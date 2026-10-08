import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('C-PERF-01 has twenty fixed, distinct no-machine questions requesting cards', async () => {
  const questions = JSON.parse(await readFile(new URL('./questions.json', import.meta.url), 'utf8'))
  assert.equal(questions.length, 20)
  assert.equal(new Set(questions).size, 20)
  for (const question of questions) {
    assert.match(question, /Show (the|its) (file|license file|wiki page)\.$/)
    assert.match(question, /^(What|How|Where|Which) /)
    assert.doesNotMatch(question, /\b(please run|execute|open a terminal|ssh|wake a machine)\b/i)
  }
})

import { workload, preflightTiming, configuration, wakeCount } from './agent-first-token.mjs'
import { authenticatedMember, distinctMembers } from './lib/member.mjs'

test('agent workload repeats each fixed question five times in reproducible shuffled order', async () => {
 const questions = JSON.parse(await readFile(new URL('./questions.json', import.meta.url), 'utf8'))
 const order = workload(questions)
 assert.equal(order.length, 100)
 assert.deepEqual(order, workload(questions))
 assert.notDeepEqual(order, Array.from({ length: 5 }, () => questions).flat())
 for (const question of questions) assert.equal(order.filter(q => q === question).length, 5)
 assert.throws(() => workload(questions.slice(1)))
 assert.throws(() => workload(Array(20).fill('same')))
})
test('Inspect clock receipts are mandatory and never replaced by a duration or network timestamp', () => {
 const start = { type: 'context.preflight', runId: 'run', phase: 'started', at: 100, clock: 'host monotonic:boot-1' }
 const end = { ...start, phase: 'completed', at: 150, result: { context: [], model: 'fast', durationMs: 50 } }
 assert.equal(preflightTiming([start, end], 'run').durationMs, 50)
 for (const events of [undefined, [], [end], [start], [{ ...start, at: undefined }, end], [start, { ...end, at: 99 }], [start, { ...end, clock: 'browser monotonic' }], [start, { ...end, result: {} }]]) assert.throws(() => preflightTiming(events, 'run'))
 assert.throws(() => preflightTiming([start, end], 'other'))
})
test('agent configuration never accepts foreign or local origins', () => {
 const env = { SMITHERS_PERF_ORIGIN: 'https://factory.example', SMITHERS_PERF_PAGE: '/main', SMITHERS_PERF_OWNER_COOKIE: 'session=secret', SMITHERS_PERF_MEMBER_A: '/private/member.json', SMITHERS_PERF_INSTALL_VERSION: 'test' }
 assert.equal(configuration(env).page, 'https://factory.example/main')
 for (const key of Object.keys(env)) assert.throws(() => configuration({ ...env, [key]: undefined }))
 assert.throws(() => configuration({ ...env, SMITHERS_PERF_PAGE: 'https://foreign.example' }))
})
test('no-machine cross-check refuses absent producers and invalid counter values', () => {
 assert.equal(wakeCount([{ name: 'smithers_machine_wake_total', metric: [{ counter: { value: 3 } }, { counter: { value: 2 } }] }]), 5)
 for (const metrics of [undefined, [], [{ name: 'smithers_machine_wake_total', metric: [] }], [{ name: 'smithers_machine_wake_total', metric: [{ counter: { value: -1 } }] }]]) assert.throws(() => wakeCount(metrics))
})
test('browser fixtures prove server identity and conversation access before mutation', async () => {
 const calls = []
 const context = { request: { async get(url, options) {
   calls.push({ url, options })
   return { status: () => 200, json: async () => url.endsWith('/api/user') ? { id: 3, username: 'Alice', token: 'do-not-copy' } : { id: 'canonical-main', entries: [] } }
 } } }
 assert.deepEqual(await authenticatedMember(context, 'https://factory.example'), { id: 3, username: 'Alice', conversation: 'canonical-main' })
 assert.deepEqual(calls.map(c => c.url), ['https://factory.example/api/user', 'https://factory.example/api/conversations/main'])
 assert.ok(calls.every(c => c.options.maxRedirects === 0 && c.options.timeout === 10000))
 distinctMembers([{ id: 1 }, { id: 2 }])
 assert.throws(() => distinctMembers([{ id: 1 }, { id: 1 }]))
 for (const status of [401, 403, 302, 503]) await assert.rejects(authenticatedMember({ request: { get: async () => ({ status: () => status }) } }, 'https://factory.example'), new RegExp(`returned ${status}`))
 await assert.rejects(authenticatedMember({ request: { get: async () => ({ status: () => 200, json: async () => ({ id: 0, username: 'Alice' }) }) } }, 'https://factory.example'), /identity/)
})

import { measure as rebaseHold } from './rebase-hold.mjs'

