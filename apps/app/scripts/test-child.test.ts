import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from './test-child'

test('captured subprocess has closed stdin, preserves output and exit status', () => {
  const child = spawnSync('node', ['-e', `const fs=require('fs'); console.log(fs.readFileSync(0).length); console.error('error'); process.exitCode=7`], { encoding: 'utf8' })
  expect(child.status).toBe(7)
  expect(child.stdout).toBe('0\n')
  expect(child.stderr).toBe('error\n')
  expect(child.error).toBeUndefined()
})

test('explicit input, buffers and missing executable keep the spawn contract', () => {
  const child = spawnSync('node', ['-e', `process.stdin.pipe(process.stdout)`], { input: 'payload' })
  expect(Buffer.isBuffer(child.stdout)).toBe(true)
  expect(child.stdout.toString()).toBe('payload')
  const absent = spawnSync('/does/not/exist', [], { encoding: 'utf8' })
  expect((absent.error as NodeJS.ErrnoException).code).toBe('ENOENT')
})

test('timeout bounds a leader that exits while a descendant holds its pipes', () => {
  const root = mkdtempSync(join(tmpdir(), 'test-child-'))
  try {
    const pidFile = join(root, 'pid')
    const start = Date.now()
    const child = spawnSync('node', ['-e', `
      const {spawn}=require('child_process'); const fs=require('fs');
      const child=spawn('node',['-e','setInterval(()=>{},1000)'],{stdio:['ignore',1,2]});
      fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid)); child.unref();
    `], { encoding: 'utf8', timeout: 500 })
    expect((child.error as NodeJS.ErrnoException).code).toBe('ETIMEDOUT')
    expect(Date.now() - start).toBeLessThan(5000)
    const pid = Number(readFileSync(pidFile, 'utf8'))
    // A killed orphan may briefly be a zombie until init reaps it.
    if (process.platform === 'linux') {
      try { expect(readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].startsWith('Z ')).toBe(true) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('timeout emits process tree, descriptor and stack diagnostics before killing the child', async () => {
  const { spawnSync: native } = await import('node:child_process')
  const result = native('node', [join(import.meta.dir, 'test-child-supervisor.mjs')], {
    input: JSON.stringify({ command: 'node', args: ['-e', 'setInterval(()=>{},1000)'], options: { timeout: 100 } }),
    encoding: 'utf8', timeout: 5000, maxBuffer: 16 * 1024 * 1024
  })
  expect(result.status).toBe(0)
  expect(JSON.parse(result.stdout).error.code).toBe('ETIMEDOUT')
  expect(result.stderr).toContain('[test-child timeout]')
  expect(result.stderr).toContain('PID')
  if (process.platform === 'linux') {
    expect(result.stderr).toContain('descriptors:')
    expect(result.stderr).toContain('stack:')
    expect(result.stderr).toContain('wchan:')
  } else {
    expect(result.stderr).toContain('/usr/sbin/lsof:')
    expect(result.stderr).toContain('/usr/bin/sample:')
  }
})

test('excess output is bounded and terminates the process group', () => {
  const child = spawnSync('node', ['-e', `setInterval(()=>process.stdout.write('x'.repeat(1024)),1)`], { maxBuffer: 128 })
  expect((child.error as NodeJS.ErrnoException).code).toBe('ENOBUFS')
  expect(child.signal).toBe('SIGKILL')
})
