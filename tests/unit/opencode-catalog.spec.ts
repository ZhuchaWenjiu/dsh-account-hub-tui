import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  OpencodeAdapter, clearOpencodeCatalogCache, loadOpencodeCatalog, pickSlot,
} from '../../src/opencode-adapter.js'
import {
  clearOpencodeCapabilitiesCache, type OpencodeModelCapability,
} from '../../src/opencode-capability.js'
import { listIdentitySlots, type IdentitySlot } from '../../src/opencode-auth.js'
import { OPENCODE, isFreeOpencodeModel } from '../../src/opencode-product.js'

// ⚠️ 目录缓存是**模块级**的（按槽 id 分桶），不清会让前一个用例的目录
// 泄漏到后一个 —— 表现为「明明给了自定义 fetchRemoteCatalog，
// resolveModel 却拿到别的目录」。这也正是修复「适配器永久 memoize」
// 后必须配套的隔离手段。
beforeEach(() => clearOpencodeCatalogCache())

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/**
 * 构造一个匿名槽。
 *
 * ⚠️ 必须**显式造一条池内条目**（2026-10-02 起匿名通道是账号池里的普通条目，
 * 不再由 `listIdentitySlots` 进程内合成）。用旧写法 `listIdentitySlots([], …).at(-1)`
 * 会拿到 `undefined`。
 */
function anonSlot(): IdentitySlot {
  return listIdentitySlots([{
    id: 'opencode-anon-test',
    enabled: true,
    apiKey: 'public',
    fingerprint: undefined,
  }], 'opencode/1.18.22')[0]!
}

function account(id: string, key = 'sk-x'): IdentitySlot {
  return { ...anonSlot(), id, kind: 'account', apiKey: key }
}

const remoteCatalog = {
  data: [
    { id: 'big-pickle', name: 'Big Pickle' },
    { id: 'claude-opus-4-5', name: 'Claude Opus 4.5' },
  ],
}

/**
 * 把一份最小能力表落进**临时** `DSH_HOME` 的合法磁盘缓存，让紧随其后的
 * `getOpencodeCapabilitiesSync()` 读到它；返回的 `restore()` 必须放在
 * `finally`（或 `afterEach`）里调用。
 *
 * ## ⚠️⚠️ 为什么需要它（本文件那条用例曾经**假绿/假红**的根因）
 *
 * 能力表的真实来源是**运行时抓取**的 models.dev（`opencode-capability.ts`），
 * 磁盘缓存落 `$DSH_HOME/cache/opencode-capabilities.json` —— 它是外部产物、
 * **不入库**。于是：
 * - 作者机器上跑过插件 ⇒ 有缓存 ⇒ 用例绿；
 * - 全新 clone / 从未联网抓过的机器（含 CI）⇒ `memory === []` ⇒
 *   `capability === undefined` ⇒ 兜底链落到 catalog 的 0 ⇒ 用例红。
 *
 * ⇒ 用例必须**自带夹具**，不能依赖机器状态。这里只用既有接口：
 * `clearOpencodeCapabilitiesCache()` 会把 `diskLoaded` 复位（否则
 * `loadDiskCacheSync()` 会因「已读过」而直接返回、忽略我们新写的文件），
 * 然后按 `CapabilityCacheFile`（`version: 2 + entries`）的形状写一份缓存。
 */
