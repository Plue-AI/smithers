import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, rm, copyFile, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs, buildSchedule, validateDefinitions, assertLiveModels, createStepLog, verifyInstallRepository } from './run.mjs'
import { CANARY_OWNER, canaryName, assertCanaryRepository, ensureCanaryRepository } from './canary-repo.mjs'
import { journeys } from './steps/index.mjs'
import { githubActors } from './github-actors.mjs'
import { OUTSIDE_SAVE_SCRIPT, outsideVersions, outsideSave, sshTarget } from './outside-save.mjs'
import { keyboardOnly, startMacRecording, startRemoteMacRecording, startBrowserStep } from './record.mjs'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { verifyActivation, verifyCredentialSoak } from './evidence.mjs'
import { runInNewContext } from 'node:vm'
import { command, childEnvironment } from './lib.mjs'
import { githubApi } from './github-api.mjs'
import { restartBackend, duplicateLaunch } from './faults.mjs'
import './run-live.test.mjs'
import './record-coverage.test.mjs'
import './safety-coverage.test.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const journeyIds = ['J1', 'J2', 'J3', 'J4', 'J5', 'J6', 'J7', 'J8', 'J10', 'J11']
const range = (journey, numbers) => numbers.map(number => `C-${journey}-${String(number).padStart(2, '0')}`)
// Independent expansion of T-REL-02 Acceptance. J3-07, J9 and J11-04 are outside this ticket.
const acceptedChecks = [
  ...range('J1', [1, 2, 3, 4, 5, 6]), ...range('J2', [1, 2, 3, 4, 5]),
  ...range('J3', [1, 2, 3, 4, 5, 6, 8, 9, 10]), ...range('J4', [1, 2, 3]),
  ...range('J5', [1, 2, 3]), ...range('J6', [1, 2]), ...range('J7', [1, 2, 3]),
  ...range('J8', [1, 2, 3, 4, 5, 6]), ...range('J10', [1, 2, 3, 4, 5, 6, 7, 8, 9]),
  ...range('J11', [1, 2, 3, 4]), 'C-UI-01', 'C-REL-05',
].sort()

async function temporaryDirectory(t) {
  const parent = join(root, '.artifacts', 'journey-unit')
  await mkdir(parent, { recursive: true })
  const directory = await mkdtemp(join(parent, 'test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

test('canary name uses the UTC date, including timezone and year boundaries', () => {
  assert.equal(CANARY_OWNER, 'smithers-mvp-canary')
  assert.equal(canaryName(new Date('2026-10-02T23:30:00-07:00')), '2026-10-03')
  assert.equal(canaryName(new Date('2027-01-01T00:30:00+01:00')), '2026-12-31')
  assert.equal(canaryName(new Date('2026-02-03T00:00:00Z')), '2026-02-03')
  assert.throws(() => canaryName(new Date('invalid')))
})

test('repository admission accepts only the canary owner and a dated repository', () => {
  assert.deepEqual(assertCanaryRepository('smithers-mvp-canary/2026-10-02'), {
    owner: CANARY_OWNER, name: '2026-10-02',
  })
  for (const repository of ['smithersai/2026-10-02', 'smithers-mvp-canary/template',
    'smithers-mvp-canary/../main', 'smithers-mvp-canary/2026-10-02/extra',
    'https://github.com/smithers-mvp-canary/2026-10-02', '', 'smithers-mvp-canary/2026-02-30']) {
    assert.throws(() => assertCanaryRepository(repository), undefined, repository)
  }
})

function githubResponse(status, value) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

function canaryRepository(repository = 'smithers-mvp-canary/2026-10-02') {
  return { full_name: repository, name: repository.split('/')[1],
    owner: { login: CANARY_OWNER }, template_repository: { full_name: `${CANARY_OWNER}/template` },
    default_branch: 'main', allow_squash_merge: true }
}

// Fake HTTP below proves isolated helper boundaries only. It is never live journey evidence.
test('existing canary lookup is idempotent and does not issue a GitHub write', async () => {
  const calls = []
  const existing = canaryRepository()
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options })
    return githubResponse(200, existing)
  }
  const options = { repository: existing.full_name, token: 'unit-only', fetchImpl }
  const first = await ensureCanaryRepository(options)
  const second = await ensureCanaryRepository(options)
  assert.deepEqual(first, second)
  assert.equal(calls.length, 2)
  for (const call of calls) {
    assert.equal(call.options.method ?? 'GET', 'GET')
    assert.equal(new URL(call.url).pathname, '/repos/smithers-mvp-canary/2026-10-02')
  }
})

test('missing canary is generated from the sole approved template', async () => {
  const calls = []
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options })
    return calls.length === 1 ? githubResponse(404, { message: 'Not Found' }) :
      githubResponse(calls.length === 2 ? 201 : 200, canaryRepository())
  }
  await ensureCanaryRepository({ repository: canaryRepository().full_name, token: 'unit-only', fetchImpl })
  assert.equal(calls.length, 3)
  assert.equal(calls[1].options.method, 'POST')
  assert.equal(new URL(calls[1].url).pathname, '/repos/smithers-mvp-canary/template/generate')
  const body = JSON.parse(calls[1].options.body)
  assert.equal(body.owner, CANARY_OWNER)
  assert.equal(body.name, '2026-10-02')
  assert.equal(body.private, true)
  assert.equal(body.include_all_branches, false)
  assert.equal(calls[2].options.method ?? 'GET', 'GET')
  assert.equal(new URL(calls[2].url).pathname, '/repos/smithers-mvp-canary/2026-10-02')
})

test('concurrent creation reconciles the winning canary and verifies its provenance', async () => {
  for (const repository of [canaryRepository(), { ...canaryRepository(), template_repository: undefined }]) {
    const methods = []
    const result = ensureCanaryRepository({ repository: canaryRepository().full_name, token: 'unit-only',
      fetchImpl: async (url, options = {}) => {
        methods.push(options.method ?? 'GET')
        if (methods.length === 1) return githubResponse(404, { message: 'Not Found' })
        if (methods.length === 2) return githubResponse(422, { message: 'Already exists' })
        return githubResponse(200, repository)
      } })
    if (repository.template_repository) assert.deepEqual(await result, repository)
    else await assert.rejects(result, /template|provenance/i)
    assert.deepEqual(methods, ['GET', 'POST', 'GET'])
  }
})

test('wrong owner is rejected before any network request', async () => {
  let calls = 0
  await assert.rejects(ensureCanaryRepository({ repository: 'smithersai/main', token: 'unit-only',
    fetchImpl: async () => {
      calls++
      throw new Error('network must not run')
    } }), /canary|owner|repository/i)
  assert.equal(calls, 0)
})

test('existing repositories need exact approved template provenance', async () => {
  for (const existing of [
    { ...canaryRepository(), template_repository: undefined },
    { ...canaryRepository(), template_repository: { full_name: 'smithersai/template' } },
    { ...canaryRepository(), full_name: 'smithersai/2026-10-02' },
    { ...canaryRepository(), owner: { login: 'smithersai' } },
    { ...canaryRepository(), default_branch: 'develop' },
    { ...canaryRepository(), allow_squash_merge: false },
  ]) {
    let calls = 0
    await assert.rejects(ensureCanaryRepository({ repository: canaryRepository().full_name, token: 'unit-only',
      fetchImpl: async () => {
        calls++
        return githubResponse(200, existing)
      } }), /template|provenance|canary|repository/i)
    assert.equal(calls, 1)
  }
})

test('lookup errors cannot be mistaken for a missing repository and create one', async () => {
  for (const status of [401, 403, 429, 500]) {
    let calls = 0
    await assert.rejects(ensureCanaryRepository({ repository: canaryRepository().full_name, token: 'unit-only',
      fetchImpl: async () => {
        calls++
        return githubResponse(status, { message: 'unit failure' })
      } }))
    assert.equal(calls, 1)
  }
})

test('GitHub API rejects paths outside the canary and path traversal before fetching', async () => {
  let calls = 0
  const api = githubApi({ token: 'unit-only', fetchImpl: async () => { calls++ } })
  for (const path of ['/repos/smithersai/main', '/repos/smithers-mvp-canary/../main',
    '/repos/smithers-mvp-canary/2026-10-02/%2e%2e/main', '/repos/smithers-mvp-canary/2026-10-02/%2fmain',
    'https://github.com/user', '/repos/smithers-mvp-canary/2026-10-02/%5cmain']) {
    await assert.rejects(api('GET', path), /outside the canary/i)
  }
  assert.equal(calls, 0)
  assert.throws(() => githubApi({ token: '', fetchImpl: async () => { calls++ } }), /token/)
})

