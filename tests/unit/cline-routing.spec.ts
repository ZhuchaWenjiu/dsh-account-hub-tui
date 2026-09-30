import { describe, expect, it } from 'vitest'
import { parseClineRouting } from '../../src/cline-routing.js'

/**
 * 「上游渠道」解析的回归。
 *
 * ⚠️ 这些 fixture 的**形状取自参考实现**（`github.com/codeOct/dsh-cline-pass`
 * 的 `test/smoke.mjs`，其注释说明是照着真实网关响应写的）：
 * planner 管线走 `provider_metadata.gateway.routing.finalProvider`，
 * direct 管线走顶层 `provider`。
 *
 * 用户报障「上游显示的不正确」：原先展示层用的是**模型 id 的 `/` 前缀**
 * （`cline-pass` / `cline-free`，甚至是厂商名），不是 serving channel。
 */
describe('parseClineRouting', () => {
  it('planner 管线：读 message 上的 provider_metadata（参考实现同款样例）', () => {
    expect(parseClineRouting({
      choices: [{
        message: {
          provider_metadata: {
            gateway: {
              routing: {
                finalProvider: 'alibaba',
                canonicalSlug: 'z-ai/glm-5.2',
                fallbacksAvailable: ['baseten'],
                planningReasoning: 'alibaba won tier 0 over baseten',
              },
            },
          },
        },
      }],
    })).toBe('alibaba')
  })

  it('流式帧：读顶层 provider_metadata（路由出现在携带它的那一帧）', () => {
    expect(parseClineRouting({
      provider_metadata: { gateway: { routing: { finalProvider: 'baseten' } } },
    })).toBe('baseten')
  })

  it('direct 管线：读顶层 provider（保留原始大小写）', () => {
    expect(parseClineRouting({ provider: 'GMICloud', choices: [{ message: {} }] })).toBe('GMICloud')
  })

  it('套了一层 data 信封也要认（参考实现的 unwrapEnvelope）', () => {
    expect(parseClineRouting({
      data: { provider: 'GMICloud', choices: [{ message: { content: 'hi' } }] },
    })).toBe('GMICloud')
  })

  /**
   * ⚠️ 本仓库另一处实测（AGENTS.md 的 Gemini-400 段）记的是 **camelCase**
   * `providerMetadata` —— 只认 snake_case 会在那种形态下静默读不到。
   */
  it('camelCase 拼写同样接受（本仓库错误体实测形态）', () => {
    expect(parseClineRouting({
      providerMetadata: { gateway: { routing: { finalProvider: 'vertex' } } },
    })).toBe('vertex')
  })

  it('读不到时返回空串（绝不编造渠道名）', () => {
    for (const frame of [undefined, null, {}, { choices: [] }, 'str', 42, { provider: '' }, { provider: 7 }]) {
      expect(parseClineRouting(frame), JSON.stringify(frame)).toBe('')
    }
  })

  it('空白字符串不算读数（否则会把空渠道写进记录）', () => {
    expect(parseClineRouting({ provider: '   ' })).toBe('')
    expect(parseClineRouting({ provider_metadata: { gateway: { routing: { finalProvider: '  ' } } } })).toBe('')
  })
})
