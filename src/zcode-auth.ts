/**
 * ZCode 认证/凭据服务（`ctx.zcodeAuth`）。
 *
 * ## 与其它 auth 服务的关键差异
 *
 * 其它 `ctx.xxxAuth` 管「浏览器登录 → 拿 token → 续期」。
 * ZCode **没有登录流程** —— 用户在官方 ZCode 客户端里登录一次，
 * 凭据就落在磁盘上（`~/.zcode/v2/credentials.json`，AES-256-GCM 加密）。
 * 本服务的职责是：
 *
 * 1. **读凭据**：解密磁盘凭据（`zcode.ts`）—— **不需要任何实例在跑**
 * 2. **探活**：凭据是否可用（能不能拿到额度）
 * 3. **额度**：`billing/balance`
 * 4. **签到**：补激活上报 → preview → claim（每个 plan 单独 mint captcha）
 * 5. **captcha 配置**：`client/configs`（拿 region/prefix/sceneId）
 *
 * ## ⚠ 必须 `extends Service`
 *
 * 其余八个 auth 服务全部继承 `@deepseek-ai/cordis` 的 `Service` 基类，
 * 由基类构造函数完成 `ctx.provide(<name>, this)` 注册。
 * 初版 `ZcodeAuth` 是个**裸 class**，既没继承也没自己 provide ——
 * 结果是 `ctx.zcodeAuth` **恒为 undefined**（行为探针实证），
 * 与注释里「注册为 ctx.zcodeAuth」的声明直接矛盾。
 *
 * 服务名由 `product.id` 派生为 `zcodeAuth`，与 `RaccoonAuth` 同款做法。
 *
 * ## ⚠ 不注册任何斜杠命令
 *
 * 与其余 provider 一致：登录/状态/额度/签到全部在 Jet Hub 面板完成。
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import type { AccountPool } from './account-pool.js'
import type { CheckinStatus } from './credits.js'
import type { ClaimOutcome } from './credits.js'
import {
  isUsableZcodeCredential,
  readZcodeCredential,
  type ZcodeCredential,
} from './zcode.js'
import { ZCODE, type ZcodeProduct, type ZcodeRemoteModelLike } from './zcode-product.js'
import { ZcodeCaptchaBrowser, ZCODE_CAPTCHA_FALLBACK } from './zcode-captcha.js'
import { generateDeviceMid, runZcodeLogin } from './zcode-login.js'
import {
  claimZcodePlan,
  fetchZcodeBalance,
  fetchZcodeCaptchaConfig,
  fetchZcodeClaimablePlans,
  fetchZcodeModels,
  reportZcodeActivation,
  type ZcodeBalanceResult,
  type ZcodeClaimOutcome,
} from './zcode-upstream.js'

/** 一次探活的结果。 */
export interface ZcodeProbeResult {
  /** 凭据是否可用。 */
  available: boolean
  /** 展示名（脱敏手机号 / 设备码）。 */
  accountLabel?: string
  /** 剩余额度（探活成功时）。 */
  remaining?: number
  /** 不可用时的原因（人类可读）。 */
  reason?: string
}

/** `ZcodeAuth` 的构造选项。 */
export interface ZcodeAuthOptions {
  /** 产品配置；默认 {@link ZCODE}。 */
  product?: ZcodeProduct
  /** 服务名覆盖（默认由产品 id 派生为 `zcodeAuth`）。 */
  serviceName?: string
  /** 注入的 fetch（测试用）。 */
  fetchImpl?: typeof fetch
  /** 注入的凭据读取（测试用，避免碰真实磁盘）。 */
  readCredential?: () => ZcodeCredential | undefined
  /**
   * 账号池（测试用）。
   *
   * 生产路径靠 `ctx.get('accountPool')` 惰性取（见 `accountPool()`），
   * 但单测里未必把池注册到 ctx 上 —— 故保留这个注入口。
   */
  accountPool?: AccountPool
}

