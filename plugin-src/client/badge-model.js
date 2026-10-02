/**
 * 用量徽标的**纯逻辑**：显示偏好 → 模式 → 折叠态那一行文案。
 *
 * ## 为什么单独成模块（而不是写在组件里）
 *
 * `usage-badge.js` 是 React 组件，而本仓库的 node_modules 里**没有 react**
 * （它是 esbuild 的 external，由宿主注入）—— 任何 import 组件的测试都跑不起来。
 * 把「该显示什么」全部搬到本模块后，三态偏好 × 三种数据形态的**每一种组合**
 * 都能被单测逐条锁死（见 `tests/unit/badge-model.spec.ts`）。
 *
 * ## 显示优先级（用户 2026-10-01 定：窗口 > 套餐包 > 积分）
 *
 * | 偏好 | 行为 |
 * |---|---|
 * | `auto`（默认） | 有订阅读数就显示订阅（窗口优先，其次套餐包），否则积分 |
 * | `subscription` | 同上，但**不会**因为「订阅读数为 0/空」就回落到积分吗？——会回落，见下 |
 * | `credits` | 始终显示积分（也是套餐判定误判时的兜底开关） |
 *
 * ⚠️ 「订阅读数存在但内容为空」（例如账号 `ok:true` 却 `windows: []`）必须
 * **回落到积分**：否则徽标会显示成 `Cline · `（只有渠道名、没有数字），
 * 比显示余额更没用。
 *
 * ⚠️ 多单位**绝不跨单位求和**：ZCode 的额度是 token，其余是积分。同一渠道内
 * 单位一致，但代码里不做这个假设 —— 出现两种单位时按单位分组并列显示。
 */

import { formatUnits, unitLabel } from './credits-format.js';
import { quotaWindowsOf, quotaPercentValue, quotaTone } from './quota-format.js';

/**
 * 三态偏好的取值。
 *
 * ⚠️ 必须与宿主侧 `src/badge-preferences.ts` 的 `BADGE_PREFERENCES` 逐字一致
 * （`usage.badgePreference` 对非法值回 `bad-request`）。这条一致性由
 * `tests/unit/usage-badge-client.spec.ts` 直接 import 两边比对锁死。
 */
export const BADGE_PREFERENCES = Object.freeze(['auto', 'subscription', 'credits']);

/** 默认偏好（宿主侧的默认值必须与它相同）。 */
export const DEFAULT_BADGE_PREFERENCE = 'auto';

/**
 * 「宿主进程跑的是旧代码」的用户提示（真实故障，2026-10-02 用户报障）。
 *
 * ## 故障长什么样
 *
 * 用户在模型选择器旁看到「LobsterAI · 用量不可用」，点开弹窗里赫然写着
 * `unknown method: usage.badgePreference`。
 *
 * ## 根因不是代码，是**两侧加载时机不同**
 *
 * 宿主（Node）在**启动时**把 `lib/` 加载进内存；客户端 bundle 却是**每次请求
 * 从磁盘读**的。于是「改了代码 → 重新构建 → 刷新页面」之后，浏览器拿到了**新**
 * bundle（徽标 UI 出现了），而宿主仍在跑**旧**代码 —— `handleMethod` 落到
 * `default` 分支，回 `unknown method`。
 *
 * ⚠️ 这类失败**静默且有指向性**：用户会以为是功能坏了，实际上只需要重启一次
 * DSH。所以裸错误必须翻译成可行动的一句话（见 {@link describeBadgeError}）。
 */
export const HOST_STALE_HINT = '插件宿主未加载最新版本，请重启 DSH 后重试';

/**
 * 把 RPC 错误翻译成**用户能行动**的一句话。
 *
 * - 命中「宿主没有这个方法」⇒ 给出 {@link HOST_STALE_HINT}；
 * - 其它错误**原样透出**（凭据过期、网络失败等，它们的文案本身就有指向性）；
 * - 拿不到消息时回落到调用方给的 `fallback`。
 *
 * ⚠️ 判据要**窄**：只认 `unknown method` 这一个短语。这是宿主 `handleMethod`
 * 的 `default` 分支写死的文案（`src/jet-hub-rpc.ts`），改动它时本函数要同步；
 * 不要泛化成「含 unknown / 不支持」之类，那会把真实的参数错误也吞掉。
 */
