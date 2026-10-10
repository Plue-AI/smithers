// Observe real state/process transitions, kill only the process group this
// recorder creates, and verify lease expiry through the served TODO route.
// A checkpoint that passes too quickly to observe FAILS, rather than granting
// a synthetic checkpoint or marking a fault as exercised.
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { lstat, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { config, run, save, mainURL } from './host-maintenance-evidence.mjs'

export const killPoints = ['freeze', 'drain', 'capture', 'pg_dump', 'clone', 'manifest']
async function entries(path) { try { return await readdir(path) } catch (error) { if (error.code === 'ENOENT') return []; throw error } }
async function exists(path) { try { return await lstat(path) } catch (error) { if (error.code === 'ENOENT') return null; throw error } }

export async function fault(path, point) {
  if (!killPoints.includes(point)) throw new Error('unknown backup kill point')
  const c = await config(path)
  if (!c.database || !c.api || !c.authHeaders || !c.todo || !c.evidence) throw new Error('database, owner API authentication and literal TODO probe required')
  const output = join(c.state, 'backups')
  const old = new Set(await entries(output))
  const env = { HOME: process.env.HOME, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }
  const child = spawn(c.cli, ['host', 'backup'], { detached: true, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = '', ended = false, status
  child.stdout.on('data', b => { stdout += b })
  child.stderr.on('data', b => { stderr += b })
  const completion = new Promise((yes, no) => {
    child.once('error', error => { ended = true; no(error) })
    child.once('close', (code, signal) => { ended = true; status = { code, signal }; yes(status) })
  })
  // Attach rejection immediately while polling so a spawn error cannot become
  // an unhandled rejection. Await completion still propagates it below.
  completion.catch(() => {})
  const began = Date.now()
  let observed = null, killed = false
  try {
    while (!ended && Date.now() - began < 120_000) {
      const q = "SELECT COALESCE((SELECT value::text FROM install_settings WHERE key='quiesce'), 'null')"
      const freeze = JSON.parse((await run(c.psql, ['-X', '-qAt', '-c', q], { env: { PGDATABASE: c.database, PGOPTIONS: '-c default_transaction_read_only=on' } })).stdout)
      const partial = (await entries(output)).filter(name => !old.has(name) && name.startsWith('.partial-'))
      const processes = (await run('/bin/ps', ['-axo', 'uid=,pid=,ppid=,command='])).stdout
      let hit = false
      const current = !!freeze && typeof freeze.op === 'string' && freeze.op.startsWith('backup-') && Date.parse(freeze.since) >= began
      if (point === 'freeze') hit = current
      if (point === 'drain') hit = current && freeze.ready === false
      if (point === 'capture' && current && !freeze.ready) {
        // Releasing is the durable branch transition before final capture and
        // confirmed VM stop in workspace_sleep.go.
        const result = await run(c.psql, ['-X', '-qAt', '-c', "SELECT count(*) FROM workspaces WHERE status='releasing'"], { env: { PGDATABASE: c.database, PGOPTIONS: '-c default_transaction_read_only=on' } })
        hit = Number(result.stdout.trim()) > 0
      }
      if (point === 'pg_dump') hit = current && processes.split('\n').some(line => /^\s*\d+\s+\d+\s+\d+\s+.*\/pg_dump(?:\s|$)/.test(line) && Number(line.trim().split(/\s+/)[0]) === process.getuid())
      for (const name of partial) {
        const dir = join(output, name)
        if (point === 'clone') hit ||= current && (await entries(dir)).includes('state') && !(await exists(join(dir, 'MANIFEST.json')))
        if (point === 'manifest') hit ||= current && !!(await exists(join(dir, 'MANIFEST.json')))
      }
      if (hit && !ended) {
        observed = { at: new Date().toISOString(), point, pid: child.pid, freeze, partial, processes }
        // This is exclusively our detached child group, never a service or VM.
        process.kill(-child.pid, 'SIGKILL')
        killed = true
        break
      }
      await sleep(10)
    }
    if (!killed) throw new Error(`checkpoint not observed before backup ended: ${point}`)
    await completion
    await sleep(31_000)
    const created = (await entries(output)).filter(name => !old.has(name))
    for (const name of created) {
      if (!name.startsWith('.partial-') || await exists(join(output, name, 'MANIFEST.json'))) throw new Error(`killed backup published a manifest: ${name}`)
    }
    const probe = await fetch(new URL('/api/todos', c.api), { method: 'POST', headers: { 'Content-Type': 'application/json', ...c.authHeaders }, body: JSON.stringify(c.todo), signal: AbortSignal.timeout(15_000) })
    const body = await probe.text()
    if (probe.status !== 202) throw new Error(`TODO admission did not reopen: HTTP ${probe.status}`)
    await save(c, `fault-${point}.json`, { commit: c.commit, observed, status, stdout, stderr, created, probe: { status: probe.status, body }, pass: true })
  } catch (error) {
    await save(c, `fault-${point}-failed.json`, { commit: c.commit, observed, status, stdout, stderr, error: error.message, pass: false })
    throw error
  } finally {
    if (!ended && !killed) process.kill(-child.pid, 'SIGKILL')
    await completion
  }
}
if (mainURL(import.meta.url)) fault(...process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1 })
