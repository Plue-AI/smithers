import { execFileSync, spawn } from 'node:child_process'
import { mkdir, mkdtemp, lstat, readFile, writeFile } from 'node:fs/promises'
import { statfsSync } from 'node:fs'
import { cpus, platform, release, totalmem } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'

// Component evidence never qualifies C-DUR-04's integrated kill matrix.
export const points = ['K1', 'K2', 'K3', 'K3b', 'K4', 'K4b', 'K5a', 'K5b', 'K5c', 'K6', 'K7a', 'K7b', 'K7c', 'K7d', 'K7e', 'K8']
export const suites = ['versions', 'outbox', 'capture', 'reconcile', 'barrier', 'documents', 'rebase', 'link', 'moved_off']
export const componentKillTests = {
  versions: ['k1_k2_process_exit_recovery_ten_runs_each'],
  link: ['authenticated_delivery_killpoints_replay_ten_runs_each']
}
export function verdict(code, logs) {
  if (code !== 0) return 'failed'
  for (const suite of suites) {
    const section = logs.split(`Running tests/${suite}.rs`)[1]?.split(/\n\s*Running /)[0]
    const match = section?.match(/test result: ok\. (\d+) passed; 0 failed/)
    if (!match || Number(match[1]) === 0) return 'failed'
    for (const name of componentKillTests[suite] || []) {
      // A green suite built without kill hooks cannot qualify fault evidence.
      const receipts = section.split('\n').filter(line => line.trim() === `test ${name} ... ok`)
      if (receipts.length !== 1) return 'failed'
    }
  }
  return 'component-passed'
}
export const wikiTests = ['TestWikiHostCommittedReceiptsAndRestart']
export const codeTests = ['TestMachinedComposedDocumentBoundary', 'TestDocRelayMirrorRecovery', 'TestDocRelayRevocation', 'TestDocRelayRebuildBarrier', 'TestDocRelayReconnectUnreceipted']
// Count completed run/pass lifecycles from the selected package, not pass lines.
export function boundaryVerdict(code, logs, tests, repetitions = 10, pkg = 'github.com/smithersai/smithers/packages/backend/internal/compose') {
  if (code !== 0) return 'failed'
  const counts = new Map(tests.map(name => [name, 0]))
  const running = new Set()
  let started = false
  let completed = false
  for (const line of logs.split('\n')) {
    let event
    try { event = JSON.parse(line) } catch { continue }
    if (!event || event.Package !== pkg) continue
    if (['fail', 'skip'].includes(event.Action)) return 'failed'
    if (!event.Test) {
      if (event.Action === 'start') {
        if (started || completed) return 'failed'
        started = true
      }
      if (event.Action === 'pass') {
        if (!started || completed || running.size) return 'failed'
        completed = true
      }
      continue
    }
    if (!counts.has(event.Test)) continue
    if (!started || completed) return 'failed'
    if (event.Action === 'run') {
      if (running.has(event.Test)) return 'failed'
      running.add(event.Test)
    }
    if (event.Action === 'pass') {
      if (!running.delete(event.Test)) return 'failed'
      counts.set(event.Test, counts.get(event.Test) + 1)
    }
  }
  return completed && !running.size && [...counts.values()].every(count => count === repetitions) ? 'boundary-passed' : 'failed'
}
export const hostTests = ['TestFaultK4HostCommitBeforeAck', 'TestFaultK4bHostConnectionCut']
export const hostLifecycles = hostTests.flatMap(name => [name, ...Array.from({ length: 10 }, (_, i) => `${name}/${i + 1}`)])
export const hostVerdict = (code, logs) => boundaryVerdict(code, logs, hostLifecycles, 1, 'github.com/smithersai/smithers/packages/backend/internal/machined')
export const watcherHostTests = ['TestOutsideWatcherHostFaultRecovery', 'TestOutsideWatcherHostOutageRecovery']
export const watcherHostLifecycles = watcherHostTests.flatMap(name => [name, ...Array.from({ length: 10 }, (_, i) => `${name}/${i + 1}`)])
export const watcherHostVerdict = (code, logs) => boundaryVerdict(code, logs, watcherHostLifecycles, 1)
export const watcherPoints = ['K1', 'K2', 'K3', 'K3b', 'K5a', 'K5b', 'K5c']
export const watcherTests = ['TestOutsideWatcherDaemonFaultRecovery']
export const watcherLifecycles = watcherTests.flatMap(name => [name, ...watcherPoints.flatMap(point => [`${name}/${point}`, ...Array.from({ length: 10 }, (_, i) => `${name}/${point}/${i + 1}`)])])
export const watcherVerdict = (code, logs) => boundaryVerdict(code, logs, watcherLifecycles, 1)
export const sessionTests = ['TestMachinedDaemonSessionFaultRecovery']
export const memberHostTests = ['TestMachinedMemberHostOutageRecovery']
export const memberHostLifecycles = memberHostTests.flatMap(name => [name, ...Array.from({ length: 10 }, (_, i) => `${name}/K4b/${String(i + 1).padStart(2, '0')}`)])
export const memberHostVerdict = (code, logs) => boundaryVerdict(code, logs, memberHostLifecycles, 1)
export const vmTests = ['TestMachinedK6VMStop']
const guestLifecycles = (tests, selected) => tests.flatMap(name => [name, ...selected.flatMap(point =>
  Array.from({ length: 10 }, (_, i) => `${name}/${point}/${String(i + 1).padStart(2, '0')}`))])