/** ZCode 认证服务。 */
export class ZcodeAuth extends Service {
  private readonly product: ZcodeProduct
  private readonly fetchImpl: typeof fetch
  private readonly readCredential: () => ZcodeCredential | undefined
  /** 注入的账号池（测试用；生产走 ctx.get）。 */
  private readonly injectedPool: AccountPool | undefined
  /**
   * 常驻 captcha 浏览器。
   *
   * ⚠ 常驻是必需的：冷启动约 690ms，而每次 mint 还要新建 page
   * （约 1.2 秒）。每次请求都冷启动会让首字延迟凭空多一秒。
   * 生命周期由 `stop()` 收尾。
   */
  private captchaBrowser: ZcodeCaptchaBrowser | undefined
  /** 最近一次失败原因（供 `status()` 暴露给 UI）。 */
  private lastError: string | undefined

  constructor(ctx: Context, options: ZcodeAuthOptions = {}) {
    const product = options.product ?? ZCODE
    super(ctx, options.serviceName ?? `${product.id}Auth`)
    this.product = product
    this.fetchImpl = options.fetchImpl ?? fetch
    this.readCredential = options.readCredential ?? (() => readZcodeCredential())
    this.injectedPool = options.accountPool
  }

  /** 凭据 ref 名（供 Jet Hub 展示）。 */
  get credentialRefName(): string {
    return this.product.defaultCredentialRef
  }

  /** 产品配置（测试与 Jet Hub 用）。 */
  get productConfig(): ZcodeProduct {
    return this.product
  }

  /**
   * 读取当前凭据。
   *
   * ## 两个来源，插件自存优先
   *
   * 1. **插件自存**（`ctx.credentials` 的 `ZCODE_CREDENTIAL`）——
   *    用户在 Jet Hub 里走插件内登录拿到的，**不需要官方客户端**。
   * 2. **回退**：解密官方客户端的 `~/.zcode/v2/credentials.json` ——
   *    让「已经装了官方客户端并登录过」的用户零操作即可用。
   *
   * ⚠ **每次调用都重新读**，不缓存 —— 用户刚登录完或刚在官方客户端
   * 重新登录后，无需重启 DSH 即可生效。
   *
   * 返回 `undefined` 表示「没有可用的 ZCode 登录态」。
   */
  async current(): Promise<ZcodeCredential | undefined> {
    const stored = await this.readStoredCredential()
    if (stored !== undefined) return stored
    try {
      return this.readCredential()
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
      return undefined
    }
  }

  /**
   * 读插件自存的凭据（`ctx.credentials`）。
   *
   * ## ⚠ 必须同时认**账号池里的 ref**（真实缺陷）
   *
   * 凭据可能落在**两个**地方，ref 名不同：
   *
   * | 来源 | ref |
   * |---|---|
   * | RPC `account.create`（用户点「添加账号」） | **`ZCODE_ACCOUNT_XXXX`**（`refName`） |
   * | 单凭据回退 / 手工写入 | `ZCODE_CREDENTIAL`（`defaultCredentialRef`） |
   *
   * 早期只读后者 —— 于是「用户在 Jet Hub 登录成功」之后，
   * `probe()` / `fetchBalance()` / `status()` / `fetchCheckinStatus()`
   * **全都读不到凭据**（它们都走本方法），表现为：
   * **能聊天（适配器读账号条目的 ref），但面板显示「未配置」、积分查不出**。
   *
   * 这个缺口一度被「回退读官方凭据文件」掩盖 —— 装了官方客户端的机器上
   * 现象会消失，只有**没装**的用户才会看到。
   *
   * ⇒ 顺序：**账号池（用户的显式登录）> 单凭据 ref（回退）**。
   * 与适配器的解析顺序保持一致，避免「适配器能用而面板不能用」。
   *
   * ⚠ 形状校验必须做：凭据存储里可能有**任何**字符串（用户手填、旧版本
   * 残留）。`isUsableZcodeCredential` 保证后续代码拿到的是完整对象。
   */
  private async readStoredCredential(): Promise<ZcodeCredential | undefined> {
    // ① 账号池：用户显式登录创建的账号条目（ref 形如 ZCODE_ACCOUNT_XXXX）。
    const fromPool = await this.readCredentialFromPool()
    if (fromPool !== undefined) return fromPool
    // ② 单凭据回退 ref。
    return await this.readCredentialFromRef(this.product.defaultCredentialRef as CredentialRef)
  }

