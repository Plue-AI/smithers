import { resolveApplicationTarget } from "@smthrs/rpc/ApplicationTarget"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test"
import type { Refusal } from "@smthrs/rpc/Refusal"
import { presentAppFailure } from "../state/controller/AppFailure"
import { ApplicationClientError, createApplicationClient } from "./ApplicationClient"

const pageOrigin = "https://app.example.test"
const target = (mode: "web-selfhost" | "web-plue" | "local-own" | "local-plue" | "native-own" | "native-plue") => {
  const plue = mode.endsWith("plue")
  const apiOrigin = mode.startsWith("web-") ? "" : plue ? "https://plue.example.test" : "http://127.0.0.1:4100"
  return resolveApplicationTarget({
    apiVersion: 1,
    mode,
    apiOrigin,
    auth: {
      kind: plue && apiOrigin !== "" ? "bearer" : mode === "local-own" ? "token" : "session"
    },
    cors: plue && apiOrigin !== "" ? "credentialed" : "same-origin",
    developerExternal: mode === "web-plue" && apiOrigin !== ""
  }, pageOrigin)
}

const interruptedJsonRead = (failure: unknown, signal?: AbortSignal) => {
  const reading = Promise.withResolvers<void>()
  const interrupt = Promise.withResolvers<void>()
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      reading.resolve()
      if (signal?.aborted) interrupt.resolve()
      else signal?.addEventListener("abort", () => interrupt.resolve(), { once: true })
      await interrupt.promise
      controller.error(failure)
    }
  }, { highWaterMark: 0 })
  const client = createApplicationClient(target("web-selfhost"), {
    pageOrigin,
    fetchImpl: async () => new Response(body, { headers: { "content-type": "application/json" } })
  })
  return { client, reading: reading.promise, interrupt: interrupt.resolve }
}

// Literal wire expectations are independent of the client's derived target fields.
const modes = [
  { mode: "web-selfhost", url: "/api/bootstrap", socket: "wss://app.example.test/api/socket", ticketPath: "/api/auth/sse-ticket", auth: null, credentials: "include", csrf: "csrf-secret" },
  { mode: "web-plue", url: "/api/bootstrap", socket: "wss://app.example.test/api/socket", ticketPath: "/api/auth/sse-ticket", auth: null, credentials: "include", csrf: "csrf-secret" },
  { mode: "local-own", url: "http://127.0.0.1:4100/api/bootstrap", socket: "ws://127.0.0.1:4100/api/socket", ticketPath: "http://127.0.0.1:4100/api/auth/sse-ticket", auth: "token secret", credentials: "omit", csrf: null },
  { mode: "local-plue", url: "https://plue.example.test/api/bootstrap", socket: "wss://plue.example.test/api/socket", ticketPath: "https://plue.example.test/api/auth/sse-ticket", auth: "Bearer secret", credentials: "omit", csrf: null },
  { mode: "native-own", url: "http://127.0.0.1:4100/api/bootstrap", socket: "ws://127.0.0.1:4100/api/socket", ticketPath: "http://127.0.0.1:4100/api/auth/sse-ticket", auth: null, credentials: "include", csrf: "csrf-secret" },
  { mode: "native-plue", url: "https://plue.example.test/api/bootstrap", socket: "wss://plue.example.test/api/socket", ticketPath: "https://plue.example.test/api/auth/sse-ticket", auth: "Bearer secret", credentials: "omit", csrf: null }
] as const

async function clientError(pending: Promise<unknown>): Promise<ApplicationClientError> {
  try { await pending } catch (error) {
    expect(error).toBeInstanceOf(ApplicationClientError)
    if (!(error instanceof ApplicationClientError)) throw error
    return error
  }
  throw new Error("Expected an application client refusal")
}

