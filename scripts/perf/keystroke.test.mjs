import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, mkdir, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { configuration, markers, verifyTexts } from './keystroke.mjs'

const env = { SMITHERS_PERF_SSH_IDENTITY: '/tmp/member-key', SMITHERS_PERF_ORIGIN: 'https://factory.example', SMITHERS_PERF_PAGE: '/team/repo', SMITHERS_PERF_READ_ARGV: '["/usr/bin/ssh","-p","2222","-o","BatchMode=yes","-o","StrictHostKeyChecking=yes","--","T2@mini.lan","cat -- src/target.ts"]', SMITHERS_PERF_MEMBER_A: '/tmp/a.json', SMITHERS_PERF_MEMBER_C: '/tmp/c.json', SMITHERS_PERF_OWNER_COOKIE: 'session=fixture', SMITHERS_PERF_INSTALL_VERSION: 'fixture' }
test('requires a remote origin, separate members and an explicit machine read', () => {
  assert.equal(configuration(env).page, 'https://factory.example/team/repo')
  for (const origin of ['http://localhost:47400', 'http://127.0.0.1', 'https://[::1]']) assert.throws(() => configuration({ ...env, SMITHERS_PERF_ORIGIN: origin }))
  assert.throws(() => configuration({ ...env, SMITHERS_PERF_PAGE: 'https://other.example' }))
  assert.throws(() => configuration({ ...env, SMITHERS_PERF_MEMBER_C: env.SMITHERS_PERF_MEMBER_A }))
  for (const value of ['null', '[]', '[""]', '[1]', 'not json']) assert.throws(() => configuration({ ...env, SMITHERS_PERF_READ_ARGV: value }))
  for (const key of ['SMITHERS_PERF_MEMBER_A', 'SMITHERS_PERF_MEMBER_C', 'SMITHERS_PERF_OWNER_COOKIE', 'SMITHERS_PERF_INSTALL_VERSION', 'SMITHERS_PERF_PAGE']) assert.throws(() => configuration({ ...env, [key]: '' }))
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
    assert.equal(result.budgets[0].status, 'failed')
    assert.deepEqual(result.samples, [])
    assert.match(result.error, /configured public origin required/)
    assert.equal(await readFile(join(directory, '.artifacts/checks/C-PERF-03', timestamp, 'keystroke.json'), 'utf8'), await readFile(join(directory, '.artifacts/perf', timestamp, 'keystroke.json'), 'utf8'))
    assert.equal(result.summary, undefined)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('machine reads cannot select a host executable, shell, option or another file', () => {
  for (const argv of [
    ['sudo', 'cat', '/etc/passwd'],
    ['node', 'scratch.js'],
    ['smthrs', 'ssh', '--help', '--', 'cat', '--', 'src/target.ts'],
    ['smthrs', 'ssh', '../T2', '--', 'cat', '--', 'src/target.ts'],
    ['smthrs', 'ssh', 'T2', '--', 'sh', '-c', 'cat src/target.ts'],
    ['smthrs', 'ssh', 'T2', '--', 'cat', '--', '/etc/passwd'],
    ['smthrs', 'ssh', 'T2', '--', 'cat', '--', 'src/target.ts', 'extra'],
    ['/usr/bin/ssh', '-o', 'ProxyCommand=sh scratch.sh', 'T2@mini.lan', 'cat -- src/target.ts']
  ]) assert.throws(() => configuration({ ...env, SMITHERS_PERF_READ_ARGV: JSON.stringify(argv) }), /machine read must use/)
  const valid = JSON.parse(env.SMITHERS_PERF_READ_ARGV)
  for (const [index, value] of [[0, 'sudo'], [1, '-F'], [2, '22'], [3, '-i'], [4, 'BatchMode=no'], [5, '-F'], [6, 'StrictHostKeyChecking=no'], [7, '-v'], [8, '-option'], [8, 'T2@host;whoami'], [9, 'sh scratch.sh']]) {
    const argv = [...valid]
    argv[index] = value
    assert.throws(() => configuration({ ...env, SMITHERS_PERF_READ_ARGV: JSON.stringify(argv) }), /machine read must use/)
  }
})

test('standalone CLI refuses symlink check parents and writes nothing outside the artifact root', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'keystroke-symlink-'))
  try {
    await mkdir(join(directory, '.artifacts'))
    await mkdir(join(directory, 'outside'))
    await symlink(join(directory, 'outside'), join(directory, '.artifacts/checks'))
    const child = spawnSync(process.execPath, [fileURLToPath(new URL('./keystroke.mjs', import.meta.url))], { cwd: directory, env: { ...process.env, SMITHERS_PERF_ORIGIN: '' }, encoding: 'utf8' })
    assert.equal(child.status, 1)
    assert.match(child.stderr, /unsafe artifact directory/)
    assert.deepEqual(await readdir(join(directory, 'outside')), [])
  } finally { await rm(directory, { recursive: true, force: true }) }
})
