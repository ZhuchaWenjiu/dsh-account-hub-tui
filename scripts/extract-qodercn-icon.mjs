/**
 * 从 **Qoder 中国版**官方安装目录提取面板图标（内联进客户端 bundle）。
 *
 * ## 为什么不复用国际版图标
 *
 * 实测两站 `resources/app-icon.ico` 的 256×256 PNG 帧 SHA256 分别为
 * `d9ab00eb…`（CN）与 `5022fe91…`（国际版）—— **确实是两个图标**。
 * 两个面板在 Jet Hub 列表里挨着渲染，同图标会让用户分不清点的是哪个。
 *
 * ## 为什么提取位图而不是手绘 SVG
 *
 * 与 Cline / Raccoon 那次的教训一致：早期手绘的图标与官方标志不符，
 * 用户报障「我们用的图标和 cline 的好像不一样」。故一律**从官方产物提取**。
 *
 * ## 为什么取 ICO 的 256 帧而不是用 exe 内嵌图标
 *
 * `resources/app-icon.ico` 是一个 **ICO 容器**（本项目实测 7 帧：
 * 16/24/32/48/64/128/256，每帧都是 PNG）。取最大帧再缩放，边缘最清晰；
 * `ExtractAssociatedIcon` 只能拿 32×32（Raccoon 那次实测过），缩到 20×20 会糊。
 *
 * ## 用法
 *
 *   node scripts/extract-qodercn-icon.mjs                  # 48×48，写入 jet-hub.js
 *   node scripts/extract-qodercn-icon.mjs --dry-run        # 只报告，不改文件
 *   node scripts/extract-qodercn-icon.mjs --size=64
 *   node scripts/extract-qodercn-icon.mjs --out=icon.png   # 另存 PNG 供目视
 *   QODER_CN_HOME=D:\\path\\to\\Qoder CN node scripts/extract-qodercn-icon.mjs
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { decodePng, encodePng, resizeArea } from './extract-cline-icon.mjs'

const CLIENT_FILE = resolve(import.meta.dirname, '../plugin-src/client/jet-hub.js')
const CONST_NAME = 'QODERCN_ICON'

/** 解析命令行参数（与 extract-cline-icon.mjs 同形态，不引第三方依赖）。 */
function parseArgs(argv) {
  const values = new Map()
  const flags = new Set()
  for (const arg of argv) {
    const eq = arg.indexOf('=')
    if (arg.startsWith('--') && eq > 0) values.set(arg.slice(2, eq), arg.slice(eq + 1))
    else if (arg.startsWith('--')) flags.add(arg.slice(2))
  }
  return { values, flags }
}

/** ICO 源路径（`QODER_CN_HOME` 可覆盖，供换机或 CI 复现）。 */
function iconPath() {
  const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
  const root = process.env.QODER_CN_HOME ?? join(localAppData, 'Programs', 'Qoder CN')
  return join(root, 'resources', 'app-icon.ico')
}

/**
 * 从 ICO 容器里取指定边长的 PNG 帧。
 *
 * ICO 布局：6 字节头（reserved / type / count）+ count × 16 字节目录项，
 * 每项为 `width, height, colorCount, reserved, planes, bitCount,
 * bytesInRes, imageOffset`。**宽高字节 0 表示 256**（单字节放不下）。
 * 帧数据本身就是完整 PNG（本项目 7 帧皆然），故可直接交给 `decodePng`。
 */
function pickIcoFramePng(buffer, wanted) {
  const count = buffer.readUInt16LE(4)
  for (let i = 0; i < count; i += 1) {
    const entry = 6 + i * 16
    const width = buffer[entry] === 0 ? 256 : buffer[entry]
    const height = buffer[entry + 1] === 0 ? 256 : buffer[entry + 1]
    if (width !== wanted || height !== wanted) continue
    const size = buffer.readUInt32LE(entry + 8)
    const offset = buffer.readUInt32LE(entry + 12)
    const frame = buffer.subarray(offset, offset + size)
    // PNG 魔数校验：不是 PNG 就明确报错，而不是把 BMP 帧当 PNG 解出垃圾。
    if (!(frame[0] === 0x89 && frame[1] === 0x50 && frame[2] === 0x4e && frame[3] === 0x47)) {
      throw new Error(`ICO 的 ${wanted}×${wanted} 帧不是 PNG 编码，需另加 BMP 解码分支`)
    }
    return frame
  }
  throw new Error(`ICO 里找不到 ${wanted}×${wanted} 帧（共 ${count} 帧）`)
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const size = Number.parseInt(args.values.get('size') ?? '48', 10)
  const dryRun = args.flags.has('dry-run')
  const outPath = args.values.get('out')

  if (!Number.isFinite(size) || size < 16 || size > 256) {
    throw new Error(`--size 必须是 16..256 的整数，实得 ${args.values.get('size')}`)
  }

  const source = iconPath()
  if (!existsSync(source)) throw new Error(`未找到图标源：${source}`)
  console.log(`图标来源 : ${source}`)

  const png = pickIcoFramePng(readFileSync(source), 256)
  const { width, height, rgba } = decodePng(png)
  console.log(`源帧   : 256×256 PNG（解码得 ${width}×${height}，${rgba.length} 字节 RGBA）`)
  console.log(`输出尺寸: ${size}×${size}`)

  const scaled = resizeArea(rgba, width, height, size, size)
  const encoded = encodePng(scaled, size, size, 'paeth')
  const base64 = encoded.toString('base64')
  console.log(`PNG 体积: ${encoded.length} 字节 → base64 ${base64.length} 字符`)

  if (outPath !== undefined) {
    writeFileSync(resolve(outPath), encoded)
    console.log(`已另存   : ${resolve(outPath)}`)
  }

  if (dryRun) {
    console.log('\n--dry-run：未改动任何文件。')
    return
  }

  /**
   * ⚠️ 用**全局**匹配并「只保留第一行」，而不是 `String.replace(单次)`。
   * 理由同 extract-cline-icon.mjs：一旦文件里意外出现**重复**的
   * `const QODERCN_ICON = '...'` 行，单次替换只改第一处，第二行会残留 →
   * esbuild 直接报 `The symbol "QODERCN_ICON" has already been declared`
   * （那套实现开发期就踩过一次）。现在无论多少行都收敛成一行，重复运行幂等。
   */
  const pattern = new RegExp(`const ${CONST_NAME} = '[^']*'[^\\S\\r\\n]*\\r?\\n`, 'g')
  const text = readFileSync(CLIENT_FILE, 'utf8')
  const matches = text.match(pattern)
  if (matches === null) {
    throw new Error(`${CLIENT_FILE} 里找不到 \`const ${CONST_NAME} = '...'\``)
  }
  let first = true
  const replaced = text.replace(pattern, () => {
    if (!first) return '' // 重复行整行删除
    first = false
    return `const ${CONST_NAME} = 'data:image/png;base64,${base64}'\n`
  })
  writeFileSync(CLIENT_FILE, replaced)
  console.log(`已写入   : ${CLIENT_FILE}`)
}

main()
