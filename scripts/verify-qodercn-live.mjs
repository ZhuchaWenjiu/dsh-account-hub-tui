/**
 * QoderCN 一次性端到端验证：**登录 → 加密推理 → 积分**，全程只跑一次。
 *
 * ## 为什么需要它
 *
 * 设计文档 §13.2 要求「真实登录 + 真实推理 + 真实领取各一次」，但 e2e 探针依赖
 * 已存在的凭据；而凭据要么由用户重启宿主后在 Jet Hub 面板登录（改动面大），
 * 要么手工塞环境变量（易把 token 留在磁盘上）。本脚本把三件事合并成一次运行：
 *
 *   1. 打印授权 URL → 用户在浏览器点一次「授权」
 *   2. 轮询拿到 device token（含 `user_id`，即加密推理必需的 uid）
 *   3. **在内存里**直接跑加密推理与积分链路，只打印非机密结论
 *
 * ⚠️ **token 不落盘、不打印**：凭据只在进程内存里，脚本结束即消失。
 * 这是刻意设计 —— 避免把真实凭据写进 `.credentials.yaml` 或任何文件。
 *
 * ## 用法
 *
 *   pnpm build                      # 先编译出 lib/
 *   node scripts/verify-qodercn-live.mjs
 *   node scripts/verify-qodercn-live.mjs --model=qfmodel --no-claim
 *
 * `--no-claim` 跳过真实领取（只查余额与活动，全程只读）。
 */
import { setTimeout as sleep } from 'node:timers/promises'
import {
  QODER_CN,
} from '../lib/qoder-product.js'
import {
  buildQoderAuthUrl,
  buildQoderCredential,
  buildQoderPollUrl,
  createQoderDeviceSession,
  parseQoderTokenPayload,
} from '../lib/qoder.js'
import { QoderEncryptedInfer } from '../lib/qoder-wasm.js'
import { unwrapQoderEnvelopeStream } from '../lib/qoder-envelope.js'
import {
  claimQoderDailyCheckin,
  fetchQoderCheckinStatus,
  fetchQoderCreditBalance,
} from '../lib/qoder-credits.js'