describe("application client", () => {
  test.each([...modes])("$mode uses the literal selected URL and auth", async ({ mode, url, auth, credentials }) => {
    const seen: Array<{ url: string; auth: string | null; credentials: RequestCredentials | undefined }> = []
    const client = createApplicationClient(target(mode), {
      pageOrigin, token: () => "secret",
      fetchImpl: async (input, init) => {
        seen.push({ url: String(input), auth: new Headers(init?.headers).get("authorization"), credentials: init?.credentials })
        return Response.json({ ok: true })
      }
    })
    await expect(client.request("/api/bootstrap")).resolves.toEqual({ ok: true })
    expect(seen).toEqual([{ url, auth, credentials }])
  })

  test("cancellation, auth, API refusals, and invalid responses stay distinct", async () => {
    const session = target("web-selfhost")
    const cancelled = createApplicationClient(session, {
      fetchImpl: async (_input, init) => {
        await new Promise((_resolve, reject) =>
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true })
        )
        return new Response()
      }
    })
    const abort = new AbortController()
    const pending = cancelled.request("/api/wait", { signal: abort.signal })
    abort.abort()
    await expect(pending).rejects.toMatchObject({ code: "cancelled" })

    await expect(createApplicationClient(target("native-plue")).request("/api/user"))
      .rejects.toMatchObject({ code: "auth-missing" })

    const refused = createApplicationClient(session, {
      fetchImpl: async () =>
        new Response(JSON.stringify({ code: "access_denied", message: "Denied." }), {
          status: 403,
          headers: { "retry-after": "4" }
        })
    })
    await expect(refused.request("/api/user")).rejects.toMatchObject({
      code: "forbidden",
      apiCode: "access_denied",
      status: 403,
      retryAfterSeconds: 4,
      refusal: { rawCode: "access_denied", fault: "user", retryAfter: 4 }
    })

    const bodyRetry = createApplicationClient(session, {
      fetchImpl: async () => Response.json({ code: "limited", fault: "dependency", retry_after: 7 }, { status: 429 })
    })
    await expect(bodyRetry.request("/api/user")).rejects.toMatchObject({
      code: "rate-limited",
      retryAfterSeconds: 7,
      refusal: { rawCode: "limited", fault: "dependency", retryAfter: 7 }
    })

    /* A fetch that threw: the refusal says nothing answered; the thrown text rides only on the cause. */
    const thrown = new TypeError("getaddrinfo ENOTFOUND app.example.test")
    const offline = createApplicationClient(session, { fetchImpl: async () => { throw thrown } })
    const transport = await offline.request("/api/user").catch((error: unknown) => error)
    expect(transport).toMatchObject({ code: "transport", cause: thrown, refusal: { origin: "client", status: null } })
    expect(JSON.stringify((transport as ApplicationClientError).refusal)).not.toContain("ENOTFOUND")
    expect(presentAppFailure(transport, () => {}).sentence).not.toContain("ENOTFOUND")

    const invalid = createApplicationClient(session, { fetchImpl: async () => new Response("not json") })
    const malformed = await clientError(invalid.request("/api/user"))
    expect(malformed).toMatchObject({ code: "invalid-response", message: "Backend returned invalid JSON.", status: 200 })
    expect(malformed.cause).toBeInstanceOf(SyntaxError)
  })

  test("aborting a signal during a JSON body read preserves cancellation and its cause", async () => {
    const cause = new DOMException("body aborted", "AbortError")
    const abort = new AbortController()
    const read = interruptedJsonRead(cause, abort.signal)
    const pending = read.client.request("/api/read", { signal: abort.signal })
    await read.reading
    abort.abort()

    const error: unknown = await pending.catch((failure: unknown) => failure)
    expect(error).toBeInstanceOf(ApplicationClientError)
    expect(error).toMatchObject({ code: "cancelled", message: "Request cancelled.", status: null })
    expect((error as ApplicationClientError).cause).toBe(cause)
  })

  test("a body AbortError without a signal and a custom signal reason are cancellations", async () => {
    const namedAbort = new Error("reader stopped")
    namedAbort.name = "AbortError"
    const reason = new Error("user stopped reading")
    const abort = new AbortController()

    for (const { cause, controller } of [
      { cause: namedAbort, controller: undefined },
      { cause: reason, controller: abort }
    ]) {
      const read = interruptedJsonRead(cause, controller?.signal)
      const pending = read.client.request("/api/read", { signal: controller?.signal })
      await read.reading
      controller?.abort(reason)
      if (controller === undefined) read.interrupt()

      const error: unknown = await pending.catch((failure: unknown) => failure)
      expect(error).toBeInstanceOf(ApplicationClientError)
      expect(error).toMatchObject({ code: "cancelled", message: "Request cancelled.", status: null })
      expect((error as ApplicationClientError).cause).toBe(cause)
    }
  })

  test("malformed JSON and an unrelated body reader failure remain invalid responses", async () => {
    const malformed = createApplicationClient(target("web-selfhost"), {
      fetchImpl: async () => new Response("not json")
    })
    const syntaxError: unknown = await malformed.request("/api/read").catch((failure: unknown) => failure)
    expect(syntaxError).toBeInstanceOf(ApplicationClientError)
    expect(syntaxError).toMatchObject({ code: "invalid-response", status: 200 })
    expect((syntaxError as ApplicationClientError).cause).toBeInstanceOf(SyntaxError)

    const cause = new Error("reader failed")
    const read = interruptedJsonRead(cause)
    const pending = read.client.request("/api/read")
    await read.reading
    read.interrupt()
    const error: unknown = await pending.catch((failure: unknown) => failure)
    expect(error).toBeInstanceOf(ApplicationClientError)
    expect(error).toMatchObject({ code: "invalid-response", status: 200 })
    expect((error as ApplicationClientError).cause).toBe(cause)
  })

  test("aborting a non-2xx body read reports cancellation with its cause", async () => {
    for (const method of ["stream", "request"] as const) {
      const abort = new AbortController()
      const cause = new DOMException("body read aborted", "AbortError")
      let reading!: () => void
      const bodyRead = new Promise<void>((resolve) => { reading = resolve })
      const client = createApplicationClient(target("web-selfhost"), {
        fetchImpl: async () => new Response(new ReadableStream({
          pull(controller) {
            reading()
            abort.signal.addEventListener("abort", () => controller.error(cause), { once: true })
          }
        }, { highWaterMark: 0 }), { status: 503 })
      })

      const pending = client[method]("/api/wait", { signal: abort.signal })
      await bodyRead
      abort.abort()
      const failure = await pending.catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(ApplicationClientError)
      expect(failure).toMatchObject({ code: "cancelled", status: null })
      expect((failure as ApplicationClientError).cause).toBe(cause)
    }
  })

  test("malformed non-2xx bodies still report the HTTP failure", async () => {
    const client = createApplicationClient(target("web-selfhost"), {
      fetchImpl: async () => new Response("not json", { status: 503 })
    })
    for (const method of ["stream", "request"] as const) {
      const signal = new AbortController().signal
      await expect(client[method]("/api/fail", { signal })).rejects.toMatchObject({
        code: "api", status: 503, message: "Request failed (503)."
      })
      expect(signal.aborted).toBe(false)
    }
  })

  test("never attaches an application credential to another origin", async () => {
    let calls = 0
    const client = createApplicationClient(target("native-plue"), {
      token: () => "secret",
      fetchImpl: async () => {
        calls += 1
        return new Response()
      }
    })
    await expect(client.stream("https://elsewhere.example.test/api/user"))
      .rejects.toMatchObject({ code: "invalid-target" })
    expect(calls).toBe(0)
  })

  test("explicit web Plue development uses the selected origin and bearer auth", async () => {
    const selected = resolveApplicationTarget({
      apiVersion: 1,
      mode: "web-plue",
      apiOrigin: "https://plue.example.test",
      auth: { kind: "bearer" },
      cors: "credentialed",
      developerExternal: true
    }, pageOrigin)
    let call: { readonly url: string; readonly authorization: string | null } | undefined
    const client = createApplicationClient(selected, {
      token: () => "developer-token",
      fetchImpl: async (input, init) => {
        call = { url: String(input), authorization: new Headers(init?.headers).get("authorization") }
        return Response.json({ ok: true })
      }
    })
    await client.request("/api/bootstrap")
    expect(call).toEqual({
      url: "https://plue.example.test/api/bootstrap",
      authorization: "Bearer developer-token"
    })
  })

  test.each([...modes])("$mode mutation uses the literal CSRF policy", async ({ mode, csrf }) => {
    let headers = new Headers()
    const client = createApplicationClient(target(mode), {
      pageOrigin, token: () => "secret", csrfToken: () => "csrf-secret",
      fetchImpl: async (_input, init) => { headers = new Headers(init?.headers); return Response.json({ ok: true }) }
    })
    await client.request("/api/write", { method: "POST" })
    expect(headers.get("x-csrf-token")).toBe(csrf)
  })

  test("owner bootstrap and login use one client and never expose credentials to Plue", async () => {
    const calls: Array<{ readonly path: string; readonly body: unknown; readonly bootstrap: string | null }> = []
    const owner = createApplicationClient(target("web-selfhost"), {
      pageOrigin,
      fetchImpl: async (input, init) => {
        const url = new URL(String(input), pageOrigin)
        calls.push({
          path: url.pathname,
          body: init?.body === undefined ? null : JSON.parse(String(init.body)),
          bootstrap: new Headers(init?.headers).get("x-smithers-bootstrap-token")
        })
        if (url.pathname.endsWith("/status")) return Response.json({ enabled: true, initialized: false })
        return Response.json({ user: { id: 1, username: "owner" } })
      }
    })
    await expect(owner.localIdentity.status()).resolves.toEqual({ enabled: true, initialized: false })
    await expect(owner.localIdentity.bootstrap({ username: "owner", password: "password", bootstrapToken: "setup" }))
      .resolves.toMatchObject({ user: { username: "owner" } })
    await expect(owner.localIdentity.login({ username: "owner", password: "password" }))
      .resolves.toMatchObject({ user: { username: "owner" } })
    expect(calls).toEqual([
      { path: "/api/auth/local/status", body: null, bootstrap: null },
      { path: "/api/auth/local/bootstrap", body: { username: "owner", password: "password" }, bootstrap: "setup" },
      { path: "/api/auth/local/login", body: { username: "owner", password: "password" }, bootstrap: null }
    ])

    let leaked = false
    const plue = createApplicationClient(target("native-plue"), {
      pageOrigin,
      token: () => "secret",
      fetchImpl: async () => {
        leaked = true
        return Response.json({})
      }
    })
    await expect(plue.localIdentity.login({ username: "owner", password: "password" }))
      .rejects.toMatchObject({ code: "invalid-target" })
    expect(leaked).toBe(false)
  })

  test("the selected backend user is the identity and token-scope authority", async () => {
    const session = createApplicationClient(target("web-selfhost"), {
      fetchImpl: async () => Response.json({ username: "owner", is_admin: true })
    })
    await expect(session.identity.current()).resolves.toEqual({ username: "owner", admin: true, scopes: null })

    const scoped = createApplicationClient(target("native-plue"), {
      token: () => "secret",
      fetchImpl: async () => Response.json({
        username: "plue-user",
        token_source: "personal_access_token",
        token_scopes: ["write:user", "write:repository"]
      })
    })
    await expect(scoped.identity.current()).resolves.toEqual({ username: "plue-user", admin: false, scopes: "degraded" })

    const signedOut = createApplicationClient(target("web-plue"), {
      fetchImpl: async () => Response.json({ code: "authentication_required" }, { status: 401 })
    })
    await expect(signedOut.identity.current()).resolves.toBeNull()
  })

  test("browser owner login is observed through the shared user route", async () => {
    let authenticated = false
    const paths: string[] = []
    const client = createApplicationClient(target("web-selfhost"), {
      fetchImpl: async (input, init) => {
        const path = new URL(String(input), pageOrigin).pathname
        paths.push(path)
        if (path === "/api/auth/local/login") {
          expect(init?.credentials).toBe("include")
          authenticated = true
          return Response.json({ user: { id: 1, username: "owner" } })
        }
        if (path === "/api/user") {
          return authenticated
            ? Response.json({ username: "owner", is_admin: true })
            : Response.json({ code: "authentication_required" }, { status: 401 })
        }
        throw new Error(`unexpected path ${path}`)
      }
    })
    await expect(client.identity.current()).resolves.toBeNull()
    await expect(client.localIdentity.login({ username: "owner", password: "password" }))
      .resolves.toMatchObject({ user: { username: "owner" } })
    await expect(client.identity.current()).resolves.toEqual({ username: "owner", admin: true, scopes: null })
    expect(paths).toEqual(["/api/user", "/api/auth/local/login", "/api/user"])
  })

  test.each([...modes])("$mode mints a socket ticket with the literal HTTP auth policy", async ({ mode, socket, ticketPath, auth, csrf, credentials }) => {
    const seen: Array<{ url: string; authorization: string | null; csrf: string | null; method: string | undefined; credentials: RequestCredentials | undefined }> = []
    const client = createApplicationClient(target(mode), {
      pageOrigin, token: () => "secret", csrfToken: () => "csrf-secret",
      fetchImpl: async (input, init) => {
        const headers = new Headers(init?.headers)
        seen.push({ url: String(input), authorization: headers.get("authorization"), csrf: headers.get("x-csrf-token"), method: init?.method, credentials: init?.credentials })
        return Response.json({ ticket: "one-use", expires_at: "2026-09-21T00:00:00Z" })
      }
    })
    await expect(client.authorizeWebSocket(socket)).resolves.toBe(`${socket}?ticket=one-use`)
    expect(seen).toEqual([{ url: ticketPath, authorization: auth, csrf, method: "POST", credentials }])
  })

  test("a socket ticket is never minted for another origin", async () => {
    let calls = 0
    const client = createApplicationClient(target("native-plue"), {
      pageOrigin,
      token: () => "secret",
      fetchImpl: async () => {
        calls += 1
        return Response.json({ ticket: "never", expires_at: "2026-09-21T00:00:00Z" })
      }
    })
    await expect(client.authorizeWebSocket("wss://elsewhere.example.test/api/socket"))
      .rejects.toMatchObject({ code: "invalid-target" })
    expect(calls).toBe(0)
  })
})

