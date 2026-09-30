import { describe, expect, it } from 'vitest'
import { toOpenAiModels } from '../../src/openai-gateway/models.js'

describe('OpenAI gateway model catalog', () => {
  it('namespaces models by provider without merging duplicates', () => {
    const models = toOpenAiModels([
      { provider: 'qoder', models: [{ id: 'qfmodel', name: 'Qwen Flash', contextWindow: 128000 }] },
      { provider: 'qodercn', models: [{ id: 'qfmodel', name: 'Qwen Flash CN' }] },
    ])
    expect(models.map(model => model.id)).toEqual(['qoder/qfmodel', 'qodercn/qfmodel'])
    expect(models[0]).toMatchObject({ owned_by: 'qoder', context_window: 128000 })
  })
})
