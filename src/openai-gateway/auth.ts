import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'

const KEY_FILE = 'api-key'

/** 从环境变量或 DSH home 的独立文件读取网关密钥；没有时只生成一次。 */
export function loadOrCreateApiKey(home: string, env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.DSH_OPENAI_GATEWAY_API_KEY?.trim()
  if (configured) return configured

  const directory = join(home, 'openai-gateway')
  const path = join(directory, KEY_FILE)
  try {
    const stored = readFileSync(path, 'utf8').trim()
    if (stored) return stored
  } catch {
    // 文件不存在或不可读时走生成路径；写入失败会向调用方暴露。
  }

  const key = randomBytes(32).toString('base64url')
  mkdirSync(directory, { recursive: true })
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(temporary, key, { encoding: 'utf8', mode: 0o600 })
  try {
    renameSync(temporary, path)
  } catch (error) {
    // 并发启动时另一进程可能已经落盘，优先复用它，避免生成两个有效密钥。
    if (existsSync(path)) return readFileSync(path, 'utf8').trim()
    throw error
  }
  return key
}