test('GitHub API uses redirects disabled and keeps transport secrets out of errors and logs', async () => {
  const entries = []
  let options
  const api = githubApi({ token: 'unit-sensitive-token', log: async entry => { entries.push(entry) },
    fetchImpl: async (url, settings) => {
      options = settings
      throw new Error('transport leaked unit-sensitive-token')
    } })
  await assert.rejects(api('GET', '/user'), error => {
    assert.match(error.message, /transport failed/)
    assert.doesNotMatch(error.message, /unit-sensitive-token/)
    return true
  })
  assert.equal(options.redirect, 'error')
  assert.ok(options.signal instanceof AbortSignal)
  assert.deepEqual(entries.map(entry => entry.event), ['github.request', 'github.failure'])
  assert.doesNotMatch(JSON.stringify(entries), /unit-sensitive-token|Authorization/)
  const noContent = githubApi({ token: 'unit-only', fetchImpl: async () => new Response(null, { status: 204 }) })
  assert.equal(await noContent('GET', '/user'), null)
})

test('GitHub API redacts invalid-JSON failures and retains safe request and response receipts', async () => {
  const entries = []
  const api = githubApi({ token: 'unit-only', log: async entry => { entries.push(entry) },
    fetchImpl: async () => ({ ok: true, status: 200, headers: new Headers(),
      json: async () => { throw new SyntaxError('Unexpected unit-sensitive-server-key in JSON') } }) })
  await assert.rejects(api('GET', '/user'), error => {
    assert.match(error.message, /HTTP 200; invalid JSON response/)
    assert.doesNotMatch(error.message, /unit-sensitive-server-key/)
    return true
  })
  assert.deepEqual(entries.map(entry => entry.event), ['github.request', 'github.response', 'github.failure'])
  assert.equal(entries.at(-1).reason, 'invalid-json')
  assert.doesNotMatch(JSON.stringify(entries), /unit-sensitive-server-key/)
})

test('child environments keep location settings while removing all credential categories', () => {
  assert.deepEqual(childEnvironment({ HOME: '/unit/home', PATH: '/unit/bin', SMITHERS_SESSION_ID: 'unit-session',
    JOURNEY_OWNER_TOKEN: 'unit-secret', OPENAI_API_KEY: 'unit-secret', PASSWORD: 'unit-secret',
    AUTH_SECRET: 'unit-secret', PRIVATE_KEY: 'unit-secret' }), {
    HOME: '/unit/home', PATH: '/unit/bin', SMITHERS_SESSION_ID: 'unit-session',
  })
})

test('command uses literal argv and stdin, collects output, and rejects failures and timeouts', async () => {
  const input = 'literal $(must-not-execute)\n'
  const result = await command(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], { input })
  assert.deepEqual(result, { stdout: input, stderr: '', code: 0 })
  const output = await command(process.execPath, ['-e', "process.stdout.write('out');process.stderr.write('err')"])
  assert.equal(output.stdout, 'out')
  assert.equal(output.stderr, 'err')
  await assert.rejects(command(process.execPath, ['-e', 'process.exit(7)']), /exited 7/)
  await assert.rejects(command(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeout: 20 }), /timed out/)
  await assert.rejects(command(join(root, 'scripts/journeys/nonexistent-unit-command'), []), /ENOENT/)
})

test('backend restart verifies exact process identity before sending SIGKILL and records only a request', async () => {
  const calls = []
  const events = []
  await restartBackend({ target: 'owner@mac-mini', pid: 123, executable: '/opt/smithers/backend',
    execImpl: async (file, argv) => {
      calls.push({ file, argv })
      return { stdout: '/opt/smithers/backend\n' }
    }, log: async event => { events.push(event) } })
  assert.equal(calls.length, 2)
  assert.ok(calls.every(call => call.file === 'ssh' && call.argv.includes('BatchMode=yes')))
  assert.equal(calls[0].argv.at(-1), 'ps -p 123 -o comm=')
  assert.equal(calls[1].argv.at(-1), 'kill -9 123')
  assert.deepEqual(events.map(event => event.event), ['restart.kill', 'restart.requested'])
  assert.equal(events[0].signal, 'SIGKILL')
})

test('backend restart rejects unsafe targets, PIDs and executable paths before SSH', async () => {
  let calls = 0
  const options = { target: 'owner@mac-mini', pid: 123, executable: '/opt/smithers/backend',
    execImpl: async () => { calls++ } }
  for (const overrides of [{ target: '-oBad' }, { pid: 1 }, { pid: 0 }, { pid: 1.5 },
    { pid: '123' }, { executable: '/opt/other/program' }, { executable: 'backend' },
    { executable: '/opt/backend && another' }]) {
    await assert.rejects(restartBackend({ ...options, ...overrides }))
  }
  assert.equal(calls, 0)
})

test('backend restart refuses a changed PID and does not retry failed inspection or kill', async () => {
  for (const failure of ['identity', 'inspection', 'kill']) {
    const calls = []
    const events = []
    await assert.rejects(restartBackend({ target: 'owner@mac-mini', pid: 123, executable: '/opt/smithers/backend',
      execImpl: async (file, argv) => {
        calls.push(argv.at(-1))
        if (failure === 'inspection' || failure === 'kill' && calls.length === 2) throw new Error('unit SSH failure')
        return { stdout: failure === 'identity' ? '/opt/another/backend\n' : '/opt/smithers/backend\n' }
      }, log: async event => { events.push(event.event) } }))
    assert.equal(calls.length, failure === 'kill' ? 2 : 1)
    assert.equal(events.includes('restart.requested'), false)
  }
})

test('duplicate launch repeats the same payload and key and returns the original durable result', async () => {
  const calls = []
  const events = []
  const result = await duplicateLaunch({ origin: 'https://factory.example', path: '/api/todos',
    payload: { prompt: 'Canary TODO' }, key: 'unit-idempotency-key', token: 'unit-install-token',
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options })
      return githubResponse(200, { id: 'todo-unit', status: 'requested' })
    }, log: async event => { events.push(event) } })
  assert.deepEqual(result, { id: 'todo-unit', status: 'requested' })
  assert.equal(calls.length, 2)
  assert.equal(calls[0].url, 'https://factory.example/api/todos')
  for (const call of calls) {
    assert.equal(call.options.method, 'POST')
    assert.equal(call.options.redirect, 'error')
    assert.equal(call.options.headers['Idempotency-Key'], 'unit-idempotency-key')
    assert.deepEqual(JSON.parse(call.options.body), { prompt: 'Canary TODO' })
  }
  assert.equal(events.at(-1).event, 'duplicate.reconciled')
  assert.equal(events.at(-1).id, 'todo-unit')
})

test('duplicate launch rejects external endpoints and absent credentials before network', async () => {
  let calls = 0
  const options = { origin: 'https://factory.example', path: '/api/todos', payload: {},
    key: 'unit-key', token: 'unit-token', fetchImpl: async () => { calls++ } }
  for (const overrides of [{ path: 'https://other.example/api/todos' }, { path: '//other.example/api/todos' },
    { path: '/outside' }, { path: '/api/todos?secret=x' }, { path: '/api/todos#fragment' },
    { token: '' }, { key: '' }]) {
    await assert.rejects(duplicateLaunch({ ...options, ...overrides }))
  }
  assert.equal(calls, 0)
})

test('duplicate launch fails on forged results or missing durable identity and never retries transport or HTTP errors', async () => {
  for (const response of ['mismatch', 'missing-id', 'transport', 'http']) {
    let calls = 0
    await assert.rejects(duplicateLaunch({ origin: 'https://factory.example', path: '/api/todos',
      payload: {}, key: 'unit-key', token: 'unit-token', fetchImpl: async () => {
        calls++
        if (response === 'transport') throw new Error('unit transport failure')
        if (response === 'http') return githubResponse(503, { error: 'unavailable' })
        if (response === 'missing-id') return githubResponse(200, { status: 'requested' })
        return githubResponse(200, { id: calls === 1 ? 'original' : 'forged' })
      } }))
    assert.equal(calls, ['transport', 'http'].includes(response) ? 1 : 2)
  }
})

test('default schedule covers each required journey exactly once per theme', () => {
  const schedule = buildSchedule()
  assert.equal(schedule.length, 20)
  assert.deepEqual(schedule.map(item => `${item.journey}:${item.theme}`).sort(),
    journeyIds.flatMap(id => [`${id}:light`, `${id}:dark`]).sort())
  assert.equal(schedule.some(item => item.journey === 'J9'), false)
  for (const item of schedule) assert.ok(item.steps.length > 0, item.journey)
})

