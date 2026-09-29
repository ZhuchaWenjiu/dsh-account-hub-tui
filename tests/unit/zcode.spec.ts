/**
 * ZCode provider 单元测试。
 *
 * 覆盖**纯函数**与**序列化层**——那些「写错了不会报错、只会静默行为错」
 * 的部分（这正是 AGENTS.md 里 Qoder 三处缺陷的共同形态）。
 */
import { describe, expect, it } from 'vitest'
import { createCipheriv, createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, platform, tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import {
  CREDENTIAL_PREFIX,
  credentialFileCandidates,
  decryptCredentialValue,
  deriveCredentialKey,
  labelFromUserInfo,
  readRawCredentials,
  readZcodeCredential,
} from '../../src/zcode.js'
import {
  validateCaptchaParam,
  findBrowserExecutable,
  ZCODE_CAPTCHA_FALLBACK,
  ALIYUN_CAPTCHA_SDK_URL,
} from '../../src/zcode-captcha.js'
import {
  OFFICIAL_CLI_PREFIX,
  OFFICIAL_IDENTITY_CHARS,
  OFFICIAL_STABLE_SECTIONS,
  buildContextPrefixBlock,
  buildZcodeSystemBlocks,
  formatLocalIsoDate,
  withContextPrefix,
} from '../../src/zcode-identity.js'
import {
  parseFrame,
  parseToolArguments,
  toAnthropicMessages,
  toAnthropicTools,
} from '../../src/zcode-anthropic.js'
import {
  buildZcodeHeaders,
  ZCODE_BILLING_BALANCE_URL,
  ZCODE_PLAN_MESSAGES_URL,
} from '../../src/zcode-upstream.js'
import {
  describeUpstreamError,
  httpErrorCodeForZcode,
} from '../../src/zcode-adapter.js'
import { toClaimOutcome, emptyCheckinStatus } from '../../src/zcode-auth.js'

// ───────────────────────────── 凭据解密 ─────────────────────────────

/** 按官方算法加密一个值（测试用反向实现）。 */
function encrypt(value: string, secret?: string): string {
  const key = secret !== undefined
    ? createHash('sha256').update(secret).digest()
    : deriveCredentialKey({})
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${CREDENTIAL_PREFIX}${iv.toString('base64url')}.${tag.toString('base64url')}.${data.toString('base64url')}`
}

describe('ZCode 凭据解密（AES-256-GCM）', () => {
  it('能解出自己加密的值（往返一致）', () => {
    const plain = 'zcode-jwt-value-测试'
    expect(decryptCredentialValue(encrypt(plain), {})).toBe(plain)
  })

  it('无 enc:v1: 前缀的值原样返回（支持用户手工填明文）', () => {
    expect(decryptCredentialValue('plain-token', {})).toBe('plain-token')
  })

  it('ZCODE_CREDENTIAL_SECRET 覆盖默认密钥', () => {
    const secret = 'my-explicit-secret'
    const cipher = encrypt('payload', secret)
    // 用同一个显式 secret 能解开。
    expect(decryptCredentialValue(cipher, { ZCODE_CREDENTIAL_SECRET: secret })).toBe('payload')
    // 换回默认密钥必须**解不开**（证明 secret 真的参与了派生）。
    expect(() => decryptCredentialValue(cipher, {})).toThrow(/解密失败/)
  })

  it('密钥派生对「用户名取不到」回落字面量 unknown（官方同款）', () => {
    // 默认路径不抛错，且长度是 sha256 的 32 字节。
    const key = deriveCredentialKey({})
    expect(key.length).toBe(32)
    // 显式 secret 走另一条分支：sha256(secret)。
    const explicit = deriveCredentialKey({ ZCODE_CREDENTIAL_SECRET: 'abc' })
    expect(explicit.equals(createHash('sha256').update('abc').digest())).toBe(true)
  })

  it('密文段数不对时抛错（而不是静默返回垃圾）', () => {
    expect(() => decryptCredentialValue(`${CREDENTIAL_PREFIX}only-one-part`, {})).toThrow(/格式非法/)
    expect(() => decryptCredentialValue(`${CREDENTIAL_PREFIX}a..c`, {})).toThrow(/格式非法/)
  })

  it('IV / AuthTag 长度不对时抛错（防篡改检测）', () => {
    // IV 用 8 字节（应为 12）。
    expect(() => decryptCredentialValue(
      `${CREDENTIAL_PREFIX}${Buffer.alloc(8).toString('base64url')}.${Buffer.alloc(16).toString('base64url')}.${Buffer.from('x').toString('base64url')}`,
      {},
    )).toThrow(/IV 长度非法/)
    // AuthTag 用 8 字节（应为 16）。
    expect(() => decryptCredentialValue(
      `${CREDENTIAL_PREFIX}${Buffer.alloc(12).toString('base64url')}.${Buffer.alloc(8).toString('base64url')}.${Buffer.from('x').toString('base64url')}`,
      {},
    )).toThrow(/AuthTag 长度非法/)
  })

  it('密文被篡改时 GCM 认证失败（不是静默解出错误内容）', () => {
    const good = encrypt('original', 'sec')
    const parts = good.slice(CREDENTIAL_PREFIX.length).split('.')
    const tampered = Buffer.from(parts[2] ?? '', 'base64url')
    tampered[0] = (tampered[0] ?? 0) ^ 0xff
    const broken = `${CREDENTIAL_PREFIX}${parts[0]}.${parts[1]}.${tampered.toString('base64url')}`
    expect(() => decryptCredentialValue(broken, { ZCODE_CREDENTIAL_SECRET: 'sec' })).toThrow(/解密失败/)
  })

  it('凭据文件候选表包含家目录（官方默认位置）', () => {
    const candidates = credentialFileCandidates()
    const home = join(homedir(), '.zcode', 'v2', 'credentials.json')
    expect(candidates).toContain(home)
  })

  it('readRawCredentials 对不存在的文件返回 undefined（不抛错）', () => {
    expect(readRawCredentials(join(tmpdir(), 'definitely-not-here-xyz.json'))).toBeUndefined()
  })

  it('readRawCredentials 丢弃非字符串值', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zcode-test-'))
    try {
      const file = join(dir, 'credentials.json')
      writeFileSync(file, JSON.stringify({ a: 'str', b: 123, c: null, d: { x: 1 } }))
      expect(readRawCredentials(file)).toEqual({ a: 'str' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('labelFromUserInfo 对手机号做末 4 位脱敏', () => {
    expect(labelFromUserInfo(JSON.stringify({ phone: '13800138000' }))).toBe('尾号8000')
    expect(labelFromUserInfo(JSON.stringify({ name: 'Alice' }))).toBe('Alice')
    expect(labelFromUserInfo(JSON.stringify({ id: 'abcdef123456' }))).toBe('id:123456')
    expect(labelFromUserInfo(undefined)).toBeUndefined()
    expect(labelFromUserInfo('not-json')).toBeUndefined()
  })

  it('readZcodeCredential 缺 zcodejwttoken 时返回 undefined（不抛错）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zcode-test-'))
    try {
      const file = join(dir, 'credentials.json')
      writeFileSync(file, JSON.stringify({ 'oauth:other': encrypt('x') }))
      expect(readZcodeCredential({}, file)).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ───────────────────────────── captcha ─────────────────────────────

describe('ZCode captcha param 校验', () => {
  /** 造一个合法 param。 */
  const goodParam = (): string => Buffer.from(JSON.stringify({
    certifyId: 'abc123',
    sceneId: '11xygtvd',
    isSign: true,
    securityToken: 'x'.repeat(128),
  })).toString('base64')

  it('合法 param 通过（长度 280 级别、securityToken 128）', () => {
    const param = goodParam()
    expect(param.length).toBeGreaterThanOrEqual(200)
    expect(validateCaptchaParam(param)).toEqual({ ok: true })
  })

  it('★ 降级输出（约 76 字符）被拒绝 —— 这正是「发了必 3007」的形态', () => {
    // 模拟 SDK 降级：短且没有 securityToken。
    const degraded = Buffer.from(JSON.stringify({ certifyId: 'x', securityToken: 'short' })).toString('base64')
    const verdict = validateCaptchaParam(degraded)
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toMatch(/长度/)
  })

  it('长度够但 securityToken 过短 → 拒绝', () => {
    const param = Buffer.from(JSON.stringify({
      certifyId: 'abc',
      securityToken: 'y'.repeat(20),
      padding: 'z'.repeat(250),
    })).toString('base64')
    const verdict = validateCaptchaParam(param)
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toMatch(/securityToken/)
  })

  it('缺 certifyId → 拒绝', () => {
    const param = Buffer.from(JSON.stringify({
      securityToken: 'x'.repeat(128),
      padding: 'z'.repeat(250),
    })).toString('base64')
    expect(validateCaptchaParam(param).ok).toBe(false)
  })

  it('非 base64/非 JSON → 拒绝（不抛错）', () => {
    expect(validateCaptchaParam(undefined).ok).toBe(false)
    expect(validateCaptchaParam('').ok).toBe(false)
    expect(validateCaptchaParam('!'.repeat(300)).ok).toBe(false)
  })

  it('兜底配置与 SDK 地址是实测值', () => {
    expect(ZCODE_CAPTCHA_FALLBACK).toEqual({ region: 'cn', prefix: 'no8xfe', sceneId: '11xygtvd' })
    expect(ALIYUN_CAPTCHA_SDK_URL).toBe(
      'https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js',
    )
  })

  it('findBrowserExecutable 在给了 ZCODE_CHROME_PATH 且文件存在时优先用它', () => {
    // 用 Node 可执行文件当替身（它一定存在）。
    const previous = process.env.ZCODE_CHROME_PATH
    process.env.ZCODE_CHROME_PATH = process.execPath
    try {
      expect(findBrowserExecutable()).toBe(process.execPath)
    } finally {
      if (previous === undefined) delete process.env.ZCODE_CHROME_PATH
      else process.env.ZCODE_CHROME_PATH = previous
    }
  })
})

// ───────────────────────────── 身份块 ─────────────────────────────

describe('ZCode 官方身份块（3012 准入）', () => {
  it('cliPrefix 是官方那 42 字符', () => {
    expect(OFFICIAL_CLI_PREFIX).toBe('You are ZCode, an interactive coding agent')
    expect(OFFICIAL_CLI_PREFIX.length).toBe(42)
  })

  it('★ 身份块总长度与实测通过的量级一致（2355 级别）', () => {
    // 实测矩阵里「cliPrefix + stable」是准入必需的最小集合。
    // 此处断言的是**同一量级**（防止有人误删段落导致退回 3012）。
    expect(OFFICIAL_IDENTITY_CHARS).toBeGreaterThan(2300)
    expect(OFFICIAL_IDENTITY_CHARS).toBeLessThan(3000)
    expect(OFFICIAL_STABLE_SECTIONS.length).toBeGreaterThanOrEqual(2)
  })

  it('system 块第一块必须是 cliPrefix（顺序是准入判据的一部分）', () => {
    const blocks = buildZcodeSystemBlocks('caller prompt', { cwd: process.cwd() })
    expect(blocks[0]?.text).toBe(OFFICIAL_CLI_PREFIX)
    expect(blocks[1]?.text).toBe(OFFICIAL_STABLE_SECTIONS.join('\n\n'))
  })

  it('调用方 system 追加在**最后**（身份块必须在开头）', () => {
    const blocks = buildZcodeSystemBlocks('MY-CALLER-PROMPT', { cwd: process.cwd() })
    expect(blocks[blocks.length - 1]?.text).toBe('MY-CALLER-PROMPT')
    expect(blocks.length).toBe(4) // cliPrefix + stable + env + caller
  })

  it('空/缺失的调用方 system 不产生空块', () => {
    expect(buildZcodeSystemBlocks(undefined, { cwd: '.' })).toHaveLength(3)
    expect(buildZcodeSystemBlocks('', { cwd: '.' })).toHaveLength(3)
    expect(buildZcodeSystemBlocks('   ', { cwd: '.' })).toHaveLength(3)
  })

  /**
   * ★ 断点策略（2026-09-30 调整，此前是「每块都打」）。
   *
   * ## 为什么改
   *
   * Anthropic 的 prompt caching 是**前缀式**的：一个断点覆盖「它之前的全部内容」，
   * 故**一个位于最后一块的断点**与「每块各打一个」覆盖面相同。
   * 而断点有**数量上限（4 个）**：每块都打（3-4 块）会把预算用光，
   * 于是 `tools` 再也打不了点 —— 而 DSH 每步带 24 个工具、约 19KB schema
   *（`dsh-free-glm` 的 P0-2 实测）。
   *
   * ⇒ 收敛成「只最后一块」，预算留给 `withToolCacheBreakpoint()`。
   *
   * 反向验证：改回「每块都打」⇒ 本条变红；同时断点总数会到 4-5 个，
   * 撞上「最多 4 个」的上限。
   */
  it('★ 只在最后一块打 cache_control（断点预算留给 tools）', () => {
    const blocks = buildZcodeSystemBlocks('x', { cwd: '.' })
    expect(blocks[blocks.length - 1]?.cache_control?.type).toBe('ephemeral')
    // 前面的块不再单独打点 —— 前缀式语义下它们的覆盖面已被最后那个包含。
    expect(blocks.slice(0, -1).every((b) => b.cache_control === undefined)).toBe(true)
  })

  it('★ system + tools 的断点总数不得超过 Anthropic 的上限（4）', () => {
    const blocks = buildZcodeSystemBlocks('x', { cwd: '.' })
    const systemBreakpoints = blocks.filter((b) => b.cache_control?.type === 'ephemeral').length
    // tools 侧固定 1 个（`withToolCacheBreakpoint` 只给最后一个工具打点）。
    const toolBreakpoints = 1
    expect(systemBreakpoints + toolBreakpoints).toBeLessThanOrEqual(4)
  })

  it('有调用方 system 时断点落在**它**身上（那段最大、最值得缓存）', () => {
    const blocks = buildZcodeSystemBlocks('MY-CALLER-PROMPT', { cwd: '.' })
    expect(blocks[blocks.length - 1]?.text).toBe('MY-CALLER-PROMPT')
    expect(blocks[blocks.length - 1]?.cache_control?.type).toBe('ephemeral')
  })

  it('environment 段含工作目录与平台（缺了会让模型用相对路径瞎猜）', () => {
    const blocks = buildZcodeSystemBlocks(undefined, { cwd: 'D:\\proj', model: 'glm-5.3-flash' })
    const env = blocks[2]?.text ?? ''
    expect(env).toContain('D:\\proj')
    expect(env).toContain('Primary working directory')
    expect(env).toContain('zcode/glm-5.3-flash')
  })

  it('日期块用本地时区（不是 UTC）且带 6 空格缩进的 outro', () => {
    const block = buildContextPrefixBlock(new Date(2026, 8, 29, 23, 30))
    expect(block.text).toContain('Today\'s date is 2026-09-29.')
    expect(block.text).toContain('      IMPORTANT:')
    expect(block.text.startsWith('<system-reminder>')).toBe(true)
    expect(block.text.endsWith('</system-reminder>')).toBe(true)
  })

  it('formatLocalIsoDate 补零且用本地字段', () => {
    expect(formatLocalIsoDate(new Date(2026, 0, 5))).toBe('2026-01-05')
  })

  it('★ 首轮 user 消息被插入日期块（块数组形态，不是拼字符串）', () => {
    const out = withContextPrefix([{ role: 'user', content: 'hello' }], new Date(2026, 8, 29))
    const content = out[0]?.content
    expect(Array.isArray(content)).toBe(true)
    const arr = content as Array<{ type: string; text: string }>
    expect(arr[0]?.text).toContain('<system-reminder>')
    expect(arr[1]).toEqual({ type: 'text', text: 'hello' })
  })

  it('已经是数组的消息把日期块插在最前面', () => {
    const out = withContextPrefix(
      [{ role: 'user', content: [{ type: 'text', text: 'existing' }] }],
      new Date(2026, 8, 29),
    )
    const arr = out[0]?.content as Array<{ text?: string }>
    expect(arr[0]?.text).toContain('<system-reminder>')
    expect(arr[1]?.text).toBe('existing')
  })

  it('★ 幂等：已以 system-reminder 开头则不重复插', () => {
    const first = withContextPrefix([{ role: 'user', content: 'hi' }], new Date(2026, 8, 29))
    const second = withContextPrefix(
      first as Array<{ role: string; content: unknown }>,
      new Date(2026, 8, 29),
    )
    const arr = second[0]?.content as unknown[]
    expect(arr).toHaveLength(2) // 仍然是「日期块 + 原文」，没有变成 3 项
  })

  it('首轮不是 user 时不插（官方行为）', () => {
    const out = withContextPrefix([{ role: 'assistant', content: 'hi' }], new Date(2026, 8, 29))
    expect(out[0]?.content).toBe('hi')
  })

  it('空消息列表不抛错', () => {
    expect(withContextPrefix([])).toEqual([])
  })
})

// ───────────────────── Anthropic 协议转换 ─────────────────────

describe('ZCode Anthropic 协议转换', () => {
  it('assistant 的 tool_calls 转成 tool_use，且 arguments 字符串转**对象**', () => {
    const out = toAnthropicMessages([{
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: 'call_1',
        type: 'function',
        function: { name: 'read', arguments: '{"path":"a.txt"}' },
      }],
    }])
    expect(out).toHaveLength(1)
    const content = out[0]?.content as Array<Record<string, unknown>>
    expect(content[0]).toMatchObject({ type: 'tool_use', id: 'call_1', name: 'read' })
    // ⚠ 关键：必须是**对象**，不是 JSON 字符串（Anthropic 规范）。
    expect(content[0]?.input).toEqual({ path: 'a.txt' })
  })

  it('★ role:tool 转成 user 里的 tool_result 块（不是独立的 tool 角色）', () => {
    const out = toAnthropicMessages([
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', function: { name: 'f', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'result-text' },
    ])
    const last = out[out.length - 1]
    expect(last?.role).toBe('user')
    const content = last?.content as Array<Record<string, unknown>>
    expect(content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'c1', content: 'result-text' })
  })

  it('孤儿 tool 结果（无 tool_call_id）被丢弃 —— 否则 Anthropic 会 400', () => {
    const out = toAnthropicMessages([{ role: 'tool', content: 'orphan' }])
    expect(out).toHaveLength(0)
  })

  it('空 assistant 消息被丢弃（会让上游 400）', () => {
    expect(toAnthropicMessages([{ role: 'assistant', content: '' }])).toHaveLength(0)
  })

  it('多模态 user 消息的 image 块转成 Anthropic base64 形态', () => {
    const dataUrl = `data:image/png;base64,${Buffer.from('fake').toString('base64')}`
    const out = toAnthropicMessages([{
      role: 'user',
      content: [
        { type: 'text', text: 'look' },
        { type: 'image_url', image_url: { url: dataUrl } },
      ],
    }])
    const content = out[0]?.content as Array<Record<string, unknown>>
    expect(content[0]).toEqual({ type: 'text', text: 'look' })
    expect(content[1]).toMatchObject({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png' },
    })
  })

  it('工具表转成**扁平** input_schema（不是 OpenAI 的嵌套 function）', () => {
    const tools = toAnthropicTools([{
      name: 'read',
      description: 'Read a file',
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
    }])
    expect(tools[0]).toEqual({
      name: 'read',
      description: 'Read a file',
      input_schema: { type: 'object', properties: { path: { type: 'string' } } },
    })
    // ⚠ 绝不能有 OpenAI 的 `function` 包装。
    expect(tools[0]).not.toHaveProperty('function')
  })

  it('无 parameters 的工具给空 object schema（不产生 undefined）', () => {
    const tools = toAnthropicTools([{ name: 'ping', description: '' }])
    expect(tools[0]?.input_schema).toEqual({ type: 'object', properties: {} })
    expect(tools[0]).not.toHaveProperty('description')
  })

  it('parseToolArguments 对残缺 JSON 返回哨兵（不静默补 {}）', () => {
    const parsed = parseToolArguments('{"broken":') as Record<string, unknown>
    // ⚠ 不能是 `{}` —— 那会被当成「无参数调用」并可能触发破坏性动作。
    expect(parsed).not.toEqual({})
    expect(parsed.__zcodeUnparsableArguments).toBeDefined()
  })

  it('parseToolArguments 对完全空的参数给 {}（工具确实可以无参数）', () => {
    expect(parseToolArguments('')).toEqual({})
    expect(parseToolArguments(undefined)).toEqual({})
    expect(parseToolArguments('{}')).toEqual({})
  })

  it('parseFrame 解析 event + data 行', () => {
    const frame = parseFrame('event: content_block_delta\ndata: {"type":"content_block_delta"}')
    expect(frame?.event).toBe('content_block_delta')
    expect(frame?.data).toBe('{"type":"content_block_delta"}')
  })

  it('parseFrame 支持多行 data（SSE 规范允许）', () => {
    const frame = parseFrame('data: line1\ndata: line2')
    expect(frame?.data).toBe('line1\nline2')
  })

  it('parseFrame 对空帧返回 undefined', () => {
    expect(parseFrame('')).toBeUndefined()
    expect(parseFrame(': comment only')).toBeUndefined()
  })
})

// ───────────────────────── 上游请求头与错误 ─────────────────────────

describe('ZCode 请求头与错误映射', () => {
  const credential = {
    zcode_jwt: 'jwt-value',
    device_mid: 'device-1234',
    app_version: '3.14.3',
  }

  it('★ 必须带 X-Device-Mid（缺它上游回 400 code 3001）', () => {
    const headers = buildZcodeHeaders(credential)
    expect(headers['X-Device-Mid']).toBe('device-1234')
  })

  it('Authorization 只在显式要求时出现（balance 需要、preview 不需要）', () => {
    expect(buildZcodeHeaders(credential)).not.toHaveProperty('Authorization')
    expect(buildZcodeHeaders(credential, { authorization: 'Bearer x' })).toHaveProperty('Authorization', 'Bearer x')
  })

  it('captcha 头成对出现（param + region）', () => {
    const headers = buildZcodeHeaders(credential, { captcha: { param: 'P', region: 'cn' } })
    expect(headers['x-aliyun-captcha-verify-param']).toBe('P')
    expect(headers['x-aliyun-captcha-verify-region']).toBe('cn')
  })

  it('JSON 头默认带，可用 json:false 关掉', () => {
    expect(buildZcodeHeaders(credential)['Content-Type']).toBe('application/json')
    expect(buildZcodeHeaders(credential, { json: false })).not.toHaveProperty('Content-Type')
  })

  it('端点常量是实测值', () => {
    expect(ZCODE_PLAN_MESSAGES_URL).toBe(
      'https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages',
    )
    expect(ZCODE_BILLING_BALANCE_URL).toBe(
      'https://zcode.z.ai/api/v1/zcode-plan/billing/balance',
    )
  })

  it('★ 3007（captcha）映射到 RATE_LIMIT —— **可重试**，换个 param 就能过', () => {
    expect(httpErrorCodeForZcode(400, '{"code":3007,"msg":"captcha verify failed"}')).toBe('RATE_LIMIT')
  })

  it('★ 3012（风控）映射到 PERMISSION —— **不可重试**（有账号冷却惩罚）', () => {
    const code = httpErrorCodeForZcode(405, '{"code":3012,"msg":"request has been blocked"}')
    expect(code).toBe('PERMISSION')
    // 断言它**不在** harness 的可重试集合里。
    expect(['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT']).not.toContain(code)
  })

  it('★ 1113（余额不足）映射到 QUOTA_EXCEEDED —— 不可重试', () => {
    expect(httpErrorCodeForZcode(429, '{"code":"1113"}')).toBe('QUOTA_EXCEEDED')
    expect(httpErrorCodeForZcode(429, '余额不足或无可用资源包')).toBe('QUOTA_EXCEEDED')
  })

  it('401 / 1002 映射到 AUTH', () => {
    expect(httpErrorCodeForZcode(401, '')).toBe('AUTH')
    expect(httpErrorCodeForZcode(400, '{"type":"1002"}')).toBe('AUTH')
  })

  it('describeUpstreamError 对 3012 给出「勿重试」的警告文案', () => {
    const text = describeUpstreamError(405, '{"code":3012,"msg":"blocked"}')
    expect(text).toContain('3012')
    expect(text).toMatch(/冷却|勿连续重试|请勿/)
  })

  it('describeUpstreamError 对 3007 给出「请重试」的可操作提示', () => {
    expect(describeUpstreamError(400, '{"code":3007}')).toMatch(/captcha.*失败/)
  })

  it('describeUpstreamError 对非 JSON 响应体不抛错', () => {
    expect(describeUpstreamError(500, '<html>oops</html>')).toContain('500')
  })
})

// ───────────────────────────── 签到映射 ─────────────────────────────

describe('ZCode 签到结果映射', () => {
  it('★ 1003（已领取）视为**成功**（幂等，不是错误）', () => {
    const outcome = toClaimOutcome(
      { planId: 'p1', ok: true, alreadyClaimed: true, code: 1003 },
      'p1',
    )
    expect(outcome.kind).toBe('already-claimed')
  })

  it('code:0 是成功领取', () => {
    const outcome = toClaimOutcome({ planId: 'p1', ok: true, code: 0 }, 'p1')
    expect(outcome.kind).toBe('claimed')
  })

  it('3007 给出可操作提示（不是裸码）', () => {
    const outcome = toClaimOutcome({ planId: 'p1', ok: false, code: 3007 }, 'p1')
    expect(outcome.kind).toBe('failed')
    if (outcome.kind === 'failed') {
      expect(outcome.code).toBe(3007)
      expect(outcome.message).toMatch(/captcha/)
    }
  })

  it('无业务码的 HTTP 失败用 -1 占位（code 是必填字段）', () => {
    const outcome = toClaimOutcome({ planId: 'p1', ok: false, httpStatus: 503 }, 'p1')
    expect(outcome.kind).toBe('failed')
    if (outcome.kind === 'failed') expect(outcome.code).toBe(-1)
  })

  it('emptyCheckinStatus 满足契约（字段全给）', () => {
    const status = emptyCheckinStatus(false, true)
    expect(status.active).toBe(false)
    expect(status.actionRequired).toBe(true)
    expect(status.todayCheckedIn).toBe(false)
    expect(Array.isArray(status.checkinDates)).toBe(true)
  })
})
