import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveGatewayConfig } from '../../src/openai-gateway/config.js'
import { loadOrCreateApiKey } from '../../src/openai-gateway/auth.js'

describe('OpenAI gateway config', () => {
  it('uses localhost and port 8326 by default', () => {
    expect(resolveGatewayConfig({})).toEqual({ host: '127.0.0.1', port: 8326 })
  })

  it('accepts a valid port override', () => {
    expect(resolveGatewayConfig({ DSH_OPENAI_GATEWAY_PORT: '9382' }).port).toBe(9382)
  })

  it('rejects an invalid port override', () => {
    expect(() => resolveGatewayConfig({ DSH_OPENAI_GATEWAY_PORT: '0' })).toThrow(/port/i)
  })

  it('prefers the environment API key', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-gateway-auth-'))
    expect(loadOrCreateApiKey(home, { DSH_OPENAI_GATEWAY_API_KEY: 'env-secret' })).toBe('env-secret')
  })

  it('generates and persists a key when the environment is empty', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-gateway-auth-'))
    const first = loadOrCreateApiKey(home, {})
    const second = loadOrCreateApiKey(home, {})
    expect(first).toHaveLength(43)
    expect(second).toBe(first)
    expect(readFileSync(join(home, 'openai-gateway', 'api-key'), 'utf8')).toBe(first)
  })
})
