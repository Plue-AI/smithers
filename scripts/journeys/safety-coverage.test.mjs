import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { spawnSync } from 'node:child_process'
import { randomInt } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { canaryName, assertCanaryRepository, ensureCanaryRepository } from './canary-repo.mjs'
import { githubActors } from './github-actors.mjs'
import { restartBackend, duplicateLaunch } from './faults.mjs'
import { cli, command, childEnvironment, isMain, safeRelativePath } from './lib.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const repository = 'smithers-mvp-canary/2026-10-02'
const env = { JOURNEY_OWNER_TOKEN: 'owner', JOURNEY_BEN_TOKEN: 'ben', JOURNEY_ALICE_TOKEN: 'alice' }
const head = 'a'.repeat(40)
const next = 'b'.repeat(40)
const tree = 'c'.repeat(40)
const blob = 'd'.repeat(40)
const response = (value, status = 200) => new Response(JSON.stringify(value), { status })
const approved = (name = repository) => ({ full_name: name, owner: { login: 'smithers-mvp-canary' },
  template_repository: { full_name: 'smithers-mvp-canary/template' }, default_branch: 'main', allow_squash_merge: true })
const pull = () => ({ head: { repo: { full_name: repository }, ref: 'smithers/todo', sha: head },
  base: { repo: { full_name: repository }, ref: 'main' } })

function actorHttp({ user, permission, result = ({ path, method }) => {
  if (path.includes('/git/ref/')) return { object: { sha: head } }
  if (method === 'GET' && path.includes('/git/commits/')) return { tree: { sha: tree } }
  if (path.endsWith('/git/blobs')) return { sha: blob }
  if (path.endsWith('/git/trees')) return { sha: tree }
  if (path.endsWith('/git/commits')) return { sha: next }
  if (path.endsWith('/git/refs') || method === 'PATCH') return {}
  if (path.endsWith('/pulls')) return { number: 7 }
  if (path.endsWith('/pulls/7')) return { ...pull(), head: { ...pull().head, ref: 'journey/unrelated', sha: next } }
  if (path.endsWith('/merge')) return { merged: true, sha: next }
  return pull()
} } = {}) {
  const calls = []
  const fetchImpl = async (url, options) => {
    const actor = options.headers.Authorization.slice('Bearer '.length)
    const request = { actor, method: options.method, path: new URL(url).pathname,
      body: options.body ? JSON.parse(options.body) : undefined }
    calls.push(request)
    if (request.path === '/user') return response(user ? user(actor) : {
      id: ['owner', 'ben', 'alice'].indexOf(actor) + 1, login: actor, type: 'User' })
    if (request.path.endsWith('/permission')) return response({ permission: permission ? permission(actor) : actor === 'owner' ? 'admin' : 'write' })
    return response(await result(request))
  }
  return { calls, fetchImpl }
}

test('canary admission handles missing names, invalid dates, and dated campaign suffixes', () => {
  assert.match(canaryName(), /^\d{4}-\d{2}-\d{2}$/)
  assert.deepEqual(assertCanaryRepository(`${repository}-dark-webkit`), { owner: 'smithers-mvp-canary', name: '2026-10-02-dark-webkit' })
  for (const value of [undefined, null, 7, 'smithers-mvp-canary', 'smithers-mvp-canary/2026-13-01', `${repository}-UPPER`]) {
    assert.throws(() => assertCanaryRepository(value), /Missing|date/)
  }
})

test('canary creation errors stop immediately without rereading or accepting an unrelated winner', async () => {
  for (const status of [401, 403, 429, 503]) {
    const calls = []
    await assert.rejects(ensureCanaryRepository({ repository, token: 'unit-token', fetchImpl: async (url, options) => {
      calls.push(options.method)
      return response({}, calls.length === 1 ? 404 : status)
    } }), error => error.status === status)
    assert.deepEqual(calls, ['GET', 'POST'])
  }
  for (const value of [null, {}, { ...approved(), owner: undefined }]) {
    let calls = 0
    await assert.rejects(ensureCanaryRepository({ repository, token: 'unit-token', fetchImpl: async () => {
      calls++
      return response(value)
    } }), /identity/)
    assert.equal(calls, 1)
  }
})

