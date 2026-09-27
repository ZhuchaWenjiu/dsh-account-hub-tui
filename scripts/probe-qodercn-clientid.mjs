/**
 * 只读：在 **Qoder CN** 的 asar / worker runtime 里定位 `client_id`。
 *
 * 国际版的 prod client_id 是 `e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb`（源码常量
 * `J_a`，值经 base64 编码存放在 obf runtime 里）。CN asar 里搜该 UUID 命中 **0 次**，
 * 说明中国版用的是**另一个 client_id** —— 而它正是登录最容易踩错的字段：
 * AGENTS.md 记着国际版曾因用错 client_id（`J_a` vs `G_a`）导致授权回调页报
 * 「参数无效」，且**入口 302 检查发现不了**（任何 client_id 都回 302）。
 *
 * 本脚本三路并查：
 * 1. asar 里所有 UUID 字面量（含 `client_id` 邻近的）；
 * 2. `client_id` / `clientId` / `clientID` 出现点的上下文；
 * 3. obf runtime 的 base64→XOR 解码串里的 UUID（国际版就藏在这层）。
 *
 * 用法：
 *   node scripts/probe-qodercn-clientid.mjs
 *   QODER_ASAR=<asar 路径> node scripts/probe-qodercn-clientid.mjs
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const CN_ROOT = process.env.QODER_CN_HOME
  ?? join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Qoder CN')
const ASAR = process.env.QODER_ASAR ?? join(CN_ROOT, 'resources', 'app.asar')

if (!existsSync(ASAR)) {
  console.error(`未找到 asar：${ASAR}`)
  process.exit(1)
}

const text = readFileSync(ASAR).toString('latin1')
console.log(`asar: ${ASAR}  (${(text.length / 1048576).toFixed(1)} MB)\n`)

const UUID_RE = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g

/** 国际版的两个 id，用于确认「CN 确实换了」。 */
const INTL = {
  prod: 'e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb',
  test: 'e93fe488-5778-4c35-a6fc-0f54ed7b3139',
}
for (const [label, id] of Object.entries(INTL)) {
  const n = text.split(id).length - 1
  console.log(`国际版 ${label} client_id ${id} 在 CN asar 命中：${n} 次`)
}

/** 收集 UUID → 出现次数 + 首次邻近上下文。 */
function collectUuids(haystack, radius = 260) {
  const found = new Map()
  let m
  UUID_RE.lastIndex = 0
  while ((m = UUID_RE.exec(haystack)) !== null) {
    const id = m[0]
    if (!found.has(id)) {
      found.set(id, {
        count: 0,
        ctx: haystack.slice(Math.max(0, m.index - radius), m.index + id.length + radius),
      })
    }
    found.get(id).count += 1
  }
  return found
}

const all = collectUuids(text)
// 只关心「看起来与登录/client 相关」的：邻近文本含这些关键词。
const LOGIN_HINT = /client_?id|clientId|oauth|authorize|device|challenge|redirect|app_?id/i
const interesting = [...all.entries()].filter(([, v]) => LOGIN_HINT.test(v.ctx))

console.log(`\n=== asar 内 UUID 共 ${all.size} 个，其中邻近含 client/oauth/device 语义的 ${interesting.length} 个 ===`)
for (const [id, v] of interesting.slice(0, 20)) {
  const clean = v.ctx.replace(/[^\x20-\x7e]+/g, '·')
  console.log(`\n--- ${id}  (出现 ${v.count} 次) ---\n${clean}`)
}

/** `client_id` 字面量出现点上下文（可能值是变量而非字面量）。 */
function windows(needle, radius = 300, limit = 10) {
  const out = []
  let from = 0
  for (;;) {
    const at = text.indexOf(needle, from)
    if (at === -1) break
    out.push(text.slice(Math.max(0, at - radius), at + needle.length + radius))
    from = at + needle.length
    if (out.length >= limit) break
  }
  return out
}

for (const key of ['client_id', 'clientId', 'selectAccounts']) {
  const hits = windows(key)
  console.log(`\n${'#'.repeat(70)}\n## asar 关键词: ${key}  (前 ${hits.length} 处)\n${'#'.repeat(70)}`)
  hits.forEach((w, i) => console.log(`\n---- [${i}] ----\n${w.replace(/[^\x20-\x7e]+/g, '·')}`))
}

/**
 * obf worker runtime：字符串以 base64 → XOR 编码存放（国际版的 `J_a` 就在这一层）。
 * 这里复用已知的解码方式探测，密钥随版本会变，故对常见密钥逐个试。
 */
const workerCandidates = [
  join(CN_ROOT, 'resources', 'app.asar.unpacked', 'node_modules', '@qoder-ai', 'qoder-cn-agent-sdk', 'dist', '_worker', 'qoder-worker-runtime.obf.mjs'),
  join(CN_ROOT, 'resources', 'app.asar.unpacked', 'node_modules', '@qoder-ai', 'qoder-agent-sdk', 'dist', '_worker', 'qoder-worker-runtime.obf.mjs'),
]
const worker = workerCandidates.find((p) => existsSync(p))
if (worker === undefined) {
  console.log('\n未找到 worker runtime（跳过 obf 层探测）')
  process.exit(0)
}
console.log(`\n=== worker runtime: ${worker} ===`)
const wtext = readFileSync(worker).toString('latin1')

// 解码器：找 `_$d = (s, k) => base64 解码后逐字节 XOR` 这类函数，直接按已知密钥试。
const KEYS = ['tqrRVttEZQ4G']
// 同时从文件里抓看起来像密钥的短字符串常量（12 位左右字母数字）。
const keyGuesses = new Set(KEYS)
for (const m of wtext.matchAll(/"([A-Za-z0-9]{10,16})"/g)) keyGuesses.add(m[1])

function decodeWithKey(src, key) {
  // base64 串 → Buffer → 逐字节 XOR key（循环）
  const kb = Buffer.from(key, 'utf8')
  const out = Buffer.alloc(src.length)
  for (let i = 0; i < src.length; i += 1) out[i] = src[i] ^ kb[i % kb.length]
  return out.toString('utf8')
}

// 提取候选 base64 字面量（长度 >= 16，字符集受限）
const b64Re = /"([A-Za-z0-9+/=]{20,200})"/g
const hits = new Map()
let bm
while ((bm = b64Re.exec(wtext)) !== null) {
  const b64 = bm[1]
  for (const key of keyGuesses) {
    let decoded
    try {
      decoded = decodeWithKey(Buffer.from(b64, 'base64'), key)
    } catch {
      continue
    }
    // 只要解出含 UUID 或 client_id 语义的
    if (UUID_RE.test(decoded) || /client_?id/i.test(decoded)) {
      UUID_RE.lastIndex = 0
      hits.set(`${b64}|${key}`, { b64, key, decoded: decoded.slice(0, 400) })
    }
  }
  if (hits.size > 40) break
}

console.log(`\n=== obf 层解码命中 ${hits.size} 条（密钥候选 ${keyGuesses.size} 个）===`)
let shown = 0
for (const v of hits.values()) {
  if (shown++ > 25) break
  console.log(`\n--- key=${v.key} b64=${v.b64.slice(0, 48)}… ---\n${v.decoded.replace(/[^\x20-\x7e一-鿿]/g, '·')}`)
}
