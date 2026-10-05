/**
 * The three properties a rebuild-while-serving host rests on.
 *
 * `ExecutableRefresh.test.ts` proves the seam does its job: a flow written
 * after startup becomes plannable, an edited one adopts its new delegate, a
 * refused one keeps the catalog honest. None of that says the rebuild is SAFE
 * to run on a host that is already serving, and three separate guarantees
 * carry that weight:
 *
 * 1. The module a load imports is a file that load created. The exclusive
 *    `wx` create is the whole reservation — no temp directory is available to
 *    the guarded filesystem a native host composes — so a name another writer
 *    already holds must cost this load an attempt and reach nothing, and a
 *    load that cannot find a free name must refuse rather than overwrite one.
 * 2. The new body is registered with the runtime BEFORE the previous one's
 *    scope closes, so an execution dispatched across the swap always has a
 *    body to reach.
 * 3. Refreshes are serialized, so two rebuilds of one name cannot interleave
 *    their registration and leave the loser's scope held by nobody.
 *
 * Each of the three is asserted here against the behaviour that would break
 * it, not against the code that implements it.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { describe, expect, it } from "@effect/vitest"
import { Action, FlowRuntime } from "@smthrs/flow"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Schedule from "effect/Schedule"
import * as Scope from "effect/Scope"
import { readFile, readlink, symlink, writeFile } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, vi } from "vitest"
import * as Executable from "../src/Executable.ts"
import * as Registry from "../src/Registry.ts"

const modulesRoot = fileURLToPath(new URL("./fixtures/executable/modules", import.meta.url))
const platform = Layer.merge(NodeFileSystem.layer, NodePath.layer)

/**
 * Where each load's private sibling ended up, reported by the module itself.
 *
 * The reserved name is created, imported and removed inside one scoped load,
 * so the only place it is observable from is the body that ran out of it.
 */
const sites: Array<string> = []
const siteKey = "__executableRefreshSafetySites"
;(globalThis as Record<string, unknown>)[siteKey] = sites

const declaration = `import { Action, Flow } from "@smthrs/flow"
import { Schema } from "effect"
globalThis[${JSON.stringify(siteKey)}].push(import.meta.url)

const Probe = Action.make("safety/Probe", { payload: { step: Schema.String }, success: Schema.String })

export default Flow.make("safety/early", {
  description: "Written after the catalog was built",
  capabilities: [],
  effects: { reads: [], writes: [], mode: "hermetic", onConflict: "serialize", tier: "sealed" },
  payload: {},
  success: Schema.Unknown,
  body: () => Probe.call({ step: "only" })
})
`

/** The path this load reserved, as the imported module reported it. */
const reserved = (site: string): string => fileURLToPath(new URL(site))

/**
 * The name a load `delta` sequence values later would try, given one it took.
 *
 * A reserved name is `.smithers-<content digest>-<sequence>-<clock>` plus the
 * source's extension. The digest and the clock are pinned by the caller, so
 * the sequence is the only part that moves and a later name is predictable —
 * which is exactly what makes a collision plantable.
 */
const sibling = (site: string, delta: number): string => {
  const path = reserved(site)
  const parts = basename(path).split("-")
  const sequence = Number.parseInt(parts[2]!, 36)
  return join(dirname(path), [parts[0], parts[1], (sequence + delta).toString(36), parts[3]].join("-"))
}

/** Everything the runtime was asked to register, and what closed afterwards. */
interface Registrations {
  readonly events: Array<string>
  /** How many registrations of a tag were live when the last one arrived. */
  readonly liveOnRegister: Array<number>
  readonly layer: Layer.Layer<FlowRuntime.FlowRuntime>
}

const runtime = (
  options: {
    readonly onRegister?: ((tag: string, count: number) => Effect.Effect<void>) | undefined
  } = {}
): Registrations => {
  const events: Array<string> = []
  const liveOnRegister: Array<number> = []
  const live = new Map<string, number>()
  let registrations = 0
  return {
    events,
    liveOnRegister,
    layer: Layer.succeed(
      FlowRuntime.FlowRuntime,
      {
        register: (flow: { readonly _tag: string }) =>
          Effect.gen(function*() {
            const tag = flow._tag
            registrations += 1
            const ordinal = registrations
            liveOnRegister.push(live.get(tag) ?? 0)
            events.push(`register:${tag}#${ordinal}`)
            live.set(tag, (live.get(tag) ?? 0) + 1)
            // A registration lives exactly as long as the scope that built
            // it, so the scope closing is what this finalizer reports.
            yield* (Effect.addFinalizer(() =>
              Effect.sync(() => {
                live.set(tag, (live.get(tag) ?? 1) - 1)
                events.push(`release:${tag}#${ordinal}`)
              })
            ) as Effect.Effect<void>)
            if (options.onRegister !== undefined) yield* options.onRegister(tag, registrations)
          })
      } as never
    )
  }
}

