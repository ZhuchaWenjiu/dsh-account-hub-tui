/**
 * Cline **订阅额度**（官方额度窗口）与**请求记录**查询。
 *
 * 与 `src/cline-credits.ts`（余额）分开成模块：余额是「还剩多少钱」，
 * 订阅额度是「这几个时间窗各用掉了百分之几」，两者端点、形状、失败语义
 * 都不同，混在一个文件里会让各自的判据互相干扰。
 *
 * ## 端点（参考 `github.com/codeOct/dsh-cline-pass` 的额度管理实现）
 *
 * ```
 * GET {apiBase}/api/v1/users/me/plan/usage-limits
 *   → { success: true, data: { limits: [{ type, percentUsed, resetsAt }] } }
 *      type ∈ five_hour | weekly | monthly          ← 订阅额度窗口
 *
 * GET {apiBase}/api/v1/users/{userId}/usages
 *   → { success: true, data: { items: [...], nextToken } }
 *      item = { aiModelName, aiModelTypeName, totalTokens, creditsUsed, costUsd, createdAt }
 *                                                  ← 请求记录（网关自己的流水）
 * ```
 *
 * ## ⚠️ 实测踩过的坑（沿用本项目既有的核实结论，不要重新踩）
 *
 * 1. **分页参数只认 `cursor`**，且值取自响应里的 `data.nextToken`。
 *    `nextToken` / `next_token` / `page` / `offset` / `skip` 作为**请求参数**
 *    会被网关**静默忽略** —— 永远返回同一页。早期据此连翻会重复计数，
 *    得出「已用 28 亿 token、超限 120%」这种荒谬结果。
 * 2. **`data.total` 恒为 0**，不能用来算页数或总量。
 * 3. **`/usages` 忽略 `startDate` / `endDate`**：只按时间**倒序**返回，
 *    要按窗口截断只能读每行的 `createdAt`。
 * 4. **`resetsAt` 是 ISO 字符串**，不是数字时间戳 —— 不要按毫秒去 `new Date()`。
 * 5. **`userId` 用凭据里的 `account_id`（`usr-…`）**，不是 JWT 的 `sub`
 *    （`user_…`）：后者实测 `400 Invalid request format`（见 `cline-credits.ts`）。
 *
 * ## 失败一律「作为数据上报」，不抛错
 *
 * 额度与请求记录都是**附加信息**：面板上的账号管理、模型开关、登录等功能
 * 不依赖它们。因此读取失败必须降级成一条可读原因（含 HTTP 状态与响应体摘要），
 * 而不是让整个面板挂掉 —— 与 `fetchClineCreditBalance` 同约定。
 *
 * ## ⚠️ 不把「查不到」显示成 0
 *
 * `percentUsed: 0` 是「这个窗口一点没用」的合法语义。查询失败必须以
 * `ok: false` + `error` 表达，由调用方显示原因 —— 把失败渲染成 0% 会让用户
 * 以为自己额度充足（与其余 provider「查不到不显示成 0」的约定一致）。
 */

import { clineAuthHeaders, type ClineCredential } from './cline.js'
import type { ClineProduct } from './cline-product.js'

/** 单次额度/请求记录请求超时（毫秒；与余额同档）。 */
export const CLINE_QUOTA_TIMEOUT_MS = 30_000

/**
 * 订阅额度窗口端点。
 *
 * ⚠️ 路径段是 `users/me`（**字面量 `me`**，不是账号 id）—— 由网关按 Bearer
 * 令牌自行判定账号。故本端点**不要求**凭据里有 `account_id`，这让
 * 「凭据缺 account_id」的账号也仍能看到额度。
 */
export const CLINE_USAGE_LIMITS_PATH = '/api/v1/users/me/plan/usage-limits'

/**
 * 请求记录每页的行数上限提示。
 *
 * ⚠️ 200 是**网关实际给的**：要更多会被接受并**静默截断** ——
 * 所以「翻 N 页就能覆盖多少历史」不能按请求值算。
 */
export const CLINE_USAGE_PAGE_SIZE = 200