describe("application client controlled HTTP units", () => {
  test.each([
    { name: "null", wire: "null", expected: null },
    { name: "array", wire: '[1,"two",null]', expected: [1, "two", null] },
    { name: "number", wire: "42", expected: 42 },
    { name: "boolean", wire: "false", expected: false },
    { name: "Unicode string", wire: '"café 𐐀"', expected: "café 𐐀" }
  ])("generic JSON request returns the literal $name value without imposing an identity schema", async ({ wire, expected }) => {
    const client = createApplicationClient(target("web-selfhost"), { pageOrigin, fetchImpl: async () => new Response(wire, { headers: { "content-type": "application/json" } }) })
    await expect(client.request("/api/value")).resolves.toEqual(expected)
  })

  test("public client error retains the explicit host verdict and cause without replacing it with transport attribution", () => {
    const cause = new Error("host adapter context")
    const refusal: Refusal = { code: null, rawCode: "future_host_code", fault: "dependency", message: "Host refused.", retryAfter: 4, status: 503, origin: "local" }
    const error = new ApplicationClientError("api", "Host refused.", 503, "future_host_code", 4, { cause }, refusal)
    expect(error).toMatchObject({ name: "ApplicationClientError", code: "api", message: "Host refused.", status: 503, apiCode: "future_host_code", retryAfterSeconds: 4 })
    expect(error.refusal).toEqual({ code: null, rawCode: "future_host_code", fault: "dependency", message: "Host refused.", retryAfter: 4, status: 503, origin: "local" })
    expect(error.cause).toBe(cause)
  })

  test("public client error optional metadata defaults preserve a client-side verdict", () => {
    const error = new ApplicationClientError("transport", "Offline.")
    expect(error).toMatchObject({ name: "ApplicationClientError", code: "transport", message: "Offline.", status: null, apiCode: null, retryAfterSeconds: null })
    expect(error).not.toHaveProperty("cause")
    expect(error.refusal).toEqual({ code: null, rawCode: null, fault: "infra", message: "Offline.", retryAfter: null, status: null, origin: "client" })
  })

  test.each(["object", "tuples", "Headers"] as const)("Request headers merge with %s init headers and session method precedence", async kind => {
    const request = new Request("http://127.0.0.1:4100/api/write?q=1", {
      method: "POST", body: "payload", headers: { "content-type": "text/plain", "x-retained": "original", "x-overridden": "old" }
    })
    const initHeaders = kind === "object" ? { "x-overridden": "new", "x-added": "added" }
      : kind === "Headers" ? new Headers({ "x-overridden": "new", "x-added": "added" })
      : [["x-overridden", "new"], ["x-added", "added"]] satisfies [string, string][]
    const seen: Array<{ url: string; method: string; body: string; headers: [string, string][]; credentials: RequestCredentials | undefined }> = []
    let csrfReads = 0
    const client = createApplicationClient(target("native-own"), {
      csrfToken: () => { csrfReads++; return "csrf" },
      fetchImpl: async (input, init) => {
        expect(input).toBeInstanceOf(Request)
        if (!(input instanceof Request)) throw new Error("Expected forwarded Request")
        seen.push({ url: input.url, method: init?.method ?? input.method, body: await input.text(), headers: [...new Headers(init?.headers)], credentials: init?.credentials })
        return new Response(null, { status: 204 })
      }
    })
    await client.fetch(request, { method: "OPTIONS", headers: initHeaders, credentials: "omit" })
    expect(seen).toEqual([{
      url: "http://127.0.0.1:4100/api/write?q=1", method: "OPTIONS", body: "payload", credentials: "include",
      headers: [["content-type", "text/plain"], ["x-added", "added"], ["x-overridden", "new"], ["x-retained", "original"]]
    }])
    expect(csrfReads).toBe(0)
  })

  test("URL input retains its type and query while token auth replaces a stale header", async () => {
    const url = new URL("https://plue.example.test/api/read?q=a%20b")
    let reads = 0, calls = 0
    const client = createApplicationClient(target("native-plue"), {
      token: async () => { reads++; return "  fresh-token \n" }, csrfToken: () => { throw new Error("Session reader must not run") },
      fetchImpl: async (input, init) => {
        calls++
        expect(input).toBeInstanceOf(URL)
        expect(String(input)).toBe("https://plue.example.test/api/read?q=a%20b")
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fresh-token")
        expect(init?.credentials).toBe("omit")
        return new Response(null, { status: 204 })
      }
    })
    await client.fetch(url, { headers: { authorization: "Bearer old-token" }, credentials: "include" })
    expect([reads, calls]).toEqual([1, 1])
    expect(url.href).toBe("https://plue.example.test/api/read?q=a%20b")
  })

  test("each request reads the current async host token", async () => {
    let current = "first", reads = 0
    const seen: Array<string | null> = []
    const client = createApplicationClient(target("local-own"), {
      token: async () => { reads++; return current },
      fetchImpl: async (_input, init) => { seen.push(new Headers(init?.headers).get("authorization")); return Response.json({ ok: true }) }
    })
    await client.request("/api/read"); current = "second"; await client.request("/api/read")
    expect(seen).toEqual(["token first", "token second"])
    expect(reads).toBe(2)
  })

  test.each([
    { mode: "local-own", name: "undefined", token: undefined, message: "No token token is available for this backend." },
    { mode: "local-own", name: "whitespace", token: " \t", message: "No token token is available for this backend." },
    { mode: "native-plue", name: "undefined", token: undefined, message: "No bearer token is available for this backend." },
    { mode: "native-plue", name: "whitespace", token: " \n", message: "No bearer token is available for this backend." }
  ] as const)("$mode refuses $name host token without egress", async ({ mode, token, message }) => {
    let calls = 0
    const client = createApplicationClient(target(mode), { token: async () => token, fetchImpl: async () => { calls++; return Response.json({}) } })
    expect(await clientError(client.request("/api/read"))).toMatchObject({ name: "ApplicationClientError", code: "auth-missing", message, status: null, apiCode: null, retryAfterSeconds: null, refusal: { origin: "client", fault: "infra" } })
    expect(calls).toBe(0)
  })

  test.each([
    { method: "GET", mutation: false }, { method: "head", mutation: false }, { method: "OPTIONS", mutation: false },
    { method: "POST", mutation: true }, { method: "patch", mutation: true }, { method: "DELETE", mutation: true }
  ])("session $method applies CSRF only for mutations", async ({ method, mutation }) => {
    let reads = 0
    let actual = new Headers()
    const client = createApplicationClient(target("web-selfhost"), {
      pageOrigin, csrfToken: () => { reads++; return "  fresh-csrf  " },
      fetchImpl: async (_input, init) => { actual = new Headers(init?.headers); return new Response(null, { status: 204 }) }
    })
    await client.request("/api/write", { method, headers: { "X-CSRF-Token": "caller-csrf" } })
    expect([reads, actual.get("x-csrf-token")]).toEqual(mutation ? [1, "fresh-csrf"] : [0, "caller-csrf"])
  })

  test.each([{ name: "undefined", token: undefined }, { name: "empty", token: "" }, { name: "whitespace", token: " \t" }])("$name CSRF reader preserves an explicit caller header", async ({ token }) => {
    let actual = new Headers()
    const client = createApplicationClient(target("web-selfhost"), {
      pageOrigin, csrfToken: () => token,
      fetchImpl: async (_input, init) => { actual = new Headers(init?.headers); return new Response(null, { status: 204 }) }
    })
    await client.request("/api/write", { method: "POST", headers: { "x-csrf-token": "explicit" } })
    expect(actual.get("x-csrf-token")).toBe("explicit")
  })

  test.each([
    { input: "http://[", message: "Request URL is invalid." },
    { input: "https://other.example.test/api/read", message: "Application credentials cannot be sent outside the selected backend origin." }
  ])("invalid request $input is rejected before reading host credentials", async ({ input, message }) => {
    let reads = 0, calls = 0
    const client = createApplicationClient(target("native-plue"), {
      token: () => { reads++; return "secret" }, fetchImpl: async () => { calls++; return Response.json({}) }
    })
    expect(await clientError(client.stream(input))).toMatchObject({ code: "invalid-target", message, status: null })
    expect([reads, calls]).toEqual([0, 0])
  })

  test("stream returns the original unread response whose body the caller cancels", async () => {
    let cancelled: unknown
    const body = new ReadableStream<Uint8Array>({ cancel: reason => { cancelled = reason } })
    const response = new Response(body)
    const client = createApplicationClient(target("web-selfhost"), { pageOrigin, fetchImpl: async () => response })
    const result = await client.stream("/api/events")
    expect(result).toBe(response)
    expect(result.bodyUsed).toBe(false)
    await result.body!.cancel("caller finished")
    expect(cancelled).toBe("caller finished")
  })

  test.each([{ status: 200, expect: "empty" }, { status: 204, expect: "json" }] as const)("$status/$expect skips JSON parsing and strips the expect option", async ({ status, expect: expected }) => {
    const response = new Response(status === 204 ? null : "not-json", { status })
    let initSeen: RequestInit | undefined
    const client = createApplicationClient(target("web-selfhost"), { pageOrigin, fetchImpl: async (_input, init) => { initSeen = init; return response } })
    await expect(client.request("/api/read", { expect: expected })).resolves.toBeUndefined()
    expect(response.bodyUsed).toBe(false)
    expect(initSeen).not.toHaveProperty("expect")
  })

  test.each([
    { status: 401, body: { message: "Sign in", error: "ignored" }, code: "unauthenticated", message: "Sign in" },
    { status: 403, body: { message: "", error: "No access" }, code: "forbidden", message: "No access" },
    { status: 429, body: { message: 42, error: "" }, code: "rate-limited", message: "Request failed (429)." },
    { status: 500, body: null, code: "api", message: "Request failed (500)." },
    { status: 422, body: ["wrong envelope"], code: "api", message: "Request failed (422)." }
  ])("HTTP $status retains its public error classification and body message", async ({ status, body, code, message }) => {
    const client = createApplicationClient(target("web-selfhost"), { pageOrigin, fetchImpl: async () => Response.json(body, { status }) })
    expect(await clientError(client.request("/api/read"))).toMatchObject({ code, message, status, apiCode: null, retryAfterSeconds: null, refusal: { message, status } })
  })

  test("non-JSON API refusal remains an API error with its HTTP status", async () => {
    const client = createApplicationClient(target("web-selfhost"), { pageOrigin, fetchImpl: async () => new Response("gateway unavailable", { status: 502 }) })
    expect(await clientError(client.request("/api/read"))).toMatchObject({ code: "api", message: "Request failed (502).", status: 502 })
  })

  test.each([{ header: "9", expected: 9 }, { header: "bad", expected: 7 }])("API retry header $header retains body fallback and explicit verdict", async ({ header, expected }) => {
    const client = createApplicationClient(target("web-selfhost"), {
      pageOrigin, fetchImpl: async () => Response.json({ code: "future_code", fault: "dependency", origin: "local", message: "Wait", retry_after: 7 }, { status: 503, headers: { "retry-after": header } })
    })
    expect(await clientError(client.request("/api/read"))).toMatchObject({ code: "api", apiCode: "future_code", message: "Wait", status: 503, retryAfterSeconds: expected, refusal: { rawCode: "future_code", code: null, origin: "local", fault: "dependency", retryAfter: expected } })
  })

  test.each([{ name: "Error", cause: new Error("offline") }, { name: "string", cause: "host unreachable" }])("stream wraps $name transport failure and retains the cause", async ({ cause }) => {
    const client = createApplicationClient(target("web-selfhost"), { pageOrigin, fetchImpl: async () => { throw cause } })
    const error = await clientError(client.stream("/api/read"))
    expect(error).toMatchObject({ code: "transport", message: "Could not reach Smithers.", status: null, refusal: { origin: "client", fault: "infra" } })
    expect(error.cause).toBe(cause)
    // The raw authenticated fetch deliberately retains the FetchLike rejection.
    await expect(client.fetch("/api/read")).rejects.toBe(cause)
  })

  test.each([{ name: "DOMException", cause: new DOMException("stopped", "AbortError") }, { name: "Error", cause: Object.assign(new Error("stopped"), { name: "AbortError" }) }])("native $name abort failure becomes cancelled with its original cause", async ({ cause }) => {
    const client = createApplicationClient(target("web-selfhost"), { pageOrigin, fetchImpl: async () => { throw cause } })
    const error = await clientError(client.request("/api/read"))
    expect(error).toMatchObject({ code: "cancelled", message: "Request cancelled.", status: null })
    expect(error.cause).toBe(cause)
  })

  test("an already-aborted signal classifies a rejecting controlled fetch as cancellation", async () => {
    const abort = new AbortController(), cause = new Error("host stopped")
    abort.abort()
    const client = createApplicationClient(target("web-selfhost"), { pageOrigin, fetchImpl: async (_input, init) => { expect(init?.signal).toBe(abort.signal); throw cause } })
    const error = await clientError(client.request("/api/read", { signal: abort.signal }))
    expect(error.code).toBe("cancelled")
    expect(error.cause).toBe(cause)
  })

  test("a typed application refusal from the host remains the same error", async () => {
    const original = new ApplicationClientError("forbidden", "Host denied", 403)
    const client = createApplicationClient(target("web-selfhost"), { pageOrigin, fetchImpl: async () => { throw original } })
    expect(await clientError(client.stream("/api/read"))).toBe(original)
  })

  test("an asynchronous host token failure is wrapped before any fetch", async () => {
    const cause = new Error("host locked"); let calls = 0
    const client = createApplicationClient(target("native-plue"), { token: async () => { throw cause }, fetchImpl: async () => { calls++; return Response.json({}) } })
    const error = await clientError(client.request("/api/read"))
    expect(error).toMatchObject({ code: "transport", message: "Could not reach Smithers." })
    expect(error.cause).toBe(cause)
    expect(calls).toBe(0)
  })

  test("Request's own mutation method supplies CSRF when init does not override it", async () => {
    const request = new Request("http://127.0.0.1:4100/api/write", { method: "POST", body: "payload" })
    let actual = new Headers()
    const client = createApplicationClient(target("native-own"), {
      csrfToken: () => "csrf", fetchImpl: async (_input, init) => { actual = new Headers(init?.headers); return new Response(null, { status: 204 }) }
    })
    await client.fetch(request)
    expect(actual.get("x-csrf-token")).toBe("csrf")
  })

  test("server rendering without an origin cannot mint a socket ticket", async () => {
    expect(typeof globalThis.location).toBe("undefined")
    let calls = 0
    const client = createApplicationClient(target("web-selfhost"), { fetchImpl: async () => { calls++; return Response.json({}) } })
    expect(await clientError(client.authorizeWebSocket("wss://app.example.test/api/socket"))).toMatchObject({ code: "invalid-target", message: "The selected backend origin is unavailable." })
    expect(calls).toBe(0)
  })

  // A response body's native rejection belongs to the same cancellation boundary
  // as the initial FetchLike promise; malformed JSON above is a separate control.
  test.each([
    { name: "request signal", cause: new DOMException("body read stopped", "AbortError"), signal: true },
    { name: "host AbortError", cause: Object.assign(new Error("body read stopped"), { name: "AbortError" }), signal: false },
    { name: "custom abort reason", cause: new Error("custom stop reason"), signal: true }
  ])("successful JSON body consumption cancelled by $name stays cancelled", async ({ cause, signal }) => {
    const abort = new AbortController(), started = Promise.withResolvers<void>()
    let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined
    const body = new ReadableStream<Uint8Array>({
      start(controller) { bodyController = controller },
      pull() { started.resolve() }
    }, { highWaterMark: 0 })
    const cancel = () => { bodyController!.error(cause) }
    const client = createApplicationClient(target("web-selfhost"), {
      pageOrigin, fetchImpl: async (_input, init) => {
        expect(init?.signal).toBe(signal ? abort.signal : undefined)
        if (signal) abort.signal.addEventListener("abort", cancel, { once: true })
        return new Response(body, { headers: { "content-type": "application/json" } })
      }
    })
    const pending = clientError(client.request("/api/read", { signal: signal ? abort.signal : undefined }))
    try {
      await started.promise
      if (signal) abort.abort(cause)
      else bodyController!.error(cause)
      const error = await pending
      expect(error).toMatchObject({ code: "cancelled", message: "Request cancelled.", status: null })
      expect(error.cause).toBe(cause)
    } finally {
      abort.signal.removeEventListener("abort", cancel)
      bodyController!.error(cause)
      await pending
    }
  })

  test("a non-abort body reader failure stays distinct from cancellation and retains its cause", async () => {
    const cause = new Error("body transport interrupted")
    const body = new ReadableStream<Uint8Array>({ start: controller => controller.error(cause) })
    const client = createApplicationClient(target("web-selfhost"), { pageOrigin, fetchImpl: async () => new Response(body) })
    const error = await clientError(client.request("/api/read"))
    // The public contract does not specify a dedicated code for non-abort body
    // I/O failure; retain that distinction without asserting it is JSON syntax.
    expect(error.code).not.toBe("cancelled")
    expect(error.cause).toBe(cause)
  })
})

