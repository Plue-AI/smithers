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