/** 一个额度窗口。 */
export interface ClineQuotaWindow {
  /** 窗口类型：`five_hour` / `weekly` / `monthly`（网关新增的类型原样透传）。 */
  type: string
  /** 已用百分比（网关原值，0–100 之外的值也如实透传，不在解析层夹取）。 */
  percentUsed: number
  /** 窗口重置时刻（**ISO 字符串**，可能为空串）。 */
  resetsAt: string
}

/** 额度查询结果。 */
export interface ClineQuotaResult {
  ok: boolean
  windows: ClineQuotaWindow[]
  /** 失败原因；成功但网关附带文案时也可能有值。 */
  error?: string
}

/** 请求记录的一行。 */
export interface ClineRequestRow {
  /** 发生时刻（ISO 字符串；网关未给则为空串）。 */
  createdAt: string
  /** 模型展示名（`aiModelName`，缺省回落到 `aiModelTypeName`）。 */
  model: string
  /** 模型族/上游（`aiModelTypeName`，例如 `cline-free`）。 */
  modelType: string
  /** 总 token（`totalTokens`，缺省由 prompt + completion 现算）。 */
  totalTokens: number
  /** 该请求消耗的积分（网关原值）。 */
  creditsUsed: number
  /** 该请求的成本（网关自己的微美元记账口径，原值透传）。 */
  costUsd: number
}

/** 请求记录查询结果。 */
export interface ClineRequestLogResult {
  ok: boolean
  rows: ClineRequestRow[]
  /** 下一页游标（网关没给更多时为 undefined）。 */
  nextToken?: string
  error?: string
}

/** 从响应里读数值型字段（同时接受数字与数字字符串）。 */
function readNumber(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

/** 从响应里读非空字符串字段。 */
function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key]
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/** 网关自己的一句话解释（`error` 可能是字符串或 `{message}`）。 */
function firstMessage(envelope: unknown): string {
  if (typeof envelope !== 'object' || envelope === null) return ''
  const record = envelope as Record<string, unknown>
  if (typeof record.error === 'string' && record.error.trim().length > 0) return record.error.trim()
  if (typeof record.message === 'string' && record.message.trim().length > 0) return record.message.trim()
  const nested = record.error
  if (typeof nested === 'object' && nested !== null) {
    const inner = (nested as Record<string, unknown>).message
    if (typeof inner === 'string' && inner.trim().length > 0) return inner.trim()
  }
  return ''
}

/**
 * 解包 `{ success, data }` 信封。
 *
 * ⚠️ **信封不是契约**：同族的余额端点实测有两种失败形态
 * （业务层 `{success:false,error}` / 网关层 `{error}` **没有 `success`**），
 * 故这里只在**确实有 `data` 对象**时取它，否则把顶层当作载荷本身 ——
 * 这样网关某天直接回数组/裸对象时仍能解析。
 */
function unwrapData(envelope: unknown): Record<string, unknown> | undefined {
  if (typeof envelope !== 'object' || envelope === null) return undefined
  const record = envelope as Record<string, unknown>
  const data = record.data
  if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
    return data as Record<string, unknown>
  }
  return record
}

/**
 * 解析订阅额度响应。
 *
 * ⚠️ **窗口列表按网关给的原序透传，不映射到固定形状**：网关将来新增窗口
 * （例如 `daily`）时，面板多一行即可，**不需要**为它发一个插件版本。
 * 这正是把 `type` 当字符串而非联合类型的原因。
 *
 * ⚠️ **`percentUsed` 不做夹取**：网关若给 120（超额），如实透传 ——
 * 夹到 100 会把「已超限」显示成「刚好用完」，那正是最该看见的信息。
 */
