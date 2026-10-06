import test from 'node:test'
import assert from 'node:assert/strict'
import { verdict, suites, points } from './faults.mjs'
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
