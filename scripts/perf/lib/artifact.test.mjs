import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, mkdir, symlink, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { run } from '../run.mjs'
import { publicOrigin, validateHost, readHost } from './host.mjs'

const host = { profile: { memory_bytes: 68719476736, perf_cores: 10, physical_cores: 12, disk_free_bytes: 200000000000, macos_version: '15.7', hypervisor: true }, limits: { capacity: 5 } }
const options = { providers: {}, origin: 'http://mini.lan:8080', token: 'test-secret', commit: 'a'.repeat(40), installVersion: 'fixture', browser: 'not-run', timestamp: '2026-10-04T00-00-00-000Z', read: async () => host }
test('host reader uses the owner metrics boundary and records only its Go host response', async () => {
  // Unit transport substitute: the real authenticated router is independently
  // exercised with PostgreSQL by TestInstallMetricsOwnerBoundary.
  let calls = 0
  const result = await readHost('https://factory.example', { cookie: 'session=secret' }, async (url, options) => {
    calls++
    assert.equal(url, 'https://factory.example/api/install/metrics')
    assert.deepEqual(options.headers, { Cookie: 'session=secret' })
    assert.equal(options.redirect, 'error')
    return new Response(JSON.stringify({ host, metrics: [], live_connections: 0 }))
  })
  assert.equal(calls, 1)
  assert.deepEqual(result, host)
  for (const status of [401, 403, 503]) {
    await assert.rejects(readHost('https://factory.example', { cookie: 'session=secret' }, async () => new Response('{}', { status })), new RegExp(`returned ${status}`))
  }
  await assert.rejects(readHost('https://factory.example', { cookie: 'session=secret' }, async () => new Response('{"host":null}')), /host profile missing/)
})
async function temporary(body) {
  const root = await mkdtemp(join(tmpdir(), 'smithers-perf-'))
  try { await body(root) } finally { await rm(root, { recursive: true, force: true }) }
}
test('TestPerfRunnerMissingProvider: six skips retain host/origin and emit no passing receipts', async () => temporary(async (root) => {
  const result = await run({ ...options, root })
  assert.equal(result.exit, 2)
  const saved = JSON.parse(await readFile(join(result.directory, 'summary.json'), 'utf8'))
  assert.equal(saved.status, 'incomplete')
  assert.deepEqual(saved.host, host)
  assert.equal(saved.origin, options.origin)
  assert.equal(saved.budgets.length, 6)
  for (const budget of saved.budgets) {
    assert.equal(budget.status, 'skipped')
    assert.deepEqual(budget.samples, [])
    assert.match(budget.reason, /not implemented|standalone driver exists|contract driver exists/)
    for (const ticket of budget.tickets) assert.ok(budget.reason.includes(ticket))
  }
  assert.ok(!JSON.stringify(saved).includes(options.token))
  assert.deepEqual((await readdir(join(root, '.artifacts'))).sort(), ['checks', 'perf'])
  for (const budget of saved.budgets) {
    const check = join(root, '.artifacts/checks', budget.check, saved.timestamp)
    const evidence = JSON.parse(await readFile(join(check, 'summary.json'), 'utf8'))
    assert.deepEqual(evidence.budgets, [budget])
    assert.deepEqual(evidence.host, host)
    assert.equal(evidence.origin, options.origin)
    assert.deepEqual((await readdir(check)).sort(), [`${budget.name}.json`, 'summary.json'].sort())
    assert.equal(await readFile(join(check, `${budget.name}.json`), 'utf8'), await readFile(join(result.directory, `${budget.name}.json`), 'utf8'))
  }
  await assert.rejects(run({ ...options, root }), { code: 'EEXIST' })
}))
test('origin preconditions refuse before any authenticated read', async () => temporary(async (root) => {
  let reads = 0
  const result = await run({ ...options, root, origin: 'http://localhost:8080', read: async () => { reads++; throw new Error('unexpected') } })
  assert.equal(reads, 0)
  assert.equal(result.summary.host, null)
  assert.ok(result.summary.budgets.every((b) => b.reason.includes('T-INS-04')))
}))
test('host failures remain incomplete; no fallback profile is invented', async () => temporary(async (root) => {
  const result = await run({ ...options, root, read: async () => { throw new Error('T-INS-08: unavailable') } })
  assert.equal(result.summary.host, null)
  assert.ok(result.summary.budgets.every((b) => b.reason === 'T-INS-08: unavailable'))
}))
test('symlink artifact parents refuse and write nothing outside root', async () => temporary(async (root) => {
  await mkdir(join(root, 'outside'))
  await symlink(join(root, 'outside'), join(root, '.artifacts'))
  await assert.rejects(run({ ...options, root }), /unsafe artifact/)
  assert.deepEqual(await readdir(join(root, 'outside')), [])
}))
test('symlink check evidence parents refuse without writing into the target', async () => temporary(async (root) => {
  await mkdir(join(root, '.artifacts'))
  await mkdir(join(root, 'outside'))
  await symlink(join(root, 'outside'), join(root, '.artifacts/checks'))
  await assert.rejects(run({ ...options, root }), /unsafe artifact/)
  assert.deepEqual(await readdir(join(root, 'outside')), [])
}))
test('host schema and public origin reject incomplete or local metadata', () => {
  assert.deepEqual(validateHost(host), host)
  for (const value of ['http://127.0.0.2', 'http://[::1]', 'http://app.localhost', 'file:///tmp', 'http://user:pass@mini.lan', 'http://mini.lan/path']) assert.throws(() => publicOrigin(value))
  for (const value of [{}, { ...host, limits: {} }, { ...host, profile: { ...host.profile, hypervisor: undefined } }, { ...host, profile: { ...host.profile, perf_cores: -1 } }]) assert.throws(() => validateHost(value))
})

