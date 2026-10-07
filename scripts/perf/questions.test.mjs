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
 const start = { type: 'context.preflight', runId: 'run', phase: 'started', at: 100, clock: 'host monotonic' }
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
   return { status: () => 200, json: async () => url.endsWith('/api/user') ? { id: 3, username: 'Alice', token: 'do-not-copy' } : { id: 'main', entries: [] } }
 } } }
 assert.deepEqual(await authenticatedMember(context, 'https://factory.example'), { id: 3, username: 'Alice' })
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
  async pushScratchMain(i) { main = (i + (withheld ? 100 : 0)).toString(16).padStart(40, '0'); pending = false; return main },
  async retryGitHubSync() { pending = true },
  async waitRebasePending(onto) { assert.equal(pending, true); assert.equal(onto, main); return { state: 'pending', present: true, onto: main, rebased: false, member: 'Alice' } },
  async pressRebaseNow() { assert.equal(pending, true); pending = false },
  async waitWriteHold() { assert.equal(pending, false) },
  async typeMarker(value) { marker = value },
  async waitRebased(onto) { assert.equal(onto, main); return { id: main, onto: main, headChanged: true, approvalsCleared: true, activity: [{ kind: 'rebase', onto: main }], marker: { text: marker, member: 'Alice' } } },
  async guestHold(id) { return { id, clock: 'guest monotonic:boot-1', start: 10, end: 110, acknowledgedBeforeThaw: false, localSnapshotQueued: true, withheldMs: withheld ? 10000 : 0 } },
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
  { guestHold: async id => ({ id, clock: 'guest monotonic:boot-1', start: 10, end: 2010 }) },
  { guestHold: async id => ({ id, clock: 'host monotonic', start: 10, end: 110 }) },
  { guestHold: async id => ({ id, clock: 'guest monotonic:boot-1', start: 10, end: 110, acknowledgedBeforeThaw: true, localSnapshotQueued: true, withheldMs: 10000 }) }
 ]) await assert.rejects(rebaseHold(rebaseBoundary(overrides)))
})


test('rebase acknowledgement fixture restores ordinary delivery after cancellation/failure', async () => {
 const windows = []
 const boundary = rebaseBoundary({
  acknowledgementWindow: async ms => { windows.push(ms) },
  pushScratchMain: async () => { throw new Error('cancelled push') }
 })
 await assert.rejects(rebaseHold(boundary), /cancelled push/)
 assert.deepEqual(windows, [0, 0])
})
