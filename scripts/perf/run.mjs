#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { isDeepStrictEqual } from 'node:util'
import { pathToFileURL } from 'node:url'
import { publicOrigin, readHost, validateReferenceHost } from './lib/host.mjs'
import { requireMachineQualification } from './lib/qualification.mjs'
import { writeRun } from './lib/artifact.mjs'
import { summarize, summarizeRebases } from './lib/stats.mjs'
import { configuration as agentConfiguration, run as agentRun } from './agent-first-token.mjs'
import { configuration as rebaseConfiguration, run as rebaseRun } from './rebase-production.mjs'
import { configuration as projectionConfiguration, run as projectionRun } from './projection-delta.mjs'

import { configuration as keystrokeConfiguration, run as keystrokeRun } from './keystroke.mjs'
import { configuration as diskConfiguration, run as diskRun } from './disk-write.mjs'
import { configuration as wakeConfiguration, run as wakeRun, verifyWake, summarizeWakes } from './warm-wake.mjs'

// No operator boolean can qualify privileged lifecycle inputs. Until the install
// exposes authenticated qualification, refuse before invoking machine workloads.
function machineProvider(configuration, workload, fields) {
  return {
    available(env, { origin }) {
      const config = configuration(env)
      if (config.origin !== origin) throw new Error('configured measurement origin differs from run')
      requireMachineQualification()
    },
    async measure(env) { return (await workload(env, { persist: false })).result },
    fields
  }
}

// Literal release budgets, not derived from spec text or implementation policy.
// Drivers remain unavailable until their production boundary and security evidence qualify.
export const budgets = [
  { check: 'C-PERF-01', name: 'agent-first-token', minimum: 100, thresholdsMs: { firstToken: 1500, answerWithCards: 8000 }, tickets: ['T-APP-01', 'T-APP-16', 'T-INS-06'] },
  { check: 'C-PERF-02', name: 'projection-delta', minimum: 100, thresholdsMs: { home: 1000, todo: 1000 }, tickets: ['T-COL-02', 'T-STK-01', 'T-ACC-03'] },
  { check: 'C-PERF-03', name: 'keystroke', minimum: 200, thresholdsMs: { remoteCard: 1000 }, tickets: ['T-COL-08', 'T-APP-14'] },
  { check: 'C-PERF-04', name: 'disk-write', minimum: 200, thresholdsMs: { fileReload: 1000 }, tickets: ['T-COL-04', 'T-APP-11', 'T-TRM-03'] },
  { check: 'C-PERF-05', name: 'warm-wake', minimum: 100, thresholdsMs: { awake: 5000 }, tickets: ['T-MCH-06', 'T-MCH-07', 'T-TRM-01'] },
  { check: 'C-PERF-06', name: 'rebase-hold', minimum: 100, thresholdsMs: { writeHold: 2000 }, tickets: ['T-STK-08', 'T-GH-07'] }
]

export const productionProviders = {
  'C-PERF-06': machineProvider(rebaseConfiguration, rebaseRun, { writeHold: 'holdMs' }),
  'C-PERF-03': machineProvider(keystrokeConfiguration, keystrokeRun, { remoteCard: 'arrival_ms' }),
  'C-PERF-04': machineProvider(diskConfiguration, diskRun, { fileReload: 'arrival_ms' }),
  'C-PERF-05': machineProvider(wakeConfiguration, wakeRun, { awake: 'hostMs' }),
  'C-PERF-01': {
    available(env, { origin }) {
      const config = agentConfiguration(env)
      if (config.origin !== origin) throw new Error('configured measurement origin differs from run')
      if (process.platform !== 'darwin') throw new Error('second Mac required')
    },
    async measure(env) { return (await agentRun(env, { persist: false })).result },
    fields: { firstToken: 'firstTokenMs', answerWithCards: 'answerWithCardsMs' }
  },
  'C-PERF-02': {
    available(env, { origin }) {
      const config = projectionConfiguration(env)
      if (config.origin !== origin) throw new Error('configured measurement origin differs from run')
      if (process.platform !== 'darwin') throw new Error('reference-network Mac required')
    },
    async measure(env) { return (await projectionRun(env, { persist: false })).result },
    fields: { home: 'homeMs', todo: 'todoMs' }
  }
}

