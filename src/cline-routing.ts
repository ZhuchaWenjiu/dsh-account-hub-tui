/**
 * 从网关响应帧里读出**真正服务这笔请求的上游渠道**。
 *
 * ## 为什么需要（真实缺陷，用户报障 2026-09-30）
 *
 * 用户报障：「上游显示的不正确」。
 *
 * 原先「请求记录」的「上游」列取的是**模型 id 的 `/` 前缀**
 * （`clineUpstreamOf(model)`）—— 那其实是**模型命名空间/订阅通道**
 * （`cline-pass` / `cline-free`），甚至可能是**厂商名**
 * （`deepseek/deepseek-v4.1-flash` → `deepseek`），**不是**服务这笔请求的渠道。
 * 参考实现（`github.com/codeOct/dsh-cline-pass`）的同一列显示的是
 * `alibaba` / `baseten` 这类**真实 serving channel**，取自网关下发的路由元数据。
 *
 * ## 三种实测形态（参考实现 `parseRouting()` 的同款覆盖）
 *
 * | 形态 | 路径 | 例 |
 * |---|---|---|
 * | **planner 管线** | `choices[0].message.provider_metadata.gateway.routing.finalProvider` | `alibaba` |
 * | 同上（**流式帧**） | 顶层 `provider_metadata.gateway.routing.finalProvider` | `alibaba` |
 * | **direct 管线** | 顶层 `provider` | `GMICloud` |
 *
 * ⚠️ 参考实现注释原文：*"in a stream it appears on whichever frame carries it,
 * so every frame is inspected and the last non-null reading wins"* ——
 * 故调用方必须**逐帧**喂进来，且**以最后一次非空读数为准**。
 *
 * ⚠️ **大小写两种拼写都要认**：错误体实测用的是 camelCase
 * （`providerMetadata.gateway.routing.modelAttempts[].providerAttempts[]`，
 * 见 AGENTS.md 的 Gemini-400 段），成功路径的样例是 snake_case
 * （`provider_metadata`）。只认一种会在另一种形态下静默读不到。
 *
 * ⚠️ **读不到就返回空串**（调用方回落到模型命名空间）——绝不编造渠道名。
 */

/** 按点号路径取值，任一层不是对象就返回 `undefined`。 */
function dig(value: unknown, path: readonly string[]): unknown {
  let current: unknown = value
  for (const key of path) {
    if (typeof current !== 'object' || current === null) return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

/** 非空字符串才算读数（空串 / 数字 / 对象一律视为「没读到」）。 */
function asText(value: unknown): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : ''
}

/**
 * 从**一帧**已解析的响应 JSON 里读出上游渠道（读不到返回空串）。
 *
 * 调用方应逐帧调用并保留最后一个非空结果。
 */
export function parseClineRouting(frame: unknown): string {
  if (typeof frame !== 'object' || frame === null) return ''
  // 有的网关把成功载荷再套一层 `data`（参考实现的 `unwrapEnvelope`）。
  const envelope = dig(frame, ['data'])
  const payload = typeof envelope === 'object' && envelope !== null ? envelope : frame

  const message = dig(payload, ['choices', '0', 'message'])
  const providers = ['provider_metadata', 'providerMetadata'] as const
  for (const key of providers) {
    // 1) 非流式：挂在 message 上。
    const onMessage = asText(dig(message, [key, 'gateway', 'routing', 'finalProvider']))
    if (onMessage.length > 0) return onMessage
    // 2) 流式：挂在帧的顶层。
    const onFrame = asText(dig(payload, [key, 'gateway', 'routing', 'finalProvider']))
    if (onFrame.length > 0) return onFrame
  }
  // 3) direct 管线：顶层 `provider`（大小写混排的展示名，原样保留）。
  return asText(dig(payload, ['provider']))
}
