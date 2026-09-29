import { CapabilityPattern, make as makeCapability } from "@smthrs/capability/Capability"
import { PermissionRequired, Rule } from "@smthrs/capability/Permission"
import { Effect, Fiber, Layer, Option } from "effect"
import * as EffectHttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import { describe, expect, it } from "vitest"
import { attenuate } from "../src/CapabilitySet.ts"
import * as GrantStore from "../src/GrantStore.ts"
import * as HttpClient from "../src/HttpClient.ts"
import * as Workspace from "../src/Workspace.ts"

const recordingStore = () => {
  const checked: Array<string> = []
  const service = GrantStore.GrantStore.of({
    check: (capability) =>
      Effect.sync(() => {
        checked.push(`${capability.action}:${capability.resource}`)
      }),
    reply: () => Effect.die("unused"),
    list: Effect.succeed([]),
    grantEnvelope: () => Effect.die("unused")
  })
  return { checked, service }
}

const raw = () => {
  const sent: Array<string> = []
  const client = EffectHttpClient.make((request) =>
    Effect.sync(() => {
      sent.push(request.url)
      return HttpClientResponse.fromWeb(request, new Response("ok"))
    })
  )
  return { client, sent }
}

const guardedLayer = (rawClient: EffectHttpClient.HttpClient, store: GrantStore.Service) =>
  HttpClient.layer.pipe(
    Layer.provide(Layer.succeed(EffectHttpClient.HttpClient)(rawClient)),
    Layer.provide(Layer.succeed(GrantStore.GrantStore)(store))
  )

const awaitPending = (store: GrantStore.Service): Effect.Effect<GrantStore.PendingRequest> =>
  Effect.suspend(() =>
    Effect.flatMap(
      store.list,
      (pending) =>
        pending[0] === undefined
          ? Effect.yieldNow.pipe(Effect.andThen(awaitPending(store)))
          : Effect.succeed(pending[0])
    )
  )

