/**
 * 「每日首次启动自动签到」—— 开关、当日记录与执行体。
 *
 * ## 它做什么
 *
 * DSH 启动后延迟一小段（默认 30 秒，见下），若这个开关开着、且**今天（UTC+8）
 * 还没跑过**，就串行遍历「账号池里真的有账号的渠道」，逐个调内部
 * `credits.claimAll`；跑完把日期与结果摘要写进文档 ⇒ **当天不再触发**。
 * 用户手动点「全部渠道签到」不受此限（那是显式操作，永远放行）。
 *
 * ## 为什么延迟 30 秒
 *
 * 两个理由，任一成立都不该立刻跑：
 * 1. **不跟启动抢资源**：一轮签到是「渠道数 × 账号数」次串行上游请求（反风控
 *    口径，见 `collectCreditBalances` 的顺序查询），启动瞬间打它会拖慢首屏；
 * 2. **等凭据续期先跑一轮**：宿主启动时的续期调度器**本身也要立刻跑一轮**
 *    （见 `index.ts` 的注释：短寿命 provider 的凭据在关机期间早就过期）。
 *    若抢在续期之前签到，过期凭据会让整轮变成失败。
 * 即便如此仍可能抢在续期完成前（多账号时续期本身就要几秒到几十秒），故**再加
 * 一道保险**：整轮「零成功且零已领」时**不记日期**，下次启动会重试（见
 * `shouldMarkToday`）。延迟可用 `DSH_JET_HUB_AUTO_CHECKIN_DELAY_MS` 覆盖，
 * `0` 合法（表示立刻跑，单测用它）。
 *
 * ## 为什么单独一份文档，而不是塞进 ui-preferences.json
 *
 * `ui-preferences.json` 是**同 dsh home、多 profile 共享**的文档，而本仓库写盘
 * 是**整体替换**语义（见 `badge-preferences.ts` 的文件头对 state.json 记过的
 * 同一条理由）。同机上另一条工作区跑着**没有本功能**的旧版本插件时，它保存显示
 * 偏好会把这里的字段静默抹掉 —— 后果是「开关自己关了」或「今天又跑一次」。
 * 独立文档的读写者只有本文件，旧版本代码碰不到它。
 *
 * ## ⚠️ 不支持的渠道怎么判：**不建第二份能力名单**
 *
 * 「哪些渠道能签到」的权威是客户端的 `credits-capabilities.js`（12 个渠道逐项
 * 登记）。在本模块再抄一份必然漂移（本仓库已有「两份名单漂移」的真实缺陷）。
 * 故判据交给 `credits.claimAll` 自己：cline / raccoon / **workbuddy** 三条分支
 * **不发任何上游请求**就返回「不支持每日签到」，本模块把这类错误计为**跳过**，
 * 既不算失败也不重试。
 *
 * ⚠️ 其中 **workbuddy 的那条守卫是本功能先补上的**：此前它会落到 buddy 产品
 * 分支、真去发必然失败的签到请求（客户端从不调用它，是因为能力表写着 false，
 * 所以这个洞一直没被触发）。补上之后，「调用即判定」这条规则才真正安全。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { QODER_BILLING_UTC_OFFSET_MS } from './model-queue.js'
import { resolveJetHubHome } from './jet-hub-store.js'
import type { BadgeRpcResult } from './usage-badge.js'
import type { RpcCreditsClaimAllResponse, RpcUsageAutoCheckinState } from './types.js'

/** 独立文档的文件名（与 state.json / ui-preferences.json 同目录）。 */
export const AUTO_CHECKIN_FILE = 'auto-checkin.json'

const SCHEMA = 'dsh-codearts-auth/auto-checkin/v1'

/**
 * 文档内容。
 *
 * `lastDate` / `lastResult` 既是「当天不重复触发」的判据，也是状态灯提示的来源
 * （用户要求「记录签到状态，不多次重复触发」）。
 */
