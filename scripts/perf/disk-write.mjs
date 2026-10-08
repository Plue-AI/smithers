import { requireMachineQualification } from './lib/qualification.mjs'
import { runSelected } from './run.mjs'
import { createRequire } from 'node:module'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { publicOrigin, readHost } from './lib/host.mjs'
import { authenticatedMember, distinctMembers } from './lib/member.mjs'
import { authenticatedSSHKey, identityPath } from './lib/ssh-member.mjs'
import { summarize } from './lib/stats.mjs'
import { writeRun } from './lib/artifact.mjs'

const execute = promisify(execFile)
export const markers = Array.from({ length: 200 }, (_, i) => `// m${i + 1}`)
export function configuration(env) {
  const origin = publicOrigin(env.SMITHERS_PERF_ORIGIN)
  const page = new URL(env.SMITHERS_PERF_PAGE, origin)
  if (!env.SMITHERS_PERF_PAGE || page.origin !== origin) throw new Error('same-origin repository page required')
  for (const key of ['SMITHERS_PERF_MEMBER_A', 'SMITHERS_PERF_MEMBER_C', 'SMITHERS_PERF_OWNER_COOKIE', 'SMITHERS_PERF_INSTALL_VERSION', 'SMITHERS_PERF_SSH_MEMBER']) {
    if (!env[key]) throw new Error(`${key} required`)
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9.-]*$/.test(env.SMITHERS_PERF_SSH_DESTINATION ?? '')) throw new Error('branch SSH destination required')
  if (!/^[^:\s/\\]+$/.test(env.SMITHERS_PERF_BRANCH ?? '')) throw new Error('branch id required')
  const identity = identityPath(env)
  return { identity, origin, page: page.href, destination: env.SMITHERS_PERF_SSH_DESTINATION, branch: env.SMITHERS_PERF_BRANCH }
}
export function verifySample(text, expected, hint, member) {
  if (text !== expected) throw new Error('card and independently read machine bytes differ')
  const digest = createHash('sha256').update(expected).digest('hex')
  if (hint?.path !== 'src/a.ts' || hint.post_digest !== digest) throw new Error('file hint missing or digest differs from machine')
  if (hint.actor?.member_id !== member || hint.actor.via !== 'ssh') throw new Error('outside write is not attributed to the SSH member')
  return digest
}
// Activity is a log topic: both snapshots and deltas carry entry arrays.
export function activityEntries(frames) {
  if (frames.some(frame => frame.t === 'err' || frame.t === 'gap')) throw new Error('live subscription failed during measurement')
  return frames.filter(frame => frame.id === 802 && ['snap', 'delta'].includes(frame.t)).flatMap(frame => {
    if (!Array.isArray(frame.data)) throw new Error('activity frame must be an entry array')
    return frame.data
  })
}
export function verifyActivity(entries, baseline, member) {
  const added = entries.filter(entry => !baseline.has(entry.id))
  if (added.length !== 200 || new Set(added.map(entry => entry.id)).size !== 200) throw new Error('requires 200 distinct new activity entries')
  for (const entry of added) {
    if (entry.kind !== 'burst' || entry.actor?.member_id !== member || entry.actor.via !== 'ssh' || entry.files?.length !== 1 || entry.files[0].path !== 'src/a.ts') throw new Error('activity does not describe one SSH member file write')
  }
  return added
}

// Serialized into the real browser; the composed-router test uses the same
// subscriber with a real WebSocket transport and authenticated session.
export async function subscribeFiles({ origin, branch }) {
  window.__diskFrames = []
  window.__diskSocket = new WebSocket(origin.replace(/^http/, 'ws') + '/api/live', 'smithers.live.v1')
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('live subscription timeout')), 10000)
    const seen = new Set()
    window.__diskSocket.onopen = () => {
      for (const [id, suffix] of [[801, 'files'], [802, 'activity']]) window.__diskSocket.send(JSON.stringify({ t: 'sub', id, topic: `branch:${branch}:${suffix}` }))
    }
    window.__diskSocket.onerror = () => { clearTimeout(timer); reject(new Error('live socket failed')) }
    window.__diskSocket.onmessage = ({ data }) => {
      if (typeof data !== 'string') return
      const frame = JSON.parse(data)
      window.__diskFrames.push(frame)
      if (frame.t === 'err' || frame.t === 'gap') { clearTimeout(timer); reject(new Error(`live publisher refused: ${frame.code ?? frame.t}`)); return }
      if (frame.t === 'snap') seen.add(frame.id)
      if (seen.has(801) && seen.has(802)) { clearTimeout(timer); resolve() }
    }
  })
}

