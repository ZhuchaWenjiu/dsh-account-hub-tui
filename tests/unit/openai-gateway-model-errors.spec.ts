import { describe, expect, it } from 'vitest'
import {
  findCaseInsensitiveSuggestion,
  looksLikeMissingModel,
  normalizeUpstreamFailure,
} from '../../src/openai-gateway/model-errors.js'

/**
 * 上游「模型不存在」类错误的**翻译**。
 *
 * ## 为什么是翻译而不是预检拦截
 *
 * `design.md:76` 明确要求「隐藏模型不出现在 /v1/models，但显式请求仍交给 DSH
 * 路由处理」。有些 provider 支持目录之外的模型（远端新上线、黑名单隐藏的），
 * 网关若在发请求前用 `listModels` 拦截，会把这类合法请求一并挡掉。
 *
 * 所以网关**不预判**：照常发起请求，只把上游返回的「模型不存在」从 502
 * （网关故障、客户端会重试）翻译成 404（配置错误、重试无意义）。
 *
 * ⚠️ 判据必须**窄**：CodeArts 的 `INVALID_REQUEST` 还覆盖参数非法、余额不足等
 * 多种情况，一律误判成「模型不存在」会让真正的参数错误也变成 404。
 */

describe('looksLikeMissingModel', () => {
  it('认得实测到的真实措辞', () => {
    // 实测：codearts 返回 code=INVALID_REQUEST + 下面这句。
    expect(looksLikeMissingModel('codearts: The model is not registered, please request other model')).toBe(true)
  })

  it('认得其它常见措辞', () => {
    for (const text of [
      'unknown model: foo',
      'model not found',
      'no such model',
      'The model does not exist',
      '模型不存在',
    ]) {
      expect(looksLikeMissingModel(text), text).toBe(true)
    }
  })

  it('⚠️ 其它错误不得被误判成模型不存在', () => {
    // 这几条都是真实的 INVALID_REQUEST / 其它失败形态，误判会让用户去查模型名
    // 而真正的参数错误被掩盖。
    for (const text of [
      'Invalid parameter: max_tokens',
      '余额不足',
      'Billing daily count exceeded',
      'rate limit exceeded',
      'the model returned an internal error',
      '',
    ]) {
      expect(looksLikeMissingModel(text), text).toBe(false)
    }
  })
})

describe('normalizeUpstreamFailure', () => {
  it('模型不存在：从 502 翻成 404 + invalid_request（不该被当成可重试故障）', () => {
    // 502 在 OpenAI 客户端眼里是「服务端故障」→ 会自动重试，而这是确定性失败。
    const result = normalizeUpstreamFailure({
      status: 502,
      type: 'server_error',
      code: 'INVALID_REQUEST',
      message: 'codearts: The model is not registered, please request other model',
    })
    expect(result).toEqual({ status: 404, type: 'invalid_request_error', code: 'model_not_found' })
  })

  it('非模型类错误原样保留（不得被顺手改写成 404）', () => {
    // ⚠️ 返回值**不含 message**（那是给调用方拼文案用的），故不能与入参整体比较。
    expect(normalizeUpstreamFailure({
      status: 502, type: 'server_error', code: 'SERVER', message: 'upstream exploded',
    })).toEqual({ status: 502, type: 'server_error', code: 'SERVER' })
  })

  it('余额不足等 INVALID_REQUEST 不会被当成模型不存在', () => {
    const result = normalizeUpstreamFailure({
      status: 502, type: 'server_error', code: 'INVALID_REQUEST',
      message: 'Invalid parameter: max_tokens',
    })
    expect(result.status).toBe(502)
  })
})

describe('findCaseInsensitiveSuggestion', () => {
  const CATALOG = [
    'codearts/glm-5.3-flash',
    'codearts/GLM-5.2',
    'buddy/deepseek-v4.1-flash',
  ]

  it('大小写拼错时给出正确拼写', () => {
    // 实测：用户照着 GLM-5.2 的大小写习惯猜出 GLM-5.3 → 被上游拒绝，
    // 但没有任何提示告诉他真正的小写 ID 是什么。
    expect(findCaseInsensitiveSuggestion('buddy/DeepSeek-V4.1-Flash', CATALOG)).toBe('buddy/deepseek-v4.1-flash')
    expect(findCaseInsensitiveSuggestion('Codearts/GLM-5.2', CATALOG)).toBe('codearts/GLM-5.2')
  })

  it('★ 实测那个真实误填：GLM-5.3 → glm-5.3-flash（既大小写不同又少一截后缀）', () => {
    // 纯「大小写全等」救不了这条：只有前缀匹配才能命中。漏掉第二级的话，
    // 用户拿到的还是那句没有任何线索的 "model is not registered"。
    expect(findCaseInsensitiveSuggestion('codearts/GLM-5.3', CATALOG)).toBe('codearts/glm-5.3-flash')
  })

  it('少打结尾时只有在候选唯一时才敢建议（有歧义就不猜）', () => {
    const ambiguous = ['codearts/glm-5.3-flash', 'codearts/glm-5.3-flashx']
    expect(findCaseInsensitiveSuggestion('codearts/glm-5.3-f', ambiguous)).toBeUndefined()
    expect(findCaseInsensitiveSuggestion('codearts/glm-5.3-f', ambiguous.slice(0, 1))).toBe('codearts/glm-5.3-flash')
  })

  it('完全不存在时不硬凑一个建议', () => {
    expect(findCaseInsensitiveSuggestion('codearts/totally-other', CATALOG)).toBeUndefined()
    expect(findCaseInsensitiveSuggestion('unknown/model', CATALOG)).toBeUndefined()
  })

  it('精确命中时返回 undefined（没有拼写错误就没有建议）', () => {
    expect(findCaseInsensitiveSuggestion('codearts/GLM-5.2', CATALOG)).toBeUndefined()
  })

  it('目录为空时不报错', () => {
    expect(findCaseInsensitiveSuggestion('a/b', [])).toBeUndefined()
  })

  it('只认大小写不同：模型段相同但 provider 不同不得建议', () => {
    // codearts 与 buddy 各有一份 deepseek-v4.1-flash，换 provider 不是拼写错误。
    expect(findCaseInsensitiveSuggestion('CodeArts/deepseek-v4.1-flash', CATALOG)).toBeUndefined()
  })
})
