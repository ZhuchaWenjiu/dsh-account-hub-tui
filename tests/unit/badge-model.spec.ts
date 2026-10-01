import { describe, expect, it } from 'vitest'
import {
  BADGE_PREFERENCE_LABELS,
  BADGE_PREFERENCES,
  DEFAULT_BADGE_PREFERENCE,
  badgeView,
  creditGroupsOf,
  formatUpdatedAt,
  normalizeBadgePreference,
  planGroupsOf,
  windowPreview,
} from '../../plugin-src/client/badge-model.js'
// 宿主侧的同一份枚举：两边必须逐字一致（`usage.badgePreference` 会拒绝非法值）
import { BADGE_PREFERENCES as HOST_BADGE_PREFERENCES } from '../../src/badge-preferences.js'
import { formatUnits, unitLabel } from '../../plugin-src/client/credits-format.js'

/**
 * 用量徽标**折叠态**的纯逻辑回归（不依赖 react，故可直接 import 真实现）。
 *
 * 锁的是「用户定的口径」本身：**窗口 > 套餐包 > 积分**（2026-10-01 定），
 * 以及三态偏好对它的影响。每一条文案断言都是完整字符串 —— 徽标上就是这一行
 * 字，改口径必然改文案，用例会红。
 */

/** 构造余额行。 */
function row(accountId, packages, error) {
  const balance = packages === null
    ? null
    : { total: packages.reduce((sum, item) => sum + item.remaining, 0), packages, expiredTotal: 0 }
  return { accountId, nickname: accountId, balance, ...error === undefined ? {} : { error } }
}

/** 构造资源包。 */
function pkg(name, remaining, unit = 'credits') {
  return { name, unit, remaining, total: remaining, used: 0, active: true, cycleStartTime: '', cycleEndTime: '', expiredTime: '' }
}

describe('偏好枚举与宿主同步', () => {
  it('三态取值与宿主完全一致', () => {
    expect([...BADGE_PREFERENCES]).toEqual([...HOST_BADGE_PREFERENCES])
    expect(DEFAULT_BADGE_PREFERENCE).toBe('auto')
  })

  it('每个档位都有中文展示名（弹窗里的三态开关）', () => {
    for (const value of BADGE_PREFERENCES) {
      expect(typeof BADGE_PREFERENCE_LABELS[value], value).toBe('string')
      expect(BADGE_PREFERENCE_LABELS[value].length).toBeGreaterThan(0)
    }
  })

  it('归一化：未知值 / 大小写变体 / 非字符串一律回落到默认', () => {
    expect(normalizeBadgePreference('credits')).toBe('credits')
    expect(normalizeBadgePreference('Credits')).toBe('auto')
    expect(normalizeBadgePreference(undefined)).toBe('auto')
    expect(normalizeBadgePreference(null)).toBe('auto')
    expect(normalizeBadgePreference(1)).toBe('auto')
  })
})

describe('窗口预览', () => {
  it('只取前两个，且已知窗口按固定顺序（five_hour → weekly → monthly）', () => {
    expect(windowPreview([
      { type: 'monthly', percentUsed: 48 },
      { type: 'weekly', percentUsed: 2 },
      { type: 'five_hour', percentUsed: 6 },
    ])).toEqual([
      { type: 'five_hour', label: '5 小时', percent: 6 },
      { type: 'weekly', label: '本周', percent: 2 },
    ])
  })

  it('缺失的已知窗口顺延给未知窗口（网关新增窗口也能显示）', () => {
    expect(windowPreview([
      { type: 'weekly', percentUsed: 10 },
      { type: 'daily', percentUsed: 3 },
    ])).toEqual([
      { type: 'weekly', label: '本周', percent: 10 },
      { type: 'daily', label: 'daily', percent: 3 },
    ])
  })

  it('百分比夹取到 0–100（网关下发 120 / -5 都不该画到条外）', () => {
    expect(windowPreview([{ type: 'five_hour', percentUsed: 120 }])[0].percent).toBe(100)
    expect(windowPreview([{ type: 'five_hour', percentUsed: -5 }])[0].percent).toBe(0)
    expect(windowPreview([{ type: 'five_hour', percentUsed: 'abc' }])[0].percent).toBe(0)
  })

  it('非数组输入不炸（脏数据兜底）', () => {
    expect(windowPreview(undefined)).toEqual([])
    expect(windowPreview(null)).toEqual([])
  })
})