/** One project whose single flow is `early`, under an importable directory. */
const withProject = <A, E>(
  registrations: Registrations,
  use: (
    root: string
  ) => Effect.Effect<A, E, Executable.Catalog | Executable.Refresh | FileSystem.FileSystem | Scope.Scope>
) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const root = yield* fs.makeTempDirectoryScoped({ directory: modulesRoot, prefix: ".safety-" })
    yield* fs.makeDirectory(`${root}/flows/early`, { recursive: true })
    yield* fs.writeFileString(`${root}/flows/early/flow.ts`, declaration)
    return yield* use(root).pipe(
      Effect.provide(
        Executable.layer({ delegates: [] }).pipe(
          Layer.provideMerge(
            Layer.mergeAll(registrations.layer, Action.layerImplementations, NodeCrypto.layer)
          ),
          Layer.provideMerge(Registry.layerProject({ root })),
          Layer.orDie
        )
      )
    )
  }).pipe(Effect.scoped, Effect.provide(platform))

/** A fixed clock, so the only moving part of a reserved name is its sequence. */
const pinClock = () => vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000)

afterEach(() => {
  vi.restoreAllMocks()
  sites.length = 0
})

describe("a load reserves its own module file", () => {
  it.effect("costs one attempt on a name another writer holds, and writes nothing through it", () => {
    pinClock()
    return withProject(runtime(), (root) =>
      Effect.gen(function*() {
        const refresh = yield* Executable.Refresh
        const first = sites.at(-1)!
        const decoy = join(root, "decoy.txt")
        yield* Effect.promise(() => writeFile(decoy, "not this file"))
        // A symlink is the sharp case: `wx` refuses a name a symlink occupies,
        // and a create that did not would write through it to the target.
        const planted = sibling(first, 1)
        yield* Effect.promise(() => symlink(decoy, planted))

        expect((yield* refresh.flow("early"))._tag).toBe("Registered")

        const second = sites.at(-1)!
        expect(second).not.toBe(first)
        expect(basename(reserved(second))).toBe(basename(sibling(first, 2)))
        expect(yield* Effect.promise(() => readFile(decoy, "utf8"))).toBe("not this file")
        expect(yield* Effect.promise(() => readlink(planted))).toBe(decoy)
      }))
  }, 60_000)

  it.effect("refuses the body rather than take a name it could not create", () => {
    pinClock()
    return withProject(runtime(), (root) =>
      Effect.gen(function*() {
        const catalog = yield* Executable.Catalog
        const refresh = yield* Executable.Refresh
        const previous = catalog.executables[0]!
        const first = sites.at(-1)!
        const taken = Array.from({ length: 8 }, (_, index) => sibling(first, index + 1))
        yield* Effect.forEach(taken, (path) => Effect.promise(() => writeFile(path, "held by somebody else")))

        const outcome = yield* refresh.flow("early")
        expect(outcome._tag).toBe("Refused")
        if (outcome._tag !== "Refused") return
        expect(outcome.error.code).toBe("body_unavailable")
        expect(sites.at(-1)).toBe(first)
        expect(catalog.executables).toEqual([previous])
        expect(catalog.refused.map((entry) => entry.flow)).toEqual(["early"])
        for (const path of taken) {
          expect(yield* Effect.promise(() => readFile(path, "utf8"))).toBe("held by somebody else")
        }
        expect(root).toContain(".safety-")
      }))
  }, 60_000)
})

