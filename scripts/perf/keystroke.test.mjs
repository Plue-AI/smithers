import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { configuration, markers, verifyTexts } from './keystroke.mjs'

const env = { SMITHERS_PERF_ORIGIN: 'https://factory.example', SMITHERS_PERF_PAGE: '/team/repo', SMITHERS_PERF_READ_ARGV: '["smthrs","ssh","T2","--","cat","src/target.ts"]', SMITHERS_PERF_MEMBER_A: '/tmp/a.json', SMITHERS_PERF_MEMBER_C: '/tmp/c.json', SMITHERS_PERF_TOKEN: 'fixture', SMITHERS_PERF_INSTALL_VERSION: 'fixture' }
test('requires a remote origin, separate members and an explicit machine read', () => {
  assert.equal(configuration(env).page, 'https://factory.example/team/repo')
  for (const origin of ['http://localhost:47400', 'http://127.0.0.1', 'https://[::1]']) assert.throws(() => configuration({ ...env, SMITHERS_PERF_ORIGIN: origin }))
  assert.throws(() => configuration({ ...env, SMITHERS_PERF_PAGE: 'https://other.example' }))
  assert.throws(() => configuration({ ...env, SMITHERS_PERF_MEMBER_C: env.SMITHERS_PERF_MEMBER_A }))
  for (const value of ['null', '[]', '[""]', '[1]', 'not json']) assert.throws(() => configuration({ ...env, SMITHERS_PERF_READ_ARGV: value }))
  for (const key of ['SMITHERS_PERF_MEMBER_A', 'SMITHERS_PERF_MEMBER_C', 'SMITHERS_PERF_TOKEN', 'SMITHERS_PERF_INSTALL_VERSION', 'SMITHERS_PERF_PAGE']) assert.throws(() => configuration({ ...env, [key]: '' }))
})
test('200 unique six-character markers must occur exactly once and in order on both members and disk', () => {
  assert.equal(markers.length, 200)
  assert.equal(new Set(markers).size, 200)
  assert.ok(markers.every(marker => marker.length === 6))
  const text = markers.join('\n')
  verifyTexts(text, text, text)
  for (const invalid of [text.replace(markers[99], ''), `${text}\n${markers[0]}`, [...markers].reverse().join('\n')]) assert.throws(() => verifyTexts(invalid, invalid, invalid))
  assert.throws(() => verifyTexts(text, `${text}\n`, text))
  assert.throws(() => verifyTexts(text, text, text.slice(0, -1)))
})
test('CLI refuses an unconfigured stack and retains failed evidence without a passing receipt', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'keystroke-refusal-'))
  try {
    const child = spawnSync(process.execPath, [fileURLToPath(new URL('./keystroke.mjs', import.meta.url))], { cwd: directory, env: { ...process.env, SMITHERS_PERF_ORIGIN: '' }, encoding: 'utf8' })
    assert.equal(child.status, 1, child.stderr)
    const [timestamp] = await readdir(join(directory, '.artifacts/perf'))
    const result = JSON.parse(await readFile(join(directory, '.artifacts/perf', timestamp, 'keystroke.json'), 'utf8'))
    assert.equal(result.status, 'failed')
    assert.deepEqual(result.samples, [])
    assert.match(result.error, /configured public origin required/)
    assert.equal(await readFile(join(directory, '.artifacts/checks/C-PERF-03', timestamp, 'keystroke.json'), 'utf8'), `${JSON.stringify(result, null, 2)}\n`)
    assert.equal(result.summary, undefined)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
