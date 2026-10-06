import { execFileSync, spawn } from 'node:child_process'
import { mkdir, lstat, writeFile } from 'node:fs/promises'
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
export async function run({ root = process.cwd(), componentsOnly = false } = {}) {
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
  await writeFile(join(directory, 'env.json'), JSON.stringify(env, null, 2) + '\n', { flag: 'wx' })
  const args = ['test', '--locked', '-p', 'smithers-machined', '--features', 'testing,killpoints', ...suites.flatMap(suite => ['--test', suite]), '--', '--test-threads=1']
  let logs = ''
  const code = await new Promise(resolve => {
    const child = spawn('cargo', args, { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { logs += data; process.stdout.write(data) })
    child.on('error', error => { logs += error.message; resolve(1) })
    child.on('close', code => resolve(code))
  })
  await writeFile(join(directory, 'components.log'), logs, { flag: 'wx' })
  const componentStatus = verdict(code, logs)
  const result = { ...env, timestamp, status: componentStatus === 'failed' ? 'failed' : 'incomplete', componentStatus,
    command: ['cargo', ...args], points: points.map(point => ({ point, status: 'blocked',
      reason: 'integrated packages/backend/internal/machined/fault_test.go is absent; component fixtures do not run the C-DUR-04 writer/receipt/head/browser matrix' })) }
  await writeFile(join(directory, 'summary.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' })
  console.log(`${result.status}: ${directory}`)
  return componentStatus === 'failed' ? 1 : componentsOnly ? 0 : 2
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await run({ componentsOnly: process.argv.includes('--components-only') })