test('theme and journey filters preserve coverage without duplicates', () => {
  for (const theme of ['light', 'dark']) {
    const schedule = buildSchedule({ theme })
    assert.deepEqual(schedule.map(item => item.journey), journeyIds)
    assert.ok(schedule.every(item => item.theme === theme))
    for (const journey of journeyIds) {
      const filtered = buildSchedule({ theme, journey })
      assert.equal(filtered.length, 1)
      assert.equal(filtered[0].journey, journey)
      assert.equal(filtered[0].theme, theme)
    }
  }
  for (const journey of journeyIds) {
    assert.deepEqual(buildSchedule({ journey }).map(item => item.theme).sort(), ['dark', 'light'])
  }
  assert.throws(() => buildSchedule({ theme: 'sepia' }))
  assert.throws(() => buildSchedule({ journey: 'J9' }))
})

test('CLI validates filters and rejects unknown or incomplete arguments', () => {
  const options = parseArgs(['--dry-run', '--theme', 'dark', '--journey', 'J10'])
  assert.equal(options.theme, 'dark')
  assert.equal(options.journey, 'J10')
  assert.equal(options.dryRun, true)
  for (const argv of [['--theme'], ['--journey'], ['--theme', 'sepia'], ['--journey', 'J9'], ['--unknown']]) {
    assert.throws(() => parseArgs(argv), undefined, JSON.stringify(argv))
  }
})

test('definitions cover the ticket acceptance exactly and resolve real check files', async () => {
  const { checkIds, acceptanceIds } = await validateDefinitions({ root })
  assert.deepEqual([...checkIds].sort(), [...acceptedChecks, 'C-REL-02'].sort())
  assert.deepEqual([...acceptanceIds].sort(), acceptedChecks)
})

test('definitions fail when an accepted check loses its step or names a nonexistent check', async () => {
  const missing = structuredClone(journeys)
  missing[0].steps = missing[0].steps.filter(step => step.check !== 'C-J1-01')
  await assert.rejects(validateDefinitions({ root, definitions: missing }), /C-J1-01|coverage|acceptance|missing/i)
  const stale = structuredClone(journeys)
  const step = stale.flatMap(journey => journey.steps).find(item => item.check === 'C-J1-01')
  step.check = 'C-J1-99'
  await assert.rejects(validateDefinitions({ root, definitions: stale }), /C-J1-99|coverage|check|missing/i)
})

test('definitions fail when an acceptance check file is absent', async t => {
  const directory = await temporaryDirectory(t)
  const specs = join(directory, '.specs', 'engineering')
  await mkdir(join(specs, 'checks'), { recursive: true })
  await mkdir(join(specs, 'tickets'), { recursive: true })
  await copyFile(join(root, '.specs/engineering/tickets/T-REL-02.md'), join(specs, 'tickets/T-REL-02.md'))
  await Promise.all([...acceptedChecks, 'C-REL-02'].filter(id => id !== 'C-J1-01').map(id =>
    copyFile(join(root, '.specs/engineering/checks', `${id}.md`), join(specs, 'checks', `${id}.md`))))
  await assert.rejects(validateDefinitions({ root: directory }), /C-J1-01|missing|ENOENT|not found/i)
})

const actorEnvironment = {
  JOURNEY_OWNER_TOKEN: 'owner', JOURNEY_BEN_TOKEN: 'ben', JOURNEY_ALICE_TOKEN: 'alice',
}
const headSha = 'a'.repeat(40)
const treeSha = 'b'.repeat(40)
const blobSha = 'c'.repeat(40)
const nextSha = 'd'.repeat(40)

function actorHttp({ users = {}, permissions = {}, respond } = {}) {
  const calls = []
  const fetchImpl = async (url, options = {}) => {
    const actor = options.headers.Authorization.replace('Bearer ', '')
    const path = new URL(url).pathname
    const method = options.method ?? 'GET'
    const body = options.body ? JSON.parse(options.body) : undefined
    calls.push({ actor, path, method, body })
    if (path === '/user') return githubResponse(200, users[actor] ?? {
      id: ['owner', 'ben', 'alice'].indexOf(actor) + 1, login: actor, type: 'User',
    })
    if (path.endsWith('/permission')) return githubResponse(200, {
      permission: permissions[actor] ?? (actor === 'owner' ? 'admin' : actor === 'ben' ? 'maintain' : 'write'),
    })
    assert.ok(respond, `unexpected HTTP ${method} ${path}`)
    return respond({ actor, path, method, body })
  }
  return { calls, fetchImpl }
}

async function makeActors(http, env = actorEnvironment) {
  return githubActors({ repository: canaryRepository().full_name, env, fetchImpl: http.fetchImpl })
}

test('actors require three distinct personal accounts and appropriate repository access', async () => {
  const http = actorHttp()
  const actors = await makeActors(http)
  assert.deepEqual(actors.identities, {
    owner: { id: 1, login: 'owner' }, ben: { id: 2, login: 'ben' }, alice: { id: 3, login: 'alice' },
  })
  assert.deepEqual(http.calls.map(call => call.actor), ['owner', 'ben', 'alice', 'owner', 'ben', 'alice'])
  for (const options of [
    { users: { ben: { id: 1, login: 'someone', type: 'User' } } },
    { users: { ben: { id: 2, login: 'OWNER', type: 'User' } } },
    { users: { owner: { id: 1, login: 'owner', type: 'Bot' } } },
    { users: { owner: { id: 0, login: 'owner', type: 'User' } } },
    { users: { owner: { id: 1, login: 'owner/path', type: 'User' } } },
    { permissions: { owner: 'write' } }, { permissions: { ben: 'read' } }, { permissions: { alice: 'triage' } },
  ]) await assert.rejects(makeActors(actorHttp(options)), /distinct|personal|access/i)
  await assert.rejects(makeActors(actorHttp(), { ...actorEnvironment, JOURNEY_BEN_LOGIN: 'wrong-user' }), /different login/i)
})

test('actor identities can be admitted before repository creation while writes wait for access verification', async () => {
  const http = actorHttp()
  const actors = await githubActors({ repository: canaryRepository().full_name, env: actorEnvironment,
    fetchImpl: http.fetchImpl, verifyAccess: false })
  assert.deepEqual(http.calls.map(call => call.path), ['/user', '/user', '/user'])
  await assert.rejects(actors.mergePr('owner', { pr: 1, expectedHead: headSha }), /not been verified/i)
  assert.equal(http.calls.length, 3)
  await actors.verifyAccess()
  assert.equal(http.calls.length, 6)
  assert.ok(http.calls.slice(3).every(call => call.path.endsWith('/permission')))
})

test('actor setup rejects a noncanary repository before checking credentials or contacting GitHub', async () => {
  const http = actorHttp()
  await assert.rejects(githubActors({ repository: 'smithersai/main', env: {}, fetchImpl: http.fetchImpl }), /canary/i)
  assert.equal(http.calls.length, 0)
  await assert.rejects(makeActors(http, {}), /JOURNEY_OWNER_TOKEN/)
  assert.equal(http.calls.length, 0)
})

test('actor pushes reject unsafe branches, paths and stale expected heads without writing', async () => {
  const http = actorHttp({ respond: () => githubResponse(200, { object: { sha: headSha } }) })
  const actors = await makeActors(http)
  const input = { branch: 'smithers/todo', path: 'src/main.ts', content: 'new text', message: 'Canary change', expectedHead: headSha }
  for (const overrides of [{ branch: 'main' }, { path: '../outside' }, { path: '/absolute' },
    { path: 'src//file' }, { content: '' }, { message: '' }]) {
    const before = http.calls.length
    await assert.rejects(actors.pushTodo('ben', { ...input, ...overrides }))
    assert.equal(http.calls.length, before)
  }
  await assert.rejects(actors.pushTodo('unknown', input), /actor/i)
  await assert.rejects(actors.pushTodo('ben', { ...input, expectedHead: nextSha }), /moved/i)
  assert.equal(http.calls.at(-1).method, 'GET')
  assert.ok(http.calls.every(call => call.method === 'GET'))
})

