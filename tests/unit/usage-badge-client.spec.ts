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
 * 去掉注释后的源码（块注释 + **整行** `//` 注释都要去）。
 *
 * ⚠️ 反面断言（`not.toContain`）必须基于它：本仓库的注释里**大量引用**被禁止的
 * 写法（例如「判定来自能力表而不是 `PROVIDERS.includes()`」「按钮文案不写
 * `签到（仅 …）`」），直接对全文断言会把注释本身判成违规 —— 第一次写这类用例时
 * 就这么红过两次（块注释一次、`//` 行注释一次）。
 *
 * ⚠️ 只去「整行以 `//` 开头」的注释，故字符串里的 `https://…` 不会被误删。
 */
const codeOf = (text: string) => text
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '')

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

  it('三类读取语义分明：挂载走缓存 / 轮询跳过隐藏页 / 刷新才 force', () => {
    // 挂载（含切渠道后）：不 force、不跳过 —— 走宿主缓存，有缓存就立刻出数
    expect(badge).toMatch(/read\.current = \(\) => \{ void load\(\{ force: true \}\); \};\s*\n\s*void load\(\);/)
    // 轮询与「切回前台」带 poll 标记（只有它们跳过隐藏页）
    expect(badge).toContain('void load({ poll: true })')
    expect(badge).toContain("if (options.poll === true && typeof document !== 'undefined' && document.visibilityState === 'hidden') return;")
    // 请求本身：只有 force 形态才带 { force: true }
    expect(badge).toContain('await readBadge(provider, force ? { force: true } : {});')
    // ⚠️ 挂载**不得**再写成 force（用户报障「反应有点慢」的根因：每次挂载都
    // 绕过宿主 120s 缓存，逐账号重打上游）
    expect(badge).not.toContain('void load(true)')
  })

  it('首屏状态显式传给展示层（不能靠「账号列表为空」推断）', () => {
    expect(badge).toMatch(/loading: snapshot === null && !failed/)
    expect(badge).toMatch(/failed: failed && snapshot === null/)
  })

  it('首屏读数未到时不渲染明细区（否则会说成「该渠道还没有账号」）', () => {
    // 首屏只给一句说明 + 签到按钮，然后 return（不 push 订阅/积分区）
    expect(badge).toContain("key: 'placeholder'")
    expect(badge).toContain('正在读取用量…')
    expect(badge).toMatch(/children\.push\(renderClaim\(\)\);\s*\n\s*return React\.createElement\('div', \{ className: 'dim-jh-badgePop' \}, children\);/)
  })

  it('客户端**不**直接调 credits.balances（那是逐账号打上游的端点）', () => {
    // 该端点由宿主侧 `usage.badge` 内部复用（带 TTL 缓存），客户端直连会让
    // 上游请求数随「轮询次数 × 账号数」放大。
    expect(badgeCode).not.toContain('credits.balances')
    expect(badgeCode).toContain('readBadge(')
  })
})

