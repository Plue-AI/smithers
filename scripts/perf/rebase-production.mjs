import { createRequire } from 'node:module'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { publicOrigin, readHost } from './lib/host.mjs'
import { authenticatedMember } from './lib/member.mjs'
import { authenticatedSSHKey, identityPath } from './lib/ssh-member.mjs'
import { acknowledgementDelay } from './lib/ack-delay.mjs'
import { requireMachineQualification } from './lib/qualification.mjs'
import { measure } from './rebase-hold.mjs'

const execute = promisify(execFile)
export function configuration(env) {
  const origin = publicOrigin(env.SMITHERS_PERF_ORIGIN)
  const page = new URL(env.SMITHERS_PERF_PAGE, origin)
  if (!env.SMITHERS_PERF_PAGE || page.origin !== origin) throw new Error('same-origin repository page required')
  for (const name of ['SMITHERS_PERF_OWNER_COOKIE', 'SMITHERS_PERF_MEMBER_A', 'SMITHERS_PERF_BRANCH', 'SMITHERS_PERF_TODO', 'SMITHERS_PERF_INSTALL_VERSION', 'SMITHERS_PERF_REBASE_LOG', 'SMITHERS_PERF_REPOSITORY']) {
    if (!env[name]) throw new Error(`${name} required`)
  }
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(env.SMITHERS_PERF_BRANCH) || !/^[1-9][0-9]*$/.test(env.SMITHERS_PERF_TODO)) throw new Error('branch UUID and TODO number required')
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9.-]*$/.test(env.SMITHERS_PERF_SSH_DESTINATION ?? '')) throw new Error('branch SSH destination required')
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(env.SMITHERS_PERF_REPOSITORY) || env.SMITHERS_PERF_REPOSITORY.split('/').some(part => part === '..')) throw new Error('scratch owner/repository required')
  const delay = acknowledgementDelay({ origin, branch: env.SMITHERS_PERF_BRANCH, cookie: env.SMITHERS_PERF_OWNER_COOKIE })
  return { origin, page: page.href, branch: env.SMITHERS_PERF_BRANCH, todo: env.SMITHERS_PERF_TODO, identity: identityPath(env), destination: env.SMITHERS_PERF_SSH_DESTINATION, delay }
}

/** Logs are an export of the installed guest observer, like the warm-wake host
 * log. A partial tail, duplicate receipt or foreign branch cannot qualify. The
 * occupied-rebase producer belongs to T-STK-08; no script invents its evidence. */
export async function observations(path, branch, onto) {
  const text = await readFile(path, 'utf8')
  const lines = text.split('\n'); lines.pop()
  return lines.filter(Boolean).map(line => JSON.parse(line)).filter(row => row.branch === branch && row.onto === onto)
}

export function verifyCaptureDelay(receipt, hold) {
  if (receipt.state !== 'acknowledged' || receipt.event !== hold.capture?.event || receipt.boot !== hold.capture?.boot || receipt.sequence !== hold.capture?.sequence || !Number.isFinite(receipt.withheld_ms) || receipt.withheld_ms < 10000) throw new Error('host delay does not bind the guest capture')
  if (hold.acknowledgedBeforeThaw !== false || hold.localSnapshotQueued !== true) throw new Error('guest did not queue and thaw before host acknowledgement')
  return receipt
}