export interface AutoCheckinDoc {
  /** 自动签到开关。**默认关闭**：这是会代用户打上游的写操作，须显式开启。 */
  enabled: boolean
  /** 上次**完成**自动签到的 UTC+8 日期（`YYYY-MM-DD`）；空串 = 从未跑过。 */
  lastDate: string
  /** 上次结果摘要（中文短句，直接展示）。 */
  lastResult: string
}

/** 默认：关闭 + 无记录。 */
export const DEFAULT_AUTO_CHECKIN: AutoCheckinDoc = { enabled: false, lastDate: '', lastResult: '' }

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * 归一化文档：非法值一律回落默认值（**不抛错**）。
 *
 * ⚠️ 与 RPC 写入路径的严格校验**不冲突**：那条路径面对用户输入，要拒绝非法值；
 * 这条路径面对**磁盘上的脏数据**（手工编辑过、被旧版本写坏），回落比整机不可用
 * 更合理 —— 判据口径与 `sanitizeBadgePreference` 一致。
 */
export function sanitizeAutoCheckin(raw: unknown): AutoCheckinDoc {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ...DEFAULT_AUTO_CHECKIN }
  const record = raw as Record<string, unknown>
  return {
    // 只认显式 `true`：`'true'` / `1` 都不算（避免脏数据把开关悄悄打开）。
    enabled: record.enabled === true,
    lastDate: typeof record.lastDate === 'string' && DATE_RE.test(record.lastDate) ? record.lastDate : '',
    lastResult: typeof record.lastResult === 'string' ? record.lastResult : '',
  }
}

/**
 * 取「UTC+8 的当天日期」（`YYYY-MM-DD`）。
 *
 * ⚠️ 必须用**算术平移**而不是本机时区：日界归服务端（各渠道的每日额度按 UTC+8
 * 结算），取本机时区会在用户出差/改系统时区时得到错的「今天」—— 偏东会提前把
 * 当天记为已跑（真的漏签），偏西会一天跑两次。偏移量复用 `model-queue.ts` 的
 * `QODER_BILLING_UTC_OFFSET_MS`（同一口径，不另立常量）。
 */
export function utc8DateString(nowMs: number = Date.now()): string {
  return new Date(nowMs + QODER_BILLING_UTC_OFFSET_MS).toISOString().slice(0, 10)
}

/** 环境变量：启动后延迟多久再尝试自动签到（毫秒）。 */
export const DSH_JET_HUB_AUTO_CHECKIN_DELAY_MS = 'DSH_JET_HUB_AUTO_CHECKIN_DELAY_MS'

/** 默认延迟（毫秒）。理由见文件头「为什么延迟 30 秒」。 */
export const AUTO_CHECKIN_DELAY_MS = 30_000

/**
 * 读延迟配置。
 *
 * ⚠️ 不能写成 `Number(env.X) || 默认值`：`0` 是**合法**值（立刻执行），
 * 而 `0` 是 falsy 会被静默换成 30 秒 —— 与本仓库 `DSH_JET_HUB_BADGE_TTL_MS`、
 * `DSH_QODER_QUEUE_TIMEOUT_MS` 记过的是同一个坑。
 */
export function autoCheckinDelayMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[DSH_JET_HUB_AUTO_CHECKIN_DELAY_MS]
  if (typeof raw !== 'string' || raw.trim().length === 0) return AUTO_CHECKIN_DELAY_MS
  const parsed = Number(raw.trim())
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : AUTO_CHECKIN_DELAY_MS
}

/** 文档后端：文件（正常）或内存（定位不到 dsh home 时的显式降级）。 */
export type AutoCheckinStoreKind = 'file' | 'memory'

/** 文档读写接口（同步读、异步写，与 `BadgePreferenceStore` 同款约定）。 */
export interface AutoCheckinStore {
  readonly kind: AutoCheckinStoreKind
  /** 载入文档；不存在 / 损坏 / 字段非法时返回默认值。 */
  load(): AutoCheckinDoc
  /** 整份写入（原子写）。 */
  save(doc: AutoCheckinDoc): Promise<void>
}

class MemoryAutoCheckinStore implements AutoCheckinStore {
  readonly kind = 'memory' as const
  private doc: AutoCheckinDoc = { ...DEFAULT_AUTO_CHECKIN }