export function describeBadgeError(error, fallback = '') {
  const message = typeof error?.message === 'string' ? error.message : '';
  if (message.includes('unknown method')) return HOST_STALE_HINT;
  return message.length > 0 ? message : fallback;
}

/** 偏好的展示名（弹窗里的三态开关）。 */
export const BADGE_PREFERENCE_LABELS = Object.freeze({
  auto: '自动',
  subscription: '优先订阅',
  credits: '优先积分',
});

/** 归一化偏好：未知值一律回落到默认（宿主若返回脏值，UI 不该崩）。 */
export function normalizeBadgePreference(value) {
  return BADGE_PREFERENCES.includes(value) ? value : DEFAULT_BADGE_PREFERENCE;
}

/**
 * 折叠态窗口预览：**最多两条**（优先 5 小时与本周，再多会把胶囊撑宽）。
 *
 * 排序复用设置页的「已知窗口固定顺序 + 未知窗口追加」，故两处显示顺序一致。
 * @returns `[{ type, label, percent }]`，百分比已夹取到 0–100。
 */
export function windowPreview(windows, limit = 2) {
  const list = Array.isArray(windows) ? windows : [];
  return quotaWindowsOf(list)
    .slice(0, limit)
    .map(([type, label, win]) => ({ type, label, percent: quotaPercentValue(win?.percentUsed) }));
}

/**
 * 把逐账号余额按**单位**分组求和。
 *
 * - 只有**读到数**的账号进合计（`error` 有值 → 该账号不进）；
 * - `failedCount` 单独给出，供 UI 说明「另有 N 个账号读取失败」——
 *   **不要把失败画成 0**（0 会被读成「额度用光了」）。
 *
 * @returns `{ groups: [{ unit, label, total, accountCount }], failedCount, okCount }`
 */
export function creditGroupsOf(accounts) {
  const rows = Array.isArray(accounts) ? accounts : [];
  const byUnit = new Map();
  let failedCount = 0;
  let okCount = 0;
  for (const row of rows) {
    const balance = row?.balance;
    if (!balance || typeof balance.total !== 'number' || !Number.isFinite(balance.total)) {
      failedCount += 1;
      continue;
    }
    okCount += 1;
    // 单位从**包**上取（ZCode 是 token，其余是积分）；一个包都没有时按空串走
    // `unitLabel` 的默认（「积分」）——与账号卡片的口径一致。
    const unit = firstUnitOf(balance.packages) ?? '';
    const group = byUnit.get(unit) ?? { unit, label: unitLabel(unit), total: 0, accountCount: 0 };
    group.total += balance.total;
    group.accountCount += 1;
    byUnit.set(unit, group);
  }
  // 顺序固定：单位名排序（通常只有一个分组；多单位时顺序稳定，避免每次渲染抖动）
  const groups = [...byUnit.values()].sort((a, b) => (a.unit < b.unit ? -1 : a.unit > b.unit ? 1 : 0));
  return { groups, failedCount, okCount };
}

/**
 * 把逐账号**套餐**读数按（包名 + 单位）归组求和。
 *
 * 为什么归组而不是只取一个账号：折叠态要显示的是**这个渠道还剩多少**，
 * 多账号下「按包名汇总」才回答得了那个问题（弹窗里再逐账号列出）。
 * 排序按剩余额度降序 ⇒ 折叠态取第一条即「最大的那份套餐」。
 *
 * @returns `[{ name, unit, label, remaining, total, accountCount, deductionEndTime }]`
 */
