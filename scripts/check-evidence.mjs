/** Engineering receipt policy shared by the runner and trusted issue writer. @since 0.1.0 */
import { isDeepStrictEqual } from 'node:util'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

export const hashLog = (data) => `sha256:${createHash('sha256').update(data).digest('hex')}`
export const fullSha = (sha) => typeof sha === 'string' && /^[a-f0-9]{40}$/.test(sha)
export const gitRead = (root, args) => execFileSync('/usr/bin/git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH, HOME: process.env.HOME, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0' } }).trim()

/** Inventory entries are either explicit markers or approved executable contracts. */
export const validMapping = (mapping) => {
  if (!mapping || typeof mapping.reason !== 'string' && mapping.status) return false
  if (mapping.status === 'manual') return Boolean(mapping.reason.trim())
  if (mapping.status === 'pending-owner') return Boolean(mapping.reason.trim() && /^T-[A-Z]+-\d+[a-z]*$/.test(mapping.ticket ?? ''))
  // An approved mapping may not drop obligations its proposal still lists open.
  const pending = mapping.pendingBinding
  if (!mapping.status && pending && ((pending.unboundSubcases ?? []).length || (pending.commands ?? []).some(command => !command.expectedCaseIds?.length))) return false
  if (mapping.status || mapping.approvedBy !== 'smithers-22' || typeof mapping.host !== 'string' || !mapping.host.trim()) return false
  // CI ran the target; approved mappings carry no executable argv.
  return mapping.host === 'CI' && targetLabel(mapping.target) && !('command' in mapping) && !('paths' in mapping)
}

export const targetLabel = (label) => typeof label === 'string' && /^\/\/[A-Za-z0-9._/-]*:[A-Za-z0-9._-]+$/.test(label)

/** The receipt command a mapping must reproduce: the CI receipt of its label. */
export const expectedCommand = (mapping) => ['smthrs-ci', mapping.target]

const ENTRY = /^[A-Za-z0-9._-]+\.json$/

/**
 * Unpacks one smthrs-results artifact zip, confined (3f, #3663): only
 * top-level `*.json` regular files, at most `maxFile` bytes each and `maxTotal`
 * in all, checked from the listing before extraction and by lstat after it.
 * Refusals carry a fixed reason and never quote file contents.
 * Returns { files: [{ name, text }] } or { reason }.
 */
export const unpackResults = (bytes, { maxTotal = 16 << 20, maxFile = 4 << 20 } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'check-ci-'))
  try {
    const zip = join(dir, 'artifact.zip'); const out = join(dir, 'x')
    writeFileSync(zip, bytes)
    let listing
    try { listing = execFileSync('/usr/bin/unzip', ['-Zl', zip], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) } catch { return { reason: 'artifact_zip' } }
    // zipinfo -l: mode, version, os, size, type, csize, method, date, time, name.
    const entries = listing.split('\n').filter(line => /^[-a-z?][-rwxsStTl?]{9}\s/.test(line)).map(line => {
      const fields = line.trim().split(/\s+/)
      return { mode: fields[0], size: Number(fields[3]), name: fields.slice(9).join(' ') }
    })
    if (entries.some(entry => !entry.mode.startsWith('-') || !ENTRY.test(entry.name) || entry.name === '.json')) return { reason: 'artifact_entry' }
    if (entries.some(entry => !Number.isSafeInteger(entry.size) || entry.size > maxFile) || entries.reduce((sum, entry) => sum + entry.size, 0) > maxTotal) return { reason: 'artifact_size' }
    try { execFileSync('/usr/bin/unzip', ['-qq', zip, '-d', out], { stdio: ['ignore', 'pipe', 'pipe'] }) } catch { return { reason: 'artifact_zip' } }
    const names = entries.map(entry => entry.name).sort()
    if (!isDeepStrictEqual(readdirSync(out).sort(), names)) return { reason: 'artifact_entry' }
    const files = []
    for (const name of names) {
      const stat = lstatSync(join(out, name))
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxFile) return { reason: 'artifact_entry' }
      files.push({ name, text: readFileSync(join(out, name), 'utf8') })
    }
    return { files }
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