  load(): AutoCheckinDoc {
    return { ...this.doc }
  }

  async save(doc: AutoCheckinDoc): Promise<void> {
    this.doc = { ...doc }
  }
}

class FileAutoCheckinStore implements AutoCheckinStore {
  readonly kind = 'file' as const

  constructor(
    private readonly path: string,
    private readonly logger: { warn(message: string): void } | undefined,
  ) {}

  load(): AutoCheckinDoc {
    try {
      if (!existsSync(this.path)) return { ...DEFAULT_AUTO_CHECKIN }
      return sanitizeAutoCheckin(JSON.parse(readFileSync(this.path, 'utf-8')) as unknown)
    } catch (error) {
      // 损坏时回落默认值（= 开关关闭）而不是抛错：这是后台任务，读不到文档最多
      // 是「今天不自动签到」，不该让插件起不来。
      this.logger?.warn(`[jet-hub] 读取 ${this.path} 失败，自动签到按关闭处理: ${String(error)}`)
      return { ...DEFAULT_AUTO_CHECKIN }
    }
  }

  async save(doc: AutoCheckinDoc): Promise<void> {
    mkdirSync(join(this.path, '..'), { recursive: true })
    const tmp = `${this.path}.tmp`
    writeFileSync(tmp, JSON.stringify({
      schema: SCHEMA,
      enabled: doc.enabled,
      lastDate: doc.lastDate,
      lastResult: doc.lastResult,
    }, null, 2), 'utf-8')
    renameSync(tmp, this.path)
  }
}

/** 创建文档后端（home 与账号池 / 偏好文档用**同一个** `resolveJetHubHome`）。 */
export function createAutoCheckinStore(ctx: Context): AutoCheckinStore {
  const home = resolveJetHubHome(ctx)
  if (home === undefined) {
    ctx.logger?.warn?.('[jet-hub] 无法定位 DSH home，自动签到开关仅存在于内存中')
    return new MemoryAutoCheckinStore()
  }
  return new FileAutoCheckinStore(join(home, 'jet-hub', AUTO_CHECKIN_FILE), ctx.logger)
}

/** 一轮执行的累计口径（账号级计数来自各渠道的 `summary`）。 */
interface RunTotals {
  /** 真正跑过 `claimAll` 的渠道数（不含被跳过的）。 */
  providers: number
  claimed: number
  totalCredit: number
  alreadyClaimed: number
  inactive: number
  failed: number
  /** 渠道级：不支持签到（`claimAll` 未发上游请求就返回的那些）。 */
  skipped: number
  /** 渠道级：其它错误（凭据、网络……）。 */
  errors: number
}

function emptyTotals(): RunTotals {
  return { providers: 0, claimed: 0, totalCredit: 0, alreadyClaimed: 0, inactive: 0, failed: 0, skipped: 0, errors: 0 }
}

/**
 * 「不支持每日签到」的判据：`credits.claimAll` 对 cline / raccoon / workbuddy
 * 返回的**显式**错误文案（这三条分支都不发上游请求）。
 *
 * ⚠️ 兜底认 `unsupported provider`：那是 `productById` 找不到产品时的文案，
 * 语义同样是「这个渠道没有可用的签到实现」，计成失败只会制造假警报。
 * ⚠️ 判据必须**窄**：只匹配这两个短语，不要泛化成「含 unsupported」之类，
 * 免得把真正的参数错误也吞掉。
 */
export function isUnsupportedCheckin(message: string): boolean {
  return message.includes('不支持每日签到') || message.includes('unsupported provider')
}

/** 把一轮结果拼成一句中文摘要（给状态灯提示与日志用）。 */
export function describeRun(totals: RunTotals): string {
  const parts: string[] = []
  if (totals.claimed > 0) {
    parts.push(`${totals.claimed} 个账号领取成功${totals.totalCredit > 0 ? `（+${totals.totalCredit} 积分）` : ''}`)
  }
  if (totals.alreadyClaimed > 0) parts.push(`${totals.alreadyClaimed} 个今天已领`)
  if (totals.failed > 0) parts.push(`${totals.failed} 个失败`)
  if (totals.errors > 0) parts.push(`${totals.errors} 个渠道出错`)
  if (totals.skipped > 0) parts.push(`${totals.skipped} 个渠道不支持签到`)
  if (parts.length === 0) return `${totals.providers} 个渠道：没有需要领取的账号`
  return `${totals.providers} 个渠道：${parts.join('，')}`
}

