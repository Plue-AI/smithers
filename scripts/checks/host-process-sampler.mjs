import { execFile } from 'node:child_process'
import { parseArgs, promisify } from 'node:util'
import { appendFile, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const execute = promisify(execFile)
export function descendants(text, rootPid) {
  const rows = text.split('\n').flatMap(line => {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/)
    return m ? [{ pid: +m[1], ppid: +m[2], uid: +m[3], command: m[4] }] : []
  })
  const ids = new Set([rootPid])
  let changed = true
  while (changed) {
    changed = false
    for (const row of rows) if (ids.has(row.ppid) && !ids.has(row.pid)) { ids.add(row.pid); changed = true }
  }
  return rows.filter(row => ids.has(row.pid))
}
export async function sample({ rootPid, label, directory, exec = execute, now = () => new Date().toISOString() }) {
  await mkdir(directory, { recursive: true })
  await appendFile(join(directory, 'lsof-samples.jsonl'), '')
  const at = now()
  if (label) {
    const job = await exec('launchctl', ['print', label])
    rootPid = Number(job.stdout.match(/\bpid = (\d+)/)?.[1])
  }
  if (!Number.isSafeInteger(rootPid) || rootPid <= 0) throw new Error('sampler: live root PID required')
  const result = await exec('ps', ['-axo', 'pid,ppid,uid,command'])
  const processes = descendants(result.stdout, rootPid)
  await appendFile(join(directory, 'process-samples.jsonl'), JSON.stringify({ at, root: rootPid, processes }) + '\n')
  for (const row of processes) {
    const binary = row.command.split(/\s+/)[0].split('/').at(-1)
    if (!/^(node|bun|smithers-.*)$/.test(binary)) continue
    let observation
    try { const result = await exec('lsof', ['-p', String(row.pid), '-Fn']); observation = { stdout: result.stdout, stderr: result.stderr ?? '', exitCode: 0 } }
    catch (error) { observation = { exitCode: error.code, stdout: error.stdout ?? '', stderr: error.stderr || error.message } }
    await appendFile(join(directory, 'lsof-samples.jsonl'), JSON.stringify({ at, ...row, ...observation }) + '\n')
  }
  return { rootPid, processes }
}
export async function monitor(options, { signal, interval = 250, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), clock = Date.now } = {}) {
  while (!signal?.aborted) {
    const start = clock()
    const observation = await sample(options)
    if (!observation.processes.some(row => row.pid === observation.rootPid)) break
    if (!signal?.aborted) await sleep(Math.max(0, interval - (clock() - start)))
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: {
    pid: { type: 'string' }, label: { type: 'string' }, output: { type: 'string' }, interval: { type: 'string', default: '250' }
  } })
  const rootPid = Number(values.pid), interval = Number(values.interval)
  if ((!values.label && (!Number.isSafeInteger(rootPid) || rootPid <= 1)) || (values.label && values.pid) || !values.output || !Number.isSafeInteger(interval) || interval < 25) throw new Error('usage: host-process-sampler.mjs --pid <pid> | --label <launchd domain/label> --output <directory> [--interval 250]')
  const controller = new AbortController()
  for (const name of ['SIGTERM', 'SIGINT']) process.once(name, () => controller.abort())
  await monitor({ rootPid, label: values.label, directory: values.output }, { signal: controller.signal, interval })
}