test('actor pushes preserve the original parent and update refs only by fast-forward', async () => {
  const http = actorHttp({ respond: ({ path, method }) => {
    if (path.includes('/git/ref/')) return githubResponse(200, { object: { sha: headSha } })
    if (method === 'GET' && path.endsWith(`/git/commits/${headSha}`)) return githubResponse(200, { tree: { sha: treeSha } })
    if (path.endsWith('/git/blobs')) return githubResponse(201, { sha: blobSha })
    if (path.endsWith('/git/trees')) return githubResponse(201, { sha: treeSha })
    if (path.endsWith('/git/commits')) return githubResponse(201, { sha: nextSha })
    if (method === 'PATCH') return githubResponse(200, { object: { sha: nextSha } })
    assert.fail(`unexpected ${method} ${path}`)
  } })
  const actors = await makeActors(http)
  const result = await actors.pushTodo('ben', {
    branch: 'smithers/todo', path: 'src/main.ts', content: 'new text', message: 'Canary change', expectedHead: headSha,
  })
  assert.equal(result.sha, nextSha)
  const writes = http.calls.filter(call => call.method !== 'GET')
  assert.deepEqual(writes.map(call => call.method), ['POST', 'POST', 'POST', 'PATCH'])
  assert.ok(writes.every(call => call.actor === 'ben'))
  assert.deepEqual(writes[1].body.tree, [{ path: 'src/main.ts', mode: '100644', type: 'blob', sha: blobSha }])
  assert.deepEqual(writes[2].body.parents, [headSha])
  assert.deepEqual(writes[3].body, { sha: nextSha, force: false })
})

function canaryPull(overrides = {}) {
  return { head: { ref: 'smithers/todo', sha: headSha, repo: { full_name: canaryRepository().full_name } },
    base: { ref: 'main', repo: { full_name: canaryRepository().full_name } }, ...overrides }
}

test('review and merge actions reject stale or outside-repository PRs before writing', async () => {
  for (const pull of [canaryPull(), canaryPull({ head: { ...canaryPull().head, repo: { full_name: 'outside/fork' } } }),
    canaryPull({ base: { ...canaryPull().base, ref: 'develop' } })]) {
    const http = actorHttp({ respond: () => githubResponse(200, pull) })
    const actors = await makeActors(http)
    await assert.rejects(actors.reviewComment('ben', {
      pr: 1, commitSha: nextSha, path: 'src/main.ts', line: 1, body: 'Review comment',
    }), /stale|canary|main/i)
    await assert.rejects(actors.mergePr('owner', { pr: 1, expectedHead: nextSha }), /stale|canary|main/i)
    assert.ok(http.calls.every(call => call.method === 'GET'))
  }
})

test('actor merge requires the expected head, squash mode and a real completion response', async () => {
  for (const merged of [true, false]) {
    const http = actorHttp({ respond: ({ method }) => githubResponse(200, method === 'GET' ? canaryPull() : { merged }) })
    const actors = await makeActors(http)
    const result = actors.mergePr('owner', { pr: 1, expectedHead: headSha })
    if (merged) assert.equal((await result).merged, true)
    else await assert.rejects(result, /completed merge/i)
    const write = http.calls.at(-1)
    assert.equal(write.method, 'PUT')
    assert.deepEqual(write.body, { sha: headSha, merge_method: 'squash' })
  }
})

test('actor review comments target the current PR head and exact selected line', async () => {
  const http = actorHttp({ respond: ({ method }) => githubResponse(200, method === 'GET' ? canaryPull() : { id: 'review-unit' }) })
  const actors = await makeActors(http)
  const result = await actors.reviewComment('ben', { pr: 3, commitSha: headSha, path: 'src/main.ts', line: 4, body: 'Please fix this' })
  assert.equal(result.id, 'review-unit')
  const write = http.calls.at(-1)
  assert.equal(write.actor, 'ben')
  assert.equal(write.path, '/repos/smithers-mvp-canary/2026-10-02/pulls/3/comments')
  assert.equal(write.method, 'POST')
  assert.deepEqual(write.body, { body: 'Please fix this', commit_id: headSha, path: 'src/main.ts', line: 4, side: 'RIGHT' })
  const before = http.calls.filter(call => call.method !== 'GET').length
  await assert.rejects(actors.reviewComment('ben', { pr: 3, commitSha: headSha, path: '../outside', line: 4, body: 'comment' }))
  await assert.rejects(actors.reviewComment('ben', { pr: 3, commitSha: headSha, path: 'src/main.ts', line: 0, body: 'comment' }))
  assert.equal(http.calls.filter(call => call.method !== 'GET').length, before)
})

test('actor PR close and reopen preserve the same PR and cannot alter a merged one', async () => {
  for (const merged of [true, false]) {
    const http = actorHttp({ respond: ({ method, body }) => githubResponse(200,
      method === 'GET' ? canaryPull({ merged }) : { state: body.state }) })
    const actors = await makeActors(http)
    const before = http.calls.length
    await assert.rejects(actors.setPrState('ben', { pr: 1, state: 'deleted' }))
    assert.equal(http.calls.length, before)
    for (const state of ['closed', 'open']) {
      const result = actors.setPrState('ben', { pr: 1, state })
      if (merged) await assert.rejects(result, /merged PR/)
      else {
        assert.deepEqual(await result, { state })
        assert.equal(http.calls.at(-1).method, 'PATCH')
        assert.deepEqual(http.calls.at(-1).body, { state })
      }
    }
    if (merged) assert.ok(http.calls.every(call => call.method === 'GET'))
  }
})

test('unrelated actor merge uses its own branch and squash PR without updating main directly', async () => {
  const http = actorHttp({ respond: ({ path, method }) => {
    if (path.includes('/git/ref/')) return githubResponse(200, { object: { sha: headSha } })
    if (method === 'GET' && path.endsWith(`/git/commits/${headSha}`)) return githubResponse(200, { tree: { sha: treeSha } })
    if (path.endsWith('/git/refs')) return githubResponse(201, {})
    if (path.endsWith('/git/blobs')) return githubResponse(201, { sha: blobSha })
    if (path.endsWith('/git/trees')) return githubResponse(201, { sha: treeSha })
    if (path.endsWith('/git/commits')) return githubResponse(201, { sha: nextSha })
    if (path.endsWith('/git/refs/heads/journey/unrelated')) return githubResponse(200, {})
    if (path.endsWith('/pulls')) return githubResponse(201, { number: 7 })
    if (path.endsWith('/pulls/7')) return githubResponse(200, canaryPull({ head: { ...canaryPull().head, ref: 'journey/unrelated', sha: nextSha } }))
    if (path.endsWith('/pulls/7/merge')) return githubResponse(200, { merged: true, sha: nextSha })
    assert.fail(`unexpected ${method} ${path}`)
  } })
  const actors = await makeActors(http)
  const before = http.calls.length
  for (const overrides of [{ branch: 'smithers/todo' }, { content: '' }, { message: '' }]) {
    await assert.rejects(actors.unrelatedMerge('ben', { branch: 'journey/unrelated', content: 'canary', message: 'Canary change', ...overrides }))
    assert.equal(http.calls.length, before)
  }
  const result = await actors.unrelatedMerge('ben', { branch: 'journey/unrelated', content: 'canary', message: 'Canary change' })
  assert.deepEqual(result, { pr: 7, merged: true, sha: nextSha })
  const writes = http.calls.filter(call => call.method !== 'GET')
  assert.deepEqual(writes[0].body, { ref: 'refs/heads/journey/unrelated', sha: headSha })
  assert.deepEqual(writes.at(-1).body, { sha: nextSha, merge_method: 'squash' })
  assert.ok(writes.every(call => !call.path.endsWith('/heads/main')))
})

test('outside versions change distinct requested lines and preserve final newline behavior', () => {
  const edits = { untouchedLine: 1, typedLine: 3, untouchedText: 'outside safe', typedText: 'outside overlap' }
  assert.deepEqual(outsideVersions('one\ntwo\nthree', edits), {
    untouched: 'outside safe\ntwo\nthree', overlap: 'outside safe\ntwo\noutside overlap',
  })
  assert.deepEqual(outsideVersions('one\ntwo\nthree\n', edits), {
    untouched: 'outside safe\ntwo\nthree\n', overlap: 'outside safe\ntwo\noutside overlap\n',
  })
  for (const overrides of [{ untouchedLine: 0 }, { typedLine: 4 }, { typedLine: 1 },
    { typedLine: 1.5 }, { typedText: 'two\nlines' }, { untouchedText: 'two\rlines' }]) {
    assert.throws(() => outsideVersions('one\ntwo\nthree', { ...edits, ...overrides }))
  }
})

test('SSH targets reject shell options, commands and unsafe separators', () => {
  assert.equal(sshTarget('owner@mac-mini.example'), 'owner@mac-mini.example')
  for (const target of ['-oProxyCommand=evil', 'owner@host$(bad)', 'host && bad', 'host/other', 'host\nother', '']) {
    assert.throws(() => sshTarget(target), undefined, target)
  }
})

