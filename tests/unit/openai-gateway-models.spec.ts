import { describe, expect, it } from 'vitest'
import { collectGatewayModelIds, collectGatewayModels, toOpenAiModels } from '../../src/openai-gateway/models.js'

/** 目录采集替身：`broken` provider 的 listModels 一律抛错。 */
function makeSource() {
  return {
    listProviders: () => [{ id: 'qoder' }, { id: 'broken' }],
    listModels: async (provider: string) => {
      if (provider === 'broken') throw new Error('no credentials')
      return [{ id: 'qfmodel', name: 'Qwen Flash' }]
    },
  }
}

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

describe('collectGatewayModels（目录采集的容错口径）', () => {
  it('单个 provider 失败只跳过它，不让整份目录失败', async () => {
    // 「一家失败整体 502」是初版缺陷：用户看到的是「网关坏了」，
    // 真实原因只是某一个 provider 没登录。
    const skipped: string[] = []
    const groups = await collectGatewayModels(makeSource(), (provider) => skipped.push(provider))
    expect(groups.map(g => g.provider)).toEqual(['qoder'])
    expect(skipped).toEqual(['broken'])
  })

  it('不给 onError 也照常跳过（不把错误抛给调用方）', async () => {
    await expect(collectGatewayModels(makeSource())).resolves.toHaveLength(1)
  })

  it('collectGatewayModelIds 与 /v1/models 返回同一批 ID（两处必须同源）', async () => {
    // 漂移的症状是「照着设置页填的模型号却不被网关接受」，极难自查。
    const groups = await collectGatewayModels(makeSource())
    const fromEndpoint = toOpenAiModels(groups).map(m => m.id)
    const fromRpc = (await collectGatewayModelIds(makeSource())).map(m => m.id)
    expect(fromRpc).toEqual(fromEndpoint)
    expect(fromRpc).toEqual(['qoder/qfmodel'])
  })

  it('ID 保留原始大小写（大小写敏感，规范化会掩盖真实 ID）', async () => {
    const source = {
      listProviders: () => [{ id: 'codearts' }],
      // 同一 provider 内大小写就是混的：glm-5.3-flash 与 GLM-5.2 并存。
      listModels: async () => [{ id: 'glm-5.3-flash', name: 'A' }, { id: 'GLM-5.2', name: 'B' }],
    }
    const ids = (await collectGatewayModelIds(source)).map(m => m.id)
    expect(ids).toEqual(['codearts/glm-5.3-flash', 'codearts/GLM-5.2'])
  })

  it('模型名里带斜杠时只按第一个斜杠切分', async () => {
    const source = {
      listProviders: () => [{ id: 'cline' }],
      listModels: async () => [{ id: 'anthropic/claude-sonnet-5.5', name: 'Claude' }],
    }
    expect((await collectGatewayModelIds(source))[0].id).toBe('cline/anthropic/claude-sonnet-5.5')
  })

  // 以下三条是**实机报障**后复现出来的畸形输入（真实 DSH service 的形态与类型
  // 声明可能不一致）。它们曾让目录采集直接抛错，进而把设置页**整个状态读取**
  // 一起拖垮 —— 用户连开关、地址、密钥都看不到。
  it('⚠️ 承诺永不抛出：listProviders 返回非数组', async () => {
    await expect(collectGatewayModels({ listProviders: () => undefined, listModels: async () => [] }))
      .resolves.toEqual([])
  })

  it('⚠️ 承诺永不抛出：listModels 返回非数组', async () => {
    const skipped: string[] = []
    const groups = await collectGatewayModels(
      { listProviders: () => [{ id: 'a' }], listModels: async () => undefined },
      (provider) => skipped.push(provider),
    )
    expect(groups).toEqual([])
    expect(skipped).toEqual(['a'])
  })

  it('⚠️ 承诺永不抛出：provider 条目缺 id / listProviders 自身抛错', async () => {
    // 缺 id 的条目被丢弃，合法的 `ok` 照常保留 —— 而不是整份目录一起崩掉。
    await expect(collectGatewayModels({
      listProviders: () => [{}, { id: 'ok' }],
      listModels: async () => [],
    })).resolves.toEqual([{ provider: 'ok', models: [] }])
    await expect(collectGatewayModels({
      listProviders: () => { throw new Error('boom') },
      listModels: async () => [],
    })).resolves.toEqual([])
  })

  it('一个 provider 目录畸形不影响其它 provider 的模型出现在清单里', async () => {
    const groups = await collectGatewayModels({
      listProviders: () => [{ id: 'broken' }, { id: 'good' }],
      listModels: async (provider) => {
        if (provider === 'broken') throw new Error('no credentials')
        return [{ id: 'm', name: 'M' }]
      },
    })
    expect(groups.map(g => g.provider)).toEqual(['good'])
  })

  it('透传 inputModalities（决定用户能否给该模型发图）', async () => {
    const source = {
      listProviders: () => [{ id: 'lobsterai' }],
      listModels: async () => [
        { id: 'vision', name: 'V', inputModalities: ['text', 'image'] as const },
        { id: 'text-only', name: 'T', inputModalities: ['text'] as const },
      ],
    }
    const models = await collectGatewayModelIds(source)
    expect(models.find(m => m.id.endsWith('vision'))?.input).toEqual(['text', 'image'])
    expect(models.find(m => m.id.endsWith('text-only'))?.input).toEqual(['text'])
  })

  it('⚠️ 缺 inputModalities 时归一化为 [text]（少报能力好过让用户发一张必被拒的图）', async () => {
    const source = {
      listProviders: () => [{ id: 'p' }],
      listModels: async () => [{ id: 'm', name: 'M' }],
    }
    expect((await collectGatewayModelIds(source))[0].input).toEqual(['text'])
  })

  it('input 必须是副本：调用方改返回值不得污染上游对象', async () => {
    const shared = { id: 'm', name: 'M', inputModalities: ['text', 'image'] as const }
    const source = { listProviders: () => [{ id: 'p' }], listModels: async () => [shared] }
    const model = (await collectGatewayModelIds(source))[0]
    expect(model.input).not.toBe(shared.inputModalities)
  })

  it('与 /v1/models 返回的 input 同源（两处漂移会让用户选错模型）', async () => {
    const source = {
      listProviders: () => [{ id: 'codearts' }],
      listModels: async () => [{ id: 'GLM-5.2', name: 'G', inputModalities: ['text'] as const }],
    }
    const groups = await collectGatewayModels(source)
    expect(toOpenAiModels(groups)[0].input).toEqual((await collectGatewayModelIds(source))[0].input)
  })
})
