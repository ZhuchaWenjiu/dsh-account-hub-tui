/**
 * dsh-account-hub-tui — 把 dsh-account-hub 的账号管理接到 dst 的斜杠命令上。
 *
 * 交互式流（v2）：`/account_hub` 弹出 provider 选择菜单（ctx.userQuestions
 * 的选项卡片，TUI 对「无 agent 的请求」刻意应答——dsh-auth 的 /auth 向导
 * 同款通路），选定后进入该 provider 的操作菜单：添加账号（浏览器登录）/
 * 切换优先账号/启停/续期/详情；未登录时直接引导登录。
 *
 * 纯桥接：不持有业务状态，读写都打在 dsh-account-hub 注册到 cordis 上下文的
 * 服务上 —— `accountPool`（账号池）与各 provider 的 `*Auth` 服务实例。
 * 服务访问统一走 ctx.reflect.get（cordis 的「无 inject 要求」底层访问器）：
 * 直接 ctx.accountPool 会被 proxy 拒绝（cannot get property ... without inject）；
 * 改静态 inject 则 hub 缺席时本插件永久 pending、整个 profile 启动失败。
 * reflect.get 让两插件解耦：hub 缺席时命令报友好错误而已。
 *
 * 登录全部走 hub 自己的服务方法（与 web 面板 account.create RPC 同款时序）：
 * - codearts / lobsterai / trae-cn：prepareLogin() → 占位条目 → 打开
 *   session.loginUrl → 后台 awaitCredential() + persistLoginResult() 补全；
 * - qoder / qoder-cn：同两段式（设备流，persistLoginResult 内部 awaitToken）；
 * - buddy / buddy-cn：login({openBrowser, refName, accountId, pool}) 一步式，
 *   由它自己在完成时入池（不建占位，避免与它的 addAccount 撞出双条目）。
 *
 * 模型侧无需本插件参与：hub 适配器本就按「一个模型条目 + 账号池逐请求选号」
 * 注册（ctx.llm.registerConfigurableProviders，listModels 无账号时整组隐藏），
 * 登录后 /model 模型选择器自然出现该 provider 的模型并自动在全部账号间路由。
 */

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const name = 'account-hub-tui'
export const inject = ['commands']

const PROVIDERS = ['codearts', 'buddy-cn', 'buddy', 'lobsterai', 'trae-cn', 'qoder', 'qoder-cn']

const AUTH_SERVICE_KEY = {
  codearts: 'codeartsAuth',
  'buddy-cn': 'buddyCnAuth',
  buddy: 'buddyAuth',
  lobsterai: 'lobsteraiAuth',
  'trae-cn': 'traeCnAuth',
  qoder: 'qoderAuth',
  'qoder-cn': 'qoderCnAuth',
}

const PROVIDER_LABEL = {
  codearts: 'CodeArts（华为云）',
  'buddy-cn': 'Buddy CN',
  buddy: 'Buddy 国际版',
  lobsterai: 'LobsterAI',
  'trae-cn': 'Trae CN',
  qoder: 'Qoder 国际版',
  'qoder-cn': 'Qoder CN',
}

/** 两段式登录的 provider（buddy 系除外，见文件头说明）。 */
const TWO_PHASE_PROVIDERS = new Set(['codearts', 'lobsterai', 'trae-cn', 'qoder', 'qoder-cn'])

const HINT_INSTALL = '**未找到 dsh-account-hub 的账号池服务**（ctx.accountPool 不存在）。\n\n'
  + '请先在 dsh-tui profile 安装 dsh-account-hub 后重启会话：\n\n'
  + '`dsh plugin --profile dsh-tui add "https://github.com/gurio-wine/dsh-account-hub.git"`'

const ok = text => ({ kind: 'success', text })
const err = text => ({ kind: 'error', text })

/** 跨插件读取服务：reflect.get 不做 inject 校验，兜底直接属性访问。 */
function service(ctx, name) {
  try {
    const viaReflect = ctx.reflect?.get?.(name, false)
    if (viaReflect !== undefined) return viaReflect
  } catch {}
  try {
    return ctx[name]
  } catch {
    return undefined
  }
}

function logger(ctx) {
  return service(ctx, 'logger') ?? { info() {}, warn() {} }
}

// ─────────────────────────── 基础工具 ───────────────────────────

