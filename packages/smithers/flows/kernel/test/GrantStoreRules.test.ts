/**
 * `GrantStore.rules`: the rules in force for one action, as a confinement
 * derives its profile from them. Every case is checked against what `check`
 * itself would answer for the rule's own resource, because that agreement is
 * the whole contract: a profile must never open what a check would refuse,
 * and never close what a check would allow without asking.
 */
import { describe, expect, it } from "@effect/vitest"
import { Capability, CapabilityPattern } from "@smthrs/capability/Capability"
import { Rule } from "@smthrs/capability/Permission"
import { Effect, Exit, Scope } from "effect"
import { attenuate } from "../src/CapabilitySet.ts"
import { make as makeGrantStore, makeNoop, type MakeOptions } from "../src/GrantStore.ts"
import * as Workspace from "../src/Workspace.ts"

const make = (options?: MakeOptions) => makeGrantStore(options).pipe(Effect.provide(Workspace.layer("/workspace")))

const rule = (effect: "allow" | "deny", action: CapabilityPattern["action"], resource: string) =>
  new Rule({ effect, pattern: new CapabilityPattern({ action, resource }) })

const shape = (rules: ReadonlyArray<Rule>) =>
  rules.map((rule) => [rule.effect, rule.pattern.action, rule.pattern.resource])

describe("GrantStore.rules", () => {
  it.effect("lists configured allows and denies for the action, and nothing for another", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const store = yield* make({
          rules: [
            rule("allow", "fs:write", "/workspace/src/**"),
            rule("deny", "fs:write", "/workspace/src/secret/**"),
            rule("allow", "proc:spawn", "git status")
          ]
        })
        expect(shape(yield* store.rules("fs:write"))).toEqual([
          ["allow", "fs:write", "/workspace/src/**"],
          ["deny", "fs:write", "/workspace/src/secret/**"]
        ])
        expect(yield* store.rules("fs:read")).toEqual([])
        expect(yield* store.rules("net:get")).toEqual([])
        // The deny is what a check of its own resource answers.
        const secret = new Capability({ action: "fs:write", resource: "/workspace/src/secret/key" })
        expect((yield* Effect.flip(store.check(secret))).code).toBe("permission_denied")
      })
    ))

  it.effect("re-spells a wildcard action as the action asked for", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const store = yield* make({
          rules: [rule("allow", "*", "**"), rule("allow", "fs:*", "/workspace/docs/**")]
        })
        expect(shape(yield* store.rules("fs:read"))).toEqual([
          ["allow", "fs:read", "**"],
          ["allow", "fs:read", "/workspace/docs/**"]
        ])
        expect(shape(yield* store.rules("net:post"))).toEqual([["allow", "net:post", "**"]])
      })
    ))

  it.effect("leaves out an allow a later deny masks", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const store = yield* make({
          rules: [[rule("allow", "fs:write", "/workspace/**")], [rule("deny", "fs:write", "/workspace/**")]]
        })
        expect(shape(yield* store.rules("fs:write"))).toEqual([["deny", "fs:write", "/workspace/**"]])
        const file = new Capability({ action: "fs:write", resource: "/workspace/file" })
        expect((yield* Effect.flip(store.check(file))).code).toBe("permission_denied")
      })
    ))

  it.effect("lists a rule granted twice once", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const store = yield* make({
          rules: [[rule("allow", "fs:write", "/workspace/**")], [rule("allow", "fs:write", "/workspace/**")]]
        })
        expect(shape(yield* store.rules("fs:write"))).toEqual([["allow", "fs:write", "/workspace/**"]])
      })
    ))

  it.effect("leaves out an allow the capability ceiling excludes", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const store = yield* make({ rules: [rule("allow", "fs:write", "/workspace/**")] })
        const narrowed = attenuate([new CapabilityPattern({ action: "fs:read", resource: "**" })])
        expect(yield* store.rules("fs:write").pipe(narrowed)).toEqual([])
        expect(shape(yield* store.rules("fs:write"))).toEqual([["allow", "fs:write", "/workspace/**"]])
        // A deny stays in force under a ceiling that excludes it: the answer is deny either way.
        const denying = yield* make({ rules: [rule("deny", "fs:write", "/workspace/out/**")] })
        expect(shape(yield* denying.rules("fs:write").pipe(narrowed))).toEqual([
          ["deny", "fs:write", "/workspace/out/**"]
        ])
      })
    ))

  it.effect("applies a run rule only inside its captured ceiling", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const inside = new CapabilityPattern({ action: "fs:write", resource: "/workspace/**" })
        const store = yield* make({
          attended: false,
          runId: "run-1",
          planDigest: "plan-1",
          runRules: [
            { rule: rule("allow", "fs:write", "/workspace/a/**"), ceiling: [[inside]] },
            {
              rule: rule("allow", "fs:write", "/workspace/b/**"),
              ceiling: [[new CapabilityPattern({ action: "fs:read", resource: "/workspace/**" })]]
            }
          ]
        })
        expect(shape(yield* store.rules("fs:write"))).toEqual([["allow", "fs:write", "/workspace/a/**"]])
        yield* store.check(new Capability({ action: "fs:write", resource: "/workspace/a/x" }))
        expect(
          (yield* Effect.flip(store.check(new Capability({ action: "fs:write", resource: "/workspace/b/x" })))).code
        )
          .toBe("permission_required")
      })
    ))

  it.effect("lists envelope and remembered grants once they are in force", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const store = yield* make({
          runId: "run-1",
          planDigest: "plan-1",
          envelope: {
            planDigest: "plan-1",
            patterns: [new CapabilityPattern({ action: "net:get", resource: "https://example.com/**" })]
          }
        })
        expect(shape(yield* store.rules("net:get"))).toEqual([["allow", "net:get", "https://example.com/**"]])
        expect(yield* store.rules("net:private")).toEqual([])
        yield* store.grantEnvelope({
          planDigest: "plan-1",
          scope: "remembered",
          patterns: [new CapabilityPattern({ action: "fs:read", resource: "/workspace/**" })]
        })
        expect(shape(yield* store.rules("fs:read"))).toEqual([["allow", "fs:read", "/workspace/**"]])
      })
    ))

  it.effect("never grants private network access through a wider network allow", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const store = yield* make({ rules: [rule("allow", "net:*", "**")] })
        expect(shape(yield* store.rules("net:get"))).toEqual([["allow", "net:get", "**"]])
        expect(yield* store.rules("net:private")).toEqual([])
      })
    ))

  it.effect("skips a rule whose resource no capability of the action can spell", () =>
    Effect.scoped(
      Effect.gen(function*() {
        // An absolute filesystem resource with a dot segment has no canonical
        // form, so it matches nothing, its own text included.
        const store = yield* make({ rules: [rule("allow", "fs:write", "/workspace/../escape/**")] })
        expect(yield* store.rules("fs:write")).toEqual([])
      })
    ))

  it.effect("answers one allow-everything rule per action from the allow-all store", () =>
    Effect.gen(function*() {
      expect(shape(yield* makeNoop.rules("fs:write"))).toEqual([["allow", "fs:write", "**"]])
      expect(shape(yield* makeNoop.rules("net:private"))).toEqual([["allow", "net:private", "**"]])
    }))

  it.effect("fails once the store is closed", () =>
    Effect.gen(function*() {
      const scope = yield* Scope.make()
      const store = yield* make({ rules: [rule("allow", "fs:write", "/workspace/**")] }).pipe(Scope.provide(scope))
      yield* Scope.close(scope, Exit.void)
      expect((yield* Effect.flip(store.rules("fs:write"))).code).toBe("store_closed")
    }))
})
