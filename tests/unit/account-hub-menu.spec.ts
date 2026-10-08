/**
 * `/account_hub` 交互式菜单的回归测试。
 *
 * ## 守的是三个真实约定
 *
 * 1. **`userQuestions` 缺失时回退文本概览且不抛错** —— 参考项目同款降级。
 *    静态 `inject` 会让没有该服务的 profile 永久 pending，故实现必须惰性
 *    `ctx.get('userQuestions')`；这条用例的 ctx 桩**故意不提供**该服务。
 * 2. **未知子命令回用法** —— 参数式入口的可发现性。
 * 3. **不支持的 provider 不发请求** —— `dailyCheckin` 能力表（与客户端
 *    `credits-capabilities.js` 对齐）是门控：对 WorkBuddy 国际版这类无签到
 *    接口的渠道发 `credits.claimAll` 是必然失败的请求（CodeArts 历史缺陷的
 *    同型问题），必须在发请求**之前**拒绝。
 *
 * ## 菜单流的桩
 *
 * 用桩 `userQuestions` 应答器模拟用户逐级选择（`ask()` 返回
 * `{ answers: [{ id, selected: [label] }] }`），驱动「选 provider → 选操作」
 * 的多级流，断言底层 `ops.handleMethod` 收到了对应的方法与载荷。
 *
 * ## ⚠️ `agent` 必须透传（锁这条用例）
 *
 * `userQuestions` 的契约：人机交互只对「恰好是活运行时根」的那个 agent 有效，
 * 子 agent（owned child）没有人机应答器，不传 `agent` 会**永远阻塞**。
 * 菜单流那条用例的桩应答器断言收到了 `agent`。
 */
import { describe, expect, it } from 'vitest'
import { registerAccountHubCommand, ACCOUNT_HUB_COMMAND } from '../../src/account-hub-command.js'
import type { JetHubOps } from '../../src/jet-hub-rpc.js'

/** RPC 信封的成功形状。 */
function okEnvelope(value: unknown): unknown {
  return { ok: true, value }
}

/** 收集到的 `handleMethod` 调用。 */
interface MethodCall {
  method: string
  payload: unknown
}

/** 构造桩 `ops`：记录调用并按方法回放预置信封。 */
function makeOps(replies: Partial<Record<string, (payload: unknown) => unknown>>): { ops: JetHubOps; calls: MethodCall[] } {
  const calls: MethodCall[] = []
  const ops: JetHubOps = {
    async handleMethod(method: string, payload: unknown) {
      calls.push({ method, payload })
      const handler = replies[method]
      return handler !== undefined ? handler(payload) : okEnvelope(undefined)
    },
  }
  return { ops, calls }
}

/** 最小 ctx 桩：`effect` 立即执行生成器并跑完（对齐 cordis 语义），`commands.register` 记录定义。 */
function makeCtx(options: { userQuestions?: unknown; emit?: (event: string) => void } = {}) {
  const registered: unknown[] = []
  const emitted: string[] = []
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    get: (name: string) => (name === 'userQuestions' ? options.userQuestions : undefined),
    emit: (event: string) => {
      emitted.push(event)
      options.emit?.(event)
    },
    commands: {
      register: (definition: unknown) => {
        registered.push(definition)
        return () => {}
      },
    },
    effect: (factory: () => Generator) => {
      // 对齐 cordis 语义：立即执行生成器并跑完（本仓库只 yield 一次 register，
      // 无清理分支），使 registered 在调用 handler 前已填充。
      for (const _ of factory()) { /* 逐个消费 yield */ }
    },
  }
  return { ctx: ctx as never, registered, emitted }
}

/** 建 ctx + 调 registerAccountHubCommand（真实装配），供各用例直接 invoke。 */
function setupHub(ops: JetHubOps, options: { userQuestions?: unknown; emit?: (event: string) => void } = {}): { registered: unknown[]; emitted: string[] } {
  const { ctx, registered, emitted } = makeCtx(options)
  registerAccountHubCommand(ctx as never, ops)
  expect(registered.length).toBe(1)
  return { registered, emitted }
}

