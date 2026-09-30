import { describe, expect, it, vi } from 'vitest'
import {
  makeClineModalitiesLoader,
  parseClineModalities,
} from '../../src/cline-modalities.js'

/**
 * Cline 输入模态（图片能力）解析的回归。
 *
 * ⚠️ fixture 的形状是**实测**的（2026-09-30 本机直连 models.dev）：
 * `cline-pass` provider 块下 18 条模型，各自带 `modalities.input`。
 * 用户报障「支持图片的模型发送不了图片」的根因就在这份数据没被使用。
 */
const REAL_SHAPE = {
  'cline-pass': {
    id: 'cline-pass',
    models: {
      'deepseek-v4.1-flash': { name: 'DeepSeek V4.1 Flash', modalities: { input: ['text', 'image'] } },
      'mimo-v2.6-flash': { name: 'MiMo-V2.6-Flash', modalities: { input: ['text', 'image', 'audio', 'video'] } },
      'glm-5.3': { name: 'GLM-5.3', modalities: { input: ['text'] } },
      'cline-pass/minimax-m3': { name: 'MiniMax-M3', modalities: { input: ['text', 'image', 'video'] } },
      // 没有 modalities 的条目：必须**不入表**（「没读到」≠「不支持」）
      'mystery-model': { name: 'Mystery' },
      'weird-model': { name: 'Weird', modalities: {} },
    },
  },
}

describe('parseClineModalities', () => {
  it('读出每条模型的图片能力（裸 id 补 cline-pass/ 前缀）', () => {
    const map = parseClineModalities(REAL_SHAPE)
    expect(map.get('cline-pass/deepseek-v4.1-flash')).toBe(true)
    expect(map.get('cline-pass/mimo-v2.6-flash')).toBe(true)
    expect(map.get('cline-pass/glm-5.3')).toBe(false)
  })

  it('已带前缀的 id 原样使用（不重复拼前缀）', () => {
    const map = parseClineModalities(REAL_SHAPE)
    expect(map.get('cline-pass/minimax-m3')).toBe(true)
    expect(map.has('cline-pass/cline-pass/minimax-m3')).toBe(false)
  })

  /** ⚠️ DSH 的模态词表只有 text/image，audio/video/pdf 必须被夹取掉。 */
  it('只认 image：audio/video 不算图片能力', () => {
    const map = parseClineModalities({
      'cline-pass': { models: { 'audio-only': { modalities: { input: ['text', 'audio', 'video', 'pdf'] } } } },
    })
    expect(map.get('cline-pass/audio-only')).toBe(false)
  })

  it('缺 modalities 的条目不入表（不把「没读到」当「不支持」）', () => {
    const map = parseClineModalities(REAL_SHAPE)
    expect(map.has('cline-pass/mystery-model')).toBe(false)
    expect(map.has('cline-pass/weird-model')).toBe(false)
  })

  it('provider 块也能挂在 providers 下（两种实测形态都认）', () => {
    const map = parseClineModalities({
      providers: { 'cline-pass': { models: { 'x-1': { modalities: { input: ['text', 'image'] } } } } },
    })
    expect(map.get('cline-pass/x-1')).toBe(true)
  })

  it('垃圾输入返回空表而不抛错', () => {
    for (const bad of [undefined, null, 'str', 42, [], {}, { 'cline-pass': {} }]) {
      expect(parseClineModalities(bad).size, JSON.stringify(bad)).toBe(0)
    }
  })
})

describe('makeClineModalitiesLoader', () => {
  it('命中 TTL 缓存：多次调用只发一次请求', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(REAL_SHAPE), { status: 200 }))
    const load = makeClineModalitiesLoader({ fetcher: fetcher as never })
    await load()
    await load()
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  /**
   * ⚠️ 失败**必须抛**（而不是返回空表）：调用方据此区分「没读到」与
   * 「读到了且不支持」。把失败记成空表会让所有模型的图片能力打回纯文本 ——
   * 那正是本次要修的缺陷形态。
   */
  it('HTTP 失败向上抛（不缓存失败，下次可重试）', async () => {
    const fetcher = vi.fn(async () => new Response('boom', { status: 500 }))
    const load = makeClineModalitiesLoader({ fetcher: fetcher as never })
    await expect(load()).rejects.toThrow(/HTTP 500/)
    // 再调一次会重试（而非复用失败结果）
    await expect(load()).rejects.toThrow(/HTTP 500/)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
})
