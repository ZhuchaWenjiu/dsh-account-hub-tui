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
 *
 * ## ⚠️⚠️ `remote.session` **必须**在这里（真机事故 2026-10-02，desktop 永久失效）
 *
 * `dsh-client-ui-model-selection` 自己的声明是
 * `inject = ["sessions", "remote", "remote.session"]`，而它的
 * `directoryFor(sessionId)` 内部会读 `this.ctx.sessions` 与
 * `this.ctx.remote.session`。
 *
 * cordis 的 inject 是**逐插件**校验的：我们自己的 ctx 没声明 `remote.session`，
 * 那句 `ctx.remote.session` 就直接抛
 * `cannot get property "remote.session" without inject`。
 * 症状是**桌面版徽标永久不显示、且无任何报错**（我曾用 try/catch 吞掉异常，
 * 结果把崩溃换成了静默失败，比原问题更难发现）。
 *
 * ⇒ 这里必须与该包**对齐**地声明 `sessions` / `remote` / `remote.session`。
 * 少一个都会让 `directoryFor` 在 desktop 上失败。
 */
export const inject = ['slots', 'connection', 'modelDirectories', 'sessions', 'remote', 'remote.session']

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
      // ⚠️⚠️ **必须惰性取目录，不能在 inject 里取**（真机事故 2026-10-02）。
      //
      // 原写法 `directory: ctx.modelDirectories.directoryFor(sessionId).store`
      // 有两个问题：
      // 1. `directoryFor` 是**惰性 getter** —— 写 `directoryFor(sessionId).store`
      //    里的 `.store` 才触发求值，而求值发生在**槽位 inject 期**（即会话
      //    输入区渲染的同步路径上）。桌面版此时它内部要访问未注入的
      //    `remote.session`，直接抛 `cannot get property "remote.session"
      //    without inject`（Web 版不走那条分支，故只在 desktop 复现）。
      // 2. 该异常发生在渲染关键路径上，**会让整个会话输入区渲染中断** ——
      //    表现为模型选择器点不动（用户报障），远不止「徽标不显示」。
      //
      // ⇒ 改为交出一个**取值函数** `resolveDirectory()`，由组件在自己的
      // effect 里调用：失败被组件自身的 try/catch 兜住，影响面收敛到
      // 「徽标不显示」，绝不影响模型选择器。
      //
      // ⚠️⚠️ **必须同时交出 `store` 与 `load`（真机事故 2026-10-02 的真正根因）
      //
      // 读 `dsh-client-ui-model-selection` 的 `ModelDirectory` 源码得到两个事实：
      //   ① 它的**公开方法是 `load()` / `syncInputs()`，没有 `getSnapshot()` /
      //      `subscribe()`** —— 那两个在 `this.store` 上。我第一版只交出实例，
      //      组件调 `directory.getSnapshot()` 得到 `undefined` → TypeError →
      //      被 safe() 吞掉 → `provider` 恒为空 → **徽标永不显示**。
      //   ② `store` 的初值是 `{ current: null, status: 'idle' }`，**只有
      //      `await load()` 之后** `syncInputs()` 才把真实 `current` 填进去。
      //      徽标自己不发模型目录请求（`usage.badge` 按 provider 查），
      //      所以必须由它调 `load()`，否则 `current` 永远是 null。
      //
      // 两者缺一不可：只给 store 不 load → current 为 null；
      // 只给实例不 load 也不 store → getSnapshot 不存在。
      resolveDirectory: () => {
        const directory = ctx.modelDirectories.directoryFor(sessionId);
        return {
          store: directory.store,
          load: () => directory.load(),
        };
      },
      providerLabel,
      readBadge: (provider, options) => rpcCall('usage.badge', { provider, ...options }),
      writePreference: (preference) => rpcCall('usage.badgePreference', { preference }),
      // 自动签到开关（全局一个，不分渠道）：宿主在「打开」时会立刻跑一轮。
      setAutoCheckin: (enabled) => rpcCall('usage.autoCheckin', { enabled }),
      // 关闭那行**常驻**的自动签到状态文字（只关当前这一轮，下一轮会重新出现）。
      dismissAutoCheckin: () => rpcCall('usage.autoCheckin', { dismiss: true }),
      claimCredits: (provider) => rpcCall('credits.claimAll', { provider }),
    }),
  }, UsageBadge))
}
