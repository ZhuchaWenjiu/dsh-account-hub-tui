/**
 * `ctx.llm` 注册的**重启幂等**包装。
 *
 * ## ⚠ 为什么需要（真实故障，2026-09-30 合并 master 后）
 *
 * 合并当晚 web profile 的插件树激活失败，**整个 Jet Hub RPC 不可用**
 *（所有 provider 面板 404）：
 *
 * ```
 * LlmError: configurable provider "minimax" is already declared
 *   at registerConfigurableProviders (…/dsh-llm/lib/index.js:1937)
 *   at registerMinimaxLlm (lib/minimax-adapter.js:352)
 *   at new apply (lib/index.js:920)
 * ```
 *
 * ## 根因（cordis + dsh-llm 的生命周期交互）
 *
 * `ctx.llm.registerConfigurableProviders()` / `registerAdapter()` 内部都是
 * `this.ctx.effect(…)` —— **effect 挂在 llm 服务的 ctx 上**（`super(ctx,'llm')`
 * 的那个），其生命周期绑定**宿主根 zone**。而插件 apply 里注册的**其它**资源
 * 挂在插件 fiber 上。当宿主在启动过程中**重启插件 fiber**（config/patch 应用
 * 时序），新 fiber 的同步 apply 与旧 fiber 的异步 dispose（cordis 1077 行：
 * `return async () => {…}`）**交错执行**：
 *
 * - 新 apply 逐个注册 12 个 provider —— 每个都调 `directory.has()` 检查；
 * - 旧 dispose **异步地**逐个清理 —— 两者在 `directory` 这个 Map 上赛跑。
 *
 * 赛跑的**确定性结果**取决于 Map 的插入/删除顺序与两边步调 —— 实测稳定撞在
 * 序列后段的 `minimax`（它紧邻合并新增的 zcode，注册时间最长，给异步 dispose
 * 留下了追上来的窗口）。既有 10 个 provider 从没撞过，是因为它们的注册序更靠前、
 * dispose 追不上；minimax 是**第 11 个**，恰好越过了临界点。
 *
 * ## 修复语义
 *
 * `DUPLICATE_DIRECTORY`（configurable）与 `an adapter for provider … is already`
 *（adapter）都意味着「**同名的注册已存在**」。在重启场景下那是**上一轮同一个
 * 插件的注册**（同一代码、同一 settingsNs）—— 保留它、跳过本次提交是**语义等价**
 * 的：directory 只服务 settings 路由与展示，adapter 路由同样指向等价的实现。
 *
 * ⚠ 这**不是**吞错误：非重复类失败照常抛出（配置错、空列表等必须暴露）。
 * 也没有用「先查 directory 再注册」——查与注册之间存在同样的竞态窗口，
 * 只有 try/catch 能把检查与提交做成原子。
 */

/** dsh-llm 对「configurable provider 已存在」抛的 code。 */
const DUPLICATE_DIRECTORY = 'DUPLICATE_DIRECTORY'

/**
 * 判断一个 LlmError 是否为「同名注册已存在」。
 *
 * ⚠ 判据**必须**含错误码 **或** 文案：dsh-llm 对 adapter 重复的抛错
 *（`an adapter for provider "x" is already declared`）用的不是
 * DUPLICATE_DIRECTORY 码，且不同 dsh 版本的码可能微调 —— 文案兜底保证
 * 跨版本行为一致。⚠ 只匹配「already declared / already registered」这类
 * 精确语义，不碰泛词（否则会把真实配置错误吞掉）。
 */
function isDuplicateRegistrationError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const code = (error as { code?: unknown }).code
  if (code === DUPLICATE_DIRECTORY) return true
  const message = (error as { message?: unknown }).message
  if (typeof message !== 'string') return false
  return /already declared|already registered|is already (?:a|an) adapter/.test(message)
}

/** {@link registerConfigurableProvidersIdempotent} 的入参（透传 dsh-llm 契约）。 */
export interface ConfigurableProviderEntry {
  provider: string
  displayName: string
  settingsNs: string
  settingsPath: readonly string[]
}

/** {@link registerAdapterIdempotent} 的入参（透传 dsh-llm 契约）。 */
export interface AdapterRegisterTarget {
  registerConfigurableProviders(entries: readonly ConfigurableProviderEntry[]): unknown
  registerAdapter(providers: readonly string[], adapter: unknown): unknown
}

/**
 * 幂等版的 `ctx.llm.registerConfigurableProviders`。
 *
 * 重复激活（fiber 重启竞态）时**保留已存在的注册**并告警 —— 见模块头的根因说明。
 */
export function registerConfigurableProvidersIdempotent(
  llm: AdapterRegisterTarget,
  entries: readonly ConfigurableProviderEntry[],
  warn?: (message: string) => void,
): void {
  try {
    llm.registerConfigurableProviders(entries)
  } catch (error) {
    if (!isDuplicateRegistrationError(error)) throw error
    warn?.(
      '[llm-register] configurable providers '
      + entries.map((e) => `"${e.provider}"`).join(', ')
      + ' 已注册（插件 fiber 重启竞态），保留现有注册并跳过本次提交',
    )
  }
}

/**
 * 幂等版的 `ctx.llm.registerAdapter`。
 *
 * ⚠ 重复场景下的行为与 configurable 同款：保留现有 adapter 路由。
 * ⚠ 返回 dsh-llm 的 handle（含 `.replace()`）——重复分支没有 handle 可还，
 * 返回 `undefined`；调用方若需要 replace 能力应保存成功路径的返回值。
 */
export function registerAdapterIdempotent(
  llm: AdapterRegisterTarget,
  providers: readonly string[],
  adapter: unknown,
  warn?: (message: string) => void,
): unknown {
  try {
    return llm.registerAdapter(providers, adapter)
  } catch (error) {
    if (!isDuplicateRegistrationError(error)) throw error
    warn?.(
      `[llm-register] adapter for ${providers.map((p) => `"${p}"`).join(', ')} `
      + '已注册（插件 fiber 重启竞态），保留现有路由并跳过本次注册',
    )
    return undefined
  }
}