function normalizeProvider(raw) {
  const key = String(raw ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
  const aliases = {
    codearts: 'codearts',
    buddycn: 'buddy-cn',
    buddy: 'buddy',
    lobsterai: 'lobsterai',
    lobster: 'lobsterai',
    traecn: 'trae-cn',
    trae: 'trae-cn',
    qoder: 'qoder',
    qodercn: 'qoder-cn',
  }
  return aliases[key]
}

function fmtTime(ms) {
  if (!ms) return undefined
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return undefined
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function parseIndex(raw, count) {
  const n = Number.parseInt(raw, 10)
  if (!Number.isInteger(n) || n < 1 || n > count) return undefined
  return n
}

/** 8 字符小写 hex 短 id（与 account-hub-rpc.ts 的 shortId 同款）。 */
function shortId() {
  return randomBytes(4).toString('hex')
}

/** 账号凭据 ref 名：PROVIDER_ACCOUNT_XXXX，连字符归一为下划线（同款归一）。 */
function refNameFor(provider) {
  const suffix = shortId().toUpperCase()
  return `${provider.toUpperCase().replace(/-/g, '_')}_ACCOUNT_${suffix}`
}

/** 系统默认浏览器打开 URL（登录的第二段时序里「打开动作归客户端」）。 */
function openInBrowser(url) {
  try {
    if (process.platform === 'win32') {
      // rundll32 对带查询参数的 URL 最稳（cmd start 会吃掉 &）。
      const child = spawn('rundll32', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore' })
      child.unref?.()
    } else {
      const opener = process.platform === 'darwin' ? 'open' : 'xdg-open'
      const child = spawn(opener, [url], { detached: true, stdio: 'ignore' })
      child.unref?.()
    }
  } catch {
    // 打不开就让用户手动复制 URL（返回的文本里有提示）。
  }
}

/**
 * 按 provider 取池内账号（保持**存储顺序**，即手动优先级顺序）。
 * 用 listAllAccounts() 而非 listAccounts(provider)：后者逐条 describe
 * 凭据（多一次 IO），只有展示来源时才需要。
 */
async function providerEntries(pool, provider) {
  const all = await pool.listAllAccounts()
  return all.filter(a => a.provider === provider)
}

// ─────────────────────────── 交互问答 ───────────────────────────

/**
 * 弹出单题选项菜单，返回选中的 option.label；用户取消（空选/中断）返回 null。
 * userQuestions 服务不可用（headless 等）返回 undefined，由调用方走文本回退。
 * 问答中途的异常按取消处理：交互失败不应把命令变成 error 卡片。
 */
async function askOne(ctx, { question, options, header }) {
  const uq = service(ctx, 'userQuestions')
  if (!uq || typeof uq.ask !== 'function') return undefined
  try {
    const answer = await uq.ask({
      questions: [{ id: 'account-hub', question, header, options }],
    })
    const picked = answer?.answers?.[0]?.selected?.[0]
    return picked ?? null
  } catch {
    return null
  }
}

/** 把 label 映射回选项对象（ask 返回的是 label 本身）。 */
function optionByLabel(options, label) {
  return options.find(o => o.label === label)
}

// ─────────────────────────── hub 内部模块加载（积分/签到） ───────────────────────────

let hubRpcPromise

/**
 * 惰性加载 dsh-account-hub 的 RPC 模块（collectProviderBalances /
 * performCheckinSweep 是模块级导出，但包的 exports map 不放行子路径导入，
 * 故按「profile node_modules 同级包 → 自身兄弟目录」的顺序探测后以绝对
 * file URL 导入）。拿不到或版本不匹配时返回 undefined，命令报可读错误。
 *
 * 这是积分/签到功能的**唯一**深耦合点：hub 升级若移动了这两个导出，
 * 余额/签到命令会降级报错，账号管理主流程不受影响。
 */
function loadHubRpc() {
  if (hubRpcPromise) return hubRpcPromise
  hubRpcPromise = (async () => {
    const ownDir = dirname(fileURLToPath(import.meta.url))
    const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
    const candidates = [
      // link 安装：真实代码在开发目录，宿主 node_modules 里是同级包目录
      join(dshHome, 'profiles', 'dsh-tui', 'node_modules', 'dsh-account-hub', 'lib', 'account-hub-rpc.js'),
      // 常规安装：与自己在同一层 node_modules
      join(ownDir, '..', '..', 'dsh-account-hub', 'lib', 'account-hub-rpc.js'),
    ]
    for (const candidate of candidates) {
      if (!existsSync(candidate)) continue
      try {
        return await import(pathToFileURL(candidate).href)
      } catch {
        // 换下一个候选
      }
    }
    return undefined
  })().catch(() => undefined)
  return hubRpcPromise
}

/** 签到结果语义 → 人类可读（ClaimOutcome 各变体的字段见 credits.ts）。 */
function describeOutcome(outcome) {
  if (!outcome || typeof outcome !== 'object') return '未知结果'
  switch (outcome.kind) {
    case 'claimed':
      return `签到成功，+${outcome.credit} 积分${outcome.streakDays ? `（连续 ${outcome.streakDays} 天）` : ''}`
    case 'already-claimed':
      return '今天已签过'
    case 'inactive':
      return `账号不在活动范围：${outcome.message ?? 'inactive'}`
    case 'unavailable':
      return '服务端暂不受理（稍后自动重试，无需操作）'
    case 'abnormal':
      return `状态异常：${outcome.message ?? '请重新登录校准'}`
    case 'undetermined':
      return '今天是否已签无法判定（稍后自动重试）'
    case 'failed':
      return `失败：${outcome.message ?? '原因未知'}`
    default:
      return String(outcome.kind)
  }
}

/**
 * 给深导入的 hub 函数用的「开放上下文」：hub 内部会自由访问
 * ctx.credentials / ctx.logger 等服务，而注入检查跟着**调用方的 fiber**
 * 走——桥接插件的 ctx 上这些访问会被拒（cannot get property "credentials"
 * without inject）。代理把服务属性的读取改走 reflect（无 inject 要求），
 * 其余（own property / 方法）原样透传。
 */
function openContext(ctx) {
  return new Proxy(ctx, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && !prop.startsWith('_') && prop !== 'then') {
        try {
          const viaReflect = target.reflect?.get?.(prop, false)
          if (viaReflect !== undefined) return viaReflect
        } catch {}
      }
      return Reflect.get(target, prop, receiver)
    },
  })
}