describe('用量徽标：签到（本渠道 + 全部渠道）', () => {
  const badge = read('plugin-src/client/usage-badge.js')
  const badgeCode = codeOf(badge)

  it('本渠道按钮由能力表门控（WorkBuddy 国际版 / Cline / Raccoon 不渲染）', () => {
    expect(badge).toContain('const canClaimCurrent = supportsDailyCheckin(provider);')
    expect(badge).toMatch(/canClaimCurrent\s*\n?\s*\? React\.createElement\('button'/)
  })

  it('本渠道按钮文案不带渠道名（否则 300px 弹窗里会被省略号截断）', () => {
    // 截图核验发现：`签到（仅 CodeBuddy (腾讯)）` 被截成 `签到（仅 CodeBuddy (…`
    expect(badge).toContain("'签到（本渠道）'")
    // ⚠️ 反面断言必须基于**去注释后的代码**：上面那条解释性注释里就写着被禁的写法
    expect(codeOf(badge)).not.toContain('签到（仅 ')
    // 渠道名改到 title 里，信息不丢（注意源码用的是**全角**括号）
    expect(badge).toContain('只签到当前渠道（${label}）的全部账号')
  })

  it('「全部渠道签到」串行遍历能力表推导出的渠道集合（不新增后端端点）', () => {
    // 用户 2026-10-02 选 B：弹窗里同时提供「仅本渠道」与「全部渠道」
    expect(badge).toContain('const providers = checkinProviders();')
    // ⚠️ 必须串行 await：真实领积分的写操作，跨渠道并发会触发风控
    expect(badge).toMatch(/for \(let index = 0; index < providers\.length; index \+= 1\)/)
    expect(badgeCode).not.toContain('Promise.all')
    // 逐个渠道调同一个端点，不新增后端接口
    expect(badge).toMatch(/const result = await claimCredits\(id\);/)
    // 进度可见（串行多次请求，不显示进度会像卡住）
    expect(badge).toContain('setClaimProgress({ done: index + 1, total: providers.length })')
    expect(badge).toMatch(/签到中 \$\{claimProgress\.done\}\/\$\{claimProgress\.total\}…/)
  })

  it('全部渠道的结果把每个非零计数与 actionRequired 提示都列出来', () => {
    // 早期只判三个分支 ⇒「活动未开启」的渠道整条消失（设置页 2026-09-26 真实缺陷）
    expect(badge).toContain('summary.alreadyClaimed > 0')
    expect(badge).toContain('summary.inactive > 0')
    expect(badge).toContain('summary.failed > 0')
    expect(badge).toContain("outcome.actionRequired !== true")
    // 单渠道失败不中断后续渠道
    expect(badge).toMatch(/catch \(error\) \{\s*failed \+= 1;/)
  })

  it('全部渠道按钮**不依赖**本渠道读数（首屏/失败态也渲染）', () => {
    expect(badge).toMatch(/children\.push\(renderClaim\(\)\);\s*\n\s*children\.push\(renderFoot\(\)\);/)
  })

  it('签到成功后强制重读（否则要等下一轮轮询才看到新数字）', () => {
    expect(badge).toMatch(/await claimCredits\(provider\)[\s\S]{0,500}?read\.current\(\)/)
    expect(badge).toMatch(/setClaiming\(null\);\s*\n\s*read\.current\(\);/)
  })

  it('签到结果按四态汇总成一句话 + 色调（「今天已领」不算失败）', () => {
    expect(badge).toContain('function summarizeClaim(result)')
    expect(badge).toContain('alreadyClaimed')
    expect(badge).toContain('totalCredit')
    expect(badge).toContain('inactive')
    expect(badge).toMatch(/tone: summary\.failed > 0 \|\| notes\.length > 0 \? 'warn' : 'ok'/)
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

describe('用量徽标：弹窗的紧凑布局（信息一项不少）', () => {
  const badge = read('plugin-src/client/usage-badge.js')
  const styles = read('plugin-src/client/jet-hub-styles.js')

  it('头部一行：色调点 + 渠道名 + 更新时间 + 图标刷新（省掉「刷新」一词占的宽度）', () => {
    expect(badge).toContain("key: 'dot', className: 'dim-jh-badgeDot'")
    expect(badge).toContain("key: 'refresh'")
    expect(badge).toContain("'aria-label': '刷新用量'")
    expect(styles).toMatch(/\.dim-jh-badgeRefresh \{[^}]*width: 22px/)
  })

  it('每个窗口只占两行：名称 + 重置倒计时 / 进度条 + 百分比', () => {
    expect(badge).toContain("key: 'track', className: 'dim-jh-badgeWinTrack'")
    expect(styles).toMatch(/\.dim-jh-badgeWinTrack \.dim-jh-quotaBar \{[^}]*flex: 1/)
    // ⚠️ 倒计时与百分比都必须可见（不能藏进 tooltip）
    expect(badge).toContain('quotaResetsIn(win?.resetsAt)')
    expect(badge).toContain('formatQuotaPercent(percent)')
  })

  it('账号行：名字与数值同一行、备注小字，合计并入节标题', () => {
    expect(badge).toContain("className: 'dim-jh-badgeRowName'")
    expect(badge).toContain("className: 'dim-jh-badgeRowNote'")
    expect(badge).toContain("className: 'dim-jh-badgeSectionSum'")
    expect(styles).toMatch(/\.dim-jh-badgeRowHead \{[^}]*justify-content: space-between/)
  })

  it('偏好做成三段等分控件（不再单占一行写「显示偏好」）', () => {
    expect(styles).toMatch(/\.dim-jh-badgePrefBtn \{[^}]*flex: 1/)
    // 解释性文案改到容器 title 上，信息不丢
    expect(badge).toContain('显示偏好：决定徽标优先显示订阅还是积分')
    expect(badge).not.toContain("'显示偏好'")
  })

  it('浮层窄于 340px 且用细分隔线分组（更矮更整齐）', () => {
    expect(styles).toMatch(/\.dim-jh-badgePop \{[^}]*width: 300px/)
    expect(styles).toMatch(/\.dim-jh-badgeSection \{[^}]*border-top: \.5px solid/)
  })

  it('信息不缺失：时间戳/缓存标记、停用与失败计数、套餐到期都仍在渲染里', () => {
    expect(badge).toContain("value?.cached === true ? ' · 缓存' : ''")
    expect(badge).toContain('另有 ${value.disabledCount} 个账号已停用，未计入')
    expect(badge).toContain('${view.failedCount} 个账号读取失败')
    expect(badge).toContain('扣费截止 ${formatUpdatedAt(group.deductionEndTime)}')
    expect(badge).toContain('本次刷新失败，显示的是上一次读数')
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
    // ⚠️ 一个 className 里可能写**两个**类（如 'dim-jh-badgeSection dim-jh-badgeClaim'），
    // 必须拆开逐个查，否则断言会拿整串去找 `.A B` 而假红。
    const classes = new Set(
      [...badge.matchAll(/className: '([A-Za-z0-9- ]+)'/g)]
        .flatMap((match) => match[1].trim().split(/\s+/)),
    )
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
