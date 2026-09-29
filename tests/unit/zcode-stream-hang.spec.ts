/**
 * ZCode「卡住 + 停止无效」的回归测试（真实缺陷，2026-09-29）。
 *
 * ## 用户报障
 *
 * 「zcode 执行任务会卡住……显示『深度求索中，用时 5分27秒...』，
 *   还没有继续输出推理或者思考……此时**停止按钮点击都没反应**，
 *   我重启后才能让这个任务停止。」
 *
 * ## 实测证据（会话日志，本机三次）
 *
 * | 会话 | 卡住起点 | 最后一个真实事件 | 卡了多久 |
 * |---|---|---|---|
 * | `session-a77ed457` | 17:20:57 `step/start` | 17:38:14 | **1018.7 秒** |
 * | `session-fe7a9979` | 20:00:25 `step/start` | 20:00:25 | 直到重启（11.5 分钟） |
 * | `session-2271311d` | 20:10:59 `step/start` | 20:10:59 | 直到切模型 |
 *
 * ⚠ 日志里那些 `step/end` + `turn/end{kind:'interrupted'}` 与 `step/start`
 * **同一毫秒** —— 它们是 `dsh-session` 的 `openTurnClosers()` 在 repair 时
 * **合成**的（「复用最后一个真实事件的时间戳」），**不是**真实收尾。
 * 真相是这些 turn **从未结束**：适配器的 generator 挂在某个 `await` 上。
 *
 * ## 两条根因（本文件逐条锁住）
 *
 * 1. **流式读取阶段既无超时、也失了中断通道**：`zcode-adapter.ts` 旧实现把
 *    `clearTimeout` / `removeEventListener('abort')` 放在 **`fetch` 的 finally**
 *    （响应头一到就执行），而 `iterateSseFrames` 的 `await reader.read()` 在
 *    上游静默时会**永久挂起**，且**不会被 abort 唤醒**。
 * 2. **captcha 侧有无超时的等待**：取页自旋 `while (pageBusy) await sleep(50)`
 *    与「等 CDP WebSocket `open`」都没有上限；而 `mint()` 的 `finally` 条件
 *    （`reusablePage === page`）在失败路径上**恒为假** ⇒ `pageBusy` 永不复位。
 *
 * ⚠ 判据是「**在有限时间内结束**」：只要唤醒/超时/复位任一失效，
 * 对应用例就会**挂到 vitest 超时**而不是断言失败 —— 这正是线上那条路径的形状。
 */
import { LlmError } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { ZcodeAdapter } from '../../src/zcode-adapter.js'
import { iterateSseFrames } from '../../src/zcode-anthropic.js'
import { ZcodeCaptchaBrowser } from '../../src/zcode-captcha.js'
import { ZCODE } from '../../src/zcode-product.js'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** 半开连接：既不 `enqueue` 也不 `close`（实测形态：上游建连后整段静默）。 */
function hangingStream(onCancel?: () => void): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start() {
      /* 永不产出、永不关闭 */
    },
    cancel() {
      onCancel?.()
    },
  })
}

/** 立即产出给定文本后收尾的流。 */
function textStream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text))
      controller.close()
    },
  })
}

/** 把一个 promise 落定为结果或异常（便于断言「不许挂起」）。 */
async function settle<T>(
  promise: Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  try {
    return { ok: true, value: await promise }
  } catch (error) {
    return { ok: false, error }
  }
}

/** 只要 promise 在 `ms` 内没有落定，就返回 `'hang'`。 */
function withHangGuard<T>(promise: Promise<T>, ms: number): Promise<T | 'hang'> {
  return Promise.race([promise, sleep(ms).then(() => 'hang' as const)])
}

function makeAdapter(options: {
  fetchImpl: () => Promise<Response>
  requestTimeoutMs?: number
}): ZcodeAdapter {
  return new ZcodeAdapter({
    credentialRef: 'R' as never,
    resolveCredential: async () => ({ zcode_jwt: 'a.b.c', device_mid: 'm' }),
    refresh: async () => {},
    mintCaptcha: async () => 'p',
    fetchImpl: options.fetchImpl as never,
    product: { ...ZCODE, requestTimeoutMs: options.requestTimeoutMs ?? 150 },
  })
}

/** 一轮最小可用的 `stream()` 参数。 */
function streamOptions(signal?: AbortSignal): never {
  return {
    provider: 'zcode',
    model: 'GLM-5.3-Flash',
    messages: [{ role: 'user', content: 'hi' }],
    ...(signal === undefined ? {} : { signal }),
  } as never
}

async function drain(iterable: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = []
  for await (const item of iterable) out.push(item)
  return out
}

