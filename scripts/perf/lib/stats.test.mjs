import { test } from 'node:test'
import assert from 'node:assert/strict'
import { summarize } from './stats.mjs'

const samples = () => Array.from({ length: 100 }, (_, i) => ({ clock: 'browser-B:page-1', failed: false, elapsed: 100 - i }))
test('nearest-rank percentiles preserve all successful samples', () => {
  assert.deepEqual(summarize(samples(), ['elapsed'], 100), { elapsed: { n: 100, p50: 50, p95: 95 } })
  assert.deepEqual(summarize(samples().map((s) => ({ ...s, elapsed: 0 })), ['elapsed'], 100).elapsed, { n: 100, p50: 0, p95: 0 })
})
test('insufficient, failed, invalid and incomparable samples refuse measurement', () => {
  assert.throws(() => summarize(samples().slice(1), ['elapsed'], 100), /100 samples/)
  assert.throws(() => summarize(samples(), ['elapsed'], 99), /at least 100/)
  assert.throws(() => summarize(samples(), [], 100), /fields/)
  for (const patch of [{ clock: undefined }, { clock: '' }, { failed: true }, { failed: undefined }, { elapsed: NaN }, { elapsed: Infinity }, { elapsed: -1 }, { elapsed: undefined }, { clock: 'other-page' }]) {
    const values = samples(); Object.assign(values[0], patch)
    assert.throws(() => summarize(values, ['elapsed'], 100))
  }
})