// ─────────────────────────── 文本视图（回退/详情） ───────────────────────────

async function showOverview(ctx, pool) {
  const all = await pool.listAllAccounts()
  // 命令卡片折叠态只显示首行摘要：把 7 个 provider 的状态压进第一行，
  // 有账号的排前面；完整提示跟在后面（展开卡片可见）。
  const withAccounts = []
  const empty = []
  for (const p of PROVIDERS) {
    const entries = all.filter(a => a.provider === p)
    if (entries.length === 0) {
      empty.push(p)
      continue
    }
    const firstEnabled = entries.find(e => e.enabled)
    withAccounts.push(firstEnabled
      ? `${p}:${entries.length}个,优先「${firstEnabled.nickname}」`
      : `${p}:${entries.length}个,全部停用`)
  }
  const summary = withAccounts.length > 0
    ? `${withAccounts.join(' · ')}${empty.length > 0 ? ` · 其余 ${empty.length} 个 provider 无账号` : ''}`
    : `7 个 provider 均无账号（${PROVIDERS.join(' / ')}）`
  return ok(
    `**账号概览** ${summary}\n\n`
    + '切换 `/account_hub <provider> use <序号>` · 详情 `/account_hub <provider>` · '
    + '启停 `on|off <序号>` · 续期 `refresh <序号>` · 改名 `rename <序号> <昵称>`')
}

async function showProvider(ctx, pool, provider) {
  const entries = await pool.listAccounts(provider)
  if (entries.length === 0) {
    return ok(`**${PROVIDER_LABEL[provider]}**（${provider}）暂无账号。用交互模式运行 /account_hub，或 CodeArts 用 /codearts-login 登录。`)
  }
  const balances = typeof pool.balanceSnapshot === 'function'
    ? pool.balanceSnapshot(provider)
    : undefined
  const now = Date.now()
  const firstEnabledIdx = entries.findIndex(e => e.enabled)
  const lines = [
    `**${PROVIDER_LABEL[provider]}**（${provider}）— ${entries.length} 个账号，自动选用顺序第一的启用账号：`,
    '',
  ]
  entries.forEach((e, i) => {
    const mark = i === firstEnabledIdx ? '▸' : ' '
    const parts = [e.enabled ? '启用' : '停用']
    if (e.expiresAt) {
      const exp = fmtTime(e.expiresAt)
      parts.push(exp ? `过期 ${exp}` : '过期时间无效')
    }
    if (e.refreshable) parts.push('可续期')
    if (e.modelRateLimits) {
      const limited = Object.values(e.modelRateLimits).filter(t => t > now)
      if (limited.length > 0) {
        parts.push(`限流中（${limited.length} 个模型，最早 ${fmtTime(Math.min(...limited))} 解除）`)
      }
    }
    const bal = balances instanceof Map ? balances.get(e.id) : undefined
    if (bal !== undefined) parts.push(`余额 ${bal}`)
    if (e.refreshError) parts.push(`最近续期出错: ${e.refreshError}`)
    if (e.source) parts.push(`来源 ${e.source}`)
    lines.push(`- ${i + 1}. ${mark} **${e.nickname}**（${e.id}）· ${parts.join(' · ')}`)
  })
  lines.push(
    '',
    `切换 \`/account_hub ${provider} use <序号>\` · 启停 \`on|off <序号>\` · 续期 \`refresh <序号>\` · 改名 \`rename <序号> <昵称>\``,
  )
  return ok(lines.join('\n'))
}