/** 从注册的 definition 里取出 handler 并调用（模拟 UI 分派一条命令行）。 */
async function invoke(registered: unknown[], rawInput: string, agent?: unknown) {
  const definition = registered[0] as {
    name: string
    handler: (invocation: { rawInput: string; agent?: unknown; attachments: readonly never[]; signal: AbortSignal }) => Promise<{ kind: string; text?: string }>
  }
  expect(definition.name).toBe(ACCOUNT_HUB_COMMAND)
  return definition.handler({
    rawInput,
    ...(agent !== undefined ? { agent } : {}),
    attachments: [],
    signal: new AbortController().signal,
  })
}

/**
 * 桩应答器：按问题 id 依序回放预设选项 label。
 *
 * ⚠️ `seenAgents` 记录每次 `ask()` 收到的 `agent` —— 用例据此断言
 * **agent 被透传**。这不是锦上添花：`userQuestions` 的契约是人机交互只对
 * 「恰好是活运行时根」的那个 agent 有效，子 agent（owned child）没有人机应答器，
 * **不传 agent 会永远阻塞**。桩若不记录，这条关键约束就没人守。
 */
function makeAnswerer(script: Readonly<Record<string, string>>) {
  const seenAgents: unknown[] = []
  return {
    seenAgents,
    ask: async (request: { questions: ReadonlyArray<{ id: string }>; agent?: unknown }) => {
      seenAgents.push(request.agent)
      const question = request.questions[0]
      const label = script[question.id]
      if (label === undefined) throw new Error(`桩脚本没有问题 ${question.id} 的答案`)
      return { answers: [{ id: question.id, selected: [label] }] }
    },
  }
}

describe('参数式入口（既有行为不回退）', () => {
  it('未知子命令回用法（可发现性）', async () => {
    const { ops } = makeOps({})
    const { registered } = setupHub(ops, {})
    await invoke(registered, 'nonsense-subcommand', { id: 'agent-1' })
    const result = await invoke(registered, 'nonsense-subcommand')
    expect(result.kind).toBe('error')
    expect(result.text).toContain('未知子命令')
    expect(result.text).toContain('nonsense-subcommand')
  })

  it('不支持的 provider 不发签到请求（能力表是门控，CodeArts 历史缺陷同型）', async () => {
    const { ops, calls } = makeOps({})
    const { registered } = setupHub(ops, {})
    // workbuddy 国际版后端没有签到接口（能力表 dailyCheckin=false）
    const result = await invoke(registered, 'checkin workbuddy')
    expect(result.kind).toBe('error')
    expect(result.text).toContain('不支持每日签到')
    // 展示名是 provider 标签（`WorkBuddy (国际版)`），不是裸 id —— 与其余文案一致。
    expect(result.text).toContain('WorkBuddy')
    // ⚠️ 关键：绝不能发出 credits.claimAll —— 对无签到接口的渠道发请求
    // 是必然失败的请求，必须在发请求之前拒绝。
    expect(calls.some((call) => call.method === 'credits.claimAll')).toBe(false)
  })

  it('支持的 provider 签到会发 credits.claimAll', async () => {
    const { ops, calls } = makeOps({
      'credits.claimAll': () => okEnvelope({
        summary: { claimed: 1, totalCredit: 100, alreadyClaimed: 0, inactive: 0, failed: 0 },
        results: [{ nickname: 'acct-1', outcome: { kind: 'claimed', credit: 100 } }],
      }),
    })
    const { registered } = setupHub(ops, {})
    const result = await invoke(registered, 'checkin codearts')
    expect(result.kind).toBe('success')
    expect(calls.some((call) => call.method === 'credits.claimAll')).toBe(true)
    expect(result.text).toContain('签到结果')
  })
})

