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
   * ⚠️ 请求记录的失败是**载荷**（`ok:false`），不是 RPC 级错误 ——
   * 面板必须判 `res.ok`，否则失败时会把已加载的行留在表格里却**不显示原因**
   * （RPC 抛错路径才有 catch，载荷路径没有）。
   */
  it('请求记录判 res.ok（失败是载荷而非 RPC 错误）', () => {
    expect(client).toMatch(/res\?\.ok === false/)
  })

  /** 分页只走响应里的 nextToken；空串视为没有下一页（否则渲染一个点了没反应的按钮）。 */
  it('分页游标取 nextToken，且空串视为没有下一页', () => {
    expect(client).toMatch(/res\?\.nextToken/)
    expect(client).toMatch(/nextToken !== undefined\s*\?\s*React\.createElement\('button'/)
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

  /** 多账号才渲染切换器（单账号时它没有可去的地方）。 */
  it('多账号才渲染账号切换器', () => {
    expect(client).toMatch(/quota\.length > 1[\s\S]{0,200}?dim-jh-quotaAccountTabs/)
  })
})
