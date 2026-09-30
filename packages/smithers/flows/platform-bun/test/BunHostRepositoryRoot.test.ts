/**
 * Root validation at the `BunHost` boundary.
 *
 * `layerAt` and `layerContainedAt` hand their root to `@smthrs/jj`'s Bun
 * adapter, which is the Node adapter under another name. That adapter refuses
 * a root that is not absolute with a bare `TypeError` naming `NodeJj.layerAt`
 * or `NodeJj.layerSpawnerAt`, echoing the whole string, and carrying nothing a
 * caller can branch on. A Bun caller never asked for that adapter, so the
 * refusal has to be this package's: one error class, one stable code, a
 * bounded message, identical from both factories.
 */
import { Capability, Permission } from "@smthrs/kernel"
import * as GuardedSpawner from "@smthrs/kernel/ChildProcessSpawner"
import * as GrantStore from "@smthrs/kernel/GrantStore"
import * as HostServices from "@smthrs/kernel/HostServices"
import * as KernelProcessConfinement from "@smthrs/kernel/ProcessConfinement"
import * as ProcessLedger from "@smthrs/kernel/ProcessLedger"
import * as Workspace from "@smthrs/kernel/Workspace"
import * as ProcessSandbox from "@smthrs/platform-node/ProcessSandbox"
import { Context, Effect, Layer, Option, Stream } from "effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner, make as makeSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as BunHost from "../src/BunHost.ts"

/** The two root-bound factories, keyed by the name a message must carry. */
const factories = {
  layerAt: (root: string) => BunHost.layerAt(root),
  layerContainedAt: (root: string) => BunHost.layerContainedAt(root)
} as const

/** What `build` threw, or `undefined` when it returned. */
const thrown = (build: () => unknown): unknown => {
  try {
    build()
  } catch (error) {
    return error
  }
  return undefined
}

/** A UTF-16 code unit that is half of a surrogate pair with no other half. */
const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

describe("BunHost repository-root validation", () => {
  it("refuses a relative, an empty, and a Unicode root from both factories with one name and one code", () => {
    for (const [factory, build] of Object.entries(factories)) {
      for (const root of ["relative/repository", "", "répertoire/relatif", "\u{1F600}/relative"]) {
        const error = thrown(() => build(root))

        expect(error).toBeInstanceOf(BunHost.BunHostError)
        expect(error).toBeInstanceOf(Error)
        expect(error).toMatchObject({
          _tag: "@smthrs/platform-bun/BunHostError",
          name: "BunHostError",
          code: "invalid_repository_root"
        })
        const message = (error as Error).message
        // The Bun factory that refused, and the root it refused, verbatim.
        expect(message).toContain(`BunHost.${factory}`)
        expect(message).toContain(JSON.stringify(root))
        // The adapter underneath is nobody's business.
        expect(message).not.toMatch(/NodeJj|layerSpawnerAt|TypeError/)
      }
    }
  })

  it("bounds the message for a root of any length", () => {
    const root = "a".repeat(100_000)
    for (const build of Object.values(factories)) {
      const error = thrown(() => build(root)) as BunHost.BunHostError

      expect(error.code).toBe("invalid_repository_root")
      expect(error.message.length).toBeLessThan(256)
      expect(error.message).not.toContain(root)
      expect(error.message).toContain(`${"a".repeat(64)}"... (100000 characters)`)
    }
  })

  it("bounds the message when escapes widen the excerpt, and never cuts through an escape", () => {
    // Each U+0001 is one code point but a six-character `\u0001` escape once
    // quoted, so a 64-code-point excerpt would alone be 384 characters.
    const control = "\u0001".repeat(65)
    // Astral characters are two UTF-16 units each; control characters six.
    // Together they are cut by budget, not by count, at a code-point boundary.
    const mixed = `${"\u{1F600}".repeat(20)}${"\u0001".repeat(40)}${"\u{1F600}".repeat(5)}`
    // Within the code-point limit, yet too wide to quote in full once escaped.
    const short = "\u0001".repeat(40)
    for (const [factory, build] of Object.entries(factories)) {
      for (const root of [control, mixed, short]) {
        const length = Array.from(root).length
        const error = thrown(() => build(root)) as BunHost.BunHostError

        expect(error.code).toBe("invalid_repository_root")
        expect(error.message.length).toBeLessThan(256)
        expect(error.message).toContain(`BunHost.${factory}`)
        expect(error.message).toContain(`... (${length} characters)`)
        expect(error.message).not.toMatch(loneSurrogate)
        // The excerpt is still one valid JSON string, and a prefix of the root.
        const excerpt = /got ("(?:[^"\\]|\\.)*")\.\.\. \(\d+ characters\)$/.exec(error.message)?.[1]
        expect(excerpt).toBeDefined()
        const decoded = JSON.parse(excerpt as string) as string
        expect(decoded.length).toBeGreaterThan(0)
        expect(root.startsWith(decoded)).toBe(true)
        expect(decoded).not.toMatch(loneSurrogate)
      }
    }
  })

  it("cuts a long root between code points, never through a surrogate pair", () => {
    // 65 astral characters: one past the limit, so the cut lands inside the
    // string, and every candidate cut point is the middle of a surrogate pair
    // if the count is in UTF-16 units.
    const root = "\u{1F600}".repeat(65)
    for (const build of Object.values(factories)) {
      const error = thrown(() => build(root)) as BunHost.BunHostError

      expect(error.message).toContain(`${"\u{1F600}".repeat(64)}"... (65 characters)`)
      expect(error.message).not.toContain("\u{1F600}".repeat(65))
      expect(error.message).not.toMatch(loneSurrogate)
      // `JSON.stringify` escapes a lone surrogate as `\udXXX`; none may appear.
      expect(error.message).not.toContain("\\ud")
    }
  })

  it("builds the layer for an absolute root, so the adapter underneath is never asked to refuse one", () => {
    const root = realpathSync(tmpdir())
    for (const build of Object.values(factories)) {
      expect(thrown(() => build(root))).toBeUndefined()
      expect(build(root).pipe).toBeTypeOf("function")
    }
  })
})

