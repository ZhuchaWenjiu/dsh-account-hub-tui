/**
 * 只读探测：用**国际版**的 `qoder_auth_wasm` 解密本机 **Qoder CN** 的模型目录缓存。
 *
 * 这一步同时回答两个设计问题：
 *
 * 1. **WASM 能否共用**：若国际版 WASM（runtime 1.1.57 提取）能解开 CN
 *    （runtime 1.1.64）下发的 `catalog-v6`，说明两站的目录加密方案一致，
 *    插件可以继续只分发一份 `.wasm`；解不开（`aead::Error`）才需要为 CN
 *    另提一份。
 * 2. **CN 的兜底模型表**：打印全部模型的目录 key 与计费字段，
 *    并直接输出可粘贴进 `src/qoder-product.ts` 的 TS 数组字面量。
 *
 * ⚠️ `model_cache_decrypt(密文, uid)` 的**第二参是 uid**（目录名即 uid），
 *    不是 machine_id —— 传错会得到 `AES-GCM decrypt failed: aead::Error`，
 *    看着像密文损坏实为参数错（国际版踩过，见 probe-qoder-catalog.mjs 头部）。
 *
 * 不联网、不消耗任何额度。
 * 用法：node scripts/probe-qodercn-catalog.mjs
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { decryptModelCatalog } from '../lib/qoder-wasm.js'

/** CN 的数据目录名（与国际版 `.qoder` 并列，来自安装包 product.json）。 */
const CN_MODELS_DIR = join(homedir(), '.qoder-cn', '.models')

if (!existsSync(CN_MODELS_DIR)) {
  console.log(`未找到 CN 模型目录：${CN_MODELS_DIR}`)
  process.exit(0)
}

// 每个子目录名就是该账号的 uid；catalog-v6 是按 uid 分片缓存的密文。
const uids = readdirSync(CN_MODELS_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)

console.log(`候选 uid 目录 ${uids.length} 个\n`)

let catalog
let used = null
for (const uid of uids) {
  const path = join(CN_MODELS_DIR, uid, 'catalog-v6')
  if (!existsSync(path)) {
    console.log(`  跳过 ${uid}（无 catalog-v6）`)
    continue
  }
  try {
    catalog = await decryptModelCatalog(readFileSync(path, 'utf8').trim(), uid)
    used = { uid, path }
    console.log(`✓ 国际版 WASM 解密成功：${path}`)
    console.log(`  （uid=${uid}，仅目录名，非机密）`)
    break
  } catch (error) {
    console.log(`✗ ${uid} 解密失败：${String(error).slice(0, 160)}`)
  }
}

if (catalog === undefined) {
  console.log('\n=== 结论：国际版 WASM 解不开 CN 目录，需要为 CN 单独提取一份 WASM ===')
  process.exit(0)
}

/**
 * 递归收集模型条目。
 *
 * ⚠️ **CN 的字段名是 `key`，国际版是 `model_key`** —— 实测 CN 0.4.3
 * （runtime 1.1.64）下发的目录顶层是 `{chat, developer, assistant, inline,
 * quest, qwork, experts, qwake, app, byok_teams, byok_enterprise}`，
 * 每个场景一个数组，条目用 `key` 标识。两个名字都认，避免再次空跑。
 */
function modelKeyOf(node) {
  if (typeof node.model_key === 'string') return node.model_key
  if (typeof node.key === 'string') return node.key
  return undefined
}
function collectModels(node, acc = [], depth = 0) {
  if (depth > 12 || node === null || typeof node !== 'object') return acc
  if (Array.isArray(node)) {
    for (const item of node) collectModels(item, acc, depth + 1)
    return acc
  }
  if (modelKeyOf(node) !== undefined) acc.push(node)
  for (const v of Object.values(node)) collectModels(v, acc, depth + 1)
  return acc
}

// 只取 `chat` 场景：这是插件要暴露的模型集合（与国际版兜底表口径一致，
// 那份表也是从 `chat` 场景采集的）。
const chatModels = Array.isArray(catalog?.chat) ? catalog.chat : []
const models = chatModels.length > 0 ? chatModels : collectModels(catalog)
// 同一 key 可能在多个场景分组里重复出现，按 key 去重保留首条。
const byKey = new Map()
for (const m of models) {
  const k = modelKeyOf(m)
  if (k !== undefined && !byKey.has(k)) byKey.set(k, m)
}
const unique = [...byKey.values()]

