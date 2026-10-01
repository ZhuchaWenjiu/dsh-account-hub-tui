/**
 * Jet Hub 管理页面客户端插件。
 *
 * 注册 Jet Hub 设置页面到 DSH settings.section slot。
 */

export const name = 'jet-hub-client'
export const inject = ['slots', 'connection']

import { callManagementRpc, unwrapRpcResult } from '../management-rpc.mjs'
import { installJetHubStyles } from './jet-hub-styles.js'
import { JET_HUB_RPC_CHANNEL, JetHubPage } from './jet-hub.js'
import { startCarrierContribution } from './zcode-carrier.js'

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
}
