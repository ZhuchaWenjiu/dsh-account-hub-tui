import type { DpopPrivateJwk } from './oauth.js'
import type { BadgePreference } from './badge-preferences.js'

/** snap-manager ticket 端点响应的传输格式。 */
export interface CodeArtsCredentialResponse {
  credential?: {
    access?: string
    secret?: string
    securitytoken?: string
    securityToken?: string
    expires_at?: string
    expiresAt?: string
  }
  result?: {
    accessKeyId?: string
    secretAccessKey?: string
    securityToken?: string
    expiration?: string
    expiresAt?: string
  }
  domain_id?: string
  user_id?: string
  user_name?: string
  error_code?: string
  error_msg?: string
}

/**
 * ========================================
 * ProviderAccountEntry 与多账号相关类型
 * ========================================
 */

/** 每个模型的重置时间信息 */
export interface RateLimitInfo {
  /** 模型 ID（如 'deepseek-v4-flash'） */
  modelId: string
  /** 重置时间戳（毫秒）；0 或缺失 = 不在重置期 */
  resetAtMs: number
}

/** 账号索引条目（存于 ctx.settings，非 credentials） */
export interface ProviderAccountEntry {
  /** 账号唯一标识：{provider}-{shortid}（如 'codearts-a1b2c3d4'） */
  id: string
  /** provider 名称：'codearts' | 'buddy' */
  provider: string
  /** 用户可读昵称 */
  nickname: string
  /** 是否启用（停用不参与自动切换） */
  enabled: boolean
  /** 对应的 credential ref 名称：{PROVIDER}_ACCOUNT_{UUID_SHORT}（如 'CODEARTS_ACCOUNT_A1B2C3D4'） */
  credentialRef: string
  /** 创建时间（毫秒时间戳） */
  createdAt: number
  /** 凭据过期时间（毫秒时间戳），用于展示 */
  expiresAt?: number
  /** 是否可静默续期 */
  refreshable: boolean
  /** 每个模型的重置时间，key=模型ID（毫秒时间戳） */
  modelRateLimits?: Record<string, number>
  /**
   * TRAE 签到设备轮换代次（仅 `trae` provider 使用）。
   *
   * 业务码 `9074`（签到人数过多）的限流范围是 **device_id 而非账号**：
   * 命中后把代次 +1，即可由 `device_id` 派生出一个全新的签到设备号绕开它
   * （见 `src/trae.ts` 的 `deriveCheckinDeviceId`）。
   *
   * 这里只存**整数代次**而不是新设备号本身：派生结果由
   * `(credential.device_id, generation)` 唯一决定，故无需改写凭据本体
   * （登录凭据里的 `device_id` 是设备指纹，动它会牵涉风控）。
   *
   * 缺省/0 = 使用凭据原始 `device_id`，既有账号行为完全不变。
   */
  traeCheckinDeviceGeneration?: number
}

/** 账号详细状态（返回给 Client 展示） */
export interface ProviderAccountStatus extends ProviderAccountEntry {
  /** 最近刷新错误 */
  refreshError?: string
  /** 来源（env/file 等） */
  source?: string
  /**
   * 账号名（用户名，如 `mylzscy4`）。
   *
   * ## 为什么不在 `ProviderAccountEntry` 上
   *
   * 账号池（`jet-hub/state.json`）的条目**不存**这个值 —— 它只在**凭据**里
   * （`user_info.displayName`）。本字段是 `account.list` 在返回前**现从该账号
   * 自己的 credential ref 里读出来**的派生值，故属于「状态」而非「存储」。
   *
   * 为什么不写回池：凭据可能被用户在别处更新（换账号名）、且池的
   * `sanitizeAccounts`（`src/jet-hub-store.ts:173-191`）只保留
   * `id`/`provider`/`credentialRef` 三个字段，写进去也会被丢掉。
   */
  accountName?: string
  /**
   * 脱敏手机号（`159****0100`）。
   *
   * ⚠ 由 17 位 `user_id` 前 11 位**派生**（上游不下发手机号字段），
   * 取不到合法前缀时**不设该字段** —— 宁可不显示，也不猜。详见
   * `src/zcode.ts` 的 `phoneFromUserId`。
   */
  phone?: string
}

/** Jet Hub 在 ctx.settings 中的 schema */
export interface JetHubConfig {
  accounts: ProviderAccountEntry[]
  /**
   * 模型黑名单：provider id → 模型 id → true。
   *
   * **黑名单制**：只有键存在且为 true 的模型被隐藏，未记录的模型默认打开。
   */
  disabledModels?: Record<string, Record<string, boolean>>
}

/** RPC 端点请求/响应类型 */
export interface RpcListAccountsRequest {
  provider: string
}
export interface RpcListAccountsResponse {
  accounts: ProviderAccountStatus[]
}

export interface RpcCreateAccountRequest {
  provider: string
  /**
   * 手机号（**仅 Loomy 需要**）。
   *
   * 其余 7 个 provider 是「返回 loginUrl 让用户在浏览器里授权」，
   * 不需要手机号；Loomy 走**短信验证码**登录，故须由前端先收集。
   */
  phone?: string
}
export interface RpcCreateAccountResponse {
  accountId: string
  /**
   * 登录页地址。
   *
   * ⚠️ `loginMode === 'sms'` 时为**空串** —— 短信登录没有可打开的 URL，
   * 前端必须据此渲染验证码表单而不是弹窗。
   */
  loginUrl: string
  /**
   * 登录交互形态。
   *
   * - `'url'`（或缺省）：前端 `window.open(loginUrl)` 并轮询 `login.poll`。
   * - `'sms'`：前端渲染手机号 + 验证码表单，走 `login.sendSms` / `login.submitSms`。
   *
   * ⚠️ **缺省必须视为 `'url'`**：既有 7 个 provider 不传该字段，
   * 行为必须逐字节不变。
   */
  loginMode?: 'url' | 'sms'
  /**
   * 本次「添加账号」**没有新建条目**，而是复用了池里已有的账号。
   *
   * ## 为什么需要这个字段（用户报障 ⑯）
   *
   * 「账号应该读取有效的本地账号凭证，而不是点了添加就多一个」——
   * 当本机已有可用凭据（官方客户端写的）时，`account.create` 不再新起 OAuth，
   * 而是复用/修复已有条目。此时 `loginUrl` 为**空串**（没有可打开的页面）。
   *
   * ⚠ 前端**必须**先看这个字段再判空：只看 `loginUrl` 为空会把它当成
   * 「后端没返回登录地址」而报错，把一次成功操作显示成失败。
   */
  reused?: boolean
}

