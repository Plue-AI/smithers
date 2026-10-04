#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { publicOrigin, readHost, validateHost } from './lib/host.mjs'
import { writeRun } from './lib/artifact.mjs'

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

export async function run({ root = process.cwd(), origin, token, commit, installVersion, browser, read = readHost, timestamp = new Date().toISOString().replace(/[:.]/g, '-') }) {
  if (!/^[a-f0-9]{40}$/.test(commit ?? '')) throw new Error('full commit SHA required')
  let host = null
  let refusal = null
  let usedOrigin = null
  try {
    usedOrigin = publicOrigin(origin)
    if (!token) throw new Error('authenticated host read requires token')
    host = validateHost(await read(usedOrigin, token))
  } catch (error) { refusal = error.message }
  const summary = {
    version: 1, timestamp, commit, installVersion: installVersion ?? null, origin: usedOrigin,
    browser: browser ?? null, host, status: 'incomplete',
    budgets: budgets.map((budget) => ({ ...budget, status: 'skipped', samples: [],
      reason: refusal ?? `production measurement driver not implemented; requires ${budget.tickets.join(', ')} and owner-reviewed seams`,
      activation: budget.check === 'C-PERF-01' || budget.check === 'C-PERF-02'
        ? ['T-INS-04'] : ['T-INS-02', 'T-MCH-11', 'T-SEC-01', 'T-MCH-10'] }))
  }
  return { summary, directory: await writeRun(root, summary), exit: 2 }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await run({ origin: process.env.SMITHERS_PERF_ORIGIN, token: process.env.SMITHERS_PERF_TOKEN,
      installVersion: process.env.SMITHERS_PERF_INSTALL_VERSION, browser: process.env.SMITHERS_PERF_BROWSER,
      commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() })
    console.log(JSON.stringify({ ...result.summary, directory: result.directory }))
    process.exitCode = result.exit
  } catch (error) { console.error(error.message); process.exitCode = 2 }
}
