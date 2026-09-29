/**
 * 面板展示用的「临时 / 永久」分桶（`plugin-src/client/credit-expiry.js`）。
 *
 * ## 本文件最重要的职责：与后端**对账**
 *
 * 判据的权威实现在后端 `src/buddy-balance-rank.ts`（选号用它），前端这份是
 * 展示侧的同规则复刻。两者一旦漂移，用户就会看到「面板说还有 250 临时积分，
 * 选号却说没号可用」——而这类不一致**没有任何一条单侧用例能发现**。
 *
 * 故下面用同一组 fixture（含边界与脏值）喂两侧，逐条断言结果相同。
 */
import { describe, expect, it } from 'vitest'
import {
  daysUntilExpiry,
  expiryBucketLabel,
  formatExpirySplitLine,
  splitCreditsByExpiry,
} from '../../plugin-src/client/credit-expiry.js'
import { splitBuddyCreditsByExpiry } from '../../src/buddy-balance-rank.js'
import type { CreditBalance, CreditPackage } from '../../src/credits.js'

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 9, 1, 12, 0, 0)
const WINDOW_DAYS = 15

function pkg(overrides: Partial<CreditPackage> = {}): CreditPackage {
  return {
    name: 'Bonus Pack',
    unit: 'credits',
    remaining: 100,
    total: 100,
    used: 0,
    active: true,
    cycleStartTime: '',
    cycleEndTime: '',
    expiredTime: '',
    deductionEndTime: NOW + 30 * DAY,
    ...overrides,
  }
}

/** 后端签名：吃整份 CreditBalance + windowMs；前端：吃 packages + windowDays。 */
function backendSplit(packages: CreditPackage[], windowDays = WINDOW_DAYS, now = NOW) {
  return splitBuddyCreditsByExpiry(
    { total: 0, packages, expiredTotal: 0 } as CreditBalance,
    now,
    windowDays * DAY,
  )
}

describe('splitCreditsByExpiry（前端分桶）', () => {
  it('14 天内到期算临时，更久算永久', () => {
    expect(splitCreditsByExpiry([pkg({ deductionEndTime: NOW + 9 * DAY })], WINDOW_DAYS, NOW))
      .toEqual({ expiring: 100, permanent: 0 })
    expect(splitCreditsByExpiry([pkg({ deductionEndTime: NOW + 3008 * DAY })], WINDOW_DAYS, NOW))
      .toEqual({ expiring: 0, permanent: 100 })
  })

  it('恰好 15 天归永久（判据是"不足 15 天"）', () => {
    expect(splitCreditsByExpiry([pkg({ deductionEndTime: NOW + 15 * DAY })], WINDOW_DAYS, NOW))
      .toEqual({ expiring: 0, permanent: 100 })
  })

  it('失效包与零余额包不计入', () => {
    expect(splitCreditsByExpiry([
      pkg({ active: false, remaining: 999, deductionEndTime: NOW + DAY }),
      pkg({ remaining: 0 }),
      pkg({ remaining: 100, deductionEndTime: NOW + 20 * DAY }),
    ], WINDOW_DAYS, NOW)).toEqual({ expiring: 0, permanent: 100 })
  })

  it('到期时间未知归永久（保守方向）', () => {
    expect(splitCreditsByExpiry([
      pkg({ deductionEndTime: undefined }),
      pkg({ deductionEndTime: 0 }),
      pkg({ deductionEndTime: Number.NaN }),
    ], WINDOW_DAYS, NOW)).toEqual({ expiring: 0, permanent: 300 })
  })

  /**
   * ⚠️ 窗口不可用时**必须返回 null**（而不是 0/0）：调用方据此不渲染分类行。
   * 把"不知道窗口"渲染成"临时 0 · 永久 0"是在说谎 —— 非 buddy provider 的
   * 积分根本没有这个维度（后端不给它们带 windowDays，于是这里是 undefined/null；
   * 而 `Number(null) === 0`，不显式挡住就会被当成"窗口 0 天"）。
   */
  it('窗口缺省或非法时返回 null，不编造分类', () => {
    const packages = [pkg()]
    for (const bad of [undefined, null, NaN, -1, 'abc']) {
      expect(splitCreditsByExpiry(packages, bad as never, NOW), String(bad)).toBeNull()
    }
  })

  it('packages 非数组时返回 null（响应形状异常不崩）', () => {
    expect(splitCreditsByExpiry(undefined as never, WINDOW_DAYS, NOW)).toBeNull()
    expect(splitCreditsByExpiry('nope' as never, WINDOW_DAYS, NOW)).toBeNull()
  })

  it('now 非法时退回当前时间而不是算出 NaN', () => {
    const split = splitCreditsByExpiry([pkg({ deductionEndTime: Date.now() + 9 * DAY })], WINDOW_DAYS, NaN)
    expect(split).toEqual({ expiring: 100, permanent: 0 })
  })
})