// ─────────────────────────── 池操作（参数式与交互式共用） ───────────────────────────

async function useAccount(pool, provider, entry) {
  const entries = await providerEntries(pool, provider)
  if (!entries.some(e => e.id === entry.id)) {
    return err(`账号「${entry.nickname}」已不存在（可能刚被删除），请重试。`)
  }
  if (!entry.enabled) {
    return err(`「${entry.nickname}」当前是停用状态，先启用再切换。`)
  }
  const firstEnabled = entries.find(e => e.enabled)
  if (firstEnabled && firstEnabled.id === entry.id && entries[0].id === entry.id) {
    return ok(`「${entry.nickname}」已经排在 ${provider} 序列首位。`)
  }
  const orderedIds = [entry.id, ...entries.filter(e => e.id !== entry.id).map(e => e.id)]
  await pool.reorderAccounts(provider, orderedIds)
  return ok(`已把「${entry.nickname}」设为 **${PROVIDER_LABEL[provider]}** 的优先账号。后续请求将优先使用它（仍受启用状态与限流过滤约束）。`)
}

async function setEnabled(pool, provider, entry, enabled) {
  if (entry.enabled === enabled) {
    return ok(`「${entry.nickname}」已经是${enabled ? '启用' : '停用'}状态。`)
  }
  await pool.updateAccount(entry.id, { enabled })
  if (!enabled) {
    return ok(`已停用「${entry.nickname}」。自动选号将跳过它；如它原是优先账号，会自动落到下一个启用的账号。`)
  }
  return ok(`已启用「${entry.nickname}」。它回到手动顺序参与自动选号。`)
}

