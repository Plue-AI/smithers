#!/usr/bin/env node

// Shared issue-claim convention for every agent, session, machine and Cloud worker:
//   node scripts/issue-claim.mjs check   <repo>#<n> [--by NAME]
//   node scripts/issue-claim.mjs claim   <repo>#<n> [--by NAME] [--note TEXT]
//   node scripts/issue-claim.mjs release <repo>#<n> [--by NAME] [--note TEXT] [--force]
// <repo> is `name` (org smithersai) or `owner/name`. NAME defaults to ISSUE_CLAIM_BY,
// then CLAUDE_SESSION_NAME, then `<user>-<parent pid>`; the host is os.hostname().
//
// A claim is the `in-progress` label plus the comment
//   Claimed by <NAME> on <host> at <UTC>; expires <UTC+6h>
// Claiming again as the same NAME and host refreshes it. A claim ends at a later
// `Released by ...` comment or at its expiry; a stale claim may be taken over.
// Release removes the label and comments `Released by <NAME> on <host> at <UTC>: <note>`.
// Prints one JSON line. Exit 0: done, or free for you; 2: held by someone else; 1: error.
// Environment: ISSUE_CLAIM_GH replaces the `gh` binary (tests).

import { execFileSync } from "node:child_process"
import { realpathSync } from "node:fs"
import { hostname, userInfo } from "node:os"
import process from "node:process"

export const LABEL = "in-progress"
export const COLOR = "fbca04"
export const HOURS = 6
const CLAIM = /^Claimed by (.+) on (\S+) at (\S+); expires (\S+?)\.?(?:\s|$)/
const RELEASE = /^Released by /

export const parseRef = (ref) => {
  const match = /^(?:([\w.-]+)\/)?([\w.-]+)#(\d+)$/.exec(ref ?? "")
  if (!match) throw new Error(`expected <repo>#<n> or <owner>/<repo>#<n>, got ${JSON.stringify(ref)}`)
  return { repo: `${match[1] ?? "smithersai"}/${match[2]}`, number: Number(match[3]) }
}

/**
 * The current holder of an issue, or null when it is free. `comments` are in
 * creation order with `body` and `created_at`; `labeledAt` is the latest time the
 * label was added, used as the claim time when no claim comment explains the label.
 * A claim by another agent while an earlier one is live does not displace it, so
 * two agents racing to claim agree on the first.
 */
export const holder = ({ labeled, comments, labeledAt }, now = Date.now()) => {
  let current = null
  for (const comment of comments) {
    const body = comment.body ?? ""
    const at = Date.parse(comment.created_at ?? "")
    if (RELEASE.test(body)) current = null
    const match = CLAIM.exec(body)
    if (!match) continue
    const claim = { by: match[1], host: match[2], at: match[3], expires: match[4], line: body.split("\n")[0] }
    const live = current && !(Date.parse(current.expires) <= at)
    if (!live || (current.by === claim.by && current.host === claim.host)) current = claim
  }
  if (!current && labeled) {
    const at = Date.parse(labeledAt ?? "")
    // An unknown label time never goes stale: take it over only by hand, with --force on release.
    current = { by: "unknown", host: "unknown", at: labeledAt, line: `${LABEL} label without a claim comment`,
      expires: Number.isFinite(at) ? new Date(at + HOURS * 3600_000).toISOString() : null }
  }
  if (!current) return null
  const expires = Date.parse(current.expires)
  return { ...current, stale: Number.isFinite(expires) && expires <= now }
}

export const claimBody = ({ by, host, now, takeover, note }) => [
  `Claimed by ${by} on ${host} at ${now.toISOString()}; expires ${new Date(now.getTime() + HOURS * 3600_000).toISOString()}`,
  ...(takeover ? [`Took over a stale claim: ${takeover}`] : []),
  ...(note ? [note] : [])
].join("\n")

export const releaseBody = ({ by, host, now, note }) => `Released by ${by} on ${host} at ${now.toISOString()}: ${note || "done"}`

