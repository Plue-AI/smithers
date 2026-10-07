import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, mkdir, symlink, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { run, productionProviders } from '../run.mjs'
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
  await assert.rejects(readHost('https://factory.example', { cookie: 'session=secret' }, async () =>
    new Response(JSON.stringify({ host: { ...host, profile: { ...host.profile, perf_cores: 8 } } }))), /reference host requires/)
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
const passing = () => ({ host, status: 'passed', installVersion: options.installVersion, commit: options.commit, origin: options.origin, browser: 'fixture', backgroundTabs: 3, samples })
test('enabled budget executes, retains raw samples and is independently checked', async () => temporary(async root => {
  let calls = 0
  const result = await run({ ...options, root, check: 'C-PERF-02', providers: { 'C-PERF-02': provider(async () => { calls++; return passing() }) } })
  assert.equal(calls, 1)
  assert.equal(result.exit, 0)
  assert.equal(result.summary.status, 'passed')
  const saved = JSON.parse(await readFile(join(root, '.artifacts/checks/C-PERF-02', options.timestamp, 'summary.json'), 'utf8'))
  assert.deepEqual(saved.budgets[0].samples, samples)
  assert.equal(saved.budgets[0].stats.homeMs.p95, 95)
  assert.equal(saved.budgets[0].backgroundTabs, 3)
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
    { ...passing(), installVersion: undefined },
    { ...passing(), installVersion: 'other-install' },
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
  const value = { host, status: 'passed', installVersion: options.installVersion, commit: options.commit, origin: options.origin, samples,
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

test('missing install version refuses enabled workloads before mutation', async () => temporary(async root => {
  let calls = 0
  const result = await run({ ...options, installVersion: undefined, root, check: 'C-PERF-02', providers: { 'C-PERF-02': provider(async () => { calls++; return passing() }) } })
  assert.equal(calls, 0)
  assert.equal(result.exit, 2)
  assert.match(result.summary.budgets[0].reason, /install version required/)
}))

test('failed first-token workloads retain partial samples and cross-checks in check evidence', async () => temporary(async root => {
  const evidence = { models: [{ role: 'fast', provider: 'fixture', model: 'fixture' }], wakesBefore: 0, wakesAfter: 1, preflightSummary: { durationMs: { p95: 10 } }, member: { id: 'A' }, clock: 'fixture monotonic' }
  const partial = samples.slice(0, 3)
  const result = await run({ ...options, root, check: 'C-PERF-01', providers: { 'C-PERF-01': { available() {}, fields: productionProviders['C-PERF-01'].fields, async measure() { return { ...passing(), ...evidence, status: 'failed', error: 'unexpected machine wake', samples: partial } } } } })
  assert.equal(result.exit, 1)
  const saved = JSON.parse(await readFile(join(root, '.artifacts/checks/C-PERF-01', options.timestamp, 'summary.json'), 'utf8'))
  assert.equal(saved.budgets[0].status, 'failed')
  assert.equal(saved.budgets[0].reason, 'unexpected machine wake')
  assert.deepEqual(saved.budgets[0].samples, partial)
  assert.equal(saved.budgets[0].stats, undefined)
  for (const [key, value] of Object.entries(evidence)) assert.deepEqual(saved.budgets[0][key], value)
}))


const rebaseSamples = () => Array.from({ length: 200 }, (_, i) => {
  const main = (i + 1).toString(16).padStart(40, '0'), marker = `marker-${i}`
  return { marker, main, acknowledgementsWithheld: i >= 100, holdMs: 100, clock: 'guest monotonic:fixture', failed: false,
    pending: { state: 'pending', present: true, onto: main, rebased: false, member: 'Alice' },
    receipt: { id: main, onto: main, headChanged: true, approvalsCleared: true, activity: [{ kind: 'rebase', onto: main }], marker: { text: marker, member: 'Alice' } },
    hold: { id: main, clock: 'guest monotonic:fixture', start: 10, end: 110, acknowledgedBeforeThaw: false, localSnapshotQueued: true, withheldMs: 10000 }, outboxDrained: i >= 100 }
})
const rebaseProvider = value => ({ available() {}, fields: { writeHold: 'holdMs' }, measure: async () => ({ ...passing(), samples: value }) })
test('unified rebase verdict requires both acknowledgement cohorts independently', async () => {
  const good = rebaseSamples()
  const hiddenTail = rebaseSamples()
  for (let i = 194; i < 200; i++) { hiddenTail[i].holdMs = 2000; hiddenTail[i].hold.end = 2010 }
  for (const [value, exit] of [[good, 0], [hiddenTail, 1], [good.slice(0, 100), 1], [good.map(s => ({ ...s, acknowledgementsWithheld: undefined })), 1], [good.map(s => ({ ...s, marker: 'duplicate' })), 1]]) {
    await temporary(async root => {
      const result = await run({ ...options, root, check: 'C-PERF-06', providers: { 'C-PERF-06': rebaseProvider(value) } })
      assert.equal(result.exit, exit)
      const saved = JSON.parse(await readFile(join(result.directory, 'rebase-hold.json'), 'utf8')).budgets[0]
      assert.equal(saved.samples.length, value.length)
      if (exit === 0) {
        assert.equal(saved.cohorts.normal.holdMs.n, 100)
        assert.equal(saved.cohorts.withheld.holdMs.n, 100)
      }
    })
  }
})
test('failed workload exceptions retain partial samples and cleanup failure in artifacts', async () => temporary(async root => {
  const error = Object.assign(new Error('lost held edit'), { samples: rebaseSamples().slice(0, 4), cleanupError: 'restore delivery failed' })
  const result = await run({ ...options, root, check: 'C-PERF-06', providers: { 'C-PERF-06': { ...rebaseProvider([]), measure: async () => { throw error } } } })
  assert.equal(result.exit, 1)
  const saved = JSON.parse(await readFile(join(result.directory, 'rebase-hold.json'), 'utf8')).budgets[0]
  assert.deepEqual(saved.samples, error.samples)
  assert.equal(saved.reason, error.message)
  assert.equal(saved.cleanupError, error.cleanupError)
}))

test('machine bindings select real drivers and refuse before measurement on this host', async () => temporary(async root => {
  const measured = await run({ ...options, root, providers: productionProviders })
  assert.equal(measured.summary.status, 'incomplete')
  for (const check of ['C-PERF-03', 'C-PERF-04', 'C-PERF-05']) {
    const budget = measured.summary.budgets.find(b => b.check === check)
    assert.equal(budget.status, 'skipped')
    assert.deepEqual(budget.samples, [])
    assert.doesNotMatch(budget.reason, /standalone driver exists/)
    assert.equal(typeof productionProviders[check].measure, 'function')
  }
  assert.deepEqual(productionProviders['C-PERF-05'].fields, { awake: 'hostMs' })
}))

test('bound machine drivers return failure observations without writing nested runs', async () => temporary(async root => {
  const env = { SMITHERS_PERF_ARTIFACT_ROOT: root }
  for (const check of ['C-PERF-03', 'C-PERF-04', 'C-PERF-05']) {
    const result = await productionProviders[check].measure(env)
    assert.equal(result.status, 'failed')
    assert.deepEqual(result.samples, [])
    assert.equal(typeof result.error, 'string')
  }
  assert.deepEqual(await readdir(root), [])
}))

test('unified wake verdict verifies host intervals and unique requests independently of the provider', async () => {
  const wakes = Array.from({ length: 100 }, (_, i) => ({ requestId: `wake-${i}`, branch: 'branch', capturedHead: 'b'.repeat(40), hostMs: 100, clientMs: 9000, clock: 'host monotonic/boot', failed: false,
    observation: { requestId: `wake-${i}`, branch: 'branch', kind: 'warm', failed: false, bootId: `boot-${i}`, workingHead: 'b'.repeat(40), acceptedNs: '100000000', awakeWrittenNs: '200000000' } }))
  const cases = [
    { samples: wakes, status: 'passed' },
    { samples: wakes.map(() => wakes[0]), status: 'failed' },
    { samples: wakes.map(s => ({ ...s, hostMs: 1 })), status: 'failed' },
    { samples: wakes.map(s => ({ ...s, observation: { ...s.observation, kind: 'cold' } })), status: 'failed' },
    { samples: wakes.map(s => ({ ...s, observation: undefined })), status: 'failed' }
  ]
  for (const fixture of cases) await temporary(async root => {
    const result = await run({ ...options, root, check: 'C-PERF-05', providers: { 'C-PERF-05': { available() {}, fields: productionProviders['C-PERF-05'].fields, async measure() { return { ...passing(), samples: fixture.samples } } } } })
    assert.equal(result.summary.status, fixture.status)
    assert.equal(result.summary.budgets[0].samples.length, 100)
    if (fixture.status === 'passed') {
      assert.equal(result.summary.budgets[0].wakeStats.hostMs.p95, 100)
      assert.equal(result.summary.budgets[0].wakeStats.clientMs.p95, 9000)
    }
  })
})

 test('unified rebase verdict refuses fabricated durations and lost or replayed evidence', async () => {
  for (const corrupt of [
    s => { s.holdMs = 0 },
    s => { delete s.hold },
    s => { s.hold.clock = 'guest monotonic:other' },
    s => { s.hold.id = 'other' },
    s => { s.pending.rebased = true },
    s => { s.receipt.marker.member = 'Mallory' },
    s => { s.receipt.activity = [] },
    s => { s.receipt.approvalsCleared = false },
    s => { s.hold.acknowledgedBeforeThaw = true },
    s => { s.outboxDrained = false },
    s => { s.hold.withheldMs = 9999 },
    (s, values) => { s.receipt.id = values[0].receipt.id; s.hold.id = s.receipt.id }
  ]) await temporary(async root => {
    const values = rebaseSamples()
    corrupt(values[199], values)
    const result = await run({ ...options, root, check: 'C-PERF-06', providers: { 'C-PERF-06': rebaseProvider(values) } })
    assert.equal(result.exit, 1)
    const saved = JSON.parse(await readFile(join(result.directory, 'rebase-hold.json'), 'utf8')).budgets[0]
    assert.equal(saved.status, 'failed')
    assert.deepEqual(saved.samples, values)
  })
 })

 test('nonreference host refuses every workload before activation', async () => {
  for (const profile of [
    { ...host.profile, memory_bytes: 34359738368 },
    { ...host.profile, perf_cores: 12 },
    { ...host.profile, hypervisor: false },
    { ...host.profile, macos_version: 'linux' }
  ]) await temporary(async root => {
    let calls = 0
    const result = await run({ ...options, root, read: async () => ({ ...host, profile }), providers: {
      'C-PERF-02': { ...provider(async () => { calls++; return passing() }), available() { calls++ } }
    } })
    assert.equal(calls, 0)
    assert.equal(result.exit, 2)
    assert.ok(result.summary.budgets.every(b => b.status === 'skipped' && b.reason.includes('reference host requires')))
  })
})

test('driver host evidence is retained and a changed platform fails after launch', async () => {
  for (const measurementHost of [undefined, { ...host, profile: { ...host.profile, physical_cores: 14 } },
    { ...host, profile: { ...host.profile, macos_version: '16.0' } }]) await temporary(async root => {
    const result = await run({ ...options, root, check: 'C-PERF-02', providers: {
      'C-PERF-02': provider(async () => ({ ...passing(), host: measurementHost }))
    } })
    assert.equal(result.exit, 1)
    assert.equal(result.summary.budgets[0].samples.length, 100)
  })
  await temporary(async root => {
    const measuredHost = { ...host, profile: { ...host.profile, disk_free_bytes: 190000000000 }, limits: { capacity: 4 } }
    const result = await run({ ...options, root, check: 'C-PERF-02', providers: {
      'C-PERF-02': provider(async () => ({ ...passing(), host: measuredHost }))
    } })
    assert.equal(result.exit, 0)
    const saved = JSON.parse(await readFile(join(root, '.artifacts/checks/C-PERF-02', options.timestamp, 'summary.json'), 'utf8'))
    assert.deepEqual(saved.host, host)
    assert.deepEqual(saved.budgets[0].host, measuredHost)
  })
})
