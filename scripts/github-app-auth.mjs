// The operator's GitHub credentials, for the GitHub proxy (scripts/github-proxy.ts).
//
// When a GitHub App is configured, a repository's requests run as that App's installation
// on the repository's owner, so agents never spend a person's rate limits. Configure
// ISSUE_CLAIM_APP_ID and ISSUE_CLAIM_APP_KEY_FILE, or the file ISSUE_CLAIM_APP_CONFIG
// (default ~/.config/issue-claim/app.json) as {"app_id": 123, "private_key_path": "~/key.pem"}.
// The installation token is cached in ISSUE_CLAIM_CACHE (default ~/.cache/issue-claim) with
// mode 0600 until 5 minutes before it expires; the key, the JWT and the token are never
// printed. Without a configured App, or when the App is not installed for the owner, the
// proxy uses the operator's own token. ISSUE_CLAIM_API_URL replaces https://api.github.com
// for token minting (tests).

import { execFileSync } from "node:child_process"
import { sign } from "node:crypto"
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import process from "node:process"

export const TOKEN_MARGIN = 5 * 60_000
const LIMITED = /secondary rate limit|rate limit exceeded|abuse detection/i

/** A token mint GitHub refused for rate limiting: retry at `retryAt`. */
export class MintLimited extends Error {
  constructor(message, retryAt) {
    super(message)
    this.retryAt = retryAt
  }
}

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
fetch(url, { method, headers: { authorization: "Bearer " + jwt, accept: "application/vnd.github+json", "user-agent": "smithers-github-proxy", "x-github-api-version": "2022-11-28" } })
  .then(async (r) => ({ status: r.status, retryAfter: r.headers.get("retry-after"), body: await r.text() }), (e) => ({ status: 0, body: String(e.message) }))
  .then((out) => process.stdout.write(JSON.stringify(out)))`], { input: JSON.stringify({ url, method, jwt }), encoding: "utf8", timeout: 30_000 }))

/**
 * The App credential for `repo`: `{ identity, token, installation }` for the configured App's
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
    if (Date.parse(cached.expires_at) - now().getTime() > TOKEN_MARGIN) return { identity: `app:${cached.slug}`, token: cached.token, installation: cached.installation }
  } catch { /* none cached yet */ }
  const jwt = appJwt(config.id, readFileSync(config.keyFile, "utf8"), now().getTime())
  const call = (method, path, ok) => {
    const response = request({ url: `${env.ISSUE_CLAIM_API_URL || "https://api.github.com"}${path}`, method, jwt })
    if (response.status === ok) return JSON.parse(response.body)
    let message = response.body
    try { message = JSON.parse(response.body).message } catch { /* not JSON */ }
    const failure = `GitHub App ${config.id} ${method} ${path}: HTTP ${response.status} ${String(message).slice(0, 200)}`
    if (response.status === 429 || (response.status === 403 && LIMITED.test(message))) {
      throw new MintLimited(failure, now().getTime() + Math.max(Number(response.retryAfter) * 1000 || 0, 60_000))
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
  return { identity: `app:${installation.app_slug}`, token, installation: installation.id }
}
