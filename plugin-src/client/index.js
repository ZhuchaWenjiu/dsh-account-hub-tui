/**
 * Jet Hub 管理页面客户端插件。
 *
 * 注册三处：
 * 1. `settings.section` —— Jet Hub 设置页面；
 * 2. `settings.models.provider-card`（keyed 槽）—— 把 ZCode 的账号按键
 *    嵌进官方「设置 → 模型 → 模型卡片 → 编辑」里；
 * 3. `conversation.input.right`（list 槽，会话作用域）—— 模型选择器旁的
 *    **用量徽标**（订阅优先 / 积分兜底，点击展开明细）。
 */

export const name = 'jet-hub-client'
/**
 * ⚠️ `modelDirectories` 是徽标**唯一**的信息来源（当前选中的渠道）。
 *
 * 它由 `@deepseek-ai/dsh-client-ui-model-selection` 提供，故 `package.json` 的
 * `dsh.client.inject` 必须声明该包 —— 声明的作用是让那个包的 bundle **先于**
 * 本插件的 bundle 到达（见 `dsh-client-modules` 的 `arriveGraphRow`）。
 * 未声明时本插件可能先被物化，`inject` 便会一直等服务，徽标不出现（不影响
 * 设置页与其余功能）。
 */
export const inject = ['slots', 'connection', 'modelDirectories']

import { callManagementRpc, unwrapRpcResult } from '../management-rpc.mjs'
import { installJetHubStyles } from './jet-hub-styles.js'
import { JET_HUB_RPC_CHANNEL, JetHubPage, providerLabel } from './jet-hub.js'
import { startCarrierContribution } from './zcode-carrier.js'
import { ZcodeProviderCard } from './zcode-card.js'
import { UsageBadge } from './usage-badge.js'

export function apply(ctx) {
  ctx.effect(() => installJetHubStyles(), 'jet-hub: install styles')

  const rpcCall = async (endpoint, payload, signal) => {
    const raw = await callManagementRpc(ctx.connection, JET_HUB_RPC_CHANNEL, endpoint, payload, signal)
    return unwrapRpcResult(raw)
  }

  /**
   * zcode 内部 captcha 载体的贡献循环（二期 Task 4）。
   *
   * ⚠ **web 版零动作**：`plugin-src/client/zcode-carrier.js` 第一件事就是判
   * `globalThis.dshDesktop`（协议版本 1 才有 `browser` 租约桥）—— 拿不到就整体 return，
   * 不查 demand、不建 `<webview>`、连日志都不打。所以这条 effect 在 web 版里是个空壳，
   * 「桌面版才有内部载体」这条不变式靠它自己守住，改判据前请先看那个文件的规则 1。
   *
   * 返回值是**停止函数**，交给 `ctx.effect` 的清理路径：插件卸载/热替换时必须停掉心跳
   * 并归还 webview 租约，否则留下一个没人收的离屏 guest（`release` 没调 ⇒ 主进程侧泄漏）。
   */
  ctx.effect(() => startCarrierContribution({ rpcCall }), 'jet-hub: zcode 内部载体贡献循环')

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'jet-hub',
    order: 50,
    label: () => 'Jet Hub',
    inject: () => ({ rpcCall }),
  }, JetHubPage))

  /**
   * 官方「模型卡片 → 编辑」里的 provider-card 槽。
   *
   * ⚠ 三条硬约束（改这里之前先读 `zcode-card.js` 顶部注释）：
   * 1. 该槽是 **keyed** 槽，注册必须用 **`key`**（不是 `id`），否则
   *    `dsh-client-ui-slots` 抛 `keyed slot "..." requires options.key`；
   * 2. 全部 `llm-pi-ai` route 共用同一个 `settingsNs`（`llm-pi-ai`），
   *    故这里注册一次会收到该家族**每一张**卡片 —— 「是不是 zcode 这一行」
   *    由组件内部按 `props.provider.provider` 自判，**不能**按 `settingsNs` 判；
   * 3. `inject` 里的 `rpcCall` 与上面 settings.section 用的是同一个闭包函数。
   */
  ctx.slots.inject('settings.models.provider-card', () => ctx.slots.register(
    { name: 'settings.models.provider-card', key: 'llm-pi-ai', inject: () => ({ rpcCall }) },
    ZcodeProviderCard,
  ))

  /**
   * 模型选择器旁的**用量徽标**（`conversation.input.right`）。
   *
   * ## 槽位契约
   *
   * 该槽是 **list + 会话作用域**（`dsh-client-ui-conversation` 声明），渲染位置
   * 是 composer 的 `standardControls` 里、`conversation.input.model` **之前**，
   * 故徽标天然落在模型选择器左侧。
   * `inject` 回调收到 `sessionId`，用它取**该会话**的模型目录。
   *
   * ## ⚠️ 为什么是 `inject`（惰性）而不是在 `apply` 里直接注册
   *
   * `ctx.modelDirectories.directoryFor(sessionId)` 需要会话 id，而它只在槽位
   * 渲染时才知道；`inject` 回调正是"每个会话渲染时求值一次"的钩子。
   * 目录按会话惰性解析、随会话 dispose，故这里**不缓存** directory 对象。
   *
   * ## ⚠️ 只在选中本插件渠道时才可能渲染
   *
   * 组件内部第一件事就是判 `supportsCreditBalance(provider)`（能力表，12 个
   * 渠道），非本插件渠道直接 `return null` —— 既不渲染也不发请求。门控放在
   * 组件里而不是这里：这里拿不到"当前选中的 provider"（它在目录快照里，
   * 会随时间变化，必须由组件订阅）。
   */
  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right',
    id: 'jet-hub-usage',
    order: 100,
    inject: (sessionId) => ({
      // 目录的 store（订阅它即可跟随「用户切了模型」重新渲染）。
      directory: ctx.modelDirectories.directoryFor(sessionId).store,
      providerLabel,
      readBadge: (provider, options) => rpcCall('usage.badge', { provider, ...options }),
      writePreference: (preference) => rpcCall('usage.badgePreference', { preference }),
      // 自动签到开关（全局一个，不分渠道）：宿主在「打开」时会立刻跑一轮。
      setAutoCheckin: (enabled) => rpcCall('usage.autoCheckin', { enabled }),
      claimCredits: (provider) => rpcCall('credits.claimAll', { provider }),
    }),
  }, UsageBadge))
}