/**
 * ⚠️ **对账**：同一组 fixture 喂前后端，两桶必须逐分不差。
 * 这是本文件存在的核心理由 —— 见文件头。
 */
describe('与后端 splitBuddyCreditsByExpiry 对账', () => {
  const fixtures: Array<[string, CreditPackage[], number?]> = [
    ['9 天的 Bonus Pack', [pkg({ remaining: 250, deductionEndTime: NOW + 9 * DAY })]],
    ['3008 天的套餐', [pkg({ name: 'Free Plan Subscription', remaining: 100, deductionEndTime: NOW + 3008 * DAY })]],
    ['恰好 15 天线', [pkg({ deductionEndTime: NOW + 15 * DAY })]],
    ['差 1 毫秒满 15 天', [pkg({ deductionEndTime: NOW + 15 * DAY - 1 })]],
    ['差 1 毫秒不足 15 天', [pkg({ deductionEndTime: NOW + 15 * DAY + 1 })]],
    ['临时与永久混合', [
      pkg({ remaining: 250, deductionEndTime: NOW + 9 * DAY }),
      pkg({ name: '裂变包', remaining: 100, deductionEndTime: NOW + 17 * DAY }),
      pkg({ name: '套餐', remaining: 100, deductionEndTime: NOW + 3008 * DAY }),
    ]],
    ['失效包', [pkg({ active: false, remaining: 500, deductionEndTime: NOW + DAY })]],
    ['本周期余额为 0（终身还有钱的套餐）', [pkg({ remaining: 0, total: 500 })]],
    ['到期时间未知', [pkg({ deductionEndTime: undefined })]],
    ['到期时间已越过', [pkg({ remaining: 30, deductionEndTime: NOW - DAY })]],
    ['脏余额', [pkg({ remaining: -5 }), pkg({ remaining: Number.NaN }), pkg({ remaining: 7.5 })]],
    ['浮点尾数', [
      pkg({ remaining: 74.61000076, deductionEndTime: NOW + 9 * DAY }),
      pkg({ remaining: 125.39, deductionEndTime: NOW + 10 * DAY }),
    ]],
    ['空列表', []],
    ['窗口放宽到 31 天', [pkg({ remaining: 100, deductionEndTime: NOW + 17 * DAY })], 31],
  ]

  for (const [label, packages, windowDays] of fixtures) {
    const days = windowDays ?? WINDOW_DAYS
    it(label, () => {
      expect(splitCreditsByExpiry(packages, days, NOW)).toEqual(backendSplit(packages, days, NOW))
    })
  }

  /**
   * 时间流动也要一致：同一份 fixture 在不同 now 下，两侧必须同步改判。
   * （面板渲染时传 Date.now()，选号时传 selector 的 now —— 两者可能相差几十秒。）
   */
  it('时间前进后两侧同步越线', () => {
    const packages = [pkg({ remaining: 100, deductionEndTime: NOW + 15 * DAY + 30_000 })]
    expect(splitCreditsByExpiry(packages, WINDOW_DAYS, NOW))
      .toEqual(backendSplit(packages, WINDOW_DAYS, NOW))
    // 40 秒后越过 15 天线
    const later = NOW + 40_000
    expect(splitCreditsByExpiry(packages, WINDOW_DAYS, later)).toEqual({ expiring: 100, permanent: 0 })
    expect(splitCreditsByExpiry(packages, WINDOW_DAYS, later))
      .toEqual(backendSplit(packages, WINDOW_DAYS, later))
  })
})

