/**
 * `/account_hub` —— 把 Jet Hub 的账号管理能力搬进 **dst TUI** 的斜杠命令。
 *
 * ## 为什么需要它（用户原话：「能把它改成 dst 可用的吗？用 /account_hub 使用」）
 *
 * 插件原先只有一条入口：Web GUI 的 Jet Hub 设置面板，经 `connection.fetch`
 * 通信。而 `connection` 服务**只存在于 Web bundle** —— 命令行 / headless /
 * **dst TUI** 这些 profile 下整套账号管理根本不可达。
 *
 * 本模块把同一套能力表达成 host 斜杠命令：
 * - **不新建任何业务实现**：所有动作都转发给 `src/jet-hub-rpc.ts` 的
 *   `createJetHubOps`（Web GUI 与命令**同一个** `handleMethod`）；
 * - 不产生 model 消息：按 `@deepseek-ai/dsh-commands` 契约，命令 handler 直接
 *   作用于 agent、只回一份给 UI 渲染的文本结果，token 影响为零；
 * - 演进单向：Jet Hub 修过的每一处缺陷（qoder 同族分派、workbuddy/cline/raccoon
 *   的签到守卫、codearts 的「Token 计户」文案、Qoder 空列表≠已领……）命令侧
 *   **自动**获得。
 *
 * ## 语法（全部在 {@link CommandInvocation.rawInput} 内解析）
 *
 * ```
 * /account_hub                       同 list
 * /account_hub list [provider]       账号列表（给 provider 时附余额）
 * /account_hub use <provider> <#>    把该池某账号挪到队首（= 切换主账号）
 * /account_hub balance <provider>    积分余额
 * /account_hub checkin <provider>    每日签到（一键领取）
 * /account_hub lock <provider> on|off   锁定永久积分（仅 buddy/workbuddy/loomy）
 * /account_hub provider <id> on|off     供应商级一键开关
 * /account_hub gateway on|off|status    本机 OpenAI 兼容网关开关
 * /account_hub refresh <accountId>  续期某账号凭据
 * /account_hub reset <provider>     清除该渠道全部模型限流标记
 * ```
 *
 * ⚠️ `provider` 一律传 **id**（`codearts` / `qodercn` / …），不是展示名。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { openBrowser } from './login.js'
import type { JetHubOps } from './jet-hub-rpc.js'

/** 命令名（无前导斜杠）。⚠️ 必须满足 `[a-z0-9_-]+`，否则 parseCommand 不认。 */
export const ACCOUNT_HUB_COMMAND = 'account_hub'

/**
 * provider id → 展示名。
 *
 * ⚠️ **须与 `plugin-src/client/jet-hub.js` 的 `PROVIDERS` 保持一致**（那里是
 * 「唯一的渠道名来源」，客户端不改它）。这里另立一份是**不得已**：命令跑在宿主侧，
 * 不能 import 客户端 bundle；而两边一旦漂移，症状是「客户端叫
 * WorkBuddy (国际版)、命令里只能输 id」——可排查、无功能损害，比反过来
 * （命令显示错名字）安全。改任一侧时请同步另一边。
 */
const PROVIDER_LABELS: Readonly<Record<string, string>> = Object.freeze({
  codearts: 'CodeArts (华为云)',
  buddy: 'CodeBuddy (腾讯)',
  workbuddy: 'WorkBuddy (国际版)',
  lobsterai: 'LobsterAI (有道)',
  qoder: 'Qoder',
  qodercn: 'Qoder (中国版)',
  trae: 'TRAE (字节)',
  cline: 'Cline',
  loomy: 'Loomy (讯飞)',
  raccoon: 'Raccoon (商汤)',
  minimax: 'MiniMax Code',
  zcode: 'ZCode (智谱)',
  opencode: 'OpenCode',
})

/** 「锁定永久积分」合法渠道（与 `src/jet-hub-rpc.ts` 的 `PERMANENT_LOCK_PROVIDERS` 同源）。 */
const LOCKABLE_PROVIDERS: ReadonlySet<string> = new Set(['buddy', 'workbuddy', 'loomy'])

/** 有每日签到的渠道（与客户端 `credits-capabilities.js` 的 `dailyCheckin` 对齐）。 */
const CHECKIN_PROVIDERS: ReadonlySet<string> = new Set([
  'codearts', 'buddy', 'lobsterai', 'qoder', 'qodercn', 'trae', 'loomy', 'minimax', 'zcode',
])

/** RPC 信封的成功形状。 */
interface OkEnvelope {
  readonly ok: true
  readonly value: unknown
}

/** RPC 信封的失败形状。 */
interface ErrEnvelope {
  readonly ok: false
  readonly error?: { code?: string; message?: string }
}

/**
 * 解析 RPC 信封；非法形状一律当错误（宁可报错也不要把 `undefined` 当成功值用）。
 *
 * ⚠️ 这里**不做**任何业务判定，只做「拆信封 + 取文案」。所有业务语义
 * （含「Qoder 空活动列表 ≠ 已领取」这类）都在 `handleMethod` 内部，命令侧
 * 照抄其结论即可。
 */
function unwrap(result: unknown): { ok: true; value: unknown } | { ok: false; error: string } {
  if (typeof result !== 'object' || result === null) {
    return { ok: false, error: '账号操作核心返回了无法识别的结果' }
  }
  const envelope = result as Partial<OkEnvelope> & Partial<ErrEnvelope>
  if (envelope.ok === true) return { ok: true, value: envelope.value }
  if (envelope.ok === false) {
    const message = envelope.error?.message
    return {
      ok: false,
      error: typeof message === 'string' && message.length > 0 ? message : '操作失败',
    }
  }
  return { ok: false, error: '账号操作核心返回了无法识别的结果' }
}