export async function run({ env = process.env, providers = productionProviders, root = process.cwd(), origin, token, commit, installVersion, browser, read = readHost, timestamp = new Date().toISOString().replace(/[:.]/g, '-'), check }) {
  if (!/^[a-f0-9]{40}$/.test(commit ?? '')) throw new Error('full commit SHA required')
  if (check !== undefined && !budgets.some(budget => budget.check === check)) throw new Error('unknown performance check')
  const selected = check === undefined ? budgets : budgets.filter(budget => budget.check === check)
  let host = null
  let refusal = null
  let usedOrigin = null
  try {
    usedOrigin = publicOrigin(origin)
    if (!token) throw new Error('authenticated host read requires token')
    host = validateReferenceHost(await read(usedOrigin, token))
  } catch (error) { refusal = error.message }
  const measured = []
  for (const budget of selected) {
    const activation = budget.check === 'C-PERF-01' || budget.check === 'C-PERF-02'
      ? ['T-INS-04'] : ['T-INS-02', 'T-MCH-11', 'T-SEC-01', 'T-MCH-10']
    const entry = { ...budget, status: 'skipped', samples: [], activation }
    measured.push(entry)
    if (refusal) { entry.reason = refusal; continue }
    const provider = providers[budget.check]
    if (!provider) {
      entry.reason = budget.name === 'rebase-hold'
        ? `contract driver exists; production binding requires ${budget.tickets.join(', ')} and qualified ${activation.join(', ')} receipts`
        : ['agent-first-token', 'keystroke', 'disk-write', 'warm-wake'].includes(budget.name)
        ? `standalone driver exists; activation requires ${budget.tickets.join(', ')} and qualified ${activation.join(', ')} receipts`
        : `production measurement driver not implemented; requires ${budget.tickets.join(', ')} and owner-reviewed seams`
      continue
    }
    try {
      if (typeof installVersion !== 'string' || !installVersion.trim()) throw new Error('install version required')
      await provider.available(env, { origin: usedOrigin, commit })
    } catch (error) {
      entry.reason = `${budget.tickets.join(', ')}: ${error.message}`
      continue
    }
    // A launched workload cannot become a skip after a failed sample.
    entry.status = 'failed'
    try {
      const result = await provider.measure(env)
      entry.samples = result.samples ?? []
      // Retain the driver's cross-checks, including on failure. Only public
      // evidence fields are copied; environment and credentials stay private.
      for (const field of ['host', 'browser', 'clock', 'models', 'member', 'members', 'sshMember', 'sshFingerprint', 'backgroundTabs', 'preflightSummary', 'questionOrder', 'metricsCrossCheck', 'wakesBefore', 'wakesAfter', 'activity', 'sleepSeconds', 'cleanupError', 'pendingTerminal']) {
        if (result[field] !== undefined) entry[field] = result[field]
      }
      if (result.status !== 'passed') throw new Error(result.error ?? 'measurement failed')
      if (result.commit !== commit || result.origin !== usedOrigin) throw new Error('measurement commit/origin differs from run')
      if (result.installVersion !== installVersion) throw new Error('measurement install version differs from run')
      validateReferenceHost(result.host)
      // Free disk and derived capacity can change during a workload. Keep both
      // readings, but refuse a different hardware/platform profile.
      for (const field of ['memory_bytes', 'perf_cores', 'physical_cores', 'macos_version', 'hypervisor']) {
        if (!isDeepStrictEqual(result.host.profile[field], host.profile[field])) throw new Error('measurement host profile differs from run')
      }
      entry.browser = result.browser
      entry.stats = summarize(entry.samples, Object.values(provider.fields), budget.minimum)
      for (const [name, limit] of Object.entries(budget.thresholdsMs)) {
        const field = provider.fields[name]
        if (!field || entry.stats[field]?.p95 >= limit) throw new Error(`${name} p95 must be below ${limit} ms`)
      }
      if (budget.check === 'C-PERF-05') {
        for (const sample of entry.samples) {
          const verified = verifyWake(sample, sample.observation)
          if (verified.hostMs !== sample.hostMs) throw new Error('wake duration differs from host observation')
        }
        entry.wakeStats = summarizeWakes(entry.samples)
      }
      if (budget.check === 'C-PERF-06') entry.cohorts = summarizeRebases(entry.samples)
      entry.status = 'passed'
    } catch (error) {
      entry.reason = error.message
      if (Array.isArray(error.samples)) entry.samples = error.samples
      if (error.cleanupError) entry.cleanupError = error.cleanupError
    }
  }
  const status = measured.some(b => b.status === 'failed') ? 'failed'
    : measured.every(b => b.status === 'passed') ? 'passed' : 'incomplete'
  const summary = {
    version: 1, timestamp, commit, installVersion: installVersion ?? null, origin: usedOrigin,
    browser: browser ?? null, host, status, budgets: measured
  }
  return { summary, directory: await writeRun(root, summary), exit: status === 'passed' ? 0 : status === 'failed' ? 1 : 2 }
}

export async function runSelected(check = process.argv[2]) {
  try {
    const result = await run({ root: process.env.SMITHERS_PERF_ARTIFACT_ROOT, origin: process.env.SMITHERS_PERF_ORIGIN, token: process.env.SMITHERS_PERF_OWNER_COOKIE ? { cookie: process.env.SMITHERS_PERF_OWNER_COOKIE } : process.env.SMITHERS_PERF_TOKEN,
      installVersion: process.env.SMITHERS_PERF_INSTALL_VERSION, browser: process.env.SMITHERS_PERF_BROWSER,
      check, commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() })
    console.log(JSON.stringify({ ...result.summary, directory: result.directory }))
    return result.exit
  } catch (error) { console.error(error.message); return 2 }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await runSelected()
