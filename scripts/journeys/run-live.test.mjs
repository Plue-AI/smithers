import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile, rm, readdir, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { ROOT, liveRun, assertLiveModels, main, publicOrigin, parseArgs, acceptanceChecks, validateDefinitions, formatSchedule, buildSchedule } from './run.mjs'
import { verifyCredentialSoak, verifyActivation } from './evidence.mjs'
import { journeys } from './steps/index.mjs'

// All runtime boundaries below are fakes. These tests prove runner behavior,
// never release acceptance: artifacts and every verdict must remain unit-only.
const origin = 'https://unit-install.example'
const repository = 'smithers-mvp-canary/2026-10-02'
const stamp = '2026-10-03T06:30:00.000Z'
const browserStep = (id = 'J2.owner', check = 'C-J2-01', extra = {}) => ({ id, check, kind: 'browser', procedure: ['Unit operator boundary'], ...extra })
const scheduleOf = (steps) => [{ journey: steps[0].id.split('.')[0], theme: 'light', steps }]

test('actual model admission requires an identifier rather than a provider alone', () => {
  for (const config of [{ provider: 'openai' }, { providerId: 'anthropic' },
    { roles: [{ provider: 'openai' }, { providerId: 'anthropic' }] },
    { provider: 'openai', model: '' }, { provider: 'openai', model_id: '   ' },
    { providers: [{ id: 'openai', name: 'anthropic' }] }]) {
    assert.throws(() => assertLiveModels(config), /configuration is absent or unrecognizable/)
  }
  for (const config of [{ provider: 'openai', model: 'gpt-6.1' },
    { model_id: 'gpt-6.1' }, { modelName: 'claude-live' },
    { routing: { roles: [{ providerId: 'anthropic', model: 'claude-live' }] } }]) {
    assert.equal(assertLiveModels(config), config)
  }
  for (const config of [{ model: 'scripted' },
    { model: 'gpt-6.1', routing: { provider: 'fixture' } },
    { seats: [{ model: 'gpt-6.1', mock: true }] }]) {
    assert.throws(() => assertLiveModels(config), /Scripted or fixture model/)
  }
})

