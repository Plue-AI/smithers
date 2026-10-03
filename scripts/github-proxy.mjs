#!/usr/bin/env node

// The machine's GitHub proxy: every GitHub call on this machine goes through it, so one
// rate limiter per principal keeps the machine inside GitHub's limits and only this process
// holds the operator's GitHub credential. See GitHub.Proxy in @smthrs/integrations
// (packages/smithers/agent/integrations/docs/guides/github.md).
//
//   node scripts/github-proxy.mjs            serve in the foreground
//   node scripts/github-proxy.mjs --ensure   start it in the background unless it answers; exit 0 once it does
//
// SMITHERS_GITHUB_PROXY (default http://127.0.0.1:47821) is where it listens and where
// clients find it. One proxy per machine: a second one cannot bind the port, and --ensure
// finds the first by its health endpoint. Start it from the operator's shell or the flow
// host: it reads the operator's credentials, which a confined child cannot.
//
// Credentials: a repository's requests run as the configured GitHub App's installation on
// the owner (scripts/github-app-auth.mjs); everything else, and every owner without the App,
// runs as SMITHERS_GITHUB_TOKEN, else GITHUB_TOKEN, else `gh auth token`. Callers send no
// token; one they send is dropped. Listening beyond loopback requires a capability that
// every caller sends as `Authorization: Bearer <capability>`: the first line of
// SMITHERS_GITHUB_PROXY_CAPABILITY_FILE.
// --ensure logs the background proxy to SMITHERS_GITHUB_PROXY_LOG (default
// ~/.cache/smithers/github-proxy.log). SMITHERS_GITHUB_PROXY_UPSTREAM replaces https://api.github.com (tests); the
// SMITHERS_GITHUB_* limit variables of GitHub.RateLimit tune the limits.

import { execFileSync, spawn } from "node:child_process"
import { existsSync, mkdirSync, openSync, readFileSync, realpathSync } from "node:fs"
import { createRequire } from "node:module"
import { homedir } from "node:os"
import { pathToFileURL } from "node:url"
import { dirname, join } from "node:path"
import process from "node:process"

export const DEFAULT_PROXY = "http://127.0.0.1:47821"

/** The proxy's base URL from the environment. */
export const proxyUrl = (env = process.env) => (env.SMITHERS_GITHUB_PROXY || DEFAULT_PROXY).replace(/\/+$/, "")

const healthy = async (base) => {
  try {
    const response = await fetch(`${base}/_smithers/health`, { signal: AbortSignal.timeout(3000) })
    return response.ok && (await response.json()).ok === true
  } catch {
    return false
  }
}

/** Starts the proxy in the background unless one answers at `base`; resolves once one does. */
export const ensure = async ({ env = process.env, script = new URL(import.meta.url).pathname, waitMs = 15_000 } = {}) => {
  const base = proxyUrl(env)
  if (await healthy(base)) return { base, started: false }
  const logFile = env.SMITHERS_GITHUB_PROXY_LOG || join(homedir(), ".cache", "smithers", "github-proxy.log")
  mkdirSync(dirname(logFile), { recursive: true })
  const log = openSync(logFile, "a")
  spawn(process.execPath, [script], { env, detached: true, stdio: ["ignore", log, log] }).unref()
  for (const deadline = Date.now() + waitMs; Date.now() < deadline;) {
    if (await healthy(base)) return { base, started: true }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`the GitHub proxy did not answer at ${base} within ${waitMs} ms; see ${logFile}`)
}

/** Resolve a public integration export through the CLI's declared dependency. */
export const proxyIntegrationUrl = (name) => {
  const cliRequire = createRequire(createRequire(import.meta.url).resolve("@smthrs/cli/package.json"))
  return pathToFileURL(cliRequire.resolve(`@smthrs/integrations/${name}`)).href
}

/** Serves the proxy until the process is stopped. */
export const serve = async (env = process.env) => {
  const [{ Effect, Layer }, NodeHttpServer, NodeRuntime, { createServer }, { IntegrationError }, Proxy, RateLimit, { appAuth, appConfig, MintLimited }] =
    await Promise.all([
      import("effect"),
      import("@effect/platform-node/NodeHttpServer"),
      import("@effect/platform-node/NodeRuntime"),
      import("node:http"),
      import(proxyIntegrationUrl("core/IntegrationError")),
      import(proxyIntegrationUrl("github/Proxy")),
      import(proxyIntegrationUrl("github/RateLimit")),
      import("./github-app-auth.mjs")
    ])
  const url = new URL(proxyUrl(env))
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
  const capabilityFile = env.SMITHERS_GITHUB_PROXY_CAPABILITY_FILE
  const capability = capabilityFile ? readFileSync(capabilityFile, "utf8").split("\n")[0].trim() : undefined
  if (!loopback && !capability) throw new Error(`listening on ${url.hostname} needs SMITHERS_GITHUB_PROXY_CAPABILITY_FILE`)
  let userToken
  const operatorToken = () => {
    userToken ??= env.SMITHERS_GITHUB_TOKEN || env.GITHUB_TOKEN ||
      execFileSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
    return userToken
  }
  // A proxy started without the operator's credentials (from a sandboxed child, say) would
  // hold the port and fail every caller; refuse to start so the next caller can start a working one.
  const app = appConfig(env)
  const hasApp = app !== null && existsSync(app.keyFile)
  let hasToken = false
  try { hasToken = operatorToken() !== "" } catch { /* no gh login */ }
  if (!hasApp && !hasToken) throw new Error("no GitHub credential: configure the GitHub App, set SMITHERS_GITHUB_TOKEN, or log in with gh")
  const credential = (repository) => Effect.try({
    try: () => {
      if (repository !== undefined) {
        const app = appAuth(repository, { env })
        if (app.token) return { token: app.token, principal: `${app.identity}@${repository.split("/")[0]}` }
      }
      return { token: operatorToken(), principal: "gh-user" }
    },
    catch: (cause) => cause instanceof MintLimited
      ? new IntegrationError("rate-limited", cause.message, { retryAt: new Date(cause.retryAt).toISOString(), reason: "app token" })
      : new IntegrationError("credentials-missing", `No GitHub credential: ${String(cause?.message ?? cause).split("\n")[0]}`)
  })
  const proxy = Proxy.layer({
    upstream: env.SMITHERS_GITHUB_PROXY_UPSTREAM || undefined,
    credential,
    capability,
    limits: RateLimit.resolveLimits({}, env)
  })
  const server = NodeHttpServer.layer(createServer, { port: Number(url.port || 80), host: url.hostname.replace(/^\[|\]$/g, "") })
  console.error(`smithers github proxy: listening on ${url.origin}`)
  NodeRuntime.runMain(Layer.launch(Layer.provide(proxy, server)))
}

const isMain = () => {
  try { return realpathSync(process.argv[1]) === realpathSync(new URL(import.meta.url).pathname) } catch { return false }
}

if (isMain()) {
  if (process.argv.includes("--ensure")) {
    ensure().then(
      ({ base, started }) => console.log(JSON.stringify({ proxy: base, started })),
      (error) => { console.error(JSON.stringify({ error: error.message })); process.exitCode = 1 }
    )
  } else {
    serve().catch((error) => { console.error(JSON.stringify({ error: error.message })); process.exitCode = 1 })
  }
}