describe("application identity and owner contract units", () => {
  test.each([
    { name: "omitted", body: { username: "owner" }, expected: { username: "owner", admin: false, scopes: null } },
    { name: "empty", body: { username: "owner", token_scopes: [] }, expected: { username: "owner", admin: false, scopes: "degraded" } },
    { name: "complete", body: { username: "owner", token_scopes: ["write:user", "write:repository", "write:workspace", "write:approval", "write:agent"] }, expected: { username: "owner", admin: false, scopes: null } },
    { name: "all", body: { username: "owner", token_scopes: ["all"] }, expected: { username: "owner", admin: false, scopes: null } },
    { name: "admin scope", body: { username: "owner", token_scopes: ["admin"] }, expected: { username: "owner", admin: false, scopes: null } },
    { name: "admin flag", body: { username: "owner", is_admin: true, token_scopes: ["write:user"] }, expected: { username: "owner", admin: true, scopes: "degraded" } },
    { name: "duplicates and unrelated", body: { username: "owner", token_scopes: ["write:user", "write:user", "read:repository", "future"] }, expected: { username: "owner", admin: false, scopes: "degraded" } },
    { name: "forward-compatible user", body: { username: "owner", is_admin: false, future: { enabled: true } }, expected: { username: "owner", admin: false, scopes: null } }
  ])("identity $name scopes retain independent admin and capability answers", async ({ body, expected }) => {
    const signal = new AbortController().signal
    const client = createApplicationClient(target("web-selfhost"), {
      pageOrigin, fetchImpl: async (input, init) => { expect(String(input)).toBe("/api/user"); expect(init?.signal).toBe(signal); return Response.json(body) }
    })
    await expect(client.identity.current(signal)).resolves.toEqual(expected)
  })

  test.each([
    { name: "a GitHub name, trimmed", display: "  Ada Park ", expected: { displayName: "Ada Park" } },
    { name: "a blank name as none", display: "   ", expected: {} },
    { name: "an empty name as none", display: "", expected: {} },
    { name: "an absent name as none", display: undefined, expected: {} }
  ])("identity reads $name from display_name", async ({ display, expected }) => {
    const client = createApplicationClient(target("web-selfhost"), { pageOrigin,
      fetchImpl: async () => Response.json({ username: "owner", ...(display === undefined ? {} : { display_name: display }) }) })
    await expect(client.identity.current()).resolves.toEqual({ username: "owner", ...expected, admin: false, scopes: null })
  })

  test.each([
    { name: "null", body: null }, { name: "empty username", body: { username: "" } },
    { name: "invalid admin", body: { username: "owner", is_admin: "yes" } },
    { name: "empty scope", body: { username: "owner", token_scopes: [""] } },
    { name: "invalid display name", body: { username: "owner", display_name: 7 } }
  ])("identity rejects $name rather than claiming signed out", async ({ body }) => {
    const client = createApplicationClient(target("web-selfhost"), { pageOrigin, fetchImpl: async () => Response.json(body) })
    const error = await clientError(client.identity.current())
    expect(error).toMatchObject({ code: "invalid-response", message: "Backend returned an invalid authenticated user.", status: null })
    expect(error.cause).toHaveProperty("name", "ZodError")
  })

  test.each([{ status: 403, code: "forbidden" }, { status: 500, code: "api" }])("identity HTTP $status rejects instead of erasing the failure as signed out", async ({ status, code }) => {
    const client = createApplicationClient(target("web-selfhost"), { pageOrigin, fetchImpl: async () => Response.json({ message: "Unavailable" }, { status }) })
    expect(await clientError(client.identity.current())).toMatchObject({ code, message: "Unavailable", status })
  })

  test.each(["status", "login", "bootstrap"] as const)("Plue owner %s is refused before validation, token lookup, or fetch", async operation => {
    let reads = 0, calls = 0
    const client = createApplicationClient(target("native-plue"), {
      token: () => { reads++; return "secret" }, fetchImpl: async () => { calls++; return Response.json({}) }
    })
    const pending = operation === "status" ? client.localIdentity.status()
      : operation === "login" ? client.localIdentity.login({ username: "", password: "" })
      : client.localIdentity.bootstrap({ username: "", password: "", bootstrapToken: "" })
    expect(await clientError(pending)).toMatchObject({ code: "invalid-target", message: "Local owner credentials cannot be sent to a Plue backend." })
    expect([reads, calls]).toEqual([0, 0])
  })

  test.each([
    { name: "username", credentials: { username: "", password: "password" } },
    { name: "password", credentials: { username: "owner", password: "" } }
  ])("owner login rejects empty $name before fetch", async ({ credentials }) => {
    let calls = 0
    const client = createApplicationClient(target("web-selfhost"), { pageOrigin, fetchImpl: async () => { calls++; return Response.json({}) } })
    await expect(client.localIdentity.login(credentials)).rejects.toHaveProperty("name", "ZodError")
    expect(calls).toBe(0)
  })

  test.each([
    { name: "bootstrap token", bootstrap: { username: "owner", password: "password", bootstrapToken: "" } },
    { name: "email", bootstrap: { username: "owner", password: "password", bootstrapToken: "setup", email: "invalid" } }
  ])("owner bootstrap rejects invalid $name before fetch", async ({ bootstrap }) => {
    let calls = 0
    const client = createApplicationClient(target("web-selfhost"), { pageOrigin, fetchImpl: async () => { calls++; return Response.json({}) } })
    await expect(client.localIdentity.bootstrap(bootstrap)).rejects.toHaveProperty("name", "ZodError")
    expect(calls).toBe(0)
  })

  test("bootstrap sends email in JSON and its token only in the bootstrap header", async () => {
    const signal = new AbortController().signal
    const seen: Array<{ path: string; body: unknown; headers: [string, string][]; signal: AbortSignal | null | undefined; method: string | undefined }> = []
    const client = createApplicationClient(target("web-selfhost"), {
      pageOrigin, csrfToken: () => "csrf", fetchImpl: async (input, init) => {
        seen.push({ path: String(input), body: JSON.parse(String(init?.body)), headers: [...new Headers(init?.headers)], signal: init?.signal, method: init?.method })
        return Response.json({ user: { id: 7, username: "owner" } })
      }
    })
    await expect(client.localIdentity.bootstrap({ username: "owner", password: "password", bootstrapToken: "setup-token", email: "owner@example.test" }, signal)).resolves.toEqual({ user: { id: 7, username: "owner" } })
    expect(seen).toEqual([{
      path: "/api/auth/local/bootstrap", body: { username: "owner", password: "password", email: "owner@example.test" }, signal, method: "POST",
      headers: [["content-type", "application/json"], ["x-csrf-token", "csrf"], ["x-smithers-bootstrap-token", "setup-token"]]
    }])
  })

  test.each([
    { operation: "status", body: { enabled: true, initialized: false, unexpected: true }, message: "Backend returned an invalid local identity status." },
    { operation: "login", body: { user: { id: 1.5, username: "owner" } }, message: "Backend returned an invalid local login response." },
    { operation: "bootstrap", body: { user: { id: 1, username: "" } }, message: "Backend returned an invalid local bootstrap response." }
  ] as const)("owner $operation rejects malformed successful wire data", async ({ operation, body, message }) => {
    const client = createApplicationClient(target("web-selfhost"), { pageOrigin, fetchImpl: async () => Response.json(body) })
    const pending = operation === "status" ? client.localIdentity.status() : operation === "login"
      ? client.localIdentity.login({ username: "owner", password: "password" })
      : client.localIdentity.bootstrap({ username: "owner", password: "password", bootstrapToken: "setup" })
    const error = await clientError(pending)
    expect(error).toMatchObject({ code: "invalid-response", message, status: null })
    expect(error.cause).toHaveProperty("name", "ZodError")
  })
})