test('canary defaults use the current UTC date and only the explicit owner token environment setting', async () => {
  const originalFetch = globalThis.fetch
  const originalToken = process.env.JOURNEY_OWNER_TOKEN
  const calls = []
  globalThis.fetch = async (url, options) => {
    calls.push({ path: new URL(url).pathname, method: options.method, authorization: options.headers.Authorization })
    return response(approved(new URL(url).pathname.slice('/repos/'.length)))
  }
  process.env.JOURNEY_OWNER_TOKEN = 'unit-default-owner'
  try {
    const firstDate = canaryName()
    const value = await ensureCanaryRepository()
    assert.ok([firstDate, canaryName()].includes(value.full_name.split('/')[1]))
    assert.deepEqual(calls, [{ path: `/repos/${value.full_name}`, method: 'GET', authorization: 'Bearer unit-default-owner' }])
  } finally {
    globalThis.fetch = originalFetch
    if (originalToken === undefined) delete process.env.JOURNEY_OWNER_TOKEN
    else process.env.JOURNEY_OWNER_TOKEN = originalToken
  }
})

test('actor identity fields and token bindings fail before repository access probes', async () => {
  for (const invalid of [null, {}, { type: 'User', id: 1.5, login: 'owner' },
    { type: 'User', id: 1, login: null }, { type: 'User', id: 1, login: '' }]) {
    const http = actorHttp({ user: () => invalid })
    await assert.rejects(githubActors({ repository, env, fetchImpl: http.fetchImpl }), /personal/)
    assert.deepEqual(http.calls.map(call => call.path), ['/user'])
  }
  const http = actorHttp()
  const actors = await githubActors({ repository, env: { ...env, JOURNEY_OWNER_LOGIN: 'OWNER', JOURNEY_BEN_LOGIN: 'BEN' }, fetchImpl: http.fetchImpl })
  assert.equal(actors.identities.owner.login, 'owner')
  assert.equal(http.calls.length, 6)
})

test('failed access revalidation revokes previously admitted actor writes until a complete verification succeeds', async () => {
  let revoked = false
  const http = actorHttp({ permission: actor => actor === 'owner' ? 'admin' : revoked && actor === 'ben' ? 'read' : 'write' })
  const actors = await githubActors({ repository, env, fetchImpl: http.fetchImpl })
  revoked = true
  await assert.rejects(actors.verifyAccess(), /ben lacks/)
  const before = http.calls.length
  await assert.rejects(actors.pushTodo('ben', {}), /not been verified/)
  assert.equal(http.calls.length, before)
  revoked = false
  await actors.verifyAccess()
  await assert.rejects(actors.pushTodo('ben', { branch: 'main' }), /smithers/)
  assert.equal(http.calls.length, before + 3)
})