async function seedCapabilities(
  entries: readonly OpencodeModelCapability[],
): Promise<{ restore: () => Promise<void> }> {
  const home = await mkdtemp(join(tmpdir(), 'opencode-caps-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  // ⚠️ 顺序不可颠倒：`clear` 会同时清内存与复位 `diskLoaded`，
  // 若先写文件再 clear，文件会被 `unlink` 掉。
  await clearOpencodeCapabilitiesCache()
  await mkdir(join(home, 'cache'), { recursive: true })
  await writeFile(
    join(home, 'cache', 'opencode-capabilities.json'),
    JSON.stringify({ version: 2, at: Date.now(), entries }),
    'utf8',
  )
  return {
    restore: async () => {
      // 在恢复 DSH_HOME **之前**清理：这样 unlink 删的是夹具文件本身
      await clearOpencodeCapabilitiesCache()
      await rm(home, { recursive: true, force: true })
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
    },
  }
}

describe('loadOpencodeCatalog', () => {
  it('实时目录成功时以其为准（**但仍过滤不可达模型**）', async () => {
    const fetcher = vi.fn(async () => jsonResponse(remoteCatalog))
    const entries = await loadOpencodeCatalog(fetcher, anonSlot(), 0)
    // claude-opus-4-5 走已坏的 /v1/messages ⇒ 被过滤掉（真实报障 2026-10-01）
    expect(entries.map((e) => e.id)).toEqual(['big-pickle'])
  })

  it('⚠️⚠️ 远端返回的不可达模型一律不进目录（真实报障 2026-10-01）', async () => {
    // 远端 /v1/models 返回全部 84 个且不含协议信息；不���滤就会让用户点到
    // 必然失败的模型（ling 500 / claude 401 / muse RegionError）。
    const fetcher = vi.fn(async () => jsonResponse({
      data: [
        { id: 'big-pickle' },
        { id: 'ling-3.0-flash-fin-free' },
        { id: 'claude-opus-4-5' },
        { id: 'gpt-5-nano' },
        { id: 'muse-spark-1.3-contributor-free' },
        { id: 'glm-5.2' },
      ],
    }))
    const entries = await loadOpencodeCatalog(fetcher, anonSlot(), 0)
    expect(entries.map((e) => e.id).sort()).toEqual(['big-pickle', 'glm-5.2'])
  })

  it('把当前槽交给 fetcher（URL/请求头由接线层构造，故这里只断言槽）', async () => {
    const fetcher = vi.fn(async () => jsonResponse(remoteCatalog))
    await loadOpencodeCatalog(fetcher, anonSlot(), 0)
    expect(fetcher).toHaveBeenCalledWith(anonSlot())
    // 匿名槽的 Bearer 就是字面量 `public`（接线层用它拼 authorization 头）
    expect(anonSlot().apiKey).toBe('public')
  })

  it('目录失败时回退静态兜底表（不抛错）', async () => {
    const fetcher = vi.fn(async () => new Response('boom', { status: 500 }))
    const entries = await loadOpencodeCatalog(fetcher, anonSlot(), 0)
    expect(entries.length).toBeGreaterThanOrEqual(8)
  })

  it('空 data 时也回退兜底（防上游返回空壳）', async () => {
    const fetcher = vi.fn(async () => jsonResponse({ data: [] }))
    const entries = await loadOpencodeCatalog(fetcher, anonSlot(), 0)
    expect(entries.length).toBeGreaterThanOrEqual(8)
  })

  it('远端条目缺 context 时窗口记 0（不编造）', async () => {
    const fetcher = vi.fn(async () => jsonResponse({ data: [{ id: 'big-pickle' }] }))
    const entries = await loadOpencodeCatalog(fetcher, anonSlot(), 0)
    expect(entries[0]!.contextWindow).toBe(0)
  })

  it('远端下发的免费判定以本地表为准（表外模型不算免费）', async () => {
    // 用一个**在表内但标为付费**的模型来验证「免费判定来自本地表」：
    const fetcher = vi.fn(async () => jsonResponse({ data: [{ id: 'brand-new-free-model' }] }))
    const entries = await loadOpencodeCatalog(fetcher, anonSlot(), 0)
    // 表外模型被可达性闸挡掉 ⇒ 目录回退兜底表（7 条免费）
    expect(entries.every((e) => isFreeOpencodeModel(e.id) || !e.isFree)).toBe(true)
    expect(entries.map((e) => e.id)).not.toContain('brand-new-free-model')
  })

  it('⚠️ 远端把免费模型报成付费也不改判定（以本地实测表为准）', async () => {
    const fetcher = vi.fn(async () => jsonResponse({ data: [{ id: 'big-pickle', cost: 999 }] }))
    const entries = await loadOpencodeCatalog(fetcher, anonSlot(), 0)
    expect(entries[0]!.isFree).toBe(true)
  })

  it('远端 id 重复时去重', async () => {
    const fetcher = vi.fn(async () => jsonResponse({ data: [{ id: 'big-pickle' }, { id: 'big-pickle' }] }))
    const entries = await loadOpencodeCatalog(fetcher, anonSlot(), 0)
    expect(entries).toHaveLength(1)
  })

  it('ttl > 0 时命中内存缓存不重复请求', async () => {
    const fetcher = vi.fn(async () => jsonResponse(remoteCatalog))
    await loadOpencodeCatalog(fetcher, anonSlot(), 60_000)
    await loadOpencodeCatalog(fetcher, anonSlot(), 60_000)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})

describe('pickSlot（平权轮换的槽选择）', () => {
  it('免费模型：按给定顺序轮换（账号槽与匿名槽地位相同）', () => {
    // ⚠️ 匿名槽**不再固定末位**（2026-10-02 起它是池内条目，由用户排序决定
    // 位置）—— 断言改成「按传入顺序」，不再写死匿名 id。
    const slots = [account('a'), account('b'), anonSlot()]
    expect(pickSlot(slots, 'big-pickle', new Set())?.id).toBe('a')
    expect(pickSlot(slots, 'big-pickle', new Set(['a']))?.id).toBe('b')
    expect(pickSlot(slots, 'big-pickle', new Set(['a', 'b']))?.id).toBe('opencode-anon-test')
  })

  it('⚠️ 匿名槽也能排在账号槽前面（用户拖拽决定顺序）', () => {
    const slots = [anonSlot(), account('a')]
    expect(pickSlot(slots, 'big-pickle', new Set())?.id).toBe('opencode-anon-test')
  })

  it('收费模型：跳过匿名槽', () => {
    const slots = [account('a'), anonSlot()]
    expect(pickSlot(slots, 'glm-5.2', new Set())?.id).toBe('a')
    expect(pickSlot(slots, 'glm-5.2', new Set(['a']))).toBeUndefined()
  })

  it('收费模型且只有匿名槽 → 无可用槽', () => {
    expect(pickSlot([anonSlot()], 'glm-5.2', new Set())).toBeUndefined()
  })

  it('excluded 集合里的槽被跳过（tried 机制）', () => {
    const slots = [account('a'), account('b'), anonSlot()]
    expect(pickSlot(slots, 'big-pickle', new Set(['a', 'b', 'opencode-anon-test']))).toBeUndefined()
  })
})

describe('目录可见性', () => {
  /** 目录 fetcher 必须返回 **Response**（契约如此），不能直接给数组。 */
  function catalogOf(entries: Array<{ id: string; name?: string; isFree?: boolean; contextWindow?: number }>) {
    return async () => jsonResponse({
      data: entries.map((e) => ({
        id: e.id,
        name: e.name ?? e.id,
        ...e.contextWindow === undefined ? {} : { context_window: e.contextWindow },
      })),
    })
  }

  function adapter(slots: readonly IdentitySlot[], disabled?: ReadonlySet<string>): OpencodeAdapter {
    return new OpencodeAdapter({
      identitySlots: async () => slots,
      // ⚠️ 两个模型都必须在**实测可达表**内，否则会被可达性闸过滤掉
      // （见 2026-10-02 端点矩阵文档）。claude-* 走已坏的 /v1/messages，
      // 故这里用实测可达的付费模型 glm-5.2 代表「付费」这一类。
      fetchRemoteCatalog: catalogOf([
        { id: 'big-pickle', isFree: true, contextWindow: 262144 },
        { id: 'glm-5.2', isFree: false, contextWindow: 200000 },
      ]),
      ...disabled === undefined ? {} : { disabledModels: () => disabled },
    })
  }

  it('只有匿名槽可用时：只列免费模型', async () => {
    const models = await adapter([anonSlot()]).listModels('opencode')
    expect(models.every((m) => isFreeOpencodeModel(m.id))).toBe(true)
    expect(models.map((m) => m.id)).toContain('big-pickle')
  })

  it('有账号槽时：全目录可见（含付费）', async () => {
    const models = await adapter([account('a'), anonSlot()]).listModels('opencode')
    expect(models.map((m) => m.id)).toContain('glm-5.2')
  })

  it('⚠️ 远端只有付费模型而当前只有匿名槽时：目录为空（DSH 隐藏该 provider 分组）', async () => {
    const only = new OpencodeAdapter({
      identitySlots: async () => [anonSlot()],
      fetchRemoteCatalog: catalogOf([{ id: 'glm-5.2', isFree: false, contextWindow: 200000 }]),
    })
    expect((await only.listModels('opencode')).length).toBe(0)
  })

  it('⚠️ 不可达模型永不出现在目录里（无论有没有账号）', async () => {
    const withAccount = new OpencodeAdapter({
      identitySlots: async () => [account('a'), anonSlot()],
      fetchRemoteCatalog: catalogOf([
        { id: 'big-pickle' },
        { id: 'ling-3.0-flash-fin-free' },
        { id: 'claude-opus-4-5' },
        { id: 'muse-spark-1.3-contributor-free' },
      ]),
    })
    const ids = (await withAccount.listModels('opencode')).map((m) => m.id)
    for (const bad of ['ling-3.0-flash-fin-free', 'claude-opus-4-5', 'muse-spark-1.3-contributor-free']) {
      expect(ids, `${bad} 不该进目录`).not.toContain(bad)
    }
  })

  it('用户黑名单里的模型被剔除', async () => {
    const a = adapter([anonSlot()], new Set(['big-pickle']))
    expect((await a.listModels('opencode')).map((m) => m.id)).not.toContain('big-pickle')
  })
})

describe('resolveModel', () => {
  it('未知模型不编造窗口（宁可 DSH 用默认）', async () => {
    const a = new OpencodeAdapter({ identitySlots: async () => [anonSlot()], fetchRemoteCatalog: async () => jsonResponse({ data: [{ id: 'big-pickle', context_window: 262144 }] }) })
    const resolved = await a.resolveModel('opencode', 'nope-model')
    expect(resolved.context).toBeUndefined()
  })
  // ⚠️ 下面两条的口径在 issue IKJJ68 修复后**变了**：窗口优先取**能力表**
  // （models.dev 的 `limit.context`），catalog 的 `context_window` 只是兜底
  // —— 而 Zen `/v1/models` 实测**从不下发**该字段（85 条只有 4 个基础字段）。
  // 故这两条改用「catalog 给 0」与「未知模型」来锁真正要守的语义。
  it('⚠️ catalog 给 0 窗口时，能力表仍能提供窗口（issue IKJJ68 根因）', async () => {
    // ⚠️⚠️ 本用例原先**依赖机器状态**（读真实 `$DSH_HOME` 里那份由插件运行时
    // 抓下来的 models.dev 缓存）—— 全新 clone 上必然失败。现在自带夹具：
    // 只声明本用例需要的那一条（`big-pickle` 的窗口 = models.dev 的 `limit.context`）。
    const caps = await seedCapabilities([{
      id: 'big-pickle',
      name: 'Big Pickle',
      modalities: ['text', 'image'],
      contextWindow: 200_000,
      maxOutputTokens: 0,
      reasoning: false,
      efforts: [],
      toolCall: true,
      isFree: true,
    }])
    try {
      const a = new OpencodeAdapter({
        identitySlots: async () => [anonSlot()],
        fetchRemoteCatalog: async () => jsonResponse({ data: [{ id: 'big-pickle', context_window: 0 }] }),
      })
      const resolved = await a.resolveModel('opencode', 'big-pickle')
      // 能力表里 big-pickle = 200000；catalog 的 0 不该压掉它
      expect(resolved.context?.contextWindow).toBe(200000)
    } finally {
      await caps.restore()
    }
  })
  it('⚠️ 两侧都不知道窗口时不下发 context（不编造）', async () => {
    const a = new OpencodeAdapter({
      identitySlots: async () => [anonSlot()],
      // 未收录的模型名：能力表没有、catalog 也没有
      fetchRemoteCatalog: async () => jsonResponse({ data: [] }),
    })
    const resolved = await a.resolveModel('opencode', 'nope-model')
    expect(resolved.context).toBeUndefined()
  })
  it('listAllModels 返回完整目录且**同步**（jet-hub-rpc 不 await）', () => {
    const a = new OpencodeAdapter({ identitySlots: async () => [anonSlot()] })
    const all = a.listAllModels()
    expect(Array.isArray(all)).toBe(true)
    expect(all.length).toBeGreaterThan(0)
    expect(all.some((m) => m.isFree === true)).toBe(true)
  })
  it('providerInfo 回退到产品 id', () => {
    const a = new OpencodeAdapter({ identitySlots: async () => [anonSlot()] })
    expect(a.providerInfo('').id).toBe('opencode')
    expect(a.providerInfo('opencode').name).toBe('OpenCode')
  })
})