async function fixture(t, steps = [browserStep()]) {
  const base = join(ROOT, '.artifacts/journey-unit')
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(join(base, 'live-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const receipt = join(root, 'manual-receipt.json')
  const hostRecording = join(root, 'host.mov')
  await writeFile(receipt, JSON.stringify({ layer: 'unit', observed: true }))
  await writeFile(hostRecording, 'unit screen bytes')
  const configPath = join(root, 'config.json')
  const config = { repository, browser: 'chromium', origin, installVersion: 'unit-release', commit: 'a'.repeat(40),
    hostProfile: 'unit-mini', macOSBuild: 'unit-build', hostRecording, browserMachine: 'unit-laptop',
    referenceHost: 'unit-mini', quickstart: 'unit-quickstart', modelConfigPaths: ['/api/models', '/api/repository/models'],
    evidence: Object.fromEntries(steps.map(step => [step.id, [receipt]])) }
  const calls = []
  const prompts = []
  const captures = []
  const stopped = []
  const outputs = []
  const models = { provider: 'anthropic', model: 'claude-live' }
  const env = { JOURNEY_CONFIG: configPath, JOURNEY_OWNER_TOKEN: 'unit-owner', JOURNEY_BEN_TOKEN: 'unit-ben',
    JOURNEY_ALICE_TOKEN: 'unit-alice', JOURNEY_INSTALL_TOKEN: 'unit-install' }
  const deps = { root, env, runtime: { platform: 'darwin', arch: 'arm64', isTTY: true },
    now: () => new Date('2026-10-02T23:30:00-07:00'), output: text => outputs.push(text),
    fetchImpl: async (url, options) => {
      const path = new URL(url).pathname
      calls.push({ type: 'fetch', path, options })
      return new Response(JSON.stringify(path === '/api/install' ? { repository } : models), { status: 200 })
    },
    githubActors: async () => {
      calls.push({ type: 'actors' })
      return { verifyAccess: async () => calls.push({ type: 'access' }),
        comment: async (actor, input) => calls.push({ type: 'comment', actor, input }) }
    },
    ensureCanaryRepository: async () => calls.push({ type: 'canary' }),
    createTerminal: () => ({ question: async prompt => { prompts.push(prompt); return prompt.includes('Type PASS') ? 'PASS' : '' },
      close: () => calls.push({ type: 'terminal.close' }) }),
    browserTypes: { chromium: { unit: 'chromium' }, webkit: { unit: 'webkit' } },
    startBrowserStep: async input => {
      captures.push(input)
      const actor = input.directory.split('/').at(-1)
      return { stop: async () => { stopped.push(actor); return { storageState: { unit: actor } } } }
    },
    startMacRecording: async ({ path }) => {
      calls.push({ type: 'screen.start' })
      return { path, stop: async () => { stopped.push('screen'); await writeFile(path, 'unit screen') } }
    },
    startRemoteMacRecording: async ({ path }) => {
      calls.push({ type: 'host.start' })
      return { path, stop: async () => { stopped.push('host'); await writeFile(path, 'unit host screen') } }
    },
    outsideSave: async input => { calls.push({ type: 'outside-save' }); await input.beforeSave('unit') },
    restartBackend: async () => calls.push({ type: 'restart' }),
    duplicateLaunch: async () => calls.push({ type: 'duplicate' }),
    githubApi: () => async () => { throw new Error('unexpected activation API') },
  }
  const schedule = scheduleOf(steps)
  const runDirectory = join(root, '.artifacts/checks', steps[0].check, stamp, 'light/run')
  return { root, config, env, deps, calls, prompts, captures, stopped, outputs, schedule, models,
    runDirectory, receipt, run: async () => { await writeFile(configPath, JSON.stringify(config)); return liveRun({ origin, theme: 'light' }, schedule, deps) },
    summary: async () => JSON.parse(await readFile(join(runDirectory, 'summary.json'), 'utf8')),
    events: async () => (await readFile(join(runDirectory, 'steps.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse) }
}

test('success reads authoritative roles and repository before side effects, retains UTC unit receipts', async t => {
  const f = await fixture(t, [browserStep('J2.owner', 'C-J2-01', { checks: ['C-UI-01'] }), browserStep('J2.member', 'C-J2-01')])
  const summary = await f.run()
  assert.equal(summary.status, 'complete')
  assert.equal(summary.evidenceLayer, 'unit')
  assert.equal(summary.timestamp, stamp)
  assert.equal(summary.finishedAt, stamp)
  assert.equal(summary.checks['C-J2-01'].status, 'unit-pass')
  assert.equal(summary.checks['C-J2-01'].steps.length, 2)
  assert.equal(summary.checks['C-UI-01'].steps.length, 1)
  assert.deepEqual(f.calls.slice(0, 6).map(call => call.path ?? call.type),
    ['/api/models', '/api/repository/models', '/api/install', 'actors', 'canary', 'access'])
  const reads = f.calls.filter(call => call.type === 'fetch')
  assert.equal(reads.length, 9)
  for (const read of reads) {
    assert.equal(read.options.redirect, 'error')
    assert.equal(read.options.method ?? 'GET', 'GET')
    assert.equal(read.options.headers.Authorization, 'Bearer unit-install')
    assert.ok(read.options.signal instanceof AbortSignal)
  }
  assert.deepEqual(f.stopped, ['owner', 'ben', 'alice', 'owner', 'ben', 'alice', 'screen'])
  assert.equal(f.captures.length, 6)
  assert.deepEqual(f.captures.slice(0, 3).map(item => item.storageState), [undefined, undefined, undefined])
  assert.deepEqual(f.captures.slice(3).map(item => item.storageState), [{ unit: 'owner' }, { unit: 'ben' }, { unit: 'alice' }])
  assert.ok(f.captures.every(item => item.theme === 'light' && item.origin === origin && item.browserType === f.deps.browserTypes.chromium))
  const events = await f.events()
  assert.ok(events.every(event => event.timestamp === stamp))
  assert.ok(events.every(event => event.evidenceLayer === 'unit'))
  const modelEvents = events.filter(event => event.event === 'models.live')
  assert.equal(modelEvents.length, 3)
  assert.equal(modelEvents[0].digest, createHash('sha256').update(JSON.stringify([f.models, f.models])).digest('hex'))
  assert.ok(events.filter(event => event.event === 'step.verified').every(event => event.layer === 'unit' && event.verifier === 'unit boundary'))
  for (const check of Object.values(summary.checks)) for (const step of check.steps) for (const directory of step.evidence) {
    assert.ok(directory.startsWith(f.root))
    const recordings = JSON.parse(await readFile(join(directory, 'recordings.json'), 'utf8'))
    assert.equal(recordings.evidenceLayer, 'unit')
    assert.equal(recordings.summary, join(f.runDirectory, 'summary.json'))
    assert.match(await readFile(join(directory, 'criteria.md'), 'utf8'), /# C-J2-01 /)
    assert.equal(await readFile(join(directory, 'receipt-0-manual-receipt.json'), 'utf8'), JSON.stringify({ layer: 'unit', observed: true }))
  }
  const multi = summary.checks['C-UI-01'].steps[0].evidence
  for (const directory of multi) assert.match(await readFile(join(directory, 'criteria.md'), 'utf8'), /# C-UI-01 /)
  assert.equal(await readFile(summary.hostRecording, 'utf8'), 'unit screen bytes')
  assert.equal(await readFile(summary.browserRecording, 'utf8'), 'unit screen')
  assert.equal(f.prompts.length, 4)
})

test('injected runs reject absent, shared and escaping unit artifact roots', async t => {
  const f = await fixture(t)
  const alias = join(f.root, 'escape')
  await symlink(ROOT, alias)
  for (const root of [undefined, ROOT, join(ROOT, '.artifacts/journey-unit'), alias]) {
    await assert.rejects(liveRun({ origin, theme: 'light' }, f.schedule, { ...f.deps, root }))
  }
  assert.equal(f.calls.length, 0)
})

test('real-run admission rejects platform, operator, config and actor prerequisites before network', async t => {
  const cases = [
    ['linux', f => { f.deps.runtime.platform = 'linux' }, /Apple Silicon/],
    ['x64', f => { f.deps.runtime.arch = 'x64' }, /Apple Silicon/],
    ['TTY', f => { f.deps.runtime.isTTY = false }, /unassisted operator/],
    ['owner', f => { delete f.env.JOURNEY_OWNER_TOKEN }, /OWNER_TOKEN/],
    ['ben', f => { delete f.env.JOURNEY_BEN_TOKEN }, /BEN_TOKEN/],
    ['alice', f => { delete f.env.JOURNEY_ALICE_TOKEN }, /ALICE_TOKEN/],
    ['repository', f => { f.config.repository = 'smithersai/main' }, /canary/],
    ['origin', f => { f.config.origin = 'https://elsewhere.example' }, /Origin must match/],
    ['browser', f => { f.config.browser = 'firefox' }, /chromium or webkit/],
    ['same machine', f => { f.config.referenceHost = f.config.browserMachine }, /second Mac/],
    ['metadata', f => { delete f.config.quickstart }, /quickstart/],
    ['screen receipt', f => { delete f.config.hostRecording }, /hostRecording/],
    ['scripted config', f => { f.config.models = { model: 'scripted' } }, /Scripted/],
    ['scripted env', f => { f.env.JOURNEY_SCRIPTED = '1' }, /Scripted model environment/],
  ]
  for (const [name, change, pattern] of cases) await t.test(name, async t => {
    const f = await fixture(t)
    change(f)
    await assert.rejects(f.run(), pattern)
    assert.equal(f.calls.length, 0)
    assert.equal(f.captures.length, 0)
  })
})

test('live invocation requires explicit origin and single-theme schedule', async t => {
  const f = await fixture(t)
  for (const options of [{ theme: 'light' }, { origin }]) {
    await assert.rejects(liveRun(options, f.schedule, f.deps), /required|--origin|--theme/)
  }
  f.schedule[0].theme = 'dark'
  await assert.rejects(f.run(), /requested theme/)
  f.schedule[0].theme = 'light'
  f.schedule[0].steps[0].id = '../../../../escaping'
  await assert.rejects(f.run(), /Invalid live step/)
  assert.equal(f.calls.length, 0)
})

test('authoritative scripted model and wrong repository are rejected before GitHub or recorder effects with failure summary', async t => {
  for (const value of [{ model: 'fixture' }, { repository: 'smithers-mvp-canary/2026-10-01' }]) await t.test(JSON.stringify(value), async t => {
    const f = await fixture(t)
    f.deps.fetchImpl = async (url, options) => {
      const path = new URL(url).pathname
      f.calls.push({ type: 'fetch', path, options })
      return new Response(JSON.stringify(value.repository && path === '/api/install' ? value : value.model ? value : f.models))
    }
    await assert.rejects(f.run(), /Scripted|different canary/)
    assert.ok(f.calls.every(call => call.type === 'fetch'))
    assert.equal(f.captures.length, 0)
    const summary = await f.summary()
    assert.equal(summary.status, 'failed')
    assert.equal(summary.checks['C-J2-01'].status, 'not-run')
    assert.match(summary.reason, /Scripted|different canary/)
  })
})

test('model and install read failures remain fail-closed and cannot invoke actors', async t => {
  const cases = [
    ['missing paths', f => { delete f.config.modelConfigPaths }, /modelConfigPaths/],
    ['cross-origin', f => { f.config.modelConfigPaths = ['https://evil.example/api/models'] }, /recorded install origin/],
    ['non-API', f => { f.config.modelConfigPaths = ['/models'] }, /API path/],
    ['query', f => { f.config.modelConfigPaths = ['/api/models?token=x'] }, /API path/],
    ['credentials', f => { f.config.modelConfigPaths = ['https://user:pass@unit-install.example/api/models'] }, /API path/],
    ['missing install token', f => { delete f.env.JOURNEY_INSTALL_TOKEN }, /INSTALL_TOKEN/],
    ['cross-origin install', f => { f.config.installStatePath = 'https://evil.example/api/install' }, /recorded origin/],
    ['model HTTP', f => { f.deps.fetchImpl = async () => new Response('', { status: 503 }) }, /model configuration: HTTP 503/],
    ['install HTTP', f => { f.deps.fetchImpl = async url => new Response(new URL(url).pathname === '/api/install' ? '' : JSON.stringify(f.models), { status: new URL(url).pathname === '/api/install' ? 403 : 200 }) }, /canary repository: HTTP 403/],
    ['absent roles', f => { f.deps.fetchImpl = async () => new Response('{}') }, /configuration is absent/],
    ['network', f => { f.deps.fetchImpl = async () => { throw new Error('read failed') } }, /read failed/],
    ['JSON', f => { f.deps.fetchImpl = async () => new Response('broken') }, /JSON|Unexpected/],
  ]
  for (const [name, change, pattern] of cases) await t.test(name, async t => {
    const f = await fixture(t)
    change(f)
    await assert.rejects(f.run(), pattern)
    assert.equal((await f.summary()).status, 'failed')
    assert.ok(f.calls.every(call => call.type === 'fetch'))
  })
})

test('missing or empty external receipts never pass despite a PASS operator answer', async t => {
  for (const evidence of [undefined, [], ['missing'], ['empty']]) await t.test(String(evidence), async t => {
    const f = await fixture(t)
    if (evidence?.[0] === 'empty') { await writeFile(f.receipt, ''); f.config.evidence['J2.owner'] = [f.receipt] }
    else if (evidence?.[0] === 'missing') f.config.evidence['J2.owner'] = [join(f.root, 'missing')]
    else f.config.evidence['J2.owner'] = evidence
    await assert.rejects(f.run(), /receipt|Missing evidence|ENOENT/)
    const summary = await f.summary()
    assert.equal(summary.checks['C-J2-01'].status, 'unit-fail')
    assert.equal(summary.checks['C-J2-01'].steps[0].status, 'unit-fail')
    assert.deepEqual(f.stopped, ['owner', 'ben', 'alice', 'screen'])
    assert.ok(f.calls.some(call => call.type === 'terminal.close'))
    assert.ok((await f.events()).some(event => event.event === 'step.completed' && event.status === 'unit-fail'))
  })
})

test('operator FAIL and cancellation close every actor and screen recorder and preserve future not-run checks', async t => {
  for (const answer of ['FAIL keyboard focus lost', '', 'CANCEL']) await t.test(answer || 'empty', async t => {
    const f = await fixture(t, [browserStep(), browserStep('J2.next', 'C-J2-02')])
    f.deps.createTerminal = () => ({ question: async prompt => prompt.includes('Type PASS') ? answer : '', close: () => f.calls.push({ type: 'terminal.close' }) })
    await assert.rejects(f.run(), answer ? undefined : /No observed verdict/)
    const summary = await f.summary()
    assert.equal(summary.status, 'failed')
    assert.equal(summary.checks['C-J2-01'].status, 'unit-fail')
    assert.equal(summary.checks['C-J2-02'].status, 'not-run')
    assert.deepEqual(f.stopped, ['owner', 'ben', 'alice', 'screen'])
    assert.equal(await readFile(summary.hostRecording, 'utf8'), 'unit screen bytes')
  })
})

test('partial actor startup and actor shutdown failures still stop every started capture', async t => {
  for (const failure of ['startup', 'stop']) await t.test(failure, async t => {
    const f = await fixture(t)
    f.deps.startBrowserStep = async input => {
      const actor = input.directory.split('/').at(-1)
      if (failure === 'startup' && actor === 'alice') throw new Error('alice startup failed')
      return { stop: async () => { f.stopped.push(actor); if (failure === 'stop' && actor === 'owner') throw new Error('owner cleanup failed'); return { storageState: {} } } }
    }
    await assert.rejects(f.run(), /startup failed|cleanup failed/)
    assert.deepEqual(f.stopped, failure === 'startup' ? ['owner', 'ben', 'screen'] : ['owner', 'ben', 'alice', 'screen'])
    assert.equal((await f.summary()).checks['C-J2-01'].status, 'unit-fail')
  })
})

test('shared-check failure preserves earlier step receipts and writes recordings for failed steps', async t => {
  const f = await fixture(t, [browserStep(), browserStep('J2.next', 'C-J2-01')])
  delete f.config.evidence['J2.next']
  await assert.rejects(f.run(), /external receipts/)
  const summary = await f.summary()
  const check = summary.checks['C-J2-01']
  assert.equal(check.status, 'unit-fail')
  assert.deepEqual(check.steps.map(step => step.status), ['unit-pass', 'unit-fail'])
  assert.deepEqual(check.steps.map(step => step.step), ['J2.owner', 'J2.next'])
  for (const step of check.steps) assert.ok((await readdir(step.evidence[0])).includes('recordings.json'))
})

test('recording failure invalidates completed check and stops both screens even when terminal close also fails', async t => {
  const f = await fixture(t)
  f.config.hostRecorder = { target: 'unit-mini', remotePath: '/unit/screen.mov' }
  delete f.config.hostRecording
  f.deps.startRemoteMacRecording = async ({ path }) => ({ path, stop: async () => { f.stopped.push('host'); throw new Error('host finalization failed') } })
  f.deps.startMacRecording = async ({ path }) => ({ path, stop: async () => { f.stopped.push('screen'); throw new Error('browser finalization failed') } })
  f.deps.createTerminal = () => ({ question: async prompt => prompt.includes('Type PASS') ? 'PASS' : '', close: () => { throw new Error('terminal close failed') } })
  const error = await f.run().then(() => assert.fail('must fail'), error => error)
  assert.ok(error instanceof AggregateError)
  assert.deepEqual(error.errors.map(error => error.message), ['terminal close failed', 'host finalization failed', 'browser finalization failed'])
  assert.deepEqual(f.stopped, ['owner', 'ben', 'alice', 'host', 'screen'])
  const summary = await f.summary()
  assert.equal(summary.status, 'failed')
  assert.equal(summary.checks['C-J2-01'].status, 'unit-fail')
  assert.equal(summary.checks['C-J2-01'].steps[0].status, 'unit-fail')
  assert.deepEqual(summary.errors, error.errors.map(error => error.message))
})

test('both owned screen recordings stop on a failed step and succeed with finalized files', async t => {
  for (const failure of [false, true]) await t.test(String(failure), async t => {
    const f = await fixture(t)
    f.config.hostRecorder = { target: 'unit-mini', remotePath: '/unit/screen.mov' }
    delete f.config.hostRecording
    if (failure) delete f.config.evidence['J2.owner']
    if (failure) await assert.rejects(f.run(), /external receipts/)
    else await f.run()
    assert.deepEqual(f.stopped, ['owner', 'ben', 'alice', 'host', 'screen'])
    const summary = await f.summary()
    assert.equal(await readFile(summary.hostRecording, 'utf8'), 'unit host screen')
    assert.equal(await readFile(summary.browserRecording, 'utf8'), 'unit screen')
  })
})

test('missing reference-host recording invalidates otherwise completed checks', async t => {
  const f = await fixture(t)
  await writeFile(f.config.hostRecording, '')
  await assert.rejects(f.run(), /Run recording/)
  const summary = await f.summary()
  assert.equal(summary.status, 'failed')
  assert.equal(summary.checks['C-J2-01'].status, 'unit-fail')
  assert.ok(summary.errors.some(error => error.includes('screen recording is missing')))
  assert.ok(f.stopped.includes('screen'))
})

test('GitHub admission and screen startup failures always create durable summaries', async t => {
  for (const boundary of ['githubActors', 'ensureCanaryRepository', 'startMacRecording']) await t.test(boundary, async t => {
    const f = await fixture(t)
    f.deps[boundary] = async () => { throw new Error(`${boundary} failed`) }
    await assert.rejects(f.run(), new RegExp(`${boundary} failed`))
    assert.equal((await f.summary()).status, 'failed')
    assert.equal(f.captures.length, 0)
    if (boundary === 'startMacRecording') assert.ok(f.calls.some(call => call.type === 'terminal.close'))
  })
})

test('fresh startup refuses reachable or uncertain hosts, requires J1 and does not bypass model guard after setup', async t => {
  for (const state of ['reachable', 'timeout', 'wrong-journey', 'scripted-after-setup']) await t.test(state, async t => {
    const steps = state === 'wrong-journey' ? [browserStep()] : [browserStep('J1.setup', 'C-J1-02'), browserStep('J1.question', 'C-J1-03')]
    const f = await fixture(t, steps)
    f.config.freshInstall = true
    const originalFetch = f.deps.fetchImpl
    f.deps.fetchImpl = async (url, options) => {
      if (new URL(url).pathname === '/readyz') {
        f.calls.push({ type: 'fetch', path: '/readyz', options })
        if (state === 'reachable') return new Response('', { status: 503 })
        throw state === 'timeout' ? new DOMException('unit timeout', 'TimeoutError') : new Error('connection refused')
      }
      if (state === 'scripted-after-setup') return new Response(JSON.stringify({ model: 'scripted-live' }))
      return originalFetch(url, options)
    }
    await assert.rejects(f.run(), /already responds|timed out|starts with J1|Scripted/)
    const summary = await f.summary()
    assert.equal(summary.status, 'failed')
    if (state === 'scripted-after-setup') {
      assert.equal(summary.checks['C-J1-02'].status, 'unit-fail')
      assert.equal(summary.checks['C-J1-03'].status, 'not-run')
      assert.equal(f.captures.length, 3)
      assert.deepEqual(f.stopped, ['owner', 'ben', 'alice', 'screen'])
    } else assert.equal(f.captures.length, 0)
  })
})

test('fresh setup verifies newly configured live roles before the next step and carries WebKit states', async t => {
  const f = await fixture(t, [browserStep('J1.install', 'C-J1-01'), browserStep('J1.setup', 'C-J1-02'), browserStep('J1.question', 'C-J1-03')])
  f.config.freshInstall = true
  f.config.browser = 'webkit'
  const originalFetch = f.deps.fetchImpl
  f.deps.fetchImpl = async (url, options) => {
    if (new URL(url).pathname === '/readyz') { f.calls.push({ type: 'fresh.probe' }); throw new Error('connection refused') }
    return originalFetch(url, options)
  }
  const summary = await f.run()
  assert.equal(summary.status, 'complete')
  assert.equal(f.calls.filter(call => call.type === 'fetch').length, 9)
  assert.ok(f.prompts.some(prompt => prompt.includes('BEFORE the first model call')))
  assert.equal(f.captures.length, 9)
  assert.ok(f.captures.slice(0, 3).every(item => item.navigate === false))
  assert.ok(f.captures.slice(3).every(item => item.navigate === true))
  assert.ok(f.captures.every(item => item.browserType === f.deps.browserTypes.webkit))
})

test('changing authoritative models blocks the next step before actor windows open', async t => {
  const f = await fixture(t, [browserStep(), browserStep('J2.next', 'C-J2-02')])
  const originalFetch = f.deps.fetchImpl
  let roleReads = 0
  f.deps.fetchImpl = async (url, options) => {
    if (new URL(url).pathname === '/api/models' && ++roleReads === 3) return new Response(JSON.stringify({ model: 'mock' }))
    return originalFetch(url, options)
  }
  await assert.rejects(f.run(), /Scripted/)
  const summary = await f.summary()
  assert.equal(summary.checks['C-J2-01'].status, 'unit-pass')
  assert.equal(summary.checks['C-J2-02'].status, 'unit-fail')
  assert.equal(f.captures.length, 3)
})

test('undeclared actor actions are rejected and declared actions wait for operator permission', async t => {
  for (const allowed of [true, false]) await t.test(String(allowed), async t => {
    const f = await fixture(t, [browserStep('J2.owner', 'C-J2-01', { actorActions: allowed ? ['comment'] : [] })])
    f.config.actions = { 'J2.owner': [{ actor: 'ben', action: 'comment', input: { pr: 1, body: 'unit comment' } }] }
    if (allowed) {
      await f.run()
      assert.deepEqual(f.calls.find(call => call.type === 'comment'), { type: 'comment', actor: 'ben', input: { pr: 1, body: 'unit comment' } })
      assert.ok(f.prompts.some(prompt => prompt.includes('ben.comment')))
    } else {
      await assert.rejects(f.run(), /Undeclared/)
      assert.ok(!f.calls.some(call => call.type === 'comment'))
    }
    assert.deepEqual(f.stopped, ['owner', 'ben', 'alice', 'screen'])
  })
})

test('outside save and restart cancellation cannot invoke the mutating boundary; duplicate launch remains operator driven', async t => {
  for (const operation of ['outside-save', 'restart', 'duplicate-launch']) await t.test(operation, async t => {
    const f = await fixture(t, [browserStep('J2.owner', 'C-J2-01', { operation })])
    if (operation === 'duplicate-launch') {
      await f.run()
      assert.equal(f.calls.filter(call => call.type === 'duplicate').length, 1)
    } else {
      await assert.rejects(f.run(), /cancelled/)
      if (operation === 'restart') assert.ok(!f.calls.some(call => call.type === 'restart'))
      assert.equal((await f.summary()).checks['C-J2-01'].status, 'unit-fail')
    }
    assert.deepEqual(f.stopped, ['owner', 'ben', 'alice', 'screen'])
  })
})

test('confirmed outside saves and backend recovery retain operator ordering and pass only after receipts', async t => {
  for (const operation of ['outside-save', 'restart']) await t.test(operation, async t => {
    const f = await fixture(t, [browserStep('J2.owner', 'C-J2-01', { operation })])
    const ordering = []
    f.deps.createTerminal = () => ({ question: async prompt => {
      ordering.push(prompt)
      if (prompt.includes('Type SAVE')) return 'SAVE'
      if (prompt.includes('Type RESTART')) return 'RESTART'
      return prompt.includes('Type PASS') ? 'PASS' : ''
    }, close() {} })
    f.deps.outsideSave = async input => { await input.beforeSave('unit'); ordering.push('saved') }
    f.deps.restartBackend = async () => ordering.push('restarted')
    const summary = await f.run()
    assert.equal(summary.checks['C-J2-01'].status, 'unit-pass')
    if (operation === 'outside-save') assert.ok(ordering.findIndex(value => value.includes('Type SAVE')) < ordering.indexOf('saved'))
    else {
      assert.ok(ordering.findIndex(value => value.includes('Type RESTART')) < ordering.indexOf('restarted'))
      assert.ok(ordering.indexOf('restarted') < ordering.findIndex(value => value.includes('launchd recovery')))
    }
    assert.ok(ordering.indexOf(operation === 'outside-save' ? 'saved' : 'restarted') < ordering.findIndex(value => value.includes('Type PASS')))
  })
})

test('activation reads GitHub completed canary merge and retains corrected UTC receipt; invalid PRs never pass', async t => {
  for (const state of ['valid', 'missing-PR', 'wrong-repository', 'unmerged']) await t.test(state, async t => {
    const f = await fixture(t, [browserStep('J1.activation', 'C-J1-04')])
    f.config.activation = { pr: 4, t0: '2026-10-03T05:30:00.000Z', clockOffsetStartMs: 1000, clockOffsetEndMs: 0 }
    if (state === 'missing-PR') delete f.config.activation.pr
    const reads = []
    f.deps.githubApi = input => async (method, path) => {
      reads.push({ method, path, token: input.token })
      return { merged: state !== 'unmerged', merged_at: '2026-10-03T06:29:59.000Z', merge_commit_sha: 'b'.repeat(40),
        base: { ref: 'main', repo: { full_name: repository } },
        head: { ref: 'smithers/unit-todo', repo: { full_name: state === 'wrong-repository' ? 'smithersai/main' : repository } } }
    }
    if (state === 'valid') {
      const summary = await f.run()
      assert.equal(summary.checks['C-J1-04'].status, 'unit-pass')
      const path = join(summary.checks['C-J1-04'].steps[0].evidence[0], 'activation.json')
      const receipt = JSON.parse(await readFile(path, 'utf8'))
      assert.equal(receipt.elapsedMs, 60 * 60_000)
      assert.equal(receipt.mergedAt, '2026-10-03T06:29:59.000Z')
      assert.ok((await f.events()).some(event => event.event === 'activation.verified' && event.elapsedMs === receipt.elapsedMs))
    } else {
      await assert.rejects(f.run(), /PR number|canary repository|completed TODO merge/)
      assert.equal((await f.summary()).checks['C-J1-04'].status, 'unit-fail')
    }
    assert.deepEqual(reads, state === 'missing-PR' ? [] : [{ method: 'GET', path: `/repos/${repository}/pulls/4`, token: 'unit-owner' }])
  })
})

test('evidence-only soak step validates the release and 24-hour source before passing, without actor windows', async t => {
  for (const valid of [true, false]) await t.test(String(valid), async t => {
    const f = await fixture(t, [{ id: 'J1.soak', check: 'C-REL-05', kind: 'evidence', procedure: ['Unit external soak boundary'] }])
    const start = Date.parse('2026-10-02T00:00:00.000Z')
    const timestamp = minutes => new Date(start + minutes * 60_000).toISOString()
    const machines = ['unit-mini', 'unit-laptop']
    const receipt = { startedAt: timestamp(0), finishedAt: timestamp(24 * 60), commit: f.config.commit,
      installVersion: valid ? f.config.installVersion : 'wrong-release', machines,
      calls: machines.flatMap(machine => ['claude', 'codex', 'gh'].flatMap(tool => Array.from({ length: 145 }, (_, cycle) => ({
        machine, tool, cycle, timestamp: timestamp(cycle * 10), exitCode: 0, loginPrompt: false,
      })))),
      wakes: [24, 48, 72, 96, 120, 144].map(cycle => ({ machine: machines[1], cycle,
        sleptAt: timestamp(cycle * 10 - 1), wokeAt: timestamp(cycle * 10), firstCallSucceeded: true })),
      credentialChanges: [{ machine: machines[0], receivedMachine: machines[1], written_at: timestamp(5), receivedAt: timestamp(6) }],
    }
    f.config.credentialSoak = join(f.root, 'soak.json')
    await writeFile(f.config.credentialSoak, JSON.stringify(receipt))
    if (valid) {
      const summary = await f.run()
      assert.equal(summary.checks['C-REL-05'].status, 'unit-pass')
      const path = join(summary.checks['C-REL-05'].steps[0].evidence[0], 'credential-soak.json')
      assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), receipt)
      const verified = (await f.events()).find(event => event.event === 'soak.verified')
      assert.equal(verified.calls, 870)
      assert.equal(verified.evidenceLayer, 'unit')
    } else {
      await assert.rejects(f.run(), /recorded install release/)
      assert.equal((await f.summary()).checks['C-REL-05'].status, 'unit-fail')
    }
    assert.equal(f.captures.length, 0)
    assert.equal(f.prompts.length, 0)
  })
})

test('browser screen startup failure stops an already started remote screen', async t => {
  const f = await fixture(t)
  f.config.hostRecorder = { target: 'unit-mini', remotePath: '/unit/screen.mov' }
  delete f.config.hostRecording
  f.deps.startMacRecording = async () => { throw new Error('browser screen launch failed') }
  await assert.rejects(f.run(), /browser screen launch failed/)
  assert.deepEqual(f.stopped, ['host'])
  assert.equal((await f.summary()).status, 'failed')
})

test('CLI help and dry planning expose no executed checks, and live dispatch rejects missing origin', async t => {
  const output = []
  t.mock.method(process.stdout, 'write', text => { output.push(String(text)); return true })
  await main(['--help'])
  assert.match(output.join(''), /run\.mjs.*--dry-run/)
  assert.doesNotMatch(output.join(''), /PLANNED ONLY|Evidence:/)
  output.length = 0
  await main(['--dry-run', '--theme', 'dark', '--journey', 'J10'])
  assert.match(output.join(''), /PLANNED ONLY — 1 journey\/theme runs/)
  assert.match(output.join(''), /J10 dark/)
  assert.doesNotMatch(output.join(''), /J10 light|Evidence:/)
  output.length = 0
  await assert.rejects(main(), /--origin/)
  assert.equal(output.length, 0)
})

test('CLI process returns successful help and failed argument or live-admission errors without credentials', async t => {
  const f = await fixture(t)
  for (const [args, status, pattern] of [
    [['--help'], 0, /--dry-run/],
    [['--theme', 'sepia'], 1, /Theme must be light or dark/],
    [['--theme', 'light'], 1, /--origin/],
  ]) {
    const result = spawnSync(process.execPath, [join(ROOT, 'scripts/journeys/run.mjs'), ...args], {
      cwd: f.root, env: { PATH: process.env.PATH,
        ...(process.env.NODE_V8_COVERAGE ? { NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE } : {}) },
      encoding: 'utf8', timeout: 20_000,
    })
    assert.ifError(result.error)
    assert.equal(result.status, status, result.stderr)
    assert.match(status === 0 ? result.stdout : result.stderr, pattern)
    assert.equal(status === 0 ? result.stderr : result.stdout, '')
  }
  assert.equal(f.calls.length, 0)
  assert.deepEqual((await readdir(f.root)).sort(), ['host.mov', 'manual-receipt.json'])
})

test('evidence-only campaign closes the default terminal without awaiting operator input', async t => {
  const f = await fixture(t, [{ id: 'J2.receipt', check: 'C-J2-01', kind: 'evidence', procedure: ['Unit receipt boundary'] }])
  delete f.deps.createTerminal
  const readers = process.stdin.listenerCount('data')
  const summary = await f.run()
  assert.equal(summary.status, 'complete')
  assert.equal(summary.evidenceLayer, 'unit')
  assert.equal(summary.checks['C-J2-01'].status, 'unit-pass')
  assert.equal(process.stdin.listenerCount('data'), readers)
  assert.equal(f.captures.length, 0)
  assert.equal(f.prompts.length, 0)
  assert.deepEqual(f.stopped, ['screen'])
})

test('credential soak rejects a final call past finish even within its allowed one-minute cadence', () => {
  const receipt = { startedAt: '2026-10-02T00:00:00.000Z', finishedAt: '2026-10-03T00:00:00.000Z',
    machines: ['unit-mini', 'unit-laptop'], wakes: [], credentialChanges: [],
    calls: [{ machine: 'unit-mini', tool: 'codex', cycle: 144, exitCode: 0, loginPrompt: false,
      timestamp: '2026-10-03T00:00:00.001Z' }] }
  assert.throws(() => verifyCredentialSoak(receipt), /missed its 10 minute schedule/)
  receipt.calls[0].timestamp = receipt.finishedAt
  assert.throws(() => verifyCredentialSoak(receipt), /missing tool call/)
})

test('a partly executed shared check cannot pass when an intervening failure prevents its remaining step', async t => {
  const f = await fixture(t, [browserStep('J2.first', 'C-J2-01'), browserStep('J2.failed', 'C-J2-02'), browserStep('J2.last', 'C-J2-01')])
  delete f.config.evidence['J2.failed']
  await assert.rejects(f.run(), /external receipts/)
  const summary = await f.summary()
  assert.equal(summary.status, 'failed')
  assert.equal(summary.checks['C-J2-01'].status, 'unit-incomplete')
  assert.deepEqual(summary.checks['C-J2-01'].steps.map(step => [step.step, step.status]), [['J2.first', 'unit-pass']])
  assert.equal(summary.checks['C-J2-02'].status, 'unit-fail')
  assert.equal(f.captures.length, 6)
  assert.ok(f.captures.every(capture => !capture.directory.includes('J2.last')))
})

test('default UTC clock and output retain unit receipts and disclose the actual artifact path', async t => {
  const f = await fixture(t)
  delete f.deps.now
  delete f.deps.output
  const output = []
  t.mock.method(process.stdout, 'write', text => { output.push(String(text)); return true })
  const before = Date.now()
  const summary = await f.run()
  const after = Date.now()
  assert.equal(summary.evidenceLayer, 'unit')
  for (const time of [summary.timestamp, summary.finishedAt]) {
    assert.match(time, /Z$/)
    assert.ok(Date.parse(time) >= before && Date.parse(time) <= after)
  }
  const directory = join(f.root, '.artifacts/checks/C-J2-01', summary.timestamp, 'light/run')
  assert.ok(output.some(text => text === `Evidence: ${directory}/summary.json\n`))
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'summary.json'), 'utf8')), summary)
})

test('default Playwright dependency boundary either supplies the installed engine or reports its absence and cleans up', async t => {
  const f = await fixture(t)
  delete f.deps.browserTypes
  const result = await f.run().then(summary => ({ summary }), error => ({ error }))
  const summary = await f.summary()
  assert.equal(summary.evidenceLayer, 'unit')
  if (result.error) {
    assert.equal(result.error.code, 'ERR_MODULE_NOT_FOUND')
    assert.match(result.error.message, /playwright/)
    assert.equal(summary.status, 'failed')
    assert.equal(summary.checks['C-J2-01'].status, 'not-run')
    assert.equal(f.captures.length, 0)
  } else {
    assert.equal(summary.status, 'complete')
    assert.equal(f.captures.length, 3)
    assert.ok(f.captures.every(capture => typeof capture.browserType.launch === 'function'))
  }
  assert.equal(f.calls.filter(call => call.type === 'terminal.close').length, 1)
  assert.equal(f.stopped.filter(actor => actor === 'screen').length, 1)
})

test('origin and option admission reject credentials, paths, queries, fragments and duplicate or incomplete flags', () => {
  for (const value of ['ftp://example.com', 'https://user@example.com', 'https://:pass@example.com',
    'https://example.com/?query=x', 'https://example.com/#fragment', 'https://example.com/path']) {
    assert.throws(() => publicOrigin(value), /Origin must be/)
  }
  assert.equal(publicOrigin('https://EXAMPLE.com:443/'), 'https://example.com')
  assert.deepEqual(parseArgs(['--origin', 'https://EXAMPLE.com:443/', '--theme', 'light']), {
    dryRun: false, origin: 'https://example.com', theme: 'light',
  })
  for (const args of [['--theme', '--dry-run'], ['--origin'], ['--dry-run', '--dry-run']]) assert.throws(() => parseArgs(args), /Missing value|Duplicate option/)
  const text = formatSchedule(buildSchedule({ journey: 'J2', theme: 'light' }), { acceptanceIds: ['C-J2-01'], checkIds: ['C-J2-01'] }, 'https://example.com')
  assert.match(text, /Origin: https:\/\/example.com/)
  assert.match(text, /No journey checks executed; no pass\/fail evidence created/)
})

test('ticket acceptance admission rejects absent, empty, reversed, oversized and mixed-family ranges', () => {
  for (const [source, error] of [
    ['# No acceptance', /no Acceptance section/],
    ['## Acceptance\nNo named checks\n', /names no checks/],
    ['## Acceptance\nC-J1-01 to C-J2-02\n', /crosses check families/],
    ['## Acceptance\nC-J1-05 to C-J1-01\n', /Invalid Acceptance range/],
    ['## Acceptance\nC-J1-01 to C-J1-99\n', /Invalid Acceptance range/],
  ]) assert.throws(() => acceptanceChecks(source), error)
  assert.deepEqual(acceptanceChecks('## Acceptance\nC-J1-01 to 03\n## Later\nC-J2-01\n'), ['C-J1-01', 'C-J1-02', 'C-J1-03'])
})

test('definition admission rejects malformed journey identities, steps, kinds and procedures', async () => {
  for (const [change, reason] of [
    [definitions => { definitions[0].id = 'J9' }, /journey definition/],
    [definitions => { definitions.push(structuredClone(definitions[0])) }, /journey definition/],
    [definitions => { delete definitions[0].steps }, /Missing steps/],
    [definitions => { definitions[0].steps = [] }, /Missing steps/],
    [definitions => { delete definitions[0].steps[0].id }, /step ID/],
    [definitions => { definitions[0].steps[1].id = definitions[0].steps[0].id }, /step ID/],
    [definitions => { definitions[0].steps[0].kind = 'invented' }, /Incomplete step/],
    [definitions => { delete definitions[0].steps[0].procedure }, /Incomplete step/],
    [definitions => { definitions[0].steps[0].procedure = [] }, /Incomplete step/],
    [definitions => { definitions[0].steps[0].procedure = [false] }, /Incomplete step/],
    [definitions => { definitions[0].steps[0].procedure = ['  '] }, /Incomplete step/],
    [definitions => { definitions[0].steps[0].check = 'unknown' }, /Invalid check ID/],
  ]) {
    const definitions = structuredClone(journeys)
    change(definitions)
    await assert.rejects(validateDefinitions({ definitions }), reason)
  }
})

test('definition evidence must identify its check and include every verification heading', async t => {
  const f = await fixture(t)
  const specs = join(f.root, '.specs/engineering')
  await mkdir(join(specs, 'checks'), { recursive: true })
  await mkdir(join(specs, 'tickets'), { recursive: true })
  await writeFile(join(specs, 'tickets/T-REL-02.md'), '## Acceptance\nC-J2-01\n')
  const definitions = [{ id: 'J2', steps: [{ id: 'J2.unit', kind: 'evidence', check: 'C-J2-01', procedure: ['Observe the receipt'] }] }]
  const headings = ['Setup', 'Steps', 'Pass when', 'Fail when', 'Evidence']
  const source = (title, omit) => `# ${title} Unit check\n${headings.filter(heading => heading !== omit).map(heading => `## ${heading}\nUnit criteria\n`).join('')}`
  const check = join(specs, 'checks/C-J2-01.md')
  await writeFile(check, source('C-J2-02'))
  await assert.rejects(validateDefinitions({ root: f.root, definitions }), /identity mismatch/)
  for (const heading of headings) {
    await writeFile(check, source('C-J2-01', heading))
    await assert.rejects(validateDefinitions({ root: f.root, definitions }), new RegExp(`lacks ${heading}`))
  }
  await writeFile(check, source('C-J2-01'))
  assert.deepEqual(await validateDefinitions({ root: f.root, definitions }), { acceptanceIds: ['C-J2-01'], checkIds: ['C-J2-01'] })
})

test('activation requires a named canary TODO head in the authoritative completed merge receipt', () => {
  const input = { t0: '2026-10-02T00:00:00.000Z', clockOffsetStartMs: 0, clockOffsetEndMs: 0 }
  const pull = { merged: true, merged_at: '2026-10-02T00:30:00.000Z', merge_commit_sha: 'a'.repeat(40), base: { ref: 'main' } }
  assert.throws(() => verifyActivation(input, pull), /completed TODO merge receipt/)
  assert.throws(() => verifyActivation(input, { ...pull, head: {} }), /completed TODO merge receipt/)
  assert.equal(verifyActivation(input, { ...pull, head: { ref: 'smithers/unit-todo' } }).elapsedMs, 30 * 60_000)
})

test('direct live admission rejects unsupported theme and invalid check identity before network or recording', async t => {
  const f = await fixture(t)
  await assert.rejects(liveRun({ origin, theme: 'sepia' }, f.schedule, f.deps), /Theme must be light or dark/)
  f.schedule[0].steps[0].check = '../escape'
  await assert.rejects(f.run(), /Invalid live step or check identity/)
  assert.equal(f.calls.length, 0)
  assert.deepEqual(f.stopped, [])
})

test('operator abort and actor cleanup errors preserve both causes while screen cleanup still runs', async t => {
  const f = await fixture(t)
  const aborted = new DOMException('operator disconnected', 'AbortError')
  f.deps.createTerminal = () => ({ question: async () => { throw aborted }, close: () => f.calls.push({ type: 'terminal.close' }) })
  f.deps.startBrowserStep = async input => {
    const actor = input.directory.split('/').at(-1)
    return { stop: async () => {
      f.stopped.push(actor)
      if (actor === 'owner') throw new Error('owner video finalization failed')
      return { storageState: {} }
    } }
  }
  const error = await f.run().then(() => assert.fail('must fail'), error => error)
  assert.ok(error instanceof AggregateError)
  assert.equal(error.cause, aborted)
  assert.equal(error.errors[0], aborted)
  assert.equal(error.errors[1].message, 'owner video finalization failed')
  assert.deepEqual(f.stopped, ['owner', 'ben', 'alice', 'screen'])
  const summary = await f.summary()
  assert.equal(summary.status, 'failed')
  assert.equal(summary.checks['C-J2-01'].status, 'unit-fail')
  assert.deepEqual(summary.errors, ['operator disconnected', 'owner video finalization failed'])
})
