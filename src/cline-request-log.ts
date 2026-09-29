/**
 * Cline **请求记录**（本插件自己发出的推理请求流水）。
 *
 * ## 与网关 `/usages` 是两回事，不能互相替代
 *
 * | | 本模块（本地流水） | 网关 `/users/{id}/usages` |
 * |---|---|---|
 * | 记什么 | **本插件发出的**每笔请求 | 该账号在 Cline **官方所有渠道**的消费 |
 * | 延迟/首块 | ✓（只有调用方知道） | ✗ |
 * | 成本 | ✗（那是网关记账） | ✓ `costUsd` |
 *
 * 参考实现：`github.com/codeOct/dsh-cline-pass` 的请求记录部分 —— 它记录的
 * 同样是**自己适配器**发出的请求（字段 `ms` / `ttfb` / `ttft` / `usage` /
 * `error` / `account`），表格列为「时间 | 模型/上游 | TOKEN | 延迟」。
 * 本模块对齐这套字段。
 *
 * ## 存储是**进程内存**，重启即丢（刻意，与参考实现一致）
 *
 * 请求流水是高频写入的派生数据：持久化会把「每笔推理」都变成一次磁盘写，
 * 且记录的价值只在于「刚刚发生了什么」。上限 {@link CLINE_HISTORY_LIMIT} 条，
 * 新记录淘汰最旧的。
 *
 * ## ⚠️ 记录**绝不抛错**：它在推理的关键路径上
 *
 * `record()` 由适配器在流结束/失败时调用 —— 这里抛错会**反噬推理本身**。
 * 所有入参都被截断/钳制，写满即淘汰最旧。
 */

/** 记录上限（参考实现同值：DEFAULT_HISTORY_LIMIT = 100）。 */
export const CLINE_HISTORY_LIMIT = 100

/** 一条请求记录。 */
export interface ClineRequestEntry {
  /** 请求**发起**时刻（毫秒时间戳；表格按它显示「时间」）。 */
  ts: number
  /** 模型 id（wire 上请求的 `model`，如 `cline-pass/deepseek-v4.1-flash`）。 */
  model: string
  /** 发请求用的**账号**（账号池里的 `id`；换号后是**最终服务的那笔**）。 */
  accountId: string
  /** 输入 token（未命中缓存的部分）。 */
  inputTokens: number
  /** 输出 token。 */
  outputTokens: number
  /** 思考 token（上游不流式输出，只在 usage 里出现；缺失时省略）。 */
  reasoningTokens?: number
  /** 首个内容块耗时（毫秒）—— 解释「为什么等了这么久才出字」的关键数字。 */
  ttftMs: number
  /** 全程耗时（毫秒）。 */
  totalMs: number
  /** 失败原因；**成功时为 undefined**。 */
  error?: string
}

/** 内存中的流水（最新在前）。 */
let history: ClineRequestEntry[] = []

/**
 * 记录一笔请求。
 *
 * ⚠️ **本函数绝不抛错**：它由适配器在流结束/失败时调用，抛错会把
 * 记账失败反噬成推理失败 —— 那是比丢一条记录严重得多的故障。
 * 字段全部截断/钳制，`Object.freeze` 防止调用方后续修改共享对象。
 */
export function recordClineRequest(entry: Omit<ClineRequestEntry, 'ts'>): void {
  try {
    history.unshift(Object.freeze({
      ts: Date.now(),
      model: String(entry.model ?? '').slice(0, 120),
      accountId: String(entry.accountId ?? '').slice(0, 64),
      inputTokens: Math.max(0, Math.trunc(Number(entry.inputTokens ?? 0))) || 0,
      outputTokens: Math.max(0, Math.trunc(Number(entry.outputTokens ?? 0))) || 0,
      ...(Number(entry.reasoningTokens ?? 0) > 0
        ? { reasoningTokens: Math.trunc(Number(entry.reasoningTokens)) }
        : {}),
      ttftMs: Math.max(0, Math.trunc(Number(entry.ttftMs ?? 0))) || 0,
      totalMs: Math.max(0, Math.trunc(Number(entry.totalMs ?? 0))) || 0,
      ...(typeof entry.error === 'string' && entry.error.length > 0
        ? { error: entry.error.slice(0, 200) }
        : {}),
    }) as ClineRequestEntry)
    if (history.length > CLINE_HISTORY_LIMIT) history.length = CLINE_HISTORY_LIMIT
  } catch {
    // 记账失败绝不反噬推理（见函数注释）。
  }
}

/**
 * 读取请求流水（最新在前）。
 *
 * @param accountId - 只看该账号；缺省返回**全部**（含无账号的失败行）。
 * @param limit - 最多多少条（不超过上限）。
 */
export function readClineRequestHistory(
  options: { accountId?: string; limit?: number } = {},
): ClineRequestEntry[] {
  const needle = typeof options.accountId === 'string' && options.accountId.length > 0
    ? options.accountId
    : ''
  const limit = Math.max(0, Math.min(options.limit ?? CLINE_HISTORY_LIMIT, CLINE_HISTORY_LIMIT))
  return history
    .filter((entry) => needle === '' || entry.accountId === needle)
    .slice(0, limit)
}

/** 当前保留的流水条数（诊断用）。 */
export function clineRequestHistorySize(): number {
  return history.length
}

/**
 * 模型 id 的**模型族/上游**前缀（`/` 之前），如
 * `cline-pass/deepseek-v4.1-flash` → `cline-pass`。
 *
 * 与参考实现的「模型 / 上游」两列对应：上游是**网关按什么通道服务的**
 * （cline-pass 订阅 / cline-free 免费），模型是**具体哪个模型** ——
 * 两者是两个维度，合成一列会让「同名不同上游」的行无法区分。
 * 无 `/` 前缀时返回空串（表格那格显示「—」而非编一个值）。
 */
export function clineUpstreamOf(model: string): string {
  const idx = String(model ?? '').indexOf('/')
  return idx > 0 ? String(model).slice(0, idx) : ''
}

/** 清空流水（仅测试用：模块级状态会在用例间泄漏）。 */
export function resetClineRequestHistory(): void {
  history = []
}