async function refreshAccount(ctx, pool, provider, entry) {
  const svc = service(ctx, AUTH_SERVICE_KEY[provider])
  if (!svc || typeof svc.refreshAccountCredential !== 'function') {
    return err(`未找到 ${provider} 的认证服务（${AUTH_SERVICE_KEY[provider]}）。dsh-account-hub 是否完整安装？`)
  }
  try {
    // 与 RPC account.refresh 同款入口：按账号自己的凭据 ref 续期，
    // 不碰 provider 的默认单凭据（account-hub-rpc.ts 修复过的错刷缺陷）。
    await svc.refreshAccountCredential(entry.credentialRef)
    return ok(`「${entry.nickname}」凭据已静默续期。`)
  } catch (error) {
    return err(`续期失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

async function renameAccount(pool, provider, entry, nickname) {
  await pool.updateAccount(entry.id, { nickname })
  return ok(`已把「${entry.nickname}」改名为「${nickname}」。`)
}

// ─────────────────────────── 登录（两段式/一步式） ───────────────────────────

function startLogin(ctx, pool, provider) {
  const svc = service(ctx, AUTH_SERVICE_KEY[provider])
  if (!svc) return err(`未找到 ${provider} 的认证服务（${AUTH_SERVICE_KEY[provider]}）。dsh-account-hub 是否完整安装？`)
  const log = logger(ctx)
  const id = `${provider}-${shortId()}`
  const refName = refNameFor(provider)

  try {
    // Buddy 系一步式：login() 自带「开浏览器 → 等授权 → 写凭据 → 入池」，
    // 且在完成时才 addAccount —— 不能预建占位，否则会出现双条目。
    // 不 await：浏览器授权可能长达数分钟；失败只记日志，池中无残留。
    if (provider === 'buddy' || provider === 'buddy-cn') {
      const done = svc.login({ openBrowser: openInBrowser, refName, accountId: id, pool })
      done.then(
        () => log.info?.(`[account-hub-tui] ${provider} login completed: ${id}`),
        (error) => {
          log.warn?.(`[account-hub-tui] ${provider} login failed: ${error instanceof Error ? error.message : String(error)}`)
        },
      )
      return ok(`已打开 **${PROVIDER_LABEL[provider]}** 的登录页面，完成授权后账号会自动加入账号池。\n\n完成后运行 \`/account_hub ${provider}\` 查看；若浏览器未弹出，请允许弹窗后重试。`)
    }

    // 其余五个 provider 两段式：与 web 面板 account.create 同款时序。
    if (typeof svc.prepareLogin !== 'function') {
      return err(`dsh-account-hub 的 ${provider} 服务不支持 prepareLogin（版本过旧？）。`)
    }
    const prepare = svc.prepareLogin()
    return Promise.resolve(prepare).then(async (prepared) => {
      if (!prepared || prepared.ok !== true) {
        const reason = prepared?.message ?? prepared?.error ?? '未知原因'
        return err(`无法启动登录：${reason}（同一 provider 同时只允许一个登录会话）`)
      }
      const session = prepared.session
      // 占位条目：无凭据、pending 形态；第二段完成时由 persistLoginResult 补全。
      await pool.addAccount({
        id,
        provider,
        nickname: id,
        enabled: true,
        credentialRef: refName,
        refreshable: false,
        createdAt: Date.now(),
      })
      if (session?.loginUrl) openInBrowser(session.loginUrl)
      // 第二段（后台）：awaitCredential（qoder 是 persistLoginResult 内部
      // awaitToken）→ 写凭据 + 补全占位；失败即移除占位，不留幽灵账号。
      const completion = typeof session?.awaitCredential === 'function'
        ? session.awaitCredential().then(flow => svc.persistLoginResult(flow, { refName, accountId: id, pool }))
        : svc.persistLoginResult(session, { refName, accountId: id, pool })
      completion.then(
        () => log.info?.(`[account-hub-tui] ${provider} login completed: ${id}`),
        (error) => {
          log.warn?.(`[account-hub-tui] ${provider} login failed: ${error instanceof Error ? error.message : String(error)}`)
          pool.removeAccount(id).catch(() => {})
        },
      )
      const opened = session?.loginUrl
        ? '已打开授权页面'
        : '已启动设备流授权（按弹出的页面提示操作）'
      return ok(`${opened}。占位账号「${id}」会在你完成授权后自动补全。\n\n完成后运行 \`/account_hub ${provider}\` 查看；若浏览器未弹出，请允许弹窗后重试。`)
    }).catch(error => err(`登录启动失败：${error instanceof Error ? error.message : String(error)}`))
  } catch (error) {
    return err(`登录启动失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

// ─────────────────────────── 积分余额与签到 ───────────────────────────

/**
 * 查询某 provider 全部账号的积分余额（逐账号一次网络请求），
 * 并像 web 面板的 credits.balances 一样把结果回写进账号池缓存
 * （自动路由的「最高优先」档与 /account_hub 概览都读这份缓存）。
 */
async function showCredits(ctx, pool, provider) {
  const hubRpc = await loadHubRpc()
  if (!hubRpc || typeof hubRpc.collectProviderBalances !== 'function') {
    return err('无法加载 dsh-account-hub 的余额模块（版本过旧或安装不完整）。')
  }
  const deps = {
    pool,
    ctx: openContext(ctx),
    qoder: service(ctx, 'qoderAuth'),
    qoderCn: service(ctx, 'qoderCnAuth'),
  }
  let accounts
  try {
    accounts = await hubRpc.collectProviderBalances(deps, provider)
  } catch (error) {
    return err(`余额查询失败：${error instanceof Error ? error.message : String(error)}`)
  }
  if (accounts === undefined) return err(`provider「${provider}」不支持余额查询。`)

  // 回写余额缓存（与 credits.balances RPC 的 recordCollectedBalances 同口径）。
  try {
    const entries = accounts
      .filter(a => a.balance && Number.isFinite(a.balance.total))
      .map(a => ({ accountId: a.accountId, total: a.balance.total }))
    if (entries.length > 0 && typeof pool.recordBalances === 'function') {
      pool.recordBalances(provider, entries)
    }
  } catch {}

  const oneLiners = accounts.map((a) => {
    if (a.balance && Number.isFinite(a.balance.total)) return `${a.nickname}=${a.balance.total}`
    return `${a.nickname}=查询失败`
  })
  const lines = [`**${PROVIDER_LABEL[provider] ?? provider}** 积分余额：${oneLiners.join(' · ')}`, '']
  for (const a of accounts) {
    if (!a.balance) {
      lines.push(`- **${a.nickname}**：${a.error ?? '余额查询失败'}`)
      continue
    }
    const b = a.balance
    lines.push(`- **${a.nickname}**：剩余 **${b.total}**（${b.packages?.length ?? 0} 个资源包）`)
    for (const pkg of b.packages ?? []) {
      const state = pkg.active ? '' : '（已失效，不可用）'
      lines.push(`  - ${pkg.name}:剩 ${pkg.remaining}/${pkg.total}${state}`)
    }
    if (Number.isFinite(b.expiredTotal) && b.expiredTotal > 0) {
      lines.push(`  - 另有 ${b.expiredTotal} 额度已失效`)
    }
    if (a.error) lines.push(`  - 注意：${a.error}`)
  }
  return ok(lines.join('\n'))
}

/**
 * 一键签到：全量 sweep（只在「此刻可签」的账号上执行，模块级互斥防并发），
 * 与自动签到定时器共用同一份分派逻辑。focusProvider 的结果排在最前展示。
 */
async function runCheckinSweep(ctx, pool, focusProvider) {
  const hubRpc = await loadHubRpc()
  if (!hubRpc || typeof hubRpc.performCheckinSweep !== 'function') {
    return err('无法加载 dsh-account-hub 的签到模块（版本过旧或安装不完整）。')
  }
  const deps = {
    ctx: openContext(ctx),
    pool,
    lobsterai: service(ctx, 'lobsteraiAuth'),
    qoder: service(ctx, 'qoderAuth'),
    qoderCn: service(ctx, 'qoderCnAuth'),
  }
  let resp
  try {
    resp = await hubRpc.performCheckinSweep(deps)
  } catch (error) {
    return err(`签到执行失败：${error instanceof Error ? error.message : String(error)}`)
  }
  if (!resp || typeof resp !== 'object' || !Array.isArray(resp.providers)) {
    return err('签到返回了无法识别的结果。')
  }
  if (resp.running === false) {
    return ok('另一趟签到正在进行中（自动签到定时器或面板），稍后再试。')
  }

  const ordered = [...resp.providers].sort((a, b) => {
    if (a.provider === focusProvider) return -1
    if (b.provider === focusProvider) return 1
    return 0
  })
  const lines = []
  let totalClaimed = 0
  let totalCredit = 0
  for (const p of ordered) {
    if (!Array.isArray(p.results) || p.results.length === 0) continue
    const items = p.results.map((r) => {
      const summary = computeSummary(r.outcome)
      return `- ${r.nickname ?? r.accountId}：${summary}`
    })
    lines.push(`**${PROVIDER_LABEL[p.provider] ?? p.provider}**`, ...items, '')
    totalClaimed += countKind(p.results, 'claimed')
    totalCredit += sumCredit(p.results)
  }
  if (lines.length === 0) {
    return ok('今天没有需要签到的账号（全部已签或无可签活动）。')
  }
  lines.push(`本次签到成功 ${totalClaimed} 个账号，共 +${totalCredit} 积分。`)
  return ok(lines.join('\n'))
}

function countKind(results, kind) {
  return results.filter(r => r.outcome?.kind === kind).length
}

function sumCredit(results) {
  return results.reduce((sum, r) => sum + (r.outcome?.kind === 'claimed' ? Number(r.outcome.credit) || 0 : 0), 0)
}

function computeSummary(outcome) {
  if (outcome?.kind === 'claimed') return `✅ +${outcome.credit} 积分${outcome.streakDays ? `（连续 ${outcome.streakDays} 天）` : ''}`
  if (outcome?.kind === 'already-claimed') return '☑ 今天已签过'
  return describeOutcome(outcome)
}

// ─────────────────────────── 交互式菜单流 ───────────────────────────

async function accountPicker(ctx, provider, entries, { onlyEnabled = false } = {}) {
  const options = entries
    .map((e, i) => ({ entry: e, index: i }))
    .filter(({ entry }) => !onlyEnabled || entry.enabled)
    .map(({ entry, index }) => ({
      label: `${index + 1}. ${entry.nickname}${entry.enabled ? '' : '（已停用）'}`,
      description: `${entry.id} · 优先级 ${index + 1}`,
    }))
  if (options.length === 0) return { error: err('没有可选的账号（该 provider 的账号都被停用）。') }
  const picked = await askOne(ctx, {
    question: `选择账号（${PROVIDER_LABEL[provider]}）`,
    options,
    header: '账号',
  })
  if (picked === undefined || picked === null) return { cancelled: true }
  const match = optionByLabel(options, picked)
  return match ? { entry: match.entry } : { cancelled: true }
}

async function providerMenu(ctx, pool, provider) {
  const entries = await providerEntries(pool, provider)

  // 未登录：直接引导登录。
  if (entries.length === 0) {
    const picked = await askOne(ctx, {
      question: `**${PROVIDER_LABEL[provider]}**（${provider}）还没有登录账号`,
      header: '登录',
      options: [
        { label: '登录新账号', description: '打开浏览器完成授权，账号自动加入账号池' },
        { label: '返回', description: '回到概览' },
      ],
    })
    if (picked === '登录新账号') return startLogin(ctx, pool, provider)
    return undefined // 取消/返回 → 外层显示概览
  }

  const firstEnabled = entries.find(e => e.enabled)
  const picked = await askOne(ctx, {
    question: `**${PROVIDER_LABEL[provider]}** — ${entries.length} 个账号，当前优先：${firstEnabled ? firstEnabled.nickname : '（无启用账号）'}`,
    header: '账号中心',
    options: [
      { label: '添加账号', description: '浏览器登录一个新账号加入账号池' },
      { label: '切换优先账号', description: '选一个账号移到自动选号的首位' },
      { label: '启用 / 停用账号', description: '停用的账号不参与自动选号' },
      { label: '积分余额', description: '逐账号查询剩余额度（需联网）' },
      { label: '每日签到', description: '签今天可签的账号（全部 provider 一并处理）' },
      { label: '续期账号凭据', description: '按账号自己的凭据 ref 静默续期' },
      { label: '查看完整详情', description: '过期时间 / 限流 / 余额 / 来源' },
      { label: '返回', description: '回到概览' },
    ],
  })

  switch (picked) {
    case '添加账号':
      return startLogin(ctx, pool, provider)
    case '切换优先账号':
      return accountPicker(ctx, provider, entries, { onlyEnabled: true }).then(r =>
        r?.cancelled ? undefined : (r?.error ?? useAccount(pool, provider, r.entry)))
    case '启用 / 停用账号':
      return accountPicker(ctx, provider, entries).then(async (r) => {
        if (r?.cancelled) return undefined
        if (r?.error) return r.error
        return setEnabled(pool, provider, r.entry, !r.entry.enabled)
      })
    case '积分余额':
      return showCredits(ctx, pool, provider)
    case '每日签到':
      return runCheckinSweep(ctx, pool, provider)
    case '续期账号凭据':
      return accountPicker(ctx, provider, entries).then(async (r) => {
        if (r?.cancelled) return undefined
        if (r?.error) return r.error
        return refreshAccount(ctx, pool, provider, r.entry)
      })
    case '查看完整详情':
      return showProvider(ctx, pool, provider)
    default:
      return undefined // 取消/返回 → 外层显示概览
  }
}

/** 全部账号的余额与签到：先统一签到（今日积分先落账），再逐 provider 查余额。 */
async function globalCreditsAndCheckin(ctx, pool) {
  const all = await pool.listAllAccounts()
  const providersWithAccounts = [...new Set(all.map(a => a.provider))]
  const sections = []
  const checkin = await runCheckinSweep(ctx, pool, undefined)
  sections.push(checkin?.text ?? '签到：无可执行项')
  for (const p of providersWithAccounts) {
    const r = await showCredits(ctx, pool, p)
    if (r?.text) sections.push(r.text)
  }
  return ok(sections.join('\n\n'))
}

async function interactiveHub(ctx, pool) {
  const picked = await askOne(ctx, {
    question: '选择要管理的 provider',
    header: '账号中心',
    options: [
      { label: '★ 全部账号 · 余额与签到', description: '查所有账号剩余积分并完成今日签到' },
      ...PROVIDERS.map(p => ({ label: p, description: PROVIDER_LABEL[p] })),
    ],
  })
  if (picked === undefined || picked === null) return undefined
  if (picked === '★ 全部账号 · 余额与签到') {
    return globalCreditsAndCheckin(ctx, pool)
  }
  const provider = normalizeProvider(picked)
  if (!provider) return err(`未知 provider「${picked}」`)
  return providerMenu(ctx, pool, provider)
}

// ─────────────────────────── 命令入口 ───────────────────────────

export function apply(ctx) {
  ctx.commands.register({
    name: 'account_hub',
    description: '账号中心：选择 provider、登录/切换/管理 dsh-account-hub 账号',
    input: {
      hint: '[provider] [use|on|off|refresh|rename] [序号] — 无参数进入交互菜单',
    },
    handler: async (invocation) => {
      const tokens = String(invocation?.rawInput ?? '').trim().split(/\s+/).filter(Boolean)
      try {
        const pool = service(ctx, 'accountPool')
        if (!pool) return err(HINT_INSTALL)

        if (tokens.length === 0) {
          // 交互式优先；userQuestions 不可用或用户取消时回退文本概览。
          const uq = service(ctx, 'userQuestions')
          if (uq && typeof uq.ask === 'function') {
            const result = await interactiveHub(ctx, pool)
            return result ?? await showOverview(ctx, pool)
          }
          return await showOverview(ctx, pool)
        }
        if (tokens[0] === 'providers') {
          return ok(`可用 provider（简写 buddycn / traecn / qodercn 等也可）：\n\n${PROVIDERS.map(p => `${p}（${PROVIDER_LABEL[p]}）`).join(' · ')}`)
        }
        if (tokens[0] === 'checkin' || tokens[0] === 'signin') {
          return runCheckinSweep(ctx, pool, normalizeProvider(tokens[1]))
        }
        if (tokens[0] === 'credits' || tokens[0] === 'balances') {
          const all = await pool.listAllAccounts()
          const targets = all.length > 0 ? [...new Set(all.map(a => a.provider))] : []
          if (targets.length === 0) return err('账号池里还没有账号，先用 /account_hub 登录。')
          const sections = []
          for (const p of targets) {
            const r = await showCredits(ctx, pool, p)
            sections.push(r?.text ?? `**${p}** 余额查询失败`)
          }
          return ok(sections.join('\n\n'))
        }

        const provider = normalizeProvider(tokens[0])
        if (!provider) {
          return err(`未知 provider「${tokens[0]}」。可用值：${PROVIDERS.join('、')}（/account_hub 不带参数进入交互菜单）`)
        }

        const action = (tokens[1] ?? 'list').toLowerCase()
        const rest = tokens.slice(2)
        switch (action) {
          case 'list':
            return await showProvider(ctx, pool, provider)
          case 'credits':
          case 'balance':
            return showCredits(ctx, pool, provider)
          case 'add':
          case 'login':
            return startLogin(ctx, pool, provider)
          case 'use': {
            const entries = await providerEntries(pool, provider)
            if (entries.length === 0) return err(`**${PROVIDER_LABEL[provider]}**（${provider}）暂无账号。`)
            const n = parseIndex(rest[0], entries.length)
            if (n === undefined) return err(`序号必须是 1-${entries.length} 的整数，收到「${rest[0]}」。`)
            return await useAccount(pool, provider, entries[n - 1])
          }
          case 'on':
          case 'off': {
            const entries = await providerEntries(pool, provider)
            if (entries.length === 0) return err(`**${PROVIDER_LABEL[provider]}**（${provider}）暂无账号。`)
            const n = parseIndex(rest[0], entries.length)
            if (n === undefined) return err(`序号必须是 1-${entries.length} 的整数，收到「${rest[0]}」。`)
            return await setEnabled(pool, provider, entries[n - 1], action === 'on')
          }
          case 'refresh': {
            const entries = await providerEntries(pool, provider)
            if (entries.length === 0) return err(`**${PROVIDER_LABEL[provider]}**（${provider}）暂无账号。`)
            const n = parseIndex(rest[0], entries.length)
            if (n === undefined) return err(`序号必须是 1-${entries.length} 的整数，收到「${rest[0]}」。`)
            return await refreshAccount(ctx, pool, provider, entries[n - 1])
          }
          case 'rename': {
            const entries = await providerEntries(pool, provider)
            if (entries.length === 0) return err(`**${PROVIDER_LABEL[provider]}**（${provider}）暂无账号。`)
            const n = parseIndex(rest[0], entries.length)
            if (n === undefined) return err(`序号必须是 1-${entries.length} 的整数，收到「${rest[0]}」。`)
            const nickname = rest.slice(1).join(' ').trim()
            if (!nickname) return err('用法：`/account_hub <provider> rename <序号> <新昵称>`')
            return await renameAccount(pool, provider, entries[n - 1], nickname)
          }
          default:
            return err(`未知动作「${action}」。支持：list（默认）、add/login、use、on、off、refresh、rename、credits/balance。`)
        }
      } catch (error) {
        return err(`/account_hub 执行失败：${error instanceof Error ? error.message : String(error)}`)
      }
    },
  })
}