export interface RpcPollLoginRequest {
  accountId: string
  provider: string
}
export interface RpcPollLoginResponse {
  done: boolean
  success?: boolean
  error?: string
}

export interface RpcUpdateAccountRequest {
  accountId: string
  patch: Partial<Pick<ProviderAccountEntry, 'nickname' | 'enabled'>>
}

export interface RpcDeleteAccountRequest {
  accountId: string
}

/**
 * RPC: 重排某 provider 的账号顺序（Jet Hub 拖拽排序）。
 *
 * 传该 provider **全部**账号 id 的目标顺序；服务端据此重写数组顺序，
 * 该顺序即自动选号/限流换号的候选优先级（见 `AccountPool.reorderAccounts`）。
 */
export interface RpcReorderAccountsRequest {
  provider: string
  /** 该 provider 全部账号 id，按目标顺序排列。 */
  orderedIds: string[]
}

export interface RpcRefreshAccountRequest {
  accountId: string
}
export interface RpcRefreshAccountResponse {
  success: boolean
  error?: string
}

/**
 * ========================================
 * 限流标记重测 / 重置
 * ========================================
 */

/** 单个模型的探测结果。 */
export interface ProbeModelResult {
  modelId: string
  ok: boolean
  /** 失败时的可读原因（限流文案 / HTTP 状态等）。 */
  message?: string
  /**
   * 探测发现「仍受限」时，上游给出的**新重置时刻**（epoch ms）。
   *
   * [patch-codearts-probe-ratelimit] 为什么必须带出来：限流是**滚动窗口**，
   * 每次撞到都会把重置时间往后推。探针若只报「仍受限」而不回传该时刻，
   * 存储里会一直留着**第一次**的旧时刻；旧时刻一旦过期，UI 的
   * `modelRateLimits[v] > Date.now()` 就判为已过期而**不渲染「限额重置」**，
   * 于是出现「重测弹窗说仍受限、账号卡片却一条都不显示」的矛盾，
   * 且选号逻辑也会误以为该账号可用。实测偏差可达数小时
   * （如存储 09-23 16:33 vs 上游 09-24 08:31）。
   */
  resetTimeMs?: number
}

/** 单个账号的重测结果。 */
export interface ProbeAccountResult {
  accountId: string
  nickname?: string
  /** 探测的模型数；0 表示该账号没有限流标记，无需重测。 */
  tested: number
  /** 确认恢复正常、标记已清除的模型。 */
  cleared: string[]
  /** 仍受限的模型。 */
  stillLimited: ProbeModelResult[]
  /** 探测过程中的异常（凭据不可用、网络失败等）。 */
  error?: string
}

/** 重测单个账号（使用该账号自己的凭据发送探测消息）。 */
export interface RpcRetestAccountRequest {
  accountId: string
}
/** 重测该 provider 下的全部账号（**包含已停用账号**）。 */
export interface RpcRetestAllRequest {
  provider: string
}
/** 重测结果（单账号与全部共用同一响应结构）。 */
export interface RpcRetestResponse {
  accounts: ProbeAccountResult[]
  /** 汇总：清除的限流标记总数。 */
  clearedCount: number
}

/** 重置单个账号的限流标记（不测试，直接清除）。 */
export interface RpcResetAccountRequest {
  accountId: string
}
/** 重置该 provider 下全部账号的限流标记（**包含已停用账号**）。 */
export interface RpcResetAllRequest {
  provider: string
}
/** 重置结果。 */
export interface RpcResetResponse {
  /** 清除的限流标记总数。 */
  clearedCount: number
  /** 实际被清除了标记的账号数。 */
  accountCount: number
}

/**
 * ========================================
 * 每日签到（积分领取）
 * ========================================
 */

/** RPC: 查询签到状态请求 */
export interface RpcCreditsStatusRequest {
  provider: string
}
/** 单个账号的签到状态 */
export interface RpcCreditsAccountStatus {
  accountId: string
  nickname: string
  /** 状态查询失败（网络错误/凭据损坏）时为 null */
  status: import('./credits.js').CheckinStatus | null
}
/** RPC: 查询签到状态响应 */
export interface RpcCreditsStatusResponse {
  accounts: RpcCreditsAccountStatus[]
}

/** RPC: 一键领取积分请求 */
export interface RpcCreditsClaimAllRequest {
  provider: string
}
/** 单个账号的领取结果 */
export interface RpcCreditsClaimAccountResult {
  accountId: string
  nickname: string
  outcome: import('./credits.js').ClaimOutcome
}
/** 领取汇总 */
export interface RpcCreditsClaimSummary {
  claimed: number
  totalCredit: number
  alreadyClaimed: number
  inactive: number
  failed: number
  /**
   * 其中**能证明「今天这一轮已被处理」**的条数（`claimed` + `alreadyClaimed`
   * 里 `coversToday !== false` 的那些）。
   *
   * ⚠️ 它**不是** `claimed + alreadyClaimed`：那两项里可能混着「刷新前那一轮」的
   * 痕迹（Qoder 活动 10:00 UTC+8 才刷新），拿它们记账会导致当天新额度整天漏领。
   * 判据见 `src/credits.ts` 的 `ClaimOutcomeCommon.coversToday`。
   */
  coversToday: number
}
/** RPC: 一键领取积分响应 */
export interface RpcCreditsClaimAllResponse {
  results: RpcCreditsClaimAccountResult[]
  summary: RpcCreditsClaimSummary
}

/**
 * ========================================
 * 积分余额（Credits Balance）
 * ========================================
 */

/** RPC: 查询某 provider 下全部账号的积分余额请求 */
export interface RpcCreditsBalancesRequest {
  provider: string
}

/**
 * RPC: Loomy「锁定永久积分」开关的读写请求。
 *
 * ⚠️ 该开关是 **Loomy 全局**的（不分账号）：锁定后选号只允许消耗今日赠送额度，
 * 永久积分不参与 —— 只剩永久积分的账号在锁定期间等同于不可用。
 *
 * `locked` 省略表示**只读查询**；给出布尔值表示写入。
 */