test('a named budget retains only that incomplete check; unknown names refuse', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'perf-selected-'))
  try {
    const result = await run({ ...options, root: directory, check: 'C-PERF-05' })
    assert.equal(result.exit, 2)
    assert.deepEqual(result.summary.budgets.map(budget => budget.check), ['C-PERF-05'])
    assert.equal(result.summary.budgets[0].status, 'skipped')
    assert.deepEqual(await readdir(join(directory, '.artifacts/checks')), ['C-PERF-05'])
    await assert.rejects(run({ ...options, root: directory, check: 'C-PERF-99' }), /unknown performance check/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

// Provider substitutes exercise orchestration, never qualify a real budget.
const samples = Array.from({ length: 100 }, (_, i) => ({ i, homeMs: i + 1, todoMs: i + 2, clock: 'fixture monotonic', failed: false }))
const provider = (measure) => ({ available() {}, measure, fields: { home: 'homeMs', todo: 'todoMs' } })
const passing = () => ({ status: 'passed', commit: options.commit, origin: options.origin, browser: 'fixture', samples })
test('enabled budget executes, retains raw samples and is independently checked', async () => temporary(async root => {
  let calls = 0
  const result = await run({ ...options, root, check: 'C-PERF-02', providers: { 'C-PERF-02': provider(async () => { calls++; return passing() }) } })
  assert.equal(calls, 1)
  assert.equal(result.exit, 0)
  assert.equal(result.summary.status, 'passed')
  const saved = JSON.parse(await readFile(join(root, '.artifacts/checks/C-PERF-02', options.timestamp, 'summary.json'), 'utf8'))
  assert.deepEqual(saved.budgets[0].samples, samples)
  assert.equal(saved.budgets[0].stats.homeMs.p95, 95)
}))
test('a partial run executes the enabled budget and names every unavailable budget', async () => temporary(async root => {
  const result = await run({ ...options, root, providers: { 'C-PERF-02': provider(async () => passing()) } })
  assert.equal(result.exit, 2)
  assert.equal(result.summary.budgets.filter(b => b.status === 'passed').length, 1)
  assert.equal(result.summary.budgets.filter(b => b.status === 'skipped').length, 5)
}))
test('failed, short, over-budget and foreign measurements cannot turn into skips or passes', async () => {
  for (const value of [
    { ...passing(), status: 'failed', error: 'lost delta' },
    { ...passing(), samples: samples.slice(1) },
    { ...passing(), samples: samples.map(s => ({ ...s, homeMs: 1000 })) },
    { ...passing(), samples: samples.map(s => ({ ...s, failed: true })) },
    { ...passing(), commit: 'b'.repeat(40) },
    { ...passing(), origin: 'https://other.example' }
  ]) await temporary(async root => {
    const result = await run({ ...options, root, check: 'C-PERF-02', providers: { 'C-PERF-02': provider(async () => value) } })
    assert.equal(result.exit, 1)
    assert.equal(result.summary.budgets[0].status, 'failed')
    assert.ok(result.summary.budgets[0].reason)
  })
})
test('origin or provider refusal prevents mutation; execution errors fail the full run', async () => {
  await temporary(async root => {
    let calls = 0
    const refused = { ...provider(async () => { calls++; return passing() }), available() { throw new Error('missing authenticated member') } }
    const result = await run({ ...options, root, providers: { 'C-PERF-02': refused } })
    assert.equal(calls, 0)
    assert.match(result.summary.budgets[1].reason, /missing authenticated member/)
  })
  await temporary(async root => {
    let calls = 0
    const result = await run({ ...options, root, origin: 'http://localhost', providers: { 'C-PERF-02': provider(async () => { calls++; return passing() }) } })
    assert.equal(calls, 0)
    assert.equal(result.exit, 2)
  })
  await temporary(async root => {
    const result = await run({ ...options, root, providers: { 'C-PERF-02': provider(async () => { throw new Error('socket disconnected') }) } })
    assert.equal(result.exit, 1)
    assert.match(result.summary.budgets[1].reason, /socket disconnected/)
  })
})

 test('agent provider retains model, preflight and wake cross-checks in the unified evidence', async () => temporary(async root => {
  const samples = Array.from({ length: 100 }, (_, i) => ({ i, firstTokenMs: 10, answerWithCardsMs: 20, clock: 'browser monotonic', failed: false }))
  const value = { status: 'passed', commit: options.commit, origin: options.origin, samples,
    models: [{ role: 'fast', provider: 'configured', model: 'configured-model' }],
    preflightSummary: { durationMs: { p95: 5 } }, wakesBefore: 0, wakesAfter: 0,
    metricsCrossCheck: [], browser: 'Chromium', token: 'must-not-be-recorded' }
  const result = await run({ ...options, root, check: 'C-PERF-01', providers: { 'C-PERF-01': {
    available() {}, measure: async () => value,
    fields: { firstToken: 'firstTokenMs', answerWithCards: 'answerWithCardsMs' }
  } } })
  assert.equal(result.exit, 0)
  const bytes = await readFile(join(result.directory, 'agent-first-token.json'), 'utf8')
  const budget = JSON.parse(bytes).budgets[0]
  assert.deepEqual(budget.models, value.models)
  assert.deepEqual(budget.preflightSummary, value.preflightSummary)
  assert.equal(budget.wakesBefore, 0)
  assert.equal(budget.wakesAfter, 0)
  assert.equal(budget.samples.length, 100)
  assert.equal(bytes.includes(value.token), false)
}))