describe('交互式菜单（无参数入口）', () => {
  it('userQuestions 缺失时回退文本概览且不抛错（headless / Web 同款降级）', async () => {
    const { ops, calls } = makeOps({
      'account.listAll': () => okEnvelope({ accounts: [] }),
    })
    // ctx 桩故意不提供 userQuestions
    const { registered } = setupHub(ops, {})
    const result = await invoke(registered, '')
    expect(result.kind).toBe('success')
    expect(result.text).toContain('账号池')
    // 回退路径只读全量清单，不发任何写操作
    expect(calls.some((call) => call.method === 'credits.claimAll')).toBe(false)
    expect(calls.some((call) => call.method === 'account.reorder')).toBe(false)
  })

  it('userQuestions 抛错时同样回退文本概览（不把异常摔成命令错误）', async () => {
    const { ops } = makeOps({
      'account.listAll': () => okEnvelope({ accounts: [] }),
    })
    const { registered } = setupHub(ops, {
      userQuestions: {
        ask: async () => { throw new Error('ASK_ABORTED') },
      },
    })
    const result = await invoke(registered, '')
    expect(result.kind).toBe('success')
    expect(result.text).toContain('账号池')
  })

  it('菜单流：选 provider → 选操作 → 底层收到对应方法；agent 必须透传', async () => {
    const { ops, calls } = makeOps({
      'account.list': () => okEnvelope({
        accounts: [
          { id: 'codearts-a1b2', provider: 'codearts', nickname: '主号', enabled: true },
          { id: 'codearts-c3d4', provider: 'codearts', nickname: '备号', enabled: true },
        ],
      }),
      // 走真实形状：value 是对象。与上面那条 `value: undefined` 的畸形信封
      // 不同 —— 畸形信封的防御另有既有用例覆盖。
      'credits.balances': () => okEnvelope({ accounts: [{ nickname: '主号', balance: { total: 100 } }] }),
    })
    const answerer = makeAnswerer({
      'account-hub:provider': 'codearts',
      'account-hub:action': '查看账号列表',
    })
    const { registered } = setupHub(ops, { userQuestions: answerer })
    const agent = { id: 'agent-live-root' }
    const result = await invoke(registered, '', agent)
    expect(result.kind).toBe('success')
    expect(calls.some((call) => call.method === 'account.list')).toBe(true)
    // ⚠️ agent 必须每次 ask 都透传：子 agent 没有人机应答器，不传会**永远阻塞**。
    expect(answerer.seenAgents.length).toBeGreaterThan(0)
    for (const seen of answerer.seenAgents) expect(seen).toBe(agent)
  })

  it('菜单流：切换优先账号 → account.reorder 收到「选中者排第一」的完整排列', async () => {
    const { ops, calls } = makeOps({
      'account.list': () => okEnvelope({
        accounts: [
          { id: 'codearts-a1b2', provider: 'codearts', nickname: '主号', enabled: true },
          { id: 'codearts-c3d4', provider: 'codearts', nickname: '备号', enabled: true },
        ],
      }),
    })
    const { registered } = setupHub(ops, {
      userQuestions: makeAnswerer({
        'account-hub:provider': 'codearts',
        'account-hub:action': '切换优先账号',
        'account-hub:account': '2. 备号',
      }),
    })
    const result = await invoke(registered, '')
    expect(result.kind).toBe('success')
    expect(result.text).toContain('主账号切换为 备号')
    const reorder = calls.find((call) => call.method === 'account.reorder')
    expect(reorder).toBeDefined()
    // ⚠️ reorderAccounts 的完整排列约束：orderedIds 必须恰好是该 provider
    // 全部账号 id 的一个排列（少一个/多一个都会抛错）。
    expect(reorder!.payload).toMatchObject({
      provider: 'codearts',
      orderedIds: ['codearts-c3d4', 'codearts-a1b2'],
    })
  })

  it('菜单流：启用 / 停用 → account.update 收到布尔 enabled（不做默认值猜测）', async () => {
    const { ops, calls } = makeOps({
      'account.list': () => okEnvelope({
        accounts: [{ id: 'codearts-a1b2', provider: 'codearts', nickname: '主号', enabled: true }],
      }),
    })
    const { registered } = setupHub(ops, {
      userQuestions: makeAnswerer({
        'account-hub:provider': 'codearts',
        'account-hub:action': '启用 / 停用账号',
        'account-hub:account': '1. 主号',
      }),
    })
    const result = await invoke(registered, '')
    expect(result.kind).toBe('success')
    expect(result.text).toContain('已停用')
    const update = calls.find((call) => call.method === 'account.update')
    expect(update).toBeDefined()
    expect(update!.payload).toMatchObject({ accountId: 'codearts-a1b2', patch: { enabled: false } })
  })

  it('菜单流：未选 provider 直接取消 → 回退文本概览，不报错', async () => {
    const { ops, calls } = makeOps({
      'account.listAll': () => okEnvelope({ accounts: [] }),
    })
    const { registered } = setupHub(ops, {
      userQuestions: {
        // 用户取消 → 该服务抛 ASK_ABORTED
        ask: async () => { throw new Error('ASK_ABORTED') },
      },
    })
    const result = await invoke(registered, '')
    expect(result.kind).toBe('success')
    expect(calls.some((call) => call.method === 'account.reorder')).toBe(false)
  })
})