export const sessionLifecycles = guestLifecycles(sessionTests, watcherPoints)
export const vmLifecycles = guestLifecycles(vmTests, ['K1', 'K5b'])
// Go creates intermediate K1/K5b parent subtests for slash-separated names.
// Count every required leaf; missing/skip/fail still refuses qualification.
export const sessionVerdict = (code, logs) => boundaryVerdict(code, logs, sessionLifecycles, 1)
export const vmVerdict = (code, logs) => boundaryVerdict(code, logs, vmLifecycles, 1)
export const wikiVerdict = (code, logs) => boundaryVerdict(code, logs, wikiTests)
const probe = (command, args) => {
  try { return execFileSync(command, args, { encoding: 'utf8', timeout: 5000 }).trim() } catch { return null }
}
const metadata = () => ({
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  host: { platform: platform(), kernel: release(), memory_bytes: totalmem(), logical_cpus: cpus().length, cpu: cpus()[0]?.model,
    perf_cores: platform() === 'darwin' ? Number(probe('/usr/sbin/sysctl', ['-n', 'hw.perflevel0.physicalcpu'])) || null : null,
    physical_cores: platform() === 'darwin' ? Number(probe('/usr/sbin/sysctl', ['-n', 'hw.physicalcpu'])) || null : null,
    macos_version: platform() === 'darwin' ? probe('/usr/bin/sw_vers', ['-productVersion']) : null,
    disk_free_bytes: statfsSync(process.cwd()).bavail * statfsSync(process.cwd()).bsize },
  msb_version: process.env.SMITHERS_MICROSANDBOX_BIN ? probe(process.env.SMITHERS_MICROSANDBOX_BIN, ['--version']) : null,
  rust_version: probe('rustc', ['--version']),
  scope: 'unprivileged component fixtures; no integrated VM, host transaction or browser kill proof'
})
export function boundaryEnvironment(config, ambient = process.env) {
  if (typeof config?.databaseUrl !== 'string' || typeof config?.libraryPath !== 'string') throw new Error('invalid fixture')
  return { ...ambient, SMITHERS_TEST_DATABASE_URL: config.databaseUrl, SMITHERS_FFI_LIBRARY_PATH: config.libraryPath,
    SMITHERS_REQUIRE_DATABASE_TESTS: '1', GOCACHE: ambient.GOCACHE,
    LANE: config.lane || ambient.LANE || 'working-together-boundary' }
}
export async function watcherEnvironment(config, directory, commit, ambient = process.env, localCapture = false) {
  if (typeof config?.machinedFaultBinary !== 'string' || !config.machinedFaultBinary.startsWith('/')) throw new Error('absolute killpoint-enabled rehearsal daemon required')
  const stat = await lstat(config.machinedFaultBinary)
  if (!stat.isFile() || !(stat.mode & 0o111) || stat.size > 512 * 1024 * 1024) throw new Error('invalid rehearsal daemon executable')
  const bytes = await readFile(config.machinedFaultBinary)
  if (!bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) || !bytes.includes(Buffer.from('SMITHERS_MACHINED_KILL_AT'))) throw new Error('rehearsal daemon must be Linux ELF built with --features killpoints')
  if (localCapture && !bytes.includes(Buffer.from('qualification-K4b-capture.arm'))) throw new Error('local capture qualification hook required')
  // Cargo's shared target can be rebuilt by another lane during a campaign.
  // Execute the exact bytes whose digest this receipt records on every restart.
  const executable = join(directory, 'machined-fault-daemon')
  await writeFile(executable, bytes, { flag: 'wx', mode: 0o500 })
  return { env: { ...boundaryEnvironment(config, ambient), SMITHERS_REHEARSAL_MACHINED_FAULT_BINARY: executable, SMITHERS_REHEARSAL_FAULT_EVIDENCE: directory, SMITHERS_REHEARSAL_COMMIT: commit }, binaryDigest: createHash('sha256').update(bytes).digest('hex') }
}
export async function run({ root = process.cwd(), componentsOnly = false, wikiOnly = false, codeOnly = false, hostOnly = false, watcherOnly = false, watcherHostOnly = false, sessionOnly = false, vmOnly = false, memberHostOnly = false, onResult } = {}) {
  if ([wikiOnly, codeOnly, hostOnly, watcherOnly, watcherHostOnly, sessionOnly, vmOnly, memberHostOnly].filter(Boolean).length > 1) throw new Error('select one boundary suite')
  const boundaryOnly = wikiOnly || codeOnly || hostOnly || watcherOnly || watcherHostOnly || sessionOnly || vmOnly || memberHostOnly
  const tests = memberHostOnly ? memberHostTests : watcherHostOnly ? watcherHostTests : sessionOnly ? sessionTests : vmOnly ? vmTests : watcherOnly ? watcherTests : hostOnly ? hostTests : wikiOnly ? wikiTests : codeTests
  const selectedPoints = memberHostOnly ? ['K4b'] : watcherHostOnly ? ['K4', 'K4b'] : sessionOnly ? watcherPoints : vmOnly ? ['K6'] : watcherOnly ? watcherPoints : hostOnly ? ['K4', 'K4b'] : wikiOnly ? ['K8'] : codeOnly ? points.filter(point => point.startsWith('K7')) : points
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  let directory = resolve(root)
  for (const part of ['.artifacts', 'checks', 'C-DUR-04']) {
    directory = join(directory, part)
    await mkdir(directory).catch(error => { if (error.code !== 'EEXIST') throw error })
    const stat = await lstat(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('unsafe evidence directory')
  }
  directory = await mkdtemp(join(directory, timestamp + '-'))
  const env = metadata()
  if (boundaryOnly) env.scope = memberHostOnly ? 'real approved guest watcher/member broker cgroups/composed host connection outage/native captures/PostgreSQL/HTTP terminal and file boundaries; K4b ten runs; K4 process exit with members remains unqualified' : watcherHostOnly ? 'real Linux watcher/native capture/outbox/bundle/host process crash after commit before ACK and 30-second transport outage/PostgreSQL/sleeping HTTP diff, ten repetitions; unchanged daemon, empty broker census; no guest member/init/VM qualification' : sessionOnly ? 'real approved guest watcher/member sessions/guest init/host/PostgreSQL/native capture; ten runs per daemon kill point; K4/K4b and K6 remain separate' : vmOnly ? 'real approved guest watcher/member sessions/VM force-stop/wake/host/PostgreSQL/native capture; K6 at K1 and K5b, ten runs each; remaining integrated points are separate' : watcherOnly ? 'real Linux watcher/native capture/outbox/bundle/host store/PostgreSQL/sleeping HTTP diff, ten repetitions per daemon kill point; empty broker census, no guest init supervision, host kill or VM qualification' : hostOnly ? 'K4 process-exit and K4b 30-second connection outage host dispatcher/PostgreSQL/Git boundary, ten runs each; fixture wire peer, no guest watcher or VM qualification' : wikiOnly ? 'K8 composed wiki host/native PostgreSQL boundary, ten repetitions; no full kill-matrix qualification' : 'composed HTTP/live/native PostgreSQL code recovery boundary with scripted daemon peer, ten repetitions; no real guest kill-matrix qualification'
  await writeFile(join(directory, 'env.json'), JSON.stringify(env, null, 2) + '\n', { flag: 'wx' })
  let executionEnv = process.env
  if (boundaryOnly) {
    try {
      const config = JSON.parse(await readFile(join(root, '.artifacts/working-together-host.json'), 'utf8'))
      executionEnv = hostOnly ? { ...process.env, SMITHERS_TEST_DATABASE_URL: config.databaseUrl, SMITHERS_REQUIRE_DATABASE_TESTS: '1' } : boundaryEnvironment(config)
      if (hostOnly && (typeof config.databaseUrl !== 'string' || !config.databaseUrl)) throw new Error('invalid fixture')
      if (sessionOnly || vmOnly || memberHostOnly) {
        if (platform() !== 'darwin' || typeof config.checkBundle !== 'string' || !config.checkBundle.startsWith('/')) throw new Error('reference Mac and absolute approved check bundle required')
        executionEnv = { ...executionEnv, SMITHERS_CHECK_BUNDLE: config.checkBundle,
          [memberHostOnly ? 'SMITHERS_MACHINED_HOST_SESSION_REFERENCE' : sessionOnly ? 'SMITHERS_MACHINED_SESSION_FAULT_REFERENCE' : 'SMITHERS_MACHINED_K6_REFERENCE']: '1' }
      }
      if (watcherOnly || watcherHostOnly) {
        const watcher = await watcherEnvironment(config, directory, env.commit, process.env, watcherHostOnly)
        executionEnv = watcher.env
        env.machinedFaultBinaryDigest = watcher.binaryDigest
        await writeFile(join(directory, 'env.json'), JSON.stringify(env, null, 2) + '\n')
      }
    } catch {
      const result = { ...env, timestamp, status: 'failed', componentStatus: 'failed', reason: 'host fixture unavailable', tests, points: selectedPoints.map(point => ({ point, status: 'blocked' })) }
      await writeFile(join(directory, 'summary.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' })
      await onResult?.(result, directory)
      console.error(`failed: ${directory} (host fixture unavailable)`)
      return 1
    }
  }
  const command = boundaryOnly ? 'go' : 'cargo'
  const args = boundaryOnly ? ['test', '-p', '4', sessionOnly || vmOnly || memberHostOnly ? '-timeout=60m' : '-timeout=20m', hostOnly ? './packages/backend/internal/machined' : './packages/backend/internal/compose', '-run', `^(${tests.join('|')})$`, hostOnly || watcherOnly || watcherHostOnly || sessionOnly || vmOnly || memberHostOnly ? '-count=1' : '-count=10', '-json', '-failfast'] : ['test', '--locked', '-p', 'smithers-machined', '--features', 'testing,killpoints', ...suites.flatMap(suite => ['--test', suite]), '--', '--test-threads=1']
  let logs = ''
  const code = await new Promise(resolve => {
    const child = spawn(command, args, { cwd: root, env: executionEnv, stdio: ['ignore', 'pipe', 'pipe'] })
    for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { logs += data; process.stdout.write(data) })
    child.on('error', error => { logs += error.message; resolve(1) })
    child.on('close', code => resolve(code))
  })
  await writeFile(join(directory, boundaryOnly ? memberHostOnly ? 'member-host.log' : sessionOnly ? 'sessions.log' : vmOnly ? 'vm.log' : watcherHostOnly ? 'watcher-host.log' : watcherOnly ? 'watcher.log' : hostOnly ? 'host.log' : wikiOnly ? 'wiki.log' : 'code.log' : 'components.log'), logs, { flag: 'wx' })
  const componentStatus = memberHostOnly ? memberHostVerdict(code, logs) : watcherHostOnly ? watcherHostVerdict(code, logs) : sessionOnly ? sessionVerdict(code, logs) : vmOnly ? vmVerdict(code, logs) : watcherOnly ? watcherVerdict(code, logs) : hostOnly ? hostVerdict(code, logs) : boundaryOnly ? boundaryVerdict(code, logs, tests) : verdict(code, logs)
  const result = { ...env, timestamp, status: componentStatus === 'failed' ? 'failed' : 'incomplete', componentStatus,
    command: [command, ...args], tests: boundaryOnly ? tests : undefined, points: selectedPoints.map(point => ({ point, status: 'blocked',
      reason: watcherHostOnly ? 'ten real watcher/host runs per K4/K4b; member sessions, guest supervision and VM matrix remain unqualified' : sessionOnly || vmOnly || memberHostOnly ? 'this approved guest campaign passed only its selected points; full K1-K6 qualification still requires integrated host crash/outage and every campaign receipt' : watcherOnly ? 'ten real daemon recovery runs; populated member session, guest supervision, host kill/outage and VM kills remain unqualified' : hostOnly ? 'ten authenticated host boundary runs; real guest watcher/outbox, VM, capture convergence and full per-run artifacts remain unqualified' : boundaryOnly ? 'ten host/native boundary repetitions; full-check client-text/row artifacts and the remaining matrix are not qualified' : 'complete real watcher/host/PostgreSQL/VM writer/receipt/head matrix remains unqualified; K4/K4b host evidence is available separately via --host-only' })) }
  await writeFile(join(directory, 'summary.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' })
  await onResult?.(result, directory)
  console.log(`${result.status}: ${directory}`)
  return componentStatus === 'failed' ? 1 : componentsOnly || boundaryOnly ? 0 : 2
}
// One S2 invocation owns every selected campaign receipt. Passing the Linux
// host campaign and the separate guest campaign still does not prove that the
// host crash/outage happened while real member cgroups were populated.
export const s2Campaigns = [
  { name: 'watcher', mode: 'watcherOnly', points: watcherPoints },
  { name: 'watcher-host', mode: 'watcherHostOnly', points: ['K4', 'K4b'] },
  { name: 'sessions', mode: 'sessionOnly', points: watcherPoints },
  { name: 'vm', mode: 'vmOnly', points: ['K6'] },
  { name: 'member-host', mode: 'memberHostOnly', points: ['K4b'] }
]
export function s2Verdict(campaigns) {
  if (campaigns.length !== s2Campaigns.length || s2Campaigns.some((expected, i) =>
    campaigns[i]?.name !== expected.name || campaigns[i]?.componentStatus !== 'boundary-passed' ||
    !/^[0-9a-f]{40}$/.test(campaigns[i]?.commit || '') || campaigns[i].commit !== campaigns[0]?.commit ||
    JSON.stringify(campaigns[i]?.points) !== JSON.stringify(expected.points))) return 'failed'
  return 'incomplete'
}
export async function runS2({ root = process.cwd() } = {}) {
  const campaigns = []
  // Keep VM campaigns sequential: they mutate the same reference install.
  // Each child retains its own per-run evidence, logs and digest-bound binary.
  for (const campaign of s2Campaigns) {
    await run({ root, [campaign.mode]: true, onResult: (result, directory) => {
      campaigns.push({ name: campaign.name, componentStatus: result.componentStatus,
        commit: result.commit, directory, points: campaign.points, reason: result.reason })
    } })
  }
  const status = s2Verdict(campaigns)
  const result = { commit: metadata().commit, status, campaigns,
    remaining: ['K4 host process exit with populated production member sessions in the composed guest/host install'] }
  const parent = join(root, '.artifacts/checks/C-DUR-04')
  const directory = await mkdtemp(join(parent, 's2-'))
  await writeFile(join(directory, 'summary.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' })
  console.log(`${status}: ${directory}`)
  // A collection of independent green boundaries never grants a full-check pass.
  return status === 'failed' ? 1 : 2
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const selected = ['components-only', 'wiki-only', 'code-only', 'host-only', 'watcher-only', 'watcher-host-only', 'session-only', 'vm-only', 'member-host-only', 's2'].filter(flag => process.argv.includes(`--${flag}`))
  if (selected.length > 1) throw new Error('select one boundary suite')
  process.exitCode = process.argv.includes('--s2') ? await runS2() : await run({ componentsOnly: process.argv.includes('--components-only'), wikiOnly: process.argv.includes('--wiki-only'), codeOnly: process.argv.includes('--code-only'), hostOnly: process.argv.includes('--host-only'), watcherOnly: process.argv.includes('--watcher-only'), watcherHostOnly: process.argv.includes('--watcher-host-only'), sessionOnly: process.argv.includes('--session-only'), vmOnly: process.argv.includes('--vm-only'), memberHostOnly: process.argv.includes('--member-host-only') })
}
