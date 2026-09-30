import { describe, expect, it } from 'vitest'
import { parseModelRoute, toGenerateOptions } from '../../src/openai-gateway/messages.js'
import { collectOpenAiCompletion, toOpenAiSse } from '../../src/openai-gateway/stream.js'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'

async function* chunks(values: StreamChunk[]): AsyncIterable<StreamChunk> { yield* values }

describe('OpenAI gateway edge cases', () => {
  it('accepts model ids that contain slashes after the provider', () => {
    expect(parseModelRoute('cline/cline-free/deepseek-v4.1-flash'))
      .toEqual({ provider: 'cline', model: 'cline-free/deepseek-v4.1-flash' })
  })

  it('rejects image parts instead of silently dropping them', () => {
    expect(() => toGenerateOptions({ model: 'qoder/qfmodel', messages: [{ role: 'user', content: [
      { type: 'image_url', image_url: { url: 'data:image/png;base64,eA==' } },
    ] }] }, new AbortController().signal)).toThrow(/image input/i)
  })

  it('never converts a DSH stream error to successful completion', async () => {
    await expect(collectOpenAiCompletion(chunks([
      { type: 'finish', reason: { kind: 'error', failure: { code: 'QUOTA_EXCEEDED', message: 'No quota' } } },
    ]), 'request', 'qoder/qfmodel')).rejects.toThrow('No quota')
  })

  it('does not pretend an incomplete stream has stopped', async () => {
    await expect(collectOpenAiCompletion(chunks([{ type: 'text-delta', index: 0, text: 'partial' }]), 'request', 'qoder/qfmodel'))
      .rejects.toThrow(/finish/i)
  })

  it('emits an SSE error rather than DONE-only when no finish arrives', async () => {
    const events: string[] = []
    for await (const frame of toOpenAiSse(chunks([{ type: 'text-delta', index: 0, text: 'partial' }]), 'request', 'qoder/qfmodel')) events.push(frame)
    expect(events.join('')).toContain('"error"')
  })
})