export interface RpcLoomyPermanentLockRequest {
  locked?: boolean
}

/** RPC: Loomy「锁定永久积分」开关响应。 */
export interface RpcLoomyPermanentLockResponse {
  /** 当前是否已锁定。 */
  locked: boolean
}

/**
 * RPC: 通用「锁定永久积分」开关的读写请求（**provider 维度**）。
 *
 * ## 为什么不是 Loomy 那个单字段开关的扩展
 *
 * 「锁定永久积分」这件事**三个 provider 都有**，但「什么算永久积分」各不相同：
 *
 * | provider | 临时积分 | 永久积分 |
 * |---|---|---|
 * | Loomy | `dailyBalance`（**当日**到期，次日重新发放） | `balance`（注册奖励 + 新手任务） |
 * | CodeBuddy / WorkBuddy | 资源包中**扣费截止距今 < 15 天**者（实测 14/30/365 天） | 其余包（实测套餐的扣费截止在 8 年后） |
 *
 * ⚠️ 判据不同但**开关语义相同**（「只消耗会近期作废的积分」），故共用一个端点
 * 与一张持久化表，而不是每个 provider 加一条 case —— 平行分支越多，漏接概率越高
 * （WorkBuddy 的「刷新」按钮就是这么一直坏着的）。
 *
 * `locked` 省略表示**只读查询**；给出布尔值表示写入。
 */
export interface RpcPermanentLockRequest {
  /** provider id（`loomy` / `buddy` / `workbuddy`）。 */
  provider: string
  locked?: boolean
}

/** RPC: 通用「锁定永久积分」开关响应。 */
export interface RpcPermanentLockResponse {
  /** 回显请求的 provider（前端并发切换时据此对号）。 */
  provider: string
  /** 当前是否已锁定。 */
  locked: boolean
  /**
   * 当前生效的「临时积分」窗口（天）—— **仅两个 buddy 返回**。
   *
   * ⚠️ 必须回传而不是让前端写死：窗口可被 `DSH_BUDDY_EXPIRING_WINDOW_DAYS`
   * 覆盖，前端写死 15 就会出现「提示说只烧 15 天内的，实际按 31 天筛号」。
   * Loomy 没有窗口概念（它看服务端的当日池），故不带该字段。
   */
  windowDays?: number
}

/**
 * 单个账号的积分余额。
 *
 * 与签到状态的设计取舍不同：余额**带回每个包的明细**而不只是总数 ——
 * 用户看到「347.87」时通常还想知道它由哪些包构成、各自何时到期（实测一个
 * 账号常同时有「Bonus Pack」与「Free Plan Subscription」两个周期不同的包）。
 * 明细只有几项，一次带回比让前端再发一次请求更划算。
 */
export interface RpcCreditsBalanceAccount {
  accountId: string
  nickname: string
  /** 余额查询失败（网络/凭据/响应异常）时为 null —— 与「余额为 0」严格区分。 */
  balance: import('./credits.js').CreditBalance | null
  /** 查询失败的原因，供 UI 提示（成功时为 undefined）。 */
  error?: string
}

/** RPC: 查询积分余额响应 */
export interface RpcCreditsBalancesResponse {
  accounts: RpcCreditsBalanceAccount[]
  /**
   * 当前生效的「临时积分」窗口（天）—— **CodeBuddy / WorkBuddy / TRAE /
   * LobsterAI 返回**。
   *
   * 面板据此把每个资源包分成临时 / 长期两桶显示（`credit-expiry.js`），
   * 且必须在**渲染时**用当前时刻现算 —— 分类是时间的函数，把结果存下来就会
   * 让越线的包继续被当成长期（宿主长期开着，时间只向前流）。
   *
   * ⚠️ 为什么由后端回传而不是前端写死：窗口可被
   * `DSH_BUDDY_EXPIRING_WINDOW_DAYS` 覆盖，前端写死就会出现
   * 「提示说只烧 15 天内的、实际按 31 天筛号」。
   * Loomy / Raccoon **不带**该字段：它们的积分由服务端按语义分成多个池下发
   * （其中有「每日刷新」池），走的是**池名分桶**（`formatPoolSplitLine`），
   * 不是到期时间分桶。Qoder 虽有包到期字段但未接入分桶展示（仅 hover 明细）。
   */
  windowDays?: number
}

/**
 * ========================================
 * Cline 订阅额度与请求记录
 * ========================================
 *
 * 与 `credits.balances`（余额）**语义不同，两个端点不能互相替代**：
 *
 * | | 余额 | 订阅额度 | 请求记录 |
 * |---|---|---|---|
 * | 回答的问题 | 还剩多少钱 | 各时间窗用掉百分之几 | 每一笔请求花了多少 |
 * | 端点 | `/users/{id}/balance` | `/users/me/plan/usage-limits` | `/users/{id}/usages` |
 *
 * 参考实现：`github.com/codeOct/dsh-cline-pass` 的额度管理与请求记录部分
 * （见 `src/cline-quota.ts` 的模块头注释）。
 */

/** RPC: 查询某 provider 的**订阅额度窗口**（当前只有 Cline 支持）。 */
export interface RpcClineQuotaRequest {
  provider: string
}

/**
 * 单个账号的订阅额度读数。
 *
 * ⚠️ **`ok:false` 与「窗口为 0 个」是两件不同的事**：前者是查询失败
 * （凭据失效、网关报错），后者是「账号确实没有任何额度窗口」。
 * 面板对两者的文案必须不同 —— 把失败显示成「无额度」会让用户
 * 以为额度没了（与本仓库「查不到不显示成 0」的一贯约定同源）。
 */
export interface RpcClineQuotaAccount {
  accountId: string
  nickname: string
  ok: boolean
  /** 窗口按网关原序透传（网关新增窗口类型时无需改插件）。 */
  windows: Array<{ type: string; percentUsed: number; resetsAt: string }>
  error?: string
}

/** RPC: 订阅额度响应。 */
export interface RpcClineQuotaResponse {
  accounts: RpcClineQuotaAccount[]
}

/**
 * RPC: 查询**请求记录**（本插件自己发出的推理请求流水，按时间倒序）。
 *
 * ⚠️ **不是**网关的 `/users/{id}/usages`（那是该账号在官方所有渠道的
 * 消费账单：没有延迟/首块时间，表格字段也对不齐参考实现）。见
 * `src/cline-request-log.ts`。
 *
 * `accountId` 必传：面板用**同一个**翻页索引同时切「额度窗口」与
 * 「请求记录」，两个区域必须看同一个账号。
 */