// Test-only dependency contracts. They never produce artifacts or real passes.
function rebaseBoundary(overrides = {}) {
 let main, marker, withheld, pending = false
 return {
  async acknowledgementWindow(ms) { assert.ok(ms === 0 || ms === 10000); withheld = ms === 10000 },
  async pushScratchMain(i, delayed) { withheld = delayed; main = (i + (withheld ? 100 : 0)).toString(16).padStart(40, '0'); pending = false; return main },
  async retryGitHubSync() { pending = true },
  async waitRebasePending(onto) { assert.equal(pending, true); assert.equal(onto, main); return { state: 'pending', present: true, onto: main, rebased: false, member: 'Alice' } },
  async pressRebaseNow() { assert.equal(pending, true); pending = false },
  async waitWriteHold() { assert.equal(pending, false) },
  async typeMarker(value) { marker = value },
  async waitRebased(onto) { assert.equal(onto, main); return { id: main, onto: main, headChanged: true, approvalsCleared: true, activity: [{ kind: 'rebase', onto: main }], marker: { text: marker, member: 'Alice' } } },
  async guestHold(id) { return { capture: { event: id.slice(-32), boot: 'b'.repeat(32), sequence: 1 }, acknowledgementReceipt: { id, state: 'acknowledged', event: id.slice(-32), boot: 'b'.repeat(32), sequence: 1, withheld_ms: 10000 }, id, clock: 'guest monotonic:' + 'b'.repeat(32), start: 10, end: 110, acknowledgedBeforeThaw: false, localSnapshotQueued: true, withheldMs: withheld ? 10000 : 0 } },
  async waitOutboxDrained(id) { assert.equal(id, main); assert.equal(withheld, true) },
  ...overrides
 }
}
test('rebase driver retains 100 normal and 100 delayed holds with all held edits', async () => {
 const result = await rebaseHold(rebaseBoundary())
 assert.equal(result.samples.length, 200)
 assert.equal(result.stats.normal.holdMs.n, 100)
 assert.equal(result.stats.withheld.holdMs.n, 100)
 assert.equal(result.stats.withheld.holdMs.p95, 100)
 assert.equal(new Set(result.samples.map(s => s.marker)).size, 200)
})
test('rebase cannot drop a lost edit, automatic rebase, missing guest receipt or acknowledgement-dependent thaw', async () => {
 for (const overrides of [
  { waitRebasePending: async onto => ({ onto, state: 'pending', present: true, rebased: true }) },
  { waitRebased: async onto => ({ id: onto, onto, headChanged: true, approvalsCleared: true, activity: [{ kind: 'rebase', onto }], marker: { text: 'lost', member: 'Alice' } }) },
  { guestHold: async id => ({ capture: { event: id.slice(-32), boot: 'b'.repeat(32), sequence: 1 }, acknowledgementReceipt: { id, state: 'acknowledged', event: id.slice(-32), boot: 'b'.repeat(32), sequence: 1, withheld_ms: 10000 }, id, clock: 'guest monotonic:' + 'b'.repeat(32), start: 10, end: 2010 }) },
  { guestHold: async id => ({ id, clock: 'host monotonic', start: 10, end: 110 }) },
  { guestHold: async id => ({ id, clock: 'guest monotonic:' + 'b'.repeat(32), start: 10, end: 110, acknowledgedBeforeThaw: true, localSnapshotQueued: true, withheldMs: 10000 }) }
 ]) await assert.rejects(rebaseHold(rebaseBoundary(overrides)))
})


test('rebase acknowledgement fixture restores ordinary delivery after cancellation/failure', async () => {
 const windows = []
 const boundary = rebaseBoundary({
  acknowledgementWindow: async ms => { windows.push(ms) },
  pushScratchMain: async () => { throw new Error('cancelled push') }
 })
 await assert.rejects(rebaseHold(boundary), /cancelled push/)
 assert.deepEqual(windows, [0])
})


import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
test('first-token CLI refusal retains commit and explicit unknown metadata without launching a model', async () => {
 const root = await mkdtemp(join(tmpdir(), 'perf-agent-refusal-'))
 try {
  const output = spawnSync(process.execPath, ['scripts/perf/agent-first-token.mjs'], { encoding: 'utf8', env: { ...process.env, SMITHERS_PERF_ORIGIN: '', SMITHERS_PERF_ARTIFACT_ROOT: root, SMITHERS_PERF_INSTALL_VERSION: 'fixture' } })
  assert.equal(output.status, 1, output.stderr)
  const receipt = JSON.parse(output.stdout)
  assert.equal(receipt.status, 'failed')
  const saved = JSON.parse(await readFile(join(receipt.directory, 'summary.json'), 'utf8'))
  assert.match(saved.commit, /^[a-f0-9]{40}$/)
  assert.equal(saved.installVersion, 'fixture')
  for (const key of ['origin', 'host', 'browser', 'models']) assert.equal(saved[key], null)
  assert.deepEqual(saved.samples, [])
  assert.match(saved.error, /T-INS-04/)
 } finally { await rm(root, { recursive: true, force: true }) }
})

