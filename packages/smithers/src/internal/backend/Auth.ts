/**
 * Browser login, consent and subscription connections for the npm CLI.
 * @since 0.1.0
 */

import { randomBytes, timingSafeEqual } from "node:crypto"
import { createServer, type IncomingMessage } from "node:http"
import { Refused, UsageError } from "../../CliError.ts"
import * as Failure from "../Failure.ts"
import { APIError, type Client, object, str, type Values, withCause } from "./Client.ts"
import type { Handler } from "./Resources.ts"
import { invalidToken, observeOrigin } from "./Session.ts"

const refused = (fault: "user" | "infra", code: string, message: string) => new Refused({ fault, code, message })

const equal = (a: string, b: string) =>
  Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b))
const open = async (c: Client, url: string) => {
  try {
    await c.exec(
      c.env.BROWSER ||
        (process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32" : "xdg-open"),
      process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url]
    )
  } catch {
    c.write(`Open ${url}\n`)
  }
}
const readJSON = async (req: IncomingMessage): Promise<Values> => {
  let data = ""
  for await (const chunk of req) {
    data += chunk
    if (data.length > 1024 * 1024) throw refused("user", "invalid_callback", "Callback too large")
  }
  return object(JSON.parse(data))
}
const bridge =
  `<!doctype html><meta charset="utf-8"><title>Smithers login</title><p id="status">Completing login…</p><script>
const p=new URLSearchParams(location.hash.slice(1));history.replaceState(null,'',location.pathname);
fetch('/callback',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.fromEntries(p))}).then(async r=>{document.getElementById('status').textContent=await r.text()}).catch(()=>{document.getElementById('status').textContent='Login failed'});
</script>`
/**
 * @private
 * @since 1.0.0
 */