describe("application socket authorization units", () => {
  test.each([
    { input: "/api/socket", message: "WebSocket URL is invalid." },
    { input: "http://[", message: "WebSocket URL is invalid." },
    { input: "https://app.example.test/api/socket", message: "WebSocket URL must use WS(S)." },
    { input: "ws://app.example.test/api/socket", message: "Application credentials cannot be sent outside the selected backend origin." },
    { input: "wss://app.example.test:444/api/socket", message: "Application credentials cannot be sent outside the selected backend origin." }
  ])("socket $input is rejected without a ticket request", async ({ input, message }) => {
    let calls = 0
    const client = createApplicationClient(target("web-selfhost"), { pageOrigin, fetchImpl: async () => { calls++; return Response.json({}) } })
    expect(await clientError(client.authorizeWebSocket(input))).toMatchObject({ code: "invalid-target", message })
    expect(calls).toBe(0)
  })

  test("each socket call replaces any old ticket and preserves the other query/path/hash", async () => {
    const signal = new AbortController().signal
    let calls = 0
    const client = createApplicationClient(target("web-selfhost"), {
      pageOrigin, fetchImpl: async (input, init) => {
        expect(String(input)).toBe("/api/auth/sse-ticket"); expect(init?.signal).toBe(signal); calls++
        return Response.json({ ticket: `fresh ${calls}`, expires_at: "2026-09-21T00:00:00Z" })
      }
    })
    const socket = "wss://app.example.test/api/socket?channel=chat&ticket=old&ticket=duplicate#tail"
    await expect(client.authorizeWebSocket(socket, signal)).resolves.toBe("wss://app.example.test/api/socket?channel=chat&ticket=fresh+1#tail")
    await expect(client.authorizeWebSocket(socket, signal)).resolves.toBe("wss://app.example.test/api/socket?channel=chat&ticket=fresh+2#tail")
    expect(calls).toBe(2)
  })

  test.each([
    { name: "blank ticket", body: { ticket: "", expires_at: "later" } },
    { name: "missing expiry", body: { ticket: "one-use" } },
    { name: "unexpected data", body: { ticket: "one-use", expires_at: "later", extra: true } }
  ])("socket rejects $name in a successful ticket response", async ({ body }) => {
    const client = createApplicationClient(target("web-selfhost"), { pageOrigin, fetchImpl: async () => Response.json(body) })
    const error = await clientError(client.authorizeWebSocket("wss://app.example.test/api/socket"))
    expect(error).toMatchObject({ code: "invalid-response", message: "Backend returned an invalid socket ticket." })
    expect(error.cause).toHaveProperty("name", "ZodError")
  })
})