export function planGroupsOf(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const byKey = new Map();
  for (const row of list) {
    const plan = row?.plan;
    if (!plan) continue;
    const unit = typeof plan.unit === 'string' ? plan.unit : '';
    const key = `${String(plan.name)}\u0000${unit}`;
    const group = byKey.get(key) ?? {
      name: String(plan.name),
      unit,
      label: unitLabel(unit),
      remaining: 0,
      total: 0,
      accountCount: 0,
      deductionEndTime: undefined,
    };
    group.remaining += Number(plan.remaining) || 0;
    group.total += Number(plan.total) || 0;
    group.accountCount += 1;
    // 取**最早**的到期时刻：多个账号同一套餐时，最该被注意的是最先作废的那份。
    const end = typeof plan.deductionEndTime === 'number' && Number.isFinite(plan.deductionEndTime)
      ? plan.deductionEndTime
      : undefined;
    if (end !== undefined && (group.deductionEndTime === undefined || end < group.deductionEndTime)) {
      group.deductionEndTime = end;
    }
    byKey.set(key, group);
  }
  return [...byKey.values()].sort((a, b) => b.remaining - a.remaining);
}

/**
 * 折叠态的完整读数：模式 + 文案 + 色调。
 *
 * @param input.providerLabel - 渠道展示名（`jet-hub.js` 的 `providerLabel()`）。
 * @param input.preference - 显示偏好（脏值会被归一化）。
 * @param input.subscription - 宿主给的订阅读数（可能缺席）。
 * @param input.accounts - 宿主给的逐账号余额（**仅启用账号**）。
 * @param input.loading - **首次读数还没回来**（`true` 时显示「读取中…」）。
 *   ⚠️ 这个入参是必需的，不是装饰：缺了它，首屏会拿空数组算出 `empty` 模式，
 *   于是徽标在读数到达前显示「未配置启用账号」——把「还没读到」说成「没有账号」，
 *   用户会以为账号丢了（真实报障，2026-10-02）。
 * @param input.failed - **首次读数失败且无任何数据**（显示「用量不可用」而不是
 *   「未配置启用账号」）：两种情况用户要做的下一步完全不同。
 * @returns `{ mode, text, tone, groups, planGroups, windows, failedCount, okCount, failureReason }`
 *   - `mode`：`'loading' | 'windows' | 'plan' | 'credits' | 'empty'`（**回落之后**的实际模式）；
 *   - `tone`：`'ok' | 'warn' | 'error' | 'muted'`（徽标圆点用）。
 */
export function badgeView(input) {
  const providerLabel = String(input?.providerLabel ?? 'Jet Hub');
  const preference = normalizeBadgePreference(input?.preference);
  const accounts = Array.isArray(input?.accounts) ? input.accounts : [];
  const subscription = input?.subscription;
  const loading = input?.loading === true;
  const failed = input?.failed === true;

  /** 空/加载状态的统一返回（保持与成功路径同一组键，调用方不必做形状判断）。 */
  const placeholder = (mode, text, tone) => ({
    mode,
    preference,
    text,
    tone,
    groups: [],
    planGroups: [],
    windows: [],
    failedCount: 0,
    okCount: 0,
    failureReason: '',
  });

  // 首屏：读数还没到 → 明确的「读取中…」，**不要**说成「未配置启用账号」。
  if (loading) return placeholder('loading', `${providerLabel} · 读取中…`, 'muted');
  // 首次读数就失败（且没有任何有效数据）→ 「用量不可用」，与「没有账号」区分开。
  if (failed && accounts.length === 0) return placeholder('empty', `${providerLabel} · 用量不可用`, 'error');

  const { groups, failedCount, okCount } = creditGroupsOf(accounts);
  /**
   * 窗口读数取**第一个读到数的账号**（`find(ok) ?? 第一个`）。
   *
   * 为什么不做多账号汇总：窗口是「百分比 + 重置时刻」，不同账号的重置时刻不同，
   * 汇总成一个百分比没有意义（45% 和 30% 加起来是 75%？）。弹窗里逐账号列出，
   * 折叠态只给「当前会发请求的那个账号」的读数。
   */
  const windowRows = subscription?.kind === 'windows' && Array.isArray(subscription.accounts)
    ? subscription.accounts
    : [];
  const windowAccount = windowRows.find((row) => row?.ok === true) ?? windowRows[0];
  const windows = windowAccount === undefined ? [] : windowPreview(windowAccount.windows);
  const planGroups = subscription?.kind === 'plan' ? planGroupsOf(subscription.accounts) : [];
  const wantsSubscription = preference !== 'credits';

  const failureReason = firstFailureReason(accounts);

  /** 订阅形态缺失（或内容为空）时一律回落 —— 见文件头的 ⚠️。 */
  const mode = wantsSubscription && windows.length > 0
    ? 'windows'
    : wantsSubscription && planGroups.length > 0
      ? 'plan'
      : groups.length > 0
        ? 'credits'
        : 'empty';

  return {
    mode,
    preference,
    text: textOf({ mode, providerLabel, windows, planGroups, groups, accounts, failedCount }),
    tone: toneOf({ mode, windows, planGroups, groups, accounts }),
    groups,
    planGroups,
    windows,
    failedCount,
    okCount,
    failureReason,
  };
}

