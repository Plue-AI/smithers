import { test } from 'node:test'
import assert from 'node:assert/strict'
import { acceptMove, configuration, stableSnapshot } from './projection-delta.mjs'

test('source move receipt preserves cursor and independently names the mutation', () => {
  const frame = { t: 'delta', cursor: 7, data: { Type: 'todo.moved', Data: { n: 12, direction: 'up' } } }
  assert.equal(acceptMove(frame, 6, 12, 'up'), 7)
  for (const changed of [{ ...frame, cursor: 6 }, { ...frame, cursor: 8 }, { ...frame, t: 'snap' }, { t: 'gap' }, { ...frame, data: { Type: 'todo.moved', Data: { n: 13, direction: 'up' } } }, { ...frame, data: { Type: 'todo.moved', Data: { n: 12, direction: 'down' } } }]) assert.throws(() => acceptMove(changed, 6, 12, 'up'))
})
test('reference workload requires remote origin, member storage and CSRF authority', () => {
  const env = { SMITHERS_PERF_ORIGIN: 'https://factory.example', SMITHERS_PERF_TODO: '12', SMITHERS_PERF_OWNER_COOKIE: 'smithers_session=session; __csrf=csrf', SMITHERS_PERF_MEMBER_A: '/tmp/member.json', SMITHERS_PERF_INSTALL_VERSION: 'test' }
  assert.deepEqual(configuration(env), { origin: 'https://factory.example', n: 12, csrf: 'csrf' })
  for (const key of Object.keys(env)) assert.throws(() => configuration({ ...env, [key]: undefined }))
  assert.throws(() => configuration({ ...env, SMITHERS_PERF_ORIGIN: 'http://127.0.0.1:4000' }))
  assert.throws(() => configuration({ ...env, SMITHERS_PERF_OWNER_COOKIE: 'smithers_session=session' }))
})

test('a metadata refresh cannot substitute for a missed source position', () => {
 assert.equal(stableSnapshot({ t: 'snap', cursor: 7, data: {} }, 7), true)
 for (const frame of [{ t: 'snap', cursor: 8, data: {} }, { t: 'snap', cursor: 6, data: {} }, { t: 'snap', cursor: 7 }, { t: 'delta', cursor: 7, data: {} }, { t: 'gap' }]) assert.equal(stableSnapshot(frame, 7), false)
})
