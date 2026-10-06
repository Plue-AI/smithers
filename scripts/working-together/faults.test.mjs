import test from 'node:test'
import assert from 'node:assert/strict'
import { verdict, wikiVerdict, suites, points } from './faults.mjs'
test('every named component must execute assertions; no empty or failed cargo receipt qualifies', () => {
  const logs = suites.map(suite => `Running tests/${suite}.rs (target)\ntest result: ok. 2 passed; 0 failed`).join('\n')
  assert.equal(verdict(0, logs), 'component-passed')
  assert.equal(verdict(1, logs), 'failed')
  assert.equal(verdict(0, ''), 'failed')
  for (const suite of suites) {
    assert.equal(verdict(0, logs.replace(`Running tests/${suite}.rs`, 'missing')), 'failed')
    const empty = logs.replace(`Running tests/${suite}.rs (target)\ntest result: ok. 2 passed`, `Running tests/${suite}.rs (target)\ntest result: ok. 0 passed`)
    assert.equal(verdict(0, empty), 'failed')
  }
  assert.deepEqual(points, ['K1', 'K2', 'K3', 'K3b', 'K4', 'K4b', 'K5a', 'K5b', 'K5c', 'K6', 'K7a', 'K7b', 'K7c', 'K7d', 'K7e', 'K8'])
})

test('fault CLI refuses a symlink evidence parent before invoking cargo', async () => {
  const { mkdtemp, mkdir, symlink, readdir, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { spawnSync } = await import('node:child_process')
  const root = await mkdtemp(join(tmpdir(), 'fault-symlink-'))
  try {
    await mkdir(join(root, '.artifacts'))
    await mkdir(join(root, 'outside'))
    await symlink(join(root, 'outside'), join(root, '.artifacts/checks'))
    const child = spawnSync(process.execPath, [new URL('./faults.mjs', import.meta.url).pathname], { cwd: root, env: { ...process.env, PATH: '' }, encoding: 'utf8' })
    assert.equal(child.status, 1)
    assert.match(child.stderr, /unsafe evidence directory/)
    assert.deepEqual(await readdir(join(root, 'outside')), [])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('wiki boundary requires ten executed passes and a completed package, never skips', () => {
  const pass = JSON.stringify({ Test: 'TestWikiHostCommittedReceiptsAndRestart', Action: 'pass' })
  const packagePass = JSON.stringify({ Action: 'pass' })
  const logs = [...Array(10).fill(pass), packagePass].join('\n')
  assert.equal(wikiVerdict(0, logs), 'boundary-passed')
  assert.equal(wikiVerdict(0, 'null\n42\n[]\ninvalid\n' + logs), 'boundary-passed')
  assert.equal(wikiVerdict(1, logs), 'failed')
  assert.equal(wikiVerdict(0, Array(9).fill(pass).join('\n') + '\n' + packagePass), 'failed')
  assert.equal(wikiVerdict(0, Array(10).fill(pass).join('\n')), 'failed')
  for (const Action of ['skip', 'fail']) {
    assert.equal(wikiVerdict(0, logs + '\n' + JSON.stringify({ Test: 'TestWikiHostCommittedReceiptsAndRestart', Action })), 'failed')
  }
  assert.equal(wikiVerdict(0, 'test result: ok. 10 passed'), 'failed')
})

test('missing wiki fixture records a failure before starting the host', async () => {
  const { mkdtemp, readdir, readFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { run } = await import('./faults.mjs')
  const root = await mkdtemp(join(tmpdir(), 'wiki-fault-refusal-'))
  try {
    assert.equal(await run({ root, wikiOnly: true }), 1)
    const parent = join(root, '.artifacts/checks/C-DUR-04')
    const [directory] = await readdir(parent)
    const summary = JSON.parse(await readFile(join(parent, directory, 'summary.json'), 'utf8'))
    assert.equal(summary.status, 'failed')
    assert.equal(summary.reason, 'wiki host fixture unavailable')
    assert.deepEqual(summary.points, [{ point: 'K8', status: 'blocked' }])
    assert.deepEqual((await readdir(join(parent, directory))).sort(), ['env.json', 'summary.json'])
  } finally { await rm(root, { recursive: true, force: true }) }
})
