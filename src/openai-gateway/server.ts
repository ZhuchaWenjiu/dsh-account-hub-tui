import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, LlmModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { loadOrCreateApiKey } from './auth.js'
import { resolveGatewayConfig, type OpenAiGatewayConfig } from './config.js'
import { toGenerateOptions, OpenAiGatewayError, parseModelRoute, normalizeReasoningEffort, type OpenAiChatRequest } from './messages.js'
import { toOpenAiModels } from './models.js'
import { collectOpenAiCompletion, failureToOpenAiError, toOpenAiSse } from './stream.js'

export interface GatewayLogger {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

export interface LlmRuntimeLike {
  listProviders(): readonly { id: string }[]
  listModels(provider: string): Promise<readonly LlmModelInfo[]>
  resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<unknown>
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}

export interface OpenAiGatewayOptions {
  ctx?: Context
  llm: LlmRuntimeLike
  home?: string
  env?: NodeJS.ProcessEnv
  logger?: GatewayLogger
}

export interface OpenAiGateway {
  start(): Promise<void>
  close(): Promise<void>
  address(): { host: string; port: number }
}

const BODY_LIMIT = 16 * 1024 * 1024

const defaultLogger: GatewayLogger = {
  info: (message) => console.info(message),
  warn: (message) => console.warn(message),
  error: (message) => console.error(message),
}

function jsonResponse(response: ServerResponse, status: number, value: unknown): void {
  if (response.headersSent) return
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  })
  response.end(body)
}

function readJson(request: IncomingMessage, signal: AbortSignal): Promise<OpenAiChatRequest> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    const abort = () => reject(new OpenAiGatewayError('request was aborted', 499, 'aborted', 'aborted'))
    signal.addEventListener('abort', abort, { once: true })
    request.on('data', (chunk: Buffer | string) => {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += data.length
      if (size > BODY_LIMIT) {
        reject(new OpenAiGatewayError('request body is too large', 413, 'invalid_request_error', 'request_too_large'))
        request.destroy()
        return
      }
      chunks.push(data)
    })
    request.on('error', reject)
    request.on('end', () => {
      signal.removeEventListener('abort', abort)
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('body must be an object')
        resolve(value as OpenAiChatRequest)
      } catch {
        reject(new OpenAiGatewayError('request body must be valid JSON'))
      }
    })
  })
}

function authorized(request: IncomingMessage, key: string): boolean {
  const value = request.headers.authorization
  return typeof value === 'string' && value === `Bearer ${key}`
}

function getHome(options: OpenAiGatewayOptions): string {
  return options.home ?? options.env?.DSH_HOME ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

export function createOpenAiGateway(options: OpenAiGatewayOptions): OpenAiGateway {
  const env = options.env ?? process.env
  const config: OpenAiGatewayConfig = resolveGatewayConfig(env)
  const key = loadOrCreateApiKey(getHome(options), env)
  const logger = options.logger ?? defaultLogger
  let server: Server | undefined
  let boundPort = config.port
  const active = new Set<AbortController>()

  const handleModels = async (response: ServerResponse): Promise<void> => {
    const groups = await Promise.all(options.llm.listProviders().map(async ({ id: provider }) => ({
      provider,
      models: await options.llm.listModels(provider),
    })))
    jsonResponse(response, 200, { object: 'list', data: toOpenAiModels(groups) })
  }

  const handleChat = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const controller = new AbortController()
    active.add(controller)
    const abort = () => controller.abort()
    request.once('aborted', abort)
    response.once('close', () => {
      if (!response.writableEnded) controller.abort()
    })
    try {
      const body = await readJson(request, controller.signal)
      const route = parseModelRoute(body.model)
      const modelInfo = await options.llm.resolveModelInfo(route.provider, route.model, controller.signal)
      const reasoningEffort = normalizeReasoningEffort(body.reasoning_effort, modelInfo)
      const generate = toGenerateOptions(body, controller.signal, reasoningEffort)
      const stream = options.llm.stream(generate)
      if (body.stream === true) {
        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'access-control-allow-origin': '*',
        })
        for await (const event of toOpenAiSse(stream, undefined, `${route.provider}/${route.model}`)) {
          if (controller.signal.aborted || response.destroyed) break
          response.write(event)
        }
        if (!response.writableEnded) response.end()
      } else {
        const result = await collectOpenAiCompletion(stream, undefined, `${route.provider}/${route.model}`)
        jsonResponse(response, 200, result)
      }
    } catch (error) {
      if (!response.headersSent && !response.destroyed) {
        const converted = failureToOpenAiError(error)
        jsonResponse(response, converted.status, converted.body)
      }
    } finally {
      request.removeListener('aborted', abort)
      active.delete(controller)
    }
  }

  const requestHandler = (request: IncomingMessage, response: ServerResponse): void => {
    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'Authorization, Content-Type',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
      })
      response.end()
      return
    }
    if (!authorized(request, key)) {
      jsonResponse(response, 401, { error: { message: 'Missing or invalid API key', type: 'authentication_error', code: 'invalid_api_key' } })
      return
    }
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    if (path === '/v1/models' && request.method === 'GET') {
      void handleModels(response).catch(error => jsonResponse(response, 502, { error: { message: String(error), type: 'server_error', code: 'model_list_failed' } }))
      return
    }
    if (path === '/v1/chat/completions' && request.method === 'POST') {
      if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) {
        jsonResponse(response, 415, { error: { message: 'Content-Type must be application/json', type: 'invalid_request_error', code: 'invalid_content_type' } })
        return
      }
      void handleChat(request, response)
      return
    }
    jsonResponse(response, 404, { error: { message: 'Not found', type: 'invalid_request_error', code: 'not_found' } })
  }

  return {
    async start(): Promise<void> {
      if (server !== undefined) return
      const current = createServer(requestHandler)
      server = current
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          current.off('listening', onListening)
          server = undefined
          reject(error)
        }
        const onListening = () => {
          current.off('error', onError)
          const address = current.address()
          boundPort = typeof address === 'object' && address !== null ? address.port : config.port
          resolve()
        }
        current.once('error', onError)
        current.once('listening', onListening)
        current.listen(config.port, config.host)
      }).catch((error) => {
        logger.error(`[openai-gateway] 启动失败 ${config.host}:${config.port}：${error instanceof Error ? error.message : String(error)}`)
        throw error
      })
      logger.info(`[openai-gateway] 已监听 http://${config.host}:${boundPort}/v1`)
    },
    async close(): Promise<void> {
      for (const controller of active) controller.abort()
      if (server === undefined) return
      const current = server
      server = undefined
      await new Promise<void>((resolve) => current.close(() => resolve()))
      logger.info('[openai-gateway] 已关闭')
    },
    address(): { host: string; port: number } {
      return { host: config.host, port: boundPort }
    },
  }
}
