import { describe, expect, it } from 'vitest'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { parseModelRoute, toGenerateOptions, OpenAiGatewayError, normalizeReasoningEffort, normalizeMaxTokens } from '../../src/openai-gateway/messages.js'

/**
 * `reasoning_effort` 的归一化。
 *
 * 背景（**实机报障**）：ZCode 经网关调 `lobsterai/MiniMax-M3.1-Flash-Preview`
 * 直接失败：
 *   `provider "lobsterai" model "..." does not support reasoning effort "high"`
 *
 * 根因：该模型**没有 `thinkingConfig`** ⇒ 适配器不声明 reasoning ⇒ 网关拿到
 * `supported.size === 0`，而那时代码是**原样透传** `high` ⇒ DSH 侧校验拒绝。
 *
 * 正确的处理是**不发** `reasoningEffort`（让模型走它自己的默认），而不是把一个
 * 该模型根本不认识的档位硬塞过去。
 */
describe('normalizeReasoningEffort', () => {
  const ON_OFF = { reasoning: { efforts: [{ id: 'on' }, { id: 'off' }] } }

  it('★ 模型未声明思考档位时不下发该参数（而不是原样透传未知的档位）', () => {
    // 原样透传会得到 DSH 侧的 UNSUPPORTED_REASONING_EFFORT（实机报障原句）。
    // ⚠️ 必须返回 **null**（明确不下发）而不是 undefined（= 用户没传）：
    // undefined 会被 toGenerateOptions 当成「没给值」而回退读 body.reasoning_effort，
    // 归一化结论被原样抵消 —— 这是本缺陷第二轮的复发形态。
    expect(normalizeReasoningEffort('high', {}, 'lobsterai', 'MiniMax-M3.1-Flash-Preview')).toBeNull()
    expect(normalizeReasoningEffort('on', {}, 'lobsterai', 'm')).toBeNull()
    expect(normalizeReasoningEffort('none', {}, 'lobsterai', 'm')).toBeNull()
  })

  it('★ null 传进 toGenerateOptions 后不得让 body 的原值复活（回归锁）', () => {
    // 这是报障的直接形态：body 里明明有 reasoning_effort:'high'，
    // 而归一化已判定「本模型不适用」，最终请求里**不能**再出现它。
    const body = {
      model: 'lobsterai/MiniMax-M3.1-Flash-Preview',
      messages: [{ role: 'user' as const, content: 'hi' }],
      reasoning_effort: 'high',
    }
    const effort = normalizeReasoningEffort(body.reasoning_effort, {}, 'lobsterai', 'MiniMax-M3.1-Flash-Preview')
    expect(effort).toBeNull()
    const options = toGenerateOptions(body, new AbortController().signal, effort)
    expect('reasoningEffort' in options).toBe(false)
  })

  it('未传该参数时（undefined）仍回退读 body，保持直连调用的老行为', async () => {
    const body = {
      model: 'qoder/qfmodel',
      messages: [{ role: 'user' as const, content: 'hi' }],
      reasoning_effort: 'high',
    }
    // 第三个参数省略 = 调用方没给 → 走 body
    const options = await toGenerateOptions(body, new AbortController().signal)
    expect(options.reasoningEffort).toBe('high')
  })

  it('模型未声明思考档位时，resolveModelInfo 整体失败也一律不下发', () => {
    // modelInfo 是 undefined 时同样不能透传：那不是「没有限制」，是「不知道」。
    expect(normalizeReasoningEffort('high', undefined, 'lobsterai', 'm')).toBeNull()
  })

  it('声明了 on/off 的模型：OpenAI 的 high/max 等一律映射成 on', () => {
    for (const requested of ['high', 'medium', 'low', 'minimal', 'xhigh', 'max']) {
      expect(normalizeReasoningEffort(requested, ON_OFF, 'lobsterai', 'm'), requested).toBe('on')
    }
  })

  it('声明了 on/off 的模型：none/off 映射成 off', () => {
    expect(normalizeReasoningEffort('none', ON_OFF, 'qoder', 'qfmodel')).toBe('off')
    expect(normalizeReasoningEffort('off', ON_OFF, 'qoder', 'qfmodel')).toBe('off')
  })

  it('已声明的档位原样透传', () => {
    expect(normalizeReasoningEffort('off', ON_OFF, 'qoder', 'qfmodel')).toBe('off')
    expect(normalizeReasoningEffort('on', ON_OFF, 'qoder', 'qfmodel')).toBe('on')
  })

  it('CodeArts 只有 on/off：任何档位都归到这两档，永不抛错', () => {
    // CodeArts 服务端只认顶层 thinking.type（llm-adapter.ts:862-866 实测），
    // 档位阶梯是假的，故这里必须二值化而不是报错。
    for (const requested of ['high', 'low', 'minimal', 'max', 'xhigh']) {
      expect(normalizeReasoningEffort(requested, {}, 'codearts', 'GLM-5.3')).toBe('on')
    }
    // 明确「关掉思考」的两���值才映射到 off。
    expect(normalizeReasoningEffort('none', {}, 'codearts', 'GLM-5.3')).toBe('off')
    expect(normalizeReasoningEffort('off', {}, 'codearts', 'GLM-5.3')).toBe('off')
  })

  it('既无 on 也无 off 可映射、且档位确实不支持时，返回 400 而不是静默丢弃', () => {
    // ⚠️ 与「未声明」区别对待：这里模型**声明了**档位（说明它支持思考控制），
    // 只是没有用户要的那一档 —— 静默丢弃会让用户以为设置生效了。
    const graded = { reasoning: { efforts: [{ id: 'low' }, { id: 'medium' }] } }
    expect(() => normalizeReasoningEffort('high', graded, 'qoder', 'm')).toThrow(OpenAiGatewayError)
  })

  it('未传 reasoning_effort 时不下发该参数', () => {
    expect(normalizeReasoningEffort(undefined, ON_OFF, 'qoder', 'm')).toBeUndefined()
  })
})

