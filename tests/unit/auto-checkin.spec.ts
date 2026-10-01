import { describe, expect, it } from 'vitest'
import {
  AUTO_CHECKIN_DELAY_MS,
  DEFAULT_AUTO_CHECKIN,
  DSH_JET_HUB_AUTO_CHECKIN_DELAY_MS,
  autoCheckinDelayMs,
  createAutoCheckin,
  describeRun,
  isUnsupportedCheckin,
  sanitizeAutoCheckin,
  shouldMarkToday,
  utc8DateString,
  type AutoCheckinDeps,
  type AutoCheckinDoc,
  type AutoCheckinStore,
} from '../../src/auto-checkin.js'
import type { BadgeRpcResult } from '../../src/usage-badge.js'
import type { RpcCreditsClaimAllResponse } from '../../src/types.js'

/**
 * 「每日首次启动自动签到」的回归测试。
 *
 * 锁六件事，每件都对应一个真实会出问题的场景：
 * 1. **日界是 UTC+8**（各渠道的每日额度都按 UTC+8 结算）—— 取本机时区会
 *    「偏东漏签一天 / 偏西一天跑两次」；
 * 2. **开关默认关闭**，关闭时**一个上游请求都不发**（这是代用户打的写操作）；
 * 3. **当天只跑一次**（用户要求「不多次重复触发」）；
 * 4. **不支持的渠道不算失败**（判据交给 `claimAll` 的信封，本模块不建第二份名单）；
 * 5. **整轮零成功零已领时「今天」不记账** ⇒ 下次启动重试（凭据还没续上 / 网络不通）；
 * 6. **在飞去重**：启动排定与「刚打开开关」同时想跑时只跑一轮。
 *
 * ⚠️ 全部用例零网络、零文件系统、零等待（`schedule` 注入、时钟注入）。
 */

/** 可控时钟（用例里只用它推进时间）。 */
function clock(start: number) {
  let now = start
  return { now: () => now, set: (value: number) => { now = value } }
}

/** 2026-10-02 12:00（UTC+8）= 04:00Z。 */
const NOON_UTC8 = Date.UTC(2026, 9, 2, 4, 0, 0)

/** 内存文档后端（记录写入次数，便于断言「今天只记一次」）。 */
function memoryStore(initial: Partial<AutoCheckinDoc> = {}) {
  let doc: AutoCheckinDoc = { ...DEFAULT_AUTO_CHECKIN, ...initial }
  const saves: AutoCheckinDoc[] = []
  const store: AutoCheckinStore = {
    kind: 'memory',
    load: () => ({ ...doc }),
    save: async (next) => {
      doc = { ...next }
      saves.push({ ...next })
    },
  }
  return { store, saves, current: () => ({ ...doc }) }
}

/** 构造一个 claimAll 成功信封。 */
function ok(partial: Partial<RpcCreditsClaimAllResponse['summary']> = {}): BadgeRpcResult<RpcCreditsClaimAllResponse> {
  const summary = { claimed: 0, totalCredit: 0, alreadyClaimed: 0, inactive: 0, failed: 0, ...partial }
  return { ok: true, value: { results: [], summary } }
}

/** 构造一个「不支持每日签到」的错误信封（`claimAll` 的 cline / raccoon / workbuddy 分支）。 */
function unsupported(message = 'Cline 不支持每日签到（其后端没有签到接口）'): BadgeRpcResult<RpcCreditsClaimAllResponse> {
  return { ok: false, error: { code: 'bad-request', message } }
}

