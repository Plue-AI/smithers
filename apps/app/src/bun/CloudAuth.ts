/*
 * The Smithers Cloud sign-in on the local origin (ADR 0001 "Settled with the
 * backend"): the CLI's browser login, not an env token. `start` listens on
 * 127.0.0.1:<random> with `/callback` and answers the URL the renderer opens
 * in the system browser (`${API}/api/auth/github/cli?callback_port=<port>`);
 * the API redirects to a fragment callback with a per-attempt callback_state;
 * a local browser page strips the fragment and posts its credentials (a
 * `smithers_` PAT), which is stored in the macOS keychain under
 * `smithers-cloud` and kept in Bun memory. The app renderer never receives
 * the token: `session()` answers `{ state, username, expiresAt, scopes? }` and
 * the `/api/cloud/*` proxy attaches the bearer itself.
 *
 * `SMITHERS_CLOUD_TOKEN` is a dev/CI override, read first — a set override
 * means signed-in with no login round-trip and nothing to store.
 *
 * The login explicitly requests ADR 0001's app scopes. Legacy restored
 * credentials can still lack workspace/agent/approval scopes, so
 * the probe (GET /api/user/workspaces) runs once, before the session reports
 * signed-in; a 403 carrying Cloud's own scope refusal marks the session
 * `scopes: "degraded"`. The session never reports signed-in without its scope
 * verdict, so a reader that polls for the state gets one consistent answer.
 */
import type { Server } from "bun"
import { randomBytes, timingSafeEqual } from "node:crypto"
import type { CloudSession } from "@smthrs/rpc/CloudTunnel"
import { isCloudScopeRefusal } from "@smthrs/rpc/UpstreamProse"

/** What the login callback posts; the keychain entry serializes exactly this. */
export interface CloudCredentials {
  readonly token: string
  readonly username: string
  readonly email: string | null
  readonly expiresAt: string | null
}

/** The OS keychain behind the token at rest; injectable so tests never touch the real one. */
export interface CloudKeychain {
  readonly read: (service: string, account: string) => Promise<string | null>
  readonly write: (service: string, account: string, secret: string) => Promise<void>
  readonly remove: (service: string, account: string) => Promise<void>
}

export interface CloudAuthOptions {
  /** The cloud API origin the login URL and the scope probe target. */
  readonly api: string
  /** SMITHERS_CLOUD_TOKEN: the dev/CI override, read before any stored credential. */
  readonly envToken?: string | undefined
  readonly keychain?: CloudKeychain
  readonly fetchImpl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
  /** The callback wait; production is five minutes. */
  readonly waitTimeoutMs?: number
  readonly log?: (line: string) => void
  readonly now?: () => number
  readonly probeTimeoutMs?: number
}

export interface CloudAuth {
  /** The bearer the `/api/cloud/*` proxy attaches; undefined when signed out. */
  readonly token: () => string | undefined
  /** The renderer-safe session answer: never the token. */
  readonly session: () => CloudSession
  /** Begin the browser login: answers the URL to open, or the honest error. */
  readonly start: () => Promise<{ readonly url: string } | { readonly error: string }>
  /** Forget the stored credential (the env override is not sign-out-able). */
  readonly signOut: () => Promise<void>
  /** Close a pending callback listener; the server calls this on shutdown. */
  readonly stop: () => Promise<void>
}

export const CLOUD_KEYCHAIN_SERVICE = "smithers-cloud"
export const CLOUD_AUTH_WAIT_TIMEOUT_MS = 5 * 60 * 1000
export const CLOUD_AUTH_BODY_LIMIT = 16 * 1024
/** ADR 0001's app capabilities, without user/org writes or administrative grants. */
export const CLOUD_AUTH_SCOPES = ["read:user", "read:organization", "read:repository", "write:repository", "read:workspace", "write:workspace", "write:agent", "write:approval"] as const

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

const matchesSecret = (value: unknown, expected: string): boolean =>
  typeof value === "string" && Buffer.byteLength(value) === Buffer.byteLength(expected) && timingSafeEqual(Buffer.from(value), Buffer.from(expected))