export interface RpcClineRequestLogRequest {
  provider: string
  accountId: string
  /** 最多返回多少条（省略用上限）。 */
  limit?: number
}

/** 请求记录的一行。 */
export interface RpcClineRequestLogRow {
  /** 请求**发起**时刻（毫秒时间戳）。 */
  ts: number
  /** 模型 id（wire 上的 `model`）。 */
  model: string
  /**
   * 真正服务这笔请求的**上游渠道**（网关下发的路由元数据，如 `alibaba`）。
   *
   * ⚠️ 与「模型命名空间」（`cline-pass` / `cline-free`）**不是一回事**：
   * 后者是订阅通道，甚至可能是厂商名（`deepseek/…`）。网关本次没报路由时
   * 这里回落到命名空间 —— 取值顺序见 `src/cline-routing.ts` 与 RPC 侧注释。
   */
  upstream: string
  /**
   * 是否收到过 usage 帧。
   *
   * ⚠️ 与「token 为 0」不是一回事：网关没发 usage 时（abort / 上游提前断开）
   * 必须显示 `—`，给 0 会被读成「瞬间完成、没花 token」（参考实现同约定）。
   */
  usageReported: boolean
  /** 输入 token（未命中缓存的部分）。 */
  inputTokens: number
  /** 输出 token。 */
  outputTokens: number
  /** 缓存命中的输入 token（表格的 ⚡ 那一项；缺失时省略）。 */
  cacheReadTokens?: number
  /** 思考 token（表格的 🧠 那一项；缺失时省略）。 */
  reasoningTokens?: number
  /**
   * 本次请求的**推理强度**（DSH 注入的 `options.reasoningEffort`）。
   *
   * ⚠️ 空串 = 本次没指定，展示层据此**整行不渲染**（参考实现同约定）；
   * 不要改成 `'auto'` —— 那会被读成「确实选了自动这一档」。
   */
  effort: string
  /** 首个内容块耗时（毫秒）—— 解释「为什么等了这么久才出字」。 */
  ttftMs: number
  /**
   * 首个**正文**块耗时（毫秒；0 = 本次没有任何正文/工具调用块）。
   *
   * ⚠️ 「输出速率」必须让分子分母落在**正文阶段**：分子 =
   * `outputTokens − reasoningTokens`（思考 token 计入 `completion_tokens`，
   * 且产生于 `ttftMs` 之前），分母 = `totalMs − ttfcMs`。缺这个字段，
   * 速率会把思考 token 除进正文窗口 → 虚高到物理不可能的值（用户报障）。
   */
  ttfcMs: number
  /** 全程耗时（毫秒）。 */
  totalMs: number
  /** 失败原因；成功行省略。 */
  error?: string
}

/** RPC: 请求记录响应（最新在前）。 */
export interface RpcClineRequestLogResponse {
  rows: RpcClineRequestLogRow[]
}

/**
 * ========================================
 * 短信验证码登录（仅 Loomy）
 * ========================================
 *
 * Loomy 是唯一**没有 loginUrl** 的 provider（短信登录），故不能复用
 * `login.poll` 那套轮询流程，需要两个专用端点。
 */

/** RPC: 为某个待登录账号下发短信验证码（Loomy **备用**登录路径）。 */
export interface RpcSendSmsRequest {
  accountId: string
  provider: string
  /**
   * 手机号。
   *
   * ⚠️ **由本请求自己携带**，不从 `account.create` 的中间态取 ——
   * 主路径是**微信扫码**，`account.create` 不再收集手机号
   * （那正是「新建账号失败：Loomy 短信登录需要手机号」那个**顺序死锁**
   * 缺陷的成因：表单要等 `account.create` 返回才渲染，却要求它先有手机号）。
   */
  phone: string
}
/** RPC: 下发短信验证码的响应。 */
export interface RpcSendSmsResponse {
  /** 服务端返回的 msgid（服务端已缓存在占位条目上，前端只需知道已发出）。 */
  msgid: string
}

/** RPC: 提交短信验证码完成登录。 */
export interface RpcSubmitSmsRequest {
  accountId: string
  provider: string
  code: string
}
/** RPC: 提交验证码的响应。 */
export interface RpcSubmitSmsResponse {
  /** 登录是否完成（凭据已写入）。 */
  done: boolean
  /** 失败原因（`done: false` 时给出）。 */
  error?: string
}

/**
 * ========================================
 * 新手任务（仅 Loomy）
 * ========================================
 *
 * ⚠️ 与 `credits.*`（每日签到）**语义独立**：新手任务是**一次性**的
 * （每号只能领一次 10000 分），故有独立端点，不参与「一键签到」遍历。
 */

/** RPC: 查询某账号的新手任务状态。 */
export interface RpcOnboardingStatusRequest {
  provider: string
  accountId: string
}
/** RPC: 新手任务状态响应。 */
export interface RpcOnboardingStatusResponse {
  /** 8 个 task key 的完成状态。 */
  tasks: Record<string, boolean>
  /** 本地现算的已领积分。 */
  earned: number
  /** 总分（10000）。 */
  total: number
  /** task key → 中文标题（供前端渲染清单）。 */
  titles: Record<string, string>
  /** task key → 积分。 */
  points: Record<string, number>
}

/** RPC: 领取某账号的全部新手任务。 */
export interface RpcOnboardingClaimRequest {
  provider: string
  accountId: string
}
/** RPC: 领取新手任务的响应。 */
export interface RpcOnboardingClaimResponse {
  /** 本次处理的任务（含幂等重放）。 */
  claimed: { key: string; title: string; points: number }[]
  /** 此前已完成、本次跳过的 key。 */
  skipped: string[]
  /** 领取后本地现算的累计已领。 */
  earned: number
  total: number
}

/**
 * ========================================
 * 模型列表可见性（黑名单开关）
 * ========================================
 */

/** RPC: 列出某 provider 的模型请求 */
export interface RpcModelListRequest {
  provider: string
}