/** 组装执行体：默认「开关开着、今天没跑过、两个渠道」。 */
function makeRunner(options: {
  initial?: Partial<AutoCheckinDoc>
  providers?: string[]
  claim?: AutoCheckinDeps['claim']
  now?: () => number
  delayMs?: number
} = {}) {
  const time = clock(options.now === undefined ? NOON_UTC8 : options.now())
  const store = memoryStore({ enabled: true, ...options.initial })
  const calls: string[] = []
  const warnings: string[] = []
  const scheduled: Array<{ fn: () => void; ms: number; cancelled: boolean }> = []
  const deps: AutoCheckinDeps = {
    store: store.store,
    listProviderIds: async () => options.providers ?? ['buddy', 'qoder'],
    claim: options.claim ?? (async (provider) => {
      calls.push(provider)
      return ok({ claimed: 1, totalCredit: 100 })
    }),
    now: options.now === undefined ? time.now : options.now,
    delayMs: options.delayMs,
    schedule: (fn, ms) => {
      const entry = { fn, ms, cancelled: false }
      scheduled.push(entry)
      return { cancel: () => { entry.cancelled = true } }
    },
    warn: (message) => warnings.push(message),
  }
  return { runner: createAutoCheckin(deps), store, calls, warnings, scheduled, time }
}

describe('自动签到：日界与配置', () => {
  it('日界按 UTC+8 算（跨 16:00Z 才换日）', () => {
    // 2026-10-02 15:59Z = UTC+8 的 10-02 23:59
    expect(utc8DateString(Date.UTC(2026, 9, 2, 15, 59, 0))).toBe('2026-10-02')
    // 2026-10-02 16:00Z = UTC+8 的 10-03 00:00 —— 换日
    expect(utc8DateString(Date.UTC(2026, 9, 2, 16, 0, 0))).toBe('2026-10-03')
    // 本机时区不影响结果（这里只断言与 UTC+8 平移一致）
    expect(utc8DateString(Date.UTC(2026, 0, 1, 0, 0, 0))).toBe('2026-01-01')
  })

  it('开关默认关闭，且脏数据只认显式 true', () => {
    expect(DEFAULT_AUTO_CHECKIN.enabled).toBe(false)
    expect(sanitizeAutoCheckin(undefined).enabled).toBe(false)
    expect(sanitizeAutoCheckin({ enabled: 'true' }).enabled).toBe(false)
    expect(sanitizeAutoCheckin({ enabled: 1 }).enabled).toBe(false)
    expect(sanitizeAutoCheckin({ enabled: true }).enabled).toBe(true)
  })

  it('lastDate 必须是 YYYY-MM-DD，否则回落空串（脏数据不该让当天被判为已跑）', () => {
    expect(sanitizeAutoCheckin({ lastDate: '2026-10-02' }).lastDate).toBe('2026-10-02')
    expect(sanitizeAutoCheckin({ lastDate: '2026/10/02' }).lastDate).toBe('')
    expect(sanitizeAutoCheckin({ lastDate: 20261002 }).lastDate).toBe('')
    expect(sanitizeAutoCheckin({ lastDate: '' }).lastDate).toBe('')
  })

  it('延迟配置：0 是合法值（不能被 || 吃掉），非法值回落默认', () => {
    expect(autoCheckinDelayMs({})).toBe(AUTO_CHECKIN_DELAY_MS)
    expect(autoCheckinDelayMs({ [DSH_JET_HUB_AUTO_CHECKIN_DELAY_MS]: '0' })).toBe(0)
    expect(autoCheckinDelayMs({ [DSH_JET_HUB_AUTO_CHECKIN_DELAY_MS]: '1500' })).toBe(1500)
    expect(autoCheckinDelayMs({ [DSH_JET_HUB_AUTO_CHECKIN_DELAY_MS]: '-1' })).toBe(AUTO_CHECKIN_DELAY_MS)
    expect(autoCheckinDelayMs({ [DSH_JET_HUB_AUTO_CHECKIN_DELAY_MS]: 'abc' })).toBe(AUTO_CHECKIN_DELAY_MS)
  })
})

