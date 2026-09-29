/**
 * 把资源包按「距扣费截止还剩多久」分成临时 / 永久两桶（面板**展示**用）。
 *
 * ## 为什么不缓存算出来的结果
 *
 * 分类是**当前时刻的函数**：宿主长期开着、时间只向前流，一笔距到期 15 天 30 秒
 * 的余额，用户什么都不做，半分钟后就成了临时积分。所以这里刻意做成纯函数，
 * 由渲染方在**每次渲染时**传当下的 `now` 现算 —— 不存 state、不设常驻定时器
 * （面板重新挂载 / 切 provider / 点「刷新积分」时数字本身也会重拉）。
 *
 * ## 与后端的关系
 *
 * 判据的权威实现是后端 `src/buddy-balance-rank.ts` 的 `splitBuddyCreditsByExpiry()`
 * （选号用它）。本文件是它的**展示侧同规则复刻** —— 两者必须逐条一致，否则用户会
 * 看到「面板说还有 250 临时积分，选号却说没号可用」。
 *
 * ⚠️ 一致性由 `tests/unit/credit-expiry.spec.ts` 的**对账用例**锁死（同一组
 * fixture 喂两边、断言结果相同），不是靠"看起来一样"。
 *
 * ## 窗口天数从哪来
 *
 * 只能由**后端回传**（`credits.balances` 的 `windowDays`）：它可被
 * `DSH_BUDDY_EXPIRING_WINDOW_DAYS` 覆盖。前端不得写死 15 —— 那会出现
 * 「提示说只烧 15 天内的、实际按 31 天筛号」。
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 归一化窗口天数：不可用时返回 **null**（调用方据此不显示分类行）。
 *
 * ⚠️ 必须显式挡住 `null` / `undefined`，不能直接 `Number(...)`：
 * `Number(null) === 0`，而**非 buddy provider 后端不带 windowDays**（它们的积分
 * 没有"会不会作废"这个维度），于是会被当成"窗口 0 天"、在卡片上凭空渲染出一行
 * 假的「临时 0 · 永久 N」。
 *
 * 窗口实际由后端写死为 15 天（或经 `DSH_BUDDY_EXPIRING_WINDOW_DAYS` 放宽），
 * 这里只做防御性归一，不假设任何特定取值。
 */
function normalizeWindowDays(windowDays) {
  if (windowDays === undefined || windowDays === null || windowDays === '') return null;
  const parsed = Number(windowDays);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * 该包距扣费截止还剩多少天；`null` = 服务端没给到期时间。
 *
 * ⚠️ 用 `deductionEndTime`，**不是** `expiredTime`（有效包那字段一律是空串，
 * 只在真正失效后才回填）也不是 `cycleEndTime`（套餐是月度值，会把长期积分误判
 * 成快到期）。理由与实测对照见 `src/buddy-balance-rank.ts` 的文件头。
 */
export function daysUntilExpiry(pkg, now) {
  const end = pkg && typeof pkg.deductionEndTime === 'number' ? pkg.deductionEndTime : null;
  if (end === null || !Number.isFinite(end) || end <= 0) return null;
  const at = typeof now === 'number' && Number.isFinite(now) ? now : Date.now();
  return (end - at) / DAY_MS;
}

/**
 * 分成 `{ expiring, permanent }` 两桶（本计费周期口径）。
 *
 * @param packages - `credits.balances` 带回来的 `balance.packages`。
 * @param windowDays - 后端回传的窗口天数。
 * @param now - **当前时刻**（渲染时传 `Date.now()`，不要传缓存值）。
 * @returns 窗口不可用时返回 `null`（调用方退化成不显示分类）。
 */
export function splitCreditsByExpiry(packages, windowDays, now) {
  const days = normalizeWindowDays(windowDays);
  if (days === null || !Array.isArray(packages)) return null;
  const windowMs = days * DAY_MS;
  const at = typeof now === 'number' && Number.isFinite(now) ? now : Date.now();
  let expiring = 0;
  let permanent = 0;
  for (const pkg of packages) {
    // 失效包跳过：服务端仍会返回它的余额，但那部分扣不到。
    if (!pkg || pkg.active !== true) continue;
    const remaining = Number(pkg.remaining);
    if (!Number.isFinite(remaining) || remaining <= 0) continue;
    const end = Number(pkg.deductionEndTime);
    const known = Number.isFinite(end) && end > 0;
    // 到期时间未知归永久（保守方向：宁可少用，不可误烧长期积分）。
    if (known && end - at < windowMs) expiring += remaining;
    else permanent += remaining;
  }
  return { expiring, permanent };
}

/** 这个包属于哪一桶的中文标签（tooltip 前缀用）。 */
export function expiryBucketLabel(pkg, windowDays, now) {
  const days = normalizeWindowDays(windowDays);
  const left = daysUntilExpiry(pkg, now);
  if (left === null) return '到期时间未知';
  if (days === null) return null;
  return left < days ? `${Math.ceil(left)} 天内到期` : `还有 ${Math.ceil(left)} 天`;
}

/**
 * tooltip 里每个包那一行的到期提示后缀。
 *
 * ⚠️ 拿不到窗口天数时也要给出「距到期 N 天」—— 它本身就解释了分类依据，
 * 比只显示一个 `CycleEndTime` 更可读（套餐的周期结束时间与积分有效期不是一回事）。
 */
export function formatExpiryHint(pkg, windowDays, now) {
  const left = daysUntilExpiry(pkg, now);
  if (left === null) return '';
  const days = Math.ceil(left);
  const label = expiryBucketLabel(pkg, windowDays, now);
  return label ? `距到期 ${days} 天（${label}）` : `距到期 ${days} 天`;
}

/**
 * 账号卡片上那行「永久 Y · 临时 X」的文案；无有效分类时返回 null。
 *
 * ⚠️ **永久在前、临时在后**（用户 2026-09-29 定）：与 Loomy 那行的
 * 「永久 … · 每日 …」同一顺序，两个 provider 的卡片读起来才对齐。
 */
export function formatExpirySplitLine(split, format) {
  if (!split) return null;
  const expiring = format(split.expiring);
  const permanent = format(split.permanent);
  if (expiring === null || permanent === null) return null;
  return `永久 ${permanent} · 临时 ${expiring}`;
}
