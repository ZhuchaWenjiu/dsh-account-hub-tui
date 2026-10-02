import { request, createServer } from 'node:http'
import { describe, expect, it } from 'vitest'
import { createOpenAiGateway } from '../../src/openai-gateway/server.js'

async function freePort(): Promise<number> {
  const server = createServer()
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

function call(port: number, path: string, options: { method?: string; body?: unknown; key?: string } = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1', port, path, method: options.method ?? 'GET',
      headers: {
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(options.key === undefined ? {} : { authorization: `Bearer ${options.key}` }),
      },
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', chunk => chunks.push(Buffer.from(chunk)))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    if (options.body !== undefined) req.end(JSON.stringify(options.body))
    else req.end()
  })
}

async function* responseStream(signal?: AbortSignal) {
  if (signal?.aborted) return
  yield { type: 'text-delta' as const, index: 0, text: 'hello' }
  yield { type: 'finish' as const, reason: { kind: 'stop' as const } }
}

/** 吐一帧就挂住，直到 DSH 侧收到 abort 才收尾——用来观察取消是否真的传到底层。 */
async function* hangingStream(signal?: AbortSignal) {
  yield { type: 'text-delta' as const, index: 0, text: 'first' }
  await new Promise<void>((resolve) => {
    if (signal?.aborted) { resolve(); return }
    signal?.addEventListener('abort', () => resolve(), { once: true })
  })
  yield { type: 'finish' as const, reason: { kind: 'aborted' as const } }
}

const ENV = (port: number) => ({ DSH_OPENAI_GATEWAY_PORT: String(port), DSH_OPENAI_GATEWAY_API_KEY: 'test-key' })

/** 正常工作的 runtime 替身；各用例在其上覆盖个别方法。 */
const llm = {
  listProviders: () => [{ id: 'qoder', name: 'Qoder' }],
  listModels: async () => [{ provider: 'qoder', id: 'qfmodel', name: 'Qwen Flash' }],
  resolveModelInfo: async () => ({ provider: 'qoder', id: 'qfmodel', name: 'Qwen Flash' }),
  stream: (options: { signal?: AbortSignal }) => responseStream(options.signal),
}

