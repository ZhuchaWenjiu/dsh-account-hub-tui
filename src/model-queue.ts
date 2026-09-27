/**
 * **模型排队**错误的共享解析（Qoder 业务码 `10605`）。
 *
 * ## 为什么单独成模块
 *
 * 排队错误的**识别**发生在两个地方，而**解析逻辑必须只有一份**（否则必然漂移）：
 *
 * | 位置 | 场景 |
 * |---|---|
 * | `openai-compat.ts` 的 SSE 消费器 | HTTP **200** + 流内 `{code:"10605",…}` 帧 |
 * | `qoder-adapter.ts` 的 HTTP 分支 | HTTP **403** + 排队 JSON 体 |
 *
 * ⚠️ 放在这里而不是 `qoder-adapter.ts`：后者 import 前者，反向依赖会成环。
 *
 * ## 关键结构：`message` 是「一个 JSON 字符串」
 *
 * ```json
 * {"code":"10605","message":"{\"isQueued\":true,…,\"retryAfterSeconds\":30,…}"}
 * ```
 * 必须**二次解析** —— 客户端 `lFc()` 正是为此递归遍历
 * `data`/`result`/`message`/`body`，字符串再 `JSON.parse`。
 * **只读顶层 `code` 永远拿不到排队参数**（这是第一版修复漏掉 SSE 通道的根因）。
 *
 * ## 客户端权威实现（obf 产物取证）
 *
 * - 排队码 `mRA="10605"` → `model_queued`；认证码 `MF="105"` → `auth_error`
 *   —— **互相独立**（`rJc()`），绝不能合并；
 * - 延迟优先序（`kJa()`/`EV()`/`IRA()`）：`retry_after_ms` → `retryAfterMs`
 *   → `retryAfterSeconds × 1000` → 兜底 `Retry-After` 响应头；
 * - 决策（`W7c()`）：**有延迟就精确等它**，没有才退回指数退避。
 *
 * 取证脚本：`scripts/probe-qoder-queue-error.mjs`。
 */

/** Qoder 的排队业务码（客户端 obf 产物里的 `mRA`）。 */
export const QUEUE_BUSINESS_CODE = '10605'

/**
 * 单次排队等待的**封顶**（毫秒）。
 *
 * 用户要求：服务端给的排队时间 **< 10 秒按它的值**，**≥ 10 秒按 10 秒** ——
 * 避免一次阻塞 30 秒让 UI 长期停在「运行中」且无法区分「排队」与「卡死」。
 */
export const QUEUE_MAX_DELAY_MS = 10_000

/** 排队重试的**次数上限**（与 CodeArts 适配器的既有惯例一致）。 */
export const QUEUE_MAX_ATTEMPTS = 180

/** 排队错误里我们关心的字段（客户端 `PJa()` 的裁剪版）。 */
export interface QueueInfo {
  isQueued?: boolean
  modelKey?: string
  queueCount?: number
  queueType?: string
  serviceAvailable?: boolean
  retryAfterSeconds?: number
  waitTime?: number
  /** 毫秒口径的延迟（客户端 `kJa()` 优先取这个）。 */
  retry_after_ms?: number
  retryAfterMs?: number
}

/** 只接受有限数字（与客户端的 `RE()` 同口径）。 */
function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** 业务码是否命中排队（兼容字符串与数字两种编码）。 */
export function isQueueBusinessCode(code: unknown): boolean {
  return code === QUEUE_BUSINESS_CODE || code === Number(QUEUE_BUSINESS_CODE)
}

/**
 * 从一段响应体（或错误帧的 `message`）里解析**排队信息**；不是排队则 undefined。
 *
 * ## ⚠️ 两种入参形态都必须支持（踩过的坑）
 *
 * 1. **外层整体**：`{"code":"10605","message":"{…}"}`
 *    —— HTTP 403 形态（`qoder-adapter` 传这个）。
 * 2. **内层消息**：`{"isQueued":true,…,"retryAfterSeconds":30}`
 *    —— SSE 错误帧的 `data.message`（`openai-compat` 传这个）。
 *
 * ⚠️ **内层没有 `code` 字段**！若函数要求「必须命中 code 才算排队」，形态 2 会
 * 被判成 undefined —— 第一版就这么写的，实测导致 SSE 通道修复**静默失效**
 * （探针显示 `sleep 次数 = 0`，错误照旧抛 `SERVER`）。
 *
 * 故判据改为：**命中 `code=10605`，或直接出现排队字段（`isQueued` /
 * `serviceAvailable`）** 即视为排队。调用方（SSE 消费器）已在外层确认过
 * 业务码，这里只需正确取出字段。
 *
 * @param body - 响应体原文、已解析对象，或错误帧的 `message` 字符串。
 * @returns 排队信息；既没命中 `10605` 也没有排队字段时 undefined。
 */
