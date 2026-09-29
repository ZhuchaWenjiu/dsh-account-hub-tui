/**
 * ZCode（智谱 z.ai 免费额度）LLM 适配器。
 *
 * ## 与其它 provider 的共同点
 *
 * 「读凭据 → 直发远端」—— 这一点与 CodeArts / Buddy / Qoder 等**相同**。
 * 用户装好官方 ZCode 客户端并登录一次即可，不需要任何实例常驻。
 *
 * ## 与其它 provider 的差异（全部实测）
 *
 * | 维度 | ZCode | 对照 |
 * |---|---|---|
 * | 凭据来源 | 解密磁盘 `~/.zcode/v2/credentials.json`（AES-256-GCM） | 浏览器登录拿 token |
 * | 协议 | **Anthropic Messages**（非 OpenAI） | 其余多为 OpenAI 兼容 |
 * | 每请求前置 | **产出一个阿里云 captcha**（约 1.2 秒） | 无 |
 * | 请求体准入 | **必须带官方身份块 + 首轮日期块**（否则 3012） | 无 |
 * | 续期 | 无（静态凭据） | 多数有 refresh_token |
 *
 * ## 三个必须真的做到的点
 *
 * 1. **`system` 必须带官方身份块** —— 缺了上游回 `3012 unusual activity`
 *    （实测矩阵见 `zcode-identity.ts`）。且这是**请求体内容**层面的判据，
 *    与 HTTP 头、运行时无关。
 * 2. **首轮 user 消息要带 `<system-reminder>` 日期块** —— 桥侧源码称之为
 *    「3012 的最后一个开关」。
 * 3. **`tools` 必须真的下发**（转成 Anthropic 的扁平 `input_schema` 形态）——
 *    Qoder 与 TRAE 都因漏发而让模型在正文里臆造 XML 工具调用、harness
 *    认不出 → 任务终止。
 *
 * ## ⚠ captcha 是每请求一次，且**不能复用**
 *
 * 上游对缺失 captcha 的请求回 `3007`。而 captcha param **一次性**——
 * 复用同一个会再得 `3007`（实测：同一页面上重复 mint 必 `F001`）。
 * 故每次 `stream()` 都要产出一个新 param（约 1.2 秒）。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { LlmAdapter, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { AccountPool, providerCatalogVisible } from './account-pool.js'
import { settingsNamespaceFor } from './settings-compat.js'
import { collectImages, serializeMessages } from './openai-compat.js'
import { projectRequestImage, type ImageRequestTarget } from './image-budget.js'
import type { ZcodeCredential } from './zcode.js'
import { ZCODE, type ZcodeFallbackModel, type ZcodeProduct, type ZcodeRemoteModelLike } from './zcode-product.js'
import {
  ZCODE_PLAN_MESSAGES_URL,
  buildZcodeHeaders,
} from './zcode-upstream.js'
import {
  buildZcodeSystemBlocks,
  withContextPrefix,
} from './zcode-identity.js'
import {
  consumeAnthropicSse,
  toAnthropicMessages,
  toAnthropicTools,
} from './zcode-anthropic.js'
import {
  ZcodeCaptchaBrowser,
  ZCODE_CAPTCHA_FALLBACK,
  type ZcodeCaptchaConfig,
} from './zcode-captcha.js'

/** 本适配器注册的 provider 路由名（等价于 `ZCODE.id`）。 */
export const PROVIDER = 'zcode'

/** 远端模型条目（已归一）。 */
export type ZcodeRemoteModel = ZcodeRemoteModelLike

/**
 * 思考档位的**展示名**。
 *
 * ⚠ **只用于展示** —— 发给上游的 `id` 必须保持小写（见 `resolveModel`）。
 * 两者混用会让上游认不出档次，是本仓库 qoder 那边记过的同型风险。
 *
 * 上游没提供档位的 i18n 名（`app.asar` 里搜不到，官方 IDE 也直接显示
 * `low`/`high`/`max`），故按用户要求用**首字母大写**：
 * 小写形态在 DSH 的选择器里看着像标识符而不像可选项。
 *
 * 未知档位原样返回（上游加了新档位时不至于显示成空白）。
 */
export function reasoningEffortLabel(id: string): string {
  if (id.length === 0) return id
  return id.charAt(0).toUpperCase() + id.slice(1)
}

