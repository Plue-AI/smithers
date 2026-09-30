import { describe, expect, it } from "@effect/vitest"
import { Capability, CapabilityPattern } from "@smthrs/capability/Capability"
import { Rule } from "@smthrs/capability/Permission"
import { Effect, Fiber, Path } from "effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import * as CapabilitySet from "../src/CapabilitySet.ts"
import * as GrantStore from "../src/GrantStore.ts"
import * as ProcessConfinement from "../src/ProcessConfinement.ts"
import * as Workspace from "../src/Workspace.ts"

const scoped = (name: string, body: () => Effect.Effect<void, unknown, import("effect").Scope.Scope>) =>
  it.effect(name, () => Effect.scoped(body()))
const pattern = (action: CapabilityPattern["action"], resource: string) => new CapabilityPattern({ action, resource })
const rule = (action: CapabilityPattern["action"], resource: string, effect: "allow" | "deny" | "ask" = "allow") =>
  new Rule({ effect, pattern: pattern(action, resource) })
const resolve = (options: GrantStore.MakeOptions) =>
  Effect.gen(function*() {
    const grants = yield* GrantStore.make({ attended: false, ...options })
    return yield* ProcessConfinement.profile(grants, "/ws", yield* Path.Path)
  }).pipe(Effect.provide(Workspace.layer("/ws")), Effect.provide(Path.layer))