export function parseQueueError(body: unknown): QueueInfo | undefined {
  let root: unknown = body
  if (typeof body === 'string') {
    try { root = JSON.parse(body) } catch { return undefined }
  }
  if (root === null || typeof root !== 'object') return undefined

  // 广度优先展开 data / result / message / body（客户端 lFc() 的键集）。
  const seen = new Set<unknown>()
  const nodes: Array<Record<string, unknown>> = []
  const queue: unknown[] = [root]
  while (queue.length > 0) {
    const node = queue.shift()
    if (node === null || typeof node !== 'object' || seen.has(node)) continue
    seen.add(node)
    const record = node as Record<string, unknown>
    nodes.push(record)
    for (const key of ['data', 'result', 'message', 'body']) {
      const value = record[key]
      if (value !== null && typeof value === 'object') queue.push(value)
      else if (typeof value === 'string' && value.length > 0) {
        try { queue.push(JSON.parse(value)) } catch { /* 非 JSON，忽略 */ }
      }
    }
  }

  // 取第一个含排队标志的节点（客户端 dFc()/PJa() 同口径）。
  const info = nodes.find((node) => node.isQueued !== undefined || node.serviceAvailable !== undefined)
  if (info === undefined) return undefined

  // 业务码命中 **或** 含排队标志即视为排队（见函数注释）。
  //
  // ⚠️ **不能要求 `isQueued === true`**：瞬时排队（服务端可立即处理）实测为
  // `isQueued:false, serviceAvailable:true, waitTime:0, retryAfterSeconds:2` ——
  // 用户报告「一次重试就能成功」，正是这一形态。若要求 `true`，它会落到
  // 兜底 1 秒退避（写单测时实测到了：期望 2000ms 实际 1000ms）。
  const codeHit = nodes.some((node) => isQueueBusinessCode(node.code))
  if (!codeHit && info.isQueued === undefined) return undefined

  const out: QueueInfo = {}
  if (typeof info.isQueued === 'boolean') out.isQueued = info.isQueued
  if (typeof info.modelKey === 'string' && info.modelKey.length > 0) out.modelKey = info.modelKey
  if (typeof info.queueType === 'string' && info.queueType.length > 0) out.queueType = info.queueType
  if (typeof info.serviceAvailable === 'boolean') out.serviceAvailable = info.serviceAvailable
  for (const key of ['queueCount', 'retryAfterSeconds', 'waitTime', 'retry_after_ms', 'retryAfterMs'] as const) {
    const value = readFiniteNumber(info[key])
    if (value !== undefined) out[key] = Math.trunc(value)
  }
  return out
}

/**
 * 算出本次排队该等多久（毫秒）；无法判定时返回 undefined（交调用方退避）。
 *
 * 取值优先序：`retry_after_ms` → `retryAfterMs` → `retryAfterSeconds × 1000`，
 * 命中即用并**封顶** {@link QUEUE_MAX_DELAY_MS}。
 *
 * ⚠️ **非法值一律忽略而不是当 0**：客户端 `W7c()` 对非有限/负值直接判 fail。
 * 当 0 会变成「立即重试」的忙循环，把机会瞬间烧掉。
 */
export function queueDelayMs(info: QueueInfo | undefined): number | undefined {
  if (info === undefined) return undefined
  const ms = readFiniteNumber(info.retry_after_ms) ?? readFiniteNumber(info.retryAfterMs)
  const fromSeconds = readFiniteNumber(info.retryAfterSeconds)
  const raw = ms ?? (fromSeconds === undefined ? undefined : fromSeconds * 1000)
  if (raw === undefined || raw < 0) return undefined
  return Math.min(Math.trunc(raw), QUEUE_MAX_DELAY_MS)
}
