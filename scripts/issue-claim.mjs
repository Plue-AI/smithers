#!/usr/bin/env node

// Shared issue-claim convention for every agent, session, machine and Cloud worker:
//   node scripts/issue-claim.mjs check   <repo>#<n> [--by NAME]
//   node scripts/issue-claim.mjs claim   <repo>#<n> [--by NAME] [--note TEXT]
//   node scripts/issue-claim.mjs release <repo>#<n> [--by NAME] [--note TEXT] [--force]
//   node scripts/issue-claim.mjs comment <repo>#<n> (--body TEXT | --body-file PATH) [--close] [--pr]
//                                        [--release [--by NAME] [--note TEXT] [--force]]
// <repo> is `name` (org smithersai) or `owner/name`. NAME defaults to ISSUE_CLAIM_BY,
// then CLAUDE_SESSION_NAME, then `<user>-<parent pid>`; the host is os.hostname().
//
// A claim is the `in-progress` label plus the comment
//   Claimed by <NAME> on <host> at <UTC>; expires <UTC+6h>
// Claiming again as the same NAME and host refreshes it once the claim is an hour old;
// sooner it is a no-op, so a retried claim never posts a second comment. A claim ends at
// a later comment with a `Released by ...` line, or at its expiry; a stale claim may be
// taken over. Release removes the label and, when it ends a live claim, comments
// `Released by <NAME> on <host> at <UTC>: <note>`. `comment --release` appends that line
// to the receipt or failure comment instead of posting a second one; `--close` then closes
// the issue (`--pr`: the pull request). A body already on the issue is never posted again.
//
// Every GitHub call goes through the machine's GitHub proxy (scripts/github-proxy.mjs, started
// on first use; SMITHERS_GITHUB_PROXY, default http://127.0.0.1:47821) as `gh api` with an
// absolute proxy URL. The proxy holds the credential (the configured GitHub App's
// installation on the issue's owner, else the operator's token; see github-app-auth.mjs) and
// the one rate limiter of that principal on the machine: writes start at least 1 s apart, at
// most 80 a minute and 500 an hour, and a GitHub rate-limit response pauses every caller.
// Before writing, a command asks the proxy whether all its writes can start within the
// proxy's one-minute wait, so it makes all of them or none.
// Prints one JSON line naming the principal (`identity`). Exit 0: done, or free for you;
// 2: held by someone else; 75: rate limited, retry after `retry_at` (not a failed attempt,
// nothing to undo); 1: error. ISSUE_CLAIM_GH replaces the `gh` binary (tests).

import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs"
import { homedir, hostname, userInfo } from "node:os"
import { join } from "node:path"
import process from "node:process"

import { proxyUrl } from "./github-proxy.mjs"

export const LABEL = "in-progress"
export const COLOR = "fbca04"
export const HOURS = 6
export const REFRESH_AFTER = 3600_000
export const TRANSIENT = 75
const CLAIM = /^Claimed by (.+) on (\S+) at (\S+); expires (\S+?)\.?(?:\s|$)/
const RELEASE = /^Released by /m
const LIMITED = /secondary rate limit|rate limit exceeded|abuse detection|HTTP 429/i

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

/** A call GitHub or the proxy refused for rate limiting, or one the proxy cannot start soon: retry at `retryAt`. */
export class Transient extends Error {
  constructor(message, retryAt) {
    super(message)
    this.retryAt = retryAt
  }
}

/** Splits `gh api -i` output into lower-cased headers and the body; output without a status line is all body. */
export const splitResponse = (text = "") => {
  const match = /^HTTP\/[\d.]+ \d{3}[^\n]*\n([\s\S]*?)\r?\n\r?\n([\s\S]*)$/.exec(text)
  if (!match) return { headers: {}, body: text }
  const headers = Object.fromEntries(match[1].split(/\r?\n/).filter((line) => line.includes(":"))
    .map((line) => [line.slice(0, line.indexOf(":")).trim().toLowerCase(), line.slice(line.indexOf(":") + 1).trim()]))
  return { headers, body: match[2] }
}

const limited = (text, headers) => LIMITED.test(text) ||
  (/HTTP 403/.test(text) && (headers["retry-after"] !== undefined || headers["x-ratelimit-remaining"] === "0"))