export function parseClineUsageLimits(value: unknown): { windows: ClineQuotaWindow[]; error?: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { windows: [], error: '响应不是 JSON 对象' }
  }
  const record = value as Record<string, unknown>
  // 失败形态优先：`success:false` 或带 `error` 且未声明成功。
  const serverError = firstMessage(record)
  if (record.success === false || (serverError !== '' && record.success !== true)) {
    return { windows: [], error: serverError !== '' ? serverError : '服务端返回失败' }
  }
  const payload = unwrapData(record)
  if (payload === undefined) return { windows: [], error: '响应缺少 data 字段' }
  const raw = payload.limits
  if (!Array.isArray(raw)) return { windows: [], error: '响应缺少 limits 字段' }
  const windows: ClineQuotaWindow[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue
    const entry = item as Record<string, unknown>
    const type = readString(entry, 'type')
    // 没有 type 的行无法归属到任何窗口，丢弃比显示一行"未知窗口"更有用。
    if (type === undefined) continue
    windows.push({
      type,
      percentUsed: readNumber(entry, 'percentUsed') ?? 0,
      // ⚠️ `resetsAt` 是 ISO 字符串。若网关某天回数字时间戳，也不要在这里
      // 猜单位（秒/毫秒），原样转成字符串交由展示层判定 —— 猜错会显示
      // 1970 年或 5 万年后的时间，比不显示更难排查。
      resetsAt: readString(entry, 'resetsAt') ?? '',
    })
  }
  return { windows, error: serverError === '' ? undefined : serverError }
}

/**
 * 读取单个账号的**订阅额度窗口**。
 *
 * 失败作为数据返回（`ok:false` + `error`），不抛错。
 */
export async function fetchClineUsageLimits(
  credential: ClineCredential,
  product: ClineProduct,
  fetcher: typeof fetch = fetch,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<ClineQuotaResult> {
  const refusal = { ok: false, windows: [], error: '额度端点不可用' }
  const url = `${product.apiBase}${CLINE_USAGE_LIMITS_PATH}`
  let response: Response
  try {
    response = await fetcher(url, {
      method: 'GET',
      headers: clineAuthHeaders(credential.access_token, product),
      signal: options.signal ?? AbortSignal.timeout(options.timeoutMs ?? CLINE_QUOTA_TIMEOUT_MS),
    })
  } catch (error) {
    return { ...refusal, error: `额度查询网络失败：${error instanceof Error ? error.message : String(error)}` }
  }
  let text = ''
  try {
    text = await response.text()
  } catch (error) {
    return { ...refusal, error: `额度响应读取失败：${error instanceof Error ? error.message : String(error)}` }
  }
  let parsed: unknown = null
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = null
    }
  }
  if (parsed === null) {
    // ⚠️ 网关出错时可能回 HTML（`Unexpected token '<'` 那类），把前缀带上
    // 才有线索 —— 本仓库已有过一次「HTML 错误页被当成 JSON 解析失败」的报障。
    return { ...refusal, error: `额度响应不是 JSON（HTTP ${response.status}）：${text.slice(0, 120)}` }
  }
  if (!response.ok) {
    const detail = firstMessage(parsed)
    return {
      ...refusal,
      error: `额度查询失败（HTTP ${response.status}）${detail === '' ? '' : `：${detail}`}`,
    }
  }
  const result = parseClineUsageLimits(parsed)
  if (result.error !== undefined && result.windows.length === 0) {
    return { ok: false, windows: [], error: result.error }
  }
  return { ok: true, windows: result.windows, ...result.error === undefined ? {} : { error: result.error } }
}

/**
 * 解析请求记录响应。
 *
 * 行的字段名以**网关实测**为准（`aiModelName` / `aiModelTypeName` /
 * `totalTokens` / `creditsUsed` / `costUsd`），并容忍 `createdAt` 的
 * 蛇形别名 —— 采集时只在一条真实流水上见过它，别名属于防御性读取。
 */