/**
 * 这一轮该不该把「今天」记为已跑。
 *
 * 判据：**至少有一个账号「领到了」或「今天已领」**才记。
 * 反例（不记、下次启动重试）：
 * - 整轮零成功零已领（凭据全过期 / 网络不通 / 启动太早抢在续期之前）——
 *   若记了，用户当天就再也不会自动签到，且界面只说「上次：N 个失败」；
 * - 一个渠道都没跑（全被跳过）：没有意义，不记。
 * 反之「有成功也有失败」要记：否则一个坏账号会让插件每次启动都把好账号再领一遍
 * （虽然幂等，但白白多发请求）。
 */
export function shouldMarkToday(totals: RunTotals): boolean {
  return totals.claimed + totals.alreadyClaimed > 0
}

/** 装配层注入的依赖（全部可替换 ⇒ 单测零网络、零文件系统、零等待）。 */
export interface AutoCheckinDeps {
  store: AutoCheckinStore
  /**
   * 列出**账号池里有账号**的渠道 id。
   * 只遍历有账号的渠道：没有账号的渠道调 `claimAll` 只会拿到空结果，白白走一遍
   * 12 条分支。
   */
  listProviderIds(): Promise<string[]>
  /**
   * 调某个渠道的签到 —— **必须复用 `credits.claimAll` 的实现**（装配层直接调内部
   * `handleMethod`）。本模块不认任何具体渠道，只按返回的信封判「跳过 / 失败」。
   */
  claim(provider: string): Promise<BadgeRpcResult<RpcCreditsClaimAllResponse>>
  now?(): number
  /** 延迟毫秒数；默认读环境变量。 */
  delayMs?: number
  /** 排定延迟执行（注入以便单测零等待）。返回值交给 `stop()` 取消。 */
  schedule?(fn: () => void, ms: number): { cancel(): void }
  warn?(message: string): void
}

/** 自动签到执行体。 */
export interface AutoCheckin {
  /** 实时状态（供 RPC 与状态灯；`enabled` 等取自内存，不重新读盘）。 */
  state(): RpcUsageAutoCheckinState
  /** 写开关；**打开时若今天还没跑过，立刻跑一轮**（否则用户会以为开关没生效）。 */
  setEnabled(enabled: boolean): Promise<RpcUsageAutoCheckinState>
  /** 启动时调用一次：延迟后排定一轮（内部自己判开关与当天是否已跑）。 */
  start(): void
  /** 立刻按判据跑一轮（供「刚打开开关」与单测用）。 */
  runIfDue(): Promise<void>
  /** 取消尚未执行的延迟任务（不打断已开始的一轮）。 */
  stop(): void
}

