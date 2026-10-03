/** Engineering receipt policy shared by the runner and trusted issue writer. @since 0.1.0 */
import { isDeepStrictEqual } from 'node:util'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
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
  return !mapping.status && mapping.approvedBy === 'smithers-22' && typeof mapping.host === 'string' && Boolean(mapping.host.trim()) && Array.isArray(mapping.command) && mapping.command.length > 0 && mapping.command.every(arg => typeof arg === 'string' && Boolean(arg))
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
      else if (!isDeepStrictEqual(r.command, mappings.checks[check].command)) reason = 'coverage'
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