describe('自动签到：执行判据', () => {
  it('开关关闭时一个请求都不发，也不写盘', async () => {
    const { runner, calls, store } = makeRunner({ initial: { enabled: false } })
    await runner.runIfDue()
    expect(calls).toEqual([])
    expect(store.saves).toEqual([])
    expect(runner.state()).toMatchObject({ enabled: false, ranToday: false, running: false })
  })

  it('跑过之后：遍历全部有账号的渠道，写盘一次，状态变「今天已跑」', async () => {
    const { runner, calls, store } = makeRunner({
      claim: async (provider) => {
        calls.push(provider)
        return ok({ claimed: 2, totalCredit: 300 })
      },
    })
    await runner.runIfDue()
    expect(calls).toEqual(['buddy', 'qoder'])
    expect(store.saves).toHaveLength(1)
    expect(store.current()).toMatchObject({ lastDate: '2026-10-02', enabled: true })
    expect(store.current().lastResult).toContain('2 个渠道')
    expect(runner.state()).toMatchObject({ ranToday: true, running: false })
    // 同一天再跑：一次请求都不发（用户要求「不多次重复触发」）
    calls.length = 0
    await runner.runIfDue()
    expect(calls).toEqual([])
    expect(store.saves).toHaveLength(1)
  })

  it('换到第二天会重新跑（lastDate 不等于今天）', async () => {
    const time = clock(NOON_UTC8)
    const { runner, calls } = makeRunner({ now: time.now, initial: { lastDate: '2026-10-01' } })
    await runner.runIfDue()
    expect(calls).toEqual(['buddy', 'qoder'])
  })

  it('「不支持每日签到」计为跳过，不算失败、不重试', async () => {
    const { runner, calls, warnings } = makeRunner({
      providers: ['buddy', 'cline', 'raccoon', 'workbuddy', 'qoder'],
      claim: async (provider) => {
        calls.push(provider)
        if (provider === 'cline' || provider === 'raccoon') return unsupported()
        if (provider === 'workbuddy') return unsupported('WorkBuddy 国际版不支持每日签到（其后端没有签到接口）')
        return ok({ alreadyClaimed: 1 })
      },
    })
    await runner.runIfDue()
    const state = runner.state()
    expect(calls).toHaveLength(5)
    // 跳过 3 个、正常 2 个；摘要里明说跳过的数量，且不出现「失败」
    expect(state.lastResult).toContain('3 个渠道不支持签到')
    expect(state.lastResult).not.toContain('失败')
    expect(warnings.some((w) => w.includes('不支持每日签到'))).toBe(false)
  })

  it('整轮零成功零已领 ⇒ 不记「今天」（下次启动重试）', async () => {
    const { runner, store, warnings } = makeRunner({
      claim: async () => ({ ok: false, error: { code: 'unauthorized', message: '凭据已过期' } }),
    })
    await runner.runIfDue()
    expect(store.saves).toEqual([])
    expect(runner.state().ranToday).toBe(false)
    expect(warnings.some((w) => w.includes('未记入今日'))).toBe(true)
  })

  it('有成功也有失败 ⇒ 记账（否则一个坏账号会让好账号每次启动都被重领）', async () => {
    const { runner, store } = makeRunner({
      providers: ['buddy', 'qoder'],
      claim: async (provider) => provider === 'buddy'
        ? ok({ claimed: 1, totalCredit: 100 })
        : { ok: false, error: { code: 'unauthorized', message: '凭据已过期' } },
    })
    await runner.runIfDue()
    expect(store.saves).toHaveLength(1)
    expect(runner.state().lastResult).toContain('1 个渠道出错')
  })

  it('账号池读不出来 ⇒ 不记账（不把「读不到」当成「今天跑过了」）', async () => {
    const store = memoryStore({ enabled: true })
    const warnings: string[] = []
    const runner = createAutoCheckin({
      store: store.store,
      listProviderIds: async () => { throw new Error('store broken') },
      claim: async () => ok({ claimed: 1 }),
      now: () => NOON_UTC8,
      warn: (m) => warnings.push(m),
    })
    await runner.runIfDue()
    expect(store.saves).toEqual([])
    expect(warnings.some((w) => w.includes('读取账号池失败'))).toBe(true)
  })

  it('在飞去重：并发调用只跑一轮', async () => {
    let claimCalls = 0
    const { runner } = makeRunner({
      providers: ['buddy'],
      claim: async () => {
        claimCalls += 1
        await new Promise((resolve) => setTimeout(resolve, 5))
        return ok({ claimed: 1 })
      },
    })
    await Promise.all([runner.runIfDue(), runner.runIfDue(), runner.runIfDue()])
    expect(claimCalls).toBe(1)
  })
})

