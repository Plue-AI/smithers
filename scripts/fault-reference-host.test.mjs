import { test } from 'node:test'
import assert from 'node:assert/strict'
import { requireReferenceFaultHost } from './fault-reference-host.mjs'
const approved = { platform: 'darwin', uuid: 'ABC', hosts: [{ ioPlatformUUID: 'abc' }], bundleExists: true }
test('only the approved reference Mac with its bundle admits faults', () => {
  assert.doesNotThrow(() => requireReferenceFaultHost(approved))
  for (const change of [{ platform: 'linux' }, { uuid: undefined }, { hosts: [] }, { bundleExists: false }]) {
    assert.throws(() => requireReferenceFaultHost({ ...approved, ...change }), /reference faults require/)
  }
})

test('the command refuses a Linux host before a fault starts', { skip: process.platform !== 'linux' }, async () => {
  const { spawnSync } = await import('node:child_process')
  const result = spawnSync(process.execPath, ['scripts/fault-reference-host.mjs'], { encoding: 'utf8' })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /reference faults require the approved macOS reference host/)
})