const args = process.argv.slice(2)
const value = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`))
  return hit === undefined ? fallback : hit.slice(name.length + 3)
}
const MODEL = value('model', 'qfmodel')
const DO_CLAIM = !args.includes('--no-claim')
const SESSION_TYPE = value('session-type', undefined)
const POLL_DEADLINE_MS = Number.parseInt(value('timeout', '300000'), 10)

const line = (s) => process.stdout.write(`${s}\n`)

// ── 1. 登录 ──────────────────────────────────────────────────────────────
const session = createQoderDeviceSession()
const url = buildQoderAuthUrl(session, QODER_CN)

line('═══ 1. 登录（PKCE 设备码）═══')
line(`  请在浏览器打开并点「授权」：\n\n${url}\n`)
line(`  client_id = ${QODER_CN.clientId}`)
line(`  轮询地址 = ${QODER_CN.openApiBase}/api/v1/deviceToken/poll`)

const pollUrl = buildQoderPollUrl(session, QODER_CN)
const deadline = Date.now() + POLL_DEADLINE_MS
let credential
let consecutiveFailures = 0
while (Date.now() < deadline) {
  await sleep(1500)
  let response
  try {
    response = await fetch(pollUrl, { method: 'GET', signal: AbortSignal.timeout(15_000) })
  } catch (error) {
    consecutiveFailures += 1
    line(`  轮询异常（第 ${consecutiveFailures} 次）：${String(error).slice(0, 120)}`)
    if (consecutiveFailures >= 5) throw new Error('轮询连续失败，放弃')
    continue
  }
  if (response.status === 404) {
    // 404 = 该端点被网关豁免认证、业务层报「会话未就绪」—— 必须继续轮询，
    // 不是错误（AGENTS.md Qoder 要点 4）。
    process.stdout.write('  · 等待授权…\r')
    consecutiveFailures = 0
    continue
  }
  const body = await response.text()
  if (!response.ok) {
    throw new Error(`轮询返回 ${response.status}：${body.slice(0, 300)}`)
  }
  const payload = parseQoderTokenPayload(JSON.parse(body))
  if (payload.accessToken.length === 0) throw new Error(`响应里没有 token：${body.slice(0, 300)}`)
  credential = buildQoderCredential(payload, { machineId: session.machineId })
  line(`\n  ✓ 授权成功`)
  line(`    uid        = ${credential.uid ?? '（响应未带 user_id —— 加密推理会失败）'}`)
  line(`    userName   = ${credential.nickname ?? '(无)'}`)
  line(`    token 长度 = ${credential.access_token.length}（不落盘、不打印内容）`)
  break
}
if (credential === undefined) throw new Error('超时未完成授权')
if (credential.uid === undefined || credential.uid.length === 0) {
  throw new Error('登录响应缺少 user_id：加密推理必需，无法继续')
}

// ── 2. 加密推理（验证 WASM 共用）────────────────────────────────────────
line('\n═══ 2. 加密推理（验证「WASM 共用一份」是否成立）═══')
const client = await QoderEncryptedInfer.create({
  user: {
    uid: credential.uid,
    securityOauthToken: credential.security_oauth_token ?? credential.access_token,
  },
  machineId: credential.machine_id,
  metadata: { ...QODER_CN.clientMetadata },
  host: QODER_CN.encryptedInferBase,
})
const request = client.prepareInfer({
  modelKey: MODEL,
  userText: '回复两个字：收到',
  history: [{ role: 'user', content: '回复两个字：收到' }],
  isReasoning: true,
  ...(SESSION_TYPE === undefined ? {} : { sessionType: SESSION_TYPE }),
  business: { type: 'agent' },
})
line(`  POST ${request.url.split('?')[0]}?…&Encode=1`)
line(`  model = ${MODEL}   session_type = ${SESSION_TYPE ?? 'qodercli（默认）'}`)
const chatResponse = await fetch(request.url, {
  method: 'POST',
  headers: { ...request.headers, Accept: 'text/event-stream' },
  body: request.body,
  signal: AbortSignal.timeout(180_000),
})
line(`  status = ${chatResponse.status}`)
if (!chatResponse.ok) {
  line(`  body = ${(await chatResponse.text()).slice(0, 600)}`)
  line('  ── 排查方向：1) Signature invalid → 需为 CN 另提 WASM；')
  line('     2) session 相关 → 加 --session-type=qoder_work 重跑；')
  line('     3) client/business 相关 → 改 clientMetadata 为 Fh 那组。')
  process.exitCode = 1
} else {
  const text = await (await unwrapQoderEnvelopeStream(chatResponse, 'qodercn')).text()
  const frames = text.split('\n').filter((l) => l.startsWith('data:')).length
  line(`  ✓ 推理走通：${frames} 个 SSE data 帧`)
  line(`    响应片段 = ${text.replace(/\s+/g, ' ').slice(0, 260)}`)
  if (text.includes('event: error')) {
    line('  ⚠️ 响应里含 error 事件帧 —— 需检查错误是否被静默当成正常结束')
  }
}

// ── 3. 积分 ─────────────────────────────────────────────────────────────
line('\n═══ 3. 积分（/sash/ 链路复用）═══')
const before = await fetchQoderCreditBalance(credential, QODER_CN)
if (before === null) {
  line('  ✗ 余额查询失败（返回 null）—— 检查 Bearer + Cosy-ClientType + machine 头')
  process.exitCode = 1
} else {
  line(`  ✓ 余额可查：total=${before.total} packages=${before.packages.length} expiredTotal=${before.expiredTotal}`)
  for (const p of before.packages.slice(0, 5)) {
    line(`      · ${p.name} ${p.remaining}/${p.total} ${p.unit}${p.active ? '' : '（已失效）'}`)
  }
}

const status = await fetchQoderCheckinStatus(credential, QODER_CN)
if (status === null) {
  line('  ✗ 活动查询失败（null）—— 多半是 machine 头不全（见 qoder-machine.ts）')
  process.exitCode = 1
} else {
  line(`  ✓ 活动可查：active=${status.active} todayCheckedIn=${status.todayCheckedIn}`
    + ` dailyCredit=${status.dailyCredit} activityName=${JSON.stringify(status.activityName)}`)
  line(`    （active 恒 true 是刻意的：服务端在活动各阶段都可能回空列表）`)
}

if (DO_CLAIM) {
  line('  → 真实领取一次…')
  const result = await claimQoderDailyCheckin(credential, QODER_CN)
  line(`    结果 = ${JSON.stringify(result)}`)
  const after = await fetchQoderCreditBalance(credential, QODER_CN)
  line(`    领取后 total = ${after?.total ?? 'null'}（领取前 ${before?.total ?? 'null'}）`)
  if (result.kind === 'claimed' && after !== undefined && after !== null && before !== null) {
    if (after.total > before.total) {
      line('    ✓ 额度确实增加')
    } else {
      line('    ✗ 报成功但额度未增加 —— 幂等判据（replayed）可能有问题')
      process.exitCode = 1
    }
  }
} else {
  line('  （--no-claim：跳过真实领取）')
}

line('\n═══ 完成 ═══')
line('  ⚠️ 本次登录得到的凭据**未写入任何文件**，进程退出即失效。')
line('     要在插件里长期使用，请重启 DSH 宿主后在 Jet Hub「Qoder (中国版)」面板登录。')
