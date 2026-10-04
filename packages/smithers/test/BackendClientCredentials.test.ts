import { chmod, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Refused } from "../src/CliError.ts"
import { Client } from "../src/internal/backend/Client.ts"
import { run } from "../src/internal/backend/Process.ts"
import { Session } from "../src/internal/backend/Session.ts"
import { workspaces } from "../src/internal/backend/Workspaces.ts"

vi.mock("../src/internal/backend/Process.ts", async (actual) => ({ ...await actual(), run: vi.fn() }))
const spawn = vi.mocked(run)
const native = new Map<string, string>()
const platform = Object.getOwnPropertyDescriptor(process, "platform")!
const output = (stdout = "") => ({ code: 0, stdout, stderr: "" })
beforeEach(() => {
  Object.defineProperty(process, "platform", { value: "darwin" })
  native.clear()
  native.set("127.0.0.1", "synthetic-keyring-value")
  spawn.mockReset().mockImplementation(async (_command, args, options) => {
    const host = options.env.SMITHERS_CRED_HOST!
    if (args[0] === "find-generic-password") return output(native.get(host))
    if (args[0] === "delete-generic-password") native.delete(host)
    else native.set(host, options.env.SMITHERS_CRED_TOKEN!)
    return output()
  })
})

const disposals: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  Object.defineProperty(process, "platform", platform)
  for (const dispose of disposals.splice(0).reverse()) await dispose()
})
const deferred = <A = void>() => {
  let resolve!: (value: A) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<A>((done, failed) => {
    resolve = done
    reject = failed
  })
  return { promise, resolve, reject }
}
const storageFailure = () =>
  new Refused({
    fault: "dependency",
    code: "credential_storage_failed",
    message: "Secure credential storage get failed"
  })

/** Real loopback HTTP and temporary session files; native storage alone is synthetic, never the user's keyring. */
const fixture = async (signal?: AbortSignal) => {
  const home = await mkdtemp(join(tmpdir(), "smithers-client-credentials-"))
  const admitted = deferred()
  const received: Array<{ method: string; path: string; authenticated: boolean }> = []
  const accepted = new Set<string>()
  const routes = new Map<string, (request: IncomingMessage, response: ServerResponse) => void>()
  let creates = 0, polls = 0
  const server: Server = createServer((request, response) => {
    const method = request.method!, path = request.url!
    const authenticated = request.headers.authorization === `token ${native.get("127.0.0.1")}` ||
      [...accepted].some((token) => request.headers.authorization === `token ${token}`)
    received.push({ method, path, authenticated })
    response.setHeader("content-type", "application/json")
    const route = routes.get(path)
    if (route !== undefined) {
      route(request, response)
      return
    }
    if (!authenticated) {
      response.writeHead(401).end("{\"message\":\"unauthorized\"}")
      return
    }
    if (method === "POST" && path === "/api/repos/acme/app/workspaces") {
      creates++
      response.writeHead(201).end(JSON.stringify({ id: "owned-workspace", status: "pending" }))
      admitted.resolve()
    } else if (path === "/api/repos/acme/app/workspaces/owned-workspace") {
      polls++
      response.end(JSON.stringify({ id: "owned-workspace", status: polls >= 3 ? "running" : "pending" }))
    } else response.end("{}")
  })
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("fixture did not bind a TCP port")
  const origin = `http://127.0.0.1:${address.port}`
  const environment: Record<string, string> = {
    HOME: home,
    XDG_CONFIG_HOME: home,
    SMITHERS_AUTH_FILE: join(home, "auth.json"),
    SMITHERS_API_ORIGIN: origin,
    SMITHERS_WORKSPACE_CREATE_POLL_INTERVAL_MS: "1"
  }
  const client = new Client({
    environment,
    ...(signal ? { signal } : {}),
    stderr: { write: () => {}, isTTY: false, columns: 80 }
  })
  client.session.saveConfig({ api_origin: origin })
  const keyring = vi.spyOn(client.session, "keyring")
  disposals.push(async () => {
    server.closeAllConnections()
    await new Promise<void>((done, failed) => server.close((error) => error ? failed(error) : done()))
    await rm(home, { recursive: true, force: true })
  })
  return {
    client,
    keyring,
    origin,
    environment,
    home,
    received,
    admitted: admitted.promise,
    gets: () => keyring.mock.calls.filter(([action]) => action === "get").length,
    allow: (token: string) => accepted.add(token),
    disallow: (token: string) => accepted.delete(token),
    route: (path: string, handler: (request: IncomingMessage, response: ServerResponse) => void) =>
      routes.set(path, handler),
    counts: () => ({ creates, polls })
  }
}