test('actor branches and PR numbers reject every unsafe shape before a read or write', async () => {
  const http = actorHttp()
  const actors = await githubActors({ repository, env, fetchImpl: http.fetchImpl })
  const before = http.calls.length
  for (const branch of [undefined, 42, 'smithers/', 'smithers/a//b', 'smithers/a.b', 'smithers/a b']) {
    await assert.rejects(actors.pushTodo('ben', { branch, path: 'src/a.ts', content: 'text', message: 'message' }), /branch/)
  }
  for (const pr of [undefined, null, '1', 0, -1, 1.2, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(actors.mergePr('owner', { pr, expectedHead: head }), /positive PR/)
  }
  assert.equal(http.calls.length, before)
})

test('actor PR admission rejects absent heads, foreign bases, and malformed current commit identities without writes', async () => {
  for (const value of [null, {}, { ...pull(), base: { ...pull().base, repo: { full_name: 'outside/fork' } } },
    { ...pull(), head: { ...pull().head, ref: 'smithers/a//b' } },
    { ...pull(), head: { ...pull().head, sha: undefined } },
    { ...pull(), head: { ...pull().head, sha: 'f'.repeat(39) } }]) {
    const http = actorHttp({ result: () => value })
    const actors = await githubActors({ repository, env, fetchImpl: http.fetchImpl })
    await assert.rejects(actors.reviewComment('ben', { pr: 1, commitSha: head, path: 'src/a', line: 1, body: 'comment' }), /canary|branch|SHA/)
    assert.ok(http.calls.every(call => call.method === 'GET'))
  }
})

test('actor pushes validate each Git object response and never update the ref after an invalid object', async () => {
  for (const fault of ['ref', 'previous', 'blob', 'tree', 'commit']) {
    const http = actorHttp({ result: ({ path, method }) => {
      if (path.includes('/git/ref/')) return fault === 'ref' ? {} : { object: { sha: head } }
      if (method === 'GET') return fault === 'previous' ? {} : { tree: { sha: tree } }
      if (path.endsWith('/git/blobs')) return fault === 'blob' ? {} : { sha: blob }
      if (path.endsWith('/git/trees')) return fault === 'tree' ? {} : { sha: tree }
      if (path.endsWith('/git/commits')) return fault === 'commit' ? {} : { sha: next }
      assert.fail('invalid Git object must never update a ref')
    } })
    const actors = await githubActors({ repository, env, fetchImpl: http.fetchImpl })
    await assert.rejects(actors.pushTodo('ben', { branch: 'smithers/todo', path: 'src/a.ts', content: 'text', message: 'message' }), /SHA/)
    assert.equal(http.calls.filter(call => call.method === 'PATCH').length, 0)
    assert.equal(http.calls.length, { ref: 7, previous: 9, blob: 9, tree: 10, commit: 11 }[fault])
  }
})

test('unrelated merge stops on a changed PR head or missing completion receipt without direct main writes', async () => {
  for (const fault of ['changed-head', 'not-merged', 'missing-merge']) {
    const baseline = actorHttp()
    const http = actorHttp({ result: async request => {
      if (request.path.endsWith('/pulls/7') && fault === 'changed-head') return { ...pull(), head: { ...pull().head, ref: 'journey/unrelated', sha: head } }
      if (request.path.endsWith('/merge')) return fault === 'missing-merge' ? null : { merged: false }
      const options = { method: request.method, headers: { Authorization: `Bearer ${request.actor}` },
        ...(request.body ? { body: JSON.stringify(request.body) } : {}) }
      return await (await baseline.fetchImpl(`https://api.github.com${request.path}`, options)).json()
    } })
    const actors = await githubActors({ repository, env, fetchImpl: http.fetchImpl })
    await assert.rejects(actors.unrelatedMerge('ben', { branch: 'journey/unrelated', content: 'text', message: 'message' }), /head changed|did not complete/)
    assert.equal(http.calls.filter(call => call.method === 'PUT').length, fault === 'changed-head' ? 0 : 1)
    assert.ok(http.calls.every(call => call.method === 'GET' || !call.path.endsWith('/heads/main')))
  }
})

test('duplicate launch recognizes each supported durable identity and records its exact value', async () => {
  for (const value of [{ todo_id: 'todo' }, { run_id: 'run' }, { result: { id: 'nested' } }]) {
    const logs = []
    const result = await duplicateLaunch({ origin: 'http://factory.local:4000', path: '/api/todos', payload: {}, key: 'key', token: 'unit-token',
      fetchImpl: async () => response(value), log: async event => logs.push(event) })
    assert.deepEqual(result, value)
    assert.equal(logs.at(-1).id, value.todo_id ?? value.run_id ?? value.result.id)
    assert.deepEqual(logs.map(event => event.event), ['duplicate.request', 'duplicate.response', 'duplicate.request', 'duplicate.response', 'duplicate.reconciled'])
  }
  for (const value of [null, false, 'result', 12, { result: {} }]) {
    await assert.rejects(duplicateLaunch({ origin: 'https://factory.example', path: '/api/todos', payload: {}, key: 'key', token: 'unit-token',
      fetchImpl: async () => response(value) }), /durable result identity/)
  }
})

test('duplicate launch rejects same-origin credentials and relative paths before transport', async () => {
  let calls = 0
  for (const path of ['https://factory.example/api/todos', '//user@factory.example/api/todos', '//user:password@factory.example/api/todos', '//:password@factory.example/api/todos', 'api/todos']) {
    await assert.rejects(duplicateLaunch({ origin: 'https://factory.example', path, key: 'key', token: 'unit-token',
      fetchImpl: async () => { calls++ } }), /API path/)
  }
  assert.equal(calls, 0)
})

test('restart accepts minimum safe PID and default logger while rejecting absent executable and unsafe PID boundaries', async () => {
  const calls = []
  await restartBackend({ target: 'owner@mac-mini', pid: 2, executable: '/opt/backend',
    execImpl: async (file, args) => { calls.push(args.at(-1)); return { stdout: '/opt/backend\n' } } })
  assert.deepEqual(calls, ['ps -p 2 -o comm=', 'kill -9 2'])
  for (const overrides of [{ executable: undefined }, { executable: null }, { pid: Number.MAX_SAFE_INTEGER + 1 }]) {
    await assert.rejects(restartBackend({ target: 'owner@mac-mini', pid: 2, executable: '/opt/backend', ...overrides,
      execImpl: async () => assert.fail('invalid restart must not execute') }), /exact reference/)
  }
})

test('relative path rejects dot components and forbidden punctuation while admitting nested literal names', () => {
  assert.equal(safeRelativePath('src/my_file-2.ts'), 'src/my_file-2.ts')
  for (const value of ['.', './file', 'src/./file', 'src/file/', 'src/file?x', 'src\\file', 'src/../file']) {
    assert.throws(() => safeRelativePath(value), /Unsafe/)
  }
})

test('command tolerates broken stdin and still settles from the child exit receipt', async () => {
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.stdin = new EventEmitter()
  child.stdin.end = input => {
    assert.equal(input, 'payload')
    child.stdin.emit('error', Object.assign(new Error('pipe closed'), { code: 'EPIPE' }))
    child.stdout.write('final receipt')
    child.emit('close', 0)
  }
  const result = await command('unit-command', ['literal'], { input: 'payload', spawnImpl: (file, args, options) => {
    assert.equal(file, 'unit-command')
    assert.deepEqual(args, ['literal'])
    assert.equal(options.shell, false)
    return child
  } })
  assert.deepEqual(result, { stdout: 'final receipt', stderr: '', code: 0 })
})

test('command rejects an actual signal-terminated process instead of reporting a success', async () => {
  await assert.rejects(command(process.execPath, ['-e', 'process.kill(process.pid,"SIGTERM")']), /exited null/)
})

test('main detection handles absent argv and exact file URLs without changing the process permanently', t => {
  const argv = process.argv
  t.after(() => { process.argv = argv })
  process.argv = [process.execPath]
  assert.equal(isMain(import.meta.url), undefined)
  process.argv = [process.execPath, fileURLToPath(import.meta.url)]
  assert.equal(isMain(import.meta.url), true)
  assert.equal(isMain(pathToFileURL(join(root, 'other.mjs')).href), false)
})

async function temporaryDirectory(t) {
  const base = join(root, '.artifacts', 'journey-unit')
  await mkdir(base, { recursive: true })
  const directory = await mkdtemp(join(base, 'safety-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

// Actual helper CLIs and files; fake HTTP cannot fall through to the network.
// Fixed UTC timestamps isolate receipts from concurrently running test lanes.
async function cliFixture(t, stamp) {
  const directory = await temporaryDirectory(t)
  stamp = new Date(new Date(stamp).getTime() + randomInt(86_400_000)).toISOString()
  const preload = join(directory, 'preload.mjs')
  const requests = join(directory, 'requests.jsonl')
  await writeFile(preload, `
import { appendFile } from 'node:fs/promises'
const RealDate = Date
globalThis.Date = class extends RealDate { constructor(...args) { super(...(args.length ? args : [${JSON.stringify(stamp)}])) } }
globalThis.fetch = async (url, options) => {
  const parsed = new URL(url)
  if (parsed.origin !== 'https://api.github.com') throw new Error('unit fixture refuses external origin')
  const path = parsed.pathname
  const method = options.method
  const actor = options.headers.Authorization.slice('Bearer '.length)
  await appendFile(${JSON.stringify(requests)}, JSON.stringify({ path, method, actor })+'\\n')
  let value
  if (path === '/user') value = { id: ['owner','ben','alice'].indexOf(actor)+1, login: actor, type: 'User' }
  else if (path.endsWith('/permission')) value = { permission: actor === 'owner' ? 'admin' : 'write' }
  else if (method === 'GET' && /\\/pulls\\/1$/.test(path)) {
    const repository = path.slice('/repos/'.length).split('/pulls/')[0]
    value = { head: { repo: { full_name: repository }, ref: 'smithers/todo', sha: '${head}' }, base: { repo: { full_name: repository }, ref: 'main' } }
  }
  else if (method === 'GET' && /^\\/repos\\/smithers-mvp-canary\\/[^/]+$/.test(path)) {
    value = { full_name: path.slice('/repos/'.length), owner: { login: 'smithers-mvp-canary' }, template_repository: { full_name: 'smithers-mvp-canary/template' }, default_branch: 'main', allow_squash_merge: true }
  }
  else if (method === 'POST' && path.endsWith('/pulls/1/comments')) value = JSON.parse(process.env.UNIT_ACTION_RESULT)
  else throw new Error('unexpected fixture request: '+method+' '+path)
  return new Response(JSON.stringify(value), { status: 200 })
}
`)
  const run = async (file, args = [], extraEnv = {}) => {
    const runtimeEnv = { ...childEnvironment(), ...env, ...extraEnv }
    return await command(process.execPath, ['--import', preload, join(root, 'scripts/journeys', file), ...args], { env: runtimeEnv, timeout: 30_000 })
  }
  const runFailure = (file, args = []) => spawnSync(process.execPath, ['--import', preload, join(root, 'scripts/journeys', file), ...args], {
    env: { ...childEnvironment(), ...env }, encoding: 'utf8', timeout: 30_000,
  })
  return { directory, requests, run, runFailure, stamp }
}

test('canary CLI uses a default UTC date or explicit campaign and persists only safe read receipts', async t => {
  for (const [stamp, args, expected] of [
    ['2199-01-01T00:00:00.000Z', [], 'smithers-mvp-canary/2199-01-01'],
    ['2199-01-02T00:00:00.000Z', [`${repository}-dark`], `${repository}-dark`],
  ]) {
    const fixture = await cliFixture(t, stamp)
    const artifact = join(root, '.artifacts', 'checks', 'C-J1-01', fixture.stamp)
    t.after(() => rm(artifact, { recursive: true, force: true }))
    const result = await fixture.run('canary-repo.mjs', args)
    assert.equal(result.stdout, `${expected}\n`)
    assert.equal(result.stderr, '')
    assert.deepEqual((await readFile(fixture.requests, 'utf8')).trim().split('\n').map(JSON.parse), [
      { path: `/repos/${expected}`, method: 'GET', actor: 'owner' } ])
    const receipts = (await readFile(join(artifact, 'steps.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
    assert.deepEqual(receipts.map(item => item.event), ['github.request', 'github.response'])
    assert.ok(receipts.every(item => item.timestamp === fixture.stamp))
    assert.doesNotMatch(JSON.stringify(receipts), /Authorization|Bearer/)
  }
})

test('actor CLI reads JSON action input and records review, PR, and absent completion identifiers accurately', async t => {
  for (const [index, value, expectedId, expectedSha] of [[3, { id: 7, sha: next }, 7, next], [4, { pr: 9 }, 9, null], [5, {}, null, null]]) {
    const stamp = `2199-01-0${index}T00:00:00.000Z`
    const fixture = await cliFixture(t, stamp)
    const artifact = join(root, '.artifacts', 'checks', 'C-J10-01', fixture.stamp)
    t.after(() => rm(artifact, { recursive: true, force: true }))
    const input = join(fixture.directory, 'action.json')
    await writeFile(input, JSON.stringify({ pr: 1, commitSha: head, path: 'src/a.ts', line: 1, body: 'Please fix this' }))
    const result = await fixture.run('github-actors.mjs', [repository, 'ben', 'reviewComment', input], { UNIT_ACTION_RESULT: JSON.stringify(value) })
    assert.equal(result.stdout, '')
    assert.equal(result.stderr, '')
    const requests = (await readFile(fixture.requests, 'utf8')).trim().split('\n').map(JSON.parse)
    assert.equal(requests.length, 8)
    assert.deepEqual(requests.at(-1), { method: 'POST', actor: 'ben', path: `/repos/${repository}/pulls/1/comments` })
    const receipts = (await readFile(join(artifact, 'steps.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
    assert.deepEqual(receipts.at(-1), { timestamp: fixture.stamp, event: 'github.action.completed', actor: 'ben', action: 'reviewComment', id: expectedId, sha: expectedSha })
  }
})

test('actor CLI rejects unknown actions and missing action paths with a failing exit and no GitHub write', async t => {
  for (const [index, args, message] of [[6, [repository, 'ben', 'unknown'], /Unknown GitHub actor action/],
    [7, [repository, 'ben', 'reviewComment'], /Missing action JSON file/]]) {
    const stamp = `2199-01-0${index}T00:00:00.000Z`
    const fixture = await cliFixture(t, stamp)
    const artifact = join(root, '.artifacts', 'checks', 'C-J10-01', fixture.stamp)
    t.after(() => rm(artifact, { recursive: true, force: true }))
    const result = fixture.runFailure('github-actors.mjs', args)
    assert.ifError(result.error)
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, message)
    const requests = (await readFile(fixture.requests, 'utf8')).trim().split('\n').map(JSON.parse)
    assert.equal(requests.length, 6)
    assert.ok(requests.every(item => item.method === 'GET'))
  }
})

test('cli returns success and preserves an error message with exitCode 1', async t => {
  const previousCode = process.exitCode
  const previousWrite = process.stderr.write
  const output = []
  t.after(() => { process.exitCode = previousCode; process.stderr.write = previousWrite })
  process.stderr.write = value => { output.push(value); return true }
  let completed = false
  await cli(async () => { completed = true })
  assert.equal(completed, true)
  assert.equal(process.exitCode, previousCode)
  await cli(async () => { throw new Error('unit failure receipt') })
  assert.deepEqual(output, ['unit failure receipt\n'])
  assert.equal(process.exitCode, 1)
})