/**
 * 单个模型在设置页的展示条目。
 *
 * `disabled` 由服务端按黑名单回填，`name` 是适配器播报的展示名 ——
 * 两者都取自**权威来源**（适配器的 listModels），而不是前端自己再拼一份
 * 模型清单，否则远端模型池变化时设置页与对话框会显示两套不同的列表。
 */
export interface RpcModelListEntry {
  id: string
  name: string
  /** true = 已关闭（不出现在对话框的模型选择里）。 */
  disabled: boolean
  /**
   * 是否为**免费额度模型**（适配器按远端 `free` 集合判定的权威标记）。
   *
   * ⚠️ **缺失 = 该适配器没报**（不是「确认收费」）：Jet Hub 的模型列表按
   * 「计费/来源」分组时，缺失项**保守归入「按量计费」**，但字段本身保持
   * 「未知」语义 —— 不编造 `false`（与全仓「未知不编造」的约定一致）。
   */
  isFree?: boolean
}

/** RPC: 列出某 provider 的模型响应 */
export interface RpcModelListResponse {
  models: RpcModelListEntry[]
}

/** RPC: 打开/关闭某个模型请求 */
export interface RpcModelSetDisabledRequest {
  provider: string
  modelId: string
  disabled: boolean
}

/** RPC: 打开/关闭某个模型响应（回传写入后的完整黑名单，便于前端校验） */
export interface RpcModelSetDisabledResponse {
  provider: string
  disabledModels: Record<string, boolean>
}

/**
 * RPC: 批量打开/关闭某 provider 的全部模型请求。
 *
 * 两个方向**刻意不对称**（见 `AccountPool.setModelsDisabled` /
 * `clearDisabledModels`）：
 * - `disabled: true` 关闭全部：按当前目录逐项加入黑名单，服务端需要读目录；
 * - `disabled: false` 打开全部：直接清空该 provider 的黑名单，不读目录 ——
 *   这样「曾被关闭、后来从服务端目录里下线」的历史遗留键才能被清掉。
 *
 * `disabled` **没有默认值**：缺失或非布尔一律拒绝。若默认成 `true`，一次字段名
 * 写错的前端改动会静默关闭用户全部模型；默认成 `false` 则反向静默打开 ——
 * 两个方向都是灾难性且难察觉的。
 */
export interface RpcModelSetAllDisabledRequest {
  provider: string
  disabled: boolean
}

/** RPC: 批量打开/关闭响应（回传写入后的完整黑名单，与单条端点同结构） */
export type RpcModelSetAllDisabledResponse = RpcModelSetDisabledResponse

/**
 * RPC: 批量打开/关闭**指定的一批**模型（Jet Hub 模型列表里「按分组」的
 * 本组全开 / 本组全关）。
 *
 * 与 {@link RpcModelSetAllDisabledRequest} 的区别是**范围**：那个是「该 provider
 * 的全部模型」（且打开方向刻意顺带清掉已下线模型的历史死键），本端点只动传进来
 * 的 id —— **分组开关必须用本端点**，否则一次「本组全开」会把用户特意关着的
 * 其它组一起打开。
 *
 * ⚠️ `modelIds` **不接受空数组**：空组不该出现在界面上（前端按钮也按
 * `bulkButtonState` 禁用），服务端再拒一次，避免一次无意义的写入与广播。
 * ⚠️ `disabled` 同样**没有默认值**（与单条/全量端点同约定）。
 */
export interface RpcModelSetDisabledManyRequest {
  provider: string
  modelIds: string[]
  disabled: boolean
}

/** RPC: 分组批量开关响应（回传写入后的完整黑名单，与其它两个开关端点同结构） */
export type RpcModelSetDisabledManyResponse = RpcModelSetDisabledResponse

/**
 * 单个供应商的汇总状态（Jet Hub 左侧导航的分组与一键开关据此渲染）。
 *
 * 存在的意义：左侧要一次拿到**全部**供应商的状态才能分组，若逐个供应商调
 * `account.list` + `model.list`，8 个供应商就是 16 次往返，且每次都要走
 * 异步的凭据解析。这里一次返回，且服务端全程只用**同步的内存副本**。
 */
export interface ProviderStatus {
  /** 模型计数：total 为**不套黑名单**的全量目录条数，disabled 为其中已关闭的条数。 */
  models: { total: number; disabled: number }
  /** 账号计数：enabled 为其中处于启用状态的条数。 */
  accounts: { total: number; enabled: number }
  /**
   * 该供应商是否**已关闭**。
   *
   * 判据：`models.total > 0 && models.disabled === models.total` ——
   * **全部模型都已关闭**才算关闭。两条边界都不能省：
   * - `total > 0`：没有任何可用模型时**不算**「已关闭」（没有模型可关，
   *   就不该说它被关闭了），此时前端把开关置为不可用；
   * - `disabled === total`：只要还剩一个打开的模型，该供应商就仍是「已打开」。
   *
   * ⚠️ 与前端 `allModelsDisabled(models)`（`plugin-src/client/account-model-link.js`）
   * 的判据**语义同源、形态不同**：那个函数看的是模型**条目数组**，这里看的是计数。
   * 两者必须同步修改，否则「左侧说已关闭、账号联动说没全关」会自相矛盾。
   */
  closed: boolean
}

/** RPC: 读取多个供应商的汇总状态请求 */
export interface RpcProviderStatusRequest {
  /** 要查询的 provider id 列表（Jet Hub 一次性传全部 8 个）。 */
  providers: string[]
}

/** RPC: 读取多个供应商的汇总状态响应 */
export interface RpcProviderStatusResponse {
  /** provider id → 状态。请求里未识别的 id 不出现在结果中。 */
  statuses: Record<string, ProviderStatus>
}

/**
 * RPC: 供应商级一键开关请求。
 *
 * 语义（用户已确认）：
 * - `enabled: false`（关闭）= **先关掉它的全部模型，再停用它的全部账号**；
 * - `enabled: true`（打开）= 清空它的模型黑名单，并启用它的全部账号。
 *
 * `enabled` **没有默认值**：缺失或非布尔一律拒绝。与
 * {@link RpcModelSetAllDisabledRequest} 同理 —— 默认成 `true` 会静默打开
 * 用户特意关闭的供应商，默认成 `false` 则反向静默关闭，两个方向都难察觉。
 */
export interface RpcProviderSetEnabledRequest {
  provider: string
  enabled: boolean
}

