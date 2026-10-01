/**
 * Jet Hub 管理页面客户端插件。
 *
 * 注册两处：
 * 1. `settings.section` —— Jet Hub 设置页面；
 * 2. `settings.models.provider-card`（keyed 槽）—— 把 ZCode 的账号按键
 *    嵌进官方「设置 → 模型 → 模型卡片 → 编辑」里。
 */

export const name = 'jet-hub-client'
export const inject = ['slots', 'connection']

import { callManagementRpc, unwrapRpcResult } from '../management-rpc.mjs'
import { installJetHubStyles } from './jet-hub-styles.js'
import { JET_HUB_RPC_CHANNEL, JetHubPage } from './jet-hub.js'
import { ZcodeProviderCard } from './zcode-card.js'

export function apply(ctx) {
  ctx.effect(() => installJetHubStyles(), 'jet-hub: install styles')

  const rpcCall = async (endpoint, payload, signal) => {
    const raw = await callManagementRpc(ctx.connection, JET_HUB_RPC_CHANNEL, endpoint, payload, signal)
    return unwrapRpcResult(raw)
  }

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
}