/** 把任意未知量渲染成一行文案（绝不抛错）。 */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** provider id → 展示名；查不到时原样返回 id（可排查）。 */
function label(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider
}

/**
 * 解析 `on|off|true|false|1|0` 之类的布尔参数。
 *
 * ⚠️ 返回值是**三态**：无法识别必须与「关」区分开。与
 * `provider.setEnabled` / `gateway.setEnabled` 那两条「不做默认值猜测」约定
 * 同因：把无法识别静默当成 off，会让一条打错的命令真的关掉用户的渠道。
 */
function parseToggle(raw: string): boolean | undefined {
  switch (raw.trim().toLowerCase()) {
    case 'on': case 'true': case '1': case '开': case '开启':
      return true
    case 'off': case 'false': case '0': case '关':
      return false
    default:
      return undefined
  }
}

/** 把整段 rawInput 切成 token 数组（命令名已由 dsh-commands 剥掉）。 */
function tokens(rawInput: string): string[] {
  return rawInput.trim().split(/\s+/).filter((token) => token.length > 0)
}

/** 把毫秒时间戳渲染成 `MM-DD HH:mm`；缺省返回空串。 */
function stamp(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return ''
  const date = new Date(ms)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 用法文案（help / 空输入 / 未知子命令共用）。 */
const USAGE = [
  '用法：/account_hub <provider> [动作] [参数]      ← provider 打头（推荐）',
  '      /account_hub                 进入交互式菜单',
  '      /account_hub <provider>      该 provider 的账号列表',
  '      /account_hub <provider> add           添加账号（浏览器授权）',
  '      /account_hub <provider> use <序号>     切换主账号',
  '      /account_hub <provider> on|off <序号>  启用 / 停用',
  '      /account_hub <provider> rename <序号> <昵称>',
  '      /account_hub <provider> credits        积分余额',
  '      /account_hub <provider> checkin        每日签到',
  '',
  '等价的动作打头写法（与旧版兼容）：',
  '  list [provider]              账号列表（给 provider 时附余额）',
  '  use <provider> <序号>        切换主账号（把该账号挪到池首）',
  '  balance <provider>           查询积分余额',
  '  checkin <provider>           每日签到 / 一键领取',
  '  lock <provider> on|off       锁定永久积分（buddy / workbuddy / loomy）',
  '  provider <id> on|off         供应商一键开关（连带模型与账号）',
  '  gateway on|off|status        本机 OpenAI 兼容网关',
  '  refresh <accountId>          续期某账号凭据',
  '  reset <provider>             清除该渠道模型限流标记',
  '  help                         本用法',
  'provider 一律传 id：' + Object.keys(PROVIDER_LABELS).join(' / '),
].join('\n')

/** `credits.balances` 的返回项（只声明命令真正读到的字段）。 */
interface BalanceRow {
  nickname: string
  balance: {
    total: number
    packages?: ReadonlyArray<{ name: string; remaining: number; unit?: string }>
  } | null
  error?: string
}

/** `account.list` 的返回项（只声明命令真正读到的字段）。 */
interface AccountRow {
  id: string
  provider: string
  nickname: string
  enabled: boolean
  accountName?: string
}

/** `credits.claimAll` 的返回项。 */
interface ClaimRow {
  nickname: string
  outcome: { kind: string; message?: string; credit?: number }
}

/** `credits.claimAll` 的汇总。 */
interface ClaimSummary {
  claimed: number
  totalCredit: number
  alreadyClaimed: number
  inactive: number
  failed: number
}

/**
 * 渲染「账号列表」。
 *
 * @param provider 给定时附一次余额查询（只对该渠道发一轮 RPC）；
 *                  缺省时读全池概览（`account.listAll`）。
 */
async function renderList(ops: JetHubOps, provider: string | undefined): Promise<string> {
  if (provider === undefined) {
    // 无参 = 全池概览。必须**自己**经 ops 读全量：调用方（dispatch）手里
    // 只有 rawInput 的 token，没有任何账号数据可传。
    const all = unwrap(await ops.handleMethod('account.listAll', undefined))
    if (!all.ok) return `✗ 账号列表读取失败：${all.error}`
    const rows = ((all.value ?? {}) as { accounts?: AccountRow[] }).accounts ?? []
    if (rows.length === 0) {
      return '账号池为空。请先用 Web 端 Jet Hub 或官方客户端登录账号。'
    }
    const grouped = new Map<string, AccountRow[]>()
    for (const row of rows) {
      const bucket = grouped.get(row.provider)
      if (bucket === undefined) grouped.set(row.provider, [row])
      else bucket.push(row)
    }
    const lines = [`账号池共 ${rows.length} 个账号：`]
    for (const [providerId, bucket] of grouped) {
      const enabled = bucket.filter((row) => row.enabled !== false).length
      lines.push(`  ${label(providerId)}（${providerId}）：${bucket.length} 个，启用 ${enabled}`)
      bucket.forEach((row, index) => {
        lines.push(`    ${index + 1}. ${row.accountName ?? row.nickname ?? row.id}${row.enabled === false ? '（已停用）' : ''}`)
      })
    }
    return lines.join('\n')
  }

  const listed = unwrap(await ops.handleMethod('account.list', { provider }))
  if (!listed.ok) return `✗ ${label(provider)} 账号列表读取失败：${listed.error}`
  const rows = ((listed.value ?? {}) as { accounts?: AccountRow[] }).accounts ?? []
  if (rows.length === 0) return `${label(provider)}：没有账号`

  const balances = unwrap(await ops.handleMethod('credits.balances', { provider }))
  const balanceByNickname = new Map<string, BalanceRow>()
  if (balances.ok) {
    for (const row of ((balances.value ?? {}) as { accounts?: BalanceRow[] }).accounts ?? []) {
      balanceByNickname.set(row.nickname, row)
    }
  }
  const lines = [`${label(provider)}：${rows.length} 个账号`]
  rows.forEach((row, index) => {
    const who = row.accountName ?? row.nickname ?? row.id
    lines.push(`  ${index + 1}. ${who}${row.enabled === false ? '（已停用）' : ''}  [${row.id}]`)
    const balance = balanceByNickname.get(row.nickname)
    if (balance === undefined) return
    if (balance.balance === null) {
      lines.push(`     余额：${balance.error ?? '查询失败'}`)
    } else {
      lines.push(`     余额：${balance.balance.total}`)
      for (const pack of balance.balance.packages ?? []) {
        lines.push(`       └ ${pack.name}：剩 ${pack.remaining}${pack.unit ? ` ${pack.unit}` : ''}`)
      }
    }
  })
  if (!balances.ok) lines.push(`（余额查询失败：${balances.error}）`)
  return lines.join('\n')
}

/**
 * 广播「模型目录可能已变化」（`llm/adapters-updated`）。
 *
 * ## ⚠️ 为什么**登录成功后必须调**（真实缺陷，2026-10-05）
 *
 * 症状：dst 里 `/account_hub <provider> add` 登录明明成功（`login.poll`
 * 回 `done:true`、凭据已落库），但 `/models` 里始终看不到该 provider 的
 * 模型，**重启 dst 后**才出现。
 *
 * 根因在**客户端缓存**而非适配器（`dsh-client-ui-model-selection` 的
 * `ModelCatalogDirectory`）：它把 `modelCatalog` 响应存进一个
 * `status === 'ready'` 即**短路返回缓存**的 store，只在三个宿主事件上
 * `refresh()`：`llm/adapters-updated` / `settings/document-updated` /
 * `credentials/reference-updated`。
 *
 * 而本仓库此前只在这 5 个方法里广播：`model.setDisabled` /
 * `model.setDisabledMany` / `model.setAllDisabled` / `provider.setEnabled` /
 * `backup.import` —— **建号与登录路径一次都没有**。且 `dsh-credentials` 的
 * `notifyUpdated(ref)` 需要写凭据方**显式调用**，本仓库也从未调用。
 * ⇒ 于是「账号池从无到有」这种最剧烈的目录变化（`providerCatalogVisible`
 * 由 false 转 true）反而**没有任何事件通知客户端**，缓存一直不刷新。
 *
 * 三者中 `llm/adapters-updated` 最贴合：按契约它是**无载荷**的「目录可能变了，
 * 请重新读 listModels」（dsh-llm README：consumers re-read the registries）。
 *
 * ⚠️ **广播失败不能反噬已经落盘的账号**：否则用户看到「切换失败」而实际已
 * 生效，再点一次又因幂等而看似「无效」，比不提示更难排查。故这里自行吞掉
 * 异常只记日志（与 `jet-hub-rpc.ts` 的 `broadcastCatalogChanged` 同口径）。
 */
function broadcastCatalogChanged(ctx: Context): void {
  try {
    ctx.emit('llm/adapters-updated')
  } catch (error) {
    ctx.logger?.warn?.(`[account-hub] 广播 llm/adapters-updated 失败（不影响已完成的账户操作）: ${String(error)}`)
  }
}

// ═══════════════════ 交互式菜单（无参数入口） ═══════════════════

/**
 * `ctx.userQuestions` 的最小形状（**惰性取用**，见 `dispatch` 的说明）。
 *
 * 取用必须走 `ctx.get('userQuestions')`，不得静态 `inject`：没有该服务的
 * profile（headless / Web）会因注入缺失而**永久 pending**。取不到时
 * {@link askOne} 返回 `undefined`，上层回退文本概览。
 */
interface UserQuestionsLike {
  ask(request: {
    questions: ReadonlyArray<{
      id: string
      question: string
      header?: string
      detail?: string
      options?: ReadonlyArray<{ label: string; description?: string }>
      multiSelect?: boolean
    }>
    agent?: unknown
    signal?: AbortSignal
  }): Promise<{ answers: ReadonlyArray<{ id: string; selected: readonly string[]; custom?: string }> }>
}

/** 从 ctx 取 `userQuestions`；缺失/形状不对返回 `undefined`（调用方走文本回退）。 */
function userQuestionsOf(ctx: Context): UserQuestionsLike | undefined {
  const uq = ctx.get('userQuestions') as UserQuestionsLike | undefined
  if (uq === undefined || typeof uq.ask !== 'function') return undefined
  return uq
}

/**
 * 弹一次单选问卷；返回选中的 **label**，`undefined` 表示「走文本回退」。
 *
 * ## 两个必须守住的约定
 *
 * 1. **`agent` 必须透传**（见 `dispatch` 的说明）——子 agent 没有人机应答器，
 *    不传 `agent` 会**永远阻塞**；传了不属于活运行时根的 agent 则抛
 *    `CALLER_NOT_LIVE` / `DELEGATED_CALLER`，同样走文本回退。
 * 2. **任何异常都算「不可用」**：`ASK_ABORTED`（用户取消）、服务抛错、
 *    形状不符 → 一律返回 `undefined` 让上层回退文本，绝不把异常摔成命令错误。
 */
async function askOne(
  ctx: Context,
  agent: unknown,
  question: { id: string; question: string; header?: string; options: ReadonlyArray<{ label: string; description?: string }> },
): Promise<string | undefined> {
  const uq = userQuestionsOf(ctx)
  if (uq === undefined) return undefined
  try {
    const answer = await uq.ask({
      questions: [{ id: question.id, question: question.question, header: question.header, options: question.options }],
      ...(agent !== undefined ? { agent } : {}),
    })
    return answer?.answers?.[0]?.selected?.[0]
  } catch {
    return undefined
  }
}

/** 把选中的 label 映射回选项；ask 返回的是 label 本身。 */
function optionByLabel<T extends { label: string }>(options: readonly T[], label: string): T | undefined {
  return options.find((option) => option.label === label)
}

/** 「取消 / 返回」的共享哨兵：外层据此回退文本概览而不是把它当错误。 */
const MENU_CANCELLED = undefined as unknown as CommandResult

/**
 * 账号选择器：列出该 provider 的账号（含停用标记与优先级），返回选中条目。
 * 用户取消时返回 {@link MENU_CANCELLED}。
 */
async function accountPicker(
  ctx: Context,
  agent: unknown,
  provider: string,
  entries: readonly AccountRow[],
): Promise<{ entry: AccountRow } | { cancelled: true } | CommandResult> {
  const options = entries.map((entry, index) => ({
    label: `${index + 1}. ${entry.accountName ?? entry.nickname ?? entry.id}${entry.enabled === false ? '（已停用）' : ''}`,
    description: `${entry.id} · 优先级 ${index + 1}`,
    entry,
  }))
  if (options.length === 0) {
    return { kind: 'error', text: `没有可选的账号（${label(provider)} 的账号都被停用）。` }
  }
  const picked = await askOne(ctx, agent, {
    id: 'account-hub:account',
    question: `选择账号（${label(provider)}）`,
    header: '账号',
    options,
  })
  if (picked === undefined) return { cancelled: true }
  const match = optionByLabel(options, picked)
  return match !== undefined ? { entry: match.entry } : { cancelled: true }
}

/**
 * 该 provider 的账号列表（复用既有 `renderList` 的分派路径，含余额与限流标记）。
 */
async function providerDetail(ops: JetHubOps, provider: string): Promise<CommandResult> {
  return { kind: 'success', text: await renderList(ops, provider) }
}

/**
 * 发起浏览器登录：`account.create`（返回 `loginUrl` + `accountId`）→ 打开浏览器
 * → 轮询 `login.poll` 直到凭据落池。
 *
 * ## 时序（与 Web 面板 `account.create` 同款）
 *
 * - `loginUrl` 只在**用户点击后的短暂窗口**（transient activation）内能被
 *   `window.open`，故创建与打开必须**连续**，不能先 await 完整登录流程再给 URL。
 * - `loginMode === 'sms'`（Loomy）返回**空串** `loginUrl`——短信登录没有可打开的
 *   地址，此时如实告知去 Web 端完成，不伪装成功。
 * - 轮询有**上限**（`LOGIN_POLL_MAX` 次 × `LOGIN_POLL_MS`）：占位条目在授权完成
 *   后由后台补全，超时**不报错**——账号仍在池里，用户可稍后 `refresh` 或重进菜单。
 * - 抛错时后台会自行移除占位条目（`jet-hub-rpc.ts` 的 `.catch` 分支），这里
 *   只需把失败说清，不留幽灵账号。
 */
async function startLogin(ctx: Context, ops: JetHubOps, provider: string): Promise<CommandResult> {
  const created = unwrap(await ops.handleMethod('account.create', { provider }))
  if (!created.ok) return { kind: 'error', text: `✗ ${label(provider)} 登录发起失败：${created.error}` }
  const value = created.value as { accountId?: string; loginUrl?: string; loginMode?: 'url' | 'sms' }
  const accountId = value.accountId ?? ''
  const loginUrl = value.loginUrl ?? ''
  if (value.loginMode === 'sms' || loginUrl.length === 0) {
    return {
      kind: 'success',
      text: `${label(provider)} 走短信验证码登录，终端里没有验证码表单，请在 Web 端 Jet Hub 完成输入。\n占位账号已建：${accountId}`,
    }
  }
  openBrowser(loginUrl)

  // 轮询登录完成：`done` / `success` 由 login.poll 给出；有上限，超时不报错。
  const LOGIN_POLL_MAX = 60
  const LOGIN_POLL_MS = 2_000
  for (let i = 0; i < LOGIN_POLL_MAX; i++) {
    await new Promise((resolve) => setTimeout(resolve, LOGIN_POLL_MS))
    const polled = unwrap(await ops.handleMethod('login.poll', { accountId }))
    if (!polled.ok) continue
    const state = polled.value as { done?: boolean; success?: boolean }
    if (state.done === true) {
      if (state.success === false) {
        return { kind: 'error', text: `✗ ${label(provider)} 授权未完成或已取消（账号 ${accountId} 已从池中移除，可重试）。` }
      }
      // ⚠️ 凭据刚落库 ⇒ providerCatalogVisible 由 false 转 true，目录内容
      // **从无到有**。不广播的话客户端一直复用旧缓存，模型要重启才出现。
      broadcastCatalogChanged(ctx)
      return { kind: 'success', text: `✓ ${label(provider)} 登录成功：${accountId}\n该 provider 的模型会自动出现在 /model 选择器（按账号池聚合选号）。` }
    }
  }
  broadcastCatalogChanged(ctx)
  return {
    kind: 'success',
    text: `已打开浏览器完成 ${label(provider)} 授权（账号 ${accountId}）。\n终端侧等待超时；账号仍在池里，完成后用 /account_hub ${provider} 确认，或直接看 /model。`,
  }
}

/** 签到（共享入口）：`provider` 缺省 = 全渠道（由核心分派按能力表逐个处理）。 */
async function dispatchCheckin(ops: JetHubOps, provider?: string): Promise<CommandResult> {
  if (provider !== undefined && !CHECKIN_PROVIDERS.has(provider)) {
    return {
      kind: 'error',
      text: `${label(provider)} 不支持每日签到（其后端没有签到接口）。支持：${[...CHECKIN_PROVIDERS].join(' / ')}`,
    }
  }
  const result = unwrap(await ops.handleMethod('credits.claimAll', provider !== undefined ? { provider } : undefined))
  if (!result.ok) return { kind: 'error', text: `✗ ${provider !== undefined ? label(provider) : ''}签到失败：${result.error}` }
  const value = result.value as { summary?: ClaimSummary; results?: ClaimRow[] }
  const lines = [`${provider !== undefined ? `${label(provider)} 签到结果：` : '全部渠道签到结果：'}`]
  for (const row of value.results ?? []) {
    const outcome = row.outcome
    const glyph = outcome.kind === 'claimed' ? '✓' : outcome.kind === 'failed' ? '✗' : '·'
    const detail = outcome.kind === 'claimed'
      ? `+${outcome.credit ?? 0}`
      : outcome.message ?? outcome.kind
    lines.push(`  ${glyph} ${row.nickname}：${detail}`)
  }
  const summary = value.summary
  if (summary !== undefined) {
    lines.push(
      `合计：领取 ${summary.claimed} 个 / +${summary.totalCredit}，`
      + `已领 ${summary.alreadyClaimed}，未开启 ${summary.inactive}，失败 ${summary.failed}`,
    )
  }
  return { kind: 'success', text: lines.join('\n') }
}

/**
 * 「★ 全部账号 · 余额与签到」：**先统一签到再查余额**（今日积分先落账，
 * 否则余额会读旧值）。
 */
async function globalCreditsAndCheckin(ops: JetHubOps): Promise<CommandResult> {
  // 先签到（不分渠道，由核心分派按能力表逐个处理），再逐 provider 查余额。
  const checkin = await dispatchCheckin(ops)
  const all = unwrap(await ops.handleMethod('account.listAll', undefined))
  const rows = all.ok ? (((all.value ?? {}) as { accounts?: AccountRow[] }).accounts ?? []) : []
  const providersWithAccounts = [...new Set(rows.map((row) => row.provider))]
  const sections = [checkin.text]
  for (const providerId of providersWithAccounts) {
    const balances = unwrap(await ops.handleMethod('credits.balances', { provider: providerId }))
    if (balances.ok) {
      const value = balances.value as { accounts?: BalanceRow[] }
      const rowsFor = value.accounts ?? []
      if (rowsFor.length > 0) {
        const lines = [`${label(providerId)}：`]
        for (const row of rowsFor) {
          lines.push(row.balance === null
            ? `  ✗ ${row.nickname}：${row.error ?? '查询失败'}`
            : `  ✓ ${row.nickname}：${row.balance.total}`)
        }
        sections.push(lines.join('\n'))
      }
    } else {
      sections.push(`${label(providerId)} 余额查询失败：${balances.error}`)
    }
  }
  return { kind: 'success', text: sections.join('\n\n') }
}

/**
 * 交互式菜单入口（`/account_hub` 无参数）。
 *
 * 层级：选 provider（或「★ 全部账号」）→ 该 provider 的操作菜单 → 子选择。
 * 任何一级取消 / `userQuestions` 不可用 ⇒ 回退**文本概览**（`renderList`），
 * 绝不让命令因此报错。
 */
async function interactiveHub(ctx: Context, ops: JetHubOps, invocation: CommandInvocation): Promise<CommandResult> {
  const agent = invocation.agent
  // 首级：选 provider。没有 userQuestions 时 askOne 返回 undefined → 文本回退。
  const picked = await askOne(ctx, agent, {
    id: 'account-hub:provider',
    question: '选择要管理的 provider',
    header: '账号中心',
    options: [
      { label: '★ 全部账号 · 余额与签到', description: '完成今日签到并查所有账号剩余额度' },
      ...Object.entries(PROVIDER_LABELS).map(([id, name]) => ({ label: id, description: name })),
    ],
  })
  if (picked === undefined) {
    // 服务不可用或用户取消：文本概览兜底（与参考插件同款降级）。
    return { kind: 'success', text: await renderList(ops, undefined) }
  }
  if (picked === '★ 全部账号 · 余额与签到') {
    return await globalCreditsAndCheckin(ops)
  }
  if (PROVIDER_LABELS[picked] === undefined) {
    return { kind: 'error', text: `未知 provider「${picked}」。可用值见 /account_hub providers。` }
  }
  const provider = picked

  // 二级：该 provider 的操作菜单。
  const action = await askOne(ctx, agent, {
    id: 'account-hub:action',
    question: `${label(provider)}（${provider}）—— 选择操作`,
    header: '操作',
    options: [
      { label: '查看账号列表', description: '含启用状态、到期时间与限流标记' },
      { label: '添加账号', description: '浏览器登录一个新账号加入账号池' },
      { label: '切换优先账号', description: '选一个账号移到自动选号首位' },
      { label: '启用 / 停用账号', description: '停用的账号不参与自动选号' },
      { label: '积分余额', description: '逐账号查询剩余额度（需联网）' },
      { label: '每日签到', description: '签今天可签的账号' },
      { label: '续期账号凭据', description: '按账号自己的凭据 ref 静默续期' },
      { label: '返回', description: '回到文本概览' },
    ],
  })
  if (action === undefined || action === '返回') {
    return { kind: 'success', text: await renderList(ops, undefined) }
  }

  switch (action) {
    case '查看账号列表':
      return await providerDetail(ops, provider)

    case '添加账号':
      return await startLogin(ctx, ops, provider)

    case '积分余额':
    case '每日签到':
    case '切换优先账号':
    case '启用 / 停用账号':
    case '续期账号凭据': {
      // 这些操作都要先选账号；「积分余额」「每日签到」是 provider 级的，直接跑。
      if (action === '积分余额') {
        return { kind: 'success', text: await renderList(ops, provider) }
      }
      if (action === '每日签到') {
        return await dispatchCheckin(ops, provider)
      }
      // 其余三条需要具体账号。
      const listed = unwrap(await ops.handleMethod('account.list', { provider }))
      if (!listed.ok) return { kind: 'error', text: `✗ ${label(provider)} 账号列表读取失败：${listed.error}` }
      const accounts = ((listed.value ?? {}) as { accounts?: AccountRow[] }).accounts ?? []
      if (accounts.length === 0) {
        return { kind: 'error', text: `${label(provider)} 暂无账号。先选「添加账号」。` }
      }
      const pickedAccount = await accountPicker(ctx, agent, provider, accounts)
      if ('cancelled' in pickedAccount) return MENU_CANCELLED
      if ('kind' in pickedAccount) return pickedAccount
      const entry = pickedAccount.entry
      if (action === '切换优先账号') {
        const orderedIds = [entry.id, ...accounts.filter((row) => row.id !== entry.id).map((row) => row.id)]
        const reordered = unwrap(await ops.handleMethod('account.reorder', { provider, orderedIds }))
        if (!reordered.ok) return { kind: 'error', text: `✗ 切换失败：${reordered.error}` }
        return { kind: 'success', text: `已将 ${label(provider)} 的主账号切换为 ${entry.accountName ?? entry.nickname ?? entry.id}` }
      }
      if (action === '启用 / 停用账号') {
        const nextEnabled = entry.enabled === false
        const updated = unwrap(await ops.handleMethod('account.update', { accountId: entry.id, patch: { enabled: nextEnabled } }))
        if (!updated.ok) return { kind: 'error', text: `✗ 设置失败：${updated.error}` }
        return { kind: 'success', text: `${label(provider)} 的 ${entry.accountName ?? entry.nickname ?? entry.id} 已${nextEnabled ? '启用' : '停用'}` }
      }
      // 续期
      const refreshed = unwrap(await ops.handleMethod('account.refresh', { accountId: entry.id }))
      if (!refreshed.ok) return { kind: 'error', text: `✗ 续期失败：${refreshed.error}` }
      const refreshValue = refreshed.value as { success?: boolean; error?: string }
      if (refreshValue.success === false) {
        return { kind: 'error', text: `✗ 续期失败：${refreshValue.error ?? '未知原因'}` }
      }
      broadcastCatalogChanged(ctx)
      return { kind: 'success', text: `已续期 ${label(provider)} 的 ${entry.accountName ?? entry.nickname ?? entry.id}` }
      }

    default:
      return { kind: 'success', text: await renderList(ops, undefined) }
  }
}

/**
 * 子命令分派。
 *
 * 抛出会被 `dsh-commands` 兜住并 settle 成 error，故这里只管把话说清。
 *
 * ## 无参数 = 交互式菜单（2026-10-05 改）
 *
 * 早先无参数等价于 `list`。现在改为**优先交互**：`ctx.userQuestions` 可用
 * （dst TUI 装了应答器，`dsh-auth` `/auth` 向导同款通路）时弹多级菜单；
 * 服务不可用（headless / Web）或用户取消时**回退文本概览**——绝不让命令
 * 因此报错。`agent` 必须透传给 `ask()`：按该服务的契约，人机交互只对
 * 「恰好是活运行时根」的那个 agent 有效，子 agent（owned child）没有
 * 人机应答器，不传会**永远阻塞**。
 *
 * ## ⚠️ `userQuestions` 必须**惰性取用**（不要静态 inject）
 *
 * 本仓库对「可能不存在的服务」一律 `ctx.get`（见 `src/index.ts` 的
 * `ctx.get('attachments')`、`jet-hub-rpc.ts` 对 `connection` 的 `ctx.inject`）。
 * 静态 `inject: [..., 'userQuestions']` 会让没有该服务的 profile 永久 pending。
 */
/**
 * 可跟在 provider 之后的动作（「provider 打头」写法用）。
 *
 * `credits` 是 `balance` 的别名（参考项目用前者），归一化时改写成后者。
 */
const PROVIDER_FIRST_ACTIONS = new Set(['list', 'credits', 'balance', 'add', 'login', 'use', 'on', 'off', 'refresh', 'rename', 'checkin', 'lock'])

/**
 * 把「provider 打头」的参数归一化成「动作打头」。
 *
 * ## 为什么需要（真实缺陷，2026-10-05）
 *
 * 用户按参考项目 `dsh-account-hub-tui` 的文档敲 `/account_hub buddy`，
 * 吃到的是「未知子命令：buddy」—— 本仓库既有子命令全是**动作打头**
 * （`/account_hub list buddy`）。两种写法都要认：
 * - `/account_hub buddy`            → `list buddy`
 * - `/account_hub buddy use 2`      → `use buddy 2`
 * - `/account_hub buddy add`        → `add buddy`
 * - `/account_hub buddy on 1`       → `on buddy 1`
 * - `/account_hub buddy checkin`    → `checkin buddy`
 *
 * 非 provider 打头时原样返回，故既有用法一字不变。
 */
function normalizeProviderFirst(input: readonly string[]): string[] {
  const [head, ...rest] = input
  if (head === undefined) return []
  // 不是已知 provider id ⇒ 原样（既有「动作打头」写法）
  if (PROVIDER_LABELS[head] === undefined) return [...input]
  const hasAction = rest[0] !== undefined && PROVIDER_FIRST_ACTIONS.has(rest[0])
  const action = hasAction ? (rest[0] as string) : 'list'
  const tail = hasAction ? rest.slice(1) : rest
  return [action === 'credits' ? 'balance' : action, head, ...tail]
}

async function dispatch(ctx: Context, ops: JetHubOps, invocation: CommandInvocation): Promise<CommandResult> {
  const args = normalizeProviderFirst(tokens(invocation.rawInput))
  const sub = args[0] ?? 'menu'
  try {
    switch (sub) {
      case 'menu':
      case 'interactive':
        return await interactiveHub(ctx, ops, invocation)

      case 'help':
        return { kind: 'success', text: USAGE }

      case 'add':
      case 'login': {
        const [, provider] = args
        if (provider === undefined) {
          return { kind: 'error', text: `用法：/account_hub ${sub} <provider>` }
        }
        if (PROVIDER_LABELS[provider] === undefined) {
          return { kind: 'error', text: `未知 provider「${provider}」。可用值：${Object.keys(PROVIDER_LABELS).join(' / ')}` }
        }
        return await startLogin(ctx, ops, provider)
      }

      case 'on':
      case 'off': {
        const [, provider, slot] = args
        if (provider === undefined || slot === undefined) {
          return { kind: 'error', text: `用法：/account_hub ${sub} <provider> <序号>（序号见 /account_hub list <provider>）` }
        }
        const listed = unwrap(await ops.handleMethod('account.list', { provider }))
        if (!listed.ok) return { kind: 'error', text: `✗ ${label(provider)} 账号列表读取失败：${listed.error}` }
        const accounts = ((listed.value ?? {}) as { accounts?: AccountRow[] }).accounts ?? []
        const index = Number(slot)
        if (!Number.isInteger(index) || index < 1 || index > accounts.length) {
          return { kind: 'error', text: `序号必须是 1–${accounts.length} 的整数（收到：${slot}）` }
        }
        const target = accounts[index - 1]
        const enabled = sub === 'on'
        const updated = unwrap(await ops.handleMethod('account.update', { accountId: target.id, patch: { enabled } }))
        if (!updated.ok) return { kind: 'error', text: `✗ 设置失败：${updated.error}` }
        const who = target.accountName ?? target.nickname ?? target.id
        return { kind: 'success', text: `${label(provider)} 的 ${who} 已${enabled ? '启用' : '停用'}` }
      }

      case 'rename': {
        const [, provider, slot, ...nicknameParts] = args
        const nickname = nicknameParts.join(' ').trim()
        if (provider === undefined || slot === undefined || nickname.length === 0) {
          return { kind: 'error', text: '用法：/account_hub rename <provider> <序号> <新昵称>' }
        }
        const listed = unwrap(await ops.handleMethod('account.list', { provider }))
        if (!listed.ok) return { kind: 'error', text: `✗ ${label(provider)} 账号列表读取失败：${listed.error}` }
        const accounts = ((listed.value ?? {}) as { accounts?: AccountRow[] }).accounts ?? []
        const index = Number(slot)
        if (!Number.isInteger(index) || index < 1 || index > accounts.length) {
          return { kind: 'error', text: `序号必须是 1–${accounts.length} 的整数（收到：${slot}）` }
        }
        const target = accounts[index - 1]
        const updated = unwrap(await ops.handleMethod('account.update', { accountId: target.id, patch: { nickname } }))
        if (!updated.ok) return { kind: 'error', text: `✗ 改名失败：${updated.error}` }
        return { kind: 'success', text: `${label(provider)} 的账号已改名为「${nickname}」` }
      }

      case 'list':
        return { kind: 'success', text: await renderList(ops, args[1]) }

      case 'use': {
        const [, provider, slot] = args
        if (provider === undefined || slot === undefined) {
          return { kind: 'error', text: '用法：/account_hub use <provider> <序号>（序号见 /account_hub list）' }
        }
        const listed = unwrap(await ops.handleMethod('account.list', { provider }))
        if (!listed.ok) return { kind: 'error', text: `✗ ${label(provider)} 账号列表读取失败：${listed.error}` }
        const accounts = ((listed.value ?? {}) as { accounts?: AccountRow[] }).accounts ?? []
        const index = Number(slot)
        if (!Number.isInteger(index) || index < 1 || index > accounts.length) {
          return { kind: 'error', text: `序号必须是 1–${accounts.length} 的整数（收到：${slot}）` }
        }
        const target = accounts[index - 1]
        const orderedIds = [
          target.id,
          ...accounts.filter((row) => row.id !== target.id).map((row) => row.id),
        ]
        const reordered = unwrap(await ops.handleMethod('account.reorder', { provider, orderedIds }))
        if (!reordered.ok) return { kind: 'error', text: `✗ 切换失败：${reordered.error}` }
        const who = target.accountName ?? target.nickname ?? target.id
        return { kind: 'success', text: `已将 ${label(provider)} 的主账号切换为 ${who}` }
      }

      case 'balance': {
        const [, provider] = args
        if (provider === undefined) return { kind: 'error', text: '用法：/account_hub balance <provider>' }
        const result = unwrap(await ops.handleMethod('credits.balances', { provider }))
        if (!result.ok) return { kind: 'error', text: `✗ ${label(provider)} 余额查询失败：${result.error}` }
        const rows = ((result.value ?? {}) as { accounts?: BalanceRow[] }).accounts ?? []
        if (rows.length === 0) return { kind: 'success', text: `${label(provider)}：没有账号` }
        const lines = [`${label(provider)} 积分余额：`]
        for (const row of rows) {
          if (row.balance === null) {
            // ⚠️ 如实区分「查不到」与「真是 0」——二者排查方向完全相反
            //   （前者看凭据/网络，后者看账期）。
            lines.push(`  ✗ ${row.nickname}：${row.error ?? '查询失败'}`)
            continue
          }
          lines.push(`  ✓ ${row.nickname}：${row.balance.total}`)
          for (const pack of row.balance.packages ?? []) {
            lines.push(`      └ ${pack.name}：剩 ${pack.remaining}${pack.unit ? ` ${pack.unit}` : ''}`)
          }
        }
        return { kind: 'success', text: lines.join('\n') }
      }

      case 'checkin': {
        const [, provider] = args
        return await dispatchCheckin(ops, provider)
      }

      case 'lock': {
        const [, provider, toggle] = args
        if (provider === undefined || toggle === undefined) {
          return { kind: 'error', text: '用法：/account_hub lock <provider> on|off' }
        }
        if (!LOCKABLE_PROVIDERS.has(provider)) {
          return {
            kind: 'error',
            text: `${label(provider)} 不支持永久额度锁定。支持：${[...LOCKABLE_PROVIDERS].join(' / ')}`,
          }
        }
        const locked = parseToggle(toggle)
        if (locked === undefined) return { kind: 'error', text: `无法识别开关值：${toggle}（只接受 on / off）` }
        const result = unwrap(await ops.handleMethod('credits.permanentLock', { provider, locked }))
        if (!result.ok) return { kind: 'error', text: `✗ 设置失败：${result.error}` }
        return { kind: 'success', text: `${label(provider)} 永久额度锁定已${locked ? '开启' : '关闭'}` }
      }

      case 'provider': {
        const [, provider, toggle] = args
        if (provider === undefined || toggle === undefined) {
          return { kind: 'error', text: '用法：/account_hub provider <id> on|off' }
        }
        const enabled = parseToggle(toggle)
        if (enabled === undefined) return { kind: 'error', text: `无法识别开关值：${toggle}（只接受 on / off）` }
        const result = unwrap(await ops.handleMethod('provider.setEnabled', { provider, enabled }))
        if (!result.ok) return { kind: 'error', text: `✗ ${label(provider)} 开关失败：${result.error}` }
        const value = result.value as { models?: number; accounts?: number }
        return {
          kind: 'success',
          text: `${label(provider)} 已${enabled ? '开启' : '关闭'}：`
            + `${enabled ? '清空' : '关闭'} ${value.models ?? 0} 个模型开关、`
            + `${enabled ? '启用' : '停用'} ${value.accounts ?? 0} 个账号`,
        }
      }

      case 'gateway': {
        const [, toggle] = args
        if (toggle === undefined || toggle === 'status') {
          const result = unwrap(await ops.handleMethod('gateway.getEnabled', undefined))
          if (!result.ok) return { kind: 'error', text: `✗ 网关状态读取失败：${result.error}` }
          const value = result.value as {
            enabled?: boolean
            running?: boolean
            blockedByEnv?: boolean
            address?: string | null
            apiKey?: { value: string } | null
          }
          const lines = [
            `本机 OpenAI 兼容网关：开关 ${value.enabled === false ? '关' : '开'}`,
            `  监听：${value.address ?? '（未监听）'}`,
            `  运行态：${value.running === true ? '运行中' : '未运行'}`,
          ]
          if (value.blockedByEnv === true) lines.push('  ⚠ 已被环境变量 DSH_OPENAI_GATEWAY_ENABLED 阻止')
          if (value.apiKey !== null && value.apiKey !== undefined) lines.push(`  API Key：${value.apiKey.value}`)
          return { kind: 'success', text: lines.join('\n') }
        }
        const enabled = parseToggle(toggle)
        if (enabled === undefined) return { kind: 'error', text: `无法识别开关值：${toggle}（只接受 on / off / status）` }
        const result = unwrap(await ops.handleMethod('gateway.setEnabled', { enabled }))
        if (!result.ok) return { kind: 'error', text: `✗ 网关开关失败：${result.error}` }
        const value = result.value as { running?: boolean; blockedByEnv?: boolean }
        const suffix = value.blockedByEnv === true
          ? '（已被 DSH_OPENAI_GATEWAY_ENABLED 阻止）'
          : value.running === true ? '' : '（已写入开关，但未在监听，可能是端口被占用）'
        return { kind: 'success', text: `本机网关已${enabled ? '开启' : '关闭'}${suffix}` }
      }

      case 'refresh': {
        const [, accountId] = args
        if (accountId === undefined) return { kind: 'error', text: '用法：/account_hub refresh <accountId>' }
        const result = unwrap(await ops.handleMethod('account.refresh', { accountId }))
        if (!result.ok) return { kind: 'error', text: `✗ 续期失败：${result.error}` }
        const value = result.value as { success?: boolean; error?: string }
        if (value.success === false) return { kind: 'error', text: `✗ 续期失败：${value.error ?? '未知原因'}` }
        broadcastCatalogChanged(ctx)
        return { kind: 'success', text: `已续期账号 ${accountId}` }
      }

      case 'reset': {
        const [, provider] = args
        if (provider === undefined) return { kind: 'error', text: '用法：/account_hub reset <provider>' }
        const result = unwrap(await ops.handleMethod('account.resetAll', { provider }))
        if (!result.ok) return { kind: 'error', text: `✗ 清除限流标记失败：${result.error}` }
        return { kind: 'success', text: `已清除 ${label(provider)} 的模型限流标记` }
      }

      default:
        return { kind: 'error', text: `未知子命令：${sub}\n${USAGE}` }
    }
  } catch (error) {
    // 兜底：任何未预期异常都变成一句人话，而不是把 stack 摔到 UI 上。
    return { kind: 'error', text: `✗ ${sub} 执行异常：${describe(error)}` }
  }
}

/**
 * 注册 `/account_hub` 斜杠命令。
 *
 * ⚠️ **重名即抛**：`CommandRuntime.register` 在同一 scope 内不允许重名，
 * 而这里**不**自行 try/catch 吞掉 —— 吞掉会让「命令没注册上」静默无感，
 * 比响亮失败难查得多。调用方须保证只调一次。
 */
export function registerAccountHubCommand(ctx: Context, ops: JetHubOps): void {
  ctx.effect(function* () {
    yield ctx.commands.register({
      name: ACCOUNT_HUB_COMMAND,
      description: '账号中心：选择 provider、登录/切换/管理账号（无参数进交互菜单）',
      input: { hint: '[provider|menu|use|balance|checkin|lock|provider|gateway|refresh|reset] …' },
      handler: (invocation: CommandInvocation): Promise<CommandResult> =>
        dispatch(ctx, ops, invocation),
    })
  }, 'account-hub command')
}
