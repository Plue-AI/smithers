import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { publicOrigin, readHost } from './lib/host.mjs'
import { summarize } from './lib/stats.mjs'
import { writeRun } from './lib/artifact.mjs'

export function configuration(env) {
  const origin = publicOrigin(env.SMITHERS_PERF_ORIGIN)
  const n = Number(env.SMITHERS_PERF_TODO)
  if (!Number.isSafeInteger(n) || n < 1) throw new Error('SMITHERS_PERF_TODO must identify a movable TODO')
  for (const key of ['SMITHERS_PERF_OWNER_COOKIE', 'SMITHERS_PERF_MEMBER_A', 'SMITHERS_PERF_INSTALL_VERSION']) {
    if (!env[key]) throw new Error(`${key} required`)
  }
  const csrf = env.SMITHERS_PERF_OWNER_COOKIE.match(/(?:^|;\s*)__csrf=([^;]+)/)?.[1]
  if (!csrf) throw new Error('owner cookie must include __csrf')
  return { origin, n, csrf }
}

// Reject recovery, coalescing, duplicates and any unrelated delta during the
// isolated move workload. Its source facts, not today's snapshot, name moves.
export function acceptMove(frame, previous, n, direction) {
  if (frame.t !== 'delta' || !Number.isSafeInteger(frame.cursor) || frame.cursor !== previous + 1) throw new Error('missing, duplicated, coalesced or recovered delta')
  const fact = frame.data
  if (fact?.Type !== 'todo.moved' || fact.Data?.n !== n || fact.Data?.direction !== direction) throw new Error('delta does not name the measured move')
  return frame.cursor
}

export async function run(env = process.env) {
  const timestamp = new Date().toISOString().replaceAll(':', '-').replace('.', '-')
  const result = { timestamp, check: 'C-PERF-02', status: 'failed', samples: [], clock: 'second Mac Node process: performance.now()' }
  const sockets = []
  let browser
  try {
    if (process.platform !== 'darwin') throw new Error('C-PERF-02 requires the second Mac on the reference-host network')
    const config = configuration(env)
    result.origin = config.origin
    result.host = await readHost(config.origin, { cookie: env.SMITHERS_PERF_OWNER_COOKIE })
    result.commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    result.installVersion = env.SMITHERS_PERF_INSTALL_VERSION
    const require = createRequire(resolve('packages/smithers/package.json'))
    const WebSocket = require('ws')
    const appRequire = createRequire(resolve('apps/app/package.json'))
    browser = await appRequire('@playwright/test').chromium.launch()
    const context = await browser.newContext({ storageState: env.SMITHERS_PERF_MEMBER_A })
    const tabs = await Promise.all(Array.from({ length: 3 }, () => context.newPage()))
    await Promise.all(tabs.map(async page => {
      await page.goto(config.origin)
      await page.getByRole('button', { name: 'New TODO', exact: true }).waitFor()
    }))
    result.browser = browser.version()
    result.backgroundTabs = tabs.length
    const streams = await Promise.all(['home', `todo:${config.n}`].map(topic => new Promise((resolveStream, reject) => {
      const socket = new WebSocket(`${config.origin.replace(/^http/, 'ws')}/api/live`, 'smithers.live.v1', { headers: { Cookie: env.SMITHERS_PERF_OWNER_COOKIE, Origin: config.origin } })
      sockets.push(socket)
      const stream = { topic, cursor: undefined, pending: undefined, failure: undefined }
      const timeout = setTimeout(() => reject(new Error(`${topic}: snapshot timeout`)), 10000)
      const fail = error => { stream.failure = error; stream.pending?.reject(error); reject(error) }
      socket.on('error', fail)
      socket.on('close', () => fail(new Error(`${topic}: socket closed`)))
      socket.on('open', () => socket.send(JSON.stringify({ t: 'sub', id: 1, topic })))
      socket.on('message', (raw, binary) => {
        try {
          if (binary) throw new Error('unexpected binary frame')
          const frame = JSON.parse(raw.toString())
          if (frame.t === 'snap' && stream.cursor === undefined && Number.isSafeInteger(frame.cursor)) {
            stream.cursor = frame.cursor; clearTimeout(timeout); resolveStream(stream); return
          }
          if (!stream.pending) throw new Error(`${topic}: unsolicited frame`)
          const cursor = acceptMove(frame, stream.cursor, config.n, stream.pending.direction)
          const at = performance.now()
          stream.cursor = cursor
          stream.pending.resolve({ topic, seq: cursor, at })
          stream.pending = undefined
        } catch (error) { clearTimeout(timeout); fail(error) }
      })
    })))
    for (let i = 0; i < 200; i++) {
      const direction = i % 2 === 0 ? 'up' : 'down'
      const arrivals = streams.map(stream => new Promise((resolveArrival, reject) => {
        if (stream.failure) return reject(stream.failure)
        const timer = setTimeout(() => reject(new Error(`${stream.topic}: move timeout`)), 10000)
        stream.pending = { direction, resolve: value => { clearTimeout(timer); resolveArrival(value) }, reject: error => { clearTimeout(timer); reject(error) } }
      }))
      const t0 = performance.now()
      const requestId = crypto.randomUUID()
      const response = await fetch(`${config.origin}/api/todos/${config.n}`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000), headers: { Cookie: env.SMITHERS_PERF_OWNER_COOKIE, Origin: config.origin, 'X-CSRF-Token': config.csrf, 'Idempotency-Key': requestId, 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'move', direction }) })
      if (response.status !== 202) { await Promise.allSettled(arrivals); throw new Error(`move returned ${response.status}`) }
      const [home, todo] = await Promise.all(arrivals)
      result.samples.push({ i, requestId, direction, t0, home, todo, homeMs: home.at - t0, todoMs: todo.at - t0, clock: result.clock, failed: false })
    }
    // Let a duplicated final delivery arrive before accepting the workload.
    await new Promise(resolveDrain => setTimeout(resolveDrain, 1000))
    for (const stream of streams) if (stream.failure) throw stream.failure
    const stats = summarize(result.samples, ['homeMs', 'todoMs'], 200)
    result.budgets = [{ check: 'C-PERF-02', name: 'projection-delta', stats }]
    if (stats.homeMs.p95 >= 1000 || stats.todoMs.p95 >= 1000) throw new Error('projection p95 exceeds 1 s')
    result.status = 'passed'
  } catch (error) { result.error = error.message }
  finally { for (const socket of sockets) socket.terminate(); await browser?.close() }
  const directory = await writeRun(resolve('.'), result)
  return { result, directory }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { result, directory } = await run()
  console.log(JSON.stringify({ status: result.status, directory, error: result.error }))
  process.exitCode = result.status === 'passed' ? 0 : 1
}