/** The API returns credentials in the fragment, which never reaches HTTP logs. */
const callbackPage = (nonce: string): Response => new Response(`<!doctype html><meta charset="utf-8"><title>Smithers sign-in</title><p id="message">Completing sign-in…</p><script nonce="${nonce}">
const params = new URLSearchParams(location.hash.slice(1));
history.replaceState(null, '', location.pathname);
const message = document.getElementById('message');
fetch('/callback', { method: 'POST', headers: { 'content-type': 'application/json', 'x-smithers-callback': '${nonce}' }, body: JSON.stringify({ token: params.get('token'), username: params.get('username'), email: params.get('email'), expires_at: params.get('expires_at'), callback_state: params.get('callback_state') }) })
  .then(response => { message.textContent = response.ok ? 'Return to Smithers to finish signing in.' : 'Sign-in could not be verified. Start again in Smithers; the cloud API must support callback state.'; })
  .catch(() => { message.textContent = 'Sign-in could not finish. Return to Smithers and try again.'; });
</script>`, { headers: {
  "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer",
  "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  "x-content-type-options": "nosniff"
} })

/** The callback body's contract; anything else is refused, never partially stored. */
export const parseCloudCredentials = (value: unknown): CloudCredentials | null => {
  if (!isRecord(value)) return null
  if (typeof value.token !== "string" || value.token === "") return null
  if (typeof value.username !== "string" || value.username === "") return null
  return {
    token: value.token,
    username: value.username,
    email: typeof value.email === "string" ? value.email : null,
    expiresAt: typeof value.expiresAt === "string" ? value.expiresAt : typeof value.expires_at === "string" ? value.expires_at : null
  }
}

/** The `security` process seam: argv plus optional stdin; tests record calls instead of spawning. */
export type KeychainRun = (argv: ReadonlyArray<string>, stdin?: string) => Promise<{ readonly code: number; readonly stdout: string }>

const spawnRun: KeychainRun = async (argv, stdin) => {
  const proc = Bun.spawn([...argv], { stdin: stdin === undefined ? "ignore" : new Blob([stdin]), stdout: "pipe", stderr: "ignore" })
  const stdout = (await new Response(proc.stdout).text()).trim()
  const code = await proc.exited
  return { code, stdout }
}