test('outside save sends content on stdin and gates each write on live typing', async () => {
  const order = []
  const requests = []
  const digest = content => createHash('sha256').update(content).digest('hex')
  const receipts = await outsideSave({ target: 'owner@mac-mini', root: '/repo', path: 'src/file.ts',
    untouchedLine: 1, typedLine: 2, untouchedText: 'safe $(must remain text)', typedText: 'overlap',
    beforeSave: async kind => { order.push(`ready:${kind}`) },
    execImpl: async (command, argv, options) => {
      assert.equal(command, 'ssh')
      assert.ok(argv.includes('BatchMode=yes'))
      assert.equal(argv.at(-2), 'owner@mac-mini')
      const payload = JSON.parse(options.input)
      requests.push({ argv, payload })
      order.push(payload.action)
      const content = payload.action === 'read' ? 'one\ntwo\n' : payload.content
      return { stdout: JSON.stringify({ content, digest: digest(content) }) }
    } })
  assert.deepEqual(order, ['read', 'ready:untouched', 'write', 'ready:overlap', 'write'])
  assert.equal(receipts.length, 2)
  assert.deepEqual(receipts.map(receipt => receipt.kind), ['untouched', 'overlap'])
  assert.ok(requests.every(request => request.argv.at(-1) === requests[0].argv.at(-1)))
  assert.doesNotMatch(requests[0].argv.at(-1), /must remain text/)
  assert.equal(requests[1].payload.content, 'safe $(must remain text)\ntwo\n')
  assert.equal(requests[2].payload.content, 'safe $(must remain text)\noverlap\n')
})

test('outside-save Python replacement preserves file owner, group, mode and exact text', async t => {
  const directory = await temporaryDirectory(t)
  const file = join(directory, 'group-preserved.txt')
  // A real local process exercises the production remote program without SSH or release evidence.
  const setup = spawnSync('python3', ['-c', `
import json,os,pathlib,sys
file=pathlib.Path(sys.argv[1])
file.write_text('previous text',encoding='utf-8')
default_group=os.getegid()
groups=os.getgroups()
group=next((candidate for candidate in groups if candidate!=default_group),default_group)
os.chown(file,os.geteuid(),group)
os.chmod(file,0o640)
print(json.dumps({'group':group,'defaultGroup':default_group,'hasAlternateGroup':group!=default_group}))
`, file], { encoding: 'utf8', env: childEnvironment(), timeout: 20_000 })
  assert.ifError(setup.error)
  assert.equal(setup.status, 0, setup.stderr)
  const metadata = JSON.parse(setup.stdout)
  const before = await stat(file)
  assert.equal(before.gid, metadata.group)
  if (metadata.hasAlternateGroup) assert.notEqual(before.gid, metadata.defaultGroup)
  const text = 'Outside edit: café and λ\nLiteral $(never executed)\n'
  const result = spawnSync('python3', ['-c', OUTSIDE_SAVE_SCRIPT], {
    input: JSON.stringify({ root: directory, path: 'group-preserved.txt', action: 'write', content: text }),
    encoding: 'utf8', env: childEnvironment(), timeout: 20_000,
  })
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr)
  const after = await stat(file)
  assert.equal(after.uid, before.uid)
  assert.equal(after.gid, before.gid)
  assert.equal(after.mode & 0o777, 0o640)
  assert.equal(await readFile(file, 'utf8'), text)
  assert.deepEqual(JSON.parse(result.stdout), { content: text,
    digest: createHash('sha256').update(text).digest('hex') })
})

test('outside save rejects unsafe paths and missing synchronization before SSH', async () => {
  let calls = 0
  const options = { target: 'owner@mac-mini', root: '/repo', path: 'src/file.ts',
    beforeSave: async () => {}, execImpl: async () => { calls++ } }
  for (const overrides of [{ target: '-oBad' }, { root: 'relative' }, { path: '../outside' }, { beforeSave: undefined }]) {
    await assert.rejects(outsideSave({ ...options, ...overrides }))
  }
  assert.equal(calls, 0)
})

test('cancelled typing synchronization prevents the outside write', async () => {
  const requests = []
  await assert.rejects(outsideSave({ target: 'owner@mac-mini', root: '/repo', path: 'src/file.ts',
    untouchedLine: 1, typedLine: 2, untouchedText: 'safe', typedText: 'overlap',
    beforeSave: async () => { throw new Error('typing cancelled') },
    execImpl: async (command, argv, options) => {
      requests.push(JSON.parse(options.input).action)
      return { stdout: JSON.stringify({ content: 'one\ntwo', digest: 'base' }) }
    } }), /typing cancelled/)
  assert.deepEqual(requests, ['read'])
})

test('keyboard-only guard rejects pointer APIs through nested locators at the app origin', () => {
  const actions = []
  let location = 'https://factory.example/home'
  const locator = {
    click: () => actions.push('click'), fill: () => actions.push('fill'),
    press: key => actions.push(key), nth() { return this },
  }
  const page = { url: () => location, locator: () => locator,
    keyboard: { press: key => actions.push(key) },
    mouse: { click: () => actions.push('mouse') }, click: () => actions.push('page-click') }
  const guarded = keyboardOnly(page, 'https://factory.example')
  assert.throws(() => guarded.click(), /Keyboard-only/)
  assert.throws(() => guarded.mouse.click(), /Keyboard-only/)
  assert.throws(() => guarded.locator('button').nth(0).click(), /Keyboard-only/)
  assert.throws(() => guarded.locator('input').fill('text'), /Keyboard-only/)
  guarded.locator('button').press('Enter')
  guarded.keyboard.press('Tab')
  assert.deepEqual(actions, ['Enter', 'Tab'])
  location = 'https://github.com/login'
  guarded.locator('button').click()
  assert.deepEqual(actions, ['Enter', 'Tab', 'click'])
})

function recordingChild({ error, code = 0, signal } = {}) {
  const child = new EventEmitter()
  child.pid = 123
  child.stderr = new PassThrough()
  child.kills = []
  child.kill = terminationSignal => {
    child.kills.push(terminationSignal)
    process.nextTick(() => child.emit('close', code, signal))
    return true
  }
  process.nextTick(() => child.emit(error ? 'error' : 'spawn', error))
  return child
}

test('Mac recording stops and verifies finalized footage before reporting completion', async t => {
  const directory = await temporaryDirectory(t)
  const path = join(directory, 'screen.mov')
  await writeFile(path, 'unit footage')
  let child
  const events = []
  let spawned
  const recording = await startMacRecording({ path, platform: 'darwin',
    spawnImpl: (file, argv, options) => {
      spawned = { file, argv, options }
      child = recordingChild()
      return child
    },
    log: async event => { events.push(event.event) } })
  assert.equal(spawned.file, '/usr/sbin/screencapture')
  assert.deepEqual(spawned.argv, ['-v', '-x', path])
  assert.equal(spawned.options.shell, false)
  assert.equal(await recording.stop(), path)
  assert.deepEqual(child.kills, ['SIGINT'])
  assert.deepEqual(events, ['recording.start', 'recording.stop'])
})

test('Mac recording refuses unsupported platforms and failed spawn or empty output', async t => {
  const directory = await temporaryDirectory(t)
  let calls = 0
  await assert.rejects(startMacRecording({ path: join(directory, 'screen.mov'), platform: 'linux',
    spawnImpl: () => { calls++ } }), /macOS/)
  assert.equal(calls, 0)
  await assert.rejects(startMacRecording({ path: join(directory, 'screen.mov'), platform: 'darwin',
    spawnImpl: () => recordingChild({ error: new Error('spawn failed') }) }), /spawn failed/)
  const path = join(directory, 'empty.mov')
  await writeFile(path, '')
  const recording = await startMacRecording({ path, platform: 'darwin', spawnImpl: () => recordingChild() })
  await assert.rejects(recording.stop(), /finalize/)
})

test('Mac recording accepts finalized SIGINT footage and rejects SIGKILL footage', async t => {
  const directory = await temporaryDirectory(t)
  for (const signal of ['SIGINT', 'SIGKILL']) {
    const path = join(directory, `${signal}.mov`)
    await writeFile(path, 'unit footage')
    const recording = await startMacRecording({ path, platform: 'darwin',
      spawnImpl: () => recordingChild({ code: null, signal }) })
    if (signal === 'SIGINT') assert.equal(await recording.stop(), path)
    else await assert.rejects(recording.stop(), /did not finalize/)
  }
})

