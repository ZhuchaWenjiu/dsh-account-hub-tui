import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  groupProviders,
  providerSwitchState,
  summarizeProviderToggle,
} from '../../plugin-src/client/provider-toggle.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(resolve(HERE, '../../plugin-src/client/jet-hub.js'), 'utf8')
const styles = readFileSync(resolve(HERE, '../../plugin-src/client/jet-hub-styles.js'), 'utf8')

/** 最小供应商定义（只用到 id，与真实 PROVIDERS 的结构一致）。 */
const P = (id) => ({ id, label: id })

describe('groupProviders（左侧分组）', () => {
  it('按 closed 分成两组，且保持传入顺序', () => {
    const providers = [P('a'), P('b'), P('c'), P('d')]
    const statuses = {
      a: { closed: false },
      b: { closed: true },
      c: { closed: false },
      d: { closed: true },
    }
    const { open, closed } = groupProviders(providers, statuses)
    expect(open.map(p => p.id)).toEqual(['a', 'c'])
    expect(closed.map(p => p.id)).toEqual(['b', 'd'])
  })

  it('组内顺序就是传入顺序，不重排（用户认知顺序必须稳定）', () => {
    const providers = [P('z'), P('a'), P('m')]
    const { open } = groupProviders(providers, {})
    expect(open.map(p => p.id)).toEqual(['z', 'a', 'm'])
  })

  it('状态缺失的供应商归入「已打开」（宁多勿少，避免一次失败看成全被关）', () => {
    const providers = [P('a'), P('b')]
    const { open, closed } = groupProviders(providers, { a: { closed: true } })
    expect(open.map(p => p.id)).toEqual(['b'])
    expect(closed.map(p => p.id)).toEqual(['a'])
  })

  it('closed 只认显式 true（与黑名单「非 true 即打开」的判据一致）', () => {
    const providers = [P('a'), P('b'), P('c')]
    const statuses = { a: { closed: 1 }, b: { closed: 'true' }, c: { closed: undefined } }
    expect(groupProviders(providers, statuses).open.map(p => p.id)).toEqual(['a', 'b', 'c'])
    expect(groupProviders(providers, statuses).closed).toEqual([])
  })

  it('statuses 为 null / 非对象时不抛错，全部归入已打开', () => {
    const providers = [P('a'), P('b')]
    expect(groupProviders(providers, null).open).toHaveLength(2)
    expect(groupProviders(providers, null).closed).toHaveLength(0)
    expect(groupProviders(providers, 'bogus').open).toHaveLength(2)
  })

  it('providers 非数组时返回两个空组（不抛错）', () => {
    const { open, closed } = groupProviders(null, {})
    expect(open).toEqual([])
    expect(closed).toEqual([])
  })
})

describe('providerSwitchState（开关三形态）', () => {
  it('有模型且未全关 → 已打开（checked=true），可点击', () => {
    const s = providerSwitchState({ models: { total: 30, disabled: 13 }, closed: false })
    expect(s).toEqual({ checked: true, disabled: false, reason: null })
  })

  it('全部模型已关闭 → checked=false（开关呈关闭态），仍可点击以重新打开', () => {
    const s = providerSwitchState({ models: { total: 17, disabled: 17 }, closed: true })
    expect(s.checked).toBe(false)
    expect(s.disabled).toBe(false)
  })

  it('① 没有任何模型 → 禁用并给出原因（「不关闭模型就不关闭供应商」）', () => {
    const s = providerSwitchState({ models: { total: 0, disabled: 0 }, closed: false })
    expect(s.disabled).toBe(true)
    expect(s.checked).toBe(true)
    expect(s.reason).toContain('没有可关闭的模型')
  })

  it('② 状态未知（undefined）→ 禁用并说明原因', () => {
    const s = providerSwitchState(undefined)
    expect(s.disabled).toBe(true)
    expect(s.reason).toBeTruthy()
  })

  it('③ 状态非对象（异常输入）→ 禁用而不是抛错', () => {
    expect(providerSwitchState(null).disabled).toBe(true)
    expect(providerSwitchState('bogus').disabled).toBe(true)
  })

  it('models 字段缺失时视为 0 → 禁用（不误判为可操作）', () => {
    expect(providerSwitchState({ accounts: { total: 1 } }).disabled).toBe(true)
  })

  it('total 为负数等非法值 → 禁用（不给用户一个无效的操作入口）', () => {
    expect(providerSwitchState({ models: { total: -5 } }).disabled).toBe(true)
  })
})

