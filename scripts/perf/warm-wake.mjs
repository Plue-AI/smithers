import { readFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { publicOrigin, readHost } from './lib/host.mjs'
import { summarize } from './lib/stats.mjs'
import { writeRun } from './lib/artifact.mjs'

// Host observations are separate from client timing: a client stopwatch cannot
// prove acceptance-to-state-write latency. Missing observations fail the run.
export function verifyWake(sample, observation) {
  if (observation?.requestId !== sample.requestId || observation.branch !== sample.branch) throw new Error('host observation does not identify this wake')
  if (observation.kind !== 'warm' || observation.failed !== false) throw new Error('cold or failed wake')
  if (typeof observation.bootId !== 'string' || !observation.bootId) throw new Error('host boot identity required')
  for (const key of ['acceptedNs', 'awakeWrittenNs']) {
    if (typeof observation[key] !== 'string' || !/^(0|[1-9][0-9]*)$/.test(observation[key])) throw new Error('host monotonic nanoseconds required')
  }
  const elapsed = BigInt(observation.awakeWrittenNs) - BigInt(observation.acceptedNs)
  if (elapsed < 0n || elapsed > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('invalid host interval')
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(sample.capturedHead ?? '') || observation.workingHead !== sample.capturedHead) throw new Error('working head differs from final capture')
  if (!Number.isFinite(sample.clientMs) || sample.clientMs < 0) throw new Error('invalid client interval')
  return { ...sample, observation, hostMs: Number(elapsed) / 1e6, failed: false, clock: `host monotonic/${observation.bootId}; client performance.now()` }
}

export function summarizeWakes(samples) {
  if (new Set(samples.map(s => s.requestId)).size !== samples.length) throw new Error('duplicate wake')
  const summary = summarize(samples, ['hostMs', 'clientMs'], 100)
  return { ...summary, passed: summary.hostMs.p95 < 5000 }
}

export function configuration(env) {
  const origin = publicOrigin(env.SMITHERS_PERF_ORIGIN)
  for (const name of ['SMITHERS_PERF_BRANCH', 'SMITHERS_PERF_REPOSITORY', 'SMITHERS_PERF_OWNER_COOKIE', 'SMITHERS_PERF_INSTALL_VERSION', 'SMITHERS_PERF_HOST_WAKE_LOG']) {
    if (!env[name]) throw new Error(`${name} required`)
  }
  const repository = env.SMITHERS_PERF_REPOSITORY.split('/')
  if (repository.length !== 2 || repository.some(part => !/^[A-Za-z0-9_.-]+$/.test(part) || part === '..')) throw new Error('owner/repository required')
  const csrf = env.SMITHERS_PERF_OWNER_COOKIE.match(/(?:^|;\s*)__csrf=([^;]+)/)?.[1]
  if (!csrf) throw new Error('owner cookie must include __csrf')
  const sleepSeconds = Number(env.SMITHERS_PERF_SLEEP_SECONDS ?? 120)
  if (!Number.isFinite(sleepSeconds) || sleepSeconds <= 0) throw new Error('positive recorded sleep policy required')
  return { origin, repository: repository.map(encodeURIComponent).join('/'), branch: env.SMITHERS_PERF_BRANCH, csrf, sleepSeconds }
}

export async function run(env = process.env) {
  const result = { timestamp: new Date().toISOString().replace(/[:.]/g, '-'), check: 'C-PERF-05', status: 'failed', samples: [], budgets: [{ check: 'C-PERF-05', name: 'warm-wake', status: 'failed' }] }
  let socket
  let terminal, closeTerminal
  try {
    const c = configuration(env)
    if (process.platform !== 'darwin') throw new Error('C-PERF-05 requires the reference Mac host')
    result.commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    result.installVersion = env.SMITHERS_PERF_INSTALL_VERSION
    result.sleepSeconds = c.sleepSeconds
    result.host = await readHost(c.origin, { cookie: env.SMITHERS_PERF_OWNER_COOKIE })
    result.origin = c.origin
    const headers = { Cookie: env.SMITHERS_PERF_OWNER_COOKIE, Origin: c.origin, 'X-CSRF-Token': c.csrf, 'Content-Type': 'application/json' }
    const request = async (path, options = {}) => {
      const response = await fetch(`${c.origin}${path}`, { ...options, headers: { ...headers, ...options.headers }, redirect: 'error', signal: AbortSignal.timeout(30000) })
      if (!response.ok) throw new Error(`${options.method ?? 'GET'} ${path}: ${response.status}`)
      return response
    }
    closeTerminal = id => request(`/api/repos/${c.repository}/workspace/sessions/${encodeURIComponent(id)}/destroy`, { method: 'POST' })
    const require = createRequire(resolve('packages/smithers/package.json'))
    const WebSocket = require('ws')
    socket = new WebSocket(`${c.origin.replace(/^http/, 'ws')}/api/live`, 'smithers.live.v1', { headers })
    let current, failure, sequence = 0
    const events = []
    socket.on('error', error => { failure = error })
    socket.on('close', () => { failure = new Error('branch subscription closed') })
    socket.on('open', () => socket.send(JSON.stringify({ t: 'sub', id: 1, topic: `branch:${c.branch}` })))
    socket.on('message', (raw, binary) => {
      try {
        if (binary) throw new Error('unexpected binary branch frame')
        const frame = JSON.parse(raw.toString())
        if (frame.t === 'err' || frame.t === 'gap') throw new Error('branch live stream unavailable or recovered')
        if (frame.id !== 1 || !['snap', 'delta'].includes(frame.t)) return
        current = { ...frame, sequence: ++sequence, at: performance.now() }
        events.push(current)
      } catch (error) { failure = error }
    })
    const wait = async (predicate, timeout) => {
      const deadline = performance.now() + timeout
      for (;;) {
        if (failure) throw failure
        const found = await predicate()
        if (found) return found
        if (performance.now() >= deadline) throw new Error('warm wake observation timed out')
        await new Promise(resolveWait => setTimeout(resolveWait, 25))
      }
    }
    const asleep = async () => {
      await wait(() => current?.data?.machine?.state === 'asleep', (c.sleepSeconds + 60) * 1000)
      const branch = await (await request(`/api/branches/${encodeURIComponent(c.branch)}`)).json()
      if (branch.state !== 'asleep' || !branch.head) throw new Error('retained final capture unavailable')
      return branch.head
    }
    let capturedHead = await asleep()
    for (let i = 0; i < 100; i++) {
      const requestId = crypto.randomUUID()
      const previous = sequence
      const t0 = performance.now()
      const opened = await (await request('/api/terminals', { method: 'POST', headers: { 'Idempotency-Key': requestId, 'X-Request-ID': requestId }, body: JSON.stringify({ branch: c.branch }) })).json()
      if (typeof opened.id !== 'string' || !opened.id) throw new Error('terminal open returned no session id')
      terminal = opened.id
      const awake = await wait(() => events.find(event => event.sequence > previous && event.t === 'delta' && event.data?.machine?.state === 'awake'), 30000)
      const sample = { i, requestId, branch: c.branch, capturedHead, clientMs: awake.at - t0 }
      // This file must come from the install's host observer, never fabricated
      // from client time or histogram buckets. Retain the matched raw record.
      const observation = await wait(() => readFile(env.SMITHERS_PERF_HOST_WAKE_LOG, 'utf8').then(text => {
        const lines = text.split('\n'); lines.pop() // a partially written tail is not an observation
        const matches = lines.filter(Boolean).map(line => JSON.parse(line)).filter(row => row.requestId === requestId)
        if (matches.length > 1) throw new Error('duplicate host observation')
        return matches[0]
      }), 10000)
      result.samples.push(verifyWake(sample, observation))
      await closeTerminal(terminal)
      terminal = undefined
      capturedHead = await asleep()
    }
    result.summary = summarizeWakes(result.samples)
    if (!result.summary.passed) throw new Error('warm wake p95 must be below 5000 ms')
    result.status = 'passed'
    result.budgets[0].status = 'passed'
  } catch (error) {
    result.error = error.message
  } finally {
    socket?.close()
    if (terminal) {
      try { await closeTerminal(terminal) } catch (error) { result.cleanupError = error.message; result.pendingTerminal = terminal }
    }
  }
  result.artifacts = await writeRun(env.SMITHERS_PERF_ARTIFACT_ROOT ?? process.cwd(), result)
  return result
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await run()
  console.log(JSON.stringify(result, null, 2))
  process.exitCode = result.status === 'passed' ? 0 : 2
}
