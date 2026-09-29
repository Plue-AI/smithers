import { describe, expect, it } from "@effect/vitest"
import type * as Capability from "@smthrs/capability/Capability"
import { PermissionDenied } from "@smthrs/capability/Permission"
import { Effect, Option } from "effect"
import * as EffectHttpClient from "effect/unstable/http/HttpClient"
import type * as EffectHttpClientError from "effect/unstable/http/HttpClientError"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import { GrantStore } from "../src/GrantStore.ts"
import * as HttpClient from "../src/HttpClient.ts"

/**
 * A request whose URL cannot be parsed has no host, so there is no honest
 * capability resource to ask about. The kernel fails closed — but the denial it
 * reports still has to name the action the caller attempted, otherwise the
 * audit record and the operator's error message describe the wrong effect tier.
 *
 * Effect owns the tag, so the denial rides in `HttpClientError`; the structured
 * failure is recovered from it with `HttpClient.fromHttpClientError`, exactly
 * the way `Permission.fromPlatformError` recovers a filesystem denial.
 */

const itEffect = <E>(name: string, effect: () => Effect.Effect<void, E>) => it.effect(name, () => effect())

const store = (checks: Array<Capability.Capability>) =>
  GrantStore.of({
    check: (capability) => {
      checks.push(capability)
      return Effect.void
    },
    reply: () => Effect.die("not used by HTTP decorator tests"),
    list: Effect.succeed([]),
    rules: () => Effect.succeed([]),
    grantEnvelope: () => Effect.void
  })

const provide = <A, E>(
  effect: Effect.Effect<A, E, EffectHttpClient.HttpClient>,
  calls: Array<string>,
  checks: Array<Capability.Capability>
) =>
  effect.pipe(
    Effect.provide(HttpClient.layer),
    Effect.provideService(
      EffectHttpClient.HttpClient,
      EffectHttpClient.make((request) =>
        Effect.sync(() => {
          calls.push(request.url)
          return { status: 200, headers: {}, request } as never
        })
      )
    ),
    Effect.provideService(GrantStore, store(checks))
  )

const unparsable = "not a url"

const denial = (failure: EffectHttpClientError.HttpClientError) =>
  Option.getOrThrow(HttpClient.fromHttpClientError(failure))

const expectUnavailable = (
  failure: EffectHttpClientError.HttpClientError,
  method: string,
  url: string
): void => {
  expect(failure).toMatchObject({
    _tag: "HttpClientError",
    reason: {
      _tag: "TransportError",
      request: { method, url }
    }
  })
  expect(String(failure.reason.cause)).toContain("HTTP is unavailable on this host")
}

describe("HttpClient unparsable URLs", () => {
  itEffect("names net:get for a rejected GET", () => {
    const calls: Array<string> = []
    const checks: Array<Capability.Capability> = []
    return provide(
      Effect.gen(function*() {
        const client = yield* EffectHttpClient.HttpClient
        const failure = yield* Effect.flip(client.execute(HttpClientRequest.get(unparsable)))
        expect(denial(failure)).toBeInstanceOf(PermissionDenied)
        expect(denial(failure)).toMatchObject({
          capability: { action: "net:get", resource: unparsable },
          reason: "HTTP capability checks require an absolute, parseable URL"
        })
        expect(checks).toEqual([])
        expect(calls).toEqual([])
      }),
      calls,
      checks
    )
  })

  itEffect("names net:get for a rejected HEAD", () => {
    const calls: Array<string> = []
    const checks: Array<Capability.Capability> = []
    return provide(
      Effect.gen(function*() {
        const client = yield* EffectHttpClient.HttpClient
        const failure = yield* Effect.flip(client.head(unparsable))
        expect(denial(failure)).toMatchObject({ capability: { action: "net:get" } })
      }),
      calls,
      checks
    )
  })

  itEffect("names net:post for a rejected write method", () => {
    const calls: Array<string> = []
    const checks: Array<Capability.Capability> = []
    return provide(
      Effect.gen(function*() {
        const client = yield* EffectHttpClient.HttpClient
        const failure = yield* Effect.flip(client.execute(HttpClientRequest.make("DELETE")(unparsable)))
        expect(denial(failure)).toMatchObject({ capability: { action: "net:post", resource: unparsable } })
        expect(calls).toEqual([])
      }),
      calls,
      checks
    )
  })

  itEffect("names model:call for a rejected model request regardless of method", () => {
    const calls: Array<string> = []
    const checks: Array<Capability.Capability> = []
    return provide(
      Effect.gen(function*() {
        const client = yield* EffectHttpClient.HttpClient
        const failure = yield* Effect.flip(
          client.execute(HttpClientRequest.get(unparsable)).pipe(HttpClient.withModelCall("anthropic/claude"))
        )
        expect(denial(failure)).toMatchObject({ capability: { action: "model:call", resource: unparsable } })
        expect(checks).toEqual([])
        expect(calls).toEqual([])
      }),
      calls,
      checks
    )
  })
})

describe("HttpClient stub layer", () => {
  itEffect("provides an unavailable client", () =>
    Effect.gen(function*() {
      const client = yield* EffectHttpClient.HttpClient
      expectUnavailable(
        yield* Effect.flip(client.get("https://example.test")),
        "GET",
        "https://example.test"
      )
    }).pipe(Effect.provide(HttpClient.layerNoop())))

  it("builds a stub client directly", () => {
    expect(EffectHttpClient.isHttpClient(HttpClient.makeNoop())).toBe(true)
  })
})

// Redirect coverage lives in HttpClient.test.ts and HttpClient.integration.test.ts,
// which drive a real Location hop. This block only pins that two independent
// requests produce two independent checks, so it is named for what it proves.
describe("HttpClient per-request checks", () => {
  itEffect("re-checks each request against the kernel", () => {
    const calls: Array<string> = []
    const checks: Array<Capability.Capability> = []
    return Effect.gen(function*() {
      const client = yield* EffectHttpClient.HttpClient
      yield* client.get("https://first.test/a")
      yield* client.get("https://second.test/b")
      expect(checks.map((check) => check.resource)).toEqual(["first.test", "second.test"])
      expect(calls).toEqual(["https://first.test/a", "https://second.test/b"])
    }).pipe((effect) => provide(effect, calls, checks))
  })
})
