import test from 'node:test'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { configuration, markers, verifySample, verifyActivity, activityEntries } from './disk-write.mjs'
const env = { SMITHERS_PERF_SSH_IDENTITY: '/tmp/member-key', SMITHERS_PERF_ORIGIN: 'https://mini.example', SMITHERS_PERF_PAGE: '/repo', SMITHERS_PERF_MEMBER_A: '/tmp/a.json', SMITHERS_PERF_MEMBER_C: '/tmp/c.json', SMITHERS_PERF_OWNER_COOKIE: 'fixture', SMITHERS_PERF_INSTALL_VERSION: 'fixture', SMITHERS_PERF_SSH_MEMBER: 'C', SMITHERS_PERF_SSH_DESTINATION: 'T2@mini.lan', SMITHERS_PERF_BRANCH: 'b2' }
test('scratch branch configuration refuses host programs, SSH options, foreign pages and absent identity', () => {
  assert.equal(configuration(env).branch, 'b2')
  for (const destination of ['-oProxyCommand=x', 'T2@host;whoami', 'T2@host/path', '']) assert.throws(() => configuration({ ...env, SMITHERS_PERF_SSH_DESTINATION: destination }))
  for (const branch of ['b:files', '../b', 'b\\x', '']) assert.throws(() => configuration({ ...env, SMITHERS_PERF_BRANCH: branch }))
  for (const key of Object.keys(env)) assert.throws(() => configuration({ ...env, [key]: '' }))
  assert.throws(() => configuration({ ...env, SMITHERS_PERF_PAGE: 'https://other.example/' }))
  assert.throws(() => configuration({ ...env, SMITHERS_PERF_ORIGIN: 'http://localhost:47400' }))
})
test('exact bytes, independent digest and SSH member identity are required for every sample', () => {
  const text = '// m1\n', digest = createHash('sha256').update(text).digest('hex')
  const hint = { path: 'src/a.ts', post_digest: digest, actor: { member_id: 'C', via: 'ssh' } }
  assert.equal(verifySample(text, text, hint, 'C'), digest)
  assert.throws(() => verifySample(text + text, text, hint, 'C'))
  for (const patch of [{ path: 'src/b.ts' }, { post_digest: '0'.repeat(64) }, { actor: { member_id: 'agent', via: 'ssh' } }, { actor: { member_id: 'C', via: 'terminal' } }]) assert.throws(() => verifySample(text, text, { ...hint, ...patch }, 'C'))
  assert.throws(() => verifySample(text, text, undefined, 'C'))
})
test('200 unique markers and distinct per-write activity entries; unrelated baseline is excluded', () => {
  assert.equal(markers.length, 200); assert.equal(new Set(markers).size, 200)
  const entries = markers.map((_, i) => ({ id: String(i), kind: 'burst', actor: { member_id: 'C', via: 'ssh' }, files: [{ path: 'src/a.ts' }] }))
  assert.equal(verifyActivity([{ id: 'old' }, ...entries], new Set(['old']), 'C').length, 200)
  assert.throws(() => verifyActivity(entries.slice(1), new Set(), 'C'))
  assert.throws(() => verifyActivity([...entries.slice(1), entries[1]], new Set(), 'C'))
  for (const patch of [{ kind: 'write' }, { actor: { member_id: 'agent', via: 'ssh' } }, { files: [] }, { files: [{ path: 'other' }] }]) assert.throws(() => verifyActivity([{ ...entries[0], ...patch }, ...entries.slice(1)], new Set(), 'C'))
})
test('public CLI refusal retains identical skipped artifacts without a timing pass', async () => {
  const root = await mkdtemp(join(tmpdir(), 'disk-refusal-'))
  try {
    const child = spawnSync(process.execPath, [new URL('./disk-write.mjs', import.meta.url).pathname], { cwd: fileURLToPath(new URL('../../', import.meta.url)), env: { ...process.env, SMITHERS_PERF_ORIGIN: '', SMITHERS_PERF_ARTIFACT_ROOT: root }, encoding: 'utf8' })
    assert.equal(child.status, 2, child.stderr)
    const [timestamp] = await readdir(join(root, '.artifacts/perf'))
    const bytes = await readFile(join(root, '.artifacts/perf', timestamp, 'disk-write.json'), 'utf8')
    assert.equal(bytes, await readFile(join(root, '.artifacts/checks/C-PERF-04', timestamp, 'disk-write.json'), 'utf8'))
    const result = JSON.parse(bytes)
    assert.equal(result.status, 'incomplete'); assert.equal(result.budgets[0].status, 'skipped'); assert.deepEqual(result.budgets[0].samples, []); assert.equal(result.budgets[0].stats, undefined)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('production activity log arrays retain every entry across batched deltas', () => {
  const entries = markers.map((_, i) => ({ id: String(i), kind: 'burst', actor: { member_id: 'C', via: 'ssh' }, files: [{ path: 'src/a.ts' }] }))
  const frames = [{ t: 'snap', id: 802, data: [{ id: 'old' }] }, { t: 'delta', id: 801, data: { changed: [] } },
    { t: 'delta', id: 802, data: entries.slice(0, 100) }, { t: 'delta', id: 802, data: entries.slice(100) }]
  assert.deepEqual(activityEntries(frames), [{ id: 'old' }, ...entries])
  assert.equal(verifyActivity(activityEntries(frames), new Set(['old']), 'C').length, 200)
  for (const t of ['gap', 'err']) assert.throws(() => activityEntries([...frames, { t, id: 802 }]), /subscription failed/)
  for (const data of [null, {}, entries[0]]) assert.throws(() => activityEntries([{ t: 'delta', id: 802, data }]), /entry array/)
  assert.throws(() => verifyActivity(activityEntries([...frames, { t: 'delta', id: 802, data: [entries[0]] }]), new Set(['old']), 'C'), /distinct/)
})
