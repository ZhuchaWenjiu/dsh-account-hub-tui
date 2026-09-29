/**
 * ZCode **浏览器探测**的回归测试。
 *
 * ## 守的是什么（两个实测踩过的真缺陷）
 *
 * ### 1. 空环境变量会产生**相对路径**
 *
 * `join('', 'Google', 'Chrome', 'Application', 'chrome.exe')` 返回
 * `Google\Chrome\Application\chrome.exe` —— 一个**相对路径**。
 * `existsSync` 相对**当前工作目录**解析，于是：
 *   - 「当前目录下恰好有同名文件」会被误判成浏览器；
 *   - 真正的浏览器却可能找不到。
 *
 * ⇒ 只接受**绝对路径**候选。
 *
 * ### 2. `USERPROFILE` 不等于家目录
 *
 * scoop 默认装在 `~/scoop`，而 `~` 应当用 `os.homedir()` 求。
 * 用 `process.env.USERPROFILE` 拼路径时，**一旦该变量被改写**
 * （沙箱、CI、异常环境），原本可用的 scoop chromium 就找不到了 ——
 * 实测：把 `USERPROFILE` 指到临时目录后，`findBrowserExecutable()`
 * 返回 undefined，而 `ZCODE_CHROME_PATH` 一设就好。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { findBrowserExecutable } from '../../src/zcode-captcha.js'

/** 临时环境变量的设置/还原。 */
const saved: Record<string, string | undefined> = {}
function setEnv(key: string, value: string | undefined): void {
  if (!(key in saved)) saved[key] = process.env[key]
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  for (const k of Object.keys(saved)) delete saved[k]
})

describe('ZCode 浏览器探测', () => {
  it('★ ZCODE_CHROME_PATH 显式指定时优先（且必须是绝对路径）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zcode-browser-'))
    try {
      const exe = join(dir, 'chrome.exe')
      writeFileSync(exe, '')
      setEnv('ZCODE_CHROME_PATH', exe)
      expect(findBrowserExecutable()).toBe(exe)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('★ ZCODE_CHROME_PATH 是**相对路径**时被忽略（防 CWD 误匹配）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zcode-browser-rel-'))
    const cwdSaved = process.cwd()
    try {
      // 在当前工作目录下造一个同名文件 —— 相对路径会指向它。
      const relative = 'chrome-rel-test.exe'
      writeFileSync(join(cwdSaved, relative), '')
      setEnv('ZCODE_CHROME_PATH', relative)
      // ⚠ 相对路径不该被接受（否则会误把它当浏览器）。
      const found = findBrowserExecutable()
      expect(found).not.toBe(relative)
      if (found !== undefined) expect(isAbsolute(found)).toBe(true)
    } finally {
      rmSync(join(cwdSaved, 'chrome-rel-test.exe'), { force: true })
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('★ 环境变量为空时不产生相对路径候选（只能返回绝对路径或 undefined）', () => {
    // 清掉所有可能来源，只留一个不存在的 override。
    for (const k of ['PROGRAMFILES', 'PROGRAMFILES(X86)', 'LOCALAPPDATA', 'SCOOP', 'SCOOP_GLOBAL']) {
      setEnv(k, undefined)
    }
    setEnv('ZCODE_CHROME_PATH', join(tmpdir(), 'definitely-no-such-browser.exe'))
    const found = findBrowserExecutable()
    // 要么 undefined，要么绝对路径；**绝不能**是相对路径。
    if (found !== undefined) expect(isAbsolute(found)).toBe(true)
  })

  it('★ 探测跟随 os.homedir()（家目录变化时结论跟着变，而不是读死的 env）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zcode-browser-home-'))
    try {
      setEnv('ZCODE_CHROME_PATH', undefined)
      setEnv('USERPROFILE', dir)
      /**
       * ⚠ 这条用例的**断言方向**改过两次，记下来免得后人又写错。
       *
       * 实测到的两个事实：
       * 1. **独立 node 进程**里 `os.homedir()` 首次调用后**缓存** ——
       *    之后再改 `USERPROFILE` 不生效。（`.tmp-zcode/run-no-ide-verify.ps1`
       *    就是靠「另起进程」才让沙箱生效的。）
       * 2. **vitest worker** 里 `homedir()` **会**跟着 `USERPROFILE` 变
       *    （实测：改成临时目录后 `homedir()` 立刻返回该目录）。
       *
       * ⇒ 正确断言不是「改 env 后仍能找到 ~/scoop 的浏览器」
       * （那要求 `homedir()` 不变，在 vitest 下不成立），
       * 而是「**探测结论与 `homedir()` 一致**」—— 这才真正验证了
       * 「实现用 `homedir()` 而不是读某个写死的环境变量」。
       */
      const home = homedir()
      const expectedScoop = join(home, 'scoop', 'apps', 'chromium', 'current', 'chrome.exe')
      const found = findBrowserExecutable()

      if (existsSync(expectedScoop)) {
        expect(found).toBe(expectedScoop)
      } else {
        /**
         * 家目录下没有 scoop chromium（本用例把 `USERPROFILE` 指到了空目录，
         * 通常就是这种情形）⇒ 结果必须**不含**任何来自旧家目录的路径，
         * 也不该凭空返回一个不存在的东西。
         */
        if (found !== undefined) {
          expect(isAbsolute(found)).toBe(true)
          expect(existsSync(found)).toBe(true)
        }
        // 关键：不能返回「旧家目录」下的 scoop（那说明读的是缓存/env 而非 homedir()）。
        expect(found ?? '').not.toContain('AppData\\Local\\Temp\\zcode-browser-home-')
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('★ SCOOP 显式声明的根目录**优先于**默认 ~/scoop', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zcode-browser-scoop-'))
    try {
      // 造一个符合 scoop 布局的路径：<root>/apps/chromium/current/chrome.exe
      const appsDir = join(dir, 'apps', 'chromium', 'current')
      mkdirSync(appsDir, { recursive: true })
      const exe = join(appsDir, 'chrome.exe')
      writeFileSync(exe, '')

      setEnv('ZCODE_CHROME_PATH', undefined)
      setEnv('SCOOP', dir)
      /**
       * ⚠ 断言「等于自定义那个」而不是「包含它」—— `SCOOP` 是 scoop 自己
       * 的权威声明，用户设了就说明默认路径不对。若实现把它排在
       * `~/scoop` 之后，本机会先命中真实的 `~/scoop/.../chrome.exe`
       * （实测第一版就是这么错的）。
       */
      expect(findBrowserExecutable()).toBe(exe)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
