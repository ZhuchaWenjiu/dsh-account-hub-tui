import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  copyToClipboard,
  formatModelIdList,
  gatewayApiKeyHint,
  gatewayButtonLabel,
  gatewayButtonTitle,
  gatewayEndpoint,
  gatewayModelsCurl,
  gatewayModelsHint,
  gatewayStatusLines,
  gatewaySwitchDisabled,
  gatewayToggleNotice,
  modelCapabilityBadge,
  modelSupportsImage,
} from '../../plugin-src/client/openai-gateway-panel.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(resolve(HERE, '../../plugin-src/client/jet-hub.js'), 'utf8')

const RUNNING = { enabled: true, running: true, blockedByEnv: false, address: { host: '127.0.0.1', port: 8326 } }
const OFF = { enabled: false, running: false, blockedByEnv: false, address: null }
const ENV_BLOCKED = { enabled: true, running: false, blockedByEnv: true, address: null }
const WANTED_BUT_DOWN = { enabled: true, running: false, blockedByEnv: false, address: null }

describe('本机网关面板的文案与判定', () => {
  it('按钮文字足够短，且运行中带运行态提示', () => {
    expect(gatewayButtonLabel(RUNNING)).toBe('网关 ●')
    expect(gatewayButtonLabel(OFF)).toBe('网关')
    // 页头按钮排成一行，文字过长会把右端「关闭」挤到第二行。
    expect(gatewayButtonLabel(RUNNING).length).toBeLessThanOrEqual(4)
  })

  it('状态未读取时按钮退化为「网关」而不是空白', () => {
    expect(gatewayButtonLabel(null)).toBe('网关')
    expect(gatewayButtonTitle(null)).toContain('读取状态中')
    expect(gatewayStatusLines(null)).toEqual(['正在读取网关状态…'])
  })

  it('地址只在真监听时给出，且端口取自宿主侧而非写死 8326', () => {
    const custom = { ...RUNNING, address: { host: '127.0.0.1', port: 9999 } }
    expect(gatewayEndpoint(custom)).toBe('http://127.0.0.1:9999/v1')
    // ⚠️ 端口可被 DSH_OPENAI_GATEWAY_PORT 改过；address 为空时编造 8326 会让
    // 用户拿一个连不上的地址去配客户端。
    expect(gatewayEndpoint(OFF)).toBe('')
    expect(gatewayEndpoint(WANTED_BUT_DOWN)).toBe('')
    expect(gatewayEndpoint(null)).toBe('')
  })

  it('「已选择开启但没监听」必须与「运行中」说不同的话', () => {
    // 这两种状态在 UI 上都表现为 enabled=true，只靠 enabled 推导会显示
    // 「已开启」而用户连不上。
    expect(gatewayStatusLines(RUNNING).join()).toContain('正在运行')
    expect(gatewayStatusLines(WANTED_BUT_DOWN).join()).toContain('没有在监听')
    expect(gatewayStatusLines(WANTED_BUT_DOWN).join()).toContain('端口')
  })

  it('被 env 停用时开关禁用，且明确指出原因与 env 名', () => {
    expect(gatewaySwitchDisabled(ENV_BLOCKED)).toBe(true)
    expect(gatewaySwitchDisabled(RUNNING)).toBe(false)
    expect(gatewaySwitchDisabled(OFF)).toBe(false)
    expect(gatewayButtonTitle(ENV_BLOCKED)).toContain('DSH_OPENAI_GATEWAY_ENABLED')
    expect(gatewayStatusLines(ENV_BLOCKED).join()).toContain('DSH_OPENAI_GATEWAY_ENABLED')
  })

  it('状态未读取时开关禁用，避免用户对着未知状态做操作', () => {
    expect(gatewaySwitchDisabled(null)).toBe(true)
  })

  it('切换提示如实反映「没跑起来」，不谎报成功', () => {
    expect(gatewayToggleNotice(RUNNING, true)).toContain('http://127.0.0.1:8326/v1')
    expect(gatewayToggleNotice(OFF, false)).toContain('已关闭')
    expect(gatewayToggleNotice(WANTED_BUT_DOWN, true)).toContain('端口')
    expect(gatewayToggleNotice(ENV_BLOCKED, true)).toContain('DSH_OPENAI_GATEWAY_ENABLED')
  })

  it('客户端确实接上了宿主侧的两个网关端点', () => {
    expect(source).toContain("rpcCall('gateway.getEnabled'")
    expect(source).toContain("rpcCall('gateway.setEnabled'")
  })
})

