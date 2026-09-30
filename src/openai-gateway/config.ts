export const DEFAULT_GATEWAY_HOST = '127.0.0.1'
export const DEFAULT_GATEWAY_PORT = 8326

export interface OpenAiGatewayConfig {
  host: string
  port: number
}

/** 解析本机网关配置，端口错误时显式失败，避免静默换端口。 */
export function resolveGatewayConfig(env: NodeJS.ProcessEnv = process.env): OpenAiGatewayConfig {
  const rawPort = env.DSH_OPENAI_GATEWAY_PORT
  if (rawPort === undefined || rawPort.trim() === '') {
    return { host: DEFAULT_GATEWAY_HOST, port: DEFAULT_GATEWAY_PORT }
  }
  const port = Number.parseInt(rawPort, 10)
  if (!Number.isInteger(port) || port < 1 || port > 65535 || String(port) !== rawPort.trim()) {
    throw new Error('DSH_OPENAI_GATEWAY_PORT 必须是 1 到 65535 之间的整数')
  }
  return { host: DEFAULT_GATEWAY_HOST, port }
}