describe('summarizeProviderToggle（结果文案）', () => {
  it('关闭：报告实际关闭的模型与停用的账号数', () => {
    expect(summarizeProviderToggle(false, { models: 17, accounts: 1 }))
      .toBe('已关闭 17 个模型，已停用 1 个账号')
  })

  it('打开：报告实际打开的模型与启用的账号数', () => {
    expect(summarizeProviderToggle(true, { models: 17, accounts: 2 }))
      .toBe('已打开 17 个模型，已启用 2 个账号')
  })

  it('⚠️ 变更数为 0 时不得谎报「已停用 N 个」（幂等操作要照实说）', () => {
    expect(summarizeProviderToggle(false, { models: 5, accounts: 0 }))
      .toBe('已关闭 5 个模型，没有账号需要停用')
  })

  it('两侧都为 0 时如实说明无事可做', () => {
    expect(summarizeProviderToggle(true, { models: 0, accounts: 0 }))
      .toBe('模型本就全部打开，账号本就全部启用')
  })

  it('res 缺失 / 字段非数字时不抛错，按 0 处理', () => {
    expect(summarizeProviderToggle(false, null)).toBe('没有模型需要关闭，没有账号需要停用')
    expect(summarizeProviderToggle(false, { models: 'x', accounts: null }))
      .toBe('没有模型需要关闭，没有账号需要停用')
  })
})

describe('renderRail 接线（源码级回归）', () => {
  it('引用了纯逻辑模块，而不是在本文件里另写一份判定', () => {
    expect(source).toContain("from './provider-toggle.js'")
    expect(source).toContain('groupProviders(')
    expect(source).toContain('providerSwitchState(')
  })

  it('rail 渲染出两个分组标题并带计数', () => {
    expect(source).toContain('dim-jh-railGroup')
    expect(source).toContain('dim-jh-railGroupTitle')
    expect(source).toContain('`已打开 (${open.length})`')
    expect(source).toContain('`已关闭 (${closed.length})`')
  })

  it('⚠️ 开关是 <button role="tab"> 的**兄弟**，不在按钮内部', () => {
    // 取 renderProviderRow 的函数体，断言结构顺序：按钮先闭合，开关后出现。
    const start = source.indexOf('const renderProviderRow = (p) => {')
    expect(start).toBeGreaterThan(-1)
    const body = source.slice(start, source.indexOf('const renderRail = () =>'))
    const buttonOpen = body.indexOf("role: 'tab'")
    const buttonClose = body.indexOf('React.createElement(\'input\'')
    expect(buttonOpen).toBeGreaterThan(-1)
    expect(buttonClose).toBeGreaterThan(buttonOpen)
    // 开关必须在 label span 的闭合之后（即已是按钮的兄弟）
    expect(body.indexOf('dim-jh-providerLabel')).toBeLessThan(buttonClose)
  })

  it('行容器不挂 onClick（点击只属于 tab 按钮，开关由 onChange 处理）', () => {
    const start = source.indexOf('const renderProviderRow = (p) => {')
    const body = source.slice(start, source.indexOf('const renderRail = () =>'))
    expect(body).toContain("className: 'dim-jh-providerRow'")
    expect(body).not.toMatch(/dim-jh-providerRow'[^}]*onClick/)
  })

  it('开关是受控组件（绑定 checked），取消确认后能回到原值', () => {
    const start = source.indexOf('const renderProviderRow = (p) => {')
    const body = source.slice(start, source.indexOf('const renderRail = () =>'))
    expect(body).toContain('checked: on')
    expect(body).toContain('onChange:')
  })

  it('状态未就绪时退化为不分组平铺（不阻断账号管理）', () => {
    expect(source).toContain('if (providerStatuses === null)')
  })

  it('关闭前必须确认，且文案给出影响面', () => {
    expect(source).toContain('确认关闭「${label}」？')
    expect(source).toContain('取消则不做任何变更')
  })
})

describe('供应商开关的样式约束（源码级回归）', () => {
  it('.dim-jh-providerRow 的首列是 minmax(0, 1fr)（否则长名把开关挤出 rail）', () => {
    expect(styles).toMatch(/\.dim-jh-providerRow \{[^}]*grid-template-columns: minmax\(0, 1fr\) auto/)
  })

  it('.dim-jh-providerRow 内的 .dim-jh-provider 允许收缩（min-width: 0）', () => {
    expect(styles).toMatch(/\.dim-jh-providerRow \.dim-jh-provider \{[^}]*min-width: 0/)
  })

  it('rail 宽度为实测反推的 243px（而不是随手取的整数值）', () => {
    expect(styles).toMatch(/\.dim-jh-rail \{ width: 243px;/)
  })

  it('开关保持 flex: none（目标控件不参与收缩）', () => {
    expect(styles).toMatch(/\.dim-jh-switch \{[^}]*flex: none/)
  })
})