const defaultGh = (args) => {
  const binary = process.env.ISSUE_CLAIM_GH || "gh"
  return execFileSync(binary, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
}

const pages = (text) => JSON.parse(text || "[]").flat()

/** Reads the issue's label, comments and, only when needed, its latest `in-progress` label event. */
export const read = ({ repo, number }, gh = defaultGh) => {
  const base = `repos/${repo}/issues/${number}`
  const issue = JSON.parse(gh(["api", base]))
  const labeled = (issue.labels ?? []).some((label) => (label.name ?? label) === LABEL)
  const comments = pages(gh(["api", "--paginate", "--slurp", `${base}/comments?per_page=100`]))
  let labeledAt = null
  if (labeled && !comments.some((comment) => CLAIM.test(comment.body ?? ""))) {
    const events = pages(gh(["api", "--paginate", "--slurp", `${base}/events?per_page=100`]))
    labeledAt = events.filter((event) => event.event === "labeled" && event.label?.name === LABEL).at(-1)?.created_at ?? null
  }
  return { state: issue.state, labeled, comments, labeledAt }
}

const mine = (claim, me) => claim && claim.by === me.by && claim.host === me.host

export const run = (argv, { gh = defaultGh, now = () => new Date(), env = process.env } = {}) => {
  const [command, ref, ...rest] = argv
  const option = (name) => { const at = rest.indexOf(name); return at < 0 ? undefined : rest[at + 1] }
  if (!["check", "claim", "release"].includes(command)) throw new Error("usage: issue-claim.mjs check|claim|release <repo>#<n> [--by NAME] [--note TEXT] [--force]")
  const issue = parseRef(ref)
  const me = { by: option("--by") || env.ISSUE_CLAIM_BY || env.CLAUDE_SESSION_NAME || `${userInfo().username}-${process.ppid}`, host: hostname() }
  const id = `${issue.repo}#${issue.number}`
  const before = holder(read(issue, gh), now().getTime())
  const blocked = before && !before.stale && !mine(before, me)
  if (command === "check") return { code: blocked ? 2 : 0, out: { issue: id, free: !before || before.stale, mine: Boolean(mine(before, me)), holder: before } }
  const base = `repos/${issue.repo}/issues/${issue.number}`
  if (command === "release") {
    if (blocked && !rest.includes("--force")) return { code: 2, out: { issue: id, action: "refused", holder: before } }
    try { gh(["api", "--method", "DELETE", `${base}/labels/${LABEL}`]) } catch { /* already unlabeled */ }
    gh(["api", `${base}/comments`, "-f", `body=${releaseBody({ ...me, now: now(), note: option("--note") })}`])
    return { code: 0, out: { issue: id, action: "released", by: me.by, host: me.host } }
  }
  if (blocked) return { code: 2, out: { issue: id, action: "refused", holder: before } }
  try { gh(["api", `repos/${issue.repo}/labels`, "-f", `name=${LABEL}`, "-f", `color=${COLOR}`, "-f", "description=An agent is working this; see its Claimed by comment"]) } catch { /* exists */ }
  gh(["api", `${base}/labels`, "-f", `labels[]=${LABEL}`])
  const takeover = before && before.stale && !mine(before, me) ? before.line : undefined
  gh(["api", `${base}/comments`, "-f", `body=${claimBody({ ...me, now: now(), takeover, note: option("--note") })}`])
  const after = holder(read(issue, gh), now().getTime())
  if (!mine(after, me)) return { code: 2, out: { issue: id, action: "lost-race", holder: after } }
  return { code: 0, out: { issue: id, action: takeover ? "took-over" : mine(before, me) ? "refreshed" : "claimed", holder: after } }
}

const isMain = () => {
  try { return realpathSync(process.argv[1]) === realpathSync(new URL(import.meta.url).pathname) } catch { return false }
}

if (isMain()) {
  try {
    const { code, out } = run(process.argv.slice(2))
    console.log(JSON.stringify(out))
    process.exitCode = code
  } catch (error) {
    console.error(JSON.stringify({ error: String(error.stderr || error.message).trim().slice(0, 500) }))
    process.exitCode = 1
  }
}