describe("per-command authenticated credential reuse (#3396)", () => {
  it("keeps an admitted workspace identity through readiness polls without reopening secure storage", async () => {
    const t = await fixture()
    t.keyring.mockResolvedValueOnce("synthetic-keyring-value").mockRejectedValue(storageFailure())
    const waiting = workspaces["workspace create"]!(t.client, {}, {
      repo: "acme/app",
      name: "owned",
      wait: true,
      waitTimeout: 1
    })
      .catch((cause) => ({ error: cause instanceof Refused ? cause.code : "unexpected" }))
    await t.admitted
    expect(t.counts().creates).toBe(1)
    const outcome = await waiting
    expect(outcome).toMatchObject({ id: "owned-workspace", status: "running" })
    expect(t.counts()).toEqual({ creates: 1, polls: 3 })
    expect(t.keyring).toHaveBeenCalledTimes(1)
    expect(t.received.every((request) => request.authenticated)).toBe(true)
  })

  it("reuses one resolution per Client without sharing credentials between Client instances", async () => {
    const t = await fixture()
    const peer = new Client({ environment: t.environment })
    const otherGet = vi.spyOn(peer.session, "keyring")
    await t.client.request("GET", "/api/user")
    await t.client.request("GET", "/api/user")
    await peer.request("GET", "/api/user")
    await peer.request("GET", "/api/user")
    expect(t.gets()).toBe(1)
    expect(otherGet).toHaveBeenCalledTimes(1)
    expect(t.received).toHaveLength(4)
    expect(t.received.every((request) => request.authenticated)).toBe(true)
  })

  it("deduplicates concurrent lookup waiters before either HTTP request begins", async () => {
    const t = await fixture(), lookup = deferred<ReturnType<typeof output>>()
    spawn.mockReturnValueOnce(lookup.promise)
    const first = t.client.request("GET", "/api/first"), second = t.client.request("GET", "/api/second")
    expect(t.gets()).toBe(1)
    expect(t.received).toEqual([])
    lookup.resolve(output("synthetic-keyring-value"))
    await Promise.all([first, second])
    expect(t.received).toHaveLength(2)
    expect(t.gets()).toBe(1)
    expect(spawn.mock.calls[0]![2]).toMatchObject({ timeoutMs: 10_000, signal: expect.any(AbortSignal) })
  })

  it.each(["storage failure", "missing login"])(
    "does not cache %s or start an unauthenticated request",
    async (reason) => {
      const t = await fixture()
      if (reason === "storage failure") spawn.mockRejectedValueOnce(new Error("synthetic secure-store failure"))
      else native.delete("127.0.0.1")
      await expect(t.client.request("GET", "/api/user")).rejects.toMatchObject({
        code: reason === "storage failure" ? "credential_storage_failed" : "not_signed_in"
      })
      expect(t.received).toEqual([])
      native.set("127.0.0.1", "synthetic-keyring-value")
      await t.client.request("GET", "/api/user")
      await t.client.request("GET", "/api/user")
      expect(t.gets()).toBe(2)
      expect(t.received).toHaveLength(2)
    }
  )

  it.each(["scheme", "port"])("never reuses a saved credential across a different %s", async (boundary) => {
    const t = await fixture(), other = await fixture()
    await t.client.request("GET", "/api/user")
    const origin = boundary === "scheme" ? t.origin.replace("http:", "https:") : other.origin
    await expect(t.client.response("GET", "/api/user", undefined, { origin, signal: AbortSignal.timeout(1000) }))
      .rejects.toMatchObject({ code: "not_signed_in" })
    expect(other.received).toEqual([])
    await t.client.request("GET", "/api/user")
    expect(t.gets()).toBe(1)
    expect(t.received).toHaveLength(2)
  })

  it("explicit tokens and anonymous calls bypass and do not replace the saved-session resolution", async () => {
    const t = await fixture()
    await t.client.request("GET", "/api/user")
    t.keyring.mockRejectedValue(storageFailure())
    t.allow("synthetic-explicit")
    t.route("/public", (_request, response) => {
      response.end("{}")
    })
    await t.client.response("GET", "/api/user", undefined, { token: "synthetic-explicit" })
    await t.client.response("GET", "/public", undefined, { anonymous: true })
    await t.client.request("GET", "/api/user")
    expect(t.gets()).toBe(1)
    expect(t.received.map((request) => request.authenticated)).toEqual([true, true, false, true])
  })

  it("observes environment token rotation and returning to the saved source", async () => {
    const t = await fixture()
    for (const token of ["synthetic-env-first", "synthetic-env-second"]) {
      t.environment.SMITHERS_TOKEN = token
      t.allow(token)
      await t.client.request("GET", "/api/user")
    }
    expect(t.gets()).toBe(0)
    delete t.environment.SMITHERS_TOKEN
    await t.client.request("GET", "/api/user")
    expect(t.gets()).toBe(1)
    expect(t.received.every((request) => request.authenticated)).toBe(true)
  })

  it("invalidates rotation and sign-out through a separate Session", async () => {
    const t = await fixture(), peer = new Session(t.environment)
    await t.client.request("GET", "/api/user")
    await peer.save(t.origin, "synthetic-rotation")
    await t.client.request("GET", "/api/user")
    expect(t.gets()).toBe(2)
    await peer.clear(t.origin)
    await expect(t.client.request("GET", "/api/user")).rejects.toMatchObject({ code: "not_signed_in" })
    expect(t.received).toHaveLength(2)
    await peer.save(t.origin, "synthetic-recovery")
    await t.client.request("GET", "/api/user")
    expect(t.gets()).toBe(4)
  })

  it.each(["save", "clear"] as const)(
    "a failed %s releases its mutation fences and permits a fresh authenticated lookup",
    async (action) => {
      const t = await fixture(), peer = new Session(t.environment)
      await t.client.request("GET", "/api/user")
      spawn.mockRejectedValueOnce(new Error("synthetic mutation failure"))
      await expect(action === "save" ? peer.save(t.origin, "synthetic-unsaved") : peer.clear(t.origin))
        .rejects.toMatchObject({ code: "credential_storage_failed" })
      await t.client.request("GET", "/api/recovery")
      await t.client.request("GET", "/api/reuse")
      expect(t.gets()).toBe(2)
      expect(t.received).toHaveLength(3)
      expect(t.received.every((request) => request.authenticated)).toBe(true)
    }
  )

  it("native host mutation invalidates another home's cached native credential", async () => {
    const t = await fixture(), other = await fixture()
    await t.client.request("GET", "/api/user")
    await other.client.session.save(t.origin, "synthetic-shared-native-rotation")
    await t.client.request("GET", "/api/user")
    expect(t.gets()).toBe(2)
    expect(t.received.every((request) => request.authenticated)).toBe(true)
  })

  it("a file-only login stays path-scoped when another home mutates the same native host", async () => {
    const t = await fixture(), other = await fixture()
    t.environment.SMITHERS_DISABLE_SYSTEM_KEYRING = "1"
    t.allow("synthetic-file-only")
    await t.client.session.save(t.origin, "synthetic-file-only")
    const resolve = vi.spyOn(t.client.session, "require")
    await t.client.request("GET", "/api/user")
    await other.client.session.save(t.origin, "synthetic-native-other-home")
    await t.client.request("GET", "/api/user")
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(spawn.mock.calls.filter(([, args]) => args[0] === "find-generic-password")).toHaveLength(0)
  })

  it("a file-only cache is fenced by pending native logout sharing only its auth file", async () => {
    const t = await fixture(), other = await fixture(), entered = deferred(), release = deferred()
    t.environment.SMITHERS_DISABLE_SYSTEM_KEYRING = "1"
    t.allow("synthetic-shared-file")
    await t.client.session.save(t.origin, "synthetic-shared-file")
    await t.client.request("GET", "/api/user")
    const peer = new Session({
      ...other.environment,
      SMITHERS_API_ORIGIN: t.origin,
      SMITHERS_AUTH_FILE: t.client.session.authPath
    })
    expect(peer.configPath).not.toBe(t.client.session.configPath)
    expect(peer.authPath).toBe(t.client.session.authPath)
    spawn.mockImplementationOnce(async () => {
      entered.resolve()
      await release.promise
      native.delete("127.0.0.1")
      return output()
    })
    const clearing = peer.clear(t.origin)
    try {
      await entered.promise
      await expect(t.client.request("GET", "/api/no-pending-logout")).rejects.toMatchObject({
        code: "credentials_changing"
      })
      expect(t.received).toHaveLength(1)
    } finally {
      release.resolve()
      await clearing
    }
    await expect(t.client.request("GET", "/api/no-signed-out-request")).rejects.toMatchObject({ code: "not_signed_in" })
    expect(t.received).toHaveLength(1)
    await t.client.session.save(t.origin, "synthetic-file-recovery")
    t.allow("synthetic-file-recovery")
    await t.client.request("GET", "/api/recovery")
    expect(t.received.at(-1)?.authenticated).toBe(true)
  })

  it("observes external auth-file content and unchanged-content atomic replacement", async () => {
    const t = await fixture()
    t.environment.SMITHERS_DISABLE_SYSTEM_KEYRING = "1"
    t.allow("synthetic-file-original")
    await t.client.session.save(t.origin, "synthetic-file-original")
    const require = vi.spyOn(t.client.session, "require")
    await t.client.request("GET", "/api/user")
    t.disallow("synthetic-file-original")
    t.allow("synthetic-file-replacement")
    await writeFile(
      t.client.session.authPath,
      JSON.stringify({ api_url: t.origin, token: "synthetic-file-replacement" })
    )
    await t.client.request("GET", "/api/user")
    expect(require).toHaveBeenCalledTimes(2)
    const contents = await readFile(t.client.session.authPath, "utf8")
    const replacement = join(t.home, "replacement-auth.json")
    await writeFile(replacement, contents)
    await rename(replacement, t.client.session.authPath)
    await t.client.request("GET", "/api/user")
    await t.client.request("GET", "/api/user")
    expect(require).toHaveBeenCalledTimes(3)
    expect(t.received).toHaveLength(4)
    expect(t.received.every((request) => request.authenticated)).toBe(true)
  })

  it("changing native storage mode replaces the resolution without reusing the other source", async () => {
    const t = await fixture()
    await writeFile(t.client.session.authPath, JSON.stringify({ api_url: t.origin, token: "synthetic-mode-file" }))
    t.allow("synthetic-mode-file")
    const sources: boolean[] = []
    for (
      const [path, expected] of [["/api/native", "synthetic-keyring-value"], ["/api/file", "synthetic-mode-file"], [
        "/api/native-again",
        "synthetic-keyring-value"
      ], ["/api/reuse", "synthetic-keyring-value"]]
    ) {
      t.route(path!, (request, response) => {
        const matches = request.headers.authorization === `token ${expected}`
        sources.push(matches)
        response.writeHead(matches ? 200 : 401).end("{}")
      })
    }
    const require = vi.spyOn(t.client.session, "require")
    await t.client.request("GET", "/api/native")
    t.environment.SMITHERS_DISABLE_SYSTEM_KEYRING = "1"
    await t.client.request("GET", "/api/file")
    delete t.environment.SMITHERS_DISABLE_SYSTEM_KEYRING
    await t.client.request("GET", "/api/native-again")
    await t.client.request("GET", "/api/reuse")
    expect(require).toHaveBeenCalledTimes(3)
    expect(spawn.mock.calls.filter(([, args]) => args[0] === "find-generic-password")).toHaveLength(2)
    expect(t.received.every((request) => request.authenticated)).toBe(true)
    expect(sources).toEqual([true, true, true, true])
  })

  it.each(["rotation", "sign-out"])("a held old lookup cannot publish after separate-Session %s", async (mutation) => {
    const t = await fixture(), peer = new Session(t.environment), lookup = deferred<ReturnType<typeof output>>()
    spawn.mockReturnValueOnce(lookup.promise)
    const requesting = t.client.request("GET", "/api/user").then(() => "sent", (cause) => cause.code)
    if (mutation === "rotation") await peer.save(t.origin, "synthetic-later-login")
    else await peer.clear(t.origin)
    lookup.resolve(output("synthetic-keyring-value"))
    expect(await requesting).toBe(mutation === "rotation" ? "sent" : "not_signed_in")
    expect(t.received).toHaveLength(mutation === "rotation" ? 1 : 0)
    expect(t.received.every((request) => request.authenticated)).toBe(true)
    expect(t.gets()).toBe(2)
  })

  it("fences a held lookup while native mutation is still pending, then recovers after commit", async () => {
    const t = await fixture(), peer = new Session(t.environment), lookup = deferred<ReturnType<typeof output>>()
    const mutationEntered = deferred(), releaseMutation = deferred()
    spawn.mockReturnValueOnce(lookup.promise).mockImplementationOnce(async (_command, _args, options) => {
      mutationEntered.resolve()
      await releaseMutation.promise
      native.set("127.0.0.1", options.env.SMITHERS_CRED_TOKEN!)
      return output()
    })
    const requesting = t.client.request("GET", "/api/user").then(() => "sent", (cause) => cause.code)
    const changing = peer.save(t.origin, "synthetic-after-pending-mutation")
    await mutationEntered.promise
    lookup.resolve(output("synthetic-keyring-value"))
    try {
      expect(await requesting).toBe("credentials_changing")
      expect(t.received).toEqual([])
    } finally {
      releaseMutation.resolve()
      await changing
    }
    await t.client.request("GET", "/api/user")
    expect(t.received).toHaveLength(1)
    expect(t.received[0]?.authenticated).toBe(true)
  })

  it("fences auth mutation in the final microtask between credential resolution and HTTP admission", async () => {
    const t = await fixture(), peer = new Session(t.environment), entered = deferred(), release = deferred()
    spawn.mockResolvedValueOnce(output("synthetic-keyring-value")).mockImplementationOnce(
      async (_command, _args, options) => {
        entered.resolve()
        await release.promise
        native.set("127.0.0.1", options.env.SMITHERS_CRED_TOKEN!)
        return output()
      }
    )
    let reads = 0, changing: Promise<unknown> | undefined
    const readIdentity = t.client.session.credentialIdentity.bind(t.client.session)
    vi.spyOn(t.client.session, "credentialIdentity").mockImplementation((origin) => {
      const result = readIdentity(origin)
      if (++reads === 2) {
        queueMicrotask(() => {
          changing = peer.save(t.origin, "synthetic-final-gap-login")
        })
      }
      return result
    })
    try {
      const requesting = t.client.request("GET", "/api/user").then(() => "sent", (cause) => cause.code)
      await entered.promise
      expect(await requesting).toBe("credentials_changing")
      expect(t.received).toEqual([])
    } finally {
      release.resolve()
      await changing
    }
  })

  it("bounds continuous pre-HTTP login churn and permits recovery after the churn ends", async () => {
    const t = await fixture(), peer = new Session(t.environment)
    const original = spawn.getMockImplementation()!
    let lookups = 0
    spawn.mockImplementation(async (command, args, options) => {
      if (args[0] !== "find-generic-password") return original(command, args, options)
      const old = native.get("127.0.0.1")!
      await peer.save(t.origin, `synthetic-churn-${++lookups}`)
      return output(old)
    })
    await expect(t.client.request("GET", "/api/no-churning-request")).rejects.toMatchObject({
      code: "credentials_changing"
    })
    expect(lookups).toBe(3)
    expect(t.received).toEqual([])
    spawn.mockImplementation(original)
    await t.client.request("GET", "/api/recovery")
    expect(t.gets()).toBe(4)
    expect(t.received[0]?.authenticated).toBe(true)
  })

  it.each(["login change", "cancellation"])(
    "rechecks %s after body serialization and before HTTP admission",
    async (change) => {
      const caller = new AbortController(), t = await fixture(caller.signal)
      t.allow("synthetic-body-login")
      const body = {
        toJSON: () => {
          if (change === "login change") t.environment.SMITHERS_TOKEN = "synthetic-body-login"
          else caller.abort()
          return { value: "synthetic-body" }
        }
      }
      await expect(t.client.response("POST", "/api/no-stale-body-request", body))
        .rejects.toMatchObject({ code: change === "login change" ? "credentials_changing" : "cancelled" })
      expect(t.received).toEqual([])
      await t.client.response("GET", "/api/recovery", undefined, { signal: AbortSignal.timeout(1000) })
      expect(t.received[0]?.authenticated).toBe(true)
      expect(t.gets()).toBe(1)
    }
  )

  it("a late old HTTP401 cannot evict the newer rotation's current cache entry", async () => {
    const t = await fixture(), peer = new Session(t.environment), entered = deferred(), release = deferred()
    t.route("/held401", (_request, response) => {
      entered.resolve()
      void release.promise.then(() => response.writeHead(401).end("{\"message\":\"old login refused\"}"))
    })
    const old = t.client.response("GET", "/held401").catch((cause) => cause.status)
    await entered.promise
    await peer.save(t.origin, "synthetic-new-http-login")
    await t.client.request("GET", "/api/user")
    release.resolve()
    expect(await old).toBe(401)
    await t.client.request("GET", "/api/user")
    expect(t.gets()).toBe(2)
    expect(t.received.every((request) => request.authenticated)).toBe(true)
  })

  it("only a session-authenticated401 evicts; explicit, anonymous, custom-header401 and403 do not", async () => {
    const t = await fixture()
    t.route("/401", (_request, response) => {
      response.writeHead(401).end("{}")
    })
    t.route("/403", (_request, response) => {
      response.writeHead(403).end("{}")
    })
    await t.client.request("GET", "/api/user")
    for (
      const options of [{ token: "synthetic-wrong-explicit" }, { anonymous: true }, {
        headers: { Authorization: "token synthetic-custom-header" }
      }]
    ) {
      await expect(t.client.response("GET", "/401", undefined, options)).rejects.toMatchObject({ status: 401 })
      await t.client.request("GET", "/api/user")
      expect(t.gets()).toBe(1)
    }
    await expect(t.client.response("GET", "/403")).rejects.toMatchObject({ status: 403 })
    await t.client.request("GET", "/api/user")
    expect(t.gets()).toBe(1)
    await expect(t.client.response("GET", "/401")).rejects.toMatchObject({ status: 401 })
    await t.client.request("GET", "/api/user")
    expect(t.gets()).toBe(2)
  })

  it("one cancelled waiter does not cancel another waiting on the same native lookup", async () => {
    const t = await fixture(), lookup = deferred<ReturnType<typeof output>>(), caller = new AbortController()
    spawn.mockReturnValueOnce(lookup.promise)
    const cancelled = t.client.response("GET", "/api/cancelled", undefined, { signal: caller.signal }).catch((cause) =>
      cause.code
    )
    const live = t.client.request("GET", "/api/live")
    caller.abort()
    expect(await cancelled).toBe("cancelled")
    expect(spawn.mock.calls[0]![2].signal?.aborted).toBe(false)
    lookup.resolve(output("synthetic-keyring-value"))
    await live
    await t.client.request("GET", "/api/reuse")
    expect(t.received.map((request) => request.path)).toEqual(["/api/live", "/api/reuse"])
    expect(t.gets()).toBe(1)
  })

  it("last-waiter abort evicts and signals the native lookup; its late rejection cannot evict recovery", async () => {
    const t = await fixture(), lookup = deferred<ReturnType<typeof output>>(), caller = new AbortController()
    spawn.mockReturnValueOnce(lookup.promise)
    const cancelled = t.client.response("GET", "/api/cancelled", undefined, { signal: caller.signal }).catch((cause) =>
      cause.code
    )
    caller.abort()
    expect(await cancelled).toBe("cancelled")
    expect(spawn.mock.calls[0]![2].signal?.aborted).toBe(true)
    await t.client.request("GET", "/api/recovery")
    lookup.reject(new Refused({ fault: "user", code: "cancelled", message: "synthetic native lookup cancelled" }))
    await new Promise<void>((done) => setImmediate(done))
    await t.client.request("GET", "/api/reuse")
    expect(t.gets()).toBe(2)
    expect(t.received.map((request) => request.path)).toEqual(["/api/recovery", "/api/reuse"])
  })

  it("owned native cancellation remains cancellation instead of authenticating through a fallback file", async () => {
    const t = await fixture(), caller = new AbortController()
    await writeFile(t.client.session.authPath, JSON.stringify({ api_url: t.origin, token: "synthetic-fallback" }))
    const cancelled = new Refused({ fault: "user", code: "cancelled", message: "synthetic native lookup cancelled" })
    spawn.mockImplementationOnce((_command, _args, options) =>
      new Promise((_done, failed) => {
        options.signal!.addEventListener("abort", () => failed(cancelled), { once: true })
      })
    )
    const resolving = t.client.session.resolve(t.origin, caller.signal)
    caller.abort()
    await expect(resolving).rejects.toBe(cancelled)
    expect(t.received).toEqual([])
  })

  it("an aborted command still sends its independently bounded cancellation cleanup using cached auth", async () => {
    const caller = new AbortController(), t = await fixture(caller.signal)
    const path = "/api/repos/acme/app/workspaces/owned-workspace/command-runs"
    t.route(path, (_request, response) => {
      response.writeHead(201).end(JSON.stringify({ operationId: "owned-operation", state: "accepted" }))
    })
    let polls = 0
    t.route(`${path}/owned-operation`, (_request, response) => {
      if (++polls === 1) caller.abort()
      response.end(JSON.stringify({ operationId: "owned-operation", state: polls === 1 ? "running" : "cancelled" }))
    })
    t.route(`${path}/owned-operation/cancel`, (_request, response) => {
      response.end(JSON.stringify({ operationId: "owned-operation", state: "running" }))
    })
    await expect(
      workspaces["workspace exec"]!(t.client, { id: "owned-workspace" }, {
        repo: "acme/app",
        command: "synthetic-command",
        "exec-id": "owned-exec"
      })
    )
      .rejects.toMatchObject({ code: "interrupted" })
    expect(t.received.filter((request) => request.method === "POST" && request.path.endsWith("/cancel"))).toHaveLength(
      1
    )
    expect(t.received.every((request) => request.authenticated)).toBe(true)
    expect(t.gets()).toBe(1)
    expect(polls).toBe(2)
    await expect(t.client.request("GET", "/api/no-owner-work")).rejects.toMatchObject({ code: "cancelled" })
    expect(t.received.some((request) => request.path === "/api/no-owner-work")).toBe(false)
  })
})

