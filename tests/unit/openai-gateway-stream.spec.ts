import { describe, expect, it } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { collectOpenAiCompletion, toOpenAiSse } from '../../src/openai-gateway/stream.js'

async function* chunks(values: StreamChunk[]): AsyncIterable<StreamChunk> {
  yield* values
}

describe('OpenAI gateway stream conversion', () => {
  it('converts text and usage into OpenAI SSE', async () => {
    const output: string[] = []
    for await (const item of toOpenAiSse(chunks([
      { type: 'text-delta', index: 0, text: 'hello' },
      { type: 'usage', usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]), 'req-1', 'qoder/qfmodel')) output.push(item)

    expect(output.join('')).toContain('"content":"hello"')
    expect(output.join('')).toContain('"finish_reason":"stop"')
    expect(output.at(-1)).toBe('data: [DONE]\n\n')
  })

  it('converts tool call deltas and finish reason', async () => {
    const output: string[] = []
    for await (const item of toOpenAiSse(chunks([
      { type: 'tool-call-delta', index: 0, id: 'call-1' as never, name: 'read', argumentsDelta: '{' },
      { type: 'tool-call-delta', index: 0, id: 'call-1' as never, argumentsDelta: '}' },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ]), 'req-2', 'qoder/qfmodel')) output.push(item)

    expect(output.join('')).toContain('"tool_calls"')
    expect(output.join('')).toContain('"finish_reason":"tool_calls"')
  })

  it('aggregates a non-stream response', async () => {
    const response = await collectOpenAiCompletion(chunks([
      { type: 'text-delta', index: 0, text: 'a' },
      { type: 'text-delta', index: 0, text: 'b' },
      { type: 'finish', reason: { kind: 'max-tokens' } },
    ]), 'req-3', 'qoder/qfmodel')
    expect(response).toMatchObject({ id: 'req-3', model: 'qoder/qfmodel' })
    expect(response.choices[0].message.content).toBe('ab')
    expect(response.choices[0].finish_reason).toBe('length')
  })
})
