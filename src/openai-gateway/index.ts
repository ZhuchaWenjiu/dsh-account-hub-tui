import type { Context } from '@deepseek-ai/cordis'
import { resolveJetHubHome } from '../jet-hub-store.js'
import { createOpenAiGateway, type LlmRuntimeLike, type GatewayLogger } from './server.js'

/** 启动对外兼容网关，并把关闭动作绑定到插件生命周期。 */
export function mountOpenAiGateway(ctx: Context): void {
  const logger: GatewayLogger = {
    info: (message) => ctx.logger?.info?.(message),
    warn: (message) => ctx.logger?.warn?.(message),
    error: (message) => ctx.logger?.error?.(message),
  }
  const gateway = createOpenAiGateway({
    ctx,
    llm: ctx.llm as unknown as LlmRuntimeLike,
    home: resolveJetHubHome(ctx),
    logger,
  })
  void gateway.start().catch(() => {
    // 启动失败已经由网关记录端口冲突等具体原因；不阻断 Desktop 其它功能。
  })
  ctx.effect(() => () => {
    void gateway.close()
  }, 'openai-gateway')
}