test('projection CLI refusal copies failed evidence into its check directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'projection-refusal-'))
  try {
    const output = spawnSync(process.execPath, ['scripts/perf/projection-delta.mjs'], { cwd: process.cwd(), env: { ...process.env, SMITHERS_PERF_ARTIFACT_ROOT: root, SMITHERS_PERF_ORIGIN: '' }, encoding: 'utf8' })
    assert.equal(output.status, 1)
    const result = JSON.parse(output.stdout)
    const saved = JSON.parse(await readFile(join(result.directory, 'projection-delta.json'), 'utf8'))
    assert.equal(saved.status, 'failed')
    assert.match(saved.commit, /^[a-f0-9]{40}$/)
    assert.equal(saved.budgets[0].status, 'failed')
    assert.deepEqual(saved.budgets[0].samples, [])
    const check = JSON.parse(await readFile(join(root, '.artifacts/checks/C-PERF-02', saved.timestamp, 'summary.json'), 'utf8'))
    assert.deepEqual(check, saved)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('rebase failure retains prior samples and the failed attempt when cleanup also fails', async () => {
 let writes = 0, restores = 0
 const boundary = rebaseBoundary({
  acknowledgementWindow: async () => { if (++restores > 3) throw new Error('cleanup unavailable') },
  waitWriteHold: async () => { if (++writes === 3) throw new Error('SSH disconnected') }
 })
 await assert.rejects(rebaseHold(boundary), error => {
  assert.equal(error.message, 'SSH disconnected')
  assert.equal(error.cleanupError, 'cleanup unavailable')
  assert.equal(error.samples.length, 3)
  assert.equal(error.samples[0].failed, false)
  assert.equal(error.samples[2].failed, true)
  assert.equal(error.samples[2].marker, 'NORMAL_REBASE002')
  return true
 })
})

test('rebase threshold and cleanup failures retain all completed raw observations', async () => {
 let windows = 0
 const boundary = rebaseBoundary()
 const window = boundary.acknowledgementWindow
 boundary.acknowledgementWindow = async ms => {
  if (++windows === 201) throw new Error('restore failed')
  await window(ms)
 }
 await assert.rejects(rebaseHold(boundary), error => {
  assert.equal(error.message, 'restore failed')
  assert.equal(error.samples.length, 200)
  return true
 })
 await assert.rejects(rebaseHold(rebaseBoundary({
  guestHold: async id => ({ capture: { event: id.slice(-32), boot: 'b'.repeat(32), sequence: 1 }, acknowledgementReceipt: { id, state: 'acknowledged', event: id.slice(-32), boot: 'b'.repeat(32), sequence: 1, withheld_ms: 10000 }, id, clock: 'guest monotonic:' + 'b'.repeat(32), start: 10, end: 2010, acknowledgedBeforeThaw: false, localSnapshotQueued: true, withheldMs: 10000 })
 })), error => {
  assert.match(error.message, /each acknowledgement cohort/)
  assert.equal(error.samples.length, 200)
  assert.equal(error.samples[199].holdMs, 2000)
  return true
 })
})

 test('Inspect retains every context page and refuses missing, replayed or reordered pages', () => {
  const frame = { type: 'context.preflight', runId: 'run', clock: 'host monotonic:boot-1' }
  const start = { ...frame, phase: 'started', at: 10, page: { index: 0, total: 1 } }
  const first = { ...frame, phase: 'completed', at: 20, page: { index: 0, total: 2 }, result: { model: 'fast', context: ['a'] } }
  const last = { ...first, at: 21, page: { index: 1, total: 2 }, result: { model: 'fast', context: ['b'] } }
  assert.deepEqual(preflightTiming([start, first, last], 'run').context, ['a', 'b'])
  assert.equal(preflightTiming([start, first, last], 'run').durationMs, 11)
  for (const events of [
    [start, last], [start, first, first], [start, last, first], [first, last, start],
    [start, first, { ...last, clock: 'host monotonic:other' }],
    [start, first, { ...last, at: 19 }],
    [start, first, { ...last, result: { model: 'other', context: ['b'] } }],
    [start, first, { ...last, page: { index: 1, total: 3 } }],
    [start, first, { ...last, page: undefined }],
    [start, { ...first, at: -1 }, last]
  ]) assert.throws(() => preflightTiming(events, 'run'))
 })
test('preflight cross-check aggregates paired durations from separate producer processes', async () => {
  const { summarizePreflights } = await import('./agent-first-token.mjs')
  const samples = Array.from({ length: 100 }, (_, i) => ({ failed: false, preflight: { start: i * 100, end: i * 100 + i + 1, durationMs: i + 1, clock: `host monotonic:producer-${i}` } }))
  assert.equal(summarizePreflights(samples).durationMs.p95, 95)
  assert.throws(() => summarizePreflights(samples.slice(1)), /100 samples/)
  assert.throws(() => summarizePreflights(samples.map(s => ({ ...s, failed: true }))), /succeed/)
  assert.throws(() => summarizePreflights(samples.map(s => ({ ...s, preflight: { ...s.preflight, durationMs: -1 } }))), /invalid/)
})

import { configuration as rebaseConfiguration, run as rebaseProductionRun, verifyCaptureDelay, verifyDrain } from './rebase-production.mjs'
import { productionProviders } from './run.mjs'

const rebaseEnv = { SMITHERS_PERF_REPOSITORY: 'team/scratch', SMITHERS_PERF_ORIGIN: 'https://mini.example', SMITHERS_PERF_PAGE: '/', SMITHERS_PERF_OWNER_COOKIE: 'session=secret; __csrf=csrf', SMITHERS_PERF_MEMBER_A: '/private/a.json', SMITHERS_PERF_BRANCH: '11111111-1111-4111-8111-111111111111', SMITHERS_PERF_TODO: '1', SMITHERS_PERF_INSTALL_VERSION: 'test', SMITHERS_PERF_REBASE_LOG: '/private/guest.jsonl', SMITHERS_PERF_SSH_IDENTITY: '/private/key', SMITHERS_PERF_SSH_DESTINATION: 'branch@mini.example' }

test('production rebase provider is bound and refuses before machine workload without qualification', async () => {
  assert.equal(typeof productionProviders['C-PERF-06'].measure, 'function')
  const result = (await rebaseProductionRun(rebaseEnv)).result
  assert.equal(result.status, 'failed')
  assert.deepEqual(result.samples, [])
  assert.match(result.error, /reference-network Mac required|authenticated lifecycle qualification unavailable/)
})
test('rebase production configuration pins public origin, credentials and unprivileged SSH', () => {
  assert.equal(rebaseConfiguration(rebaseEnv).branch, rebaseEnv.SMITHERS_PERF_BRANCH)
  for (const name of Object.keys(rebaseEnv)) assert.throws(() => rebaseConfiguration({ ...rebaseEnv, [name]: undefined }))
  for (const change of [ { SMITHERS_PERF_PAGE: 'https://foreign.example/' }, { SMITHERS_PERF_TODO: '-1' }, { SMITHERS_PERF_SSH_DESTINATION: '-oProxyCommand=bad' }, { SMITHERS_PERF_OWNER_COOKIE: 'session=secret' } ]) assert.throws(() => rebaseConfiguration({ ...rebaseEnv, ...change }))
})
test('delayed capture binds the actual ACK to the guest event, boot and sequence', () => {
  const capture = { event: 'a'.repeat(32), boot: 'b'.repeat(32), sequence: 123 }
  const armed = { id: 'window', branch: rebaseEnv.SMITHERS_PERF_BRANCH, boot: capture.boot, state: 'armed' }
  const hold = { branch: armed.branch, clock: `guest monotonic:${capture.boot}`, capture, acknowledgedBeforeThaw: false, localSnapshotQueued: true }
  const receipt = { ...capture, id: armed.id, branch: armed.branch, state: 'acknowledged', withheld_ms: 10000 }
  assert.equal(verifyCaptureDelay(receipt, hold, armed), receipt)
  for (const change of [{ id: 'other-window' }, { branch: 'other-branch' }, { event: 'c'.repeat(32) }, { boot: 'c'.repeat(32) }, { sequence: 124 }, { state: 'withheld' }, { withheld_ms: 9999 }]) assert.throws(() => verifyCaptureDelay({ ...receipt, ...change }, hold, armed))
  assert.throws(() => verifyCaptureDelay(receipt, { ...hold, acknowledgedBeforeThaw: true }, armed))
})

test('drain observation binds branch, target, clock and the complete capture', () => {
  const hold = { id: 'hold', branch: rebaseEnv.SMITHERS_PERF_BRANCH, onto: 'a'.repeat(40), clock: 'guest monotonic:boot', capture: { boot: 'boot', event: 'event', sequence: 2 } }
  const drained = { ...hold, phase: 'drained', outboxDepth: 0 }
  assert.equal(verifyDrain(drained, hold), drained)
  for (const change of [{ id: 'other' }, { branch: 'other' }, { onto: 'other' }, { clock: 'other' }, { phase: 'thawed' }, { outboxDepth: 1 }, { capture: undefined }, ...['boot', 'event', 'sequence'].map(field => ({ capture: { ...hold.capture, [field]: 'other' } }))]) assert.throws(() => verifyDrain({ ...drained, ...change }, hold))
})