test('Mac recording stops its child if the startup receipt cannot be written', async t => {
  const directory = await temporaryDirectory(t)
  let child
  await assert.rejects(startMacRecording({ path: join(directory, 'screen.mov'), platform: 'darwin',
    spawnImpl: () => {
      child = recordingChild()
      return child
    },
    log: async () => { throw new Error('receipt disk full') } }), /receipt disk full/)
  assert.deepEqual(child.kills, ['SIGINT'])
})

function remoteRecorderChild({ ready = true, code = 0, closeOnStop = true } = {}) {
  const child = new EventEmitter()
  child.pid = 321
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.inputs = []
  child.kills = []
  child.stdin.on('data', chunk => {
    const input = chunk.toString()
    child.inputs.push(input)
    if (input === 'STOP\n' && closeOnStop) process.nextTick(() => child.emit('close', code))
    else if (input.startsWith('{') && ready) process.nextTick(() => {
      child.stdout.write('REA')
      child.stdout.write('DY\n')
    })
  })
  child.kill = signal => {
    child.kills.push(signal)
    process.nextTick(() => child.emit('close', 1))
    return true
  }
  return child
}

test('remote recording uses constant SSH control, waits for READY, finalizes, and copies footage once', async t => {
  const directory = await temporaryDirectory(t)
  const path = join(directory, 'remote.mov')
  let child
  let spawned
  const copies = []
  const events = []
  const recorder = await startRemoteMacRecording({ target: 'owner@mac-mini', remotePath: '/tmp/unit-recording.mov', path,
    spawnImpl: (file, argv, options) => {
      spawned = { file, argv, options }
      child = remoteRecorderChild()
      return child
    }, execImpl: async (file, argv) => {
      copies.push({ file, argv })
      await writeFile(path, 'unit remote footage')
    }, log: async event => { events.push(event.event) } })
  assert.equal(spawned.file, 'ssh')
  assert.equal(spawned.options.shell, false)
  assert.ok(spawned.argv.includes('BatchMode=yes'))
  assert.doesNotMatch(spawned.argv.at(-1), /unit-recording/)
  assert.deepEqual(JSON.parse(child.inputs[0]), { path: '/tmp/unit-recording.mov' })
  assert.deepEqual(events, ['recording.remote.start'])
  assert.equal(await recorder.stop(), path)
  assert.equal(await recorder.stop(), path)
  assert.deepEqual(child.inputs.slice(1), ['STOP\n'])
  assert.equal(copies.length, 1)
  assert.equal(copies[0].file, 'scp')
  assert.deepEqual(copies[0].argv.slice(-2), ['owner@mac-mini:/tmp/unit-recording.mov', path])
  assert.deepEqual(events, ['recording.remote.start', 'recording.remote.stop'])
})

test('remote recording rejects unsafe paths, targets and timeouts before spawning', async t => {
  const directory = await temporaryDirectory(t)
  let calls = 0
  const options = { target: 'owner@mac-mini', remotePath: '/tmp/unit.mov', path: join(directory, 'remote.mov'),
    spawnImpl: () => { calls++ } }
  for (const overrides of [{ target: '-oBad' }, { remotePath: 'relative.mov' }, { remotePath: '/tmp/../unit.mov' },
    { remotePath: '/tmp/unit.mov$(bad)' }, { remotePath: '/tmp/unit.mov\n' }, { path: '' },
    { startupTimeoutMs: 0 }, { stopTimeoutMs: Infinity }]) {
    await assert.rejects(startRemoteMacRecording({ ...options, ...overrides }))
  }
  assert.equal(calls, 0)
})

test('remote recording cleans up if READY or the startup log fails and never copies an unfinalized recording', async t => {
  const directory = await temporaryDirectory(t)
  for (const failure of ['ready', 'log', 'exit']) {
    let child
    let copies = 0
    const options = { target: 'owner@mac-mini', remotePath: '/tmp/unit.mov', path: join(directory, `${failure}.mov`),
      startupTimeoutMs: 20, stopTimeoutMs: 100,
      spawnImpl: () => {
        child = remoteRecorderChild({ ready: failure !== 'ready', code: failure === 'exit' ? 1 : 0 })
        return child
      }, execImpl: async () => { copies++ },
      log: async () => { if (failure === 'log') throw new Error('remote start log failed') } }
    if (failure === 'exit') {
      const recorder = await startRemoteMacRecording(options)
      await assert.rejects(recorder.stop(), /SSH did not finalize/)
    } else await assert.rejects(startRemoteMacRecording(options), /READY timed out|remote start log failed/)
    assert.deepEqual(child.inputs.slice(1), ['STOP\n'])
    assert.equal(copies, 0)
  }
})

test('remote recording stop is bounded and rejects missing, empty or failed copied evidence', async t => {
  const directory = await temporaryDirectory(t)
  for (const failure of ['stop-timeout', 'empty', 'copy']) {
    let child
    const path = join(directory, `${failure}.mov`)
    const recorder = await startRemoteMacRecording({ target: 'owner@mac-mini', remotePath: '/tmp/unit.mov', path,
      stopTimeoutMs: 20, spawnImpl: () => {
        child = remoteRecorderChild({ closeOnStop: failure !== 'stop-timeout' })
        return child
      }, execImpl: async () => {
        if (failure === 'copy') throw new Error('unit scp failed')
        await writeFile(path, '')
      } })
    await assert.rejects(recorder.stop(), /did not stop|empty footage|unit scp failed/)
    if (failure === 'stop-timeout') assert.ok(child.kills.includes('SIGTERM'))
  }
})

test('browser cleanup closes the browser even if closing its context fails', async t => {
  const directory = await temporaryDirectory(t)
  let browserClosed = false
  const context = {
    tracing: { start: async () => { throw new Error('trace failed') } },
    close: async () => { throw new Error('context close failed') },
  }
  const browser = { newContext: async () => context, close: async () => { browserClosed = true } }
  await assert.rejects(startBrowserStep({ browserType: { launch: async () => browser },
    directory, origin: 'https://factory.example', theme: 'dark' }), AggregateError)
  assert.equal(browserClosed, true)
})

test('browser recording closes the context and browser after initialization fails', async t => {
  const directory = await temporaryDirectory(t)
  const order = []
  const context = {
    tracing: { start: async () => {
      order.push('trace.start')
      throw new Error('trace failed')
    } },
    close: async () => { order.push('context.close') },
  }
  const browser = { newContext: async () => context, close: async () => { order.push('browser.close') } }
  await assert.rejects(startBrowserStep({ browserType: { launch: async () => browser },
    directory, origin: 'https://factory.example', theme: 'dark' }), /trace failed/)
  assert.deepEqual(order, ['trace.start', 'context.close', 'browser.close'])
})

test('browser keyboard instrumentation requires a visible outline in the --ring-border color', async t => {
  const directory = await temporaryDirectory(t)
  let instrument
  const context = {
    tracing: { start: async () => {} }, exposeBinding: async () => {},
    addInitScript: async script => { instrument = script },
    newPage: async () => { throw new Error('instrumentation captured') }, close: async () => {},
  }
  const browser = { newContext: async () => context, close: async () => {} }
  await assert.rejects(startBrowserStep({ browserType: { launch: async () => browser },
    directory, origin: 'https://factory.example', theme: 'light' }), /instrumentation captured/)
  for (const { color, token, focused, passes } of [
    { color: 'rgb(255, 0, 0)', token: '#ff0000', focused: true, passes: true },
    { color: 'rgb(0, 0, 255)', token: '#ff0000', focused: true, passes: false },
    { color: 'rgb(255, 0, 0)', token: '', focused: true, passes: false },
    { color: 'rgb(255, 0, 0)', token: '#ff0000', focused: false, passes: false },
  ]) {
    const handlers = {}
    const inputs = []
    const element = { tagName: 'BUTTON', matches: () => focused }
    const style = { outlineStyle: 'solid', outlineWidth: '2px', outlineColor: color,
      outline: `2px solid ${color}`, getPropertyValue: () => token }
    const document = { activeElement: element, body: { append: () => {} },
      createElement: () => ({ style: {}, remove: () => {} }) }
    runInNewContext(`(${instrument.toString()})({expectedOrigin: 'https://factory.example'})`, {
      location: { origin: 'https://factory.example' }, document,
      addEventListener: (type, handler) => { handlers[type] = handler },
      requestAnimationFrame: handler => handler(),
      getComputedStyle: target => target === element ? style : { color: 'rgb(255, 0, 0)' },
      window: { journeyInput: input => { inputs.push(input) } },
    })
    handlers.keydown({ key: 'Tab' })
    assert.equal(inputs.length, 1)
    assert.equal(inputs[0].kind, 'keyboard')
    assert.equal(inputs[0].violation, passes ? null : 'Focus or visible ring lost')
  }
})