export function parseClineRequestLog(value: unknown): { rows: ClineRequestRow[]; nextToken?: string; error?: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { rows: [], error: '响应不是 JSON 对象' }
  }
  const record = value as Record<string, unknown>
  const serverError = firstMessage(record)
  if (record.success === false || (serverError !== '' && record.success !== true)) {
    return { rows: [], error: serverError !== '' ? serverError : '服务端返回失败' }
  }
  const payload = unwrapData(record)
  if (payload === undefined) return { rows: [], error: '响应缺少 data 字段' }
  const raw = payload.items
  if (!Array.isArray(raw)) return { rows: [], error: '响应缺少 items 字段' }
  const rows: ClineRequestRow[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue
    const entry = item as Record<string, unknown>
    const prompt = readNumber(entry, 'promptTokens') ?? 0
    const completion = readNumber(entry, 'completionTokens') ?? 0
    rows.push({
      createdAt: readString(entry, 'createdAt') ?? readString(entry, 'created_at') ?? '',
      model: readString(entry, 'aiModelName') ?? readString(entry, 'aiModelTypeName') ?? '',
      modelType: readString(entry, 'aiModelTypeName') ?? '',
      // `totalTokens` 缺省时由两个分量现算 —— 直接给 0 会让「有消耗但没记录
      // 总量」的行看起来像没花钱，而它是真实请求。
      totalTokens: readNumber(entry, 'totalTokens') ?? (prompt + completion),
      creditsUsed: readNumber(entry, 'creditsUsed') ?? 0,
      costUsd: readNumber(entry, 'costUsd') ?? 0,
    })
  }
  return {
    rows,
    // ⚠️ 分页游标就是响应里的 `nextToken`（见模块头注释第 1 条）。
    ...readString(payload, 'nextToken') === undefined ? {} : { nextToken: readString(payload, 'nextToken') },
    ...serverError === '' ? {} : { error: serverError },
  }
}

/**
 * 读取单个账号的**请求记录**（网关自己的流水）。
 *
 * ⚠️ **`userId` 必须用 `account_id`（`usr-…`）**：见模块头注释第 5 条。
 * 缺 `account_id` 时返回可读原因，**不发请求**（发出去必然 400，
 * 那正是「对不支持的输入无条件发请求」那类缺陷）。
 *
 * @param cursor - 上一页返回的 `nextToken`；不传表示第一页。
 */
export async function fetchClineRequestLog(
  credential: ClineCredential,
  product: ClineProduct,
  fetcher: typeof fetch = fetch,
  options: { cursor?: string; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<ClineRequestLogResult> {
  const refusal = { ok: false, rows: [], error: '请求记录端点不可用' }
  const userId = typeof credential.account_id === 'string' ? credential.account_id.trim() : ''
  if (userId.length === 0) {
    return { ...refusal, error: '凭据缺少账号 id，无法查询请求记录' }
  }
  const query = options.cursor === undefined || options.cursor === ''
    ? ''
    : `?cursor=${encodeURIComponent(options.cursor)}`
  const url = `${product.apiBase}/api/v1/users/${encodeURIComponent(userId)}/usages${query}`
  let response: Response
  try {
    response = await fetcher(url, {
      method: 'GET',
      headers: clineAuthHeaders(credential.access_token, product),
      signal: options.signal ?? AbortSignal.timeout(options.timeoutMs ?? CLINE_QUOTA_TIMEOUT_MS),
    })
  } catch (error) {
    return { ...refusal, error: `请求记录网络失败：${error instanceof Error ? error.message : String(error)}` }
  }
  let text = ''
  try {
    text = await response.text()
  } catch (error) {
    return { ...refusal, error: `请求记录响应读取失败：${error instanceof Error ? error.message : String(error)}` }
  }
  let parsed: unknown = null
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = null
    }
  }
  if (parsed === null) {
    return { ...refusal, error: `请求记录响应不是 JSON（HTTP ${response.status}）：${text.slice(0, 120)}` }
  }
  if (!response.ok) {
    const detail = firstMessage(parsed)
    return {
      ...refusal,
      error: `请求记录查询失败（HTTP ${response.status}）${detail === '' ? '' : `：${detail}`}`,
    }
  }
  const result = parseClineRequestLog(parsed)
  if (result.error !== undefined && result.rows.length === 0) {
    return { ok: false, rows: [], error: result.error }
  }
  return {
    ok: true,
    rows: result.rows,
    ...result.nextToken === undefined ? {} : { nextToken: result.nextToken },
    ...result.error === undefined ? {} : { error: result.error },
  }
}