/** 折叠态文案（各模式一行）。 */
function textOf({ mode, providerLabel, windows, planGroups, groups, accounts, failedCount }) {
  if (mode === 'windows') {
    const parts = windows.map((win) => `${win.label} ${win.percent}%`);
    return `${providerLabel} · ${parts.join(' · ')}`;
  }
  if (mode === 'plan') {
    const best = planGroups[0];
    const range = `${formatUnits(best.remaining, best.unit) ?? '?'} / ${formatUnits(best.total, best.unit) ?? '?'}`;
    return `${providerLabel} · ${best.name} ${range} ${best.label}`;
  }
  if (mode === 'credits') {
    const parts = groups.map((group) => `${formatUnits(group.total, group.unit) ?? '?'} ${group.label}`);
    return `${providerLabel} · 合计 ${parts.join(' · ')}`;
  }
  // empty：区分「没有启用账号」与「全部读取失败」——两者给用户的下一步完全不同。
  if (accounts.length > 0 && failedCount > 0) return `${providerLabel} · 用量不可用`;
  return `${providerLabel} · 未配置启用账号`;
}

/** 徽标色调（圆点）。 */
function toneOf({ mode, windows, planGroups, groups, accounts }) {
  if (mode === 'windows') {
    // 取最紧张的那个窗口：任一窗口快满就该提示（与额度条同一套三档）。
    return quotaTone(Math.max(...windows.map((win) => win.percent)));
  }
  if (mode === 'plan') return planGroups[0].remaining > 0 ? 'ok' : 'warn';
  if (mode === 'credits') {
    return groups.some((group) => group.total > 0) ? 'ok' : 'warn';
  }
  return accounts.length > 0 ? 'error' : 'muted';
}

/** 第一个失败原因（徽标 title / 弹窗副标题用），没有失败时返回空串。 */
function firstFailureReason(accounts) {
  for (const row of accounts) {
    if (typeof row?.error === 'string' && row.error.length > 0) return row.error;
  }
  return '';
}

/** 首个声明了单位的包的单位（与 `credits-format.js` 的口径一致）。 */
function firstUnitOf(packages) {
  if (!Array.isArray(packages)) return undefined;
  const hit = packages.find((pkg) => pkg && typeof pkg.unit === 'string' && pkg.unit.length > 0);
  return hit === undefined ? undefined : hit.unit;
}

/**
 * 「更新于 2026/10/1 16:39:32」的时间戳。
 *
 * 时间戳**含日期**：宿主是长生命周期进程，只给时钟会让「昨天读的」
 * 看起来像刚刚读的。⚠️ 与设置页请求记录列用的 `formatStamp` **不同**（那个是
 * 「今天只给时钟」的表格列口径），两者用途不同故不合并。
 */
export function formatUpdatedAt(ms) {
  // ⚠️ 判据是「正数」而不是 `Number.isFinite(date.getTime())`：后者对 `undefined`
  // 会得到 `new Date(0)`（1970/1/1）并照样判为有效 —— 徽标就会显示
  // 「更新于 1970/1/1 08:00:00」。缺失时刻必须回空串，由调用方决定显示什么。
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return '';
  const at = new Date(value);
  const pad = (part) => String(part).padStart(2, '0');
  return `${at.getFullYear()}/${at.getMonth() + 1}/${at.getDate()} `
    + `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
}