describe('daysUntilExpiry / expiryBucketLabel', () => {
  it('给出距到期天数；无到期时间返回 null', () => {
    expect(daysUntilExpiry(pkg({ deductionEndTime: NOW + 9 * DAY }), NOW)).toBeCloseTo(9, 6)
    expect(daysUntilExpiry(pkg({ deductionEndTime: undefined }), NOW)).toBeNull()
    expect(daysUntilExpiry(pkg({ deductionEndTime: 0 }), NOW)).toBeNull()
  })

  it('窗口内标「N 天内到期」，窗口外标「还有 N 天」', () => {
    expect(expiryBucketLabel(pkg({ deductionEndTime: NOW + 9 * DAY }), WINDOW_DAYS, NOW))
      .toBe('9 天内到期')
    expect(expiryBucketLabel(pkg({ deductionEndTime: NOW + 3008 * DAY }), WINDOW_DAYS, NOW))
      .toBe('还有 3008 天')
    // 不足 1 天向上取整为 1，避免出现「0 天内到期」
    expect(expiryBucketLabel(pkg({ deductionEndTime: NOW + 60_000 }), WINDOW_DAYS, NOW))
      .toBe('1 天内到期')
    expect(expiryBucketLabel(pkg({ deductionEndTime: undefined }), WINDOW_DAYS, NOW))
      .toBe('到期时间未知')
  })

  /**
   * 拿不到窗口时返回 **null**，让调用方降级 —— 这是有意的：分类标签（「N 天内
   * 到期」）需要窗口才有意义，而客观天数由 `formatPackageLine` 自己拼出来
   * （「距到期 9 天」），不依赖窗口。用一个"假装是分类"的字符串会误导。
   */
  it('拿不到窗口时返回 null，由调用方降级为只显示天数', () => {
    expect(expiryBucketLabel(pkg({ deductionEndTime: NOW + 9 * DAY }), null, NOW)).toBeNull()
    expect(expiryBucketLabel(pkg({ deductionEndTime: NOW + 9 * DAY }), undefined, NOW)).toBeNull()
    // 但到期时间未知仍给确定文案（它不依赖窗口）
    expect(expiryBucketLabel(pkg({ deductionEndTime: undefined }), null, NOW)).toBe('到期时间未知')
  })
})

describe('formatExpirySplitLine（卡片那一行）', () => {
  const format = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(2))

  /**
   * ⚠️ **永久在前、临时在后**（用户 2026-09-29 要求）：与 Loomy 那行的
   * 「永久 … · 每日 …」同一顺序，两个 provider 的卡片读起来才对齐。
   *
   * 小数按两位显示（`100.50`）—— 与卡片上**总额**用的 `formatCredits` 同一口径，
   * 服务端精确值本就带小数（实测 `74.61000076`），这里不另立规则。
   */
  it('永久在前、临时在后', () => {
    expect(formatExpirySplitLine({ expiring: 250, permanent: 100.5 }, format))
      .toBe('永久 100.50 · 临时 250')
    expect(formatExpirySplitLine({ expiring: 74.61, permanent: 0 }, format))
      .toBe('永久 0 · 临时 74.61')
  })

  it('分类不可用时返回 null（调用方据此不渲染）', () => {
    expect(formatExpirySplitLine(null, format)).toBeNull()
  })

  /**
   * 全 0 也要显示 —— 「临时 0」正是「锁定永久积分后为什么没有可用账号」的答案
   * （实测中国版那个号就是永久 10064 · 临时 0：明明有分却全被判永久）。
   * 隐藏它会让用户对着有余额的卡片困惑。
   */
  it('两桶皆 0 仍显示（这是锁定失效的线索）', () => {
    expect(formatExpirySplitLine({ expiring: 0, permanent: 0 }, format)).toBe('永久 0 · 临时 0')
  })
})