export async function run(env = process.env, { persist = false } = {}) {
  if (persist) throw new Error('use the shared performance runner for artifacts')
  const result = { status: 'failed', samples: [] }
  let browser, config
  try {
    requireMachineQualification()
    config = configuration(env)
    result.origin = config.origin
    result.commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    result.installVersion = env.SMITHERS_PERF_INSTALL_VERSION
    result.host = await readHost(config.origin, { cookie: env.SMITHERS_PERF_OWNER_COOKIE })
    const require = createRequire(resolve('apps/app/package.json'))
    const { chromium } = require('@playwright/test')
    browser = await chromium.launch()
    result.browser = browser.version()
    const context = await browser.newContext({ storageState: env.SMITHERS_PERF_MEMBER_A })
    result.member = await authenticatedMember(context, config.origin)
    result.sshFingerprint = await authenticatedSSHKey(context, config.origin, config.identity)
    const page = await context.newPage()
    await page.goto(config.page)
    const say = async text => {
      await page.getByTestId('composer-input').fill(text)
      await page.getByTestId('composer-input').press('Enter')
    }
    await say(`/branch T${config.todo}`)
    await say('/file src/target.ts')
    await page.locator('.cm-content[contenteditable="true"]').waitFor({ timeout: 15000 })
    await page.evaluate(async ({origin, branch}) => {
      window.__rebaseBranch = undefined
      window.__rebaseFailure = undefined
      const socket = new WebSocket(origin.replace(/^http/, 'ws') + '/api/live', 'smithers.live.v1')
      window.__rebaseSocket = socket
      socket.onopen = () => socket.send(JSON.stringify({t:'sub',id:906,topic:`branch:${branch}`}))
      socket.onerror = () => { window.__rebaseFailure = 'branch live socket failed' }
      socket.onclose = () => { window.__rebaseFailure = 'branch live socket closed' }
      socket.onmessage = ({data}) => {
        if (typeof data !== 'string') return
        const frame = JSON.parse(data)
        if (frame.t === 'gap' || frame.t === 'err') window.__rebaseFailure = 'branch live stream refused or recovered'
        if (frame.id === 906 && ['snap','delta'].includes(frame.t)) window.__rebaseBranch = frame.data
      }
    }, {origin:config.origin,branch:config.branch})
    const csrf = env.SMITHERS_PERF_OWNER_COOKIE.match(/(?:^|;\s*)__csrf=([^;]+)/)[1]
    const ownerRequest = async (path, method, status) => {
      const response = await fetch(`${config.origin}${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(30000), headers: { Cookie: env.SMITHERS_PERF_OWNER_COOKIE, Origin: config.origin, 'X-CSRF-Token': csrf } })
      if (response.status !== status) throw new Error(`${method} ${path}: ${response.status}`)
      return response.json()
    }
    const wait = async predicate => {
      const deadline = performance.now() + 30000
      do {
        const value = await predicate()
        if (value) return value
        await new Promise(resolveWait => setTimeout(resolveWait, 10))
      } while (performance.now() < deadline)
      throw new Error('production rebase observation timed out')
    }
    let main, typed, baseline, hold, armed
    const guestSSH = async command => (await execute('/usr/bin/ssh', ['-i', config.identity, '-o', 'IdentitiesOnly=yes', '-o', 'IdentityAgent=none', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-p', '2222', '--', config.destination, command], { timeout: 30000, maxBuffer: 4 << 20 })).stdout.trim()
    if (await guestSSH('git -C .smithers-perf-main symbolic-ref --short HEAD') !== 'main') throw new Error('scratch fixture must be on main')
    const remote = await guestSSH('git -C .smithers-perf-main remote get-url origin')
    if (![ `https://github.com/${env.SMITHERS_PERF_REPOSITORY}.git`, `git@github.com:${env.SMITHERS_PERF_REPOSITORY}.git` ].includes(remote)) throw new Error('scratch fixture remote differs from configured repository')
    const records = () => observations(env.SMITHERS_PERF_REBASE_LOG, config.branch, main)
    const memberRead = async path => {
      const response = await context.request.get(`${config.origin}${path}`, { maxRedirects: 0, timeout: 10000 })
      if (response.status() !== 200) throw new Error(`GET ${path}: ${response.status()}`)
      return response.json()
    }
    result.metricsCrossCheck = { before: await ownerRequest('/api/install/metrics', 'GET', 200) }
    const boundary = {
      async acknowledgementWindow(ms) { armed = await config.delay.arm(ms) },
      async pushScratchMain(i, withheld) {
        // Fixture clone and its GitHub login live inside the guest. The Mac
        // executes only SSH; scratch commands never run on the Mac or as root.
        const name = `${withheld ? 'delay' : 'normal'}-${i}`
        main = await guestSSH(`git -C .smithers-perf-main -c core.hooksPath=/dev/null commit --allow-empty -m 'C-PERF-06 ${name}' >/dev/null && git -C .smithers-perf-main -c core.hooksPath=/dev/null push origin HEAD:main >/dev/null && git -C .smithers-perf-main rev-parse HEAD`)
        baseline = new Set((await memberRead(`/api/branches/${config.branch}/activity`)).map(entry => entry.id))
        return main
      },
      retryGitHubSync: () => ownerRequest('/api/github/sync', 'POST', 202),
      async waitRebasePending(onto) {
        await page.getByText('Rebase pending', { exact: true }).last().waitFor({ timeout: 30000 })
        const todo = await memberRead(`/api/todos/${config.todo}`)
        if (!todo.rebase_pending) throw new Error('rendered pending state has no committed TODO fact')
        // T-STK-08 must export the actual target SHA; a label such as "main"
        // cannot bind the pending observation to the scratch push.
        if (todo.rebase_pending.onto_revision !== onto) throw new Error('T-STK-08 pending target receipt unavailable or mismatched')
        const presence = await wait(async () => {
          const observed = await page.evaluate(() => ({branch:window.__rebaseBranch,error:window.__rebaseFailure}))
          if (observed.error) throw new Error(observed.error)
          return observed.branch?.presence?.some(entry => entry.actor?.kind === 'person' && entry.actor?.login === result.member.username) ? observed.branch : undefined
        })
        if (presence.id !== config.branch || presence.rebase?.state !== 'pending') throw new Error('authenticated branch presence or pending projection missing')
        return { presence, state: 'pending', present: true, onto, rebased: false, member: String(result.member.id), fact: todo.rebase_pending }
      },
      async pressRebaseNow() { await page.getByRole('button', { name: 'Rebase now', exact: true }).last().press('Enter') },
      async waitWriteHold() {
        await wait(async () => (await records()).some(row => row.phase === 'held' && row.id))
      },
      async typeMarker(marker) {
        typed = marker
        await page.locator('.cm-content').click()
        await page.keyboard.type(marker)
      },
      async waitRebased(onto) {
        hold = await wait(async () => {
          const completed = (await records()).filter(row => row.phase === 'thawed')
          if (completed.length > 1) throw new Error('duplicate guest rebase receipt')
          return completed[0]
        })
        if (hold.failed !== false || hold.marker?.text !== typed || hold.marker?.member !== String(result.member.id) || hold.marker?.typedDuringHold !== true) throw new Error('guest held marker evidence missing')
        await page.waitForFunction(marker => document.querySelector('.cm-content')?.textContent.includes(marker), typed)
        const entries = (await memberRead(`/api/branches/${config.branch}/activity`)).filter(entry => !baseline.has(entry.id) && entry.kind === 'rebase')
        if (entries.length !== 1 || entries[0].onto_revision !== onto || entries[0].receipt_id !== hold.id) throw new Error('T-STK-08 activity receipt unavailable or mismatched')
        const todo = await memberRead(`/api/todos/${config.todo}`)
        if (todo.rebase_pending) throw new Error('rebase remains pending')
        return { id: hold.id, onto, headChanged: hold.headChanged, approvalsCleared: hold.approvalsCleared, marker: hold.marker, activity: entries.map(entry => ({ ...entry, onto })) }
      },
      async guestHold(id) {
        if (id !== hold.id) throw new Error('guest hold receipt mismatch')
        return hold
      },
      async waitOutboxDrained(id) {
        const drained = await wait(async () => (await records()).find(row => row.phase === 'drained' && row.id === id && row.capture?.event === hold.capture?.event))
        const delay = await wait(async () => {
          const receipt = await config.delay.read()
          if (receipt.state === 'failed' || receipt.state === 'expired') throw new Error('capture delay failed')
          return receipt.state === 'acknowledged' && receipt.id === armed.id ? receipt : undefined
        })
        verifyCaptureDelay(delay, hold)
        if (drained.outboxDepth !== 0) throw new Error('guest outbox did not drain')
        hold.acknowledgementReceipt = delay
        hold.withheldMs = delay.withheld_ms
        hold.drainObservation = drained
      }
    }
    const measured = await measure(boundary)
    result.metricsCrossCheck.after = await ownerRequest('/api/install/metrics', 'GET', 200)
    result.samples = measured.samples
    result.stats = measured.stats
    result.status = 'passed'
  } catch (error) {
    result.error = error.message
    if (error.samples) result.samples = error.samples
    if (error.cleanupError) result.cleanupError = error.cleanupError
  } finally { await browser?.close() }
  return { result }
}