describe('积分的按单位分组', () => {
  it('单账号：合计即该账号余额', () => {
    const groups = creditGroupsOf([row('a', [pkg('Bonus Pack', 100), pkg('Free Plan', 96.87)])])
    expect(groups.groups).toEqual([{ unit: 'credits', label: '积分', total: 196.87, accountCount: 1 }])
    expect(groups.failedCount).toBe(0)
    expect(groups.okCount).toBe(1)
  })

  it('多账号：按单位求和，**绝不跨单位相加**', () => {
    const groups = creditGroupsOf([
      row('a', [pkg('Bonus Pack', 100)]),
      row('b', [pkg('Bonus Pack', 50)]),
      row('c', [pkg('GLM-5.2', 94_539_275, 'token')]),
    ])
    expect(groups.groups).toEqual([
      { unit: 'credits', label: '积分', total: 150, accountCount: 2 },
      { unit: 'token', label: 'Token', total: 94_539_275, accountCount: 1 },
    ])
  })

  it('失败的账号不进合计，只计入 failedCount（0 与「查不到」必须分开）', () => {
    const groups = creditGroupsOf([row('a', [pkg('Bonus Pack', 10)]), row('b', null, '凭据未配置')])
    expect(groups.groups[0].total).toBe(10)
    expect(groups.failedCount).toBe(1)
    expect(groups.okCount).toBe(1)
  })

  it('一个包都没有时按空单位分组（显示为「积分」）', () => {
    const groups = creditGroupsOf([{ accountId: 'a', nickname: 'a', balance: { total: 5, packages: [], expiredTotal: 0 } }])
    expect(groups.groups).toEqual([{ unit: '', label: '积分', total: 5, accountCount: 1 }])
  })
})

describe('套餐的归组', () => {
  it('按（包名 + 单位）求和，给出账号数与最早到期时刻', () => {
    const groups = planGroupsOf([
      { accountId: 'a', plan: { name: 'Free Plan Subscription', remaining: 100, total: 200, unit: 'credits', deductionEndTime: 900 } },
      { accountId: 'b', plan: { name: 'Free Plan Subscription', remaining: 300, total: 300, unit: 'credits', deductionEndTime: 500 } },
      { accountId: 'c', plan: { name: 'Bonus Plan', remaining: 50, total: 50, unit: 'credits' } },
    ])
    expect(groups[0]).toMatchObject({ name: 'Free Plan Subscription', remaining: 400, total: 500, accountCount: 2, deductionEndTime: 500 })
    // 排序按剩余降序 ⇒ 折叠态取第一条就是「最大的那份套餐」
    expect(groups.map((group) => group.name)).toEqual(['Free Plan Subscription', 'Bonus Plan'])
  })

  it('plan 为 null 的账号被跳过；单位不同不合并', () => {
    const groups = planGroupsOf([
      { accountId: 'a', plan: null },
      { accountId: 'b', plan: { name: '套餐', remaining: 1, total: 2, unit: 'token' } },
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0].unit).toBe('token')
    expect(groups[0].label).toBe('Token')
  })
})

describe('badgeView：模式与文案', () => {
  const windows = {
    kind: 'windows',
    accounts: [{ accountId: 'a', nickname: 'a', ok: true, windows: [
      { type: 'five_hour', percentUsed: 6, resetsAt: '' },
      { type: 'weekly', percentUsed: 2, resetsAt: '' },
    ] }],
  }
  const plan = {
    kind: 'plan',
    accounts: [{ accountId: 'a', nickname: 'a', plan: { name: 'Free Plan Subscription', remaining: 300, total: 500, unit: 'credits' } }],
  }

  it('auto：有窗口显示窗口（与参考实现同款文案）', () => {
    const view = badgeView({ providerLabel: 'Cline', preference: 'auto', subscription: windows, accounts: [row('a', [pkg('Cline 账户余额', 5)])] })
    expect(view.mode).toBe('windows')
    expect(view.text).toBe('Cline · 5 小时 6% · 本周 2%')
    expect(view.tone).toBe('ok')
  })

  it('auto：无窗口有套餐时显示套餐（剩余 / 总量 + 单位）', () => {
    const view = badgeView({ providerLabel: 'CodeBuddy', preference: 'auto', subscription: plan, accounts: [row('a', [pkg('Bonus Pack', 20)])] })
    expect(view.mode).toBe('plan')
    expect(view.text).toBe('CodeBuddy · Free Plan Subscription 300 / 500 积分')
  })

  it('auto：两者都没有时显示积分合计', () => {
    const view = badgeView({
      providerLabel: 'CodeBuddy',
      preference: 'auto',
      subscription: undefined,
      accounts: [row('a', [pkg('Bonus Pack', 100)]), row('b', [pkg('Bonus Pack', 96.87)])],
    })
    expect(view.mode).toBe('credits')
    expect(view.text).toBe('CodeBuddy · 合计 196.87 积分')
  })

  it('credits 偏好：即使有窗口也显示积分（套餐误判时的兜底开关）', () => {
    const view = badgeView({ providerLabel: 'Cline', preference: 'credits', subscription: windows, accounts: [row('a', [pkg('Cline 账户余额', 5)])] })
    expect(view.mode).toBe('credits')
    expect(view.text).toBe('Cline · 合计 5 积分')
  })

  it('subscription 偏好：行为与 auto 相同（窗口优先，其次套餐）', () => {
    const view = badgeView({ providerLabel: 'CodeBuddy', preference: 'subscription', subscription: plan, accounts: [row('a', [pkg('Bonus Pack', 20)])] })
    expect(view.mode).toBe('plan')
  })

  it('窗口存在但一条都没有时**回落**到积分（不能显示成只有渠道名）', () => {
    const empty = { kind: 'windows', accounts: [{ accountId: 'a', nickname: 'a', ok: true, windows: [] }] }
    const view = badgeView({ providerLabel: 'Cline', preference: 'auto', subscription: empty, accounts: [row('a', [pkg('Cline 账户余额', 12)])] })
    expect(view.mode).toBe('credits')
    expect(view.text).toBe('Cline · 合计 12 积分')
  })

  it('窗口取第一个**读到数**的账号（失败的账号不参与）', () => {
    const mixed = {
      kind: 'windows',
      accounts: [
        { accountId: 'bad', nickname: 'bad', ok: false, windows: [], error: '凭据未配置' },
        { accountId: 'good', nickname: 'good', ok: true, windows: [{ type: 'five_hour', percentUsed: 33, resetsAt: '' }] },
      ],
    }
    const view = badgeView({ providerLabel: 'Cline', preference: 'auto', subscription: mixed, accounts: [row('good', [pkg('Cline 账户余额', 1)])] })
    expect(view.text).toBe('Cline · 5 小时 33%')
  })

  it('token 渠道按 M 显示（ZCode 的 1 亿 token 不能画成「1 亿积分」）', () => {
    const view = badgeView({
      providerLabel: 'ZCode (智谱)',
      preference: 'credits',
      subscription: undefined,
      accounts: [row('a', [pkg('GLM-5.2', 94_539_275, 'token')])],
    })
    expect(view.text).toBe('ZCode (智谱) · 合计 94.54M Token')
  })

  it('没有启用账号 → 明确文案；全部读取失败 → 另一句（下一步动作不同）', () => {
    const none = badgeView({ providerLabel: 'CodeBuddy', preference: 'auto', subscription: undefined, accounts: [] })
    expect(none.mode).toBe('empty')
    expect(none.text).toBe('CodeBuddy · 未配置启用账号')
    expect(none.tone).toBe('muted')

    const allFailed = badgeView({ providerLabel: 'CodeBuddy', preference: 'auto', subscription: undefined, accounts: [row('a', null, '凭据未配置')] })
    expect(allFailed.mode).toBe('empty')
    expect(allFailed.text).toBe('CodeBuddy · 用量不可用')
    expect(allFailed.tone).toBe('error')
    expect(allFailed.failureReason).toBe('凭据未配置')
  })
})