describe('OpenAI gateway HTTP server', () => {

  it('serves models and chat completions with bearer authentication', async () => {
    const port = await freePort()
    const gateway = createOpenAiGateway({ llm, home: undefined, env: ENV(port) })
    await gateway.start()
    try {
      expect((await call(port, '/v1/models')).status).toBe(401)
      const models = await call(port, '/v1/models', { key: 'test-key' })
      expect(models.status).toBe(200)
      expect(JSON.parse(models.body).data[0].id).toBe('qoder/qfmodel')

      const response = await call(port, '/v1/chat/completions', {
        method: 'POST', key: 'test-key', body: {
          model: 'qoder/qfmodel', messages: [{ role: 'user', content: 'hello' }], stream: false,
        },
      })
      expect(response.status).toBe(200)
      expect(JSON.parse(response.body).choices[0].message.content).toBe('hello')
    } finally {
      await gateway.close()
    }
  })

  it('passes a safe GLM-5.2 output budget to the DSH runtime', async () => {
    const port = await freePort()
    let actualMaxTokens: number | undefined
    const captureLlm = {
      ...llm,
      resolveModelInfo: async () => ({ provider: 'codearts', id: 'GLM-5.2', name: 'GLM-5.2' }),
      stream: (options: { maxTokens?: number; signal?: AbortSignal }) => {
        actualMaxTokens = options.maxTokens
        return responseStream(options.signal)
      },
    }
    const gateway = createOpenAiGateway({ llm: captureLlm, env: ENV(port) })
    await gateway.start()
    try {
      const result = await call(port, '/v1/chat/completions', {
        method: 'POST', key: 'test-key', body: {
          model: 'codearts/GLM-5.2', messages: [{ role: 'user', content: 'hello' }],
          max_tokens: 128000, reasoning_effort: 'high', stream: false,
        },
      })
      expect(result.status).toBe(200)
      expect(actualMaxTokens).toBe(65536)
    } finally {
      await gateway.close()
    }
  })

  it('returns streaming SSE and completes without aborting a healthy request', async () => {
    let aborted = false
    const abortingLlm = {
      ...llm,
      stream: (options: { signal?: AbortSignal }) => {
        options.signal?.addEventListener('abort', () => { aborted = true }, { once: true })
        return responseStream(options.signal)
      },
    }
    const port = await freePort()
    const gateway = createOpenAiGateway({ llm: abortingLlm, env: ENV(port) })
    await gateway.start()
    try {
      const response = await call(port, '/v1/chat/completions', {
        method: 'POST', key: 'test-key', body: {
          model: 'qoder/qfmodel', messages: [{ role: 'user', content: 'hello' }], stream: true,
        },
      })
      expect(response.status).toBe(200)
      expect(response.body).toContain('data: [DONE]')
    } finally {
      await gateway.close()
    }
    // 正常收尾**不应**触发 abort——这条锁的是「别把正常请求误判成取消」。
    expect(aborted).toBe(false)
  })

  // ⚠️ 上一条曾被命名为 `aborts on client cancellation`，但它只断言「不 abort」，
  // 与名字相反，等于设计文档验收 9（客户端断开后 DSH 收到 abort）**从未被验证**。
  // 下面这条才是真的断开客户端，并等待 abort 传到 DSH 请求。
  it('aborts the DSH request when the client disconnects mid-stream', async () => {
    // 用「事件 promise + 兜底超时」而不是轮询等待：慢机器上轮询会 flake，
    // 而这里真正要断言的是「abort 事件到达」，直接等事件最贴合语义。
    let markAborted: (() => void) | undefined
    const abortReached = new Promise<void>((resolve) => { markAborted = resolve })
    const hangingLlm = {
      ...llm,
      stream: (options: { signal?: AbortSignal }) => {
        options.signal?.addEventListener('abort', () => { markAborted?.() }, { once: true })
        return hangingStream(options.signal)
      },
    }
    const port = await freePort()
    const gateway = createOpenAiGateway({ llm: hangingLlm, env: ENV(port) })
    await gateway.start()
    try {
      await new Promise<void>((resolve) => {
        const req = request({
          host: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer test-key' },
        }, (res) => {
          res.once('data', () => { req.destroy(); resolve() })
        })
        req.on('error', () => resolve())
        req.end(JSON.stringify({
          model: 'qoder/qfmodel', messages: [{ role: 'user', content: 'hello' }], stream: true,
        }))
      })
      const arrived = await Promise.race([
        abortReached.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5000)),
      ])
      expect(arrived).toBe(true)
    } finally {
      await gateway.close()
    }
  })

  it('keeps serving /v1/models when a single provider directory fails', async () => {
    const flakyLlm = {
      ...llm,
      listProviders: () => [{ id: 'qoder' }, { id: 'broken' }],
      listModels: async (provider: string) => {
        if (provider === 'broken') throw new Error('no credentials for broken')
        return [{ provider: 'qoder', id: 'qfmodel', name: 'Qwen Flash' }]
      },
    }
    const port = await freePort()
    const gateway = createOpenAiGateway({ llm: flakyLlm, env: ENV(port) })
    await gateway.start()
    try {
      const response = await call(port, '/v1/models', { key: 'test-key' })
      expect(response.status).toBe(200)
      const ids = JSON.parse(response.body).data.map((m: { id: string }) => m.id)
      expect(ids).toContain('qoder/qfmodel')
      expect(ids.some((id: string) => id.startsWith('broken/'))).toBe(false)
    } finally {
      await gateway.close()
    }
  })

  it('returns 404 (not 502) when the model cannot be resolved', async () => {
    const badResolveLlm = {
      ...llm,
      resolveModelInfo: async () => { throw new Error('unknown provider or model') },
    }
    const port = await freePort()
    const gateway = createOpenAiGateway({ llm: badResolveLlm, env: ENV(port) })
    await gateway.start()
    try {
      const response = await call(port, '/v1/chat/completions', {
        method: 'POST', key: 'test-key', body: {
          model: 'nosuch/nosuch', messages: [{ role: 'user', content: 'hello' }], stream: false,
        },
      })
      expect(response.status).toBe(404)
      expect(JSON.parse(response.body).error.type).toBe('invalid_request_error')
    } finally {
      await gateway.close()
    }
  })
})

/**
 * 上游「模型不存在」的错误翻译与纠错建议。
 *
 * 背景（实测）：`codearts/GLM-5.3` 会被上游拒绝，而真实 ID 是
 * `codearts/glm-5.3-flash`。此前这条错误以 **502** 离开网关 —— 客户端会把它
 * 当可重试故障白耗额度，且错误里没有任何线索能让人猜到正确拼写。
 *
 * ⚠️ 是「翻成 404」而不是「请求前拦截」：`design.md:76` 要求显式请求仍交给
 * DSH 路由处理（有些 provider 支持目录外的模型），预检会把合法请求一起挡掉。
 */