  /**
   * 从账号池里第一个**凭据可用**的 zcode 账号读取。
   *
   * ⚠ **不看 `enabled`** —— 与其余 provider 的既有约定一致
   * （`AGENTS.md`：停用只影响自动选号，与凭据是否可用无关）。
   * 用户停用了账号，面板仍应能显示它的额度与状态。
   */
  private async readCredentialFromPool(): Promise<ZcodeCredential | undefined> {
    const pool = this.accountPool()
    if (pool === undefined) return undefined
    try {
      for (const entry of pool.listAccountsByProvider(this.product.id)) {
        const credential = await this.readCredentialFromRef(entry.credentialRef as CredentialRef)
        if (credential !== undefined) return credential
      }
    } catch {
      // 账号池异常（未初始化/存储损坏）→ 退回单凭据路径。
    }
    return undefined
  }

  /** 从某个 ref 解析凭据（带形状校验）。 */
  private async readCredentialFromRef(ref: CredentialRef): Promise<ZcodeCredential | undefined> {
    try {
      const resolved = await this.ctx.credentials.resolve(ref)
      if (resolved === undefined || resolved === null) return undefined
      const parsed = JSON.parse(resolved.value) as unknown
      if (!isUsableZcodeCredential(parsed)) return undefined
      // 补上来源标记（旧凭据里没有这个字段）。
      return { ...parsed, source: parsed.source ?? 'plugin' }
    } catch {
      // 未配置或 JSON 损坏都视为「这份 ref 不可用」，让调用方试下一个。
      return undefined
    }
  }

  /**
   * 取账号池。
   *
   * ⚠ 用 `ctx.get` 而非构造注入：本服务可能在**账号池注册之前**被构造
   * （`index.ts` 里 `new ZcodeAuth(ctx)` 早于 `registerJetHubRpc`，
   * 且测试里账号池可能是后提供的）。惰性读取能让两种情况都成立。
   */
  private accountPool(): AccountPool | undefined {
    try {
      const pool = this.ctx.get('accountPool' as never) as AccountPool | undefined
      if (pool !== undefined && pool !== null) return pool
    } catch {
      // 服务未注册 —— 正常（headless / 单测）。
    }
    return this.injectedPool
  }

