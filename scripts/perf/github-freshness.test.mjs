import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { comparePhases, runFreshness, select, summarize } from './github-freshness.mjs'

test('freshness uses independent GitHub writes and install HTTP reads, retaining missing observations', async t => {
  let clock = 1000
  const head = 'a'.repeat(40)
  const visible = { main: head, pr: [], checks: [], issue: '' }
  const writes = []
  let omitIssue = false
  let refuseReview = false
  const server = http.createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    const input = body ? JSON.parse(body) : undefined
    let value
    if (req.url.startsWith('/api/')) {
      assert.equal(req.headers.authorization, 'Bearer install-fixture')
      value = { value: visible[req.url.slice(5)] }
    } else {
      assert.equal(req.headers.authorization, 'Bearer member-fixture')
      if (req.method !== 'GET') writes.push({ path: req.url, input })
      if (refuseReview && req.url.endsWith('/reviews')) {
        res.writeHead(503)
        res.end()
        return
      }
      if (req.url.includes('/pulls/') && req.method === 'GET') value = { state: 'open', head: { sha: head } }
      else if (req.url.includes('/statuses?')) value = [{ context: 'freshness/hold', state: 'pending' }]
      else if (req.url.endsWith('/git/ref/heads/main')) value = { object: { sha: head } }
      else if (req.url.endsWith(`/git/commits/${head}`)) value = { tree: { sha: head } }
      else if (req.url.endsWith('/git/trees')) value = { sha: head }
      else if (req.url.endsWith('/git/commits')) value = { sha: 'b'.repeat(40) }
      else if (req.url.endsWith('/git/refs/heads/main')) { visible.main = input.sha; value = {} }
      else if (req.url.endsWith('/reviews')) { visible.pr = [{ id: 701 }]; value = { id: 701 } }
      else if (req.url.endsWith(`/statuses/${head}`)) { visible.checks.push(input.context); value = {} }
      else if (req.method === 'PATCH') { if (!omitIssue) visible.issue = input.body; value = {} }
      else value = { body: 'original', state: 'open' }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(value))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const origin = `http://127.0.0.1:${server.address().port}`
  const config = { repository: 'fixture/canary', run: 'fixture', phase: 'inactive', origin, githubOrigin: origin,
    pulls: Array.from({ length: 10 }, (_, i) => ({ number: i + 1, todo: i + 1, head })),
    issues: Array.from({ length: 100 }, (_, i) => i + 11),
    observe: Object.fromEntries(Object.keys(visible).map(kind => [kind, { path: `/api/${kind}`, pointer: '/value' }])) }
  const events = []
  const options = { count: 1, cadence: 20, grace: 30, poll: 10, githubToken: 'member-fixture', installToken: 'install-fixture',
    now: () => clock, wait: async ms => { clock += ms }, onSample: async sample => events.push({ ...sample }) }
  const result = await runFreshness(config, options)
  assert.equal(result.samples.length, 4)
  assert.equal(events.length, 8)
  assert.ok(Object.values(result.metrics).every(metric => metric.passed))
  assert.equal(writes.length, 6)
  assert.equal(writes[2].input.force, false)
  assert.equal(writes[3].input.commit_id, head)
  assert.equal(result.samples[0].t0, 1000)
  omitIssue = true
  visible.issue = ''
  const missed = await runFreshness({ ...config, phase: 'dropped' }, options)
  assert.equal(missed.metrics.issue.missing, 1)
  assert.equal(missed.metrics.issue.passed, false)
  visible.checks = undefined
  const before = writes.length
  await assert.rejects(runFreshness(config, options), /projection unavailable/)
  assert.equal(writes.length, before, 'missing projection refuses before mutation')
  visible.checks = []
  refuseReview = true
  const previousEvents = events.length
  await assert.rejects(runFreshness(config, options), /HTTP 503/)
  assert.equal(writes.length - before, 4, 'ambiguous review write is never retried')
  assert.equal(events.length - previousEvents, 1, 'successful main write survives later failure')
})

test('nearest-rank p95 and literal limits reject slow or missing samples', () => {
  const samples = Array.from({ length: 100 }, (_, i) => ({ kind: 'main', t0: 0, t1: i < 95 ? 60000 : 60001 }))
  assert.equal(summarize(samples, 100).main.passed, true)
  samples[94].t1 = 60001
  assert.equal(summarize(samples, 100).main.passed, false)
  samples[94].t1 = null
  assert.equal(summarize(samples, 100).main.missing, 1)
  assert.equal(select({ 'a/b': { '~': 4 } }, '/a~1b/~0'), 4)
})

test('both phases require 100 observations and dropped p95 within five seconds', () => {
  const metrics = Object.fromEntries(['main', 'pr', 'checks', 'issue'].map(kind => [kind, { passed: true, n: 100, p95: 40000 }]))
  const first = { phase: 'inactive', metrics }
  const second = { phase: 'dropped', metrics: structuredClone(metrics) }
  second.metrics.main.p95 = 45000
  assert.equal(comparePhases(first, second), true)
  second.metrics.main.p95++
  assert.equal(comparePhases(first, second), false)
  second.metrics.main.p95--
  second.metrics.issue.n--
  assert.equal(comparePhases(first, second), false)
})
