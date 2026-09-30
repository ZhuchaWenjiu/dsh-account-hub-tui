import { randomUUID } from 'node:crypto'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, Message, ToolSchema } from '@deepseek-ai/dsh-llm'

export class OpenAiGatewayError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly type = 'invalid_request_error',
    readonly code = 'invalid_request',
  ) {
    super(message)
    this.name = 'OpenAiGatewayError'
  }
}

export interface OpenAiToolCall {
  id?: unknown
  type?: unknown
  function?: { name?: unknown; arguments?: unknown }
}

export interface OpenAiChatMessage {
  role?: unknown
  content?: unknown
  tool_calls?: unknown
  tool_call_id?: unknown
}

export interface OpenAiChatRequest {
  model?: unknown
  messages?: unknown
  stream?: unknown
  temperature?: unknown
  max_tokens?: unknown
  max_completion_tokens?: unknown
  stop?: unknown
  reasoning_effort?: unknown
  tools?: unknown
  tool_choice?: unknown
}

export function normalizeReasoningEffort(
  requested: unknown,
  modelInfo: unknown,
  provider?: string,
  model?: string,
): string | undefined {
  if (requested === undefined) return undefined
  const value = String(requested)
  if (provider === 'codearts' && model !== undefined) {
    return value === 'none' || value === 'off' ? 'off' : 'on'
  }
  const record = modelInfo as { reasoning?: { efforts?: readonly { id?: unknown }[] } } | undefined
  const supported = new Set((record?.reasoning?.efforts ?? []).map(effort => String(effort.id)))
  if (supported.size === 0 || supported.has(value)) return value
  if ((value === 'none' || value === 'off') && supported.has('off')) return 'off'
  if (value !== 'none' && value !== 'off' && supported.has('on')) return 'on'
  throw new OpenAiGatewayError(
    `reasoning effort ${JSON.stringify(value)} is not supported by the selected DSH model`,
    400,
    'unsupported_parameter',
    'unsupported_reasoning_effort',
  )
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (content === null || content === undefined) return ''
  if (!Array.isArray(content)) {
    throw new OpenAiGatewayError('message.content must be a string or an array of text parts')
  }
  return content.map((part) => {
    if (!part || typeof part !== 'object') {
      throw new OpenAiGatewayError('message.content contains an invalid part')
    }
    const item = part as { type?: unknown; text?: unknown }
    if (item.type === 'text' && typeof item.text === 'string') return item.text
    if (item.type === 'image_url') {
      throw new OpenAiGatewayError('image input is not available through the DSH gateway yet', 400, 'unsupported_content', 'unsupported_content')
    }
    throw new OpenAiGatewayError('message.content contains an unsupported part')
  }).join('')
}

function newMessage(
  role: Message['role'],
  content: Message['content'],
  source: Message['source'],
): Message {
  return { id: randomUUID() as Message['id'], role, content, source }
}

function convertToolCalls(raw: unknown): Message['content'] {
  if (!Array.isArray(raw)) throw new OpenAiGatewayError('assistant.tool_calls must be an array')
  return raw.map((value) => {
    if (!value || typeof value !== 'object') throw new OpenAiGatewayError('tool call must be an object')
    const call = value as OpenAiToolCall
    const id = typeof call.id === 'string' && call.id.length > 0 ? call.id : undefined
    const name = typeof call.function?.name === 'string' && call.function.name.length > 0
      ? call.function.name
      : undefined
    const args = typeof call.function?.arguments === 'string' ? call.function.arguments : undefined
    if (!id || !name || args === undefined) throw new OpenAiGatewayError('assistant.tool_calls contains an invalid function call')
    return { type: 'tool-call' as const, id: id as never, name, arguments: args }
  })
}