  /**
   * 探活：凭据是否可用。
   *
   * 判据是**端到端**的 —— 能不能真的查到额度。这样「证书解出来了但
   * 已失效」也会被如实反映（比只看文件存在可靠）。
   */
  async probe(): Promise<ZcodeProbeResult> {
    const credential = await this.current()
    if (credential === undefined) {
      return {
        available: false,
        reason:
          '未找到可用的 ZCode 登录态。请在 Jet Hub 里点「添加账号」完成登录' +
          '（若已装官方 ZCode 客户端并登录过，本插件也会自动读取它的凭据）。',
      }
    }
    try {
      const balance = await fetchZcodeBalance(credential, this.fetchImpl)
      if (balance === undefined) {
        return {
          available: false,
          accountLabel: credential.account_label,
          reason: '额度接口不可用（凭据失效或网络异常）',
        }
      }
      return {
        available: true,
        accountLabel: credential.account_label,
        remaining: balance.remaining,
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      this.lastError = reason
      return { available: false, accountLabel: credential.account_label, reason }
    }
  }

  /**
   * ★ **插件内登录** —— 走官方 CLI 设备授权流，**不需要 ZCode IDE**。
   *
   * ## 为什么这是「登录」而不是「读凭据」
   *
   * 早期实现只是「确认磁盘上有一份官方客户端写的凭据」。那要求用户
   * 先装并登录官方 ZCode 客户端 —— 与本插件「装完即用」的定位冲突。
   *
   * 实测确认官方 3.12.3+ 用的是**服务端中介的设备授权流**
   * （`/oauth/cli/init` → 浏览器授权 → `/oauth/cli/poll/{flow_id}`），
   * 完全不经 `zcode://` 回调，**普通 Node 进程就能走完**（见 `zcode-login.ts`）。
   *
   * ## 返回形状与其余 provider 一致
   *
   * `{ loginUrl, result }` —— `loginUrl` 是**真的**授权 URL（前端据此弹窗），
   * `result` 是等待用户授权完成的 Promise。
   *
   * ⚠ 与本文件其它方法不同，这个方法**不是幂等的**：每次调用都会向
   * 服务端申请一条新的授权流程。前端只在用户点「添加账号」时调一次。
   */
  async startLogin(options: { refName?: string; appVersion?: string } = {}): Promise<{
    loginUrl: string | undefined
    result: Promise<{ refName: string; credential: ZcodeCredential }>
  }> {
    /**
     * ⚠ 授权 URL 必须**立刻**拿到并返回：前端的 `window.open` 只在
     * 用户手势窗口内有效（等用户授权完再返回必被弹窗拦截 ——
     * `AGENTS.md` 记过 CodeArts 早期这个缺陷）。
     *
     * 故这里手工编排「发起 → 回调 URL → 后台轮询」，而不是直接
     * `await runZcodeLogin()`（那会阻塞到授权完成）。
     */
    const ref = (options.refName ?? this.product.defaultCredentialRef) as CredentialRef
    let resolveUrl: (url: string) => void = () => {}
    let rejectUrl: (error: Error) => void = () => {}
    const urlPromise = new Promise<string>((resolve, reject) => {
      resolveUrl = resolve
      rejectUrl = reject
    })

    const result = (async (): Promise<{ refName: string; credential: ZcodeCredential }> => {
      const loginResult = await runZcodeLogin({
        fetchImpl: this.fetchImpl,
        appVersion: options.appVersion ?? this.product.appVersionFallback,
        onAuthorizeUrl: (url) => resolveUrl(url),
      })
      /** 登录成功后组装凭据，并生成**自用**的 device_mid（见下）。 */
      const credential: ZcodeCredential = {
        zcode_jwt: loginResult.zcodeJwt,
        /**
         * ⚠ **自己生成 device_mid**，而不是读官方客户端的
         * `telemetry-state.json` —— 这正是「脱离 IDE」的关键。
         *
         * 实测依据：同一 JWT 换任意随机 UUID，`billing/balance` 都回 200；
         * 缺它才回 400 code 3001。故它的**值**不被绑定校验，
         * 只需**稳定**（生成后持久化在凭据里，登录一次就固定）。
         */
        device_mid: generateDeviceMid(),
        bigmodel_access_token: loginResult.bigmodelAccessToken,
        account_label: loginResult.displayName,
        app_version: options.appVersion ?? this.product.appVersionFallback,
        source: 'plugin',
      }
      await this.ctx.credentials.set(ref, JSON.stringify(credential))
      return { refName: ref, credential }
    })()

    /**
     * 若发起阶段就失败（网络/服务端拒绝），`onAuthorizeUrl` 永不触发，
     * 故这里把 URL promise 与结果 promise 对齐 —— 避免前端永久等待。
     */
    result.catch((error: unknown) => {
      rejectUrl(error instanceof Error ? error : new Error(String(error)))
    })

    let loginUrl: string | undefined
    try {
      loginUrl = await urlPromise
    } catch (error) {
      // 发起就失败：把错误抛给调用方（前端会显示原因）。
      throw error instanceof Error ? error : new Error(String(error))
    }
    return { loginUrl, result }
  }

  /**
   * 阻塞式登录（等待用户在浏览器完成授权）。
   *
   * ⚠ 与 `startLogin` 的区别：这个会**等到授权完成**才返回。
   * 供「没有前端、只想在脚本里登录」的场景用；Jet Hub 走 `startLogin`
   * （两步式，避免弹窗被拦截）。
   */
  async login(options: { refName?: string; appVersion?: string } = {}): Promise<{
    refName: string
    credential: ZcodeCredential
  }> {
    const started = await this.startLogin(options)
    return await started.result
  }

  /**
   * 把**当前可用凭据**（插件自存或官方文件）写进 `ctx.credentials`。
   *
   * 用途：把「官方客户端已登录」的状态**固化**成插件自存凭据，
   * 使其后即便官方客户端被卸载也能继续用。
   *
   * ⚠ 若已有插件自存凭据，本方法会**覆盖**它 —— 调用方需自行确认
   * （Jet Hub 的「添加账号」在已有账号时不会走到这里）。
   */
  async persistCurrent(refName?: string): Promise<{
    refName: string
    credential: ZcodeCredential
  }> {
    const credential = await this.current()
    if (credential === undefined) {
      throw new Error(
        'ZCode 凭据不可用：请在 Jet Hub 里点「添加账号」完成登录' +
        '（若已装官方 ZCode 客户端并登录过，本插件也会自动读取它的凭据）。',
      )
    }
    const ref = (refName ?? this.product.defaultCredentialRef) as CredentialRef
    /**
     * ⚠ `ctx.credentials.set` 的第二个参数是**字符串**（不是对象）——
     * 与 `RaccoonAuth` 同款约定：把凭据本体序列化成 JSON 存进去，
     * 读的时候再 `JSON.parse`。
     */
    await this.ctx.credentials.set(ref, JSON.stringify(credential))
    return { refName: ref, credential }
  }

  /**
   * 拉取服务端下发的 captcha 配置。
   *
   * 失败返回 `undefined`，由调用方回退到 `ZCODE_CAPTCHA_FALLBACK`。
   */
  async fetchCaptchaConfig(): Promise<{ region: string; prefix: string; sceneId: string } | undefined> {
    const credential = await this.current()
    if (credential === undefined) return undefined
    return await fetchZcodeCaptchaConfig(credential, this.fetchImpl)
  }

  /** 查额度（Jet Hub 的「余额」用）。 */
  async fetchBalance(): Promise<ZcodeBalanceResult | undefined> {
    const credential = await this.current()
    if (credential === undefined) return undefined
    return await fetchZcodeBalance(credential, this.fetchImpl)
  }

  /**
   * 用**给定凭据**查额度（Jet Hub 逐账号查询时用）。
   *
   * 与 {@link fetchBalance} 的区别：那个用「当前磁盘凭据」，
   * 这个用调用方给的那份（每个账号条目各自的凭据）——
   * 多账号场景下两者可能不是同一份。
   */
  async fetchBalanceFor(credential: ZcodeCredential): Promise<ZcodeBalanceResult | undefined> {
    return await fetchZcodeBalance(credential, this.fetchImpl)
  }

  /**
   * 产出 captcha param（`ctx.zcodeAuth` 的公开入口，供 RPC 层调用）。
   *
   * ⚠ 每次调用都产**新的**（一次性）。
   * 缺浏览器时抛错 —— 调用方（`credits.claimAll`）会把它转成可读的
   * failed outcome，而不是让整个端点失败。
   *
   * ⚠ `options.signal` 会被透传到浏览器侧（取页等待 / 建连超时 / abort）——
   * 推理链路的「停止」能否生效就靠它（真实缺陷，2026-09-29）。
   */
  async mintCaptcha(
    config?: { region: string; prefix: string; sceneId: string },
    options: { signal?: AbortSignal } = {},
  ): Promise<string> {
    const resolved = config ?? await this.fetchCaptchaConfig() ?? ZCODE_CAPTCHA_FALLBACK
    this.captchaBrowser ??= new ZcodeCaptchaBrowser()
    return await this.captchaBrowser.mint(resolved, options)
  }

  /**
   * 用**给定凭据**领取每日额度（Jet Hub 逐账号领取时用）。
   *
   * 与 {@link claimDaily} 的区别同 {@link fetchBalanceFor}。
   */
  async claimDailyFor(
    credential: ZcodeCredential,
    mintCaptcha: (() => Promise<string>) | undefined,
    captchaRegion = ZCODE_CAPTCHA_FALLBACK.region,
  ): Promise<ClaimOutcome[]> {
    return await this.claimDailyWith(credential, mintCaptcha, captchaRegion)
  }

  /**
   * 拉模型目录。
   *
   * ⚠ ZCode 的模型表是**静态白名单**（实测可用的两个），不发网络请求
   * 去枚举 —— 上游 `/v1/models` 是桥的端点（我们不再依赖桥），
   * 而 `client/configs` 的模型池含**实测不可用**的两条
   * （`GLM-5-Turbo` / `GLM-5.2` 返回空响应）。
   * 故直接返回兜底表，语义是「实测可用的清单」。
   */
  async fetchModels(): Promise<ZcodeRemoteModelLike[]> {
    /**
     * ★ **优先上游**（真实缺陷）。
     *
     * 早先这里**直接照抄兜底表**，于是：
     *   - 窗口 / 输出上限用的是兜底表的估值（`200_000` / `32_768`），
     *     而上游说的是 `1_000_000` / `128_000`；
     *   - **思考档位完全不出现**（兜底表当时没有档位字段）。
     *
     * 用户报障正是「上下文窗口 1000000、最大输出 128000，但选不了思考档位」
     * —— 那两个数字来自上游/用户手填，而**档位是代码里根本没有**。
     *
     * ⇒ 档位、视觉能力、窗口、输出上限**全部以上游为准**。
     */
    const credential = await this.current()
    if (credential !== undefined) {
      const remote = await fetchZcodeModels(credential, this.fetchImpl)
      if (remote !== undefined && remote.length > 0) return remote
    }
    // 上游不可用（未登录 / 网络异常）→ 回退兜底表（其值已与上游对齐）。
    return this.product.fallbackModels.map((model) => ({
      id: model.id,
      name: model.name,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      supportsImage: model.supportsImage,
      ...model.reasoningLevels !== undefined ? { reasoningLevels: model.reasoningLevels } : {},
      ...model.defaultReasoningLevel !== undefined
        ? { defaultReasoningLevel: model.defaultReasoningLevel }
        : {},
    }))
  }

  // ===== 签到（与 CodeArts / Buddy 等共用 CheckinStatus / ClaimOutcome 形状）=====

  /**
   * 查签到状态。
   *
   * ## ⚠ 判据是「有没有可领的 plan」，**不是**「列表是否为空」
   *
   * 与 Qoder 那次教训同型（`AGENTS.md` 记过）：服务端在活动不同阶段
   * 都可能回空列表。而 ZCode 的服务端**不会主动推送**活动 ——
   * 必须先补 `event/report`（`app_launch` + `app_daily_active`），
   * `preview` 才会下发 plan。
   *
   * 故本方法**先补激活信号再查**，否则会稳定误报「今日已领」。
   */
  async fetchCheckinStatus(): Promise<CheckinStatus> {
    const credential = await this.current()
    if (credential === undefined) {
      return emptyCheckinStatus(false, true)
    }
    // 补活跃信号 —— 不补则 preview 恒为空。
    await reportZcodeActivation(credential, this.fetchImpl)
    const plans = await fetchZcodeClaimablePlans(credential, this.fetchImpl)
    /**
     * ⚠ `active` 恒为 `true`（拿到凭据即 true）—— 与 Qoder 的同款约定：
     * 若按「列表非空」判 `active:false`，`collectClaimResults` 会先命中
     * 「活动未开启」分支，把「今天已领」误报成「签到活动未开启」。
     *
     * ⚠ ZCode 是**额度制**（不是积分制）：`ClaimOutcome` / `CheckinStatus`
     * 那些 `credit` 字段的单位是「积分」，而 ZCode 的额度单位是 **token**。
     * 两者不是同一量纲，故这里**一律填 0**，不把 token 数伪装成积分
     * （否则 Jet Hub 的汇总会把 1 亿 token 显示成 1 亿积分）。
     *
     * `todayCheckedIn` 只能由「有没有可领的 plan」推断（ZCode 没有独立的
     * 「今日是否已领」端点）：有可领 = 还没领；没有 = 已领或未投放。
     */
    return {
      active: true,
      todayCheckedIn: plans.length === 0,
      streakDays: 0,
      dailyCredit: 0,
      todayCredit: 0,
      isStreakDay: false,
      totalCredits: 0,
      checkinDates: [],
      activityName: 'ZCode Start Plan 每日额度',
      themeName: 'ZCode',
      endTime: '',
    }
  }

  /**
   * 领取每日额度。
   *
   * ## 流程（每一步都不能省）
   *
   * 1. 补活跃上报 → 2. 查 preview → 3. 逐个 claim
   *
   * ## ⚠ captcha 是**一次性**的
   *
   * 每个 plan 都必须**重新 mint** 一个新 param（复用会得 `3007`）。
   * 故 captcha 的产出来自调用方注入的 `mintCaptcha` 回调 ——
   * 让本服务不必知道浏览器怎么起（也便于单测注入桩）。
   *
   * ## ⚠ `1003`（已领取）是**成功**
   *
   * 服务端对「已领取过」回 `code:1003`。把它当失败会让定时任务
   * 反复误报 —— 这与 Buddy / Qoder 的幂等语义一致。
   */
  async claimDaily(
    mintCaptcha: (() => Promise<string>) | undefined,
    captchaRegion = ZCODE_CAPTCHA_FALLBACK.region,
  ): Promise<ClaimOutcome[]> {
    const credential = await this.current()
    if (credential === undefined) {
      return [{ kind: 'failed', code: -1, message: '未找到可用的 ZCode 登录态' }]
    }
    return await this.claimDailyWith(credential, mintCaptcha, captchaRegion)
  }

  /** 领取的共用实现（`claimDaily` 与 `claimDailyFor` 都走它）。 */
  private async claimDailyWith(
    credential: ZcodeCredential,
    mintCaptcha: (() => Promise<string>) | undefined,
    captchaRegion: string,
  ): Promise<ClaimOutcome[]> {
    if (mintCaptcha === undefined) {
      return [{ kind: 'failed', code: -1, message: 'captcha 产出不可用（找不到浏览器？）' }]
    }

    await reportZcodeActivation(credential, this.fetchImpl)
    const plans = await fetchZcodeClaimablePlans(credential, this.fetchImpl)
    /**
     * ⚠ 「没有可领 plan」**不等于**「今天已领」——也可能是活动未投放。
     * 但两种情况下用户的动作都是「明天再来」，故归为 `already-claimed`
     * 并给出如实文案（与 Buddy / Qoder 的幂等语义一致）。
     */
    if (plans.length === 0) {
      return [{ kind: 'already-claimed', message: '今日暂无可领额度（服务端按日刷新）' }]
    }

    const outcomes: ClaimOutcome[] = []
    for (const plan of plans) {
      try {
        // ⚠ 每个 plan 单独 mint（captcha 一次性）。
        const param = await mintCaptcha()
        const outcome: ZcodeClaimOutcome = await claimZcodePlan(
          credential, plan.planId, { param, region: captchaRegion }, this.fetchImpl,
        )
        outcomes.push(toClaimOutcome(outcome, plan.planId))
      } catch (error) {
        outcomes.push({
          kind: 'failed',
          code: -1,
          message: `${plan.planId}: ${error instanceof Error ? error.message : String(error)}`,
        })
      }
    }
    return outcomes
  }

  /**
   * 账号卡片「刷新」按钮。
   *
   * ⚠ ZCode **不可续期**（凭据是静态的，没有 refresh 端点）——
   * 但这个方法**仍要做实事**：重新解密磁盘凭据并回写，
   * 使用户在官方客户端重新登录后点一下就能生效。
   *
   * 与 `LoomyAuth.refreshAccountCredential` 同型（那边是「探测有效性」）。
   */
  async refreshAccountCredential(
    refName: string,
    pool?: AccountPool,
    accountId?: string,
  ): Promise<void> {
    void pool
    void accountId
    const credential = await this.current()
    if (credential === undefined) {
      throw new Error(
        'ZCode 凭据不可用，请先在官方 ZCode 客户端重新登录' +
        '（本插件读取 ~/.zcode/v2/credentials.json）。',
      )
    }
    await this.ctx.credentials.set(refName as CredentialRef, JSON.stringify(credential))
  }

  /**
   * 批量续期（定时调度器调用）。
   *
   * ⚠ ZCode **不可续期** —— 这里做的是「把磁盘上的最新凭据回写到
   * 每个账号的 ref」，这样用户在官方客户端重新登录后，定时器
   * 会自动把新凭据铺开到所有账号条目。
   *
   * ⚠ **只按 `refreshable` 过滤、不看 `enabled`**（`AGENTS.md` 既有约定：
   * 停用只影响自动选号，与凭据新鲜度无关）。
   */
  async refreshAll(pool: AccountPool): Promise<void> {
    const credential = await this.current()
    if (credential === undefined) return
    const accounts = pool.listAccountsByProvider(this.product.id)
    for (const account of accounts) {
      try {
        await this.ctx.credentials.set(
          account.credentialRef as CredentialRef,
          JSON.stringify(credential),
        )
      } catch {
        // 单个账号失败不影响其余。
      }
    }
  }

  /**
   * `status()` —— 供 Jet Hub 展示「是否已配置」。
   *
   * 与其余 provider 同形（返回 `{configured, ...}`）。
   */
  async status(): Promise<{ configured: boolean; label?: string; error?: string }> {
    const credential = await this.current()
    if (credential === undefined) {
      return { configured: false, error: this.lastError }
    }
    return { configured: true, label: credential.account_label }
  }

  /**
   * 释放资源。
   *
   * ⚠ 契约要求：`index.ts` 的 cleanup 对**全部** provider 统一调 `stop()`，
   * 缺了它会以 `is not a function` 崩在启动路径上
   * （`LoomyAuth` 的注释记过同一条）。
   *
   * ⚠ 会一并关闭 captcha 浏览器 —— 否则留下孤儿 chromium
   * （约 200-400MB，且用户没有界面能关掉它）。
   */
  stop(): void {
    this.captchaBrowser?.dispose()
    this.captchaBrowser = undefined
  }
}

/** 把上游的领取结果映射成 Jet Hub 的 `ClaimOutcome`。 */
export function toClaimOutcome(outcome: ZcodeClaimOutcome, planId: string): ClaimOutcome {
  if (outcome.ok) {
    if (outcome.alreadyClaimed === true) {
      return { kind: 'already-claimed', message: `额度已领取过（${planId}）` }
    }
    /**
     * ⚠ ZCode 的额度单位是 **token**，不是「积分」—— 而 `ClaimOutcome` 的
     * `claimed` 分支强制要求 `credit: number` 与 `streakDays`。
     * 这里填 0 并在文案里说明，避免把 token 数伪装成积分
     * （那会让 Jet Hub 的汇总把 1 亿 token 显示成 1 亿积分）。
     */
    return { kind: 'claimed', credit: 0, streakDays: 0, isStreakDay: false }
  }
  // 3007 = captcha 失败；给出可操作的提示而不是裸码。
  if (outcome.code === 3007) {
    return { kind: 'failed', code: 3007, message: `captcha 校验失败（${planId}），请重试` }
  }
  return {
    kind: 'failed',
    // ⚠ `code` 是 `failed` 分支的**必填**字段；上游没给码时用 -1 表示
    // 「无业务码」（HTTP 层失败）。
    code: outcome.code ?? -1,
    message: `${planId}: ${outcome.message ?? `HTTP ${outcome.httpStatus ?? '?'}`}`,
  }
}

/** 构造一个「不可用」的 `CheckinStatus`（字段全部显式给，满足契约）。 */
export function emptyCheckinStatus(active: boolean, actionRequired = false): CheckinStatus {
  return {
    active,
    todayCheckedIn: false,
    streakDays: 0,
    dailyCredit: 0,
    todayCredit: 0,
    isStreakDay: false,
    totalCredits: 0,
    checkinDates: [],
    activityName: '',
    themeName: '',
    endTime: '',
    ...actionRequired ? { actionRequired: true } : {},
  }
}