test('browser step finalizes trace and video, returns state in memory, and preserves input failures', async t => {
  for (const { violation, captureFailure } of [
    { violation: null, captureFailure: false }, { violation: 'Pointer input: click', captureFailure: false },
    { violation: null, captureFailure: true },
  ]) {
    const directory = await temporaryDirectory(t)
    const video = join(directory, 'video.webm')
    await writeFile(video, 'unit video')
    const order = []
    const state = { cookies: [{ name: 'session', value: 'unit-only' }] }
    let binding
    let contextOptions
    const page = {
      url: () => 'https://factory.example/home',
      goto: async origin => { order.push(`goto:${origin}`) },
      screenshot: async ({ path }) => {
        order.push('screenshot')
        await writeFile(path, 'unit screenshot')
      },
      video: () => ({ path: async () => video }),
    }
    const context = {
      tracing: {
        start: async () => { order.push('trace.start') },
        stop: async ({ path }) => {
          order.push('trace.stop')
          await writeFile(path, 'unit trace')
        },
      },
      exposeBinding: async (name, handler) => {
        assert.equal(name, 'journeyInput')
        binding = handler
      },
      addInitScript: async (script, options) => { assert.equal(options.expectedOrigin, 'https://factory.example') },
      newPage: async () => page,
      storageState: async () => state,
      close: async () => { order.push('context.close') },
    }
    const browser = {
      newContext: async options => {
        contextOptions = options
        return context
      },
      close: async () => { order.push('browser.close') },
    }
    const recorder = await startBrowserStep({ browserType: { launch: async options => {
      assert.equal(options.headless, false)
      return browser
    } }, directory, origin: 'https://factory.example', theme: 'dark', storageState: state, navigate: !violation,
    log: async event => { if (captureFailure && event.event === 'keyboard.input') throw new Error('input receipt failed') } })
    assert.equal(order.includes('goto:https://factory.example'), !violation)
    assert.equal(contextOptions.colorScheme, 'dark')
    assert.deepEqual(contextOptions.storageState, state)
    assert.deepEqual(contextOptions.recordVideo, { dir: directory })
    if (violation) await binding({ page }, { origin: 'https://factory.example', kind: 'pointer', violation })
    if (captureFailure) await assert.rejects(binding({ page }, {
      origin: 'https://factory.example', kind: 'keyboard', key: 'Tab',
    }), /input receipt failed/)
    const stopped = recorder.stop()
    if (violation) await assert.rejects(stopped, /Keyboard-only check failed/)
    else if (captureFailure) await assert.rejects(stopped, /input receipt failed/)
    else {
      assert.deepEqual(await stopped, { storageState: state, trace: join(directory, 'trace.zip'), video })
      assert.equal(await readFile(join(directory, 'trace.zip'), 'utf8'), 'unit trace')
      assert.equal(await readFile(join(directory, 'final.png'), 'utf8'), 'unit screenshot')
    }
    assert.deepEqual(order.slice(-4), ['screenshot', 'trace.stop', 'context.close', 'browser.close'])
  }
})

test('step logs append one UTC JSON object per event without losing order', async t => {
  const directory = await temporaryDirectory(t)
  const log = await createStepLog(directory, { now: () => new Date('2026-10-02T23:30:00-07:00') })
  const first = await log({ event: 'started', journey: 'J1', theme: 'light', detail: 'line one\nline two' })
  const second = await log({ event: 'completed', check: 'C-J1-01' })
  const source = await readFile(join(directory, 'steps.jsonl'), 'utf8')
  assert.ok(source.endsWith('\n'))
  const lines = source.trimEnd().split('\n')
  assert.equal(lines.length, 2)
  assert.deepEqual(lines.map(JSON.parse), [first, second])
  assert.equal(first.timestamp, '2026-10-03T06:30:00.000Z')
  assert.equal(first.detail, 'line one\nline two')
  assert.equal(first.event, 'started')
  assert.equal(second.event, 'completed')
})

test('an event cannot forge the step log timestamp', async t => {
  const directory = await temporaryDirectory(t)
  const log = await createStepLog(directory, { now: () => new Date('2026-10-02T00:00:00Z') })
  const entry = await log({ event: 'started', timestamp: 'forged' })
  assert.equal(entry.timestamp, '2026-10-02T00:00:00.000Z')
})

test('step logs serialize concurrent writes and redact credentials from nested fields and strings', async t => {
  const directory = await temporaryDirectory(t)
  const previous = process.env.JOURNEY_UNIT_TOKEN
  process.env.JOURNEY_UNIT_TOKEN = 'unit-sensitive-token-value'
  t.after(() => {
    if (previous === undefined) delete process.env.JOURNEY_UNIT_TOKEN
    else process.env.JOURNEY_UNIT_TOKEN = previous
  })
  const log = await createStepLog(directory)
  assert.throws(() => log({ event: '' }), /event name/)
  assert.throws(() => log(null), /event name/)
  const results = await Promise.all(Array.from({ length: 10 }, (_, index) => log({ event: `step.${index}`,
    details: { authorization: 'Bearer another-sensitive-value', nested: [{ cookie: 'sensitive-cookie' }] },
    message: `Request used ${process.env.JOURNEY_UNIT_TOKEN}` })))
  const source = await readFile(join(directory, 'steps.jsonl'), 'utf8')
  assert.deepEqual(source.trimEnd().split('\n').map(JSON.parse), results)
  assert.deepEqual(results.map(entry => entry.event), Array.from({ length: 10 }, (_, index) => `step.${index}`))
  assert.doesNotMatch(source, /unit-sensitive-token-value|another-sensitive-value|sensitive-cookie/)
  assert.equal(results[0].details.authorization, '[redacted]')
  assert.equal(results[0].details.nested[0].cookie, '[redacted]')
  assert.equal(results[0].message, 'Request used [redacted]')
})

test('install repository admission recognizes supported shapes and fails closed on wrong or missing identity', () => {
  const expected = canaryRepository().full_name
  for (const repository of [expected, { full_name: expected }, { fullName: expected },
    { owner: CANARY_OWNER, name: '2026-10-02' }, { owner: { login: CANARY_OWNER }, name: '2026-10-02' }]) {
    assert.equal(verifyInstallRepository({ repository }, expected), expected)
  }
  assert.equal(verifyInstallRepository({ repo: expected }, expected), expected)
  for (const install of [null, {}, { repository: {} }, { repository: 'smithersai/2026-10-02' },
    { repository: 'smithers-mvp-canary/2026-10-03' }, { repository: 'smithers-mvp-canary/template' }]) {
    assert.throws(() => verifyInstallRepository(install, expected))
  }
  assert.throws(() => verifyInstallRepository({ repository: expected }, 'smithersai/2026-10-02'))
})

test('real-run model admission requires recognizable live configuration', () => {
  for (const configuration of [undefined, null, {}, [], { models: [] }, { models: {} }]) {
    assert.throws(() => assertLiveModels(configuration), undefined, JSON.stringify(configuration))
  }
  assert.doesNotThrow(() => assertLiveModels({ models: [
    { provider: 'openai', model: 'gpt-6.1' }, { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  ] }))
})

test('real-run model admission rejects scripted and fixture providers recursively', () => {
  for (const forbidden of ['scripted', 'fixture', 'mock', 'fake']) {
    for (const suspect of [
      { provider: forbidden, model: 'gpt-6.1' },
      { provider: 'openai', model: `${forbidden}-model` },
      { provider: 'openai', model: 'gpt-6.1', endpoint: `http://localhost:4040/${forbidden}` },
    ]) {
      assert.throws(() => assertLiveModels({ settings: { coding: { routes: [suspect] } } }),
        undefined, JSON.stringify(suspect))
    }
  }
  assert.throws(() => assertLiveModels({ models: [{ provider: 'openai', model: 'gpt-6.1' }],
    settings: { nested: { scripted: true } } }))
  for (const suspect of [{ scripted: { enabled: true } }, { fixture: [{ model: 'gpt-6.1' }] },
    { providers: [{ id: 'mock' }] }, { seats: [{ type: 'fake' }] }, { routing: { model: { name: 'fixture-model' } } }]) {
    assert.throws(() => assertLiveModels({ models: [{ provider: 'openai', model: 'gpt-6.1' }], settings: suspect }),
      undefined, JSON.stringify(suspect))
  }
})

test('dry-run CLI works without credentials, network, model config or Playwright', async t => {
  const directory = await temporaryDirectory(t)
  const guard = join(directory, 'offline.mjs')
  const loader = join(directory, 'no-playwright.mjs')
  await writeFile(guard, `
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
const forbidden = () => { throw new Error('OFFLINE_TEST_NETWORK_ATTEMPT'); };
globalThis.fetch = forbidden;
http.request = http.get = https.request = https.get = forbidden;
net.connect = net.createConnection = net.Socket.prototype.connect = forbidden;
syncBuiltinESMExports();
`)
  await writeFile(loader, `
export function resolve(specifier, context, nextResolve) {
  if (/playwright/i.test(specifier)) throw new Error('OFFLINE_TEST_PLAYWRIGHT_IMPORT');
  return nextResolve(specifier, context);
}
`)
  const result = spawnSync(process.execPath, ['--import', guard, '--loader', loader,
    join(root, 'scripts/journeys/run.mjs'), '--dry-run'], {
    cwd: directory, env: { HOME: directory, PATH: dirname(process.execPath), TZ: 'Pacific/Honolulu' },
    encoding: 'utf8', timeout: 20_000,
  })
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr)
  assert.doesNotMatch(result.stdout + result.stderr, /OFFLINE_TEST_(NETWORK_ATTEMPT|PLAYWRIGHT_IMPORT)/)
  for (const journey of journeyIds) assert.match(result.stdout, new RegExp(`\\b${journey}\\b`))
  assert.match(result.stdout, /light/)
  assert.match(result.stdout, /dark/)
})