/** RPC: 供应商级一键开关响应（回传实际变更数，供前端给出准确提示）。 */
export interface RpcProviderSetEnabledResponse {
  provider: string
  enabled: boolean
  /** 实际被写入黑名单的模型数（关闭方向）或清空的条目数（打开方向）。 */
  models: number
  /** 实际被改变的账号数（已是目标状态的账号不计入）。 */
  accounts: number
}

/** 存储在 CODEARTS_ACCESS_TOKEN 下的归一化临时凭据。 */
export interface CodeArtsCredential {
  access_key_id: string
  secret_access_key: string
  security_token: string
  expires_at: string
  domain_id?: string
  user_id?: string
  user_name?: string
  /** 刷新令牌（新式 IAM OAuth 流程签发；缺失表示旧 ticket 凭据，不可静默刷新）。 */
  refresh_token?: string
  /** PKCE 验证器，刷新换取时与 refresh_token 一起提交。 */
  code_verifier?: string
  /** DPoP ES256 私钥 JWK（随凭据持久化，刷新换取时签发 DPoP JWS）。 */
  dpop_private_key_jwk?: DpopPrivateJwk
  /** 模型速率限制/重置时间（框架层附加的运行时元数据，刷新凭据时需保留）。 */
  model_rate_limits?: Record<string, unknown>
}

/** 一次登录流程的结果：已存储的凭据值及其过期时间。 */
export interface LoginFlowResult {
  /** 原始令牌（token/fingerprint 分支）或 JSON.stringify(CodeArtsCredential)（轮询分支）。 */
  access: string
  /** 凭据过期的毫秒时间戳。 */
  expires: number
  /** 展示给用户的登录 URL。 */
  loginUrl: string
}

/** runLoginFlow 和 startCallbackServer 接受的选项。 */
export interface LoginFlowOptions {
  /** pollForCredential 使用的 fetch 实现；默认为全局 fetch。 */
  fetcher?: typeof fetch
  /** 在浏览器中打开登录 URL；默认使用平台打开器。 */
  openBrowser?: (url: string) => void | Promise<void>
  /** 轮询尝试次数上限；默认为 120。 */
  maxAttempts?: number
  /** 登录流程选择：'oauth'（默认）或 'ticket'（旧流程回退）。 */
  flow?: 'oauth' | 'ticket'
}

/**
 * buddy (腾讯 CodeBuddy) 凭据，存储在 BUDDY_ACCESS_TOKEN 下。
 * 定义与解析工具放在 buddy.ts（与 CodeBuddy 协议常量同处一处）。
 */
export type { BuddyCredential } from './buddy.js'

/**
 * ========================================
 * 账号备份（导出 / 导入）
 * ========================================
 */

/** 备份文件格式标识（自包含，与 DSH 版本无关）。 */
export const BACKUP_FORMAT = 'dsh-codearts-auth/backup'

/** 备份格式版本：格式演进时递增并保留迁移逻辑。 */
export const BACKUP_VERSION = 1

/**
 * 备份载荷（导出结果 / 导入输入）。
 *
 * 设计要点：
 * - `credentials` 的值保存凭据 JSON **原文字符串**（与 `ctx.credentials`
 *   存储形态一致），导入时 `set(ref, value)` 直接回写，不重新序列化，
 *   避免字段丢失或变形；
 * - `accounts` 是账号池索引（ProviderAccountEntry 原文），`disabledModels`
 *   是模型黑名单 —— 两者与 `JetHubState` 同构，导入后整体替换；
 * - 整个文件自包含且带 `format` / `version` 标记，因此与 DSH 版本无关：
 *   换版本后导入时按**当前版本**的存储契约重建。
 */
export interface BackupPayload {
  format: typeof BACKUP_FORMAT
  version: typeof BACKUP_VERSION
  /** 导出时间（ISO 8601），用于展示与可选的新旧校验。 */
  exportedAt: string
  /** credentialRef → 凭据 JSON 原文（字符串）。 */
  credentials: Record<string, string>
  /** 账号池索引（ProviderAccountEntry 原文）。 */
  accounts: ProviderAccountEntry[]
  /** 模型黑名单：provider id → 被关闭的模型 id → true。 */
  disabledModels: Record<string, Record<string, boolean>>
  /**
   * 各 provider 的「锁定永久积分」开关：provider id → 已锁定。
   *
   * ⚠️ **可选**：老备份文件里没有该字段，导入时保持当前值（不重置）。
   * 导出时总写完整表（含空表），故新备份一律自包含。
   */
  permanentLocks?: Record<string, boolean>
  /**
   * Loomy「锁定永久积分」开关（**兼容字段**，权威值在 {@link permanentLocks}）。
   *
   * ⚠️ **可选**：老备份文件里没有该字段，导入时保持当前值（不重置），
   * 因此不需要提升 {@link BACKUP_VERSION}。
   *
   * ⚠️ 导出时**继续双写**：老版本只读这一个字段，缺了它回退版本会看到
   * 「锁定悄悄失效」——而锁定失效的后果是**真的把永久积分烧掉**，
   * 属于不可逆损失，所以宁可留一个冗余字段。
   */
  loomyPermanentLocked?: boolean
}

/** RPC: 导出备份响应。 */
export interface RpcBackupExportResponse {
  payload: BackupPayload
  /** 未能读取凭据的账号 id（凭据缺失/损坏，不中断导出）。 */
  warnings: string[]
}

/** RPC: 导入备份请求。 */
export interface RpcBackupImportRequest {
  /** 备份载荷（明文 JSON 解析后的对象；加密文件在浏览器侧解密后传入）。 */
  payload: unknown
}

/** RPC: 导入备份响应。 */
export interface RpcBackupImportResponse {
  /** 写入的凭据条数。 */
  credentialsImported: number
  /** 写入的账号数。 */
  accountsImported: number
  /** 跳过的凭据 ref（非法 ref 等）。 */
  skipped: string[]
  /**
   * 导入的账号中「凭据已过期」的条数（账号条目的 `expiresAt <= 当前时刻`）。
   * 这类账号即使 refresh_token 尚有效也会在下一次请求时先静默续期；若
   * refresh_token 也已失效（导出后搁置过久 / CodeArts 一次性轮换），则需
   * 重新登录。前端据此提示用户。
   */
  expiredAccounts: number
  /**
   * 导入的账号中「凭据缺失」的条数：账号条目存在，但其 credentialRef 不在
   * 备份的 credentials 字典里。这类账号导入后无凭据可用，对应 provider 的
   * 模型目录会被门控隐藏（像未登录一样）。前端据此提示用户重新登录该账号。
   */
  missingCredentials: number
}

