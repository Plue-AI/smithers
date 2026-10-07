import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { publicOrigin, readHost } from './lib/host.mjs'
import { authenticatedMember } from './lib/member.mjs'
import { summarize } from './lib/stats.mjs'
import { writeRun } from './lib/artifact.mjs'

export function configuration(env) {
  const origin = publicOrigin(env.SMITHERS_PERF_ORIGIN)
  const page = new URL(env.SMITHERS_PERF_PAGE, origin)
  if (!env.SMITHERS_PERF_PAGE || page.origin !== origin) throw new Error('same-origin main conversation page required')
  for (const key of ['SMITHERS_PERF_OWNER_COOKIE', 'SMITHERS_PERF_MEMBER_A', 'SMITHERS_PERF_INSTALL_VERSION']) {
    if (!env[key]) throw new Error(`${key} required`)
  }
  return { origin, page: page.href }
}

// Fixed seed shuffles all twenty questions five times. Preserve the order in
// evidence; reproducibility does not depend on the host's random generator.
export function workload(questions) {
  if (!Array.isArray(questions) || questions.length !== 20 || new Set(questions).size !== 20) throw new Error('twenty distinct questions required')
  const result = Array.from({ length: 5 }, () => questions).flat()
  let seed = 3592
  for (let i = result.length - 1; i > 0; i--) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    const j = seed % (i + 1)
    ;[result[i], result[j]] = [result[j], result[i]]
  }
  return result
}

/** Inspect must expose the host's start/end and clock. A duration alone cannot
 * establish those receipts, and browser/network time must never replace them.
 * Missing timing fields are a dependency refusal, never fabricated zeros.
 */
export function preflightTiming(events, runId) {
  if (!Array.isArray(events)) throw new Error('T-APP-16: Inspect events unavailable')
  const frames = events.filter(frame => frame.type === 'context.preflight' && frame.runId === runId)
  const starts = frames.filter(frame => frame.phase === 'started')
  const completed = frames.filter(frame => frame.phase === 'completed')
  if (!starts.length || !completed.length) throw new Error('T-APP-16: preflight phases unavailable in Inspect')
  const start = starts[0], end = completed.at(-1)
  if (!Number.isFinite(start.at) || !Number.isFinite(end.at) || end.at < start.at ||
      typeof start.clock !== 'string' || !start.clock.includes('monotonic') || start.clock !== end.clock) throw new Error('T-APP-16: preflight host-clock start/end unavailable')
  if (!end.result?.model || !Array.isArray(end.result.context)) throw new Error('preflight model/context missing')
  return { start: start.at, end: end.at, durationMs: end.at - start.at, model: end.result.model, clock: start.clock, context: end.result.context }
}

export function wakeCount(metrics) {
  const family = metrics?.find(metric => metric.name === 'smithers_machine_wake_total')
  if (!family || !Array.isArray(family.metric) || !family.metric.length) throw new Error('T-MCH-06: wake counter cross-check unavailable')
  return family.metric.reduce((total, metric) => {
    const value = metric.counter?.value
    if (!Number.isFinite(value) || value < 0) throw new Error('invalid wake counter')
    return total + value
  }, 0)
}

