import { describe, expect, it } from "@effect/vitest"
import { Capability } from "@smthrs/capability/Capability"
import { Effect } from "effect"
import { GrantStore } from "../src/GrantStore.ts"
import * as TestGrantStore from "../src/test/TestGrantStore.ts"

const read = new Capability({ action: "fs:read", resource: "/workspace/readme.md" })

const itEffect = <A, E>(name: string, body: () => Effect.Effect<A, E>): void => {
  it.effect(name, () => body())
}

describe("TestGrantStore", () => {
  itEffect("provides the allow-all test contract", () =>
    Effect.gen(function*() {
      const store = yield* GrantStore
      yield* store.check(read)
      yield* store.reply("unused", "remembered")
      yield* store.grantEnvelope({ planDigest: "", patterns: [] })
      expect(yield* store.list).toEqual([])
      expect((yield* store.rules("fs:read")).map((rule) => rule.pattern.resource)).toEqual(["**"])
    }).pipe(Effect.provide(TestGrantStore.layerAllow)))

  itEffect("holds no rules in force under the deny and scripted contracts", () =>
    Effect.gen(function*() {
      const denied = yield* Effect.flatMap(GrantStore, (store) => store.rules("fs:write")).pipe(
        Effect.provide(TestGrantStore.layerDeny())
      )
      const scripted = yield* Effect.flatMap(GrantStore, (store) => store.rules("fs:write")).pipe(
        Effect.provide(TestGrantStore.layerScripted(["once"]))
      )
      expect(denied).toEqual([])
      expect(scripted).toEqual([])
    }))

  itEffect("provides default and customized deny contracts", () =>
    Effect.gen(function*() {
      const defaultFailure = yield* Effect.flip(
        Effect.flatMap(GrantStore, (store) => store.check(read)).pipe(
          Effect.provide(TestGrantStore.layerDeny())
        )
      )
      expect(defaultFailure).toMatchObject({
        code: "permission_denied",
        capability: read,
        reason: "denied by test"
      })

      const result = yield* Effect.gen(function*() {
        const store = yield* GrantStore
        const denied = yield* Effect.flip(store.check(read))
        const unknown = yield* Effect.flip(store.reply("permission-1", "deny"))
        yield* store.grantEnvelope({ planDigest: "plan", patterns: [] })
        return { denied, unknown, pending: yield* store.list }
      }).pipe(Effect.provide(TestGrantStore.layerDeny("custom denial")))

      expect(result.denied).toMatchObject({ code: "permission_denied", reason: "custom denial" })
      expect(result.unknown).toMatchObject({ code: "request_not_found" })
      expect(result.pending).toEqual([])
    }))

  itEffect("consumes every scripted resolution and fails closed after exhaustion", () =>
    Effect.gen(function*() {
      const store = yield* GrantStore
      yield* store.check(read)
      yield* store.check(read)
      yield* store.check(read)

      expect(yield* Effect.flip(store.check(read))).toMatchObject({
        code: "permission_denied",
        reason: "permission request denied"
      })
      expect(yield* Effect.flip(store.check(read))).toMatchObject({
        code: "permission_denied",
        reason: "permission reply script exhausted"
      })
      expect(yield* Effect.flip(store.reply("permission-1", "once"))).toMatchObject({
        code: "request_not_found"
      })
      yield* store.grantEnvelope({ planDigest: "plan", patterns: [] })
      expect(yield* store.list).toEqual([])
    }).pipe(
      Effect.provide(TestGrantStore.layerScripted(["once", "run", "remembered", "deny"]))
    ))
})
