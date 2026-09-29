import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

/**
 * Cline「订阅额度」按钮与弹窗的**客户端接线**回归。
 *
 * ⚠️ 为什么是源码级断言而不是渲染测试：`plugin-src/client/jet-hub.js` 依赖
 * **宿主注入的 `react`**（esbuild 的 external），本仓库的 node_modules 里
 * 没有 react，故无法在 vitest 里渲染它 —— 这与 `raccoon-client-panel.spec.ts` /
 * `model-bulk.spec.ts` 的处境的相同，那些也一律用源码断言锁守卫。
 *
 * 这些断言守住的是**「接线」**（按钮在不在、门控用的是不是能力表、
 * 面板挂在哪个开关后面、弹窗调的是不是那两个端点）。
 * 端点本身的行为由 `jet-hub-rpc.spec.ts` 的行为级用例覆盖；
 * 能力表的判定由 `credits-capabilities.spec.ts` 覆盖。
 */

const here = dirname(fileURLToPath(import.meta.url))
const read = (rel: string) => readFileSync(resolve(here, '../..', rel), 'utf8')

describe('Cline 订阅额度：客户端接线', () => {
  const client = read('plugin-src/client/jet-hub.js')
  const styles = read('plugin-src/client/jet-hub-styles.js')

  it('从能力表导入 supportsSubscriptionQuota', () => {
    expect(client).toContain('supportsSubscriptionQuota,')
    expect(client).toMatch(/from '\.\/credits-capabilities\.js'/)
  })

  /**
   * ⚠️ 门控必须**来自能力表**，不能写成 `provider === 'cline'`：
   * 能力表是与服务端分派对齐的唯一真相源，写死字面量会在将来
   * 「某渠道下线该能力」时静默漂移（表现为按钮还在、点了报 bad-request）。
   */
  it('按钮门控来自能力表（不是写死 provider 字面量）', () => {
    expect(client).toContain('const canShowSubscriptionQuota = supportsSubscriptionQuota(provider)')
    expect(client).toMatch(/canShowSubscriptionQuota\s*\?[\s\S]{0,400}?'订阅额度'/)
  })

  it('按钮文案与提示齐备（tooltip 说明数据来自官方网关）', () => {
    expect(client).toContain("'订阅额度'")
    expect(client).toMatch(/查看 Cline 官方订阅额度窗口/)
  })

  /** 面板只在开关打开时挂载：关闭即不发请求（否则每次进面板都白发两次）。 */
  it('弹窗由 showQuota 控制挂载（关闭时不挂载）', () => {
    expect(client).toContain('const [showQuota, setShowQuota] = React.useState(false)')
    expect(client).toMatch(/showQuota\s*\?[\s\S]{0,200}?React\.createElement\(ClineQuotaPanel/)
    expect(client).toContain('onClose: () => setShowQuota(false)')
  })

  it('弹窗调用 cline.quota 与 cline.requestLog 两个端点', () => {
    expect(client).toMatch(/rpcCall\('cline\.quota',\s*\{\s*provider:\s*'cline'\s*\}\)/)
    expect(client).toMatch(/rpcCall\('cline\.requestLog',\s*\{[\s\S]{0,200}?provider:\s*'cline'/)
  })

  /**
   * ⚠️ 用户要求:**左右箭头**在账号间切换,且**额度窗口与请求记录共享同一个
   * 索引** —— 切到谁,两个区域就一起看到谁。参考实现(dsh-cline-pass)同款
   * (其「额度卡片」就是一次只显示一个账号,用 ‹ › 翻页)。
   */
  it('额度与请求记录共享同一个翻页索引', () => {
    expect(client).toMatch(/const \[viewIndex, setViewIndex\] = React\.useState\(0\)/)
    // 渲染期纯计算 + 越界钳制(不回写索引,账号恢复后还能回到原位)
    expect(client).toMatch(
      /const viewAccount = quota\.length > 0\s*\?\s*quota\[Math\.min\(viewIndex, quota\.length - 1\)\]/,
    )
    expect(client).toContain('viewAccountId')
  })

  /** 环绕:末个账号的右箭头回第一个 —— 单向尽头会让用户以为「后面没了」。 */
  it('箭头翻页环绕(末尾回第一个)', () => {
    expect(client).toMatch(/const stepView = \(delta\) => \{/)
    expect(client).toMatch(/\(\(prev \+ delta\) % quota\.length \+ quota\.length\) % quota\.length/)
  })

  /** 单账号时不渲染箭头(无处可去),但仍显示账号名(用户要知道这是谁的额度)。 */
  it('单账号不渲染箭头(多账号才渲染)', () => {
    expect(client).toMatch(/quota\.length > 1\s*\?[\s\S]{0,140}?dim-jh-quotaArrow/)
  })

  /**
   * ⚠️ 请求记录是**本地流水**（`src/cline-request-log.ts`）：本插件自己发出的
   * 推理请求（时间/模型/上游/TOKEN/延迟），**不是**网关的官方账单 ——
   * 两者的字段与语义都不同，提示文案必须讲清，否则用户以为是同一份。
   */
  it('请求记录来自本地流水(提示讲清与官方账单的区别)', () => {
    expect(client).toMatch(/请求记录是本插件自己发出的请求流水/)
    expect(client).toMatch(/dim-jh-quotaLogHint/)
  })

  /** 表格列对齐参考实现：时间 | 模型/上游 | TOKEN | 延迟(首块 + 总)。 */
  it('表格列对齐参考实现(时间/模型上游/TOKEN/延迟)', () => {
    expect(client).toContain("React.createElement('th', null, '时间')")
    expect(client).toContain("React.createElement('th', null, '模型 / 上游')")
    expect(client).toContain("React.createElement('th', { className: 'dim-jh-quotaNumCol' }, '延迟')")
    // TOKEN 列:输入 + 输出分开展示(合计会在缓存命中/思考上失真)
    expect(client).toMatch(
      /\$\{formatTokenCount\(row\.inputTokens\)\} \+ \$\{formatTokenCount\(row\.outputTokens\)\}/,
    )
    // 延迟列:首块耗时与总延迟并列
    expect(client).toMatch(/formatLatency\(row\.ttftMs, row\.totalMs\)/)
  })

  /** 失败行随行显示(colSpan 横跨数据列,参考实现同款)——收进 tooltip 用户看不到。 */
  it('失败行随行显示错误消息', () => {
    expect(client).toMatch(/row\.error !== undefined/)
    expect(client).toMatch(/colSpan: cells\.length/)
    expect(client).toContain("'dim-jh-quotaError'")
  })

  /**
   * ⚠️ `resetsAt` 是 ISO 字符串，必须用专门的格式化函数；
   * 复用毫秒口径的 `formatTime` 会把「6 小时后重置」显示成「已过期」。
   */
  it('ISO 时间另用 formatWindowReset（不复用毫秒口径的 formatTime）', () => {
    expect(client).toMatch(/function formatWindowReset\(iso\)/)
    expect(client).toMatch(/formatWindowReset\(win\.resetsAt\)/)
    expect(client).toMatch(/function formatLogTime\(iso\)/)
  })

  /**
   * ⚠️ 数值不夹取、只夹取进度条宽度：夹取数值会把「已超限 120%」显示成
   * 「刚好用完」，那正是最该看见的信息。
   */
  it('百分比数值不夹取（只有进度条宽度夹取）', () => {
    expect(client).toMatch(/function formatQuotaPercent\(value\)/)
    // 夹取只出现在宽度计算里（Math.min(100, Math.max(0, …))）。
    expect(client).toMatch(/Math\.min\(100,\s*Math\.max\(0,\s*win\.percentUsed\)\)/)
    // 百分比文案走 formatQuotaPercent，不经过 Math.min。
    expect(client).toMatch(/formatQuotaPercent\(win\.percentUsed\)/)
  })

  /**
   * ⚠️ 内容**必须**放进 `.dim-jh-modalBody`（flex:1; min-height:0; overflow-y:auto）。
   * `.dim-jh-modal` 是 max-height 有限的 flex **列**容器，子项默认不可收缩，
   * 内容直接铺在里面就会**画出弹窗边界之外** —— 首版正是漏了这一层：
   * 额度卡 + 请求表把弹窗撑破，用户报「弹窗位置不对、内容显示不对」。
   * 模型列表弹窗的内容同样在 modalBody 里（见其 error/loading/empty 分支）。
   */
  it('弹窗内容在 .dim-jh-modalBody 滚动区里（不直接铺在 .dim-jh-modal）', () => {
    expect(client).toMatch(/dim-jh-modalBody'[\s\S]{0,80}?renderQuota\(\),[\s\S]{0,40}?renderLog\(\)\)/)
  })

  /**
   * ⚠️ 数字列右对齐必须用**复合选择器**：单独 `.dim-jh-quotaNumCol` 的优先级
   * 是 (0,1,0)，压不过 `.dim-jh-quotaTable th/td` 的 (0,1,1)，`text-align:right`
   * 会**静默失效** —— 表头左对齐、数据右对齐，列就错位。参考实现 README 里
   * 「429 错误行撑宽请求记录表格」正是同一个选择器强度问题。
   */
  it('数字列右对齐用复合选择器（不被 th/td 的左对齐压过）', () => {
    expect(styles).toMatch(/\.dim-jh-quotaTable (td|th)\.dim-jh-quotaNumCol/)
    // 不得再有「裸类名 + text-align:right」的失效写法。
    expect(styles).not.toMatch(/^\.dim-jh-quotaNumCol \{[^}]*text-align:\s*right/m)
  })

  /** 时间列定宽：防时间戳被截断（参考实现实测 82px；数值允许调整，意图必须保留）。 */
  it('时间列定宽（防时间戳被截断）', () => {
    expect(styles).toMatch(/\.dim-jh-quotaTable td\.dim-jh-quotaWhen \{[^}]*width:/)
  })
})
