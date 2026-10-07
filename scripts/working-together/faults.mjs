import { execFileSync, spawn } from 'node:child_process'
import { mkdir, lstat, readFile, writeFile } from 'node:fs/promises'
import { statfsSync } from 'node:fs'
import { cpus, platform, release, totalmem } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// Component evidence never qualifies C-DUR-04's integrated kill matrix.
export const points = ['K1', 'K2', 'K3', 'K3b', 'K4', 'K4b', 'K5a', 'K5b', 'K5c', 'K6', 'K7a', 'K7b', 'K7c', 'K7d', 'K7e', 'K8']
export const suites = ['versions', 'outbox', 'capture', 'reconcile', 'barrier', 'documents', 'rebase']
export function verdict(code, logs) {
  if (code !== 0) return 'failed'
  for (const suite of suites) {
    const section = logs.split(`Running tests/${suite}.rs`)[1]?.split(/\n\s*Running /)[0]
    const match = section?.match(/test result: ok\. (\d+) passed; 0 failed/)
    if (!match || Number(match[1]) === 0) return 'failed'
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
export async function run({ root = process.cwd(), componentsOnly = false, wikiOnly = false, codeOnly = false, hostOnly = false } = {}) {
  if ([wikiOnly, codeOnly, hostOnly].filter(Boolean).length > 1) throw new Error('select one boundary suite')
  const boundaryOnly = wikiOnly || codeOnly || hostOnly
  const tests = hostOnly ? hostTests : wikiOnly ? wikiTests : codeTests
  const selectedPoints = hostOnly ? ['K4', 'K4b'] : wikiOnly ? ['K8'] : codeOnly ? points.filter(point => point.startsWith('K7')) : points
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  let directory = resolve(root)
  for (const part of ['.artifacts', 'checks', 'C-DUR-04']) {
    directory = join(directory, part)
    await mkdir(directory).catch(error => { if (error.code !== 'EEXIST') throw error })
    const stat = await lstat(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('unsafe evidence directory')
  }
  directory = join(directory, timestamp)
  await mkdir(directory)
  const env = metadata()
  if (boundaryOnly) env.scope = hostOnly ? 'K4 process-exit and K4b 30-second connection outage host dispatcher/PostgreSQL/Git boundary, ten runs each; fixture wire peer, no guest watcher or VM qualification' : wikiOnly ? 'K8 composed wiki host/native PostgreSQL boundary, ten repetitions; no full kill-matrix qualification' : 'composed HTTP/live/native PostgreSQL code recovery boundary with scripted daemon peer, ten repetitions; no real guest kill-matrix qualification'
  await writeFile(join(directory, 'env.json'), JSON.stringify(env, null, 2) + '\n', { flag: 'wx' })
  let executionEnv = process.env
  if (boundaryOnly) {
    try {
      const config = JSON.parse(await readFile(join(root, '.artifacts/working-together-host.json'), 'utf8'))
      executionEnv = hostOnly ? { ...process.env, SMITHERS_TEST_DATABASE_URL: config.databaseUrl, SMITHERS_REQUIRE_DATABASE_TESTS: '1' } : boundaryEnvironment(config)
      if (hostOnly && (typeof config.databaseUrl !== 'string' || !config.databaseUrl)) throw new Error('invalid fixture')
    } catch {
      await writeFile(join(directory, 'summary.json'), JSON.stringify({ ...env, timestamp, status: 'failed', componentStatus: 'failed', reason: 'host fixture unavailable', tests, points: selectedPoints.map(point => ({ point, status: 'blocked' })) }, null, 2) + '\n', { flag: 'wx' })
      console.error(`failed: ${directory} (host fixture unavailable)`)
      return 1
    }
  }
  const command = boundaryOnly ? 'go' : 'cargo'
  const args = boundaryOnly ? ['test', hostOnly ? './packages/backend/internal/machined' : './packages/backend/internal/compose', '-run', `^(${tests.join('|')})$`, hostOnly ? '-count=1' : '-count=10', '-json'] : ['test', '--locked', '-p', 'smithers-machined', '--features', 'testing,killpoints', ...suites.flatMap(suite => ['--test', suite]), '--', '--test-threads=1']
  let logs = ''
  const code = await new Promise(resolve => {
    const child = spawn(command, args, { cwd: root, env: executionEnv, stdio: ['ignore', 'pipe', 'pipe'] })
    for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { logs += data; process.stdout.write(data) })
    child.on('error', error => { logs += error.message; resolve(1) })
    child.on('close', code => resolve(code))
  })
  await writeFile(join(directory, boundaryOnly ? hostOnly ? 'host.log' : wikiOnly ? 'wiki.log' : 'code.log' : 'components.log'), logs, { flag: 'wx' })
  const componentStatus = hostOnly ? hostVerdict(code, logs) : boundaryOnly ? boundaryVerdict(code, logs, tests) : verdict(code, logs)
  const result = { ...env, timestamp, status: componentStatus === 'failed' ? 'failed' : 'incomplete', componentStatus,
    command: [command, ...args], tests: boundaryOnly ? tests : undefined, points: selectedPoints.map(point => ({ point, status: 'blocked',
      reason: hostOnly ? 'ten authenticated host boundary runs; real guest watcher/outbox, VM, capture convergence and full per-run artifacts remain unqualified' : boundaryOnly ? 'ten host/native boundary repetitions; full-check client-text/row artifacts and the remaining matrix are not qualified' : 'complete real watcher/host/PostgreSQL/VM writer/receipt/head matrix remains unqualified; K4/K4b host evidence is available separately via --host-only' })) }
  await writeFile(join(directory, 'summary.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' })
  console.log(`${result.status}: ${directory}`)
  return componentStatus === 'failed' ? 1 : componentsOnly || boundaryOnly ? 0 : 2
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await run({ componentsOnly: process.argv.includes('--components-only'), wikiOnly: process.argv.includes('--wiki-only'), codeOnly: process.argv.includes('--code-only'), hostOnly: process.argv.includes('--host-only') })
