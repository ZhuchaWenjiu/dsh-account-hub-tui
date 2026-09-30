import { describe, expect, it } from 'vitest'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { parseModelRoute, toGenerateOptions, OpenAiGatewayError, normalizeReasoningEffort } from '../../src/openai-gateway/messages.js'

describe('OpenAI gateway request conversion', () => {
  it('parses a namespaced model route', () => {
    expect(parseModelRoute('qoder/qfmodel')).toEqual({ provider: 'qoder', model: 'qfmodel' })
  })

  it('rejects a model without provider namespace', () => {
    expect(() => parseModelRoute('qfmodel')).toThrow(OpenAiGatewayError)
  })

  it('converts text, assistant tool calls, tool results and tools', () => {
    const options = toGenerateOptions({
      model: 'qoder/qfmodel',
      messages: [
        { role: 'system', content: 'system prompt' },
        { role: 'user', content: 'hello' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read', arguments: '{"path":"a"}' } }],
        },
        { role: 'tool', tool_call_id: 'call-1', content: 'file content' },
      ],
      tools: [{ type: 'function', function: { name: 'read', description: 'read file', parameters: { type: 'object' } } }],
      max_tokens: 100,
      max_completion_tokens: 200,
      reasoning_effort: 'high',
      stream: true,
    }, new AbortController().signal)

    expect(options.provider).toBe('qoder')
    expect(options.model).toBe('qfmodel')
    expect(options.maxTokens).toBe(200)
    expect(options.reasoningEffort).toBe(ReasoningEffortId('high'))
    expect(options.tools).toEqual([{ name: 'read', description: 'read file', parameters: { type: 'object' } }])
    expect(options.messages).toHaveLength(4)
    expect(options.messages[2].content).toContainEqual(expect.objectContaining({ type: 'tool-call', name: 'read' }))
    expect(options.messages[3].content).toContainEqual(expect.objectContaining({ type: 'tool-result', toolCallId: 'call-1' }))
  })

  it('maps generic reasoning levels to the provider declared on/off levels', () => {
    const info = { reasoning: { efforts: [{ id: 'on' }, { id: 'off' }] } }
    expect(normalizeReasoningEffort('max', info)).toBe('on')
    expect(normalizeReasoningEffort('high', info)).toBe('on')
    expect(normalizeReasoningEffort('none', info)).toBe('off')
    expect(normalizeReasoningEffort('off', info)).toBe('off')
  })
  it('maps CodeArts generic levels even when legacy runtime omits reasoning metadata', () => {
    expect(normalizeReasoningEffort('high', undefined, 'codearts', 'deepseek-v4-flash')).toBe('on')
    expect(normalizeReasoningEffort('max', undefined, 'codearts', 'deepseek-v4-flash')).toBe('on')
    expect(normalizeReasoningEffort('none', undefined, 'codearts', 'deepseek-v4-flash')).toBe('off')
  })

  it('rejects forced function tool choice in the first version', () => {
    expect(() => toGenerateOptions({
      model: 'qoder/qfmodel',
      messages: [{ role: 'user', content: 'hello' }],
      tool_choice: { type: 'function', function: { name: 'read' } },
    }, new AbortController().signal)).toThrow(/tool_choice/i)
  })
})