describe("application client owned browser cookie units", () => {
  beforeAll(() => GlobalRegistrator.register({ url: pageOrigin }))
  // HappyDOM retains an empty cookie for Max-Age=0. A real past expiry removes
  // it, so an absent-cookie case cannot accidentally inherit the empty case.
  const clearOwnedCookies = () => {
    for (const name of ["__csrf", "unrelated"]) document.cookie = `${name}=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/`
  }
  beforeEach(clearOwnedCookies)
  afterEach(clearOwnedCookies)
  afterAll(async () => { await GlobalRegistrator.unregister() })

  test.each([
    { name: "encoded", cookie: "__csrf=csrf%2Bsecret", expected: "csrf+secret" },
    { name: "malformed percent", cookie: "__csrf=%ZZ", expected: null },
    { name: "empty", cookie: "__csrf=", expected: null },
    { name: "absent", cookie: "unrelated=csrf", expected: null }
  ])("browser $name CSRF cookie is handled without exposing other cookies", async ({ cookie, expected }) => {
    document.cookie = "unrelated=ignored; Path=/"
    document.cookie = `${cookie}; Path=/`
    if (cookie === "unrelated=csrf") expect(document.cookie).toBe("unrelated=csrf")
    let headers = new Headers()
    const client = createApplicationClient(target("web-selfhost"), { fetchImpl: async (_input, init) => { headers = new Headers(init?.headers); return Response.json({}) } })
    await client.request("/api/write", { method: "POST" })
    expect(headers.get("x-csrf-token")).toBe(expected)
    expect(headers.get("cookie")).toBeNull()
  })

  test("a browser with zero cookies makes a session mutation with no CSRF header", async () => {
    expect(document.cookie).toBe("")
    let headers = new Headers()
    const client = createApplicationClient(target("web-selfhost"), { fetchImpl: async (_input, init) => { headers = new Headers(init?.headers); return Response.json({ ok: true }) } })
    await expect(client.request("/api/write", { method: "POST" })).resolves.toEqual({ ok: true })
    expect(headers.get("x-csrf-token")).toBeNull()
    expect(document.cookie).toBe("")
  })

  test("omitting fetchImpl delegates to the owned global fetch with its receiver, URL, and session options", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch")!
    const seen: Array<{ url: string; credentials: RequestCredentials | undefined; header: string | null; signal: AbortSignal | null | undefined }> = []
    const signal = new AbortController().signal
    const delegated = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async function(this: unknown, input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) {
      expect(this).toBe(globalThis)
      seen.push({ url: String(input), credentials: init?.credentials, header: new Headers(init?.headers).get("x-test"), signal: init?.signal })
      return Response.json({ delegated: true })
    }, { preconnect: () => { throw new Error("Unexpected preconnect.") } }))
    try {
      const client = createApplicationClient(target("web-selfhost"))
      await expect(client.request("/api/read?q=1", { signal, credentials: "omit", headers: { "x-test": "owned" } })).resolves.toEqual({ delegated: true })
      expect(seen).toEqual([{ url: "/api/read?q=1", credentials: "include", header: "owned", signal }])
      expect(delegated).toHaveBeenCalledTimes(1)
    } finally {
      delegated.mockRestore()
      Object.defineProperty(globalThis, "fetch", descriptor)
      expect(Object.getOwnPropertyDescriptor(globalThis, "fetch")).toEqual(descriptor)
    }
  })

  test("browser origin authority rejects a foreign URL before session fetch", async () => {
    let calls = 0
    const client = createApplicationClient(target("web-selfhost"), { fetchImpl: async () => { calls++; return Response.json({}) } })
    expect(await clientError(client.stream("https://foreign.example.test/api/read"))).toMatchObject({ code: "invalid-target", message: "Application credentials cannot be sent outside the selected backend origin." })
    expect(calls).toBe(0)
  })
})
