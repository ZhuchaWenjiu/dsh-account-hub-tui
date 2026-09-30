/**
 * Cline 模型的**输入模态**（图片能力）来源：**models.dev 公开目录**。
 *
 * ## 为什么需要（真实缺陷，用户报障 2026-09-30）
 *
 * 用户报障原文：「这个插件中支持图片的模型发送不了图片」。
 *
 * **根因**：适配器判定图片能力时**只看本地兜底表**
 * （`product.fallbackModels[].supportsImage`，全表只有 5 条、且全是
 * `cline-free/*`），而远端两个目录端点**都不下发任何能力字段** ——
 * 实测（2026-09-30，本机直连）`recommended-models` 的条目
 * 只有 `{ id, name, description, tags }`，`/api/v1/models` 只有裸 `id`。
 *
 * 于是 `cline-pass/*`（18 条）与远端数百条模型**一律被播报成纯文本**：
 * DSH 按适配器播报的 `inputModalities` 决定要不要把图片投影成文本占位符
 * （见 `ClineAdapter.stream()` 的注释），所以用户**连发都发不出去**，
 * 报 `cline: 模型 "…" 不支持图片输入` —— 尽管模型本身是支持图片的。
 *
 * ## 取值来源与实测依据
 *
 * `https://models.dev/api.json` 的 **`cline-pass` provider 块**逐模型标注了
 * `modalities.input`。实测该块有 **18 条** `cline-pass/*` 模型，例如：
 *
 * | 模型 | `modalities.input` |
 * |---|---|
 * | `cline-pass/deepseek-v4.1-flash` | `["text","image"]` ← **用户当前用的就是它** |
 * | `cline-pass/mimo-v2.6-flash` | `["text","image","audio","video"]` |
 * | `cline-pass/minimax-m3` | `["text","image","video"]` |
 * | `cline-pass/glm-5.3` | `["text"]`（确实不带图） |
 *
 * 参考实现（`github.com/codeOct/dsh-cline-pass` 的 `MODELS_DEV_URL`）用的
 * **正是同一来源**：它把该目录当作「官方扫描」，专为覆盖「发布晚于本版本、
 * 因此不在自带表里」的模型 —— 注释原文：
 * *"Without it a model newer than this release resolves to the `text` fallback
 * and the harness refuses every image for it, silently."* 同一类缺陷。
 *
 * ## 三条口径（与参考实现一致，别自作聪明）
 *
 * 1. **只认 `image`**：models.dev 还会报 `audio` / `video` / `pdf`，而 DSH 的
 *    模态词表只有 `text` / `image`（参考实现同样**夹取**到这两个值）。
 * 2. **本地兜底表优先级更高**：它是从官方客户端内嵌目录策展出来的，
 *    本模块只负责补它覆盖不到的模型（`supportsImage` 显式 `false` 也照样赢）。
 * 3. **失败绝不抛到调用方**：拿不到就退回「未知」（保守按纯文本），
 *    绝不能让一次目录抖动把**所有**模型的图片能力打回原形。
 */

import { TtlCache } from './ttl-cache.js'

/** 社区模型目录（公开、无需认证）。与参考实现的 `MODELS_DEV_URL` 同源。 */
export const CLINE_MODELS_DEV_URL = 'https://models.dev/api.json'

/** 单次目录请求超时（毫秒）。 */
export const CLINE_MODALITIES_TIMEOUT_MS = 20_000

/**
 * 缓存有效期。
 *
 * 用**长 TTL**（而不是像 captcha 配置那样 60 秒）：这份目录是**发布节奏**的
 * 数据（新模型上线才变），进程内按小时级刷新足够；每次会话都去拉一次
 * 既慢又无意义。⚠️ 仍要**有** TTL 而不是永久缓存 —— 上游新增模型后
 * 不该要求用户重启进程（这正是 `TtlCache` 模块头注释里记的那条缺陷）。
 */
export const CLINE_MODALITIES_TTL_MS = 6 * 60 * 60 * 1000

/**
 * 解析 models.dev 目录，得到 `模型 id → 是否接受图片输入`。
 *
 * ⚠️ provider 块的位置有**两种**实测形态（参考实现两者都认）：
 * `json['cline-pass']`（本机实测就是这种）与 `json.providers['cline-pass']`。
 *
 * ⚠️ 模型 id 可能是**裸 id**（`deepseek-v4.1-flash`）也可能已带前缀 ——
 * 前者补 `cline-pass/` 前缀后才是本插件路由上真正使用的 id。
 *
 * @returns 仅含**能从模态字段读出结论**的条目；`input` 缺失的模型不入表
 *   （「没读到」不等于「不支持」，交给调用方走兜底）。
 */
export function parseClineModalities(value: unknown): Map<string, boolean> {
  const out = new Map<string, boolean>()
  if (typeof value !== 'object' || value === null) return out
  const root = value as Record<string, unknown>
  const providers = typeof root.providers === 'object' && root.providers !== null
    ? root.providers as Record<string, unknown>
    : undefined
  const block = providers?.['cline-pass'] ?? root['cline-pass']
  if (typeof block !== 'object' || block === null) return out
  const models = (block as Record<string, unknown>).models
  if (typeof models !== 'object' || models === null) return out

  for (const [rawId, rawEntry] of Object.entries(models as Record<string, unknown>)) {
    if (rawId.length === 0) continue
    if (typeof rawEntry !== 'object' || rawEntry === null) continue
    const modalities = (rawEntry as Record<string, unknown>).modalities
    if (typeof modalities !== 'object' || modalities === null) continue
    const input = (modalities as Record<string, unknown>).input
    if (!Array.isArray(input)) continue
    const id = rawId.startsWith('cline-pass/') ? rawId : `cline-pass/${rawId}`
    out.set(id, input.some((item) => typeof item === 'string' && item.toLowerCase() === 'image'))
  }
  return out
}

/** {@link makeClineModalitiesLoader} 的选项（全部可注入，便于离线单测）。 */
export interface ClineModalitiesLoaderOptions {
  /** 覆盖 fetch（测试用）。 */
  fetcher?: typeof fetch
  /** 覆盖 TTL。 */
  ttlMs?: number
  /** 覆盖时钟（测试用）。 */
  now?: () => number
}

/**
 * 造一个「取模态表」的加载器：**带 TTL 与在飞去重**，失败**向上抛**。
 *
 * ⚠️ 失败必须抛（而不是返回空表）：`TtlCache` 只在成功时写入缓存，
 * 抛错才能让下一次调用**重试**，也才能让调用方区分「没读到」与
 * 「读到了且不支持」—— 把失败记成空表会把所有模型的图片能力永久打回纯文本。
 */
export function makeClineModalitiesLoader(
  options: ClineModalitiesLoaderOptions = {},
): () => Promise<Map<string, boolean>> {
  const fetcher = options.fetcher ?? fetch
  const cache = new TtlCache<Map<string, boolean>>({
    ttlMs: options.ttlMs ?? CLINE_MODALITIES_TTL_MS,
    ...options.now === undefined ? {} : { now: options.now },
    load: async () => {
      const response = await fetcher(CLINE_MODELS_DEV_URL, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(CLINE_MODALITIES_TIMEOUT_MS),
      })
      if (!response.ok) throw new Error(`models.dev HTTP ${response.status}`)
      return parseClineModalities(await response.json())
    },
  })
  return async () => await cache.get()
}