const errorText = (error) => `${error.stderr ?? ""}\n${error.message ?? ""}\n${error.stdout ?? ""}`

const firstLine = (error) => String(error.stderr || error.message).trim().split("\n")[0]

const defaultGh = (args) => {
  const binary = process.env.ISSUE_CLAIM_GH || "gh"
  return execFileSync(binary, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 << 20 })
}

/** Starts the machine's GitHub proxy unless it answers. */
const defaultEnsure = (env) => {
  execFileSync(process.execPath, [new URL("./github-proxy.mjs", import.meta.url).pathname, "--ensure"],
    { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 })
}

/**
 * GitHub through the proxy at `base`: `gh api` with absolute proxy URLs, so `gh` sends no
 * token and every call spends the machine's one budget. A rate-limited call throws Transient.
 */
export const proxied = ({ gh, base, now = () => new Date() }) => {
  const at = (args) => args.map((arg) => /^repos\//.test(arg) ? `${base}/${arg}` : arg)
  const deferred = (retryAt, why) => new Transient(`${why}; retry after ${new Date(retryAt).toISOString()}`, retryAt)
  const read = (args) => {
    try { return gh(at(args)) } catch (error) {
      if (LIMITED.test(errorText(error))) throw deferred(now().getTime() + 60_000, `GitHub rate limit on read: ${firstLine(error)}`)
      throw error
    }
  }
  return {
    /** The principal the proxy runs `repo` as; throws Transient unless `writes` writes can start soon. */
    admit(repo, writes) {
      const answer = JSON.parse(read(["api", `${base}/_smithers/admission?repo=${encodeURIComponent(repo)}&writes=${writes}`]))
      if (answer.deferred) throw deferred(Date.parse(answer.startsAt), "the GitHub write budget is booked")
      return answer.principal
    },
    read,
    write(args) {
      let out
      try { out = gh(at(["api", "-i", ...args.slice(1)])) } catch (error) {
        const { headers } = splitResponse(String(error.stdout ?? ""))
        if (!limited(errorText(error), headers)) throw error
        const retryAt = Date.parse(headers["x-smithers-retry-at"] ?? "") ||
          now().getTime() + Math.max(Number(headers["retry-after"]) * 1000 || 0, 60_000)
        throw deferred(retryAt, `GitHub rate limit: ${firstLine(error)}`)
      }
      return splitResponse(out).body
    }
  }
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

/** Runs a command through the machine's GitHub proxy, starting it first when it is not running. */
export const run = (argv, { gh = defaultGh, now = () => new Date(), env = process.env, ensure = defaultEnsure } = {}) => {
  const [command, ref, ...rest] = argv
  const option = (name) => { const at = rest.indexOf(name); return at < 0 ? undefined : rest[at + 1] }
  const flag = (name) => rest.includes(name)
  if (!["check", "claim", "release", "comment"].includes(command)) {
    throw new Error("usage: issue-claim.mjs check|claim|release|comment <repo>#<n> [--by NAME] [--note TEXT] [--force] [--body TEXT | --body-file PATH] [--close] [--pr] [--release]")
  }
  const issue = parseRef(ref)
  const me = { by: option("--by") || env.ISSUE_CLAIM_BY || env.CLAUDE_SESSION_NAME || `${userInfo().username}-${process.ppid}`, host: hostname() }
  const id = `${issue.repo}#${issue.number}`
  ensure(env)
  const github = proxied({ gh, base: proxyUrl(env), now })
  const write = (args) => github.write(args)
  const readIssue = () => read(issue, github.read)
  let identity
  const base = `repos/${issue.repo}/issues/${issue.number}`
  const unlabel = ["api", "--method", "DELETE", `${base}/labels/${LABEL}`]
  const admit = (writes) => { identity = github.admit(issue.repo, writes) }
  const result = (code, out) => ({ code, out: { ...out, identity } })
  try {
    admit(0)
    const initial = readIssue()
    const before = holder(initial, now().getTime())
    const blocked = before && !before.stale && !mine(before, me)
    // A live claim a release must end with a comment; a bare label only needs removing.
    const live = before && !before.stale && before.by !== "unknown"
    if (command === "check") return result(blocked ? 2 : 0, { issue: id, free: !before || before.stale, mine: Boolean(mine(before, me)), holder: before })
    if (command === "comment") {
      const body = (option("--body") ?? (option("--body-file") ? readFileSync(option("--body-file"), "utf8") : "")).trim()
      if (!body) throw new Error("comment needs --body TEXT or --body-file PATH")
      const release = flag("--release") && (!blocked || flag("--force"))
      const posted = initial.comments.some((comment) => (comment.body ?? "").trim().startsWith(body))
      const close = flag("--close") && initial.state !== "closed"
      const unlabeling = release && initial.labeled
      admit(Number(unlabeling) + Number(!posted) + Number(close))
      if (unlabeling) write(unlabel)
      if (!posted) {
        const line = release && live ? `\n\n${releaseBody({ ...me, now: now(), note: option("--note") })}` : ""
        write(["api", `${base}/comments`, "-f", `body=${body}${line}`])
      }
      if (close) {
        write(flag("--pr")
          ? ["api", "--method", "PATCH", `repos/${issue.repo}/pulls/${issue.number}`, "-f", "state=closed"]
          : ["api", "--method", "PATCH", base, "-f", "state=closed", "-f", "state_reason=completed"])
      }
      return result(0, { issue: id, action: posted ? "already-commented" : "commented", closed: flag("--close"),
        released: release && Boolean(live || initial.labeled), ...(flag("--release") && !release ? { holder: before } : {}) })
    }
    if (command === "release") {
      if (blocked && !flag("--force")) return result(2, { issue: id, action: "refused", holder: before })
      admit(Number(initial.labeled) + Number(Boolean(live)))
      if (initial.labeled) write(unlabel)
      if (live) write(["api", `${base}/comments`, "-f", `body=${releaseBody({ ...me, now: now(), note: option("--note") })}`])
      return result(0, { issue: id, action: live || initial.labeled ? "released" : "already-released", by: me.by, host: me.host })
    }
    if (blocked) return result(2, { issue: id, action: "refused", holder: before })
    if (mine(before, me) && !before.stale && initial.labeled && now().getTime() - Date.parse(before.at) < REFRESH_AFTER) {
      return result(0, { issue: id, action: "held", holder: before })
    }
    ensureLabel(issue.repo, { read: github.read, write: (args) => { admit(1); write(args) }, dir: env.ISSUE_CLAIM_CACHE || join(homedir(), ".cache", "issue-claim") })
    admit(initial.labeled ? 1 : 2)
    if (!initial.labeled) write(["api", `${base}/labels`, "-f", `labels[]=${LABEL}`])
    const takeover = before && before.stale && !mine(before, me) ? before.line : undefined
    try {
      write(["api", `${base}/comments`, "-f", `body=${claimBody({ ...me, now: now(), takeover, note: option("--note") })}`])
    } catch (error) {
      if (!initial.labeled) {
        try {
          const after = holder(read(issue, github.read), now().getTime())
          if (!after || after.by === "unknown") write(unlabel)
        } catch { /* keep the label when ownership cannot be checked */ }
      }
      throw error
    }
    const after = holder(readIssue(), now().getTime())
    if (!mine(after, me)) return result(2, { issue: id, action: "lost-race", holder: after })
    return result(0, { issue: id, action: takeover ? "took-over" : mine(before, me) ? "refreshed" : "claimed", holder: after })
  } catch (error) {
    if (!(error instanceof Transient)) throw error
    return result(TRANSIENT, { issue: id, action: "deferred", retry_at: new Date(error.retryAt).toISOString(), error: error.message })
  }
}

/** Creates the repository's `in-progress` label once; a marker file skips the lookup afterwards. */
const ensureLabel = (repo, { read, write, dir }) => {
  const marker = join(dir, `label-${repo.replace("/", "-")}`)
  try { statSync(marker); return } catch { /* not checked yet */ }
  try {
    read(["api", `repos/${repo}/labels/${LABEL}`])
  } catch (error) {
    if (!/HTTP 404|Not Found/i.test(errorText(error))) throw error
    write(["api", `repos/${repo}/labels`, "-f", `name=${LABEL}`, "-f", `color=${COLOR}`, "-f", "description=An agent is working this; see its Claimed by comment"])
  }
  mkdirSync(dir, { recursive: true })
  writeFileSync(marker, "")
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