describe("ProcessConfinement policy projection", () => {
  scoped("does not open directory-root metadata from descendant-only write grants", () =>
    Effect.gen(function*() {
      for (const tree of ["/ws", "/ws/out"]) {
        expect((yield* resolve({ rules: [rule("fs:read", `${tree}/**`), rule("fs:write", `${tree}/**`)] })).writes)
          .toEqual([])
      }
      expect(
        (yield* resolve({
          rules: [rule("fs:read", "/ws/out/**"), rule("fs:write", "/ws/out"), rule("fs:write", "/ws/out/**")]
        })).writes
      ).toEqual(["out"])
    }))
  scoped("configured directory-root refusal vetoes later tree and root envelopes", () =>
    Effect.gen(function*() {
      expect(
        (yield* resolve({
          rules: [rule("fs:read", "/ws/out/**"), rule("fs:write", "/ws/out/**"), rule("fs:write", "/ws/out", "deny")],
          planDigest: "p",
          envelope: { planDigest: "p", patterns: [pattern("fs:write", "/ws/out"), pattern("fs:write", "/ws/out/**")] }
        })).writes
      ).toEqual([])
    }))
  scoped("directory-root writes must also fit the current capability ceiling", () =>
    Effect.gen(function*() {
      const rules = [rule("fs:read", "/ws/out/**"), rule("fs:write", "/ws/out"), rule("fs:write", "/ws/out/**")]
      const treeOnly = [pattern("fs:read", "/ws/out/**"), pattern("fs:write", "/ws/out/**")]
      expect((yield* resolve({ rules }).pipe(CapabilitySet.attenuate(treeOnly))).writes).toEqual([])
      expect(
        (yield* resolve({ rules }).pipe(
          CapabilitySet.attenuate([...treeOnly, pattern("fs:write", "/ws/out")])
        )).writes
      ).toEqual(["out"])
    }))
  scoped("directory-root writes must also fit captured grant ceilings", () =>
    Effect.gen(function*() {
      for (const permitsRoot of [false, true]) {
        const ceiling = [pattern("fs:write", "/ws/out/**"), ...(permitsRoot ? [pattern("fs:write", "/ws/out")] : [])]
        expect(
          (yield* resolve({
            rules: [rule("fs:read", "/ws/out/**")],
            runRules: ["/ws/out", "/ws/out/**"].map((resource) => ({
              rule: rule("fs:write", resource),
              ceiling: [ceiling]
            }))
          })).writes
        ).toEqual(permitsRoot ? ["out"] : [])
      }
    }))
  scoped("never opens writable trees without the read authority an OS mount also grants", () =>
    Effect.gen(function*() {
      for (
        const rules of [
          [rule("fs:write", "/ws/out/**")],
          [rule("fs:write", "/ws/out/**"), rule("fs:read", "/ws/out/**", "deny")],
          [rule("fs:write", "/ws/out/**"), rule("fs:read", "/ws/**"), rule("fs:read", "/ws/out/token", "deny")]
        ]
      ) {
        expect((yield* resolve({ rules })).writes).toEqual([])
      }
      expect((yield* resolve({ rules: [rule("fs:write", "/ws/**"), rule("fs:read", "/ws/out/**")] })).writes)
        .toEqual(["out"])
      expect(
        (yield* resolve({ rules: [rule("fs:*", "/ws/**")] }).pipe(
          CapabilitySet.attenuate([pattern("fs:write", "/ws/**")])
        )).writes
      ).toEqual([])
      expect(
        (yield* resolve({
          runRules: (["fs:read", "fs:write"] as const).map((action) => ({
            rule: rule(action, "/ws/out/**"),
            ceiling: [[pattern("fs:write", "/ws/out/**")]]
          }))
        })).writes
      ).toEqual([])
    }))
  scoped(
    "recognizes universal star resources in configured grants and captured ceilings",
    () =>
      Effect.gen(function*() {
        const configured = yield* resolve({ rules: [rule("*", "*")] })
        expect(configured).toMatchObject({ reads: ["."], writes: ["."], network: "none" })
        const bounded = yield* resolve({
          runRules: [
            { rule: rule("fs:read", "*"), ceiling: [[pattern("fs:*", "*")]] },
            { rule: rule("fs:write", "/ws"), ceiling: [[pattern("fs:*", "*")]] },
            { rule: rule("fs:write", "/ws/**"), ceiling: [[pattern("fs:*", "*")]] }
          ]
        }).pipe(CapabilitySet.attenuate([pattern("fs:*", "*")]))
        expect(bounded).toMatchObject({ reads: ["."], writes: ["."] })
        expect((yield* resolve({ rules: [rule("fs:*", "/ws/*")] })).writes).toEqual([])
        expect((yield* resolve({ rules: [rule("net:*", "*"), rule("net:private", "*")] })).network).toBe("open")
      })
  )
  scoped("opens whole trees without widening literals or complex globs", () =>
    Effect.gen(function*() {
      expect((yield* resolve({ rules: [rule("fs:write", "/ws/out.txt"), rule("fs:write", "/ws/src/**/*.ts")] })).writes)
        .toEqual([])
      const whole = yield* resolve({
        rules: [rule("fs:read", "/ws/**"), rule("fs:write", "/ws/out"), rule("fs:write", "/ws/out/**")]
      })
      expect(whole.reads).toEqual(["."])
      expect(whole.writes).toEqual(["out"])
    }))
  scoped("configured denies veto later envelopes and remembered rules", () =>
    Effect.gen(function*() {
      const profile = yield* resolve({
        rules: [[rule("fs:write", "/ws/**"), rule("fs:write", "/ws/secret/**", "deny")], [rule("fs:write", "/ws/**")]],
        planDigest: "p",
        envelope: { planDigest: "p", patterns: [pattern("fs:write", "/ws/**")] }
      })
      expect(profile.writes).toEqual([])
    }))
  scoped("later configured whole-tree allow supersedes earlier deny", () =>
    Effect.gen(function*() {
      expect(
        (yield* resolve({
          rules: [
            rule("fs:read", "/ws/**"),
            rule("fs:write", "/ws/secret/**", "deny"),
            rule("fs:write", "/ws"),
            rule("fs:write", "/ws/**")
          ]
        })).writes
      ).toEqual(["."])
    }))
  scoped("intersects current and captured ceilings without widening either", () =>
    Effect.gen(function*() {
      const options = {
        runRules: (["fs:read", "fs:write"] as const).map((action) => ({
          rule: rule(action, "/ws/**"),
          ceiling: [[pattern("fs:*", "/ws/src/**")]]
        }))
      }
      expect(
        (yield* resolve(options).pipe(
          CapabilitySet.attenuate([pattern("fs:*", "/ws/src/lib"), pattern("fs:*", "/ws/src/lib/**")])
        )).writes
      )
        .toEqual(["src/lib"])
      expect(
        (yield* resolve({ rules: [rule("fs:write", "/ws/**")] }).pipe(
          CapabilitySet.attenuate([pattern("fs:write", "/ws/src/*.ts")])
        )).writes
      ).toEqual([])
    }))
  scoped("requires all unrestricted network actions including explicit private", () =>
    Effect.gen(function*() {
      for (
        const rules of [[rule("net:get", "https://example.test/**")], [rule("net:*", "**")], [
          rule("net:get", "**"),
          rule("net:post", "**")
        ]]
      ) {
        expect((yield* resolve({ rules })).network).toBe("none")
      }
      const full = [rule("net:get", "**"), rule("net:post", "**"), rule("net:private", "**")]
      expect((yield* resolve({ rules: full })).network).toBe("open")
      expect((yield* resolve({ rules: [...full, rule("net:get", "https://blocked.test/**", "deny")] })).network).toBe(
        "none"
      )
      expect((yield* resolve({ rules: full }).pipe(CapabilitySet.attenuate([pattern("net:get", "**")]))).network).toBe(
        "none"
      )
    }))
})