describe('登录成功后必须广播 llm/adapters-updated（真实缺陷，2026-10-05）', () => {
  const LOGIN_REPLIES = {
    'account.create': () => okEnvelope({ accountId: 'codearts-a1b2', loginUrl: 'https://example.test/login' }),
    'login.poll': () => okEnvelope({ done: true, success: true }),
  }

  it('凭据落库即广播，否则 /models 要重启才出现（客户端目录缓存只在这三个事件上刷新）', async () => {
    const { ops, calls } = makeOps(LOGIN_REPLIES)
    const { registered, emitted } = setupHub(ops, {
      userQuestions: makeAnswerer({
        'account-hub:provider': 'codearts',
        'account-hub:action': '添加账号',
      }),
    })
    const result = await invoke(registered, '')
    expect(result.kind).toBe('success')
    expect(result.text).toContain('登录成功')
    // 已确认走到了 account.create + login.poll（不是空转）
    expect(calls.map((c) => c.method)).toContain('login.poll')
    expect(emitted).toContain('llm/adapters-updated')
  })

  it('广播抛错不能反噬已完成的登录（否则用户看到「失败」而账号其实已入池）', async () => {
    const { ops } = makeOps(LOGIN_REPLIES)
    const { registered } = setupHub(ops, {
      userQuestions: makeAnswerer({
        'account-hub:provider': 'codearts',
        'account-hub:action': '添加账号',
      }),
      emit: () => { throw new Error('emit 崩了') },
    })
    const result = await invoke(registered, '')
    expect(result.kind).toBe('success')
    expect(result.text).toContain('登录成功')
  })
})

