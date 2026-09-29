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
// Every GitHub write goes through one machine-wide throttle shared by all processes
// (ISSUE_CLAIM_CACHE, default ~/.cache/issue-claim): at most one write per 3 s and 15 per
// minute. A rate-limit response blocks every write for its Retry-After, its x-ratelimit
// reset, or an exponential backoff from 1 to 30 minutes, whichever is longest.
// Prints one JSON line. Exit 0: done, or free for you; 2: held by someone else; 75: rate
// limited, retry after `retry_at` (not a failed attempt, nothing to undo); 1: error.
// Environment: ISSUE_CLAIM_GH replaces the `gh` binary (tests); ISSUE_CLAIM_SPACING_MS,
// ISSUE_CLAIM_PER_MINUTE and ISSUE_CLAIM_MAX_WAIT_MS tune the throttle.
//
// GitHub identity: when a GitHub App is configured, every call runs as that App's
// installation on the issue's owner, so agents never spend a person's rate limits.
// Configure ISSUE_CLAIM_APP_ID and ISSUE_CLAIM_APP_KEY_FILE, or the file ISSUE_CLAIM_APP_CONFIG
// (default ~/.config/issue-claim/app.json) as {"app_id": 123, "private_key_path": "~/key.pem"}.
// The installation token is cached in the cache directory with mode 0600 until 5 minutes
// before it expires and reaches `gh` only through GH_TOKEN; the key, the JWT and the token
// are never printed. Without a configured App, or when the App is not installed for the
// owner, calls run as the `gh` user. Every output line names the identity that ran it.
// ISSUE_CLAIM_API_URL replaces https://api.github.com for token minting (tests).

import { execFileSync } from "node:child_process"
import { sign } from "node:crypto"
import { closeSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir, hostname, userInfo } from "node:os"
import { join } from "node:path"
import process from "node:process"

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

/** A write GitHub refused for rate limiting, or one the throttle cannot start soon: retry at `retryAt`. */
export class Transient extends Error {
  constructor(message, retryAt) {
    super(message)
    this.retryAt = retryAt
  }
}

const sleepSync = (ms) => { if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }

/** Runs `fn(state)` under an exclusive lock file; `fn` returns `{ result, save }` and `save` replaces the state. */
const locked = (dir, fn) => {
  mkdirSync(dir, { recursive: true })
  const lock = join(dir, "throttle.lock")
  const file = join(dir, "throttle.json")
  for (let tries = 0; ; tries++) {
    try {
      closeSync(openSync(lock, "wx"))
      break
    } catch (error) {
      if (error.code !== "EEXIST") throw error
      // A holder only reads and writes a small file, so a 10 s old lock belongs to a killed process.
      try { if (Date.now() - statSync(lock).mtimeMs > 10_000) rmSync(lock, { force: true }) } catch { /* released meanwhile */ }
      if (tries >= 400) throw new Transient("issue-claim throttle lock is busy", Date.now() + 1000)
      sleepSync(25)
    }
  }
  try {
    let state = {}
    try { state = JSON.parse(readFileSync(file, "utf8")) } catch { /* first use or torn file: start empty */ }
    const { result, save } = fn({ slots: [], blockedUntil: 0, backoff: 0, ...state })
    if (save) {
      writeFileSync(`${file}.tmp`, JSON.stringify(save))
      renameSync(`${file}.tmp`, file)
    }
    return result
  } finally {
    rmSync(lock, { force: true })
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

/**
 * The machine-wide write throttle. `reserve(n)` books n write slots, all or none;
 * `write(slot, gh, args)` waits for its slot and performs one `gh api` write.
 */
export const throttle = ({ env = process.env, now = () => new Date(), sleep = sleepSync } = {}) => {
  const dir = env.ISSUE_CLAIM_CACHE || join(homedir(), ".cache", "issue-claim")
  const spacing = Number(env.ISSUE_CLAIM_SPACING_MS ?? 3000)
  const perMinute = Number(env.ISSUE_CLAIM_PER_MINUTE ?? 15)
  const maxWait = Number(env.ISSUE_CLAIM_MAX_WAIT_MS ?? 30_000)
  const clock = () => now().getTime()
  const defer = (retryAt, why) => new Transient(`${why}; retry after ${new Date(retryAt).toISOString()}`, retryAt)

  const block = (headers, error) => locked(dir, (state) => {
    const t = clock()
    const backoff = error ? Math.min(Math.max(state.backoff * 2, 60_000), 1_800_000) : state.backoff
    const retryAfter = Number(headers["retry-after"]) * 1000 || 0
    const reset = headers["x-ratelimit-remaining"] === "0" ? Number(headers["x-ratelimit-reset"]) * 1000 || 0 : 0
    const blockedUntil = Math.max(state.blockedUntil, error ? t + Math.max(backoff, retryAfter) : 0, reset)
    return { result: blockedUntil, save: { ...state, backoff, blockedUntil } }
  })

  return {
    /** Throws Transient, without any GitHub call, while a rate-limit block outlasts the wait budget. */
    open() {
      const until = locked(dir, (state) => ({ result: state.blockedUntil }))
      if (until > clock() + maxWait) throw defer(until, "GitHub writes are paused after a rate limit")
    },
    reserve(n) {
      const slots = locked(dir, (state) => {
        const t = clock()
        const booked = state.slots.filter((at) => at > t - 60_000)
        const mine = []
        for (let i = 0; i < n; i++) {
          const recent = [...booked, ...mine]
          mine.push(Math.max(t, state.blockedUntil, (recent.at(-1) ?? -Infinity) + spacing,
            recent.length >= perMinute ? recent[recent.length - perMinute] + 60_000 : -Infinity))
        }
        if (mine.length && mine.at(-1) - t > maxWait) return { result: { retryAt: mine.at(-1) } }
        return { result: mine, save: { ...state, slots: [...booked, ...mine] } }
      })
      if (!Array.isArray(slots)) throw defer(slots.retryAt, "the machine-wide GitHub write budget is booked")
      return slots
    },
    write(slot, gh, args) {
      sleep(slot - clock())
      let out
      try {
        out = gh(args[0] === "api" ? ["api", "-i", ...args.slice(1)] : args)
      } catch (error) {
        const { headers } = splitResponse(String(error.stdout ?? ""))
        if (!limited(errorText(error), headers)) throw error
        throw defer(block(headers, true), `GitHub rate limit: ${String(error.stderr || error.message).trim().split("\n")[0]}`)
      }
      const { headers, body } = splitResponse(out)
      if (headers["x-ratelimit-remaining"] === "0") block(headers, false)
      else locked(dir, (state) => ({ save: state.backoff ? { ...state, backoff: 0 } : undefined }))
      return body
    }
  }
}

const defaultGh = (args, auth = {}) => {
  const binary = process.env.ISSUE_CLAIM_GH || "gh"
  return execFileSync(binary, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 << 20, env: { ...process.env, ...auth } })
}

export const TOKEN_MARGIN = 5 * 60_000

/** The configured GitHub App as `{ id, keyFile }`, or null when none is configured. */
export const appConfig = (env = process.env) => {
  const home = (path) => path.replace(/^~(?=\/)/, homedir())
  if (env.ISSUE_CLAIM_APP_ID && env.ISSUE_CLAIM_APP_KEY_FILE) return { id: env.ISSUE_CLAIM_APP_ID, keyFile: home(env.ISSUE_CLAIM_APP_KEY_FILE) }
  let config
  try { config = JSON.parse(readFileSync(env.ISSUE_CLAIM_APP_CONFIG || join(homedir(), ".config", "issue-claim", "app.json"), "utf8")) } catch { return null }
  return config.app_id && config.private_key_path ? { id: String(config.app_id), keyFile: home(config.private_key_path) } : null
}

/** A 9-minute RS256 JWT that authenticates as the App itself; GitHub allows at most 10. */
export const appJwt = (id, key, nowMs) => {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString("base64url")
  const at = Math.floor(nowMs / 1000)
  const unsigned = `${part({ alg: "RS256", typ: "JWT" })}.${part({ iat: at - 60, exp: at + 540, iss: id })}`
  return `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), key).toString("base64url")}`
}

/** One synchronous GitHub API call authenticated by `jwt`, sent to a child process on stdin, never in argv. */
const requestSync = ({ url, method, jwt }) => JSON.parse(execFileSync(process.execPath, ["-e", `
const { url, method, jwt } = JSON.parse(require("node:fs").readFileSync(0, "utf8"))
fetch(url, { method, headers: { authorization: "Bearer " + jwt, accept: "application/vnd.github+json", "user-agent": "issue-claim", "x-github-api-version": "2022-11-28" } })
  .then(async (r) => ({ status: r.status, retryAfter: r.headers.get("retry-after"), body: await r.text() }), (e) => ({ status: 0, body: String(e.message) }))
  .then((out) => process.stdout.write(JSON.stringify(out)))`], { input: JSON.stringify({ url, method, jwt }), encoding: "utf8", timeout: 30_000 }))

/**
 * The GitHub identity for calls on `repo`: `{ identity, token }` for the configured App's
 * installation on the repo's owner, `{ identity: "gh-user" }` otherwise. Reuses the cached
 * token until TOKEN_MARGIN before its expiry, then mints a new one.
 */
export const appAuth = (repo, { env = process.env, now = () => new Date(), request = requestSync } = {}) => {
  const config = appConfig(env)
  if (!config) return { identity: "gh-user" }
  const dir = env.ISSUE_CLAIM_CACHE || join(homedir(), ".cache", "issue-claim")
  const file = join(dir, `app-${config.id}-${repo.split("/")[0]}.json`)
  try {
    const cached = JSON.parse(readFileSync(file, "utf8"))
    if (Date.parse(cached.expires_at) - now().getTime() > TOKEN_MARGIN) return { identity: `app:${cached.slug}`, token: cached.token }
  } catch { /* none cached yet */ }
  const jwt = appJwt(config.id, readFileSync(config.keyFile, "utf8"), now().getTime())
  const call = (method, path, ok) => {
    const response = request({ url: `${env.ISSUE_CLAIM_API_URL || "https://api.github.com"}${path}`, method, jwt })
    if (response.status === ok) return JSON.parse(response.body)
    let message = response.body
    try { message = JSON.parse(response.body).message } catch { /* not JSON */ }
    const failure = `GitHub App ${config.id} ${method} ${path}: HTTP ${response.status} ${String(message).slice(0, 200)}`
    if (response.status === 429 || (response.status === 403 && LIMITED.test(message))) {
      throw new Transient(failure, now().getTime() + Math.max(Number(response.retryAfter) * 1000 || 0, 60_000))
    }
    throw Object.assign(new Error(failure), { status: response.status })
  }
  let installation
  try { installation = call("GET", `/repos/${repo}/installation`, 200) } catch (error) {
    if (error.status === 404) return { identity: "gh-user", reason: `GitHub App ${config.id} is not installed for ${repo}` }
    throw error
  }
  const { token, expires_at } = call("POST", `/app/installations/${installation.id}/access_tokens`, 201)
  mkdirSync(dir, { recursive: true })
  rmSync(`${file}.tmp`, { force: true })
  writeFileSync(`${file}.tmp`, JSON.stringify({ installation: installation.id, slug: installation.app_slug, token, expires_at }), { mode: 0o600 })
  renameSync(`${file}.tmp`, file)
  return { identity: `app:${installation.app_slug}`, token }
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

/** Runs a command as the configured App when there is one; see `appAuth`. `out.identity` names who ran it. */
export const run = (argv, { gh = defaultGh, now = () => new Date(), env = process.env, sleep, request } = {}) => {
  const [command, ref] = argv
  if (!["check", "claim", "release", "comment"].includes(command)) return runAs(argv, { gh, now, env, sleep })
  const issue = parseRef(ref)
  let auth
  try { auth = appAuth(issue.repo, { env, now, request }) } catch (error) {
    if (!(error instanceof Transient)) throw error
    return { code: TRANSIENT, out: { issue: `${issue.repo}#${issue.number}`, action: "deferred", retry_at: new Date(error.retryAt).toISOString(), error: error.message } }
  }
  const result = runAs(argv, { gh: auth.token ? (args) => gh(args, { GH_TOKEN: auth.token }) : gh, now, env, sleep })
  return { ...result, out: { ...result.out, identity: auth.identity, ...(auth.reason ? { identity_reason: auth.reason } : {}) } }
}

const runAs = (argv, { gh, now, env, sleep }) => {
  const [command, ref, ...rest] = argv
  const option = (name) => { const at = rest.indexOf(name); return at < 0 ? undefined : rest[at + 1] }
  const flag = (name) => rest.includes(name)
  if (!["check", "claim", "release", "comment"].includes(command)) {
    throw new Error("usage: issue-claim.mjs check|claim|release|comment <repo>#<n> [--by NAME] [--note TEXT] [--force] [--body TEXT | --body-file PATH] [--close] [--pr] [--release]")
  }
  const issue = parseRef(ref)
  const me = { by: option("--by") || env.ISSUE_CLAIM_BY || env.CLAUDE_SESSION_NAME || `${userInfo().username}-${process.ppid}`, host: hostname() }
  const id = `${issue.repo}#${issue.number}`
  const writes = throttle({ env, now, sleep })
  const write = (slot, args) => writes.write(slot, gh, args)
  // Reads never hit the content-creation limit, but a primary rate limit on them is transient too.
  const readIssue = () => {
    try { return read(issue, gh) } catch (error) {
      if (LIMITED.test(errorText(error))) throw new Transient(`GitHub rate limit on read: ${error.message}`, now().getTime() + 60_000)
      throw error
    }
  }
  const base = `repos/${issue.repo}/issues/${issue.number}`
  const unlabel = ["api", "--method", "DELETE", `${base}/labels/${LABEL}`]
  try {
    if (command !== "check") writes.open()
    const initial = readIssue()
    const before = holder(initial, now().getTime())
    const blocked = before && !before.stale && !mine(before, me)
    // A live claim a release must end with a comment; a bare label only needs removing.
    const live = before && !before.stale && before.by !== "unknown"
    if (command === "check") return { code: blocked ? 2 : 0, out: { issue: id, free: !before || before.stale, mine: Boolean(mine(before, me)), holder: before } }
    if (command === "comment") {
      const body = (option("--body") ?? (option("--body-file") ? readFileSync(option("--body-file"), "utf8") : "")).trim()
      if (!body) throw new Error("comment needs --body TEXT or --body-file PATH")
      const release = flag("--release") && (!blocked || flag("--force"))
      const posted = initial.comments.some((comment) => (comment.body ?? "").trim().startsWith(body))
      const close = flag("--close") && initial.state !== "closed"
      const unlabeling = release && initial.labeled
      const slots = writes.reserve(Number(unlabeling) + Number(!posted) + Number(close))
      if (unlabeling) write(slots.shift(), unlabel)
      if (!posted) {
        const line = release && live ? `\n\n${releaseBody({ ...me, now: now(), note: option("--note") })}` : ""
        write(slots.shift(), ["api", `${base}/comments`, "-f", `body=${body}${line}`])
      }
      if (close) {
        write(slots.shift(), flag("--pr")
          ? ["api", "--method", "PATCH", `repos/${issue.repo}/pulls/${issue.number}`, "-f", "state=closed"]
          : ["api", "--method", "PATCH", base, "-f", "state=closed", "-f", "state_reason=completed"])
      }
      return { code: 0, out: { issue: id, action: posted ? "already-commented" : "commented", closed: flag("--close"),
        released: release && Boolean(live || initial.labeled), ...(flag("--release") && !release ? { holder: before } : {}) } }
    }
    if (command === "release") {
      if (blocked && !flag("--force")) return { code: 2, out: { issue: id, action: "refused", holder: before } }
      const slots = writes.reserve(Number(initial.labeled) + Number(Boolean(live)))
      if (initial.labeled) write(slots.shift(), unlabel)
      if (live) write(slots.shift(), ["api", `${base}/comments`, "-f", `body=${releaseBody({ ...me, now: now(), note: option("--note") })}`])
      return { code: 0, out: { issue: id, action: live || initial.labeled ? "released" : "already-released", by: me.by, host: me.host } }
    }
    if (blocked) return { code: 2, out: { issue: id, action: "refused", holder: before } }
    if (mine(before, me) && !before.stale && initial.labeled && now().getTime() - Date.parse(before.at) < REFRESH_AFTER) {
      return { code: 0, out: { issue: id, action: "held", holder: before } }
    }
    ensureLabel(issue.repo, { gh, write: (args) => write(writes.reserve(1)[0], args), dir: env.ISSUE_CLAIM_CACHE || join(homedir(), ".cache", "issue-claim") })
    const slots = writes.reserve(initial.labeled ? 1 : 2)
    if (!initial.labeled) write(slots.shift(), ["api", `${base}/labels`, "-f", `labels[]=${LABEL}`])
    const takeover = before && before.stale && !mine(before, me) ? before.line : undefined
    try {
      write(slots.shift(), ["api", `${base}/comments`, "-f", `body=${claimBody({ ...me, now: now(), takeover, note: option("--note") })}`])
    } catch (error) {
      if (!initial.labeled) {
        try {
          const after = holder(read(issue, gh), now().getTime())
          if (!after || after.by === "unknown") gh(unlabel)
        } catch { /* keep the label when ownership cannot be checked */ }
      }
      throw error
    }
    const after = holder(readIssue(), now().getTime())
    if (!mine(after, me)) return { code: 2, out: { issue: id, action: "lost-race", holder: after } }
    return { code: 0, out: { issue: id, action: takeover ? "took-over" : mine(before, me) ? "refreshed" : "claimed", holder: after } }
  } catch (error) {
    if (!(error instanceof Transient)) throw error
    return { code: TRANSIENT, out: { issue: id, action: "deferred", retry_at: new Date(error.retryAt).toISOString(), error: error.message } }
  }
}

/** Creates the repository's `in-progress` label once; a marker file skips the lookup afterwards. */
const ensureLabel = (repo, { gh, write, dir }) => {
  const marker = join(dir, `label-${repo.replace("/", "-")}`)
  try { statSync(marker); return } catch { /* not checked yet */ }
  try {
    gh(["api", `repos/${repo}/labels/${LABEL}`])
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