const spawnGrants = () =>
  GrantStore.layer({
    attended: false,
    rules: [
      new Permission.Rule({
        effect: "allow",
        pattern: new Capability.CapabilityPattern({ action: "proc:spawn", resource: "**" })
      })
    ]
  })

describe("BunHost process confinement", () => {
  it("all four bundles provide native confinement", async () => {
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      for (
        const host of [
          BunHost.layer,
          BunHost.layerAt(process.cwd()),
          BunHost.layerContained(),
          BunHost.layerContainedAt(process.cwd())
        ]
      ) {
        const confinement = yield* Effect.serviceOption(KernelProcessConfinement.ProcessConfinement).pipe(
          Effect.provide(host),
          Effect.provide(ProcessLedger.layerMemory({ hostId: "bun-host-confinement", ownerPid: process.pid }))
        )
        expect(Option.isSome(confinement)).toBe(true)
        if (Option.isSome(confinement)) expect(confinement.value).not.toBe(KernelProcessConfinement.makeNoop)
      }
    })))
  })

  it("missing confinement refuses before delegating to the native process spawner", async () => {
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const context = yield* Layer.build(BunHost.layerAt(process.cwd()))
      const nativeSpawner = Context.get(context, ChildProcessSpawner)
      let delegations = 0
      const reduced = Context.omit(KernelProcessConfinement.ProcessConfinement)(context).pipe(
        Context.add(
          ChildProcessSpawner,
          makeSpawner((command) =>
            Effect.sync(() => {
              delegations++
            }).pipe(Effect.andThen(nativeSpawner.spawn(command)))
          )
        )
      )
      const error = yield* Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        return yield* Effect.flip(spawner.spawn(ChildProcess.make("/bin/sh", ["-c", "printf escaped"])))
      }).pipe(
        Effect.provide(GuardedSpawner.layer),
        Effect.provide(reduced),
        Effect.provide(Layer.orDie(spawnGrants())),
        Effect.provide(Workspace.layer(process.cwd()))
      )
      expect(error.reason).toMatchObject({ _tag: "NotFound", module: "ProcessConfinement" })
      expect(delegations).toBe(0)
    })))
  })

  it.skipIf(ProcessSandbox.isUnenforceable(ProcessSandbox.select({ network: "none" }, ProcessSandbox.host())))(
    "guarded Bun bundle starts an approved shell and denies its ungranted write",
    async () => {
      const root = realpathSync(
        mkdtempSync(join(process.env.SMITHERS_TEST_SCRATCH ?? tmpdir(), "bunhost-confinement-"))
      )
      try {
        const result = await Effect.runPromise(Effect.scoped(
          Effect.gen(function*() {
            const spawner = yield* ChildProcessSpawner
            const handle = yield* spawner.spawn(
              ChildProcess.make("/bin/sh", ["-c", "printf started; printf forbidden > output.txt"])
            )
            const [exitCode, stdout] = yield* Effect.all([
              handle.exitCode,
              handle.stdout.pipe(Stream.decodeText(), Stream.mkString)
            ], { concurrency: "unbounded" })
            return { exitCode, stdout }
          }).pipe(
            Effect.provide(HostServices.layer),
            Effect.provide(Layer.orDie(spawnGrants())),
            Effect.provide(BunHost.layerAt(root)),
            Effect.provide(Workspace.layer(root))
          )
        ))
        expect(result.stdout).toBe("started")
        expect(Number(result.exitCode)).not.toBe(0)
        expect(existsSync(join(root, "output.txt"))).toBe(false)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
  )
})