/**
 * RPC: 查询当前账号池统计（导入前的覆盖提示用）。
 *
 * `withoutExpiry` 统计缺 `expiresAt` 的账号条目——这正是 DSH 版本切换后
 * 自动恢复（`bootstrapFromCredentialRefs`）产生的条目特征：反推只按凭据
 * ref 名重建，不读凭据值，故拿不到有效期。正常登录的账号基本都带
 * `expiresAt`。该数字用于导入前提示「有 N 个自动恢复的账号将被覆盖」。
 */
export interface RpcBackupStatusResponse {
  /** 当前账号池的账号总数。 */
  accounts: number
  /** 缺 `expiresAt` 的账号条目数（疑似自动恢复产物）。 */
  withoutExpiry: number
}

/**
 * RPC: 内部载体问「现在要不要产 param」。
 *
 * 需求位为 `false` 时 client **一次都不产**（零配额消耗）——阿里云按同设备
 * 每小时 150 次限流，白产比不产更贵（判据见 `src/captcha-supply.ts` 文件头
 * 「与预取池的区别」）。
 */
export interface RpcCaptchaDemandResponse {
  active: boolean
}

/**
 * RPC: 内部载体问「载体页在哪个地址」（评审 C1/C2）。
 *
 * ⚠ 为什么 client 不能自己拼：载体页必须待在**一个与 Host 端口不同**的回环端口上
 *   ——桌面版主进程的 `allowedNavigation()` / `onBeforeRequest` 都以
 *   `isApplicationHost(url)` 拒绝「端口相同 + 主机相同/回环」的地址
 *   （DSH Desktop 0.2.0-rc.2，`app.asar/lib/main.js`）。
 *   端口由 server 运行时挑（`src/captcha-carrier-server.ts`）⇒ 只能问。
 *
 * ⚠ `null` = **现在没有可用地址**（env 关掉 / 候选端口全被占）。client 拿到它就
 *   安静退出（本轮不建 guest、不导航）；这不是错误，别当异常报。
 */
export interface RpcCaptchaCarrierUrlResponse {
  url: string | null
}

/**
 * RPC: 内部载体回传一个 param。
 *
 * ⚠ **故意没有** `atMs` / 任何绝对时间戳字段：产出时刻由 server 用
 * 「自己的到达时刻 − `elapsedMs`」推算（见 `jet-hub-rpc.ts` 的该 case 注释）。
 * client 传绝对时间戳会把跨端时钟漂移引进时效闸 —— 快了永不判过期、
 * 慢了一投放就过期，两种都表现为**内部载体静默不可用**。
 */
export interface RpcCaptchaContributeRequest {
  /** guest 里 SDK 产出的 param。空串/全空白一律不收。 */
  param: string
  /**
   * client 侧「开始产 → 发这条 RPC」的**相对耗时**（毫秒）。
   *
   * 相对耗时是同机单向差值，比绝对时钟可靠；非法值（负数、非整数、
   * ≥ 5 分钟）一律退回 0，即按到达时刻记账。
   */
  elapsedMs?: number
  /**
   * 这一发是不是被降级成了**交互式验证**（评审 I2）。
   *
   * ⚠ 这是内部载体**唯一**的设备信誉预警：chromium 那条腿在
   *   `ZcodeAuth.captchaPoolInstance()` 里已经会 `warn`，而内部载体这段此前
   *   只打进 client 控制台 —— host 侧看不到，等于没有预警。
   * 缺省 / 非 `true` 一律当「无感通过」（不要把缺字段说成有）。
   */
  interactive?: boolean
}

/** RPC: 内部载体回传 param 的结果（`false` = 没进槽，client 可决定要不要重试）。 */
export interface RpcCaptchaContributeResponse {
  accepted: boolean
}

/**
 * ========================================
 * 用量徽标（模型选择器旁）
 * ========================================
 *
 * 一个端点回答「当前选中的渠道还剩多少」，供会话输入区那枚徽标使用：
 * 折叠态给一个数字（订阅优先 / 积分兜底），展开后给逐账号明细。
 *
 * ⚠️ 与 `credits.balances` 的关系：**读数是同一份**（本端点内部直接复用
 * `credits.balances` 的实现），差别有三处 ——
 * 1. 只返回**启用**账号（停用账号不计入合计，另给 `disabledCount` 说明）；
 * 2. 多带一份订阅读数（窗口 / 套餐），形状由 `badge-subscription.ts` 判定；
 * 3. 结果带**宿主侧 TTL 缓存**（`cached` 标出来），因为徽标会按分钟轮询，
 *    而余额是逐账号打上游的（见 `collectCreditBalances` 的「顺序查询」）。
 */

/** RPC: 读取用量徽标读数。 */
export interface RpcUsageBadgeRequest {
  /** 渠道 id（与 provider id 同名，即模型选择器里的路由 id）。 */
  provider: string
  /** `true` = 绕过宿主 TTL 缓存（手动刷新、签到之后用）。 */
  force?: boolean
}

/**
 * 套餐读数（**折叠态只显示一条**，故每个账号先折算成一条）。
 *
 * ⚠️ 与窗口式订阅（Cline）是**两种形态**，不要合并：
 * 窗口答「各时间窗用掉百分之几」，套餐答「这份套餐还剩多少额度」。
 */
export interface RpcUsageBadgePlanReading {
  /** 展示名：套餐包名，或「整个余额即套餐」时的固定名（见 `badge-subscription.ts`）。 */
  name: string
  remaining: number
  total: number
  /** 额度单位（`credits` / `token`），渲染标签与数字格式化都按它走。 */
  unit: string
  /** 扣费截止（毫秒）；缺省 = 服务端未下发（**不是**已过期）。 */
  deductionEndTime?: number
}

/** 套餐读数：一个账号一条（`plan` 为 `null` = 该账号没有可用套餐包）。 */
export interface RpcUsageBadgePlanAccount {
  accountId: string
  nickname: string
  plan: RpcUsageBadgePlanReading | null
  /** 余额本身查询失败时的原因（与 `plan: null` 严格区分）。 */
  error?: string
}

