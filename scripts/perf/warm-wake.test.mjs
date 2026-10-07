import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration, verifyWake, summarizeWakes, run } from './warm-wake.mjs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const head = 'a'.repeat(40)
const sample = { requestId: 'wake-1', branch: 'branch-1', capturedHead: head, clientMs: 20 }
const observation = { requestId: 'wake-1', branch: 'branch-1', kind: 'warm', failed: false, bootId: 'host-boot', acceptedNs: '10000000000000000', awakeWrittenNs: '10000000001000000', workingHead: head }

test('uses host nanosecond differences without rounding the absolute timestamp', () => {
  assert.equal(verifyWake(sample, observation).hostMs, 1)
  assert.equal(verifyWake(sample, observation).clientMs, 20)
})
for (const [name, changed] of Object.entries({
  cold: { kind: 'cold' }, failed: { failed: true }, unknownOutcome: { failed: undefined },
  foreignRequest: { requestId: 'other' }, foreignBranch: { branch: 'other' },
  changedHead: { workingHead: 'b'.repeat(40) }, missingClock: { bootId: '' },
  wallClock: { acceptedNs: '2026-10-07T00:00:00Z' }, negativeInterval: { awakeWrittenNs: '0' },
  floatingPoint: { acceptedNs: 10000000000000000 }, absentObservation: { awakeWrittenNs: undefined },
})) test(`refuses ${name}`, () => assert.throws(() => verifyWake(sample, { ...observation, ...changed })))

test('requires verified captured head and nonnegative finite client duration', () => {
  for (const patch of [{ capturedHead: '' }, { clientMs: NaN }, { clientMs: -1 }]) assert.throws(() => verifyWake({ ...sample, ...patch }, observation))
})

const samples = () => Array.from({ length: 100 }, (_, i) => verifyWake({ ...sample, requestId: `wake-${i}` }, { ...observation, requestId: `wake-${i}` }))
test('nearest-rank p95 retains slow samples and uses a strict five-second budget', () => {
  const values = samples()
  for (let i = 94; i < 100; i++) values[i].hostMs = 5000
  assert.equal(summarizeWakes(values).passed, false)
  values[94].hostMs = 4999
  assert.equal(summarizeWakes(values).passed, true)
  assert.equal(summarizeWakes(values).hostMs.p95, 4999)
})

test('refuses missing, duplicate, failed and cross-restart samples', () => {
  assert.throws(() => summarizeWakes(samples().slice(1)))
  for (const patch of [{ requestId: 'wake-1' }, { failed: true }, { clock: 'another boot' }]) {
    const values = samples(); Object.assign(values[0], patch)
    assert.throws(() => summarizeWakes(values))
  }
})

const env = { SMITHERS_PERF_ORIGIN: 'https://mac.example', SMITHERS_PERF_BRANCH: 'branch-1', SMITHERS_PERF_REPOSITORY: 'owner/repo', SMITHERS_PERF_OWNER_COOKIE: 'smithers_session=secret; __csrf=csrf', SMITHERS_PERF_INSTALL_VERSION: 'fixture', SMITHERS_PERF_HOST_WAKE_LOG: '/tmp/host.jsonl' }
test('configuration requires public origin, credentials, host evidence and recorded sleep delay', () => {
  assert.equal(configuration(env).sleepSeconds, 120)
  for (const patch of [{ SMITHERS_PERF_HOST_WAKE_LOG: '' }, { SMITHERS_PERF_ORIGIN: 'http://localhost' }, { SMITHERS_PERF_OWNER_COOKIE: 'smithers_session=secret' }, { SMITHERS_PERF_SLEEP_SECONDS: '0' }, { SMITHERS_PERF_REPOSITORY: '../repo' }]) assert.throws(() => configuration({ ...env, ...patch }))
})

test('CLI workload retains refusal artifacts without credentials or a passing budget', async () => {
  const root = await mkdtemp(join(tmpdir(), 'warm-wake-test-'))
  try {
    const result = await run({ ...env, SMITHERS_PERF_HOST_WAKE_LOG: '', SMITHERS_PERF_ARTIFACT_ROOT: root })
    assert.equal(result.status, 'failed')
    assert.equal(result.budgets[0].status, 'failed')
    assert.equal(result.samples.length, 0)
    const raw = await readFile(join(result.artifacts, 'warm-wake.json'), 'utf8')
    assert.equal(raw.includes('secret'), false)
    assert.match(raw, process.platform === 'darwin' ? /authenticated lifecycle qualification unavailable/ : /reference-network Mac required/)
    const receipt = await readFile(join(root, '.artifacts/checks/C-PERF-05', result.timestamp, 'summary.json'), 'utf8')
    assert.equal(JSON.parse(receipt).status, 'failed')
  } finally { await rm(root, { recursive: true, force: true }) }
})