/** 兜底表条目转远端形状。 */
function fallbackToRemote(model: ZcodeFallbackModel): ZcodeRemoteModel {
  return {
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    supportsImage: model.supportsImage,
    /**
     * ⚠ **档位必须一起搬** —— 漏了它，`resolveModel()` 就拿不到
     * `reasoningLevels`，思考档位选择器不会出现（用户报障的那个缺陷）。
     */
    ...model.reasoningLevels !== undefined ? { reasoningLevels: model.reasoningLevels } : {},
    ...model.defaultReasoningLevel !== undefined
      ? { defaultReasoningLevel: model.defaultReasoningLevel }
      : {},
  }
}

/**
 * 只放行**安全正整数**。
 *
 * ⚠ 远端是外部输入：`0` / 负数 / `NaN` 会让 DSH 在
 * `defaultMaxTokens` 的硬校验上抛 `INVALID_MODEL_MAX_TOKENS`，
 * **整轮对话起不来**（不是降级，是崩）。
 */
function positiveMaxTokens(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/** `ZcodeAdapter` 的构造选项。 */
export interface ZcodeAdapterOptions {
  /** 单凭据回退 ref（无账号池时）。 */
  credentialRef: CredentialRef
  /** 解析当前可用凭据。 */
  resolveCredential: (modelId?: string) => Promise<ZcodeCredential | undefined>
  /**
   * 凭据失效时的处理。
   *
   * ⚠ ZCode **不可续期**（凭据是静态的）。这个回调存在只是为了让适配器
   * 与其它 provider 同形；实现应当**重读磁盘凭据**而不是去调 refresh 端点。
   */
  refresh: () => Promise<void>
  /**
   * 产出一个**新鲜**的 captcha param。
   *
   * 由 `index.ts` 注入（它持有 `ZcodeAuth`，能从服务端拉 captcha 配置并
   * 驱动浏览器）。缺省时适配器会自建一个常驻浏览器。
   *
   * ⚠ `options.signal` 必须被**透传**到浏览器侧（`ZcodeCaptchaBrowser.mint`）：
   * captcha 的取页等待与 WebSocket 建连历史上都没有超时，
   * 不透传就等于「用户点停止也停不下来」（真实缺陷，2026-09-29）。
   */
  mintCaptcha?: (options?: { signal?: AbortSignal }) => Promise<string>
  /** captcha 的区域（进 `x-aliyun-captcha-verify-region`）。 */
  captchaRegion?: string
  /** 拉取远端模型目录；缺省用兜底表。 */
  fetchRemoteModels?: () => Promise<ZcodeRemoteModel[]>
  /** 账号池（目录门控与黑名单）。 */
  accountPool?: AccountPool
  /** 产品配置；默认 {@link ZCODE}。 */
  product?: ZcodeProduct
  /** 注入的 fetch（测试用）。 */
  fetchImpl?: typeof fetch
  /**
   * 就绪探测（可注入）。返回 false 时 `listModels` 返回空数组，
   * 让整个 provider 分组隐藏 —— 而不是留一个点不动的条目。
   *
   * 缺省实现 = 「磁盘上有没有可解密的凭据」。
   */
  isReady?: () => Promise<boolean>
  /**
   * 读取图片附件的原始字节（内联为 data URL 用）。
   *
   * ⚠ **图片链路的必需依赖**：DSH 的图片块只带 `attachment:{attachmentId}`，
   * 真正拿字节要经附件服务。缺了它图片会在序列化层变成
   * `[image unavailable]` 占位符（实测：模型回「没有收到任何图片」）。
   */
  readImage?: (attachment: unknown) => Promise<{ data: Uint8Array; mediaType: string } | undefined>
  /**
   * 读取图片附件的**请求版本**（按预算缩放后的字节）。
   *
   * ⚠ 与 {@link readImage} 的错误契约相反：**不可用时要返回 `undefined`**
   * 而不是抛错，适配器据此回退原图。理由与桥接实现见
   * `src/index.ts` 的 `makeReadImageRequest`、`src/image-budget.ts` 的
   * `projectRequestImage`。
   */
  readImageRequest?: (
    ref: unknown,
    target: ImageRequestTarget,
  ) => Promise<{ data: Uint8Array; mediaType: string } | undefined>
  /** 图片像素预算（原图回退前的缩放目标）。 */
  imagePixelBudget?: number
  /** 图片字节上限（请求版本的目标）。 */
  imageMaxBytes?: number
}

/** ZCode 模型适配器。 */
export class ZcodeAdapter extends LlmAdapter {
  private readonly product: ZcodeProduct
  private readonly fetchImpl: typeof fetch
  /** 兜底模型索引（id → 条目）。 */
  private readonly fallbackIndex: ReadonlyMap<string, ZcodeFallbackModel>
  private remoteModels: ZcodeRemoteModel[] | undefined
  /** 自建的常驻浏览器（仅当调用方没注入 `mintCaptcha` 时用）。 */
  private captchaBrowser: ZcodeCaptchaBrowser | undefined
  /** captcha 配置缓存（配置很少变，但与凭据一样**不长期缓存**）。 */
  private captchaConfig: ZcodeCaptchaConfig | undefined

  constructor(private readonly options: ZcodeAdapterOptions) {
    super()
    this.product = options.product ?? ZCODE
    this.fetchImpl = options.fetchImpl ?? fetch
    this.fallbackIndex = new Map(this.product.fallbackModels.map((model) => [model.id, model]))
  }

  /**
   * 描述本适配器拥有的 provider 路由。
   *
   * 对入参做防御性归一化：DSH 会强制校验 `info.id === provider`，
   * 而模型设置页会用该 id 计算 `deriveKeyRef(provider)`
   * （内部调 `provider.toUpperCase()`）。一旦 provider 不是字符串，
   * 直接回退到本产品的 id。
   */
  providerInfo(provider: string): LlmProviderInfo {
    const id = typeof provider === 'string' && provider.length > 0 ? provider : this.product.id
    return { id, name: this.product.displayName }
  }

  /**
   * 完整目录（**不套黑名单**），带最终展示名。
   *
   * 设置页需要它渲染被关闭的模型 —— 否则那些条目只能凭 `disabledMap` 的 key
   * 补回，而那条路径拿不到展示名，会退化成裸 id
   * （`AGENTS.md` 记过 Raccoon 的同款用户报障）。
   */
  listAllModels(): readonly { id: string; name: string }[] {
    const source = this.remoteModels ?? this.product.fallbackModels.map(fallbackToRemote)
    return source.map((model) => ({ id: model.id, name: model.name }))
  }

  /** 取（并缓存）远端模型目录；失败时回退兜底表。 */
  private async loadModels(): Promise<ZcodeRemoteModel[]> {
    if (this.remoteModels !== undefined) return this.remoteModels
    if (this.options.fetchRemoteModels !== undefined) {
      try {
        const fetched = await this.options.fetchRemoteModels()
        if (fetched.length > 0) {
          this.remoteModels = fetched
          return fetched
        }
      } catch {
        // 远端失败静默回退兜底表：模型目录是展示信息，不该让整个 provider 报错。
      }
    }
    const fallback = this.product.fallbackModels.map(fallbackToRemote)
    this.remoteModels = fallback
    return fallback
  }

  private inputModalitiesFor(model: ZcodeRemoteModel | undefined): readonly ('text' | 'image')[] {
    return model?.supportsImage === true ? ['text', 'image'] : ['text']
  }

  /** 就绪判据：默认看磁盘上有没有可用凭据。 */
  private async ready(): Promise<boolean> {
    if (this.options.isReady !== undefined) {
      try {
        return await this.options.isReady()
      } catch {
        return false
      }
    }
    try {
      return (await this.options.resolveCredential()) !== undefined
    } catch {
      return false
    }
  }

  async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    // ⚠ 未就绪时返回 `[]` → DSH 的 buildModelCatalog 把整个 provider 分组隐藏。
    // **必须返回空数组而不能抛错**（抛错会被归入 catalog 的 failures，
    // 界面上反而多一条 provider 报错）。
    if (!await this.ready()) return []
    if (!await providerCatalogVisible(this.options.accountPool, this.product.id)) return []

    const all = await this.loadModels()
    const disabled = this.options.accountPool?.disabledModelsFor(this.product.id)
    const listed = disabled === undefined || disabled.size === 0
      ? all
      : all.filter((model) => !disabled.has(model.id))

    return listed.map((model) => ({
      provider: this.product.id,
      id: model.id,
      name: model.name,
      inputModalities: this.inputModalitiesFor(model),
    }))
  }

  async resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const all = await this.loadModels()
    const entry = all.find((item) => item.id === model)
    const fallback = this.fallbackIndex.get(model)
    const resolved: LlmResolvedModelInfo = {
      provider,
      id: model,
      name: entry?.name ?? fallback?.name ?? model,
      inputModalities: this.inputModalitiesFor(entry),
    }
    const contextWindow = entry?.contextWindow ?? fallback?.contextWindow
    // 未知模型不编造 context（宁可让 DSH 用默认值，也不报一个假窗口）。
    if (contextWindow !== undefined && contextWindow > 0) {
      resolved.context = { contextWindow }
    }
    const maxTokens = positiveMaxTokens(entry?.maxTokens ?? fallback?.maxTokens)
    if (maxTokens !== undefined) resolved.defaultMaxTokens = maxTokens
    /**
     * ★ **思考档位必须在这里声明** —— 否则 DSH 的选择器根本不出现。
     *
     * ⚠ **真实缺陷**（用户报障）：「使用 zcode 的 glm-5.3-flash 没法选中思考档位，
     * 而 ZCode 自己可以设置」。根因与本仓库 qoder 那次**完全同型**：
     * DSH 的档位选择器**只**从 `resolveModel().reasoning` 渲染
     * （`dsh-client-ui-model-selection`：`reasoning === undefined ? [] : …efforts`），
     * 只声明 `context` 是不够的。
     *
     * 档位来自上游 `client/configs` 的
     * `builtinModels[].reasoning.{levels, defaultLevel}`：
     *   - `levels` 的**键序**即展示顺序（实测 `low` / `high` / `max`）
     *   - `defaultLevel` 实测为 `max`
     *
     * ⚠ `defaultEffort` **必须落在 `efforts` 内**，否则不发 ——
     * 指向不存在的选项会让选择器显示空白（qoder 那边的既有约定）。
     */
    const levels = entry?.reasoningLevels ?? fallback?.reasoningLevels
    if (levels !== undefined && levels.length > 0) {
      const defaultLevel = entry?.defaultReasoningLevel ?? fallback?.defaultReasoningLevel
      resolved.reasoning = {
        /**
         * ⚠ **`id` 必须保持小写**（`low`/`high`/`max`）—— 它是要发给上游的
         * 协议值（`output_config.effort`），官方 `client/configs` 里就是小写。
         * 改成大写会让上游认不出档次（通常静默忽略整个字段）。
         *
         * **展示名**按用户要求用大写（`Low`/`High`/`Max`）：DSH 的选择器
         * 直接渲染 `efforts[].name`（不本地化、不查字典），故给什么显示什么。
         * 小写形态（`max`/`high`/`low`）在 UI 里看着像标识符而不像选项。
         *
         * ⚠ `ReasoningEffortId` 是 branded 类型，必须用构造函数（同 qoder 的写法）。
         */
        efforts: levels.map((id) => ({ id: ReasoningEffortId(id), name: reasoningEffortLabel(id) })),
        ...defaultLevel !== undefined && levels.includes(defaultLevel)
          ? { defaultEffort: ReasoningEffortId(defaultLevel) }
          : {},
      }
    }
    return resolved
  }

  /**
   * 兼容 0.1.1-rc.2：新版 `LlmRuntime.prepareCall()` 会调用
   * `registration.adapter.prepareCall(...)`，而本仓库链接的 dsh-llm 副本
   * 基类尚未提供该方法。与其余适配器同款 shim。
   */
  async prepareCall(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<{
    model: LlmResolvedModelInfo
    stream: (options: GenerateOptions) => AsyncIterable<StreamChunk>
  }> {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options: GenerateOptions) => this.stream(options),
    }
  }

  /** 取得 captcha param（注入优先，否则自建常驻浏览器）。 */
  private async mintCaptcha(options: { signal?: AbortSignal } = {}): Promise<string> {
    if (this.options.mintCaptcha !== undefined) return await this.options.mintCaptcha(options)
    if (this.captchaBrowser === undefined) this.captchaBrowser = new ZcodeCaptchaBrowser()
    return await this.captchaBrowser.mint(
      this.captchaConfig ?? ZCODE_CAPTCHA_FALLBACK,
      options,
    )
  }

  /** 允许外部（`index.ts`）设置服务端下发的 captcha 配置。 */
  setCaptchaConfig(config: ZcodeCaptchaConfig | undefined): void {
    this.captchaConfig = config
  }

  /**
   * ★★ 超时与中断的**作用域**：必须覆盖整轮
   * （captcha 产出 → 请求 → **流式读取**）。
   *
   * ## 为什么必须搬到这一层（真实缺陷，2026-09-29）
   *
   * 旧实现把 `setTimeout(abort)` 与 `removeEventListener('abort')` 放在
   * **`fetch` 的 `finally`** 里 —— 那个 `finally` 在「响应头回来」时**就已执行**，
   * 于是：
   *
   * 1. **流式读取阶段完全没有超时**：`requestTimeoutMs`（180s）形同虚设；
   * 2. **用户中断的通道在流开始之前就被摘掉**：`options.signal` 的 abort
   *    不再转发给 `controller`，`response.body` 的读取永不中止。
   *
   * 两者叠加的后果正是用户报障（本机实测三次、含一次 1018.7 秒）：
   * UI 停在「深度求索中，用时 5分27秒…」不动，模型既不输出思考也不输出正文，
   * **「停止」按钮点了没反应，只能重启宿主**。
   *
   * ⚠ 会话日志里的收尾事件 `step/end` + `turn/end{kind:'interrupted'}` 与
   * `step/start` **同一毫秒** —— 那是 `dsh-session` 的 `openTurnClosers()`
   * 在 repair 时**合成**的（它「复用最后一个真实事件的时间戳」），
   * 真相是这个 turn **从未结束**。排查时别被它误导。
   */
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const controller = new AbortController()
    const timeoutMs = this.product.requestTimeoutMs
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    timer.unref?.()
    // 把调用方的 signal（harness 的用户中断）串进来，作用于**整轮**。
    const onAbort = (): void => controller.abort()
    options.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      yield* this.streamScoped(options, controller, timeoutMs)
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
    }
  }

  /**
   * `stream()` 的实际实现。
   *
   * ⚠ `controller` 由调用方传入（而不是在这里新建）：它的 signal 必须同时
   * 管住 **captcha 产出** 与 **SSE 读取**，见 `stream()` 的说明。
   */
  private async *streamScoped(
    options: GenerateOptions,
    controller: AbortController,
    timeoutMs: number,
  ): AsyncIterable<StreamChunk> {
    /**
     * ## 图片：**支持**（曾经误判为不支持，且实现里根本没有图片代码）
     *
     * ### 误判的经过
     *
     * 早期这里有一个「显式拒绝图片」的守卫，理由是「该通道图片链路未验证」。
     * **那是错的** —— 用户实测在 ZCode IDE 里用同一个 `GLM-5.3-Flash`
     * 发图片能**正确理解**（描述出了一张足球截图里的拉拽犯规、红色箭头、
     * bilibili 水印等细节）。
     *
     * ### 更深一层的问题（删掉守卫也不够）
     *
     * 删掉守卫后实测：模型回「我在当前对话中没有收到任何图片」。
     * 根因是**本适配器完全没有图片处理代码** ——
     * 缺了 `collectImages` / `readImage` / `imageUrls` 三件事：
     *
     * ```
     * DSH 的图片块 = { type:'image', attachment:{ attachmentId } }
     *   ├─ collectImages()  收集 attachmentId → ref        ← 我们没做
     *   ├─ readImage(ref)   读原始字节 → data URL          ← 我们没做
     *   └─ imageUrls.set(id, url) 交给 serializeMessages   ← 我们没做
     * ```
     * 缺了它们，`serializeMessages` 拿到的是**空映射**，
     * 于是只产出 `[image unavailable]` 占位符 —— 图片在序列化层就丢了。
     *
     * ### 上游形态（逆向官方 agent `resources/glm/zcode.cjs`）
     *
     * 官方 Anthropic 路径把图片序列化成：
     * ```js
     * { type:"image",
     *   source:{ type:"base64",
     *            media_type: mediaType === "image/*" ? "image/jpeg" : mediaType,
     *            data: <base64> } }
     * ```
     * 与 `zcode-anthropic.ts` 的 `toImageBlock()` 一致。
     */
    const imageRefs = new Map<string, unknown>()
    for (const message of options.messages) {
      if (Array.isArray(message.content)) collectImages(message.content, imageRefs)
    }
    let imageUrls: Map<string, string> | undefined
    if (imageRefs.size > 0) {
      /**
       * ⚠ 能力声明与行为必须一致：`inputModalities` 没报 `image` 的模型
       * 不该收到图片块（DSH 会按播报值决定是否投影成文本占位符）。
       */
      const all = await this.loadModels()
      const entry = all.find((item) => item.id === options.model)
      if (!this.inputModalitiesFor(entry).includes('image')) {
        throw new LlmError(
          `zcode: 模型 "${options.model}" 不支持图片输入`,
          'UNSUPPORTED_CONTENT',
        )
      }
      if (this.options.readImage === undefined) {
        throw new LlmError(
          'zcode: 图片输入需要附件服务（宿主未提供 attachments.readImage）',
          'UNSUPPORTED_CONTENT',
        )
      }
      /**
       * ⚠ 保留**空 Map**（而非降级为 undefined）：图片存在但全部读取失败时，
       * 空 Map 仍会让 `userContentParts` 产出 `[image unavailable]` 占位符 ——
       * 比静默丢图好（模型至少知道"本该有图"）。
       */
      imageUrls = new Map()
      const readImage = this.options.readImage
      for (const [id, ref] of imageRefs) {
        try {
          /**
           * ⚠ 优先用**请求版本**（按字节/像素预算缩放后的）。
           *
           * ZCode 免费通道的请求体没有实测的硬上限，但 base64 后的截图很大
           * （2560×1600 各约 3.9 MB），两张就接近常见网关的 10MB 门槛。
           * `projectRequestImage` 拿不到时**返回 undefined**（不抛错），
           * 此时回退原图 —— 与 raccoon 的同款约定。
           */
          const projected = await projectRequestImage(ref, {
            readImageRequest: this.options.readImageRequest,
            pixelBudget: this.options.imagePixelBudget,
            maxBytes: this.options.imageMaxBytes,
          })
          const image = projected ?? await readImage(ref)
          if (image === undefined) continue
          imageUrls.set(
            id,
            `data:${image.mediaType};base64,${Buffer.from(image.data).toString('base64')}`,
          )
        } catch {
          // 单张图读取失败不影响其余 —— 它会在序列化层变成占位符。
        }
      }
    }

    // 1. 取凭据（ZCode 恒不「过期」，这个调用是形状对齐）
    let credential = await this.options.resolveCredential(options.model)
    if (credential === undefined) {
      await this.options.refresh()
      credential = await this.options.resolveCredential(options.model)
    }
    if (credential === undefined) {
      throw new LlmError(
        'zcode: 没有可用的凭据 —— 请在 Jet Hub 的 ZCode 面板点「添加账号」完成登录' +
        '（若已装官方 ZCode 客户端并登录过，本插件也会自动读取它的凭据）',
        'MISSING_CREDENTIAL',
      )
    }

    // 2. 产出一个新鲜 captcha（一次性！）
    //
    // ⚠ 也必须吃 signal：captcha 侧存在**无超时的等待**（见 `zcode-captcha.ts`），
    // 一旦命中就是无输出的永久挂起 —— 与流式读取那条通道同型。
    const captchaParam = await this.mintCaptcha({ signal: controller.signal })

    /**
     * 3. 构造请求体（**Anthropic Messages 格式**）。
     *
     * ⚠ 三个必须做对的点：
     *   - `system` 是顶层块数组，且第一块必须是官方 `cliPrefix`
     *     （缺了回 3012）
     *   - 首轮 user 消息要带 `<system-reminder>` 日期块
     *   - `tools` 是**扁平** `input_schema` 形态（不是 OpenAI 的嵌套 `function`）
     */
    const wire = serializeMessages(options.messages, imageUrls)
    const messages = withContextPrefix(toAnthropicMessages(wire))
    const system = buildZcodeSystemBlocks(options.system, {
      cwd: process.cwd(),
      provider: this.product.id,
      model: options.model,
    })

    const body: Record<string, unknown> = {
      model: options.model,
      max_tokens: options.maxTokens ?? 8192,
      system,
      messages,
      stream: true,
    }
    if (options.temperature !== undefined) body.temperature = options.temperature
    if (options.stop !== undefined && options.stop.length > 0) body.stop_sequences = options.stop
    // ⚠ tools 必须真的下发（Anthropic 扁平形态）。
    if (options.tools !== undefined && options.tools.length > 0) {
      body.tools = toAnthropicTools(options.tools)
    }
    /**
     * ★ **思考档位下发为 `output_config.effort`**。
     *
     * ⚠ 协议名**不是** `reasoning_effort`（那是我一开始的猜测）。权威依据是
     * 上游 `client/configs` 里每个档位自带的写法：
     *
     * ```json
     * { "path": ["output_config", "effort"], "value": "low" | "high" | "max" }
     * ```
     *
     * 即官方把「怎么表达这个档位」也下发了 —— 照抄即可，不要自己发明字段名。
     *
     * ⚠ 只在**模型确实声明了该档位**时才写：未知档位直接下发可能被上游拒，
     * 而请求体一旦被拒整个推理就失败了（档位只是锦上添花）。
     * 也不发默认值 —— 上游有自己的 `defaultLevel`，我们别去覆盖它。
     */
    const effort = options.reasoningEffort
    if (effort !== undefined && effort.length > 0) {
      const all = await this.loadModels()
      const entry = all.find((item) => item.id === options.model)
      const levels = entry?.reasoningLevels
      if (levels !== undefined && levels.includes(effort)) {
        body.output_config = { effort }
      }
    }

    /**
     * ⚠ **每次请求都重读凭据并现产 captcha**。
     *
     * 端口那类「实例重启后失效」的问题这里不存在（直连远端），
     * 但 captcha **确实是一次性**的 —— 复用会让上游回 `3007`。
     */
    const headers = buildZcodeHeaders(credential, {
      authorization: `Bearer ${credential.zcode_jwt}`,
      captcha: {
        param: captchaParam,
        region: this.options.captchaRegion ?? 'cn',
      },
    })

    let response: Response
    try {
      response = await this.fetchImpl(ZCODE_PLAN_MESSAGES_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } catch (error) {
      if (options.signal?.aborted) throw error
      /**
       * ⚠ 超时必须归 `TIMEOUT`（它在 harness 的可重试集合里），不能混进 `TRANSPORT`：
       * 两者语义不同，文案也不该说「传输错误」。
       *
       * ⚠ 这里**不再** `clearTimeout` / `removeEventListener` —— 清理已上移到
       * `stream()` 的 finally（覆盖整轮）。旧实现在我脚下就清理，
       * 于是流式读取阶段既无超时、也失了中断通道（见 `stream()` 的说明）。
       */
      if (controller.signal.aborted) {
        throw new LlmError(
          `zcode: 请求超时（${timeoutMs}ms 内未完成）—— 上游可能长时间不返回数据`,
          'TIMEOUT',
          { cause: error as Error },
        )
      }
      throw new LlmError(
        `zcode: 请求失败：${error instanceof Error ? error.message : String(error)}`,
        'TRANSPORT',
        { cause: error as Error },
      )
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new LlmError(
        `zcode: ${describeUpstreamError(response.status, text)}`,
        httpErrorCodeForZcode(response.status, text),
        { status: response.status },
      )
    }
    if (response.body === null) {
      throw new LlmError('zcode: 上游返回了空响应体', 'EMPTY_RESPONSE')
    }

    /**
     * ⚠ 超时收尾必须报 `TIMEOUT`，不能退化成「空回复」之类的模糊错误。
     *
     * 触发路径：上游回 200 但**长时间不吐任何数据** → 上一层的 timer 到点
     * `controller.abort()` → `iterateSseFrames` 的 abort 监听 `reader.cancel()`
     * 唤醒挂起的 `read()` → 流以「一帧都没有」结束。若不在这里翻译，
     * 用户看到的就是 `EMPTY_RESPONSE`（说不清是超时还是模型抽风）。
     *
     * ⚠ 判据必须排除**用户中断**：那种情况该原样上抛，
     * 让 harness 归为 aborted（而不是当成可重试的失败）。
     */
    const timedOut = (): boolean =>
      controller.signal.aborted && options.signal?.aborted !== true
    const timeoutError = (cause?: unknown): LlmError =>
      new LlmError(
        `zcode: 请求超时（${timeoutMs}ms 内未完成）—— 上游可能长时间不返回数据`,
        'TIMEOUT',
        cause === undefined ? undefined : { cause: cause as Error },
      )

    // ⚠ signal 必须传进 SSE 消费：它是「读挂起」时唯一能唤醒读取的东西。
    try {
      yield* consumeAnthropicSse(response.body, {
        label: 'zcode',
        model: options.model,
        signal: controller.signal,
      })
    } catch (error) {
      if (timedOut()) throw timeoutError(error)
      throw error
    }
    if (timedOut()) throw timeoutError()
  }

  /** 释放自建的浏览器（由 `index.ts` 的 cleanup 调用）。 */
  stop(): void {
    this.captchaBrowser?.dispose()
    this.captchaBrowser = undefined
  }
}