describe('自动签到：开关与启动排定', () => {
  it('打开开关会立刻尝试一轮（今天没跑过），且 running 立刻为 true', async () => {
    const { runner, calls } = makeRunner({ initial: { enabled: false } })
    const state = await runner.setEnabled(true)
    expect(state.enabled).toBe(true)
    // runIfDue 在 setEnabled 内被同步启动 ⇒ 这一瞬间 running 已为 true
    expect(state.running).toBe(true)
    await runner.runIfDue()
    expect(calls).toEqual(['buddy', 'qoder'])
  })

  it('今天已跑过时打开开关不会重跑', async () => {
    const { runner, calls } = makeRunner({ initial: { enabled: false, lastDate: '2026-10-02' } })
    const state = await runner.setEnabled(true)
    expect(state).toMatchObject({ enabled: true, ranToday: true, running: false })
    await runner.runIfDue()
    expect(calls).toEqual([])
  })

  it('关闭开关不触发任何请求，但保留当日记录（避免关一下又开就重跑）', async () => {
    const { runner, calls, store } = makeRunner({ initial: { enabled: true, lastDate: '2026-10-02' } })
    const state = await runner.setEnabled(false)
    expect(state).toMatchObject({ enabled: false, ranToday: true })
    await runner.runIfDue()
    expect(calls).toEqual([])
    expect(store.current().lastDate).toBe('2026-10-02')
  })

  it('start() 按延迟排定一次；stop() 能取消', async () => {
    const { runner, scheduled, calls } = makeRunner({ delayMs: 30_000 })
    runner.start()
    expect(scheduled).toHaveLength(1)
    expect(scheduled[0]!.ms).toBe(30_000)
    runner.stop()
    expect(scheduled[0]!.cancelled).toBe(true)
    expect(calls).toEqual([])
  })

  it('延迟为 0 时立刻跑（不经过调度器）', async () => {
    const { runner, scheduled, calls } = makeRunner({ delayMs: 0 })
    runner.start()
    expect(scheduled).toEqual([])
    await runner.runIfDue()
    expect(calls).toEqual(['buddy', 'qoder'])
  })

  it('start() 被重复调用只排定一次（插件热替换时不该叠加定时器）', () => {
    const { runner, scheduled } = makeRunner({ delayMs: 1_000 })
    runner.start()
    runner.start()
    expect(scheduled).toHaveLength(1)
  })
})

describe('自动签到：摘要与判据的纯函数', () => {
  it('isUnsupportedCheckin 只认两个窄短语', () => {
    expect(isUnsupportedCheckin('Cline 不支持每日签到（其后端没有签到接口）')).toBe(true)
    expect(isUnsupportedCheckin('unsupported provider: foo')).toBe(true)
    // 反面：真正的错误不能被吞掉
    expect(isUnsupportedCheckin('凭据已过期')).toBe(false)
    expect(isUnsupportedCheckin('unsupported reasoning effort')).toBe(false)
  })

  it('describeRun 汇总各计数；无内容时给可读文案', () => {
    expect(describeRun({
      providers: 3, claimed: 2, totalCredit: 300, alreadyClaimed: 1, inactive: 0, failed: 0, skipped: 1, errors: 0,
    })).toBe('3 个渠道：2 个账号领取成功（+300 积分），1 个今天已领，1 个渠道不支持签到')
    expect(describeRun({
      providers: 2, claimed: 0, totalCredit: 0, alreadyClaimed: 0, inactive: 0, failed: 0, skipped: 0, errors: 0,
    })).toBe('2 个渠道：没有需要领取的账号')
  })

  it('shouldMarkToday：至少一个「领到 / 今天已领」才记账', () => {
    const base = { providers: 1, claimed: 0, totalCredit: 0, alreadyClaimed: 0, inactive: 0, failed: 0, skipped: 0, errors: 0 }
    expect(shouldMarkToday({ ...base, claimed: 1 })).toBe(true)
    expect(shouldMarkToday({ ...base, alreadyClaimed: 1 })).toBe(true)
    expect(shouldMarkToday({ ...base, failed: 2 })).toBe(false)
    expect(shouldMarkToday({ ...base, errors: 1 })).toBe(false)
    expect(shouldMarkToday(base)).toBe(false)
  })
})