describe("terminal credential files (#3537)", () => {
  it("prefers environment then file then saved credentials outside managed terminals", async () => {
    const f = await fixture()
    const path = join(f.home, "session-token")
    await writeFile(path, "synthetic-file-value\n")
    const session = new Session({ ...f.environment, SMITHERS_TOKEN_FILE: path })
    expect((await session.require()).source).toBe("token_file")
    expect((await session.require()).token).toBe("synthetic-file-value")
    expect(
      (await new Session({ ...f.environment, SMITHERS_TOKEN_FILE: path, SMITHERS_TOKEN: "synthetic-env-value" })
        .require()).source
    ).toBe("env")
    expect(spawn).not.toHaveBeenCalled()
    expect((await session.clear()).env_active).toBe(true)
  })

  it("refuses missing, malformed, oversized and directory files without keyring fallback", async () => {
    const f = await fixture()
    const path = join(f.home, "session-token")
    const session = new Session({ ...f.environment, SMITHERS_TOKEN_FILE: path })
    await expect(session.require()).rejects.toMatchObject({ code: "token_file_unavailable" })
    for (const contents of ["", "bad token", "x".repeat(16385)]) {
      await writeFile(path, contents)
      await expect(session.require()).rejects.toMatchObject({ code: "token_file_unavailable" })
    }
    await expect(new Session({ ...f.environment, SMITHERS_TOKEN_FILE: f.home }).require()).rejects.toMatchObject({
      code: "token_file_unavailable"
    })
    await writeFile(path, "synthetic-file-value")
    await chmod(path, 0)
    try {
      await expect(session.require()).rejects.toMatchObject({ code: "token_file_unavailable" })
    } finally {
      await chmod(path, 0o600)
    }
    expect(spawn).not.toHaveBeenCalled()
  })

  it("keeps managed sign-in dark even with an environment identity override", async () => {
    const f = await fixture()
    const session = new Session({
      ...f.environment,
      SMITHERS_TOKEN_FILE: "/run/smithers/sessions/A/token",
      SMITHERS_TOKEN: "synthetic-env-value"
    })
    await expect(session.require()).rejects.toMatchObject({ code: "terminal_auth_unavailable" })
    expect(() => session.credentialIdentity(f.origin)).toThrow(Refused)
    expect(spawn).not.toHaveBeenCalled()
  })

  it("evicts only A on 401, rereads its bound file on an explicit request and never replays a mutation", async () => {
    const f = await fixture()
    const pathA = join(f.home, "A"), pathB = join(f.home, "B")
    await writeFile(pathA, "synthetic-A")
    await writeFile(pathB, "synthetic-B")
    f.allow("synthetic-A")
    f.allow("synthetic-B")
    const a = new Client({ environment: { ...f.environment, SMITHERS_TOKEN_FILE: pathA } })
    const b = new Client({ environment: { ...f.environment, SMITHERS_TOKEN_FILE: pathB } })
    await Promise.all([a.response("GET", "/probe"), b.response("GET", "/probe")])
    const bIdentity = b.session.credentialIdentity(f.origin)
    await writeFile(pathB, "synthetic-B-rotated")
    f.disallow("synthetic-A")
    const before = f.received.length
    await expect(a.response("POST", "/probe", {})).rejects.toMatchObject({ status: 401 })
    expect(f.received.length).toBe(before + 1)
    expect(b.session.credentialIdentity(f.origin)).toBe(bIdentity)
    expect((await b.response("GET", "/probe")).status).toBe(200)
    await writeFile(pathA, "synthetic-A-rotated")
    f.allow("synthetic-A-rotated")
    expect((await a.response("GET", "/probe")).status).toBe(200)
    await rm(pathA)
    f.disallow("synthetic-A-rotated")
    await expect(a.response("GET", "/probe")).rejects.toMatchObject({ status: 401 })
    await expect(a.response("POST", "/probe", {})).rejects.toMatchObject({ code: "token_file_unavailable" })
    expect(f.received.filter(({ method }) => method === "POST")).toHaveLength(1)
    expect(spawn).not.toHaveBeenCalled()
  })
})