describe("HTTP preflight admission", () => {
  it("refuses preflight before running network work and preserves the permission failure", async () => {
    const request = HttpClientRequest.get("https://api.test/path")
    let ran = false
    const failure = await Effect.runPromise(
      HttpClient.authorizePreflight(
        request,
        Effect.sync(() => {
          ran = true
        })
      ).pipe(
        Effect.flip,
        Effect.provide(GrantStore.layer({ attended: false, rules: [] })),
        Effect.provide(Workspace.layer("/workspace"))
      )
    )
    expect(ran).toBe(false)
    expect(Option.getOrThrow(HttpClient.fromHttpClientError(failure))).toMatchObject({
      code: "permission_required",
      capability: { action: "net:get", resource: "api.test" }
    })
  })

  it("does not turn a wildcard ceiling and wildcard configured grant into private authority", async () => {
    const failure = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const store = yield* GrantStore.make({
        attended: false,
        rules: [
          new Rule({
            effect: "allow",
            pattern: new CapabilityPattern({ action: "*", resource: "**" })
          })
        ]
      }).pipe(Effect.provide(Workspace.layer("/workspace")))
      return yield* store.check(makeCapability("net:private", "http://127.0.0.1:8080")).pipe(
        attenuate([new CapabilityPattern({ action: "net:*", resource: "*" })]),
        Effect.flip
      )
    })))
    expect(failure).toBeInstanceOf(PermissionRequired)
  })

  it("checks a request once before preflight and consumes that admission at the kernel transport", async () => {
    const store = recordingStore()
    const host = raw()
    const request = HttpClientRequest.get("https://api.test/path")
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const client = yield* EffectHttpClient.HttpClient
        return yield* HttpClient.authorizePreflight(request, client.execute(request))
      }).pipe(
        Effect.provide(guardedLayer(host.client, store.service)),
        Effect.provideService(GrantStore.GrantStore, store.service)
      )
    )
    expect(result.status).toBe(200)
    expect(store.checked).toEqual(["net:get:api.test"])
    expect(host.sent).toEqual(["https://api.test/path"])
  })

  it("spends an admission on only the first matching dispatch", async () => {
    const store = recordingStore()
    const host = raw()
    const request = HttpClientRequest.get("https://api.test/path")
    await Effect.runPromise(
      Effect.gen(function*() {
        const client = yield* EffectHttpClient.HttpClient
        yield* HttpClient.authorizePreflight(
          request,
          Effect.gen(function*() {
            yield* client.execute(request)
            yield* client.execute(request)
          })
        )
      }).pipe(
        Effect.provide(guardedLayer(host.client, store.service)),
        Effect.provideService(GrantStore.GrantStore, store.service)
      )
    )
    expect(store.checked).toEqual(["net:get:api.test", "net:get:api.test"])
    expect(host.sent).toHaveLength(2)
  })

  it("uses a real once grant for preflight and its first kernel dispatch", async () => {
    const host = raw()
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const store = yield* GrantStore.make({ runId: "preflight-once" }).pipe(
        Effect.provide(Workspace.layer("/workspace"))
      )
      const request = HttpClientRequest.get("https://api.test/path")
      yield* Effect.gen(function*() {
        const client = yield* EffectHttpClient.HttpClient
        const first = yield* HttpClient.authorizePreflight(request, client.execute(request)).pipe(
          Effect.provideService(GrantStore.GrantStore, store),
          Effect.forkChild({ startImmediately: true })
        )
        const pending = yield* awaitPending(store)
        expect(pending.capability).toMatchObject({ action: "net:get", resource: "api.test" })
        yield* store.reply(pending.requestId, "once")
        expect((yield* Fiber.join(first)).status).toBe(200)
        expect(host.sent).toEqual(["https://api.test/path"])

        const second = yield* client.execute(request).pipe(Effect.forkChild({ startImmediately: true }))
        const again = yield* awaitPending(store)
        expect(again.capability).toMatchObject({ action: "net:get", resource: "api.test" })
        expect(again.requestId).not.toBe(pending.requestId)
        expect(host.sent).toHaveLength(1)
        yield* Fiber.interrupt(second)
      }).pipe(Effect.provide(guardedLayer(host.client, store)))
    })))
  })

  it("does not let an admission from another store bypass the kernel store", async () => {
    const kernel = recordingStore()
    const preflight = recordingStore()
    const host = raw()
    const request = HttpClientRequest.get("https://api.test/path")
    await Effect.runPromise(
      Effect.gen(function*() {
        const client = yield* EffectHttpClient.HttpClient
        return yield* HttpClient.authorizePreflight(request, client.execute(request)).pipe(
          Effect.provideService(GrantStore.GrantStore, preflight.service)
        )
      }).pipe(Effect.provide(guardedLayer(host.client, kernel.service)))
    )
    expect(preflight.checked).toEqual(["net:get:api.test"])
    expect(kernel.checked).toEqual(["net:get:api.test"])
    expect(host.sent).toHaveLength(1)
  })

  it("does not let an admission for one capability authorize another destination", async () => {
    const store = recordingStore()
    const host = raw()
    const admitted = HttpClientRequest.get("https://first.test/path")
    const different = HttpClientRequest.get("https://second.test/path")
    await Effect.runPromise(
      Effect.gen(function*() {
        const client = yield* EffectHttpClient.HttpClient
        return yield* HttpClient.authorizePreflight(admitted, client.execute(different))
      }).pipe(
        Effect.provide(guardedLayer(host.client, store.service)),
        Effect.provideService(GrantStore.GrantStore, store.service)
      )
    )
    expect(store.checked).toEqual(["net:get:first.test", "net:get:second.test"])
    expect(host.sent).toEqual(["https://second.test/path"])
  })
})

describe("HTTP destination pinning", () => {
  it("starts without a destination and preserves pinning only for the trusted transport", async () => {
    const destination = Effect.runSync(
      Effect.withFiber((fiber) => Effect.succeed(fiber.getRef(HttpClient.Destination)))
    )
    expect(destination).toBeUndefined()
    const trusted = raw().client
    const other = raw().client
    expect(HttpClient.supportsDestinationPinning(trusted)).toBe(false)
    expect(HttpClient.withDestinationPinning(trusted)).toBe(trusted)
    expect(HttpClient.supportsDestinationPinning(trusted)).toBe(true)
    expect(HttpClient.supportsDestinationPinning(other)).toBe(false)
    const isGuardedPinned = (client: EffectHttpClient.HttpClient) =>
      Effect.runPromise(
        Effect.gen(function*() {
          return HttpClient.supportsDestinationPinning(yield* EffectHttpClient.HttpClient)
        }).pipe(Effect.provide(guardedLayer(client, recordingStore().service)))
      )
    expect(await isGuardedPinned(trusted)).toBe(true)
    expect(await isGuardedPinned(other)).toBe(false)
  })
})
