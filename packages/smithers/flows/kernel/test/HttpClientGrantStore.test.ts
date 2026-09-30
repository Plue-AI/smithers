import { describe, expect, it } from "@effect/vitest"
import { PermissionRequired } from "@smthrs/capability/Permission"
import { Deferred, Effect, Fiber, Option } from "effect"
import * as EffectHttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import { emptyPolicy as closedPolicy } from "../src/GrantStore.ts"
import * as GrantStore from "../src/GrantStore.ts"
import * as HttpClient from "../src/HttpClient.ts"
import * as Workspace from "../src/Workspace.ts"

const awaitPending = (
  store: GrantStore.Service,
  count: number
): Effect.Effect<ReadonlyArray<GrantStore.PendingRequest>> =>
  Effect.suspend(() =>
    Effect.flatMap(store.list, (pending) =>
      pending.length >= count
        ? Effect.succeed(pending)
        : Effect.yieldNow.pipe(Effect.andThen(awaitPending(store, count))))
  )

const provide = <A, E>(
  effect: Effect.Effect<A, E, EffectHttpClient.HttpClient>,
  raw: EffectHttpClient.HttpClient,
  store: GrantStore.Service
) =>
  effect.pipe(
    Effect.provide(HttpClient.layer),
    Effect.provideService(EffectHttpClient.HttpClient, raw),
    Effect.provideService(GrantStore.GrantStore, store)
  )

const itEffect = <A, E>(name: string, body: () => Effect.Effect<A, E>): void => {
  it.effect(name, () => body())
}

describe("HttpClient with a real GrantStore lifecycle", () => {
  itEffect("carries an unattended PermissionRequired through HttpClientError", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const calls: Array<string> = []
        const raw = EffectHttpClient.make((request) =>
          Effect.sync(() => {
            calls.push(request.url)
            return { status: 200, headers: {}, request } as HttpClientResponse.HttpClientResponse
          })
        )
        const store = yield* GrantStore.make({ attended: false, runId: "run-http" }).pipe(
          Effect.provide(Workspace.layer("/workspace"))
        )
        const failure = yield* provide(
          Effect.gen(function*() {
            const client = yield* EffectHttpClient.HttpClient
            return yield* Effect.flip(client.get("https://api.example.test/data"))
          }),
          raw,
          store
        )
        const permission = Option.getOrThrow(HttpClient.fromHttpClientError(failure))

        expect(permission).toBeInstanceOf(PermissionRequired)
        expect(permission).toMatchObject({
          code: "permission_required",
          requestId: "permission-1",
          runId: "run-http",
          capability: { action: "net:get", resource: "api.example.test" }
        })
        expect(calls).toEqual([])
      })
    ))

  itEffect("replies to the actual attended request before the host sends", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const calls: Array<string> = []
        const raw = EffectHttpClient.make((request) =>
          Effect.sync(() => {
            calls.push(request.url)
            return { status: 204, headers: {}, request } as HttpClientResponse.HttpClientResponse
          })
        )
        const store = yield* GrantStore.make({ runId: "run-http" }).pipe(
          Effect.provide(Workspace.layer("/workspace"))
        )

        yield* provide(
          Effect.gen(function*() {
            const client = yield* EffectHttpClient.HttpClient
            const request = yield* client.get("https://api.example.test/data").pipe(
              Effect.forkChild({ startImmediately: true })
            )
            const [pending] = yield* awaitPending(store, 1)
            expect(pending).toMatchObject({
              capability: { action: "net:get", resource: "api.example.test" }
            })
            expect(calls).toEqual([])

            yield* store.reply(pending!.requestId, "once")
            expect((yield* Fiber.join(request)).status).toBe(204)
            expect(calls).toEqual(["https://api.example.test/data"])
          }),
          raw,
          store
        )
      })
    ))

  itEffect("sends the exact request snapshot approved before an attended wait", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const checks: Array<unknown> = []
        const calls: Array<readonly [string, string, string | undefined]> = []
        const store = GrantStore.GrantStore.of({
          policy: closedPolicy,
          check: (capability) => {
            checks.push(capability)
            return Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
          },
          reply: () => Effect.die("not used by request snapshot test"),
          list: Effect.succeed([]),
          grantEnvelope: () => Effect.void
        })
        const raw = EffectHttpClient.make((request) =>
          Effect.sync(() => {
            calls.push([request.method, request.url, request.headers["x-mode"]])
            return { status: 204, headers: {}, request } as HttpClientResponse.HttpClientResponse
          })
        )
        const source = HttpClientRequest.post("https://safe.example.test/path").pipe(
          HttpClientRequest.setHeader("x-mode", "safe")
        )

        yield* provide(
          Effect.gen(function*() {
            const client = yield* EffectHttpClient.HttpClient
            const running = yield* client.execute(source).pipe(
              Effect.forkChild({ startImmediately: true })
            )
            yield* Deferred.await(entered)
            ;(source as { method: string }).method = "DELETE"
            ;(source as { url: string }).url = "https://unsafe.example.test/other"
            ;(source.headers as Record<string, string>)["x-mode"] = "unsafe"
            yield* Deferred.succeed(release, undefined)
            expect((yield* Fiber.join(running)).status).toBe(204)
          }),
          raw,
          store
        )

        expect(checks).toEqual([{ action: "net:post", resource: "safe.example.test" }])
        expect(calls).toEqual([["POST", "https://safe.example.test/path", "safe"]])
      })
    ))

  itEffect("attends every hop of a redirecting model call with model authority", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const calls: Array<readonly [string, string]> = []
        const raw = EffectHttpClient.make((request) =>
          Effect.sync(() => {
            calls.push([request.method, request.url])
            return (request.url.includes("first.test")
              ? { status: 302, headers: { location: "https://second.test/model" }, request }
              : { status: 200, headers: {}, request }) as HttpClientResponse.HttpClientResponse
          })
        )
        const store = yield* GrantStore.make({ runId: "run-model" }).pipe(
          Effect.provide(Workspace.layer("/workspace"))
        )

        yield* provide(
          Effect.gen(function*() {
            const client = yield* EffectHttpClient.HttpClient
            const request = yield* client.execute(
              HttpClientRequest.post("https://first.test/model")
            ).pipe(
              HttpClient.withModelCall("provider/model"),
              Effect.forkChild({ startImmediately: true })
            )

            const [first] = yield* awaitPending(store, 1)
            expect(first).toMatchObject({
              capability: { action: "model:call", resource: "first.test/provider/model" }
            })
            yield* store.reply(first!.requestId, "once")

            const [second] = yield* awaitPending(store, 1)
            expect(second).toMatchObject({
              capability: { action: "model:call", resource: "second.test/provider/model" }
            })
            yield* store.reply(second!.requestId, "once")

            expect((yield* Fiber.join(request)).status).toBe(200)
            expect(calls).toEqual([
              ["POST", "https://first.test/model"],
              ["GET", "https://second.test/model"]
            ])
          }),
          raw,
          store
        )
      })
    ))
})