export const browserLogin = async (
  c: Client,
  origin: string,
  admin: boolean,
  ttl: string,
  launch = (url: string): void => void open(c, url),
  timeout = 300_000
): Promise<Values> => {
  const state = randomBytes(32).toString("base64url")
  let finish!: (value: Values) => void, fail!: (error: Error) => void, finished = false, loopback = ""
  const result = new Promise<Values>((resolve, reject) => {
    finish = resolve
    fail = reject
  })
  const server = createServer(async (req, res) => {
    res.setHeader("cache-control", "no-store")
    res.setHeader("referrer-policy", "no-referrer")
    res.setHeader("x-frame-options", "DENY")
    // A DNS-rebinding page reaches this port under its own Host and Origin.
    if (`http://${req.headers.host}` !== loopback) {
      res.writeHead(403).end()
      return
    }
    if (req.url?.split("?")[0] !== "/callback") {
      res.writeHead(404).end()
      return
    }
    if (req.method === "GET") {
      res.setHeader("content-type", "text/html; charset=utf-8")
      res.end(bridge)
      return
    }
    if (req.method !== "POST") {
      res.writeHead(405).end()
      return
    }
    if (req.headers.origin !== loopback) {
      res.writeHead(403).end()
      return
    }
    if (!req.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
      res.writeHead(415).end()
      return
    }
    try {
      const value = await readJSON(req)
      if (!equal(str(value.callback_state), state)) {
        res.writeHead(403).end("Invalid callback state")
        return
      }
      if (finished) {
        res.writeHead(409).end()
        return
      }
      if (!str(value.token).trim() || /\s/.test(str(value.token).trim())) throw invalidToken()
      if (admin && !(Date.parse(str(value.expires_at)) > Date.now())) {
        throw refused("user", "invalid_callback", "Admin login requires a future expiry")
      }
      finished = true
      res.end("Logged in. You can close this tab.")
      finish(value)
    } catch (error) {
      res.writeHead(400).end("Invalid callback")
      fail(Failure.isTagged(error) ? error : withCause(refused("user", "invalid_callback", "Invalid callback"), error))
    }
  })
  server.requestTimeout = 10_000
  server.headersTimeout = 5_000
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const port = (server.address() as { port: number }).port
  loopback = `http://127.0.0.1:${port}`
  const url = `${origin}/api/auth/github/cli?${new URLSearchParams({
    callback_port: String(port),
    callback_state: state,
    ...(admin ? { admin: "1", ttl: ttl || "1h" } : {})
  })}`
  const timer = setTimeout(() => fail(refused("user", "timed_out", "Timed out waiting for browser login")), timeout)
  const abort = () => fail(refused("user", "cancelled", "Login cancelled"))
  c.runtime.signal?.addEventListener("abort", abort, { once: true })
  try {
    if (c.runtime.signal?.aborted) abort()
    else launch(url)
    return await result
  } finally {
    clearTimeout(timer)
    c.runtime.signal?.removeEventListener("abort", abort)
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}
const anthropicKey = (value: string) => {
  const key = value.match(/\bsk-ant-api[0-9a-z-]*-[A-Za-z0-9._-]+\b/)?.[0]
  if (!key) throw new UsageError({ message: "Expected an Anthropic API key (sk-ant-api...)" })
  return key
}
const providerLogin = (provider: string): Values => {
  if (provider === "claude") {
    throw new UsageError({
      message:
        "A Claude subscription is never stored; it runs locally through Claude Code. Use --api-key for an Anthropic API key"
    })
  }
  if (provider !== "codex") throw new UsageError({ message: "Provider must be claude or codex" })
  throw refused(
    "user",
    "not_signed_in",
    "Run `codex login --device-auth` on the workspace; Codex subscriptions are never sent to a workspace"
  )
}
/**
 * @private
 * @since 1.0.0
 */
export const auth: Record<string, Handler> = {}
auth["auth login"] = async (c, _a, o) => {
  const target = c.session.target(str(o.hostname || o.host)), admin = !!(o.admin || o.observe)
  if (o.ttl && !admin) throw new UsageError({ message: "--ttl requires --admin" })
  if (admin && o["with-token"]) throw new UsageError({ message: "--admin requires browser consent" })
  if (o.ttl) {
    const raw = str(o.ttl), matches = [...raw.matchAll(/(\d+(?:\.\d+)?)(h|m|s)/g)]
    const duration = matches.reduce((sum, m) => sum + Number(m[1]) * ({ h: 3600, m: 60, s: 1 }[m[2]!] ?? 0), 0)
    if (matches.map((m) => m[0]).join("") !== raw || duration < 300 || duration > 43200) {
      throw new UsageError({ message: "--ttl must be between 5m and 12h" })
    }
  }
  if (o.observe) observeOrigin(str(c.session.config().observe_url))
  const value = o["with-token"]
    ? { token: await c.stdin("Login token") }
    : await browserLogin(c, target.api_url, admin, str(o.ttl))
  const { token, callback_state: _state, ...metadata } = value
  const saved = await c.session.save(target.api_url, str(token), { ...metadata, admin })
  if (o.observe) await openObserve(c, str(token))
  return {
    status: "logged_in",
    host: target.host,
    user: metadata.username,
    admin,
    expires_at: metadata.expires_at,
    token_source: saved.source
  }
}
// #2777: the removed `auth claude login` kept a Claude setup token in the
// CLI's own keyring entry. Logging out and connecting Claude delete it without
// reading it; Claude Code's own login is never touched. A keyring failure never
// blocks the command.
const forgetClaudeToken = (c: Client) => c.session.keyring("delete", "claude.subscription-token").catch(() => undefined)
auth["auth logout"] = async (c, _a, o) => {
  await forgetClaudeToken(c)
  return await c.session.clear(str(o.hostname))
}
auth["auth status"] = async (c, _a, o) => {
  const target = c.session.target(str(o.hostname)), resolved = await c.session.resolve(target.api_url)
  if (!resolved) {
    if (!o.context) c.runtime.exit?.(1)
    return { logged_in: false, token_set: false, ...target }
  }
  const record = c.session.record(target.api_url),
    result: Values = {
      logged_in: true,
      token_set: true,
      ...target,
      token_source: resolved.source,
      username: record?.username,
      expires_at: record?.expires_at,
      admin: record?.admin ?? false
    }
  try {
    const user = object(await c.request("GET", "/api/user", undefined, { origin: target.api_url }))
    result.username = user.login || user.username
    result.email = user.email
  } catch (error) {
    if (error instanceof APIError && [401, 403].includes(error.status)) {
      result.logged_in = false
      if (!o.context) c.runtime.exit?.(1)
    } else result.verified = false
  }
  return result
}
auth["auth token"] = async (c, _a, o) => {
  const { token: _token, ...metadata } = await c.session.require(str(o.hostname))
  return { ...metadata, token_set: true }
}
auth["auth connect"] = async (c, a, o) => {
  const provider = str(a.provider).trim().toLowerCase()
  if (provider === "claude") await forgetClaudeToken(c)
  const payload = provider === "claude" && o["api-key"]
    ? { provider, kind: "api_key", access_token: anthropicKey(await c.stdin("Anthropic API key")) }
    : providerLogin(provider)
  return c.request("POST", "/api/user/provider-connections", { ...payload, label: str(o.label) })
}
auth["auth connections"] = (c, _a, o) =>
  c.request(
    "GET",
    o.org ? `/api/orgs/${encodeURIComponent(str(o.org))}/provider-connections` : "/api/user/provider-connections"
  )
auth["auth revoke"] = async (c, a) => {
  await c.request("DELETE", `/api/user/provider-connections/${encodeURIComponent(str(a.id))}`)
  return { status: "revoked", id: a.id }
}
const openObserve = async (c: Client, token: string) => {
  const base = observeOrigin(str(c.session.config().observe_url)), state = randomBytes(32).toString("base64url")
  let resolve!: () => void, reject!: (error: Error) => void, finished = false, origin = ""
  const done = new Promise<void>((yes, no) => {
    resolve = yes
    reject = no
  })
  const server = createServer(async (req, res) => {
    res.setHeader("cache-control", "no-store")
    res.setHeader("referrer-policy", "no-referrer")
    res.setHeader("x-frame-options", "DENY")
    if (`http://${req.headers.host}` !== origin || req.url?.split("?")[0] !== "/observe") {
      res.writeHead(403).end()
      return
    }
    if (req.method === "GET") {
      res.setHeader("content-type", "text/html; charset=utf-8")
      res.end(
        `<!doctype html><p id="status">Opening Observe…</p><script>const p=new URLSearchParams(location.hash.slice(1));history.replaceState(null,'',location.pathname);fetch('/observe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({state:p.get('state'),challenge:p.get('challenge')})}).then(async r=>{if(!r.ok)throw Error();location.replace((await r.json()).url)}).catch(()=>{document.getElementById('status').textContent='Sign-in failed'})</script>`
      )
      return
    }
    if (
      req.method !== "POST" || req.headers.origin !== origin ||
      !req.headers["content-type"]?.startsWith("application/json")
    ) {
      res.writeHead(403).end()
      return
    }
    try {
      const body = await readJSON(req)
      if (!equal(str(body.state), state) || !/^[A-Za-z0-9_-]{43}$/.test(str(body.challenge))) {
        res.writeHead(403).end()
        return
      }
      if (finished) {
        res.writeHead(409).end()
        return
      }
      finished = true
      const response = object(
        await c.request("POST", "/api/v1/auth/browser-handoff", { challenge: body.challenge }, { origin: base, token })
      )
      if (!/^[A-Za-z0-9_-]{43}$/.test(str(response.ticket))) {
        throw refused("infra", "backend_protocol", "Invalid Observe ticket")
      }
      res.setHeader("content-type", "application/json")
      res.end(
        JSON.stringify({ url: `${base}/login/cli#${new URLSearchParams({ state, ticket: str(response.ticket) })}` })
      )
      resolve()
    } catch (error) {
      res.writeHead(502).end()
      reject(withCause(refused("infra", "observe_failed", "Observe sign-in failed"), error))
    }
  })
  server.requestTimeout = 10_000
  server.headersTimeout = 5000
  await new Promise<void>((yes, no) => {
    server.once("error", no)
    server.listen(0, "127.0.0.1", yes)
  })
  const port = (server.address() as { port: number }).port
  origin = `http://127.0.0.1:${port}`
  const timer = setTimeout(() => reject(refused("user", "timed_out", "Timed out opening Observe")), 300_000)
  const abort = () => reject(refused("user", "cancelled", "Observe sign-in cancelled"))
  c.runtime.signal?.addEventListener("abort", abort, { once: true })
  try {
    if (c.runtime.signal?.aborted) abort()
    else void open(c, `${base}/login/cli#${new URLSearchParams({ state, port: String(port) })}`)
    await done
  } finally {
    clearTimeout(timer)
    c.runtime.signal?.removeEventListener("abort", abort)
    server.closeAllConnections()
    await new Promise<void>((yes) => server.close(() => yes()))
  }
}