describe('provider 打头的快捷写法（参考项目同款，真实缺陷 2026-10-05）', () => {
  /** 两个账号的列表桩，供 use / on / off / rename 复用。 */
  const TWO_ACCOUNTS = {
    'account.list': () => okEnvelope({
      accounts: [
        { id: 'buddy-a1b2', provider: 'buddy', nickname: '主号', enabled: true },
        { id: 'buddy-c3d4', provider: 'buddy', nickname: '备号', enabled: false },
      ],
    }),
  }

  it('`/account_hub buddy` 不再报「未知子命令」，而是等价于 list buddy', async () => {
    const { ops, calls } = makeOps(TWO_ACCOUNTS)
    const { registered } = setupHub(ops, {})
    const result = await invoke(registered, 'buddy')
    expect(result.kind).toBe('success')
    expect(result.text).not.toContain('未知子命令')
    // 等价于 `list buddy`：按 provider 取列表
    const listed = calls.filter((c) => c.method === 'account.list')
    expect(listed.length).toBe(1)
    expect(listed[0].payload).toMatchObject({ provider: 'buddy' })
  })

  it('`/account_hub buddy credits` 归一化成 balance（参考项目用 credits 这个名字）', async () => {
    const { ops, calls } = makeOps({
      ...TWO_ACCOUNTS,
      'credits.balances': () => okEnvelope({ accounts: [{ nickname: '主号', balance: { total: 100 } }] }),
    })
    const { registered } = setupHub(ops, {})
    const result = await invoke(registered, 'buddy credits')
    expect(result.kind).toBe('success')
    expect(calls.some((c) => c.method === 'credits.balances')).toBe(true)
  })

  it('`/account_hub buddy use 2` 归一化成 use buddy 2，reorder 收到选中者排第一', async () => {
    const { ops, calls } = makeOps(TWO_ACCOUNTS)
    const { registered } = setupHub(ops, {})
    const result = await invoke(registered, 'buddy use 2')
    expect(result.kind).toBe('success')
    expect(result.text).toContain('主账号切换为 备号')
    const reorder = calls.find((c) => c.method === 'account.reorder')
    expect(reorder!.payload).toMatchObject({ provider: 'buddy', orderedIds: ['buddy-c3d4', 'buddy-a1b2'] })
  })

  it('`/account_hub buddy off 1` 走 account.update 停用，而不是报未知子命令', async () => {
    const { ops, calls } = makeOps(TWO_ACCOUNTS)
    const { registered } = setupHub(ops, {})
    const result = await invoke(registered, 'buddy off 1')
    expect(result.kind).toBe('success')
    expect(result.text).toContain('已停用')
    const update = calls.find((c) => c.method === 'account.update')
    expect(update!.payload).toMatchObject({ accountId: 'buddy-a1b2', patch: { enabled: false } })
  })

  it('`/account_hub buddy rename 1 我的小号` 落 nickname', async () => {
    const { ops, calls } = makeOps(TWO_ACCOUNTS)
    const { registered } = setupHub(ops, {})
    const result = await invoke(registered, 'buddy rename 1 我的小号')
    expect(result.kind).toBe('success')
    const update = calls.find((c) => c.method === 'account.update')
    // ⚠️ 昵称含空格必须整体保留，不能被 token 化拆散
    expect(update!.payload).toMatchObject({ accountId: 'buddy-a1b2', patch: { nickname: '我的小号' } })
  })

  it('`/account_hub buddy checkin` 归一化成 checkin buddy', async () => {
    const { ops, calls } = makeOps({
      ...TWO_ACCOUNTS,
      'credits.claimAll': () => okEnvelope({
        summary: { claimed: 1, totalCredit: 50, alreadyClaimed: 0, inactive: 0, failed: 0 },
        results: [{ nickname: '主号', outcome: { kind: 'claimed', credit: 50 } }],
      }),
    })
    const { registered } = setupHub(ops, {})
    const result = await invoke(registered, 'buddy checkin')
    expect(result.kind).toBe('success')
    const claim = calls.find((c) => c.method === 'credits.claimAll')
    expect(claim!.payload).toMatchObject({ provider: 'buddy' })
  })

  it('动作打头的旧写法仍然可用（不回归）', async () => {
    const { ops, calls } = makeOps(TWO_ACCOUNTS)
    const { registered } = setupHub(ops, {})
    const result = await invoke(registered, 'list buddy')
    expect(result.kind).toBe('success')
    expect(calls.filter((c) => c.method === 'account.list').length).toBe(1)
  })

  it('不是 provider 的第一 token 仍是未知子命令（防误吞）', async () => {
    const { ops } = makeOps({})
    const { registered } = setupHub(ops, {})
    const result = await invoke(registered, 'nonsense')
    expect(result.kind).toBe('error')
    expect(result.text).toContain('未知子命令')
  })
})