/** A quoted `security -i` word; a quote, backslash or line break could smuggle in another option or command. */
const interactiveWord = (value: string): string | null => /["\\\r\n]/.test(value) ? null : `"${value}"`

/*
 * macOS `security`: one generic-password entry per API host. The secret is
 * the serialized CloudCredentials, so a restart restores the whole session,
 * not just the token. The writer feeds `add-generic-password -X <hex>` to
 * `security -i` on stdin, so the PAT never appears in a process's argv.
 * Cloud sessions retain best-effort persistence. Strict callers require a
 * successful read/write (including readback), with no memory-only success.
 */
export const darwinKeychain = (run: KeychainRun = spawnRun, strict = false): CloudKeychain => ({
  read: async (service, account) => {
    try {
      const { code, stdout } = await run(["security", "find-generic-password", "-s", service, "-a", account, "-w"])
      if (strict && code !== 0 && code !== 44) throw new Error("Keychain unavailable")
      return code === 0 && stdout !== "" ? stdout : null
    } catch {
      if (strict) throw new Error("Keychain unavailable")
      return null
    }
  },
  write: async (service, account, secret) => {
    try {
      const s = interactiveWord(service), a = interactiveWord(account)
      if (s === null || a === null) throw new Error("Keychain unavailable")
      const hex = Buffer.from(secret, "utf8").toString("hex")
      const written = await run(["security", "-i"], `add-generic-password -U -s ${s} -a ${a} -X ${hex}\n`)
      if (strict) {
        // Interactive security can exit successfully after a command refusal.
        const verified = await run(["security", "find-generic-password", "-s", service, "-a", account, "-w"])
        if (written.code !== 0 || verified.code !== 0 || verified.stdout !== secret) throw new Error("Keychain unavailable")
      }
    } catch { if (strict) throw new Error("Keychain unavailable") }
  },
  remove: async (service, account) => {
    try {
      const result = await run(["security", "delete-generic-password", "-s", service, "-a", account])
      if (strict && result.code !== 0 && result.code !== 44) throw new Error("Keychain unavailable")
    } catch { if (strict) throw new Error("Keychain unavailable") }
  }
})

/** Off macOS there is no keychain contract; reads answer empty and writes are dropped. */
const inertKeychain = (): CloudKeychain => ({
  read: async () => null,
  write: async () => {},
  remove: async () => {}
})

interface PendingLogin {
  readonly attempt: number
  readonly url: string
  readonly server: Server<undefined>
  readonly timeout: ReturnType<typeof setTimeout>
  readonly done: Promise<void>
}

export const createCloudAuth = async (options: CloudAuthOptions): Promise<CloudAuth> => {
  const api = options.api.replace(/\/+$/, "")
  const apiOrigin = new URL(api).origin
  const account = new URL(api).host
  const keychain = options.keychain ?? (process.platform === "darwin" ? darwinKeychain() : inertKeychain())
  const fetchImpl = options.fetchImpl ?? fetch
  const waitTimeoutMs = options.waitTimeoutMs ?? CLOUD_AUTH_WAIT_TIMEOUT_MS
  const log = options.log ?? (() => {})
  const now = options.now ?? Date.now

  let credentials: CloudCredentials | null = null
  let degraded = false
  let pending: PendingLogin | null = null
  let generation = 0
  let keychainQueue: Promise<void> = Promise.resolve()
  const persist = (operation: () => Promise<void>): Promise<void> => {
    keychainQueue = keychainQueue.then(operation).catch(() => {})
    return keychainQueue
  }
  const expired = (value: CloudCredentials): boolean => value.expiresAt !== null &&
    (!Number.isFinite(Date.parse(value.expiresAt)) || Date.parse(value.expiresAt) <= now())

  // A previous launch's login restores from the keychain; the env override still wins.
  if (options.envToken === undefined || options.envToken === "") {
    const stored = await keychain.read(CLOUD_KEYCHAIN_SERVICE, account)
    if (stored !== null) {
      try {
        credentials = parseCloudCredentials(JSON.parse(stored))
      } catch {
        credentials = null
      }
    }
  }

  const token = (): string | undefined =>
    options.envToken !== undefined && options.envToken !== "" ? options.envToken :
      credentials !== null && !expired(credentials) ? credentials.token : undefined

  /*
   * The one probe (ADR 0001): Cloud's own scope refusal means the legacy token
   * set — workspace/agent/approval acts degrade to "sign in again to enable"
   * instead of failing silently. Which 403 that is comes from Cloud's typed
   * verdict, never from the English in the body (`isCloudScopeRefusal`, shared
   * with the Worker that runs the same probe): a degraded session is still a
   * signed-in one, so a Cloudflare block page or another proxy's envelope must
   * not be able to publish one.
   */
  const probeScopes = async (bearer: string): Promise<{ degraded: boolean; valid: boolean }> => {
    try {
      const response = await fetchImpl(`${api}/api/user/workspaces`, {
        headers: { authorization: `Bearer ${bearer}` },
        signal: AbortSignal.timeout(options.probeTimeoutMs ?? 5000)
      })
      if (response.status !== 403) {
        await response.body?.cancel()
        return { degraded: false, valid: response.status !== 401 }
      }
      // An unreadable body carries no verdict, so it degrades nothing.
      const text = await response.text().catch(() => "")
      return { degraded: isCloudScopeRefusal(text), valid: true }
    } catch {
      // A failed probe says nothing about scope; the session stays undegraded.
      return { degraded: false, valid: true }
    }
  }

  if (credentials !== null) {
    if (expired(credentials)) {
      credentials = null
      await persist(() => keychain.remove(CLOUD_KEYCHAIN_SERVICE, account))
    } else {
      const probe = await probeScopes(credentials.token)
      degraded = probe.degraded
      if (!probe.valid) {
        credentials = null
        await persist(() => keychain.remove(CLOUD_KEYCHAIN_SERVICE, account))
      }
    }
  } else if (options.envToken) degraded = (await probeScopes(options.envToken)).degraded

  const clearPending = (attempt?: number): void => {
    if (pending === null || (attempt !== undefined && pending.attempt !== attempt)) return
    clearTimeout(pending.timeout)
    pending.server.stop(true)
    pending = null
  }

  const accept = async (value: unknown, attempt: number): Promise<void> => {
    const parsed = parseCloudCredentials(value)
    if (parsed === null) return
    // The probe answers before the credentials are published: `session()`
    // reads signed-in off the stored credentials, so publishing first would
    // let a reader see signed-in with no scope verdict and then watch it
    // degrade a moment later.
    const probe = await probeScopes(parsed.token)
    if (generation !== attempt || expired(parsed) || !probe.valid) return
    credentials = parsed
    degraded = probe.degraded
    await persist(async () => {
      if (generation === attempt) await keychain.write(CLOUD_KEYCHAIN_SERVICE, account, JSON.stringify(parsed))
    })
    if (generation !== attempt) return
    log(`cloud-auth: signed in as ${parsed.username}`)
  }

  return {
    token,
    session: (): CloudSession => ({
      state: token() !== undefined ? "signed-in" : pending === null ? "signed-out" : "signing-in",
      username: token() === undefined ? null : credentials?.username ?? null,
      expiresAt: token() === undefined ? null : credentials?.expiresAt ?? null,
      ...(token() !== undefined && degraded ? { scopes: "degraded" as const } : {})
    }),
    start: async () => {
      if (token() !== undefined) return { error: "Already signed in to Smithers Cloud." }
      if (pending !== null) return { url: pending.url }
      const attempt = ++generation
      const callbackState = randomBytes(32).toString("base64url")
      const bridgeNonce = randomBytes(24).toString("base64url")
      credentials = null
      degraded = false
      let settle: () => void = () => {}
      const done = new Promise<void>((resolve) => {
        settle = resolve
      })
      let claimed = false
      let server: Server<undefined>
      try {
        server = Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          maxRequestBodySize: CLOUD_AUTH_BODY_LIMIT,
          fetch: async (request) => {
            if (request.headers.get("host") !== `127.0.0.1:${server.port}`) return new Response("invalid host", { status: 403 })
            const { pathname } = new URL(request.url)
            if (pathname !== "/callback") return new Response("not found", { status: 404 })
            if (request.method === "GET") return callbackPage(bridgeNonce)
            if (request.method !== "POST") return new Response("method not allowed", { status: 405 })
            // A foreign page can issue a simple text/plain POST to loopback.
            // Refuse its Origin before reading or claiming this login attempt;
            // non-browser CLI callbacks can legitimately omit Origin.
            const origin = request.headers.get("origin")
            const localOrigin = `http://127.0.0.1:${server.port}`
            if (origin !== null && origin !== apiOrigin && origin !== localOrigin) return new Response("invalid origin", { status: 403 })
            if (origin === localOrigin && !matchesSecret(request.headers.get("x-smithers-callback"), bridgeNonce)) return new Response("invalid callback page", { status: 403 })
            const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase()
            if (mediaType !== "application/json") return new Response("expected application/json", { status: 415 })
            if (Number(request.headers.get("content-length")) > CLOUD_AUTH_BODY_LIMIT) return new Response("body too large", { status: 413 })
            const reader = request.body?.getReader()
            const decoder = new TextDecoder()
            let text = ""
            let size = 0
            try {
              while (reader !== undefined) {
                const chunk = await reader.read()
                if (chunk.done) break
                size += chunk.value.byteLength
                if (size > CLOUD_AUTH_BODY_LIMIT) {
                  await reader.cancel()
                  return new Response("body too large", { status: 413 })
                }
                text += decoder.decode(chunk.value, { stream: true })
              }
              text += decoder.decode()
            } catch {
              return new Response("invalid callback body", { status: 400 })
            } finally {
              reader?.releaseLock()
            }
            let body: unknown = null
            try { body = JSON.parse(text) } catch { /* The shape check below refuses malformed JSON. */ }
            if (!isRecord(body) || !matchesSecret(body.callback_state, callbackState)) return new Response("invalid callback state", { status: 403 })
            const parsed = parseCloudCredentials(body)
            if (parsed === null || expired(parsed)) {
              return Response.json({ error: "expected { token, username, email, expiresAt }" }, { status: 400 })
            }
            // The first well-formed callback settles the attempt; a later one
            // (a replay, or a local process racing the real callback) can no
            // longer substitute the token.
            if (claimed) return Response.json({ error: "this sign-in attempt already received its callback" }, { status: 409 })
            claimed = true
            void accept(body, attempt).finally(settle)
            return Response.json({ ok: true })
          }
        })
      } catch (error) {
        log(`cloud-auth: the sign-in callback listener failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
        return { error: "Could not start sign-in on this computer. Try again." }
      }
      const url = `${api}/api/auth/github/cli?${new URLSearchParams({ callback_port: String(server.port), callback_state: callbackState, scopes: CLOUD_AUTH_SCOPES.join(",") })}`
      const timeout = setTimeout(() => {
        log("cloud-auth: the sign-in callback never arrived; the attempt expired")
        if (generation === attempt) generation += 1
        settle()
      }, waitTimeoutMs)
      pending = { attempt, url, server, timeout, done }
      void done.finally(() => clearPending(attempt))
      return { url }
    },
    signOut: async () => {
      generation += 1
      clearPending()
      credentials = null
      degraded = false
      await persist(() => keychain.remove(CLOUD_KEYCHAIN_SERVICE, account))
    },
    stop: async () => {
      generation += 1
      clearPending()
      await keychainQueue
    }
  }
}
