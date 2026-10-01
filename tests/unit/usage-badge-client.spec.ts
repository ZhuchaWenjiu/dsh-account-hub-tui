import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

/**
 * 用量徽标的**客户端接线**回归。
 *
 * ⚠️ 为什么是源码级断言而不是渲染测试：`plugin-src/client/usage-badge.js` 依赖
 * **宿主注入的 `react`**（esbuild 的 external），本仓库的 node_modules 里没有
 * react，故无法在 vitest 里渲染它 —— 与 `cline-quota-panel.spec.ts` /
 * `raccoon-client-panel.spec.ts` 的处境相同。
 *
 * 本文件守住的是「接线」：槽位挂在哪、门控用的是不是**能力表**、轮询与隐藏页
 * 行为、失败是否保留上次读数、按钮是否由能力表门控、依赖是否声明、样式是否齐备。
 * 文案与模式选择由 `badge-model.spec.ts`（纯函数，真实现）覆盖；
 * 宿主侧聚合由 `usage-badge.spec.ts` 覆盖；套餐判定由 `badge-subscription.spec.ts` 覆盖。
 */

const here = dirname(fileURLToPath(import.meta.url))
const read = (rel: string) => readFileSync(resolve(here, '../..', rel), 'utf8')

/**
 * 去掉块注释后的源码。
 *
 * ⚠️ 反面断言（`not.toContain`）必须基于它：本仓库的注释里**大量引用**被禁止的
 * 写法（例如「判定来自能力表而不是 `PROVIDERS.includes()`」），直接对全文断言
 * 会把注释本身判成违规 —— 第一次写这个用例时就这么红过。
 */
const codeOf = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '')

describe('用量徽标：槽位接线', () => {
  const index = read('plugin-src/client/index.js')

  it('注入 modelDirectories（当前渠道的唯一来源）', () => {
    expect(index).toContain("export const inject = ['slots', 'connection', 'modelDirectories']")
  })

  it('注册到 conversation.input.right（模型选择器旁的 list 槽）', () => {
    expect(index).toContain("ctx.slots.inject('conversation.input.right'")
    expect(index).toContain("name: 'conversation.input.right'")
    expect(index).toContain("id: 'jet-hub-usage'")
  })

  it('目录按会话惰性解析（不缓存 directory 对象）', () => {
    expect(index).toContain('ctx.modelDirectories.directoryFor(sessionId).store')
    expect(index).toMatch(/inject:\s*\(sessionId\)\s*=>/)
  })

  it('注入三个 RPC 包装：读读数 / 写偏好 / 签到', () => {
    expect(index).toContain("readBadge: (provider, options) => rpcCall('usage.badge'")
    expect(index).toContain("writePreference: (preference) => rpcCall('usage.badgePreference'")
    expect(index).toContain("claimCredits: (provider) => rpcCall('credits.claimAll'")
  })

  it('渠道展示名复用 jet-hub.js 的 providerLabel（不另抄一份名字表）', () => {
    expect(index).toMatch(/import \{[^}]*providerLabel[^}]*\} from '\.\/jet-hub\.js'/)
    expect(index).toContain('providerLabel,')
  })
})

