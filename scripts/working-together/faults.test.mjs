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
    for (const mode of ['wikiOnly', 'codeOnly', 'hostOnly', 'watcherOnly', 'watcherHostOnly', 'sessionOnly', 'vmOnly']) {
      assert.equal(await run({ root, [mode]: true }), 1)
      const parent = join(root, '.artifacts/checks/C-DUR-04')
      const directories = await readdir(parent)
      const directory = directories.sort().at(-1)
      const summary = JSON.parse(await readFile(join(parent, directory, 'summary.json'), 'utf8'))
      assert.equal(summary.status, 'failed')
      assert.equal(summary.reason, 'host fixture unavailable')
      assert.deepEqual(summary.tests, mode === 'watcherHostOnly' ? ['TestOutsideWatcherHostFaultRecovery', 'TestOutsideWatcherHostOutageRecovery'] : mode === 'sessionOnly' ? ['TestMachinedDaemonSessionFaultRecovery'] : mode === 'vmOnly' ? ['TestMachinedK6VMStop'] : mode === 'watcherOnly' ? watcherTests : mode === 'hostOnly' ? hostTests : mode === 'wikiOnly' ? ['TestWikiHostCommittedReceiptsAndRestart'] : codeTests)
      assert.deepEqual(summary.points.map(item => item.point), mode === 'watcherHostOnly' ? ['K4', 'K4b'] : mode === 'sessionOnly' ? watcherPoints : mode === 'vmOnly' ? ['K6'] : mode === 'watcherOnly' ? watcherPoints : mode === 'hostOnly' ? ['K4', 'K4b'] : mode === 'wikiOnly' ? ['K8'] : ['K7a', 'K7b', 'K7c', 'K7d', 'K7e'])
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
  await assert.rejects(watcherEnvironment(config,directory,'commit',{},true),/local capture qualification hook required/)
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


test('approved guest campaigns require all populated-session and VM lifecycles', async () => {
  const { sessionLifecycles, vmLifecycles, sessionVerdict, vmVerdict } = await import('./faults.mjs')
  for (const [names, verdict] of [[sessionLifecycles, sessionVerdict], [vmLifecycles, vmVerdict]]) {
    const logs = receipt(names, 1)
    assert.equal(verdict(0, logs), 'boundary-passed')
    assert.equal(verdict(1, logs), 'failed')
    for (const name of names) {
      assert.equal(verdict(0, logs.replace(event('pass', name), '')), 'failed')
      assert.equal(verdict(0, logs.replace(event('pass', name), event('skip', name))), 'failed')
      assert.equal(verdict(0, logs + '\n' + event('pass', name)), 'failed')
    }
  }
  assert.equal(sessionLifecycles.length, 71)
  assert.equal(vmLifecycles.length, 21)
})

test('real watcher host campaign requires every process-exit recovery lifecycle', async () => {
  const { watcherHostLifecycles, watcherHostVerdict } = await import('./faults.mjs')
  const logs = receipt(watcherHostLifecycles, 1)
  assert.equal(watcherHostVerdict(0, logs), 'boundary-passed')
  assert.equal(watcherHostVerdict(1, logs), 'failed')
  for (const name of watcherHostLifecycles) {
    for (const replacement of ['', event('skip', name), event('fail', name)]) {
      assert.equal(watcherHostVerdict(0, logs.replace(event('pass', name), replacement)), 'failed')
    }
    assert.equal(watcherHostVerdict(0, logs + '\n' + event('pass', name)), 'failed')
  }
  assert.equal(watcherHostLifecycles.length, 22)
  assert.equal(watcherHostVerdict(0, logs.replaceAll(pkg, 'another/package')), 'failed')
})


test('S2 receipts cannot combine missing, reordered, failed or different revisions into qualification', async () => {
  const { s2Campaigns, s2Verdict } = await import('./faults.mjs')
  const campaigns = s2Campaigns.map(({ name, points }, i) => ({ name, points, host: { platform: i < 2 ? 'linux' : 'darwin' },
    commit: 'a'.repeat(40), componentStatus: 'boundary-passed' }))
  assert.equal(s2Verdict(campaigns), 'passed')
  assert.equal(s2Verdict([]), 'failed')
  assert.equal(s2Verdict([...campaigns].reverse()), 'failed')
  assert.equal(s2Verdict([...campaigns, campaigns[0]]), 'failed')
  for (let i = 0; i < campaigns.length; i++) {
    for (const changed of [{ componentStatus: 'failed' }, { componentStatus: 'component-passed' },
      { commit: 'b'.repeat(40) }, { commit: '' }, { host: { platform: i < 2 ? 'darwin' : 'linux' } }, { points: [] }, { name: 'fixture' }]) {
      assert.equal(s2Verdict(campaigns.map((item, j) => j === i ? { ...item, ...changed } : item)), 'failed')
    }
  }
})

test('S2 CLI visits every real boundary and retains all refusals without qualifying Linux as a VM', async () => {
  const { mkdtemp, readdir, readFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { runS2, s2Campaigns } = await import('./faults.mjs')
  const root = await mkdtemp(join(tmpdir(), 's2-fault-refusal-'))
  try {
    assert.equal(await runS2({ root }), 1)
    const parent = join(root, '.artifacts/checks/C-DUR-04')
    const directories = await readdir(parent)
    assert.equal(directories.length, 6)
    const summary = JSON.parse(await readFile(join(parent, directories.find(name => name.startsWith('s2-')), 'summary.json'), 'utf8'))
    assert.equal(summary.status, 'failed')
    assert.deepEqual(summary.campaigns.map(item => item.name), s2Campaigns.map(item => item.name))
    for (const item of summary.campaigns) {
      assert.equal(item.componentStatus, 'failed')
      assert.equal(item.reason, 'host fixture unavailable')
      const child = JSON.parse(await readFile(join(item.directory, 'summary.json'), 'utf8'))
      assert.equal(child.commit, summary.commit)
      assert.equal(child.status, 'failed')
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})


test('member/host qualification requires each of the ten real guest outage lifecycles', async () => {
 const { memberHostLifecycles, memberHostVerdict } = await import('./faults.mjs')
 const logs = receipt(memberHostLifecycles, 1)
 assert.equal(memberHostVerdict(0, logs), 'boundary-passed')
 assert.equal(memberHostVerdict(1, logs), 'failed')
 assert.equal(memberHostLifecycles.length, 22)
 for (const name of memberHostLifecycles) {
  for (const replacement of ['', event('skip', name), event('fail', name)]) {
   assert.equal(memberHostVerdict(0, logs.replace(event('pass', name), replacement)), 'failed')
  }
 }
})


test('cross-host argv pins revision and quotes paths before remote execution', async () => {
 const { linuxCommand } = await import('./faults.mjs')
 const config = { host: 'member@linux', root: "/tmp/a'b $(touch bad)" }
 const args = linuxCommand(config, 'watcherHostOnly', 'a'.repeat(40))
 assert.deepEqual(args.slice(0,2), ['--', 'member@linux'])
 assert.ok(args[2].includes("cd '/tmp/a'\"'\"'b $(touch bad)'"))
 assert.ok(args[2].endsWith('--watcher-host-only --receipt'))
 for (const changed of [{ host: '-oProxyCommand=bad' }, { host: 'host;bad' }, { root: 'relative' }, { root: '/tmp/a\ncommand' }]) {
  assert.throws(() => linuxCommand({...config,...changed}, 'watcherOnly', 'a'.repeat(40)), /invalid/)
 }
 assert.throws(() => linuxCommand(config, 'vmOnly', 'a'.repeat(40)), /invalid/)
 assert.throws(() => linuxCommand(config, 'watcherOnly', 'HEAD'), /invalid/)
})


test('copied cross-host evidence must independently contain every real lifecycle at the pinned revision', async () => {
 const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
 const { tmpdir } = await import('node:os')
 const { join } = await import('node:path')
 const { readLinuxCampaign, s2Campaigns, watcherHostLifecycles } = await import('./faults.mjs')
 const directory = await mkdtemp(join(tmpdir(), 's2-copied-'))
 try {
  for (const campaign of s2Campaigns.slice(0,2)) {
   const names = campaign.mode === 'watcherOnly' ? watcherLifecycles : watcherHostLifecycles
   const file = join(directory, campaign.mode === 'watcherOnly' ? 'watcher.log' : 'watcher-host.log')
   const commit = 'a'.repeat(40)
   const summary = { commit, host: {platform:'linux'}, componentStatus:'boundary-passed', points:campaign.points.map(point=>({point})) }
   const save = value => writeFile(join(directory,'summary.json'),JSON.stringify(value))
   await save(summary); await writeFile(file,receipt(names,1))
   assert.equal((await readLinuxCampaign(directory,campaign,commit)).componentStatus,'boundary-passed')
   for (const patch of [{commit:'b'.repeat(40)}, {host:{platform:'darwin'}}, {componentStatus:'failed'}, {points:[]}]) {
    await save({...summary,...patch}); await assert.rejects(readLinuxCampaign(directory,campaign,commit),/lifecycles failed/)
   }
   await save(summary)
   for (const logs of [receipt(names,1).replace(event('pass',names.at(-1)),''), receipt(names,1)+'\n'+event('skip',names[0]), receipt(names,1)+'\n'+event('pass',names[0])]) {
    await writeFile(file,logs); await assert.rejects(readLinuxCampaign(directory,campaign,commit),/lifecycles failed/)
   }
   await rm(file); await assert.rejects(readLinuxCampaign(directory,campaign,commit),/ENOENT/)
  }
 } finally {await rm(directory,{recursive:true,force:true})}
})
