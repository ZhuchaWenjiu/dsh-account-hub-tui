/**
 * 只读探针：Qoder 系适配器在**多模态消息**上到底丢了什么。
 *
 * ## 为什么需要它
 *
 * 用户报障：「给 qodercn 的 qwen3.8-flash 发送图片，说没读到图片」。
 * 静态阅读指向 `buildQoderHistory` 里 `qoderContentText()` 只保留 `text` 块，
 * 但「看起来像」不等于「就是」。本脚本用**真实形状的 DSH 消息**跑一遍
 * 纯函数，逐层打印中间产物，把丢失点坐实：
 *
 *   1. `serializeMessages`（openai-compat）产出什么 —— 图片是否还在？
 *   2. `buildQoderHistory` 之后 —— 图片块是否被压成空串？
 *   3. `buildQoderInferPayload` 的 `messages[]` —— 最终 wire 形态。
 *
 * ⚠️ 全部离线、不联网、不消耗额度。
 * 用法：node scripts/probe-qoder-image-loss.mjs
 */
import { buildQoderHistory, buildQoderTools } from '../lib/qoder-adapter.js'
import { buildQoderInferPayload } from '../lib/qoder-wasm.js'
import { serializeMessages } from '../lib/openai-compat.js'

/** 一份「用户发了张图」的 DSH 消息（形状取自 0.1.7 的一等 tool 消息之前）。 */
const IMAGE_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='
const MESSAGES = [
  {
    role: 'user',
    content: [
      { type: 'text', text: '这个图片描述了什么内容' },
      {
        type: 'image',
        attachment: { attachmentId: 'att-1' },
      },
    ],
  },
]

/** 把 data URL 塞进 imageUrls（模拟适配器读取图片字节后的产物）。 */
const imageUrls = new Map([['att-1', IMAGE_DATA_URL]])

const line = (s) => process.stdout.write(`${s}\n`)
const show = (label, v) => line(`  ${label}: ${JSON.stringify(v)}`)

line('═══ 1. 输入：DSH 消息（用户发了 1 张图）═══')
line(JSON.stringify(MESSAGES, null, 2).split('\n').map((l) => `  ${l}`).join('\n'))

line('\n═══ 2. 第 1 步：serializeMessages(options.messages, imageUrls） ═══')
line('  这是 qoder-adapter 真正传给 buildQoderHistory 的入参。')
const wireMessages = serializeMessages(MESSAGES, imageUrls)
line(JSON.stringify(wireMessages, null, 2).split('\n').map((l) => `  ${l}`).join('\n'))
const wireHasImage = JSON.stringify(wireMessages).includes('image_url')
line(`  → wire 消息里含 image_url 吗: ${wireHasImage}`)

line('\n═══ 3. 第 2 步：buildQoderHistory(wireMessages)（当前实现）═══')
const history = buildQoderHistory(wireMessages)
line(JSON.stringify(history, null, 2).split('\n').map((l) => `  ${l}`).join('\n'))
const hasImage = JSON.stringify(history).includes('image')
line(`  → 历史里还含 "image" 字样吗: ${hasImage}`)
// 修复后 content 是数组，文本要取其中的 text 块（修复前是字符串）。
const textBlock = Array.isArray(history[0]?.content)
  ? (history[0].content).find((b) => b.type === 'text')?.text
  : history[0]?.content
line(`  → 文本是否完整保留: ${textBlock === '这个图片描述了什么内容'}`)
if (wireHasImage && !hasImage) {
  line('  ✗✗ **丢失点就在这里**：serializeMessages 已正确产出多模态数组，')
  line('      但 buildQoderHistory 把它压成了纯文本字符串。')
} else if (wireHasImage && hasImage) {
  line('  ✓ 图片已保留（修复生效）。')
}

line('\n═══ 4. 最终 payload 的 messages[]（用户看到的就是这个）═══')
const payload = buildQoderInferPayload({
  modelKey: 'qfmodel',
  userText: '这个图片描述了什么内容',
  history,
  isReasoning: true,
  displayName: 'Qwen3.8-Flash',
  isVl: true,
  business: { type: 'agent' },
  tools: buildQoderTools([{ name: 'read_image', description: '读图', parameters: {} }]),
})
// ⚠️ buildQoderInferPayload 返回**明文对象**（由 WASM 负责加密），不是 JSON 串。
line(`  messages = ${JSON.stringify(payload.messages)}`)
line(`  messages[0].content 的类型 = ${Array.isArray(payload.messages[0].content) ? 'Array（多模态）' : typeof payload.messages[0].content}`)
line(`  chat_context.imageUrls = ${JSON.stringify(payload.chat_context.imageUrls)}`)

line('\n═══ 5. 结论 ═══')
const lost = !JSON.stringify(payload.messages).includes('image')
line(`  图片是否抵达 wire messages: ${!lost}`)
if (lost) {
  line('  ✗ 图片丢失。丢失点：buildQoderHistory 把 content 数组压成了纯文本，')
  line('     而客户端权威实现是把 content **数组**原样放进 messages[]（见 obf 的')
  line('     `eQc()`：{type:"base64",media_type,data} → {type:"image_url",image_url:{url}}）。')
  line('     修法：让带图消息的 content 保持多模态数组，而不是字符串。')
}
line('\n  参照证据（obf 产物，国际版 runtime）：')
line('    function Hyc(A,e,t){return{text:A,...,chatPrompt:"",imageUrls:null}}')
line('    —— 官方把 chat_context.imageUrls 恒置 null，故图片**必须**走 messages[]；')
line('       我们那行 imageUrls:null 是忠实复刻，不是缺陷。')
