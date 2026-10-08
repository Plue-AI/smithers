import test from 'node:test'
import assert from 'node:assert/strict'
import { verdict, wikiVerdict, boundaryVerdict, boundaryEnvironment, codeTests, hostTests, hostLifecycles, hostVerdict, suites, points, componentKillTests, watcherTests, watcherPoints, watcherLifecycles, watcherVerdict, watcherEnvironment } from './faults.mjs'
test('every named component must execute assertions; no empty or failed cargo receipt qualifies', () => {
  const logs = suites.map(suite => `Running tests/${suite}.rs (target)\n${(componentKillTests[suite] || []).map(name => `test ${name} ... ok\n`).join('')}test result: ok. 2 passed; 0 failed`).join('\n')
  assert.equal(verdict(0, logs), 'component-passed')
  assert.equal(verdict(1, logs), 'failed')
  assert.equal(verdict(0, ''), 'failed')
  for (const suite of suites) {
    assert.equal(verdict(0, logs.replace(`Running tests/${suite}.rs`, 'missing')), 'failed')
    const start = logs.indexOf(`Running tests/${suite}.rs`)
    const empty = logs.slice(0, start) + logs.slice(start).replace('test result: ok. 2 passed', 'test result: ok. 0 passed')
    assert.equal(verdict(0, empty), 'failed')
  }
  for (const names of Object.values(componentKillTests)) for (const name of names) {
    const receipt = `test ${name} ... ok`
    for (const replacement of ['', `test ${name} ... ignored`, `test ${name} ... FAILED`, receipt + '\n' + receipt]) {
      assert.equal(verdict(0, logs.replace(receipt, replacement)), 'failed')
    }
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

const pkg = 'github.com/smithersai/smithers/packages/backend/internal/compose'
const event = (Action, Test, Package = pkg) => JSON.stringify({ Action, Test, Package })
const receipt = (tests, count = 10) => [event('start'), ...Array.from({ length: count }, () => tests.flatMap(name => [event('run', name), event('pass', name)])).flat(), event('pass')].join('\n')
test('boundary requires ten complete lifecycles for every selected test and package', () => {
  const tests = ['TestWikiHostCommittedReceiptsAndRestart']
  const logs = receipt(tests)
  assert.equal(wikiVerdict(0, logs), 'boundary-passed')
  assert.equal(wikiVerdict(0, 'null\n42\n[]\ninvalid\n' + logs), 'boundary-passed')
  assert.equal(wikiVerdict(1, logs), 'failed')
  assert.equal(wikiVerdict(0, receipt(tests, 9)), 'failed')
  assert.equal(wikiVerdict(0, receipt(tests, 11)), 'failed')
  assert.equal(wikiVerdict(0, logs.split('\n').slice(0, -1).join('\n')), 'failed')
  assert.equal(wikiVerdict(0, logs.replaceAll(pkg, 'another/package')), 'failed')
  assert.equal(wikiVerdict(0, logs.replace(event('run', tests[0]) + '\n', '')), 'failed')
  assert.equal(wikiVerdict(0, logs + '\n' + event('pass', tests[0])), 'failed')
  assert.equal(wikiVerdict(0, logs + '\n' + event('pass')), 'failed')
  assert.equal(wikiVerdict(0, logs.replace(event('pass', tests[0]), event('run', tests[0]))), 'failed')
  assert.equal(wikiVerdict(0, logs.replace(event('start') + '\n', '')), 'failed')
  for (const action of ['skip', 'fail']) {
    assert.equal(wikiVerdict(0, logs + '\n' + event(action, tests[0])), 'failed')
    assert.equal(wikiVerdict(0, logs + '\n' + event(action)), 'failed')
  }
  assert.equal(wikiVerdict(0, 'test result: ok. 10 passed'), 'failed')
  assert.equal(boundaryVerdict(0, receipt(codeTests), codeTests), 'boundary-passed')
  for (const name of codeTests) assert.equal(boundaryVerdict(0, receipt(codeTests.filter(test => test !== name)), codeTests), 'failed')
})

test('missing host fixture records a failure before starting either boundary suite', async () => {
  const { mkdtemp, readdir, readFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { run } = await import('./faults.mjs')
  const root = await mkdtemp(join(tmpdir(), 'wiki-fault-refusal-'))
  try {
    for (const mode of ['wikiOnly', 'codeOnly', 'hostOnly', 'watcherOnly']) {
      assert.equal(await run({ root, [mode]: true }), 1)
      const parent = join(root, '.artifacts/checks/C-DUR-04')
      const directories = await readdir(parent)
      const directory = directories.sort().at(-1)
      const summary = JSON.parse(await readFile(join(parent, directory, 'summary.json'), 'utf8'))
      assert.equal(summary.status, 'failed')
      assert.equal(summary.reason, 'host fixture unavailable')
      assert.deepEqual(summary.tests, mode === 'watcherOnly' ? watcherTests : mode === 'hostOnly' ? hostTests : mode === 'wikiOnly' ? ['TestWikiHostCommittedReceiptsAndRestart'] : codeTests)
      assert.deepEqual(summary.points.map(item => item.point), mode === 'watcherOnly' ? watcherPoints : mode === 'hostOnly' ? ['K4', 'K4b'] : mode === 'wikiOnly' ? ['K8'] : ['K7a', 'K7b', 'K7c', 'K7d', 'K7e'])
      assert.ok(summary.points.every(item => item.status === 'blocked'))
      assert.deepEqual((await readdir(join(parent, directory))).sort(), ['env.json', 'summary.json'])
    }
    await assert.rejects(run({ root, wikiOnly: true, codeOnly: true }), /select one boundary suite/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('filtered target environment keeps the shared cache and explicit lane fixture', async () => {
  const config = { databaseUrl: 'postgres://test', libraryPath: '/native.dylib', lane: 'fr3-wt-w20-r5' }
  const env = boundaryEnvironment(config, {})
  assert.equal(env.GOCACHE, undefined)
  assert.equal(env.LANE, config.lane)
  assert.equal(env.SMITHERS_TEST_DATABASE_URL, config.databaseUrl)
  assert.equal(env.SMITHERS_FFI_LIBRARY_PATH, config.libraryPath)
  assert.equal(env.SMITHERS_REQUIRE_DATABASE_TESTS, '1')
  const ambient = boundaryEnvironment({ ...config, lane: undefined }, { GOCACHE: '/shared', LANE: 'caller' })
  assert.equal(ambient.GOCACHE, '/shared')
  assert.equal(ambient.LANE, 'caller')
  for (const invalid of [null, {}, { databaseUrl: 1, libraryPath: '/native' }, { databaseUrl: 'postgres://test', libraryPath: null }]) {
    assert.throws(() => boundaryEnvironment(invalid, {}), /invalid fixture/)
  }
})


test('host fault receipt requires both campaigns and all twenty run lifecycles', () => {
  const hostPkg = 'github.com/smithersai/smithers/packages/backend/internal/machined'
  const line = (action, name) => event(action, name, hostPkg)
  const logs = [line('start'), ...hostTests.flatMap(name => [line('run', name),
    ...Array.from({ length: 10 }, (_, i) => [line('run', `${name}/${i+1}`), line('pass', `${name}/${i+1}`)]).flat(),
    line('pass', name)]), line('pass')].join('\n')
  assert.equal(hostVerdict(0, logs), 'boundary-passed')
  assert.equal(hostVerdict(1, logs), 'failed')
  assert.equal(hostVerdict(0, logs.replaceAll(hostPkg, pkg)), 'failed')
  for (const name of hostLifecycles) {
    assert.equal(hostVerdict(0, logs.replace(line('pass', name), '')), 'failed')
    assert.equal(hostVerdict(0, logs.replace(line('pass', name), line('skip', name))), 'failed')
    assert.equal(hostVerdict(0, logs.replace(line('pass', name), line('fail', name))), 'failed')
    assert.equal(hostVerdict(0, logs + '\n' + line('pass', name)), 'failed')
  }
})


test('watcher campaign requires every real kill point and all seventy completed runs', () => {
 const logs = [event('start'), ...watcherTests.flatMap(name => [event('run', name),
  ...watcherPoints.flatMap(point => [event('run', `${name}/${point}`),
   ...Array.from({length:10}, (_,i) => [event('run', `${name}/${point}/${i+1}`), event('pass', `${name}/${point}/${i+1}`)]).flat(),
   event('pass', `${name}/${point}`)]), event('pass', name)]), event('pass')].join('\n')
 assert.equal(watcherVerdict(0, logs), 'boundary-passed')
 assert.equal(watcherVerdict(1, logs), 'failed')
 for (const name of watcherLifecycles) {
  assert.equal(watcherVerdict(0, logs.replace(event('pass',name),'')), 'failed')
  assert.equal(watcherVerdict(0, logs.replace(event('pass',name),event('skip',name))), 'failed')
  assert.equal(watcherVerdict(0, logs+'\n'+event('pass',name)), 'failed')
 }
 assert.equal(watcherVerdict(0, logs.replaceAll(pkg,'another/package')), 'failed')
})


test('watcher preflight refuses an uninstrumented binary before running the campaign', async () => {
 const {mkdtemp,writeFile,readFile,stat,chmod,rm,symlink} = await import('node:fs/promises')
 const {tmpdir} = await import('node:os')
 const {join} = await import('node:path')
 const directory = await mkdtemp(join(tmpdir(),'watcher-preflight-'))
 try {
  const binary = join(directory,'daemon')
  const config = {databaseUrl:'postgres://test',libraryPath:'/native.so',machinedFaultBinary:binary}
  await writeFile(binary,Buffer.from([0x7f,0x45,0x4c,0x46]),{mode:0o700})
  await assert.rejects(watcherEnvironment(config,directory,'commit',{}),/features killpoints/)
  await writeFile(binary,Buffer.concat([Buffer.from([0x7f,0x45,0x4c,0x46]),Buffer.from('SMITHERS_MACHINED_KILL_AT')]))
  const result = await watcherEnvironment(config,directory,'commit',{LANE:'fr14-col04'})
  assert.match(result.binaryDigest,/^[0-9a-f]{64}$/)
  assert.equal(result.env.SMITHERS_REHEARSAL_COMMIT,'commit')
  assert.equal(result.env.SMITHERS_REHEARSAL_FAULT_EVIDENCE,directory)
  const staged = join(directory,'machined-fault-daemon')
  assert.equal(result.env.SMITHERS_REHEARSAL_MACHINED_FAULT_BINARY,staged)
  const stagedBytes = await readFile(staged)
  assert.deepEqual(stagedBytes,await readFile(binary))
  assert.equal((await stat(staged)).mode & 0o777,0o500)
  await writeFile(binary,'concurrent shared-target rebuild')
  assert.deepEqual(await readFile(staged),stagedBytes,'every restart uses the qualified bytes')
  await writeFile(binary,stagedBytes)
  await assert.rejects(watcherEnvironment(config,directory,'commit',{}),/EEXIST/)
  await chmod(binary,0o600)
  await assert.rejects(watcherEnvironment(config,directory,'commit',{}),/invalid rehearsal/)
  await symlink(binary,join(directory,'link'))
  await assert.rejects(watcherEnvironment({...config,machinedFaultBinary:join(directory,'link')},directory,'commit',{}),/invalid rehearsal/)
  await assert.rejects(watcherEnvironment({...config,machinedFaultBinary:'relative'},directory,'commit',{}),/absolute/)
 } finally { await rm(directory,{recursive:true,force:true}) }
})