function convertMessage(raw: unknown, provider: string, model: string): Message {
  if (!raw || typeof raw !== 'object') throw new OpenAiGatewayError('messages entries must be objects')
  const value = raw as OpenAiChatMessage
  const role = value.role
  if (role === 'system') {
    return newMessage('system', [{ type: 'text', text: textFromContent(value.content) }], {
      kind: 'plugin', plugin: 'dsh-openai-gateway',
    })
  }
  if (role === 'user') {
    return newMessage('user', [{ type: 'text', text: textFromContent(value.content) }], { kind: 'user' })
  }
  if (role === 'assistant') {
    const text = textFromContent(value.content)
    const content: Message['content'] = text.length > 0 ? [{ type: 'text', text }] : []
    if (value.tool_calls !== undefined) content.push(...convertToolCalls(value.tool_calls))
    return newMessage('assistant', content, { kind: 'model', provider, model })
  }
  if (role === 'tool') {
    if (typeof value.tool_call_id !== 'string' || value.tool_call_id.length === 0) {
      throw new OpenAiGatewayError('tool messages require tool_call_id')
    }
    return newMessage('user', [{
      type: 'tool-result',
      toolCallId: value.tool_call_id as never,
      content: [{ type: 'text', text: textFromContent(value.content) }],
    }], { kind: 'tool', callId: value.tool_call_id as never })
  }
  throw new OpenAiGatewayError(`unsupported message role: ${String(role)}`)
}

function convertTools(raw: unknown): ToolSchema[] | undefined {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw)) throw new OpenAiGatewayError('tools must be an array')
  return raw.map((value) => {
    if (!value || typeof value !== 'object') throw new OpenAiGatewayError('tool must be an object')
    const tool = value as { type?: unknown; function?: { name?: unknown; description?: unknown; parameters?: unknown } }
    if (tool.type !== 'function' || typeof tool.function?.name !== 'string') {
      throw new OpenAiGatewayError('only function tools are supported')
    }
    const parameters = tool.function.parameters
    if (parameters !== undefined && (!parameters || typeof parameters !== 'object' || Array.isArray(parameters))) {
      throw new OpenAiGatewayError('tool function.parameters must be a JSON object')
    }
    return {
      name: tool.function.name,
      description: typeof tool.function.description === 'string' ? tool.function.description : '',
      parameters: (parameters ?? {}) as Record<string, unknown>,
    }
  })
}

export function parseModelRoute(value: unknown): { provider: string; model: string } {
  if (typeof value !== 'string') throw new OpenAiGatewayError('model must be a string')
  const slash = value.indexOf('/')
  if (slash <= 0 || slash === value.length - 1) {
    throw new OpenAiGatewayError('model must use provider/model format')
  }
  return { provider: value.slice(0, slash), model: value.slice(slash + 1) }
}

function tokenValue(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new OpenAiGatewayError(`${name} must be a positive integer`)
  }
  return value
}

export function toGenerateOptions(body: OpenAiChatRequest, signal: AbortSignal, reasoningEffortOverride?: string): GenerateOptions {
  const { provider, model } = parseModelRoute(body.model)
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new OpenAiGatewayError('messages must be a non-empty array')
  }
  if (body.tool_choice !== undefined && body.tool_choice !== 'auto' && body.tool_choice !== 'none') {
    throw new OpenAiGatewayError('only tool_choice auto and none are supported')
  }
  const maxTokens = body.max_completion_tokens !== undefined
    ? tokenValue(body.max_completion_tokens, 'max_completion_tokens')
    : tokenValue(body.max_tokens, 'max_tokens')
  const stop = body.stop === undefined
    ? undefined
    : typeof body.stop === 'string' ? [body.stop]
      : Array.isArray(body.stop) && body.stop.every(item => typeof item === 'string') ? body.stop
        : (() => { throw new OpenAiGatewayError('stop must be a string or string array') })()
  const temperature = body.temperature === undefined ? undefined
    : typeof body.temperature === 'number' && Number.isFinite(body.temperature) ? body.temperature
      : (() => { throw new OpenAiGatewayError('temperature must be a finite number') })()

  const tools = convertTools(body.tools)
  if (body.tool_choice === 'none' && tools !== undefined && tools.length > 0) {
    throw new OpenAiGatewayError('tool_choice none with tools cannot be represented by DSH', 400, 'unsupported_parameter', 'unsupported_parameter')
  }
  const reasoningEffort = reasoningEffortOverride ?? (body.reasoning_effort === undefined ? undefined : String(body.reasoning_effort))
  return {
    provider,
    model,
    messages: body.messages.map((message) => convertMessage(message, provider, model)),
    ...tools === undefined ? {} : { tools },
    ...maxTokens === undefined ? {} : { maxTokens },
    ...temperature === undefined ? {} : { temperature },
    ...stop === undefined ? {} : { stop },
    ...reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(reasoningEffort) },
    signal,
  }
}
