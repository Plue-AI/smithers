import { describe, expect, it } from "@effect/vitest"
import * as Capability from "@smthrs/capability/Capability"
import { PermissionDenied, type PermissionError, PermissionRequired, Rule } from "@smthrs/capability/Permission"
import { Context, Effect, Fiber, Option, Stream } from "effect"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import * as HttpBody from "effect/unstable/http/HttpBody"
import * as EffectHttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientErrorModule from "effect/unstable/http/HttpClientError"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import { emptyPolicy as closedPolicy } from "../src/GrantStore.ts"
import { GrantStore, make as makeGrantStore, type Service } from "../src/GrantStore.ts"
import * as HttpClient from "../src/HttpClient.ts"
import * as Workspace from "../src/Workspace.ts"

const itEffect = <E>(name: string, effect: () => Effect.Effect<void, E>) => it.effect(name, () => effect())

const store = (checks: Array<Capability.Capability>, allowed = true) =>
  GrantStore.of({
    policy: closedPolicy,
    check: (capability) => {
      checks.push(capability)
      return allowed
        ? Effect.void
        : Effect.fail(new PermissionDenied({ code: "permission_denied", capability, reason: "denied by test" }))
    },
    reply: () => Effect.die("not used by HTTP decorator tests"),
    list: Effect.succeed([]),
    grantEnvelope: () => Effect.void
  })

const host = (calls: Array<string>) =>
  EffectHttpClient.make((request) =>
    Effect.sync(() => {
      calls.push(request.url)
      return { status: 200, headers: {}, request } as HttpClientResponse.HttpClientResponse
    })
  )

/** A host client that bounces `first.test` once to `second.test`. */
const redirecting = (calls: Array<string>) =>
  EffectHttpClient.make((request) =>
    Effect.sync(() => {
      calls.push(request.url)
      return (request.url.includes("first")
        ? { status: 302, headers: { location: "https://second.test/next" }, request }
        : { status: 200, headers: {}, request }) as HttpClientResponse.HttpClientResponse
    })
  )

/** The guarded client, decorating a host client in place under Effect's tag. */
const protectedClient = <A, E>(
  effect: Effect.Effect<A, E, EffectHttpClient.HttpClient>,
  client: EffectHttpClient.HttpClient,
  grants: Service
) =>
  effect.pipe(
    Effect.provide(HttpClient.layer),
    Effect.provideService(EffectHttpClient.HttpClient, client),
    Effect.provideService(GrantStore, grants)
  )

const denial = (error: unknown) => Option.getOrThrow(HttpClient.fromHttpClientError(error as never))