// Synthetic receipts validate the evidence parser, never the live 24-hour release gate.
function soakReceipt() {
  const start = Date.parse('2026-10-01T00:00:00.000Z')
  const iso = milliseconds => new Date(milliseconds).toISOString()
  return {
    startedAt: iso(start), finishedAt: iso(start + 24 * 60 * 60_000),
    commit: headSha, installVersion: '1.0.0', machines: ['mac-a', 'mac-b'],
    calls: Array.from({ length: 145 }, (_, cycle) => ['mac-a', 'mac-b'].flatMap(machine =>
      ['claude', 'codex', 'gh'].map(tool => ({ machine, tool, cycle, exitCode: 0, loginPrompt: false,
        timestamp: iso(start + cycle * 10 * 60_000) })))).flat(),
    wakes: [24, 48, 72, 96, 120, 144].map(cycle => ({ machine: 'mac-b', cycle,
      sleptAt: iso(start + cycle * 10 * 60_000 - 60_000), wokeAt: iso(start + cycle * 10 * 60_000),
      firstCallSucceeded: true })),
    credentialChanges: [{ machine: 'mac-a', receivedMachine: 'mac-b',
      written_at: iso(start + 60_000), receivedAt: iso(start + 120_000) }],
  }
}

test('activation accepts exactly 60 minutes after correcting the recorded start clock offset', () => {
  const input = { t0: '2026-10-02T00:00:01.000Z', clockOffsetStartMs: 1000, clockOffsetEndMs: 200 }
  const pull = { merged: true, merge_commit_sha: nextSha, merged_at: '2026-10-02T01:00:00.000Z',
    base: { ref: 'main' }, head: { ref: 'smithers/first-todo' } }
  const result = verifyActivation(input, pull)
  assert.equal(result.elapsedMs, 60 * 60_000)
  assert.equal(result.mergeCommit, nextSha)
  assert.equal(result.mergedAt, pull.merged_at)
  assert.throws(() => verifyActivation(input, { ...pull, merged_at: '2026-10-02T01:00:00.001Z' }), /60 minutes/)
  assert.throws(() => verifyActivation(input, { ...pull, merged_at: '2026-10-01T23:59:59.999Z' }), /ordering/)
})

test('activation rejects missing clock offsets, non-UTC timestamps and incomplete GitHub merges', () => {
  const input = { t0: '2026-10-02T00:00:00.000Z', clockOffsetStartMs: 0, clockOffsetEndMs: 0 }
  const pull = { merged: true, merge_commit_sha: nextSha, merged_at: '2026-10-02T00:30:00.000Z',
    base: { ref: 'main' }, head: { ref: 'smithers/first-todo' } }
  for (const overrides of [{ clockOffsetStartMs: undefined }, { clockOffsetEndMs: NaN },
    { t0: '2026-10-02T00:00:00+00:00' }, { t0: '2026-02-30T00:00:00Z' }, { t0: 'invalid' }]) {
    assert.throws(() => verifyActivation({ ...input, ...overrides }, pull))
  }
  for (const overrides of [{ merged: false }, { merge_commit_sha: undefined }, { merge_commit_sha: 'invalid' }, { merged_at: undefined },
    { merged_at: '2026-10-02T00:30:00+00:00' }, { base: { ref: 'develop' } }, { head: { ref: 'main' } },
    { head: { ref: 'smithers/' } }]) {
    assert.throws(() => verifyActivation(input, { ...pull, ...overrides }))
  }
})

test('credential soak requires all 870 scheduled calls and six successful wakes on the same release', () => {
  const receipt = soakReceipt()
  const result = verifyCredentialSoak(receipt, { commit: headSha, installVersion: '1.0.0' })
  assert.equal(result.calls, 870)
  assert.equal(result.credentialChanges, 1)
  assert.deepEqual(result.machines, ['mac-a', 'mac-b'])
  assert.throws(() => verifyCredentialSoak(receipt, { commit: nextSha }), /install release/)
  assert.throws(() => verifyCredentialSoak(receipt, { installVersion: '2.0.0' }), /install release/)
})

test('credential soak rejects empty, missing, skipped and duplicate call evidence', () => {
  assert.throws(() => verifyCredentialSoak(undefined))
  assert.throws(() => verifyCredentialSoak({}))
  for (const transform of [
    receipt => { receipt.calls = [] }, receipt => { delete receipt.calls },
    receipt => { receipt.calls.pop() }, receipt => { receipt.calls.push({ ...receipt.calls[0] }) },
    receipt => { receipt.wakes = [] }, receipt => { delete receipt.wakes },
    receipt => { delete receipt.credentialChanges }, receipt => { receipt.machines = ['mac-a', 'mac-a'] },
    receipt => { receipt.finishedAt = '2026-10-01T23:59:59.999Z' },
  ]) {
    const receipt = soakReceipt()
    transform(receipt)
    assert.throws(() => verifyCredentialSoak(receipt))
  }
})

test('credential soak rejects a failed call, login prompt, unknown tool or machine and invalid cadence', () => {
  for (const overrides of [{ exitCode: 1 }, { loginPrompt: true }, { loginPrompt: undefined },
    { tool: 'scripted' }, { machine: 'mac-c' }, { cycle: -1 }, { cycle: 145 },
    { timestamp: '2026-10-01T00:01:00.001Z' }, { timestamp: '2026-09-30T23:59:59.999Z' },
    { timestamp: '2026-10-01T00:00:00+00:00' }]) {
    const receipt = soakReceipt()
    Object.assign(receipt.calls[0], overrides)
    assert.throws(() => verifyCredentialSoak(receipt), undefined, JSON.stringify(overrides))
  }
  const boundary = soakReceipt()
  boundary.calls[0].timestamp = '2026-10-01T00:01:00.000Z'
  assert.doesNotThrow(() => verifyCredentialSoak(boundary))
})

test('credential soak requires successful first calls after each wake with correct ordering', () => {
  for (const overrides of [{ firstCallSucceeded: false }, { sleptAt: '2026-10-01T04:00:00.000Z' },
    { wokeAt: '2026-10-01T04:00:00.001Z' }, { machine: 'mac-a' }, { cycle: 23 }]) {
    const receipt = soakReceipt()
    Object.assign(receipt.wakes[0], overrides)
    assert.throws(() => verifyCredentialSoak(receipt), undefined, JSON.stringify(overrides))
  }
})

test('credential refresh must reach the other machine before its next call', () => {
  for (const overrides of [{ receivedMachine: 'mac-a' }, { machine: 'mac-c' },
    { receivedAt: '2026-10-01T00:00:59.999Z' }, { receivedAt: '2026-10-01T00:10:00.000Z' },
    { receivedAt: '2026-10-01T00:10:00.001Z' },
    { written_at: '2026-10-02T00:00:00.000Z', receivedAt: '2026-10-02T00:00:00.000Z' }]) {
    const receipt = soakReceipt()
    Object.assign(receipt.credentialChanges[0], overrides)
    assert.throws(() => verifyCredentialSoak(receipt), undefined, JSON.stringify(overrides))
  }
})