/**
 * 把上游错误翻成人能看懂的一句话。
 *
 * ⚠ 两个业务码要单独说清，因为它们的**处理方式完全不同**：
 * - `3007` = captcha 校验失败（**可重试**：换个新 param 即可）
 * - `3012` = 风控拦截（**不要重试**：有账号冷却惩罚，重复触发会升级封禁）
 */
export function describeUpstreamError(status: number, body: string): string {
  const trimmed = body.trim()
  let code: unknown
  let message: unknown
  try {
    const parsed = JSON.parse(trimmed) as { code?: unknown; msg?: unknown; message?: unknown }
    code = parsed.code
    message = parsed.msg ?? parsed.message
  } catch {
    // 非 JSON：原样截断。
  }
  const suffix = typeof message === 'string' && message.length > 0 ? message : trimmed.slice(0, 200)

  if (code === 3007 || trimmed.includes('3007')) {
    return `阿里云 captcha 校验失败（3007）。请重试；若持续失败，检查浏览器是否可用。`
  }
  if (code === 3012 || trimmed.includes('3012')) {
    return (
      `上游风控拦截（3012 unusual activity）。` +
      `⚠ 该错误有账号冷却惩罚（30 分钟，反复触发会升级到 24 小时乃至停用），` +
      `请勿连续重试。原始响应：${suffix}`
    )
  }
  if (code === 1002 || status === 401) {
    return `凭据失效（${status}）。请重新在官方 ZCode 客户端登录。${suffix}`
  }
  return `HTTP ${status}：${suffix}`
}