describe('模型不存在：状态码翻译与纠错建议', () => {
  const CATALOG = {
    listProviders: () => [{ id: 'codearts' }],
    listModels: async () => [
      { id: 'glm-5.3-flash', name: 'GLM-5.3 Flash' },
      { id: 'GLM-5.2', name: 'GLM-5.2' },
    ],
  }

  /** 模拟上游在流里返回「模型未注册」。 */
  function rejectingLlm() {
    return {
      ...llm,
      ...CATALOG,
      stream: () => (async function* () {
        yield {
          type: 'finish' as const,
          reason: {
            kind: 'error' as const,
            failure: {
              code: 'INVALID_REQUEST',
              message: 'codearts: The model is not registered, please request other model',
            },
          },
        }
      })(),
    }
  }

  it('非流式：翻成 404 + invalid_request，而不是会被重试的 502', async () => {
    const port = await freePort()
    const gateway = createOpenAiGateway({ llm: rejectingLlm(), env: ENV(port) })
    await gateway.start()
    try {
      const response = await call(port, '/v1/chat/completions', {
        method: 'POST', key: 'test-key', body: {
          model: 'codearts/totally-wrong', messages: [{ role: 'user', content: 'hi' }], stream: false,
        },
      })
      expect(response.status).toBe(404)
      const error = JSON.parse(response.body).error
      expect(error.type).toBe('invalid_request_error')
      expect(error.code).toBe('model_not_found')
    } finally {
      await gateway.close()
    }
  })

  it('非流式：大小写/少后缀打错时给出正确拼写', async () => {
    const port = await freePort()
    const gateway = createOpenAiGateway({ llm: rejectingLlm(), env: ENV(port) })
    await gateway.start()
    try {
      const response = await call(port, '/v1/chat/completions', {
        method: 'POST', key: 'test-key', body: {
          // 实测的真实误填：大小写不同 + 少了一截后缀
          model: 'codearts/GLM-5.3', messages: [{ role: 'user', content: 'hi' }], stream: false,
        },
      })
      expect(response.status).toBe(404)
      expect(JSON.parse(response.body).error.message).toContain('你是不是想用 codearts/glm-5.3-flash')
    } finally {
      await gateway.close()
    }
  })

  it('流式：错误帧里同样带正确 code 与建议（流已发 200，状态码改不了）', async () => {
    const port = await freePort()
    const gateway = createOpenAiGateway({ llm: rejectingLlm(), env: ENV(port) })
    await gateway.start()
    try {
      const response = await call(port, '/v1/chat/completions', {
        method: 'POST', key: 'test-key', body: {
          model: 'codearts/GLM-5.3', messages: [{ role: 'user', content: 'hi' }], stream: true,
        },
      })
      expect(response.status).toBe(200)
      const frame = response.body.split('\n').find(line => line.startsWith('data: {'))
      const error = JSON.parse(frame!.slice(6)).error
      expect(error.code).toBe('model_not_found')
      expect(error.status).toBe(404)
      expect(error.message).toContain('你是不是想用 codearts/glm-5.3-flash')
    } finally {
      await gateway.close()
    }
  })

  it('⚠️ 目录里没有相近项时不给建议（不硬凑一个误导答案）', async () => {
    const port = await freePort()
    const gateway = createOpenAiGateway({ llm: rejectingLlm(), env: ENV(port) })
    await gateway.start()
    try {
      const response = await call(port, '/v1/chat/completions', {
        method: 'POST', key: 'test-key', body: {
          model: 'codearts/完全不相干的模型', messages: [{ role: 'user', content: 'hi' }], stream: false,
        },
      })
      expect(response.status).toBe(404)
      expect(JSON.parse(response.body).error.message).not.toContain('你是不是想用')
    } finally {
      await gateway.close()
    }
  })

  it('⚠️ 其它上游错误不受影响（不得被误翻译成 404）', async () => {
    const otherLlm = {
      ...llm,
      stream: () => (async function* () {
        yield {
          type: 'finish' as const,
          reason: { kind: 'error' as const, failure: { code: 'SERVER', message: 'upstream exploded' } },
        }
      })(),
    }
    const port = await freePort()
    const gateway = createOpenAiGateway({ llm: otherLlm, env: ENV(port) })
    await gateway.start()
    try {
      const response = await call(port, '/v1/chat/completions', {
        method: 'POST', key: 'test-key', body: {
          model: 'qoder/qfmodel', messages: [{ role: 'user', content: 'hi' }], stream: false,
        },
      })
      // 仍应是 502（可重试的故障），没有被误伤成 404。
      expect(response.status).toBe(502)
    } finally {
      await gateway.close()
    }
  })
})