describe('OpenAI gateway request conversion', () => {  it('parses a namespaced model route', () => {
    expect(parseModelRoute('qoder/qfmodel')).toEqual({ provider: 'qoder', model: 'qfmodel' })
  })

  it('rejects a model without provider namespace', () => {
    expect(() => parseModelRoute('qfmodel')).toThrow(OpenAiGatewayError)
  })

  it('converts text, assistant tool calls, tool results and tools', async () => {
    const options = await toGenerateOptions({
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
  it('clamps CodeArts output tokens to its verified upstream limit', () => {
    expect(normalizeMaxTokens(128000, 'codearts', 'deepseek-v4-flash')).toBe(65536)
    expect(normalizeMaxTokens(32000, 'codearts', 'deepseek-v4-flash')).toBe(32000)
  })
  it('clamps GLM-5.2 output budget without changing unrelated models', () => {
    expect(normalizeMaxTokens(128000, 'codearts', 'GLM-5.2')).toBe(65536)
    expect(normalizeMaxTokens(32000, 'codearts', 'GLM-5.2')).toBe(32000)
    expect(normalizeMaxTokens(128000, 'qoder', 'qfmodel')).toBe(128000)
  })

  it('maps CodeArts generic levels even when legacy runtime omits reasoning metadata', () => {
    expect(normalizeReasoningEffort('high', undefined, 'codearts', 'deepseek-v4-flash')).toBe('on')
    expect(normalizeReasoningEffort('max', undefined, 'codearts', 'deepseek-v4-flash')).toBe('on')
    expect(normalizeReasoningEffort('none', undefined, 'codearts', 'deepseek-v4-flash')).toBe('off')
  })

  it('rejects forced function tool choice in the first version', async () => {
    await expect(toGenerateOptions({
      model: 'qoder/qfmodel',
      messages: [{ role: 'user', content: 'hello' }],
      tool_choice: { type: 'function', function: { name: 'read' } },
    }, new AbortController().signal)).rejects.toThrow(/tool_choice/i)
  })
})
