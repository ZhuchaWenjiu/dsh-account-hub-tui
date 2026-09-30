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

describe('OpenAI gateway HTTP server', () => {
  const llm = {
    listProviders: () => [{ id: 'qoder', name: 'Qoder' }],
    listModels: async () => [{ provider: 'qoder', id: 'qfmodel', name: 'Qwen Flash' }],
    resolveModelInfo: async () => ({ provider: 'qoder', id: 'qfmodel', name: 'Qwen Flash' }),
    stream: (options: { signal?: AbortSignal }) => responseStream(options.signal),
  }

  it('serves models and chat completions with bearer authentication', async () => {
    const port = await freePort()
    const gateway = createOpenAiGateway({ llm, home: undefined, env: { DSH_OPENAI_GATEWAY_PORT: String(port), DSH_OPENAI_GATEWAY_API_KEY: 'test-key' } })
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

  it('returns streaming SSE and aborts on client cancellation', async () => {
    let aborted = false
    const abortingLlm = {
      ...llm,
      stream: (options: { signal?: AbortSignal }) => {
        options.signal?.addEventListener('abort', () => { aborted = true }, { once: true })
        return responseStream(options.signal)
      },
    }
    const port = await freePort()
    const gateway = createOpenAiGateway({ llm: abortingLlm, env: { DSH_OPENAI_GATEWAY_PORT: String(port), DSH_OPENAI_GATEWAY_API_KEY: 'test-key' } })
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
    expect(aborted).toBe(false)
  })
})
