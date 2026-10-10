import { spawnSync as nativeSpawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Node supervises the process group while Bun's calling test is blocked. Only
// descriptors 0/1/2 are passed; stdin is /dev/null unless explicit input exists.
export const spawnSync: typeof nativeSpawnSync = ((command: string, args: string[] = [], options: any = {}) => {
  const timeout = options.timeout || 30_000
  const request = { command, args, options: { ...options, timeout,
    cwd: options.cwd instanceof URL ? fileURLToPath(options.cwd) : options.cwd,
    input: options.input === undefined ? undefined : Buffer.from(options.input).toString('base64') } }
  const result = nativeSpawnSync(typeof Bun === 'undefined' ? process.execPath : Bun.which('node')!, [fileURLToPath(new URL('./test-child-supervisor.mjs', import.meta.url))], {
    input: JSON.stringify(request), encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'],
    timeout: timeout + 10_000, killSignal: 'SIGKILL', maxBuffer: (options.maxBuffer ?? 16 * 1024 * 1024) * 2 + 4096
  })
  if (result.error) throw result.error
  const child = JSON.parse(result.stdout)
  for (const key of ['stdout', 'stderr']) {
    const buffer = Buffer.from(child[key], 'base64')
    child[key] = options.encoding && options.encoding !== 'buffer' ? buffer.toString(options.encoding) : buffer
  }
  child.output = [null, child.stdout, child.stderr]
  if (child.error) child.error = Object.assign(new Error(child.error.message), child.error)
  return child
}) as typeof nativeSpawnSync