describe("a rebuild swaps a body without dropping the one it replaces", () => {
  it.effect("registers the new body before the previous scope closes", () => {
    const registrations = runtime()
    return withProject(registrations, () =>
      Effect.gen(function*() {
        const refresh = yield* Executable.Refresh
        // The first refresh replaces the registrations the startup layer holds,
        // which that layer's own scope owns; the second replaces the ones this
        // seam forked, which is the swap the guarantee is about.
        //
        // Every build registers TWO flows, because the entry is a module that
        // is its own flow: the bridged flow the registry name resolves to, and
        // the flow it calls. Startup registered #1 and #2. The first rebuild
        // registers #3 and #4 and holds their scope; the second registers #5
        // and #6 and releases that scope, newest finalizer first.
        expect((yield* refresh.flow("early"))._tag).toBe("Registered")
        expect((yield* refresh.flow("early"))._tag).toBe("Registered")

        expect([...registrations.events]).toEqual([
          "register:early#1",
          "register:safety/early#2",
          "register:early#3",
          "register:safety/early#4",
          "register:early#5",
          "register:safety/early#6",
          "release:safety/early#4",
          "release:early#3"
        ])
        // And the previous body was still registered at the moment the new
        // one arrived: an execution dispatched across the swap reaches one.
        expect([...registrations.liveOnRegister]).toEqual([0, 0, 1, 1, 2, 2])
      }))
  }, 60_000)

  it.effect("holds the previous refresh scope through refusal, then retires it on removal", () => {
    const registrations = runtime()
    return withProject(registrations, (root) =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const catalog = yield* Executable.Catalog
        const refresh = yield* Executable.Refresh
        expect((yield* refresh.flow("early"))._tag).toBe("Registered")
        const previous = catalog.executables[0]!
        const registered = [...registrations.events]
        yield* fs.writeFileString(
          `${root}/flows/early/flow.ts`,
          declaration.replace(
            "import { Schema } from \"effect\"",
            "import { Schema } from \"effect\"\nimport \"./missing.ts\""
          )
        )
        expect((yield* refresh.flow("early"))._tag).toBe("Refused")
        expect(catalog.executables[0]).toBe(previous)
        expect(yield* catalog.load!("early")).toBe(previous)
        expect(catalog.refused.map((entry) => entry.flow)).toEqual(["early"])
        expect(registrations.events).toEqual(registered)
        expect((yield* refresh.flow("early"))._tag).toBe("Refused")
        expect(registrations.events).toEqual(registered)
        yield* fs.remove(`${root}/flows/early`, { recursive: true })
        expect((yield* refresh.flow("early"))._tag).toBe("Removed")
        expect(catalog.executables).toEqual([])
        expect(catalog.refused).toEqual([])
        expect(registrations.events.slice(registered.length)).toEqual([
          "release:safety/early#4",
          "release:early#3"
        ])
      }))
  }, 60_000)

  it.effect("keeps the previous entry and its live body when a registration dies", () => {
    const registrations = runtime({
      // Startup registers the entry's two flows, #1 and #2; #3 is the first
      // registration a REBUILD performs. A body that cannot register is the
      // case this arm exists for.
      onRegister: (_tag, count) => count === 3 ? Effect.die("registration died") : Effect.void
    })
    return withProject(registrations, () =>
      Effect.gen(function*() {
        const catalog = yield* Executable.Catalog
        const refresh = yield* Executable.Refresh
        const before = catalog.executables[0]!

        expect((yield* Effect.exit(refresh.flow("early")))._tag).toBe("Failure")

        // Readers still see the entry that is actually registered, and the
        // body behind it is still live: a rebuild that registered nothing
        // must not take the running one down with it.
        expect(catalog.executables[0]).toBe(before)
        // The rebuild's own registration was unwound with the build that made
        // it; the bodies registered before it were left alone.
        expect([...registrations.events]).toEqual([
          "register:early#1",
          "register:safety/early#2",
          "register:early#3",
          "release:early#3"
        ])

        // And the host is not wedged. The next rebuild registers both flows,
        // and releases nothing: what it replaces is the startup layer's own
        // scope, which this seam does not hold.
        expect((yield* refresh.flow("early"))._tag).toBe("Registered")
        expect([...registrations.events]).toEqual([
          "register:early#1",
          "register:safety/early#2",
          "register:early#3",
          "release:early#3",
          "register:early#4",
          "register:safety/early#5"
        ])
      }))
  }, 60_000)
})

describe("two rebuilds of one name", () => {
  it.live("do not interleave", () => {
    const entered: Array<string> = []
    // Concurrency is counted PER TAG, because one build registers two flows —
    // the bridged flow and the module's own — and merges their layers, so two
    // registrations of DIFFERENT tags overlapping is that one build, not two
    // rebuilds. Two registrations of the SAME tag at once is what only two
    // interleaved rebuilds of one name can produce.
    const depth = new Map<string, number>()
    let peak = 0
    return Effect.gen(function*() {
      const hold = yield* Deferred.make<void>()
      const registrations = runtime({
        onRegister: (tag, count) =>
          Effect.gen(function*() {
            depth.set(tag, (depth.get(tag) ?? 0) + 1)
            peak = Math.max(peak, depth.get(tag)!)
            entered.push(`enter:${tag}`)
            // Startup registers #1 and #2, so #3 is the first registration a
            // rebuild performs. Only that one waits, so a second rebuild that
            // is not held off by the gate has a whole second to overlap it.
            if (count === 3) yield* Deferred.await(hold)
            depth.set(tag, depth.get(tag)! - 1)
            entered.push(`exit:${tag}`)
          })
      })
      yield* withProject(registrations, () =>
        Effect.gen(function*() {
          const refresh = yield* Executable.Refresh
          const first = yield* Effect.forkChild(refresh.flow("early"))
          const second = yield* Effect.forkChild(refresh.flow("early"))
          // Give the second rebuild every chance to reach the runtime while
          // the first is still inside it. Under the gate it never does.
          yield* Effect.retry(
            Effect.suspend(() => peak > 1 ? Effect.void : Effect.fail("not yet")),
            { times: 30, schedule: Schedule.spaced("100 millis") }
          ).pipe(Effect.ignore)
          yield* Deferred.succeed(hold, undefined)
          expect((yield* Fiber.join(first))._tag).toBe("Registered")
          expect((yield* Fiber.join(second))._tag).toBe("Registered")
        }))
      expect(peak).toBe(1)
      // Startup, then the held rebuild, then the one that waited for it. The
      // held rebuild's own two registrations NEST — its bridged flow is what
      // waits, and the module flow it merges with proceeds meanwhile — which
      // is one build's two layers, not two builds.
      expect(entered).toEqual([
        "enter:early",
        "exit:early",
        "enter:safety/early",
        "exit:safety/early",
        "enter:early",
        "enter:safety/early",
        "exit:safety/early",
        "exit:early",
        "enter:early",
        "exit:early",
        "enter:safety/early",
        "exit:safety/early"
      ])
    })
  }, 60_000)
})
