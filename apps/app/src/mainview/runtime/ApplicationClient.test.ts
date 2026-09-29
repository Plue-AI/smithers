import { resolveApplicationTarget } from "@smthrs/rpc/ApplicationTarget"
import { describe, expect, test } from "bun:test"
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

describe("application client", () => {
  test("the six targets share URL and auth behavior", async () => {
    for (const mode of ["web-selfhost", "web-plue", "local-own", "local-plue", "native-own", "native-plue"] as const) {
      const seen: Array<{ url: string; auth: string | null; credentials: RequestCredentials | undefined }> = []
      const client = createApplicationClient(target(mode), {
        token: () => "secret",
        fetchImpl: async (input, init) => {
          seen.push({
            url: String(input),
            auth: new Headers(init?.headers).get("authorization"),
            credentials: init?.credentials
          })
          return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } })
        }
      })
      await expect(client.request("/api/bootstrap")).resolves.toEqual({ ok: true })
      const call = seen[0]!
      expect(call.url).toBe(client.baseUrl === "" ? "/api/bootstrap" : `${client.baseUrl}/api/bootstrap`)
      if (client.target.auth.kind === "session") {
        expect(call).toMatchObject({ auth: null, credentials: "include" })
      } else {
        expect(call).toMatchObject({
          auth: `${client.target.auth.kind === "bearer" ? "Bearer" : "token"} secret`,
          credentials: "omit"
        })
      }
    }
  })

  test("cancellation, auth, API refusals, and invalid responses stay distinct", async () => {
    const session = target("web-selfhost")
    const cancelled = createApplicationClient(session, {
      fetchImpl: async (_input, init) => {
        await new Promise((_resolve, reject) =>
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))
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

    const invalid = createApplicationClient(session, { fetchImpl: async () => new Response("not json") })
    await expect(invalid.request("/api/user")).rejects.toBeInstanceOf(ApplicationClientError)
    await expect(invalid.request("/api/user")).rejects.toMatchObject({ code: "invalid-response" })
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

  test("session mutations echo the CSRF cookie while token requests stay stateless", async () => {
    for (const mode of ["web-selfhost", "native-own", "native-plue"] as const) {
      let headers = new Headers()
      const client = createApplicationClient(target(mode), {
        pageOrigin,
        token: () => "secret",
        csrfToken: () => "csrf-secret",
        fetchImpl: async (_input, init) => {
          headers = new Headers(init?.headers)
          return Response.json({ ok: true })
        }
      })
      await client.request("/api/write", { method: "POST" })
      if (client.target.auth.kind === "session") {
        expect(headers.get("x-csrf-token")).toBe("csrf-secret")
      } else {
        expect(headers.get("x-csrf-token")).toBeNull()
      }
    }
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

  test("all six modes mint fresh socket tickets only for their selected origin", async () => {
    for (const mode of ["web-selfhost", "web-plue", "local-own", "local-plue", "native-own", "native-plue"] as const) {
      const seen: Array<{ readonly url: string; readonly authorization: string | null; readonly csrf: string | null }> = []
      const client = createApplicationClient(target(mode), {
        pageOrigin,
        token: () => "secret",
        csrfToken: () => "csrf-secret",
        fetchImpl: async (input, init) => {
          const headers = new Headers(init?.headers)
          seen.push({ url: String(input), authorization: headers.get("authorization"), csrf: headers.get("x-csrf-token") })
          return Response.json({ ticket: `ticket-${mode}`, expires_at: "2026-09-21T00:00:00Z" })
        }
      })
      const origin = client.baseUrl === "" ? pageOrigin : client.baseUrl
      const socketOrigin = origin.replace(/^https:/, "wss:").replace(/^http:/, "ws:")
      const authorized = await client.authorizeWebSocket(`${socketOrigin}/api/repos/o/r/workspace/sessions/s/terminal`)
      expect(new URL(authorized).searchParams.get("ticket")).toBe(`ticket-${mode}`)
      expect(seen).toHaveLength(1)
      expect(new URL(seen[0]!.url, pageOrigin).pathname).toBe("/api/auth/sse-ticket")
      if (client.target.auth.kind === "session") expect(seen[0]!.csrf).toBe("csrf-secret")
      else expect(seen[0]!.authorization).toContain("secret")
    }
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