/** 创建自动签到执行体。 */
export function createAutoCheckin(deps: AutoCheckinDeps): AutoCheckin {
  const now = deps.now ?? (() => Date.now())
  let doc = deps.store.load()
  let running = false
  /** 在飞去重：`setEnabled(true)` 与启动排定可能同时想跑。 */
  let inflight: Promise<void> | null = null
  let pending: { cancel(): void } | null = null

  const today = (): string => utc8DateString(now())

  function state(): RpcUsageAutoCheckinState {
    return {
      enabled: doc.enabled,
      lastDate: doc.lastDate,
      ranToday: doc.lastDate !== '' && doc.lastDate === today(),
      running,
      lastResult: doc.lastResult,
    }
  }

  async function performRun(): Promise<void> {
    const totals = emptyTotals()
    let providers: string[] = []
    try {
      providers = [...new Set(await deps.listProviderIds())].sort()
    } catch (error) {
      // 账号池读不出来：不记日期，下次启动重试。
      deps.warn?.(`[jet-hub] 自动签到：读取账号池失败，本次跳过: ${String(error)}`)
      return
    }
    for (const provider of providers) {
      let result: BadgeRpcResult<RpcCreditsClaimAllResponse>
      try {
        result = await deps.claim(provider)
      } catch (error) {
        totals.errors += 1
        deps.warn?.(`[jet-hub] 自动签到：${provider} 调用异常: ${String(error)}`)
        continue
      }
      if (!result.ok) {
        const message = typeof result.error?.message === 'string' ? result.error.message : ''
        if (isUnsupportedCheckin(message)) {
          totals.skipped += 1
          continue
        }
        totals.errors += 1
        deps.warn?.(`[jet-hub] 自动签到：${provider} 失败: ${message || '未知错误'}`)
        continue
      }
      totals.providers += 1
      const summary = result.value?.summary
      if (summary === undefined) continue
      totals.claimed += summary.claimed
      totals.totalCredit += summary.totalCredit
      totals.alreadyClaimed += summary.alreadyClaimed
      totals.inactive += summary.inactive
      totals.failed += summary.failed
    }

    if (!shouldMarkToday(totals)) {
      // ⚠️ 刻意**不写** lastDate：让「凭据还没续上 / 网络不通」这类整轮失败
      // 能在下次启动重试，而不是当天就此放弃（判据见 shouldMarkToday 注释）。
      deps.warn?.(
        `[jet-hub] 自动签到未记入今日（下次启动会重试）：${describeRun(totals)}`,
      )
      return
    }

    doc = { ...doc, lastDate: today(), lastResult: describeRun(totals) }
    try {
      await deps.store.save(doc)
    } catch (error) {
      // 写盘失败 ⇒ 今天可能再跑一次（幂等，代价是多发一轮请求），如实告警。
      deps.warn?.(`[jet-hub] 自动签到结果写入失败（今天可能重复触发一次）: ${String(error)}`)
    }
    deps.warn?.(`[jet-hub] 自动签到完成（${today()}）：${doc.lastResult}`)
  }

  function runIfDue(): Promise<void> {
    if (inflight !== null) return inflight
    if (!doc.enabled) return Promise.resolve()
    if (doc.lastDate !== '' && doc.lastDate === today()) return Promise.resolve()
    running = true
    const task = performRun().catch((error: unknown) => {
      deps.warn?.(`[jet-hub] 自动签到异常: ${String(error)}`)
    }).finally(() => {
      running = false
      inflight = null
    })
    inflight = task
    return task
  }

  return {
    state,
    async setEnabled(enabled) {
      doc = { ...doc, enabled }
      await deps.store.save(doc)
      // 打开开关时立刻尝试一轮（今天已跑过则由 runIfDue 内部拦住）。
      // ⚠️ 不 await：一轮要串行打十几个上游，让按钮等它会让界面像卡死；
      // `state()` 里的 `running` 会立刻变成 true，界面据此显示「进行中」。
      if (enabled) void runIfDue()
      return state()
    },
    start() {
      if (pending !== null) return
      const ms = deps.delayMs ?? autoCheckinDelayMs()
      const fire = (): void => {
        pending = null
        void runIfDue()
      }
      // 延迟为 0 = 立刻跑（单测的默认形态，也是用户把环境变量设成 0 时的语义）。
      if (ms <= 0) {
        fire()
        return
      }
      pending = (deps.schedule ?? defaultSchedule)(fire, ms)
    },
    runIfDue,
    stop() {
      pending?.cancel()
      pending = null
    },
  }
}

/**
 * 默认排定：`setTimeout` + `unref()`。
 *
 * ⚠️ `unref()` 是必须的：否则一个 30 秒的待执行定时器会**拖住宿主进程退出**
 *（用户关掉 DSH 后进程还要多活半分钟）。与 `index.ts` 的续期定时器同一处理。
 */
function defaultSchedule(fn: () => void, ms: number): { cancel(): void } {
  const timer = setTimeout(fn, ms)
  timer.unref?.()
  return { cancel: () => clearTimeout(timer) }
}
