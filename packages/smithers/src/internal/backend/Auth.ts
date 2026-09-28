/**
 * Browser consent, owner login and subscription connections for the npm CLI.
 * @since 0.1.0
 */

import * as prompts from "@clack/prompts"
import { randomBytes, timingSafeEqual } from "node:crypto"
import { readFile } from "node:fs/promises"
import { createServer, type IncomingMessage } from "node:http"
import { join } from "node:path"
import { APIError, type Client, object, str, type Values } from "./Client.ts"
import type { Handler } from "./Resources.ts"
import { observeOrigin } from "./Session.ts"

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
    if (data.length > 1024 * 1024) throw new Error("Callback too large")
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
      if (!str(value.token).trim() || /\s/.test(str(value.token).trim())) throw new Error("Invalid login token")
      if (admin && !(Date.parse(str(value.expires_at)) > Date.now())) {
        throw new Error("Admin login requires a future expiry")
      }
      finished = true
      res.end("Logged in. You can close this tab.")
      finish(value)
    } catch (error) {
      res.writeHead(400).end("Invalid callback")
      fail(error instanceof Error ? error : new Error("Invalid callback"))
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
  const timer = setTimeout(() => fail(new Error("Timed out waiting for browser login")), timeout)
  const abort = () => fail(new Error("Login cancelled"))
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
const setupToken = (value: string) => {
  const token = value.match(/\bsk-ant-oat[0-9a-z-]*-[A-Za-z0-9._-]+\b/)?.[0]
  if (!token) throw new Error("Expected a Claude subscription token from claude setup-token")
  return token
}
const claims = (token: unknown): Values => {
  try {
    return object(JSON.parse(Buffer.from(str(token).split(".")[1]!, "base64url").toString()))
  } catch {
    return {}
  }
}
const providerLogin = async (c: Client, provider: string, directory: string): Promise<Values> => {
  if (provider === "claude") {
    const dir = directory || c.env.CLAUDE_CONFIG_DIR || join(c.home, ".claude")
    let raw: string
    try {
      raw = await readFile(join(dir, ".credentials.json"), "utf8")
    } catch {
      if (process.platform !== "darwin") throw new Error("No Claude subscription login; run claude and sign in")
      raw = await c.exec("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"])
    }
    const oauth = object(object(JSON.parse(raw)).claudeAiOauth)
    if (!oauth.accessToken) throw new Error("Claude login is not a subscription login")
    let meta: Values = {}
    try {
      meta = object(JSON.parse(await readFile(join(dir, ".claude.json"), "utf8")))
    } catch { /* optional metadata */ }
    return {
      provider,
      kind: "oauth",
      access_token: oauth.accessToken,
      refresh_token: str(oauth.refreshToken),
      plan: str(oauth.subscriptionType),
      ...(Number(oauth.expiresAt) > 0 ? { access_expires_at: new Date(Number(oauth.expiresAt)).toISOString() } : {}),
      account_email: str(object(meta.oauthAccount).emailAddress)
    }
  }
  if (provider !== "codex") throw new Error("Provider must be claude or codex")
  const dir = directory || c.env.CODEX_HOME || join(c.home, ".codex")
  const tokens = object(object(JSON.parse(await readFile(join(dir, "auth.json"), "utf8"))).tokens)
  if (!tokens.access_token || !tokens.refresh_token) throw new Error("Codex login is not a ChatGPT subscription login")
  const id = claims(tokens.id_token),
    auth = object(id["https://api.openai.com/auth"]),
    access = claims(tokens.access_token)
  return {
    provider,
    kind: "oauth",
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    account_id: tokens.account_id || auth.chatgpt_account_id,
    account_email: id.email,
    plan: auth.chatgpt_plan_type,
    ...(Number(access.exp) > 0 ? { access_expires_at: new Date(Number(access.exp) * 1000).toISOString() } : {})
  }
}
/**
 * @private
 * @since 1.0.0
 */