console.log(`\n=== chat 场景 ${models.length} 条 / 去重后 ${unique.length} 个 key ===`)
const line = (label, value) => `  ${String(label).padEnd(22)} ${value}`
for (const m of unique) {
  const promo = m.promotion
  console.log(
    line(
      modelKeyOf(m),
      `name=${JSON.stringify(m.display_name ?? m.name ?? '')} price=${m.price_factor} ` +
        `orig=${m.original_price_factor ?? m.before_promotion_price_factor ?? '-'} ` +
        `ctx=${m.max_input_tokens} vl=${m.is_vl} reasoning=${m.is_reasoning} free=${m.is_free} ` +
        `promo=${promo ? `${promo.discount_factor ?? '-'}@${promo.window_start ?? '?'}-${promo.window_end ?? '?'}(active=${promo.active})` : '-'}`,
    ),
  )
}

// 用户截图里是「展示名」，加密端点要的是「目录 key」，这里给出对照。
console.log('\n=== 展示名 → 目录 key 对照（截图核对用）===')
for (const m of unique) {
  const name = m.display_name ?? m.name ?? '(无名)'
  console.log(`  ${String(name).padEnd(26)} → ${modelKeyOf(m)}`)
}

const sample = unique[0]
if (sample) {
  console.log(`\n=== 首个条目（${modelKeyOf(sample)}）完整字段，用于确认表口径 ===`)
  console.log(JSON.stringify(sample, null, 2).slice(0, 4000))
}

/**
 * 生成可直接粘贴的 TS 字面量。
 *
 * 字段口径与国际版 `QODER_FALLBACK_MODELS` 完全一致（见 `qoder-product.ts`）：
 * `priceFactor` 是采集时刻生效价，展示时由 `promotionActiveNow` 按窗口本地推算。
 */
function toTsEntry(m) {
  const key = modelKeyOf(m)
  const parts = [`id: ${JSON.stringify(key)}`, `name: ${JSON.stringify(m.display_name ?? m.name ?? key)}`]
  if (typeof m.max_input_tokens === 'number') parts.push(`contextWindow: ${m.max_input_tokens}`)
  if (m.is_vl === true) parts.push('supportsImage: true')
  if (m.is_reasoning === true) parts.push('supportsThinking: true')
  if (m.is_free === true) parts.push('isFree: true')
  if (typeof m.price_factor === 'number') parts.push(`priceFactor: ${m.price_factor}`)
  const orig = m.original_price_factor ?? m.before_promotion_price_factor
  if (typeof orig === 'number' && orig !== m.price_factor) parts.push(`originalPriceFactor: ${orig}`)
  const promo = m.promotion
  if (promo && (promo.window_start || promo.window_end)) {
    const pp = []
    if (typeof promo.active === 'boolean') pp.push(`active: ${promo.active}`)
    if (typeof promo.discount_factor === 'number') pp.push(`discountFactor: ${promo.discount_factor}`)
    const before = promo.before_promotion_price_factor
    if (typeof before === 'number') pp.push(`beforePromotionPriceFactor: ${before}`)
    if (promo.window_start) pp.push(`windowStart: ${JSON.stringify(promo.window_start)}`)
    if (promo.window_end) pp.push(`windowEnd: ${JSON.stringify(promo.window_end)}`)
    const badge = promo.badge?.zh ?? promo.badge_zh
    if (typeof badge === 'string' && badge.length > 0) pp.push(`badgeZh: ${JSON.stringify(badge)}`)
    parts.push(`promotion: { ${pp.join(', ')} }`)
  }
  const efforts = m.thinking_config?.enabled?.efforts
  if (efforts && typeof efforts === 'object') {
    const keys = Object.keys(efforts)
    if (keys.length > 0) parts.push(`efforts: [${keys.map((k) => JSON.stringify(k)).join(', ')}]`)
  }
  return `  { ${parts.join(', ')} },`
}

console.log('\n=== 可粘贴的 TS 数组条目（按目录原序）===')
for (const m of unique) console.log(toTsEntry(m))