/**
 * 把上游错误码映射到 harness 的错误类别。
 *
 * ⚠ 映射决定了**会不会被自动重试**（harness 的 `DEFAULT_RETRYABLE_CODES`
 * 是 `[EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT]`）：
 *
 * | 上游 | 映射 | 会被重试吗 | 理由 |
 * |---|---|---|---|
 * | `3007` captcha | `RATE_LIMIT` | **是** | 换新 param 就能过，值得重试 |
 * | `3012` 风控 | `PERMISSION` | **否** | 有账号冷却惩罚，重试会加重 |
 * | `1002`/401 | `AUTH` | 否 | 需用户重新登录 |
 * | `1113` 余额 | `QUOTA_EXCEEDED` | **否** | 确定性错误（要充值） |
 * | 其余 5xx | `SERVER` | 是 | 暂时性 |
 */
export function httpErrorCodeForZcode(status: number, body: string): string {
  const trimmed = body.trim()
  if (trimmed.includes('3007')) return 'RATE_LIMIT'
  if (trimmed.includes('3012')) return 'PERMISSION'
  if (trimmed.includes('1113') || trimmed.includes('余额不足')) return 'QUOTA_EXCEEDED'
  if (status === 401 || trimmed.includes('1002')) return 'AUTH'
  if (status === 429) return 'RATE_LIMIT'
  if (status >= 500) return 'SERVER'
  if (status === 400) return 'INVALID_REQUEST'
  return 'SERVER'
}

/**
 * 在 `ctx.llm` 上注册 zcode provider 路由与适配器。
 *
 * 返回适配器实例：Jet Hub「显示列表」需要 `listAllModels()`
 * （不受黑名单影响、带最终展示名）。`ctx.llm` 不透传自定义方法，
 * 故须由调用方持有引用并在 `index.ts` 的 `modelAdapters` 里登记。
 */
export function registerZcodeLlm(ctx: Context, options: ZcodeAdapterOptions): ZcodeAdapter {
  const product = options.product ?? ZCODE
  ctx.llm.registerConfigurableProviders([
    {
      provider: product.id,
      displayName: product.displayName,
      settingsNs: settingsNamespaceFor(ctx, `llm-${product.id}`),
      settingsPath: [],
    },
  ])
  const adapter = new ZcodeAdapter(options)
  ctx.llm.registerAdapter([product.id], adapter)
  return adapter
}