export async function run(env = process.env, { persist = true } = {}) {
  const result = { timestamp: new Date().toISOString().replace(/[:.]/g, '-'), check: 'C-PERF-01', status: 'failed', samples: [], clock: 'second Mac browser performance.now()' }
  let browser
  try {
    const config = configuration(env)
    if (process.platform !== 'darwin') throw new Error('C-PERF-01 requires the second Mac')
    result.origin = config.origin
    result.host = await readHost(config.origin, { cookie: env.SMITHERS_PERF_OWNER_COOKIE })
    result.commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    result.installVersion = env.SMITHERS_PERF_INSTALL_VERSION
    const beforeMetrics = await fetch(`${config.origin}/api/install/metrics`, { headers: { Cookie: env.SMITHERS_PERF_OWNER_COOKIE }, redirect: 'error', signal: AbortSignal.timeout(10000) })
    if (beforeMetrics.status !== 200) throw new Error(`metrics cross-check returned ${beforeMetrics.status}`)
    result.wakesBefore = wakeCount((await beforeMetrics.json()).metrics)
    const settings = await fetch(`${config.origin}/api/install`, { headers: { Cookie: env.SMITHERS_PERF_OWNER_COOKIE }, redirect: 'error', signal: AbortSignal.timeout(10000) })
    if (settings.status !== 200) throw new Error(`model settings returned ${settings.status}`)
    const models = (await settings.json()).models
    if (!Array.isArray(models) || !models.find(model => model.role === 'fast' && model.model && model.provider)) throw new Error('T-INS-06: configured fast model missing')
    result.models = models.map(({ role, model, provider }) => ({ role, model, provider }))
    const require = createRequire(resolve('apps/app/package.json'))
    browser = await require('@playwright/test').chromium.launch()
    result.browser = browser.version()
    const context = await browser.newContext({ storageState: env.SMITHERS_PERF_MEMBER_A })
    result.member = await authenticatedMember(context, config.origin)
    const page = await context.newPage()
    await page.goto(config.page)
    await page.locator('[data-shared-conversation="main"]').waitFor({ timeout: 15000 })
    // Track the real Home projection throughout, including warmup.
    await page.evaluate(async origin => {
      window.__perfMachineFailure = undefined
      window.__perfHome = new WebSocket(origin.replace(/^http/, 'ws') + '/api/live', 'smithers.live.v1')
      await new Promise((resolveReady, reject) => {
        const timer = setTimeout(() => reject(new Error('Home snapshot timeout')), 10000)
        window.__perfHome.onopen = () => window.__perfHome.send(JSON.stringify({ t: 'sub', id: 901, topic: 'home' }))
        window.__perfHome.onerror = () => { window.__perfMachineFailure = 'Home socket failed'; clearTimeout(timer); reject(new Error(window.__perfMachineFailure)) }
        window.__perfHome.onclose = () => { window.__perfMachineFailure = 'Home socket closed' }
        window.__perfHome.onmessage = ({ data }) => {
          const frame = JSON.parse(data)
          if (frame.id !== 901) return
          if (frame.t === 'err' || frame.t === 'gap') window.__perfMachineFailure = 'Home projection unavailable'
          if (frame.t === 'snap') {
            if (frame.data?.machines?.in_use !== 0) window.__perfMachineFailure = 'machine awake during no-machine workload'
            clearTimeout(timer)
            if (window.__perfMachineFailure) reject(new Error(window.__perfMachineFailure)); else resolveReady()
          }
          // A machine-bearing delta must retain the zero-awake invariant.
          if (frame.data?.machines && frame.data.machines.in_use !== 0) window.__perfMachineFailure = 'machine woke during no-machine workload'
        }
      })
    }, config.origin)
    const questions = JSON.parse(await readFile(new URL('./questions.json', import.meta.url), 'utf8'))
    const order = workload(questions)
    result.questionOrder = order
    for (const [i, question] of [...questions.slice(0, 5), ...order].entries()) {
      const composer = page.getByTestId('composer-input')
      await composer.fill(question)
      await page.evaluate(() => {
        const root = document.querySelector('[data-shared-conversation="main"]')
        const seen = new Set([...root.querySelectorAll('[data-shared-turn]')].map(el => el.dataset.sharedTurn))
        const input = document.querySelector('[data-testid="composer-input"]')
        window.__perfAnswer = new Promise((resolveAnswer, reject) => {
          let t0, t1
          const timer = setTimeout(() => finish(new Error('answer/card timeout')), 30000)
          const keydown = event => { if (event.key === 'Enter' && !event.shiftKey && t0 === undefined) t0 = performance.now() }
          input.addEventListener('keydown', keydown, true)
          const observer = new MutationObserver(() => {
            const turns = [...root.querySelectorAll('[data-shared-turn]')].filter(el => !seen.has(el.dataset.sharedTurn))
            if (turns.length > 1) return finish(new Error('concurrent prompt during isolated workload'))
            const turn = turns[0]
            if (!turn) return
            if (['failed', 'cancelled', 'uncertain'].includes(turn.dataset.state)) return finish(new Error(`answer ${turn.dataset.state}`))
            const text = turn.querySelector('article[data-kind="answer"] [data-slot="markdown"]')?.textContent
            if (text?.trim() && t1 === undefined) t1 = performance.now()
            if (turn.dataset.state !== 'completed') return
            if (t0 === undefined || t1 === undefined || !turn.querySelector('.smithers-card[data-kind="file"]:not([aria-busy="true"]), .smithers-card[data-kind="wiki"]:not([aria-busy="true"])')) return finish(new Error('completed answer missing text or card'))
            finish(undefined, { turn: turn.dataset.sharedTurn, t0, t1, t2: performance.now() })
          })
          const finish = (error, value) => { clearTimeout(timer); observer.disconnect(); input.removeEventListener('keydown', keydown, true); error ? reject(error) : resolveAnswer(value) }
          observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true })
        })
        // Playwright awaits this promise after Enter; retain early failures.
        window.__perfAnswer.catch(() => {})
      })
      await composer.press('Enter')
      const sample = await page.evaluate(() => window.__perfAnswer)
      const failure = await page.evaluate(() => window.__perfMachineFailure)
      if (failure) throw new Error(failure)
      const response = await context.request.get(`${config.origin}/api/conversations/main`, { maxRedirects: 0, timeout: 10000 })
      if (response.status() !== 200) throw new Error(`conversation returned ${response.status()}`)
      const turn = (await response.json()).entries.find(turn => turn.id === sample.turn)
      if (turn?.frames?.some(frame => frame.type === 'error' || frame.type === 'done' && frame.error)) throw new Error('answer contains a failed frame')
      if (!turn || turn.prompt !== question || turn.author !== result.member.id || turn.state !== 'completed') throw new Error('answer identity/state mismatch')
      const trace = await context.request.get(`${config.origin}/api/runs/${encodeURIComponent(turn.runId)}/trace`, { maxRedirects: 0, timeout: 10000 })
      if (trace.status() !== 200) throw new Error(`T-APP-16: Inspect returned ${trace.status()}`)
      const preflight = preflightTiming((await trace.json()).events, turn.runId)
      if (i < 5) continue
      result.samples.push({ ...sample, question, preflight, firstTokenMs: sample.t1 - sample.t0, answerWithCardsMs: sample.t2 - sample.t0, clock: result.clock, failed: false })
    }
    result.summary = summarize(result.samples, ['firstTokenMs', 'answerWithCardsMs'], 100)
    result.preflightSummary = summarize(result.samples.map(sample => ({ durationMs: sample.preflight.durationMs, clock: sample.preflight.clock, failed: false })), ['durationMs'], 100)
    if (result.summary.firstTokenMs.p95 >= 1500 || result.summary.answerWithCardsMs.p95 >= 8000) throw new Error('agent p95 exceeds budget')
    const metrics = await fetch(`${config.origin}/api/install/metrics`, { headers: { Cookie: env.SMITHERS_PERF_OWNER_COOKIE }, redirect: 'error', signal: AbortSignal.timeout(10000) })
    if (metrics.status !== 200) throw new Error(`metrics cross-check returned ${metrics.status}`)
    result.metricsCrossCheck = (await metrics.json()).metrics
    result.wakesAfter = wakeCount(result.metricsCrossCheck)
    if (result.wakesAfter !== result.wakesBefore) throw new Error('machine woke during no-machine workload')
    result.status = 'passed'
  } catch (error) { result.error = error.message }
  finally { await browser?.close() }
  const directory = persist ? await writeRun(process.cwd(), { ...result, budgets: [{ ...result, name: 'agent-first-token' }] }) : undefined
  return { result, directory }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { result, directory } = await run()
  console.log(JSON.stringify({ status: result.status, directory, error: result.error }))
  process.exitCode = result.status === 'passed' ? 0 : 1
}