describe('凭据的展示与复制', () => {
  it('来自环境变量时不显示文件路径（那一刻根本没有文件）', () => {
    const hint = gatewayApiKeyHint({ fromEnv: true, path: null, value: 'k' })
    expect(hint).toContain('DSH_OPENAI_GATEWAY_API_KEY')
    expect(hint).not.toContain('api-key')
  })

  it('来自文件时给出准确路径，帮用户自己核对/备份', () => {
    expect(gatewayApiKeyHint({ fromEnv: false, path: 'C:/Users/Jet/.dsh/openai-gateway/api-key', value: 'k' }))
      .toContain('C:/Users/Jet/.dsh/openai-gateway/api-key')
  })

  it('尚未生成过密钥时说明「启用后自动生成」，而不是给一个必然 401 的占位串', () => {
    const hint = gatewayApiKeyHint(null)
    expect(hint).toContain('自动生成')
  })

  it('复制失败时返回 false，调用方据此退回「显示明文」而不是无声无息', async () => {
    // 无 Clipboard API（node 环境）必须返回 false 而不是抛错。
    expect(await copyToClipboard('secret')).toBe(false)
  })

  it('复制成功时返回 true', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    try {
      expect(await copyToClipboard('secret')).toBe(true)
      expect(writeText).toHaveBeenCalledWith('secret')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('写剪贴板被拒（权限/非用户手势）时返回 false 而不是抛到 UI', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'))
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    try {
      expect(await copyToClipboard('secret')).toBe(false)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('面板默认不把密钥明文渲染进 DOM，只有点「显示明文」才出现', () => {
    // 设置页会被截图/录屏/投屏，明文默认躺在屏幕上等于把凭据带出去。
    const body = source.slice(
      source.indexOf('function GatewayPanel('),
      source.indexOf('export function JetHubPage'),
    )
    // ⚠️ 用 \s 跨空白而不是 '\n' 字面量：源文件是 CRLF，字面量匹配不上。
    // 这里验的正是「明文必须被 revealed 门控」——三元里 revealed 为真才渲染 value。
    expect(body).toMatch(/revealed\s*\?\s*React\.createElement\('code'[\s\S]*?apiKey\.value/)
    // 复制走的是同一个值，避免「显示的」与「复制的」不是同一个。
    expect(body).toContain('copyToClipboard(apiKey.value)')
    // 复制失败必须退回显示明文，不能让按钮点了没反应。
    expect(body).toMatch(/setRevealed\(true\)[\s\S]{0,80}setCopied\(false\)/)
  })
})

describe('模型 ID 清单（ZCode 等不会自动扫目录的客户端靠它）', () => {
  const MODELS = [
    { id: 'codearts/GLM-5.2', name: 'GLM-5.2' },
    { id: 'codearts/glm-5.3-flash', name: 'GLM-5.3 Flash' },
    { id: 'cline/anthropic/claude-sonnet-5.5', name: 'Claude' },
  ]

  it('每行一个 ID，保持原大小写（大小写敏感，规范化会给出错误 ID）', () => {
    expect(formatModelIdList(MODELS)).toBe(
      'codearts/GLM-5.2\ncodearts/glm-5.3-flash\ncline/anthropic/claude-sonnet-5.5',
    )
  })

  it('空清单不产生空白字符串（否则「复制」按钮会复制到一个换行）', () => {
    expect(formatModelIdList([])).toBe('')
    expect(formatModelIdList(null)).toBe('')
    expect(formatModelIdList(undefined)).toBe('')
  })

  it('提示语给出数量，并点明「ID 区分大小写」这个实测踩过的坑', () => {
    const hint = gatewayModelsHint(MODELS, 'catalog')
    expect(hint).toContain('3 个')
    expect(hint).toContain('大小写')
    // 同名模型跨 provider 不是同一个 —— 用户最常见的误配来源。
    expect(hint).toContain('不同供应商')
  })

  it('⚠️ 空清单必须能自解释：区分「没登录」与「宿主没给出 provider」', () => {
    // 实机报障：用户每个 provider 都登录了，清单却是 0 个，而提示却说
    // 「还没有可用模型，登录至少一个供应商」—— 用户照着去查登录怎么都对不上。
    expect(gatewayModelsHint([], 'none')).toContain('拿不到任何 provider 列表')
    expect(gatewayModelsHint([], 'none')).toContain('这不是登录问题')
    expect(gatewayModelsHint([], 'catalog')).toContain('还没有可用模型')
  })

  it('目录来自适配器兜底时说明它可能不完整', () => {
    const hint = gatewayModelsHint(MODELS, 'adapters')
    expect(hint).toContain('已注册的适配器')
  })

  it('curl 模板含正确端口，但**绝不含**明文密钥', () => {
    const curl = gatewayModelsCurl('http://127.0.0.1:9999/v1')
    expect(curl).toContain('127.0.0.1:9999/v1/models')
    expect(curl).toContain('Authorization: Bearer')
    // ⚠️ 命令会进剪贴板历史、可能被贴进聊天里，不能把真 key 写进去。
    expect(curl).toContain('把你的 API Key 贴在这里')
  })

  it('地址栏直接打开会 401 这件事必须提前告诉用户', () => {
    expect(gatewayModelsHint(MODELS)).not.toContain('401')
    // 说明文案在面板里，单独断言渲染处带这句。
    expect(source).toContain('地址栏直接打开会返回 401')
  })

  it('面板确实渲染了清单与「复制全部 ID」按钮', () => {
    expect(source).toContain('formatModelIdList(models)')
    expect(source).toContain('handleCopyModelIds')
    expect(source).toContain('复制全部')
    // 复制失败必须展开清单让用户手动选中。
    expect(source).toMatch(/setIdsCopied\(ok\)[\s\S]{0,120}setModelsOpen\(true\)/)
  })
})

/**
 * 「哪些模型能发图片」的标记。
 *
 * 背景：用户给网关发图得到 `unsupported_content`，但他**事先无从知道**该模型
 * 支不支持图片 —— 只能撞一次错才知道。`/v1/models` 早已带 `input` 字段，只是
 * 设置页没显示。
 */
describe('模型能力标记（可发图片）', () => {
  it('input 含 image 时标记为可发图片', () => {
    expect(modelSupportsImage({ input: ['text', 'image'] })).toBe(true)
    expect(modelCapabilityBadge({ input: ['text', 'image'] })).toBe('可发图片')
  })

  it('⚠️ 缺 input / 不含 image 一律**不标**（宁可少标也不错标）', () => {
    // 错标成支持，用户发完图才发现被拒；少标则只是没提示，错误仍是明确的。
    expect(modelSupportsImage({ input: ['text'] })).toBe(false)
    expect(modelSupportsImage({})).toBe(false)
    expect(modelSupportsImage(null)).toBe(false)
    expect(modelSupportsImage(undefined)).toBe(false)
    expect(modelSupportsImage({ input: 'image' as never })).toBe(false)
    expect(modelCapabilityBadge({ input: ['text'] })).toBe('')
  })

  it('判据只看是否含 image，不因顺序或额外模态而改变', () => {
    expect(modelSupportsImage({ input: ['image'] })).toBe(true)
    expect(modelSupportsImage({ input: ['image', 'text', 'audio'] })).toBe(true)
  })

  it('清单行确实渲染了这个标记', () => {
    expect(source).toContain('modelCapabilityBadge')
    expect(source).toContain('dim-jh-modelBadge')
  })

  it('样式里有这个类，且锁住 flex: none（否则会被 id/name 挤没）', () => {
    const styles = readFileSync(resolve(HERE, '../../plugin-src/client/jet-hub-styles.js'), 'utf8')
    expect(styles).toMatch(/\.dim-jh-modelBadge \{[^}]*flex: none/)
  })
})