describe("HttpClient", () => {
  for (const length of [4096, 4097]) {
    for (const kind of ["invalid URL", "host", "model"] as const) {
      itEffect(`keeps a ${length}-unit ${kind} resource in the typed channel`, () => {
        const checks: Array<Capability.Capability> = []
        const calls: Array<string> = []
        return Effect.gen(function*() {
          const client = yield* EffectHttpClient.HttpClient
          const request = kind === "model"
            ? client.post("https://api.test").pipe(HttpClient.withModelCall("x".repeat(length - "api.test/".length)))
            : client.get(kind === "host" ? `https://${"x".repeat(length)}` : "x".repeat(length))
          const error = denial(yield* Effect.flip(request))
          expect(error.code).toBe(length === 4096 ? "permission_denied" : "invalid_resolution")
          if (length === 4097) expect(error).toMatchObject({ message: expect.stringContaining("4096") })
          expect(checks).toHaveLength(length === 4096 && kind !== "invalid URL" ? 1 : 0)
          expect(calls).toEqual([])
        }).pipe((effect) => protectedClient(effect, host(calls), store(checks, false)))
      })
    }
  }

  itEffect("maps GET and HEAD to net:get and every other method to net:post", () => {
    const checks: Array<Capability.Capability> = []
    const calls: Array<string> = []
    const methods = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE"] as const
    return Effect.forEach(methods, (method) =>
      Effect.gen(function*() {
        const client = yield* EffectHttpClient.HttpClient
        yield* client.execute(HttpClientRequest.make(method)("https://example.test/path"))
      })).pipe(
        Effect.asVoid,
        (effect) => protectedClient(effect, host(calls), store(checks)),
        Effect.tap(() =>
          Effect.sync(() => {
            expect(checks.map((capability) => capability.action)).toEqual([
              "net:get",
              "net:get",
              "net:post",
              "net:post",
              "net:post",
              "net:post",
              "net:post",
              "net:post"
            ])
            expect(calls).toHaveLength(methods.length)
          })
        )
      )
  })

  itEffect("normalizes the URL host to lowercase and retains a nondefault port", () => {
    const checks: Array<Capability.Capability> = []
    const calls: Array<string> = []
    return Effect.gen(function*() {
      const client = yield* EffectHttpClient.HttpClient
      yield* client.get("https://API.Example.Test:8443/v1")
      expect(checks).toEqual([{ action: "net:get", resource: "api.example.test:8443" }])
    }).pipe((effect) => protectedClient(effect, host(calls), store(checks)))
  })

  itEffect("does not let an HTTPS network grant authorize an HTTP downgrade", () =>
    Effect.gen(function*() {
      const calls: Array<string> = []
      const grants = yield* makeGrantStore({
        attended: false,
        rules: [
          new Rule({
            effect: "allow",
            pattern: new Capability.CapabilityPattern({ action: "net:get", resource: "api.example.com" })
          })
        ]
      }).pipe(Effect.provide(Workspace.layer("/workspace")))

      const failure = yield* Effect.gen(function*() {
        const client = yield* EffectHttpClient.HttpClient
        yield* client.get("https://api.example.com/x")
        return yield* Effect.flip(client.get("http://API.Example.COM/x"))
      }).pipe((effect) => protectedClient(effect, host(calls), grants))

      expect(denial(failure)).toBeInstanceOf(PermissionRequired)
      expect(denial(failure)).toMatchObject({
        capability: { action: "net:get", resource: "http://api.example.com" }
      })
      expect(calls).toEqual(["https://api.example.com/x"])
    }).pipe(Effect.scoped))

  itEffect("maps a model call to model:call without granting general net:post", () => {
    const checks: Array<Capability.Capability> = []
    const calls: Array<string> = []
    return Effect.gen(function*() {
      const client = yield* EffectHttpClient.HttpClient
      yield* client.execute(HttpClientRequest.post("https://API.Example.Test/v1/messages")).pipe(
        HttpClient.withModelCall("anthropic/claude")
      )
      expect(checks).toEqual([
        { action: "model:call", resource: "api.example.test/anthropic/claude" }
      ])
      expect(calls).toEqual(["https://API.Example.Test/v1/messages"])
    }).pipe((effect) => protectedClient(effect, host(calls), store(checks)))
  })

  itEffect("does not let an HTTPS model grant authorize an HTTP downgrade", () =>
    Effect.gen(function*() {
      const calls: Array<string> = []
      const grants = yield* makeGrantStore({
        attended: false,
        rules: [
          new Rule({
            effect: "allow",
            pattern: new Capability.CapabilityPattern({
              action: "model:call",
              resource: "api.example.com/model-x"
            })
          })
        ]
      }).pipe(Effect.provide(Workspace.layer("/workspace")))

      const failure = yield* Effect.gen(function*() {
        const client = yield* EffectHttpClient.HttpClient
        yield* client.post("https://api.example.com/models").pipe(HttpClient.withModelCall("model-x"))
        return yield* Effect.flip(
          client.post("http://API.Example.COM/models").pipe(HttpClient.withModelCall("model-x"))
        )
      }).pipe((effect) => protectedClient(effect, host(calls), grants))

      expect(denial(failure)).toBeInstanceOf(PermissionRequired)
      expect(denial(failure)).toMatchObject({
        capability: { action: "model:call", resource: "http://api.example.com/model-x" }
      })
      expect(calls).toEqual(["https://api.example.com/models"])
    }).pipe(Effect.scoped))

  itEffect("fails a relative or unparsable URL with a typed denial before the host client", () => {
    const checks: Array<Capability.Capability> = []
    const calls: Array<string> = []
    return Effect.gen(function*() {
      const client = yield* EffectHttpClient.HttpClient
      const failure = yield* Effect.flip(client.get("/relative"))
      expect(denial(failure)).toBeInstanceOf(PermissionDenied)
      expect(checks).toEqual([])
      expect(calls).toEqual([])
    }).pipe((effect) => protectedClient(effect, host(calls), store(checks)))
  })

  itEffect("does not delegate a denied request", () => {
    const checks: Array<Capability.Capability> = []
    const calls: Array<string> = []
    return Effect.gen(function*() {
      const client = yield* EffectHttpClient.HttpClient
      const failure = yield* Effect.flip(client.post("https://example.test/write"))
      expect(failure).toMatchObject({ _tag: "HttpClientError", reason: { _tag: "TransportError" } })
      expect(denial(failure)).toMatchObject({
        code: "permission_denied",
        capability: { action: "net:post", resource: "example.test" },
        reason: "denied by test"
      })
      expect(checks).toEqual([{ action: "net:post", resource: "example.test" }])
      expect(calls).toEqual([])
    }).pipe((effect) => protectedClient(effect, host(calls), store(checks, false)))
  })

  itEffect("rechecks a redirect target, because the guard sits under the redirect loop", () => {
    const checks: Array<Capability.Capability> = []
    const calls: Array<string> = []
    return Effect.gen(function*() {
      const client = yield* EffectHttpClient.HttpClient
      yield* client.get("https://first.test/start")
      expect(checks).toEqual([
        { action: "net:get", resource: "first.test" },
        { action: "net:get", resource: "second.test" }
      ])
      expect(calls).toEqual(["https://first.test/start", "https://second.test/next"])
    }).pipe((effect) => protectedClient(effect, redirecting(calls), store(checks)))
  })

  itEffect("returns the first redirect to an explicitly manual caller while preserving fetch options", () => {
    const checks: Array<Capability.Capability> = []
    const calls: Array<string> = []
    const options: Array<RequestInit | undefined> = []
    const raw = EffectHttpClient.make((request) =>
      Effect.context<never>().pipe(Effect.map((context) => {
        calls.push(request.url)
        options.push(Context.getOrUndefined(context, FetchHttpClient.RequestInit))
        return (request.url.includes("first")
          ? { status: 302, headers: { location: "https://second.test/next" }, request }
          : { status: 200, headers: {}, request }) as HttpClientResponse.HttpClientResponse
      }))
    )
    return Effect.gen(function*() {
      const client = yield* EffectHttpClient.HttpClient
      const first = yield* client.get("https://first.test/start").pipe(
        Effect.provideService(FetchHttpClient.RequestInit, {
          redirect: "manual",
          credentials: "omit",
          cache: "no-store"
        })
      )
      expect(first.status).toBe(302)
      expect(first.request.url).toBe("https://first.test/start")
      expect(calls).toEqual(["https://first.test/start"])
      expect(checks).toEqual([{ action: "net:get", resource: "first.test" }])
      expect(options).toEqual([{ redirect: "manual", credentials: "omit", cache: "no-store" }])
      const second = yield* client.get("https://first.test/start")
      expect(second.status).toBe(200)
      expect(second.request.url).toBe("https://second.test/next")
      expect(calls).toEqual([
        "https://first.test/start",
        "https://first.test/start",
        "https://second.test/next"
      ])
      expect(checks).toEqual([
        { action: "net:get", resource: "first.test" },
        { action: "net:get", resource: "first.test" },
        { action: "net:get", resource: "second.test" }
      ])
    }).pipe((effect) => protectedClient(effect, raw, store(checks)))
  })

  itEffect("checks an explicitly manual next request instead of inheriting the previous hop's grant", () => {
    const checks: Array<Capability.Capability> = []
    const calls: Array<string> = []
    return Effect.gen(function*() {
      const client = yield* EffectHttpClient.HttpClient
      const first = yield* client.get("https://first.test/start").pipe(
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" })
      )
      expect(first.status).toBe(302)
      const failure = yield* Effect.flip(
        client.get("https://second.test/next").pipe(
          Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" })
        )
      )
      expect(denial(failure)).toMatchObject({
        code: "permission_denied",
        capability: { action: "net:get", resource: "second.test" }
      })
      expect(checks.map((capability) => capability.resource)).toEqual(["first.test", "second.test"])
      expect(calls).toEqual(["https://first.test/start"])
    }).pipe((effect) =>
      protectedClient(
        effect,
        redirecting(calls),
        GrantStore.of({
          policy: closedPolicy,
          check: (capability) => {
            checks.push(capability)
            return capability.resource === "first.test"
              ? Effect.void
              : Effect.fail(new PermissionDenied({ code: "permission_denied", capability, reason: "denied by test" }))
          },
          reply: () => Effect.die("unused"),
          list: Effect.succeed([]),
          grantEnvelope: () => Effect.void
        })
      )
    )
  })

  itEffect("denies a redirect to an unauthorized host after allowing the first hop", () => {
    const calls: Array<string> = []
    const checks: Array<Capability.Capability> = []
    const onlyFirst = GrantStore.of({
      policy: closedPolicy,
      check: (capability) => {
        checks.push(capability)
        return capability.resource === "first.test"
          ? Effect.void
          : Effect.fail(new PermissionDenied({ code: "permission_denied", capability, reason: "off-limits host" }))
      },
      reply: () => Effect.die("not used by HTTP decorator tests"),
      list: Effect.succeed([]),
      grantEnvelope: () => Effect.void
    })
    return Effect.gen(function*() {
      const client = yield* EffectHttpClient.HttpClient
      const failure = yield* Effect.flip(client.get("https://first.test/start"))
      expect(denial(failure)).toMatchObject({
        capability: { action: "net:get", resource: "second.test" },
        reason: "off-limits host"
      })
      expect(checks.map((capability) => capability.resource)).toEqual(["first.test", "second.test"])
      // The second hop never left the host: only the authorized URL was fetched.
      expect(calls).toEqual(["https://first.test/start"])
    }).pipe((effect) => protectedClient(effect, redirecting(calls), onlyFirst))
  })

  it("recovers foreign permission data without promising a yieldable error", () => {
    const cause = { _tag: "@smthrs/capability/GrantStoreError", code: "store_closed" }
    const failure = new HttpClientErrorModule.HttpClientError({
      reason: new HttpClientErrorModule.TransportError({
        request: HttpClientRequest.get("https://example.test"),
        cause
      })
    })
    const recovered = Option.getOrThrow(HttpClient.fromHttpClientError(failure))
    expect(recovered).toBe(cause)
    // @ts-expect-error HTTP recovery establishes data fields, not an Effect error instance.
    const instance: PermissionError = recovered
    void instance
    let calls = 0
    Object.defineProperty(cause, "message", {
      get() {
        calls++
        throw new Error("untrusted getter")
      }
    })
    expect(HttpClient.fromHttpClientError(failure)).toEqual(Option.none())
    expect(calls).toBe(0)
  })

  itEffect("leaves a native transport failure untouched", () => {
    const checks: Array<Capability.Capability> = []
    const failing = EffectHttpClient.make((request) =>
      Effect.fail(
        new HttpClientErrorModule.HttpClientError({
          reason: new HttpClientErrorModule.TransportError({ request, cause: new Error("socket reset") })
        })
      )
    )
    return Effect.gen(function*() {
      const client = yield* EffectHttpClient.HttpClient
      const failure = yield* Effect.flip(client.get("https://example.test/health"))
      expect(failure).toMatchObject({ _tag: "HttpClientError", reason: { _tag: "TransportError" } })
      expect(HttpClient.fromHttpClientError(failure)).toEqual(Option.none())
      expect(String(failure.reason.cause)).toContain("socket reset")
    }).pipe((effect) => protectedClient(effect, failing, store(checks)))
  })

  itEffect("stays interruptible through the guard", () => {
    const checks: Array<Capability.Capability> = []
    const never = EffectHttpClient.make(() => Effect.never)
    return Effect.gen(function*() {
      const client = yield* EffectHttpClient.HttpClient
      const fiber = yield* Effect.forkChild(client.get("https://example.test/slow"), { startImmediately: true })
      yield* Effect.yieldNow
      yield* Fiber.interrupt(fiber)
      expect(checks).toEqual([{ action: "net:get", resource: "example.test" }])
    }).pipe((effect) => protectedClient(effect, never, store(checks)))
  })

  itEffect("snapshots every supported request body, URL parameter, and hash representation", () => {
    const checks: Array<Capability.Capability> = []
    const seen: Array<HttpClientRequest.HttpClientRequest> = []
    const raw = EffectHttpClient.make((request) =>
      Effect.sync(() => {
        seen.push(request)
        return { status: 204, headers: {}, request } as HttpClientResponse.HttpClientResponse
      })
    )
    const bytes = new Uint8Array([1, 2, 3])
    const buffer = new Uint8Array([4, 5, 6]).buffer
    const params = new URLSearchParams({ mode: "safe" })
    const blob = new Blob(["safe"])
    const form = new FormData()
    form.append("mode", "safe")
    const bodies: ReadonlyArray<HttpBody.HttpBody> = [
      HttpBody.raw(bytes),
      HttpBody.raw(buffer),
      HttpBody.raw(params),
      HttpBody.raw(blob),
      HttpBody.raw(null),
      HttpBody.raw("text"),
      HttpBody.raw(7),
      HttpBody.raw(true),
      HttpBody.uint8Array(bytes, "application/octet-stream"),
      HttpBody.formData(form),
      HttpBody.stream(Stream.succeed(bytes), "application/octet-stream", bytes.byteLength)
    ]

    return Effect.gen(function*() {
      const client = yield* EffectHttpClient.HttpClient
      yield* Effect.forEach(
        bodies,
        (body, index) =>
          client.execute(
            HttpClientRequest.post(`https://example.test/body-${index}`).pipe(
              HttpClientRequest.setUrlParam("query", "safe"),
              HttpClientRequest.setHash("section"),
              HttpClientRequest.setBody(body)
            )
          ),
        { discard: true }
      )

      expect(seen).toHaveLength(bodies.length)
      expect(seen.map((request) => request.body._tag)).toEqual([
        "Raw",
        "Raw",
        "Raw",
        "Raw",
        "Raw",
        "Raw",
        "Raw",
        "Raw",
        "Uint8Array",
        "FormData",
        "Stream"
      ])
      expect((seen[0]!.body as HttpBody.Raw).body).not.toBe(bytes)
      expect((seen[1]!.body as HttpBody.Raw).body).not.toBe(buffer)
      expect((seen[2]!.body as HttpBody.Raw).body).not.toBe(params)
      expect((seen[3]!.body as HttpBody.Raw).body).toBe(blob)
      expect((seen[8]!.body as HttpBody.Uint8Array).body).not.toBe(bytes)
      expect((seen[9]!.body as HttpBody.FormData).formData).not.toBe(form)
      expect(seen[0]!.urlParams.params).toEqual([["query", "safe"]])
      expect(Option.getOrThrow(seen[0]!.hash)).toBe("section")
      expect(checks).toHaveLength(bodies.length)
    }).pipe((effect) => protectedClient(effect, raw, store(checks)))
  })

  itEffect("rejects unsupported raw request bodies before checking or sending", () => {
    const checks: Array<Capability.Capability> = []
    const calls: Array<string> = []
    const unsupported = [{}, undefined, Symbol("body"), 1n, () => "body"]
    return Effect.gen(function*() {
      const client = yield* EffectHttpClient.HttpClient
      for (const value of unsupported) {
        const failure = yield* Effect.flip(
          client.execute(
            HttpClientRequest.post("https://example.test/body").pipe(
              HttpClientRequest.setBody(HttpBody.raw(value))
            )
          )
        )
        expect(failure).toMatchObject({
          _tag: "HttpClientError",
          reason: {
            _tag: "TransportError",
            description: "HTTP request must be an immutable supported request description"
          }
        })
      }
      expect(checks).toEqual([])
      expect(calls).toEqual([])
    }).pipe((effect) => protectedClient(effect, host(calls), store(checks)))
  })

  itEffect("answers the stub with an unavailable-host transport failure", () =>
    Effect.gen(function*() {
      const client = yield* EffectHttpClient.HttpClient
      const failure = yield* Effect.flip(client.get("https://example.test/path"))
      expect(String(failure.reason.cause)).toContain("HTTP is unavailable on this host")
    }).pipe(Effect.provide(HttpClient.layerNoop())))

  it("re-exports Effect's own tag rather than declaring a second one", () => {
    expect(HttpClient.HttpClient).toBe(EffectHttpClient.HttpClient)
    expect(HttpClient.make).toBe(EffectHttpClient.make)
  })
})