const PASSING = new Set(['ran', 'hit'])
const RESULTS = /^smthrs-results-([A-Za-z_][A-Za-z0-9_-]*)-(\d+)-(\d+)$/

/**
 * Decides a CI-mapped check from CI's own record at `landed` (#3663, option B).
 * Trusts only a completed push run of .github/workflows/ci.yml on main at
 * exactly `landed`, its latest attempt, check runs from the github-actions app,
 * and each job leg's newest smthrs-results artifact up to that attempt, digests matching. The
 * label's own statuses decide; a job that was cancelled or timed out refuses.
 * `github.json(path)` and `github.bytes(path)` read the REST API; `unpack(bytes)`
 * returns { files: [{ name, text }] } or { reason } (see unpackResults). Returns { pass, reason, evidence }.
 */
export const verifyCiRun = ({ github, unpack, repo, landed, label }) => {
  const refuse = (reason, evidence = {}) => ({ pass: false, reason, evidence })
  if (!fullSha(landed) || !targetLabel(label) || !/^[\w.-]+\/[\w.-]+$/.test(repo ?? '')) return refuse('input')
  // One page of 100 is all we read; a longer list refuses rather than guesses.
  const page = (path, key) => { const body = github.json(path); const rows = body[key] ?? []; return Number.isSafeInteger(body.total_count) && body.total_count > rows.length ? null : rows }
  const listed = page(`repos/${repo}/commits/${landed}/check-runs?per_page=100`, 'check_runs')
  if (listed === null) return refuse('truncated')
  const checks = listed.filter(run => run.app?.slug === 'github-actions' && run.head_sha === landed)
  if (!checks.length && listed.some(run => run.app?.slug === 'github-actions' && run.head_sha !== landed)) return refuse('commit')
  const runIds = [...new Set(checks.map(run => /\/actions\/runs\/(\d+)\//.exec(run.details_url ?? '')?.[1]).filter(Boolean))]
  const runs = runIds.map(id => github.json(`repos/${repo}/actions/runs/${id}`))
    .filter(run => run.head_sha === landed && run.event === 'push' && run.head_branch === 'main' && run.path === '.github/workflows/ci.yml' && run.repository?.full_name === repo)
  if (runs.length !== 1) return refuse(runs.length ? 'ambiguous_run' : 'no_run', { runIds })
  const [run] = runs
  const evidence = { run: run.id, attempt: run.run_attempt, url: run.html_url, artifacts: [], rows: [] }
  if (run.status !== 'completed') return refuse('incomplete', evidence)
  const jobs = page(`repos/${repo}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`, 'jobs')
  if (jobs === null) return refuse('truncated', evidence)
  const stopped = jobs.filter(job => ['cancelled', 'timed_out'].includes(job.conclusion)).map(job => job.name)
  if (stopped.length) return refuse('job_stopped', { ...evidence, stopped })
  const artifacts = page(`repos/${repo}/actions/runs/${run.id}/artifacts?per_page=100`, 'artifacts')
  if (artifacts === null) return refuse('truncated', evidence)
  // Each job leg's newest attempt up to run_attempt decides: "re-run failed jobs"
  // re-executes only some legs, and the others keep their earlier attempt's result.
  const newest = new Map()
  for (const artifact of artifacts) {
    const name = RESULTS.exec(artifact.name ?? '')
    if (!name || Number(name[3]) > run.run_attempt) continue
    const leg = `${name[1]}-${name[2]}`
    if (!newest.has(leg) || Number(RESULTS.exec(newest.get(leg).name)[3]) < Number(name[3])) newest.set(leg, artifact)
  }
  // Every job leg the latest attempt executed must have uploaded at that attempt; the
  // fallback above covers only legs a partial rerun did not execute (b8, #3663).
  const ranNow = jobs.filter(job => job.run_attempt === run.run_attempt).length
  const uploadedNow = [...newest.values()].filter(artifact => Number(RESULTS.exec(artifact.name)[3]) === run.run_attempt).length
  if (uploadedNow < ranNow) return refuse('artifact_missing', { ...evidence, ranNow, uploadedNow })
  for (const artifact of [...newest.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    if (artifact.workflow_run?.id !== run.id || artifact.expired) return refuse('artifact_foreign', { ...evidence, artifact: artifact.name })
    const bytes = github.bytes(`repos/${repo}/actions/artifacts/${artifact.id}/zip`)
    if (artifact.digest !== hashLog(bytes)) return refuse('artifact_digest', { ...evidence, artifact: artifact.name })
    evidence.artifacts.push({ name: artifact.name, digest: artifact.digest })
    const unpacked = unpack(bytes)
    if (unpacked.reason) return refuse(unpacked.reason, { ...evidence, artifact: artifact.name })
    for (const file of unpacked.files) {
      let summary
      try { summary = JSON.parse(file.text) } catch { return refuse('results_unreadable', { ...evidence, file: file.name }) }
      if (summary?.version !== 1 || !Array.isArray(summary.results)) return refuse('results_unreadable', { ...evidence, file: file.name })
      for (const row of summary.results) if (row?.label === label) evidence.rows.push({ artifact: artifact.name, file: file.name, status: row.status, key: row.key })
    }
  }
  if (!evidence.rows.length) return refuse('label_absent', evidence)
  const failing = evidence.rows.filter(row => !PASSING.has(row.status))
  return failing.length ? refuse('label_failed', evidence) : { pass: true, reason: 'pass', evidence }
}

/** A run that executed no tests is never a pass, whatever its exit code. */
export const zeroTests = (log) => {
  const text = String(log)
  if (/^(?:ℹ|#) tests 0$/m.test(text) || /^Ran 0 tests across/m.test(text) || /No test files found/.test(text) || /^Error: No tests found/m.test(text)) return true
  const goRan = /^ok\s+\S+\s+[\d.]+s\s*$/m.test(text) || /^--- PASS/m.test(text) || /"Action":"pass"[^}\n]*"Test":/.test(text)
  return !goRan && /\[no tests to run\]|\bno test files\b/.test(text)
}

/** Reject traversal and every symlink component before opening a receipt or log. */
export const confined = (root, path, base = '.artifacts/checks') => {
  if (typeof path !== 'string' || path.split(/[\\/]/).includes('..')) throw new Error('unsafe path')
  const boundary = resolve(root, base)
  const target = resolve(root, path)
  const inside = relative(boundary, target)
  if (!inside || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) throw new Error('outside evidence root')
  // Include the evidence root's parents, even when .artifacts itself is a symlink.
  let current = sep
  for (const part of target.split(sep).filter(Boolean)) {
    current = join(current, part)
    if (lstatSync(current).isSymbolicLink()) throw new Error('symlink path')
  }
  const realBoundary = realpathSync(boundary)
  const realTarget = realpathSync(target)
  const realInside = relative(realBoundary, realTarget)
  if (!realInside || realInside.startsWith(`..${sep}`) || realInside === '..' || isAbsolute(realInside)) throw new Error('escaped evidence root')
  if (!lstatSync(target).isFile()) throw new Error('not a regular file')
  return target
}

const iso = (time) => typeof time === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(time) && Number.isFinite(Date.parse(time)) && new Date(time).toISOString() === time

/** Derive coverage from the unique committed ticket naming this repository and issue. */
export const ticketChecks = (root, issue, revision = 'refs/remotes/origin/main') => {
  const url = `https://github.com/${issue.repo}/issues/${issue.number}`
  const tickets = gitRead(root, ['ls-tree', '--name-only', revision, '.specs/engineering/tickets/']).split('\n').filter(name => /\/T-[A-Z]+-\d+[a-z]*\.md$/.test(name)).map(name => gitRead(root, ['show', `${revision}:${name}`])).filter(text => { const line = /^.*\bIssue:([^\n]+)$/m.exec(text)?.[1] ?? ''; return [...line.matchAll(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+/g)].some(match => match[0] === url) })
  if (tickets.length !== 1) throw new Error('missing or ambiguous ticket')
  const section = /^## Acceptance\s*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m.exec(tickets[0])?.[1]
  const checks = [...new Set(section?.match(/\bC-[A-Z][A-Z0-9]*-\d+\b/g) ?? [])]
  if (!checks.length) throw new Error('no declared coverage')
  return checks
}

/** Return all refusals before the caller may cross the remote write boundary. */
export const evidenceGate = ({ root, issue, landed, receipts }) => {
  let required
  try { required = ticketChecks(root, issue, fullSha(landed) ? landed : 'refs/remotes/origin/main') } catch { return [{ check: 'ticket', reason: 'coverage' }] }
  try {
    if (!fullSha(landed)) throw new Error('full SHA required')
    const remote = gitRead(root, ['ls-remote', '--exit-code', 'origin', 'refs/heads/main'])
    const match = /^([a-f0-9]{40})\s+refs\/heads\/main$/.exec(remote)
    if (!match) throw new Error('remote main unavailable')
    gitRead(root, ['merge-base', '--is-ancestor', landed, match[1]])
    if (gitRead(root, ['rev-parse', `${landed}^{commit}`]) !== landed) throw new Error('not a commit')
  } catch { return required.map(check => ({ check, reason: 'commit' })) }
  let mappings
  try { mappings = JSON.parse(gitRead(root, ['show', `${landed}:scripts/check-commands.json`])) } catch { return required.map(check => ({ check, reason: 'missing' })) }
  const unavailable = required.filter(check => !validMapping(mappings.checks?.[check]) || mappings.checks[check].status)
  if (unavailable.length) return unavailable.map(check => ({ check, reason: 'missing' }))
  if (!receipts.length) return required.map(check => ({ check, reason: 'missing' }))
  const failures = []; const covered = new Set()
  for (const path of receipts) {
    let r; let reason
    try { r = JSON.parse(readFileSync(confined(root, path), 'utf8')) } catch { failures.push({ check: 'receipt', receipt: path, reason: 'digest' }); continue }
    const check = typeof r?.check === 'string' ? r.check : required[0]
    if (typeof r?.check !== 'string' || !required.includes(r.check)) reason = 'coverage'
    else {
      covered.add(check)
      if (!fullSha(r.commit) || r.commit !== landed) reason = 'commit'
      else if (!isDeepStrictEqual(r.command, expectedCommand(mappings.checks[check]))) reason = 'coverage'
      else if (r.version !== 1 || !Number.isInteger(r.exit) || r.exit !== 0 || !iso(r.started) || !iso(r.ended) || r.started > r.ended || typeof r.layer !== 'string' || !r.layer) reason = 'failed'
      else {
        try {
          const log = confined(root, join(resolve(root, path), '..', 'log.txt'))
          const bytes = readFileSync(log)
          if (typeof r.log_digest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(r.log_digest) || hashLog(bytes) !== r.log_digest) reason = 'digest'
          else if (zeroTests(bytes)) reason = 'failed'
        } catch { reason = 'digest' }
      }
    }
    if (reason) failures.push({ check, receipt: path, reason })
  }
  for (const check of required) if (!covered.has(check)) failures.push({ check, reason: 'coverage' })
  return failures
}

/**
 * Closure re-reads CI for every receipt of a target mapping: a receipt is a
 * cache of the CI verdict, never the verdict (Fable, #3663). `repo` is the
 * issue's repository, never the local `origin`, so a fork's run cannot close it.
 */
export const reverifyCi = ({ root, repo, landed, receipts, github, unpack = unpackResults }) => {
  let mappings
  try { mappings = JSON.parse(gitRead(root, ['show', `${landed}:scripts/check-commands.json`])) } catch { return [{ check: 'receipt', reason: 'missing' }] }
  const failures = []
  for (const path of receipts) {
    let r
    try { r = JSON.parse(readFileSync(confined(root, path), 'utf8')) } catch { failures.push({ check: 'receipt', receipt: path, reason: 'digest' }); continue }
    const mapping = mappings.checks?.[r?.check]
    if (!mapping || !('target' in mapping)) continue
    const verdict = verifyCiRun({ github, unpack, repo, landed, label: mapping.target })
    if (!verdict.pass) {
      const reason = verdict.reason === 'commit' ? 'commit' : verdict.reason === 'artifact_digest' ? 'digest' : ['no_run', 'artifact_missing'].includes(verdict.reason) ? 'missing' : verdict.reason === 'label_absent' ? 'coverage' : 'failed'
      failures.push({ check: r.check, receipt: path, reason })
    }
  }
  return failures
}