describe('badgeView：色调', () => {
  function toneOfWindows(percent) {
    return badgeView({
      providerLabel: 'Cline',
      preference: 'auto',
      subscription: { kind: 'windows', accounts: [{ accountId: 'a', nickname: 'a', ok: true, windows: [{ type: 'five_hour', percentUsed: percent, resetsAt: '' }] }] },
      accounts: [row('a', [pkg('Cline 账户余额', 1)])],
    }).tone
  }

  it('窗口：≥90 红 / ≥70 黄 / 其余绿（取最紧张的那个窗口）', () => {
    expect(toneOfWindows(95)).toBe('error')
    expect(toneOfWindows(70)).toBe('warn')
    expect(toneOfWindows(12)).toBe('ok')
  })

  it('套餐耗尽与积分为 0 都提示（warn，而不是当成错误）', () => {
    const planEmpty = badgeView({
      providerLabel: 'CodeBuddy',
      preference: 'auto',
      subscription: { kind: 'plan', accounts: [{ accountId: 'a', plan: { name: 'Free Plan', remaining: 0, total: 100, unit: 'credits' } }] },
      accounts: [row('a', [pkg('Bonus Pack', 0)])],
    })
    expect(planEmpty.tone).toBe('warn')

    const creditsEmpty = badgeView({ providerLabel: 'CodeBuddy', preference: 'credits', subscription: undefined, accounts: [row('a', [pkg('Bonus Pack', 0)])] })
    expect(creditsEmpty.mode).toBe('credits')
    expect(creditsEmpty.tone).toBe('warn')
  })
})

describe('formatUpdatedAt', () => {
  it('含日期与秒（宿主是长生命周期进程，只有时钟会让昨天的读数看起来像刚刚）', () => {
    const at = new Date(2026, 9, 1, 16, 39, 32).getTime()
    expect(formatUpdatedAt(at)).toBe('2026/10/1 16:39:32')
  })

  it('非法值返回空串（不显示 NaN）', () => {
    expect(formatUpdatedAt(undefined)).toBe('')
    expect(formatUpdatedAt(Number.NaN)).toBe('')
  })
})

describe('与设置页共用同一套格式化（防止两处数字不一致）', () => {
  it('数字与单位标签都走 credits-format', () => {
    expect(formatUnits(196.87, 'credits')).toBe('196.87')
    expect(formatUnits(94_539_275, 'token')).toBe('94.54M')
    expect(unitLabel('token')).toBe('Token')
    expect(unitLabel(undefined)).toBe('积分')
  })
})