/** 订阅读数：窗口（Cline）或套餐（Qoder / ZCode / 两个 buddy）。 */
export type RpcUsageBadgeSubscription =
  | { kind: 'windows'; accounts: RpcClineQuotaAccount[] }
  | { kind: 'plan'; accounts: RpcUsageBadgePlanAccount[] }

/** RPC: 用量徽标读数响应。 */
export interface RpcUsageBadgeResponse {
  /** 回显请求的渠道（前端并发切换时据此对号，避免把 A 的读数画到 B 上）。 */
  provider: string
  /** 宿主**生成**这份读数的时刻（毫秒）；UI 的「更新于」用它，不用到达时刻。 */
  generatedAt: number
  /** `true` = 命中宿主 TTL 缓存（这一轮没有真的打上游）。 */
  cached: boolean
  /** 逐账号余额（**仅启用账号**），形状与 `credits.balances` 一致。 */
  accounts: RpcCreditsBalanceAccount[]
  /** 被停用而**未计入**的账号数（弹窗脚注说明用；为 0 时不渲染脚注）。 */
  disabledCount: number
  /** 临时 / 长期分桶的窗口天数（沿用 `credits.balances` 的口径）。 */
  windowDays?: number
  /** 订阅读数；该渠道没有订阅数据、或订阅查询失败时**整个字段缺席**。 */
  subscription?: RpcUsageBadgeSubscription
  /** 当前生效的显示偏好（顺带回传，省一次往返）。 */
  preference: BadgePreference
  /**
   * 「每日首次启动自动签到」的实时状态（顺带回传，供弹窗右上角那盏状态灯）。
   *
   * ⚠️ 与 `preference` 同理**不进 TTL 缓存**：`running` / `ranToday` 会在宿主
   * 后台任务跑起来后变化，缓存住会让界面一直停在旧状态（看起来像「开关点了没反应」）。
   */
  autoCheckin: RpcUsageAutoCheckinState
}

/**
 * RPC: 读写「用量徽标显示偏好」。
 *
 * ⚠️ `preference` **省略 = 只读**；给出时必须是 `auto` / `subscription` /
 * `credits` 三者之一 —— 非法值一律 `bad-request`，**不做**静默回落
 *（回落会让「设置没生效」看起来像「保存成功」）。读取侧的容错在
 * `sanitizeBadgePreference`，那里面对的是**磁盘上的脏数据**，不是用户输入。
 */
export interface RpcUsageBadgePreferenceRequest {
  preference?: BadgePreference
}

/** RPC: 用量徽标显示偏好响应（回显写入后的生效值）。 */
export interface RpcUsageBadgePreferenceResponse {
  preference: BadgePreference
}

/**
 * 「每日首次启动自动签到」的实时状态。
 *
 * 语义要点（用户 2026-10-02 的需求：「每日第一次打开 DSH 可以按照这个状态是否
 * 自动签到，并记录签到状态，不多次重复触发」）：
 * - 开关是**全局**的（不分渠道），作用范围是**全部有账号的渠道**；
 * - 「今天」按 **UTC+8** 日界算（各渠道的每日额度都按 UTC+8 结算）；
 * - `lastDate` 就是「不多次重复触发」的凭据：等于今天 ⇒ 当天不再自动跑。
 */
export interface RpcUsageAutoCheckinState {
  /**
   * 开关是否打开。默认**打开**（`auto-checkin.ts` 的 `DEFAULT_AUTO_CHECKIN`：
   * 用户 2026-10-02 明确要求「自动签到默认保持打开」）。⚠️ 本注释早于那次
   * 决定、写的是「默认关闭」，已按实现更正 —— 改默认值前先改这里，别让注释
   * 与实现分家（那正是本 PR 审查发现的一处矛盾）。
   */
  enabled: boolean
  /** 上次**完成**自动签到的 UTC+8 日期（`YYYY-MM-DD`）；空串 = 从未跑过。 */
  lastDate: string
  /** 今天是否已经自动签到过（`lastDate` 等于今天）。 */
  ranToday: boolean
  /** 正在执行中（刚打开开关会立刻跑一轮，此时为 true）。 */
  running: boolean
  /** 上次结果摘要（中文短句，展示在状态灯提示里）。 */
  lastResult: string
  /** 上次跑完的时刻（毫秒）；0 = 从未跑过。面板上的时间戳用它。 */
  lastAt: number
  /**
   * **逐渠道**结果（顺序即遍历顺序，文本形如 `2 个 +800` / `今天已领` /
   * `无签到接口` / `出错`）。
   *
   * 用户 2026-10-02：「自动签到状态下，下方应该也显示文字状态，这样才能够知道
   * 各个渠道的签到状态」—— 汇总句看不出是哪个渠道，故这里给逐渠道明细。
   */
  channels: Array<{ provider: string; text: string }>
  /**
   * 用户是否已手动关闭那行**常驻**的自动签到状态文字。
   *
   * ⚠️ 判据是「关闭的是当前这一轮」：新一轮跑出结果后自动变回 `false`
   *（否则用户关过一次就再也看不到新结果了）。
   */
  dismissed: boolean
}

/**
 * RPC: 读写「每日首次启动自动签到」开关，以及关闭常驻状态文字。
 *
 * ⚠️ `enabled` 与 `dismiss` 都**省略 = 只读**；给出时必须是布尔值 —— 非法值一律
 * `bad-request`，**不做**静默回落（与本仓库 `usage.badgePreference` 同口径：
 * 回落会让「设置没生效」看起来像「保存成功」）。磁盘脏数据的容错在
 * `sanitizeAutoCheckin`。
 * ⚠️ 打开开关时宿主会**立刻尝试一轮**（今天已跑过则内部拦住）：否则用户今天点了
 * 开关要等到明天才有动作，看起来像没生效。
 * ⚠️ `dismiss: true` 只关掉**当前这一轮**的状态文字（下一轮结果会重新出现）——
 * 手动签到的结果提示是按时自动消失的，两者语义不同，别合并。
 */
export interface RpcUsageAutoCheckinRequest {
  enabled?: boolean
  dismiss?: boolean
}

/** RPC: 自动签到开关响应（回显写入后的生效状态）。 */
export interface RpcUsageAutoCheckinResponse {
  autoCheckin: RpcUsageAutoCheckinState
}
