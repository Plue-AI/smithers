// Run with Node, outside Bun's synchronous child-process implementation.
import { spawn, spawnSync } from 'node:child_process'
import { readFileSync, readdirSync, readlinkSync } from 'node:fs'
const request = JSON.parse(readFileSync(0, 'utf8'))
const { command, args, options } = request
let child, timer, finished = false
const stdout = [], stderr = []
let bytes = 0
const finish = (status, signal, error) => {
  if (finished) return
  finished = true
  clearTimeout(timer)
  process.stderr.write('', () => process.stdout.write(JSON.stringify({ pid: child?.pid, supervisorPid: process.pid, status, signal, error,
    stdout: Buffer.concat(stdout).toString('base64'), stderr: Buffer.concat(stderr).toString('base64') }), () => process.exit(0)))
}
const kill = () => {
  if (!child?.pid) return
  try { process.kill(-child.pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
}
const diagnostics = () => {
  const ps = spawnSync('/bin/ps', process.platform === 'darwin' ? ['-axo', 'pid,ppid,pgid,state,command'] : ['-ef', '--forest'],
    { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 1000 })
  process.stderr.write(`[test-child timeout] pid=${child.pid} command=${command}\n${ps.stdout ?? ''}\n`)
  if (process.platform === 'linux') {
    // Include descendants: the leader may have exited while a grandchild holds stdout open.
    for (const pid of readdirSync('/proc').filter(name => /^\d+$/.test(name))) {
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')
        if (Number(stat[2]) !== child.pid) continue // process group, after comm and state
        const fds = readdirSync(`/proc/${pid}/fd`).map(fd => {
          try { return `${fd} -> ${readlinkSync(`/proc/${pid}/fd/${fd}`)}` } catch { return `${fd} -> unavailable` }
        })
        process.stderr.write(`[pid ${pid}] descriptors:\n${fds.join('\n')}\n`)
        for (const file of ['stack', 'wchan', 'status']) {
          try { process.stderr.write(`${file}: ${readFileSync(`/proc/${pid}/${file}`, 'utf8')}\n`) }
          catch (error) { process.stderr.write(`${file}: ${error.code}\n`) }
        }
      } catch { /* Process exited during inspection. */ }
    }
  } else {
    for (const [cmd, argv] of [['/usr/sbin/lsof', ['-p', String(child.pid)]], ['/usr/bin/sample', [String(child.pid), '1', '1']]]) {
      const result = spawnSync(cmd, argv, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 2000 })
      process.stderr.write(`${cmd}:\n${result.stdout ?? ''}${result.stderr ?? ''}\n`)
    }
  }
}
try {
  child = spawn(command, args, { cwd: options.cwd, env: options.env, detached: true,
    stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] })
  if (options.input !== undefined) {
    child.stdin.on('error', () => {}) // The child can close stdin before consuming all input.
    child.stdin.end(Buffer.from(options.input, 'base64'))
  }
  for (const [stream, chunks] of [[child.stdout, stdout], [child.stderr, stderr]]) stream.on('data', chunk => {
    bytes += chunk.length
    if (bytes > (options.maxBuffer ?? 16 * 1024 * 1024)) { kill(); finish(null, 'SIGKILL', { code: 'ENOBUFS', message: 'child output exceeded maxBuffer' }) }
    else chunks.push(chunk)
  })
  child.on('error', error => finish(null, null, { code: error.code, message: error.message }))
  child.on('close', (status, signal) => { kill(); finish(status, signal) })
  timer = setTimeout(() => {
    diagnostics()
    kill()
    finish(null, 'SIGKILL', { code: 'ETIMEDOUT', message: `child exceeded ${options.timeout}ms` })
  }, options.timeout)
} catch (error) { kill(); finish(null, null, { code: error.code, message: error.message }) }