describe('ZCode：中断必须在「读挂起」时生效（否则 UI 永远深度求索中）', () => {
  it(
    '★ abort 必须唤醒挂起的 read（旧实现会永久挂住 ⇒ 停止按钮无效）',
    async () => {
      const controller = new AbortController()
      const consuming = drain(iterateSseFrames(hangingStream(), { signal: controller.signal }))

      // 让 read 真正挂起，再中断 —— 这是线上发生的那一幕。
      await sleep(30)
      controller.abort()

      /**
       * ⚠ 这里**必须**在有限时间内结束。旧实现只在循环顶部检查
       * `signal.aborted`，而挂起中的 `read()` 不会被 abort 唤醒，
       * 于是它会一直等到 vitest 超时。
       */
      expect(await withHangGuard(consuming, 1_500)).not.toBe('hang')
    },
    5_000,
  )

  it(
    '★ 中断必须真的 cancel 底层流（只 releaseLock 会让上游连接继续挂着）',
    async () => {
      let cancelled = false
      const controller = new AbortController()
      const consuming = drain(
        iterateSseFrames(hangingStream(() => { cancelled = true }), {
          signal: controller.signal,
        }),
      )
      await sleep(30)
      controller.abort()
      expect(await withHangGuard(consuming, 1_500)).not.toBe('hang')
      expect(cancelled).toBe(true)
    },
    5_000,
  )

  it('signal 从未 abort 时行为不变（逐帧读完）', async () => {
    const controller = new AbortController()
    const frames = await drain(
      iterateSseFrames(
        textStream('event: message_start\ndata: {"type":"message_start"}\n\n'),
        { signal: controller.signal },
      ),
    )
    expect(frames).toHaveLength(1)
    expect(controller.signal.aborted).toBe(false)
  })

  it('消费方提前结束（break）时也必须取消底层流 —— 只 releaseLock 会让上游继续生成、白扣额度', async () => {
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: message_start\ndata: {"type":"message_start"}\n\n'))
        // 故意不 close：模拟上游此刻仍在生成。
      },
      cancel() {
        cancelled = true
      },
    })
    for await (const _frame of iterateSseFrames(stream, {})) {
      break
    }
    expect(cancelled).toBe(true)
  })
})

describe('ZCode：整轮超时（含流式读取）', () => {
  it(
    '★ 上游回 200 但整段静默 → 到 requestTimeoutMs 抛 TIMEOUT（不再永久挂起）',
    async () => {
      const adapter = makeAdapter({
        fetchImpl: async () => new Response(hangingStream(), { status: 200 }),
        requestTimeoutMs: 120,
      })
      const settled = await settle(drain(adapter.stream(streamOptions())))

      // 旧实现里这个 await 永不落定（fetch 的 finally 已经清掉了计时器）。
      expect(settled.ok).toBe(false)
      const error = (settled as { ok: false; error: unknown }).error
      expect(error).toBeInstanceOf(LlmError)
      expect((error as LlmError).code).toBe('TIMEOUT')
      expect((error as LlmError).message).toContain('请求超时')
    },
    5_000,
  )

  it(
    '★ 用户在流阶段中断 → 立刻结束，且**不得**被翻译成 TIMEOUT（否则会白重试）',
    async () => {
      const controller = new AbortController()
      const adapter = makeAdapter({
        fetchImpl: async () => new Response(hangingStream(), { status: 200 }),
        // 超时给得很长：这次结束必须**只**由用户中断引起。
        requestTimeoutMs: 60_000,
      })
      const consuming = settle(drain(adapter.stream(streamOptions(controller.signal))))
      await sleep(50)
      controller.abort()

      const settled = await withHangGuard(consuming, 1_500)
      expect(settled).not.toBe('hang')
      const result = settled as { ok: boolean; error?: unknown }
      if (result.ok === false && result.error instanceof LlmError) {
        expect(result.error.code).not.toBe('TIMEOUT')
      }
    },
    5_000,
  )
})

describe('ZCode captcha：等待必须有界、标志必须复位', () => {
  it(
    '★ 取页等待有上限（pageBusy 被别的 mint 占住时不无限自旋）',
    async () => {
      const browser = new ZcodeCaptchaBrowser({ pageWaitTimeoutMs: 120 })
      // 模拟「上一个 mint 没能归还页面」——线上就是这样把闸门焊死的。
      ;(browser as unknown as { pageBusy: boolean }).pageBusy = true

      const startedAt = Date.now()
      const error = await settle(
        (browser as unknown as { acquirePage: (fresh: boolean) => Promise<unknown> })
          .acquirePage(false),
      )
      expect(error.ok).toBe(false)
      expect(String((error as { error: Error }).error.message)).toContain('被占用超过')
      // 旧实现是裸的 `while (pageBusy) await sleep(50)` —— 这里会挂到超时。
      expect(Date.now() - startedAt).toBeLessThan(1_500)
    },
    5_000,
  )

  it(
    '★ mintOnPage 失败后 pageBusy 必须复位（旧实现的 finally 条件恒为假 ⇒ 后续 mint 全死锁）',
    async () => {
      const browser = new ZcodeCaptchaBrowser()
      const internals = browser as unknown as {
        start: () => Promise<void>
        acquirePage: (fresh: boolean) => Promise<unknown>
        mintOnPage: (page: unknown) => Promise<string>
        pageBusy: boolean
      }
      // 浏览器/页面全部打桩：本用例只关心「标志复位」这一件事。
      internals.start = async () => {}
      internals.acquirePage = async () => {
        internals.pageBusy = true
        return { targetId: 't', ws: { close() {} }, cdp: { close() {} }, lastUsedAt: Date.now() }
      }
      internals.mintOnPage = async () => {
        // 实测的真实失败形态：复用页空闲过久 ⇒ `F001`。
        throw new Error('zcode: captcha 产出失败（stage=error, err=F001）')
      }

      const error = await settle(browser.mint())
      expect(error.ok).toBe(false)
      expect(String((error as { error: Error }).error.message)).toContain('F001')
      /**
       * ★ 关键断言：失败后闸门必须放开。
       * 旧实现在这里留下 `true`，下一次 `acquirePage()` 直接永久自旋 ——
       * 请求根本不发出，UI 永远「深度求索中」，与本次报障完全一致。
       */
      expect(internals.pageBusy).toBe(false)
    },
    5_000,
  )
})