describe("GrantStore confinement snapshot", () => {
  for (const resolution of ["once", "run", "remembered"] as const) {
    scoped(`projects ${resolution} approval only when it leaves durable authority`, () =>
      Effect.gen(function*() {
        const store = yield* GrantStore.make({
          attended: true,
          runId: "r",
          planDigest: "p",
          rules: [rule("fs:read", "/ws/out/**"), rule("fs:write", "/ws/out")]
        })
        const waiter = yield* store.check(new Capability({ action: "fs:write", resource: "/ws/out/file" })).pipe(
          Effect.forkChild({ startImmediately: true })
        )
        let pending = yield* store.list
        while (pending.length === 0) {
          yield* Effect.yieldNow
          pending = yield* store.list
        }
        yield* store.reply(
          pending[0]!.requestId,
          resolution,
          resolution === "once" ? undefined : pattern("fs:write", "/ws/out/**")
        )
        yield* Fiber.join(waiter)
        const profile = yield* ProcessConfinement.profile(
          {
            ...store,
            check: () => Effect.die("must not probe patterns"),
            list: Effect.die("must not inspect pending")
          },
          "/ws",
          yield* Path.Path
        )
        expect(profile.writes).toEqual(resolution === "once" ? [] : ["out"])
      }).pipe(Effect.provide(Workspace.layer("/ws")), Effect.provide(Path.layer)))
  }
  it.effect("fails closed after store scope closes", () =>
    Effect.gen(function*() {
      const store = yield* GrantStore.make({ attended: false }).pipe(
        Effect.scoped,
        Effect.provide(Workspace.layer("/ws"))
      )
      expect((yield* Effect.flip(store.policy)).code).toBe("store_closed")
    }))
  scoped("snapshot arrays are immutable and preserve policy ordering", () =>
    Effect.gen(function*() {
      const store = yield* GrantStore.make({
        rules: [rule("fs:write", "/ws/**"), rule("fs:write", "/ws/private/**", "deny")]
      })
      const snapshot = yield* store.policy
      expect(snapshot.groups[0]!.map(({ rule }) => rule.effect)).toEqual(["allow", "deny"])
      expect(Object.isFrozen(snapshot)).toBe(true)
      expect(Object.isFrozen(snapshot.groups)).toBe(true)
      expect(Object.isFrozen(snapshot.groups[0])).toBe(true)
    }).pipe(Effect.provide(Workspace.layer("/ws"))))
})

describe("ProcessConfinement conservative boundaries", () => {
  scoped(
    "explicit unconfined service returns the original command and noop grants remain bounded",
    () =>
      Effect.gen(function*() {
        const command = ChildProcess.make("tool")
        const seam = yield* ProcessConfinement.ProcessConfinement
        expect(
          yield* seam.confine(command, { workspaceRoot: "/ws", reads: [], writes: [], readOnly: [], network: "none" })
        ).toBe(command)
        const all = yield* ProcessConfinement.profile(GrantStore.makeNoop, "/ws", yield* Path.Path)
        expect(all).toMatchObject({ reads: ["."], writes: ["."], network: "open" })
        const bounded = yield* ProcessConfinement.profile(GrantStore.makeNoop, "/ws", yield* Path.Path).pipe(
          CapabilitySet.attenuate([pattern("fs:read", "/ws/src/**")])
        )
        expect(bounded).toMatchObject({ reads: ["src"], writes: [], network: "none" })
      }).pipe(Effect.provide(ProcessConfinement.layerNoop), Effect.provide(Path.layer))
  )
  scoped("rejects outside and noncanonical paths and collapses redundant trees", () =>
    Effect.gen(function*() {
      const profile = yield* resolve({
        rules: [
          rule("fs:read", "src/**"),
          rule("fs:read", "/ws/src/../**"),
          rule("fs:read", "/elsewhere/**"),
          rule("fs:read", "/ws/src/**"),
          rule("fs:read", "/ws/src/lib/**"),
          rule("fs:read", "/ws/other/**")
        ]
      })
      expect(profile.reads).toEqual(["other", "src"])
    }))
  scoped("proves explicit and whole authority ceilings for unrestricted network", () =>
    Effect.gen(function*() {
      const rules = [rule("net:get", "**"), rule("net:post", "**"), rule("net:private", "**")]
      for (
        const ceiling of [[pattern("net:get", "**"), pattern("net:post", "**"), pattern("net:private", "**")], [
          pattern("*", "**")
        ]]
      ) {
        expect((yield* resolve({ rules }).pipe(CapabilitySet.attenuate(ceiling))).network).toBe("open")
      }
      expect((yield* resolve({ rules }).pipe(CapabilitySet.attenuate([pattern("net:*", "**")]))).network).toBe("open")
    }))
  scoped("fails closed when unchecked policy exceeds matching budget", () =>
    Effect.gen(function*() {
      const ceiling = yield* CapabilitySet.current
      const oversized = {
        ...rule("fs:write", "/ws/**"),
        pattern: { ...pattern("fs:write", "/ws/**"), resource: "x".repeat(4097) }
      }
      const profile = yield* ProcessConfinement.profile(
        {
          ...GrantStore.makeNoop,
          policy: Effect.succeed({
            ceiling,
            groups: [[{ rule: oversized, ceiling }, { rule: rule("fs:write", "/ws/**"), ceiling }]]
          })
        },
        "/ws",
        yield* Path.Path
      )
      expect(profile.writes).toEqual([])
    }).pipe(Effect.provide(Path.layer)))
})