describe('用量徽标：渲染门控与轮询', () => {
  const badge = read('plugin-src/client/usage-badge.js')
  const badgeCode = codeOf(badge)

  it('门控来自能力表（不是写死 provider 字面量或 PROVIDERS 列表）', () => {
    expect(badge).toContain('if (!supportsCreditBalance(provider)) return null;')
    // ⚠️ 不得改成 `PROVIDERS.includes(provider)`：能力表是与服务端分派对齐的
    // 唯一真相源（漏登记的渠道会静默失去徽标，或反过来对不存在的渠道发请求）。
    expect(badgeCode).not.toContain('PROVIDERS.includes')
    expect(badgeCode).not.toContain('PROVIDERS.some')
  })

  it('没有选中模型时整体不渲染（新会话 / 已寻址 subagent 会话）', () => {
    expect(badge).toMatch(/typeof provider !== 'string' \|\| provider\.length === 0/)
  })

  it('轮询 60 秒，且隐藏标签页跳过、切回立即刷新', () => {
    expect(badge).toContain('export const BADGE_POLL_MS = 60_000;')
    expect(badge).toContain("document.visibilityState === 'hidden'")
    expect(badge).toContain("document.addEventListener('visibilitychange', onVisible)")
    expect(badge).toContain('setInterval(')
  })

  it('读取失败保留上一次成功读数（不把旧数字清空）', () => {
    // catch 分支只置失败标记，**不**清 snapshot
    expect(badge).toMatch(/catch \{[\s\S]{0,220}?setFailed\(true\)/)
    expect(badgeCode).not.toMatch(/catch \{[\s\S]{0,220}?setSnapshot\(null\)/)
  })

  it('只认领属于当前渠道的响应（并发/切渠道时不会画错）', () => {
    expect(badge).toContain("if (value?.provider !== undefined && value.provider !== provider) return;")
  })

  it('切渠道时先清空旧读数', () => {
    expect(badge).toMatch(/React\.useEffect\(\(\) => \{\s*setSnapshot\(null\)/)
  })

  it('刷新按钮绕过宿主缓存（force）', () => {
    expect(badge).toContain("await readBadge(provider, manual === true ? { force: true } : {})")
  })

  it('客户端**不**直接调 credits.balances（那是逐账号打上游的端点）', () => {
    // 该端点由宿主侧 `usage.badge` 内部复用（带 TTL 缓存），客户端直连会让
    // 上游请求数随「轮询次数 × 账号数」放大。
    expect(badgeCode).not.toContain('credits.balances')
    expect(badgeCode).toContain('readBadge(')
  })
})

describe('用量徽标：签到与显示偏好', () => {
  const badge = read('plugin-src/client/usage-badge.js')

  it('签到按钮由能力表门控（WorkBuddy 国际版 / Cline 不渲染）', () => {
    expect(badge).toContain('if (supportsDailyCheckin(provider)) children.push(renderClaim());')
  })

  it('签到成功后强制重读（否则要等下一轮轮询才看到新数字）', () => {
    expect(badge).toMatch(/claimCredits\(provider\)[\s\S]{0,400}?read\.current\(\)/)
  })

  it('签到结果按四态汇总成一句话（「今天已领」不算失败）', () => {
    expect(badge).toContain('alreadyClaimed')
    expect(badge).toContain('totalCredit')
    expect(badge).toContain('inactive')
  })

  it('三态偏好开关写宿主（本地先生效，失败回滚）', () => {
    expect(badge).toContain('BADGE_PREFERENCES.map')
    expect(badge).toContain("'aria-pressed': effectivePreference === item")
    expect(badge).toMatch(/await writePreference\(next\)/)
    expect(badge).toMatch(/catch \(error\) \{\s*setPreference\(null\)/)
  })

  it('点外部与 Esc 都能关闭弹窗（仅在展开时挂监听）', () => {
    expect(badge).toContain("document.addEventListener('mousedown', onDown)")
    expect(badge).toContain("document.addEventListener('keydown', onKey)")
    expect(badge).toMatch(/if \(!open\) return undefined;/)
  })
})

describe('用量徽标：依赖与样式', () => {
  it('package.json 声明三个客户端依赖（含提供 modelDirectories 的那个包）', () => {
    const pkg = JSON.parse(read('package.json')) as {
      dsh?: { client?: { platform?: string; inject?: string[] } }
    }
    expect(pkg.dsh?.client?.platform).toBe('web')
    expect(pkg.dsh?.client?.inject).toEqual([
      '@deepseek-ai/dsh-client-connection',
      '@deepseek-ai/dsh-client-ui-settings',
      '@deepseek-ai/dsh-client-ui-model-selection',
    ])
  })

  it('徽标用到的每个样式类都在 jet-hub-styles.js 里定义', () => {
    const badge = read('plugin-src/client/usage-badge.js')
    const styles = read('plugin-src/client/jet-hub-styles.js')
    // ⚠️ 类名允许大写（dim-jh-badgeDot / badgePop / ...），第一次写成只认小写时
    // 只匹配到 1 个类，用例假绿。
    const classes = new Set([...badge.matchAll(/className: '([A-Za-z0-9- ]+)'/g)].map((match) => match[1].trim()))
    expect(classes.size).toBeGreaterThan(10)
    for (const className of classes) {
      expect(styles, className).toContain(`.${className}`)
    }
  })

  it('样式里的注释**不含反引号**（STYLES 是模板字符串，会被提前闭合）', () => {
    const styles = read('plugin-src/client/jet-hub-styles.js')
    // 只检查徽标那一段：从「用量徽标」注释块到 STYLES 结束
    const start = styles.indexOf('── 用量徽标')
    expect(start).toBeGreaterThan(0)
    const badgeSection = styles.slice(start - 40)
    const commentBlocks = [...badgeSection.matchAll(/\/\*[\s\S]*?\*\//g)].map((match) => match[0])
    expect(commentBlocks.length).toBeGreaterThan(0)
    for (const block of commentBlocks) expect(block).not.toContain('`')
  })
})

describe('格式化函数下沉（徽标与设置页共用同一口径）', () => {
  const hub = read('plugin-src/client/jet-hub.js')

  it('jet-hub.js 不再自带数值/窗口格式化实现，改为 import 纯模块', () => {
    expect(hub).not.toMatch(/^function formatUnits\(/m)
    expect(hub).not.toMatch(/^function formatCredits\(/m)
    expect(hub).not.toMatch(/^const QUOTA_WINDOWS = /m)
    expect(hub).toMatch(/from '\.\/credits-format\.js'/)
    expect(hub).toMatch(/from '\.\/quota-format\.js'/)
  })

  it('两个界面用的是同一组函数（不是各写一份）', () => {
    const badge = read('plugin-src/client/usage-badge.js')
    for (const source of [hub, badge]) {
      expect(source).toMatch(/from '\.\/quota-format\.js'/)
      expect(source).toMatch(/from '\.\/credits-format\.js'/)
    }
  })

  it('providerLabel 从 jet-hub.js 导出（渠道名的唯一来源）', () => {
    expect(hub).toContain('export function providerLabel(id)')
  })
})
