import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, LlmModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { loadOrCreateApiKey, type ApiKeySource } from './auth.js'
import { resolveGatewayConfig, type OpenAiGatewayConfig } from './config.js'
import { toGenerateOptions, OpenAiGatewayError, parseModelRoute, normalizeReasoningEffort, normalizeMaxTokens, type OpenAiChatRequest } from './messages.js'
import type { AttachmentBridge, ImageLimits } from './images.js'
import { collectGatewayModelIds, collectGatewayModels, toOpenAiModels } from './models.js'
import { findCaseInsensitiveSuggestion, looksLikeMissingModel } from './model-errors.js'
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
  /**
   * 附件服务桥接（`ctx.attachments.saveImage`）。
   *
   * 缺失时收到图片会明确回「未装载附件服务」而不是静默丢图 —— 静默丢弃会让用户
   * 以为模型看到了图，而答案其实是基于文本生成的。
   */
  attachments?: AttachmentBridge
  /** 图片限制；缺省用 `images.ts` 里附件服务的实测默认值。 */
  imageLimits?: ImageLimits
  home?: string
  env?: NodeJS.ProcessEnv
  logger?: GatewayLogger
}

export interface OpenAiGateway {
  start(): Promise<void>
  close(): Promise<void>
  address(): { host: string; port: number }
  /**
   * 密钥来源（含本体与文件路径）。
   *
   * 刻意**只经由 `createOpenAiGateway()` 拿**（runtime 已持有实例），而不是
   * 另开一条读密钥的通道：多一个入口就多一处「读到的和网关在用的不是同一个」
   * 的可能，而那种偏差会表现为「设置页复制的 key 一律 401」。
   */
  apiKey: ApiKeySource
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
  // 密钥在**创建时**解析（而不是 start 时）：设置页要能在网关未运行时也能
  // 读到它，用户才能配置外部客户端。
  const apiKey = loadOrCreateApiKey(getHome(options), env)
  const key = apiKey.value
  const logger = options.logger ?? defaultLogger
  let server: Server | undefined
  let boundPort = config.port
  const active = new Set<AbortController>()

  const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error))

  const handleModels = async (response: ServerResponse): Promise<void> => {
    // 逐个 catch 的容错在 collectGatewayModels 里（设置页的 RPC 复用同一份，
    // 两处各写一遍必然漂移）。
    const groups = await collectGatewayModels(options.llm, (provider, error) => {
      logger.warn(`[openai-gateway] ${provider} 模型目录读取失败，已从 /v1/models 跳过：${describe(error)}`)
    })
    jsonResponse(response, 200, { object: 'list', data: toOpenAiModels(groups) })
  }

  /**
   * 解析模型元信息。失败按「模型不可解析」回 404，而不是笼统的 502 ——
   * OpenAI 客户端据此区分「换个模型名重试」与「上游故障」，前者不该被当作可重试错误。
   */
  const resolveModelInfo = async (
    route: { provider: string; model: string },
    signal: AbortSignal,
  ): Promise<unknown> => {
    try {
      return await options.llm.resolveModelInfo(route.provider, route.model, signal)
    } catch (error) {
      // 取消导致的抛错不是「模型不存在」，不能被改写成 404。
      if (signal.aborted) throw new OpenAiGatewayError('request was aborted', 499, 'aborted', 'aborted')
      throw new OpenAiGatewayError(
        `model ${route.provider}/${route.model} could not be resolved: ${describe(error)}`,
        404,
        'invalid_request_error',
        'model_not_found',
      )
    }
  }

  /**
   * 失败时给出「你是不是想用 X」的建议。
   *
   * ⚠️ **目录只在出错时才去查**（正常请求零额外开销），且用的是与
   * `/v1/models` 完全相同的采集器 —— 建议里给出的 ID 必须真能被网关接受，
   * 两处各查一遍必然漂移，而漂移的症状是「按提示改了还是不行」。
   */
  const makeSuggestion = (requestedId: string) => async (message: string): Promise<string | undefined> => {
    if (!looksLikeMissingModel(message)) return undefined
    const catalog = await loadModelIdsHint()
    const found = findCaseInsensitiveSuggestion(requestedId, catalog)
    return found === undefined ? undefined : `你是不是想用 ${found}`
  }

  /**
   * 纠错建议用的模型 ID 清单。
   *
   * 惰性 + 只取一次：出错是少数情况，正常路径连这个数组都不会构造。
   * 取失败（某个 provider 未登录）时退化为空清单 —— 拿不到建议只是少一句
   * 提示，绝不能因此把真正的错误盖掉。
   */
  let hintLoaded = false
  let modelIdsHint: readonly string[] = []
  const loadModelIdsHint = async (): Promise<readonly string[]> => {
    if (!hintLoaded) {
      hintLoaded = true
      try {
        modelIdsHint = (await collectGatewayModelIds(options.llm)).map((model) => model.id)
      } catch {
        modelIdsHint = []
      }
    }
    return modelIdsHint
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
      const modelInfo = await resolveModelInfo(route, controller.signal)
      const reasoningEffort = normalizeReasoningEffort(body.reasoning_effort, modelInfo, route.provider, route.model)
      const requestedMaxTokens = body.max_completion_tokens ?? body.max_tokens
      const maxTokens = typeof requestedMaxTokens === 'number'
        ? normalizeMaxTokens(requestedMaxTokens, route.provider, route.model)
        : undefined
      const generate = await toGenerateOptions(body, controller.signal, reasoningEffort, maxTokens, {
        bridge: options.attachments,
        limits: options.imageLimits,
      })
      const stream = options.llm.stream(generate)
      const fullId = `${route.provider}/${route.model}`
      if (body.stream === true) {
        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'access-control-allow-origin': '*',
        })
        for await (const event of toOpenAiSse(stream, undefined, fullId, makeSuggestion(fullId))) {
          if (controller.signal.aborted || response.destroyed) break
          response.write(event)
        }
        if (!response.writableEnded) response.end()
      } else {
        const result = await collectOpenAiCompletion(stream, undefined, fullId, makeSuggestion(fullId))
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
    apiKey,
  }
}