export async function run(env = process.env, { persist = true } = {}) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const result = { timestamp, check: 'C-PERF-04', status: 'failed', samples: [], clock: 'second Mac Node performance.now(): SSH submission to browser binding (upper bound)' }
  let browser, directory, ssh, masterStarted = false
  try {
    result.machineQualification = await requireMachineQualification({ ...env, SMITHERS_PERF_COMMIT: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() })
    const config = configuration(env)
    result.origin = config.origin
    result.host = await readHost(config.origin, { cookie: env.SMITHERS_PERF_OWNER_COOKIE })
    result.commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    result.installVersion = env.SMITHERS_PERF_INSTALL_VERSION
    const require = createRequire(resolve('apps/app/package.json'))
    const { chromium } = require('@playwright/test')
    browser = await chromium.launch()
    result.browser = browser.version()
    const context = await browser.newContext({ storageState: env.SMITHERS_PERF_MEMBER_A, permissions: ['clipboard-read', 'clipboard-write'] })
    result.member = await authenticatedMember(context, config.origin)
    const sshContext = await browser.newContext({ storageState: env.SMITHERS_PERF_MEMBER_C })
    result.sshMember = await authenticatedMember(sshContext, config.origin)
    distinctMembers([result.member, result.sshMember])
    if (String(result.sshMember.id) !== env.SMITHERS_PERF_SSH_MEMBER) throw new Error('SSH member differs from authenticated fixture')
    result.sshFingerprint = await authenticatedSSHKey(sshContext, config.origin, config.identity)
    await sshContext.close()
    const page = await context.newPage()
    let arrival, resolveArrival
    await page.exposeBinding('__diskArrival', (_, text) => { resolveArrival?.({ text, t1: performance.now() }) })
    await page.goto(config.page)
    await page.getByTestId('composer-input').fill('/file src/a.ts')
    await page.getByTestId('composer-input').press('Enter')
    await page.locator('.cm-content').waitFor({ timeout: 15000 })
    // Subscribe independently: an unsupported publisher fails before any write.
    await page.evaluate(subscribeFiles, config)
    const initial = await page.evaluate(() => window.__diskFrames)
    if (!initial.some(frame => frame.id === 802 && frame.t === 'snap')) throw new Error('activity snapshot required')
    const activity = activityEntries(initial)
    const baseline = new Set(activity.map(entry => entry.id))
    directory = await mkdtemp(join(tmpdir(), 'smthrs-disk-'))
    const control = join(directory, 'ssh')
    ssh = ['-i', config.identity, '-o', 'IdentitiesOnly=yes', '-o', 'IdentityAgent=none', '-p', '2222', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ControlMaster=no', '-S', control]
    await execute('/usr/bin/ssh', [...ssh, '-o', 'ControlMaster=yes', '-o', 'ControlPersist=10m', '-MNf', '--', config.destination], { timeout: 15000 })
    masterStarted = true
    // If the master disappears, refuse instead of opening a measured handshake.
    ssh = [...ssh, '-o', 'ProxyCommand=false']
    const read = async () => (await execute('/usr/bin/ssh', [...ssh, '--', config.destination, 'cat -- src/a.ts'], { timeout: 15000, maxBuffer: 4 << 20 })).stdout
    let expected = await read()
    if (expected && !expected.endsWith('\n')) throw new Error('scratch file must end in a newline')
    if (/^\/\/ m\d+$/m.test(expected)) throw new Error('scratch file already contains measurement markers')
    for (const marker of markers) {
      // A missing master cannot silently put a handshake inside the interval.
      await execute('/usr/bin/ssh', [...ssh, '-O', 'check', '--', config.destination], { timeout: 5000 })
      await page.locator('.cm-content').click()
      await page.keyboard.press('Meta+End')
      arrival = new Promise(resolve => { resolveArrival = resolve })
      const before = await page.evaluate(() => window.__diskFrames.length)
      await page.locator('.cm-content').evaluate((el, marker) => {
        const observer = new MutationObserver(() => {
          if (![...el.querySelectorAll('.cm-line')].some(line => line.textContent === marker)) return
          observer.disconnect(); window.__diskArrival(el.textContent)
        })
        observer.observe(el, { subtree: true, childList: true, characterData: true })
        window.__diskObserver = observer
      }, marker)
      const t0 = performance.now()
      await execute('/usr/bin/ssh', [...ssh, '--', config.destination, `printf '${marker}\\n' >> src/a.ts`], { timeout: 10000 })
      let timer
      const arrived = await Promise.race([arrival, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`card timeout: ${marker}`)), 5000) })]).finally(() => clearTimeout(timer))
      expected += `${marker}\n`
      // Full clipboard text avoids CodeMirror's virtual DOM truncation.
      await page.locator('.cm-content').click()
      await page.keyboard.press('Meta+a'); await page.keyboard.press('Meta+c')
      const text = await page.evaluate(() => navigator.clipboard.readText())
      const disk = await read()
      if (disk !== expected) throw new Error('SSH write changed unexpected bytes')
      const frames = await page.evaluate(before => window.__diskFrames.slice(before), before)
      const hints = frames.filter(frame => frame.id === 801 && frame.t === 'delta').map(frame => frame.data)
      const hint = hints.find(hint => hint?.post_digest === createHash('sha256').update(disk).digest('hex'))
      const digest = verifySample(text, disk, hint, env.SMITHERS_PERF_SSH_MEMBER)
      result.samples.push({ marker, t0, t1: arrived.t1, arrival_ms: arrived.t1 - t0, post_digest: digest, clock: result.clock, failed: false })
      await page.waitForTimeout(Math.max(0, 3000 - (performance.now() - t0)))
    }
    const frames = await page.evaluate(() => window.__diskFrames)
    const entries = activityEntries(frames)
    result.activity = verifyActivity(entries, baseline, env.SMITHERS_PERF_SSH_MEMBER)
    result.summary = summarize(result.samples, ['arrival_ms'], 200)
    if (result.summary.arrival_ms.p95 >= 1000) throw new Error('p95 is not below 1000 ms')
    result.status = 'passed'
  } catch (error) { result.error = error.message }
  finally {
    await browser?.close()
    if (masterStarted) await execute('/usr/bin/ssh', [...ssh, '-O', 'exit', '--', env.SMITHERS_PERF_SSH_DESTINATION], { timeout: 5000 }).catch(() => {})
    if (directory) await rm(directory, { recursive: true, force: true })
  }
  if (!persist) return { result }
  const evidence = await writeRun(process.cwd(), { ...result, budgets: [{ ...result, name: 'disk-write' }] })
  console.log(`${result.status}: ${evidence}${result.error ? ` (${result.error})` : ''}`)
  return result.status === 'passed' ? 0 : 1
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await runSelected('C-PERF-04')