export const auth: Record<string, Handler> = {}
auth["auth login"] = async (c, _a, o) => {
  const target = c.session.target(str(o.hostname || o.host)), admin = !!(o.admin || o.observe)
  if (o.ttl && !admin) throw new Error("--ttl requires --admin")
  if (admin && o["with-token"]) throw new Error("--admin requires browser consent")
  if (o.ttl) {
    const raw = str(o.ttl), matches = [...raw.matchAll(/(\d+(?:\.\d+)?)(h|m|s)/g)]
    const duration = matches.reduce((sum, m) => sum + Number(m[1]) * ({ h: 3600, m: 60, s: 1 }[m[2]!] ?? 0), 0)
    if (matches.map((m) => m[0]).join("") !== raw || duration < 300 || duration > 43200) {
      throw new Error("--ttl must be between 5m and 12h")
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
auth["auth logout"] = async (c, _a, o) => await c.session.clear(str(o.hostname))
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
for (const action of ["status", "login", "bootstrap"]) {
  auth[`auth local ${action}`] = async (c, _a, o) => {
    const target = c.session.target(str(o.hostname || o.host)), options = { origin: target.api_url, anonymous: true }
    if (action === "status") {
      return { ...object(await c.request("GET", "/api/auth/local/status", undefined, options)), host: target.host }
    }
    const username = str(o.username || c.env.SMITHERS_AUTH_USERNAME)
    if (!username) {
      throw new Error("--username or SMITHERS_AUTH_USERNAME is required")
    }
    const secret = async (name: string, label: string) => {
      if (c.env[name]?.trim()) return c.env[name].trim()
      if (!process.stdin.isTTY) {
        if (name !== "SMITHERS_AUTH_PASSWORD") throw new Error(`${name} is required when stdin is not a TTY`)
        return c.stdin(label)
      }
      const value = await prompts.password({ message: label })
      if (prompts.isCancel(value) || !value.trim()) throw new Error("Login cancelled")
      return value.trim()
    }
    const password = await secret("SMITHERS_AUTH_PASSWORD", "Password")
    if (action === "bootstrap") {
      const token = await secret("SMITHERS_AUTH_BOOTSTRAP_TOKEN", "Bootstrap token")
      if (!token) throw new Error("SMITHERS_AUTH_BOOTSTRAP_TOKEN is required")
      await c.request("POST", "/api/auth/local/bootstrap", { username, password }, {
        ...options,
        headers: { "X-Smithers-Bootstrap-Token": token }
      })
    }
    const response = object(
      await c.request("POST", "/api/auth/local/token", {
        username,
        password,
        name: "smithers-cli",
        scopes: ["write:user", "write:repository", "write:workspace", "write:approval", "write:agent"]
      }, options)
    )
    const user = object(response.user)
    if (!response.token || !user.username) throw new Error("Owner token response was incomplete")
    await c.session.save(target.api_url, str(response.token), {
      username: user.username,
      expires_at: response.expires_at
    })
    return {
      status: "logged_in",
      host: target.host,
      user: user.username,
      expires_at: response.expires_at,
      token_id: response.token_id
    }
  }
}
auth["auth connect"] = async (c, a, o) => {
  const provider = str(a.provider).trim().toLowerCase()
  const payload = provider === "claude" && o["setup-token"]
    ? { provider, kind: "setup_token", access_token: setupToken(await c.stdin("Claude setup token")) }
    : await providerLogin(c, provider, str(o["config-dir"]))
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
const claudeKey = "claude.subscription-token"
const claudeToken = async (c: Client) => c.env.ANTHROPIC_AUTH_TOKEN || await c.session.keyring("get", claudeKey)
const pushClaude: Handler = async (c, _a, o) => {
  const token = await claudeToken(c)
  if (!token) throw new Error("No Claude subscription token; run smithers auth claude login")
  const flags = object(object(await c.request("GET", "/api/feature-flags", undefined, { anonymous: true })).flags)
  if (flags.subscription_connections !== true) {
    throw new Error("Subscription connections are not enabled on this deployment")
  }
  await c.request("POST", c.repoPath(o.repo) + "/secrets", { name: "ANTHROPIC_AUTH_TOKEN", value: setupToken(token) })
  return { status: "pushed", repo: c.repo(o.repo), secret_name: "ANTHROPIC_AUTH_TOKEN" }
}
auth["auth claude login"] = async (c, a, o) => {
  const token = setupToken(await c.stdin("Claude setup token"))
  if (await c.session.keyring("set", claudeKey, token) === undefined) {
    throw new Error("Secure credential storage is unavailable")
  }
  return o.repo ? pushClaude(c, a, o) : { status: "logged_in", stored_token: true }
}
auth["auth claude logout"] = async (c) => ({
  status: "logged_out",
  cleared: await c.session.keyring("delete", claudeKey) !== undefined
})
auth["auth claude status"] = async (c) => ({
  configured: !!await claudeToken(c),
  stored_token_set: !!await c.session.keyring("get", claudeKey),
  auth_kind: "ANTHROPIC_AUTH_TOKEN"
})
auth["auth claude token"] = auth["auth claude status"]!
auth["auth claude push"] = pushClaude

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
      if (!/^[A-Za-z0-9_-]{43}$/.test(str(response.ticket))) throw new Error("Invalid Observe ticket")
      res.setHeader("content-type", "application/json")
      res.end(
        JSON.stringify({ url: `${base}/login/cli#${new URLSearchParams({ state, ticket: str(response.ticket) })}` })
      )
      resolve()
    } catch {
      res.writeHead(502).end()
      reject(new Error("Observe sign-in failed"))
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
  const timer = setTimeout(() => reject(new Error("Timed out opening Observe")), 300_000)
  const abort = () => reject(new Error("Observe sign-in cancelled"))
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
