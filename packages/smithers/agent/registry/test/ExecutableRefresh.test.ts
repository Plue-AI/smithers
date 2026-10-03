/**
 * Rebuilding one catalog entry on a host that is already serving.
 *
 * `catalog` is a startup snapshot: a host builds it once, registers what it
 * holds, and plans from it. A flow written to `flows/<id>/flow.ts` after that
 * moment is therefore invisible — it has no executable, so the host's plan
 * hook is absent and planning answers `FlowNotFound` or a plan with no nodes,
 * whatever discovery later says. That is the whole of the agent-led authoring
 * loop failing on a production box.
 *
 * This suite is about the seam that closes it: rescan discovery, rebuild ONE
 * entry, register its body with the runtime, and swap the snapshot the
 * `Catalog` service answers with — without restarting the host and without
 * replacing the service object readers captured at startup.
 *
 * Both kinds of entry are exercised, because a rebuild means a different thing
 * to each. A `flows/<id>/flow.ts` is one `@smthrs/flow` declaration and IS its
 * own delegate, so what an edit changes is the BODY the host runs, and the
 * proof is that the new bytes are imported rather than the module cache's
 * answer. A markdown entry names a delegate the host registered, so what an
 * edit changes is WHICH registered flow it reaches.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { describe, expect, it } from "@effect/vitest"
import { Action, Flow, FlowRuntime, Graph } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { fileURLToPath } from "node:url"
import * as Executable from "../src/Executable.ts"
import * as Registry from "../src/Registry.ts"

const modulesRoot = fileURLToPath(new URL("./fixtures/executable/modules", import.meta.url))
const platform = Layer.merge(NodeFileSystem.layer, NodePath.layer)

const Probe = Action.make("refresh/Probe", { payload: { step: Schema.String }, success: Schema.String })

/** Every node id a plan built from this executable would carry. */
const drafts = (flow: Executable.Executable["flow"]) =>
  Graph.drafts(Graph.build(flow, { input: {} })).map((draft) => draft.id)

/** The delegate a markdown declaration names. Its body is the plan's graph. */
const Delegate = Flow.make("refresh/Delegate", {
  payload: Executable.Invocation,
  success: Schema.Unknown,
  error: Schema.Unknown,
  body: () => Probe.call({ step: "first" }).pipe(Node.andThen(Probe.call({ step: "second" })))
})

/** A second registered flow, so an edited declaration can move between them. */
const Other = Flow.make("refresh/Other", {
  payload: Executable.Invocation,
  success: Schema.Unknown,
  error: Schema.Unknown,
  body: () => Probe.call({ step: "only" })
})

/** The two-step body, as source text: the topology an edit can take away. */
const chained = `Node.andThen(Probe.call({ step: "first" }), Probe.call({ step: "second" }))`

/** The one-step body, as source text. */
const single = `Probe.call({ step: "only" })`

/**
 * A flow file in the one shape every `flows/<id>/flow.ts` takes: one
 * `@smthrs/flow` declaration, named, whose body is the whole of what the entry
 * runs. It names no collaborator, so it is its own delegate.
 */
const declaration = (name: string, body: string) =>
  `import { Action, Flow } from "@smthrs/flow"
${body.includes("Node.") ? `import { Node } from "@smthrs/plan"\n` : ""}import { Schema } from "effect"

const Probe = Action.make("refresh/Probe", { payload: { step: Schema.String }, success: Schema.String })

export default Flow.make(${JSON.stringify(`refresh/${name}`)}, {
  description: "Written after the catalog was built",
  capabilities: [],
  effects: { reads: [], writes: [], mode: "hermetic", onConflict: "serialize", tier: "sealed" },
  payload: {},
  success: Schema.Unknown,
  body: () => ${body}
})
`

/**
 * The half-finished edit an agent leaves behind: discovery parses it, and the
 * sibling it imports is not there, so the host cannot pin what it would run.
 */
const halfWritten = (name: string) =>
  `import { Flow } from "@smthrs/flow"
import { Schema } from "effect"
import { body } from "./body.ts"

export default Flow.make(${JSON.stringify(`refresh/${name}`)}, {
  description: "Written after the catalog was built",
  capabilities: [],
  effects: { reads: [], writes: [], mode: "hermetic", onConflict: "serialize", tier: "sealed" },
  payload: {},
  success: Schema.Unknown,
  body
})
`

/** A markdown entry, which declares WHAT to run and leaves HOW to a delegate. */
const markdown = (delegate: string) =>
  `---
description: Written after the catalog was built
flows: [${delegate}]
capabilities: []
---

Hand this to the flow the frontmatter names.
`

/** Every registration the runtime was asked for, in order. */
const observed = (registered: Array<string>) =>
  Layer.succeed(
    FlowRuntime.FlowRuntime,
    { register: (flow: { readonly _tag: string }) => Effect.sync(() => void registered.push(flow._tag)) } as never
  )

/**
 * One project root that starts with `early` on disk and nothing else, under a
 * directory whose `node_modules` resolve, so the default loader really
 * imports the file rather than a stand-in the test hands it.
 */
const withProject = <A, E>(
  registered: Array<string>,
  use: (root: string) => Effect.Effect<A, E, Executable.Catalog | Executable.Refresh | FileSystem.FileSystem>
) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const root = yield* fs.makeTempDirectoryScoped({ directory: modulesRoot, prefix: ".refresh-" })
    yield* fs.makeDirectory(`${root}/flows/early`, { recursive: true })
    yield* fs.writeFileString(`${root}/flows/early/flow.ts`, declaration("early", chained))
    return yield* use(root).pipe(
      Effect.provide(
        Executable.layer({ delegates: [Delegate, Other] }).pipe(
          Layer.provideMerge(
            Layer.mergeAll(observed(registered), Action.layerImplementations, NodeCrypto.layer)
          ),
          Layer.provideMerge(Registry.layerProject({ root })),
          Layer.orDie
        )
      )
    )
  }).pipe(Effect.scoped, Effect.provide(platform))

describe("rebuilding one catalog entry without restarting the host", () => {
  it.effect("registers and plans a flow whose file was written after startup", () => {
    const registered: Array<string> = []
    return withProject(registered, (root) =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const catalog = yield* Executable.Catalog
        const refresh = yield* Executable.Refresh
        expect(catalog.executables.map((entry) => entry.descriptor.name)).toEqual(["early"])
        expect(registered).toEqual(["early", "refresh/early"])

        yield* fs.makeDirectory(`${root}/flows/late`, { recursive: true })
        yield* fs.writeFileString(`${root}/flows/late/flow.ts`, declaration("late", chained))
        // Nothing has looked at the disk yet, so the snapshot is unchanged.
        expect(catalog.executables.map((entry) => entry.descriptor.name)).toEqual(["early"])

        const outcome = yield* refresh.flow("late")
        expect(outcome._tag).toBe("Registered")
        // The SAME service object a reader captured at startup answers with
        // the new entry: a swapped snapshot, not a swapped service.
        expect(catalog.executables.map((entry) => entry.descriptor.name).sort()).toEqual(["early", "late"])
        // The bridged flow the registry name resolves to, and the flow it
        // calls: a module that is its own flow registers both.
        expect(registered).toEqual(["early", "refresh/early", "late", "refresh/late"])

        // The plan this host would now draw for `late` is the declaration's own
        // topology, keyed nodes and all, rather than the empty one a missing
        // executable leaves behind.
        const late = catalog.executables.find((entry) => entry.descriptor.name === "late")!
        expect(late.delegate).toBeUndefined()
        expect(drafts(late.flow)).toContain("root.flow.flow.andThen")
      }))
  }, 60_000)

  it.effect("runs the body the edited bytes declare, past the module cache", () => {
    const registered: Array<string> = []
    return withProject(registered, (root) =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const catalog = yield* Executable.Catalog
        const refresh = yield* Executable.Refresh
        const before = catalog.executables.find((entry) => entry.descriptor.name === "early")!
        // The module IS the flow, so there is no delegate to name: what an
        // edit moves is the body, and only new bytes can show it moved.
        expect(before.delegate).toBeUndefined()

        yield* fs.writeFileString(`${root}/flows/early/flow.ts`, declaration("early", single))
        expect((yield* refresh.flow("early"))._tag).toBe("Registered")

        const after = catalog.executables.find((entry) => entry.descriptor.name === "early")!
        // The import cache cannot answer this: the second build reads the new
        // bytes under a new content address and imports those.
        expect(after.delegate).toBeUndefined()
        expect(after.descriptor.body.contentDigest).not.toBe(before.descriptor.body.contentDigest)
        expect(drafts(before.flow)).toContain("root.flow.flow.andThen")
        expect(drafts(after.flow)).not.toContain("root.flow.flow.andThen")
        expect(catalog.executables.filter((entry) => entry.descriptor.name === "early")).toHaveLength(1)
      }))
  }, 60_000)

  it.effect("adopts the delegate an edited declaration moved to, from the new bytes", () => {
    const registered: Array<string> = []
    return withProject(registered, (root) =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const catalog = yield* Executable.Catalog
        const refresh = yield* Executable.Refresh
        yield* fs.makeDirectory(`${root}/flows/moved`, { recursive: true })
        yield* fs.writeFileString(`${root}/flows/moved/flow.mdx`, markdown("refresh/Delegate"))
        expect((yield* refresh.flow("moved"))._tag).toBe("Registered")
        const before = catalog.executables.find((entry) => entry.descriptor.name === "moved")!
        expect(before.delegate).toBe("refresh/Delegate")

        yield* fs.writeFileString(`${root}/flows/moved/flow.mdx`, markdown("refresh/Other"))
        expect((yield* refresh.flow("moved"))._tag).toBe("Registered")

        const after = catalog.executables.find((entry) => entry.descriptor.name === "moved")!
        // A cached descriptor cannot answer this: the second build reads the
        // frontmatter now on disk.
        expect(after.delegate).toBe("refresh/Other")
        expect(after.descriptor.body.contentDigest).not.toBe(before.descriptor.body.contentDigest)
        expect(drafts(before.flow)).toContain("root.flow.flow.andThen")
        expect(drafts(after.flow)).not.toContain("root.flow.flow.andThen")
        expect(catalog.executables.filter((entry) => entry.descriptor.name === "moved")).toHaveLength(1)
      }))
  }, 60_000)

  it.effect("reports the refusal and keeps the previous entry out of the catalog", () => {
    const registered: Array<string> = []
    return withProject(registered, (root) =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const catalog = yield* Executable.Catalog
        const refresh = yield* Executable.Refresh
        yield* fs.makeDirectory(`${root}/flows/orphan`, { recursive: true })
        yield* fs.writeFileString(`${root}/flows/orphan/flow.mdx`, markdown("refresh/Nobody"))

        const outcome = yield* refresh.flow("orphan")
        expect(outcome._tag).toBe("Refused")
        if (outcome._tag !== "Refused") return
        expect(outcome.error.code).toBe("missing_delegate")
        expect(outcome.error.delegate).toBe("refresh/Nobody")
        expect(catalog.executables.map((entry) => entry.descriptor.name)).toEqual(["early"])
        expect(catalog.refused.map((failure) => failure.flow)).toEqual(["orphan"])
        expect(registered).toEqual(["early", "refresh/early"])
      }))
  }, 60_000)

  it.effect("leaves an entry the host holds fixed exactly as it was", () => {
    const registered: Array<string> = []
    return Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const root = yield* fs.makeTempDirectoryScoped({ directory: modulesRoot, prefix: ".refresh-" })
      yield* fs.makeDirectory(`${root}/flows/early`, { recursive: true })
      yield* fs.writeFileString(`${root}/flows/early/flow.ts`, declaration("early", chained))
      yield* Effect.gen(function*() {
        const catalog = yield* Executable.Catalog
        const refresh = yield* Executable.Refresh
        const before = catalog.executables.find((entry) => entry.descriptor.name === "early")!
        yield* fs.writeFileString(`${root}/flows/early/flow.ts`, declaration("early", single))

        // A host serving part of its catalog out of its own measured bundle
        // answers `false` for those entries: the working tree is not where
        // their bytes come from.
        expect((yield* refresh.flow("early"))._tag).toBe("Fixed")
        expect(catalog.executables.find((entry) => entry.descriptor.name === "early")).toBe(before)
        expect(registered).toEqual(["early", "refresh/early"])
      }).pipe(
        Effect.provide(
          Executable.layer({ delegates: [Delegate, Other], refreshable: () => false }).pipe(
            Layer.provideMerge(
              Layer.mergeAll(observed(registered), Action.layerImplementations, NodeCrypto.layer)
            ),
            Layer.provideMerge(Registry.layerProject({ root })),
            Layer.orDie
          )
        )
      )
    }).pipe(Effect.scoped, Effect.provide(platform))
  }, 60_000)

  it.effect(
    "rebuilds one entry of several, and clears the refusal it recorded for it",
    () =>
      withProject([], (root) =>
        Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          const catalog = yield* Executable.Catalog
          const refresh = yield* Executable.Refresh
          yield* fs.makeDirectory(`${root}/flows/other`, { recursive: true })
          yield* fs.writeFileString(`${root}/flows/other/flow.ts`, declaration("other", single))
          expect((yield* refresh.flow("other"))._tag).toBe("Registered")
          const other = catalog.executables.find((entry) => entry.descriptor.name === "other")!

          // spec §11.3.2: a failed edit retains the loaded executable and records why.
          const previous = catalog.executables.find((entry) => entry.descriptor.name === "early")!
          yield* fs.writeFileString(`${root}/flows/early/flow.ts`, halfWritten("early"))
          const refusal = yield* refresh.flow("early")
          expect(refusal._tag).toBe("Refused")
          if (refusal._tag !== "Refused") return
          expect(refusal.error.code).toBe("body_unavailable")
          expect(catalog.executables.map((entry) => entry.descriptor.name).sort()).toEqual(["early", "other"])
          expect(catalog.executables.find((entry) => entry.descriptor.name === "early")).toBe(previous)
          expect(catalog.refused.map((failure) => failure.flow)).toEqual(["early"])

          // Repairing the file replaces it and drops the refusal with it.
          yield* fs.writeFileString(`${root}/flows/early/flow.ts`, declaration("early", chained))
          expect((yield* refresh.flow("early"))._tag).toBe("Registered")
          expect(catalog.refused).toEqual([])
          expect(catalog.executables.map((entry) => entry.descriptor.name).sort()).toEqual(["early", "other"])

          // And rebuilding it again replaces only itself: every other entry is
          // the same object the host was already serving.
          yield* fs.writeFileString(`${root}/flows/early/flow.ts`, declaration("early", single))
          expect((yield* refresh.flow("early"))._tag).toBe("Registered")
          expect(catalog.executables.find((entry) => entry.descriptor.name === "other")).toBe(other)
          expect(drafts(catalog.executables.find((entry) => entry.descriptor.name === "early")!.flow))
            .not.toContain("root.flow.flow.andThen")
        })),
    60_000
  )

  it.effect("edit breaks an existing flow", () => {
    const events: Array<string> = []
    const key = `smithers-refresh-${Math.random()}`
    const globals = globalThis as unknown as Record<string, unknown>
    globals[key] = events
    const managed = (version: string) =>
      declaration("early", single) + `
import { Effect, Layer } from "effect"
export const layer = Layer.effectDiscard(Effect.addFinalizer(() => Effect.sync(() => {
  (globalThis as unknown as Record<string, Array<string>>)[${JSON.stringify(key)}]!.push(${JSON.stringify(version)})
})))`
    return withProject([], (root) =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const catalog = yield* Executable.Catalog
        const refresh = yield* Executable.Refresh
        yield* fs.writeFileString(`${root}/flows/early/flow.ts`, managed("first"))
        expect((yield* refresh.flow("early"))._tag).toBe("Registered")
        const first = catalog.executables[0]!
        // spec §11.3.2: failed edits hold both the previous digest and its resource scope.
        yield* fs.writeFileString(`${root}/flows/early/flow.ts`, halfWritten("early"))
        expect((yield* refresh.flow("early"))._tag).toBe("Refused")
        expect(catalog.executables[0]).toBe(first)
        expect(catalog.refused.map((entry) => entry.flow)).toEqual(["early"])
        expect(events).toEqual([])
        yield* fs.writeFileString(`${root}/flows/early/flow.ts`, managed("second"))
        expect((yield* refresh.flow("early"))._tag).toBe("Registered")
        expect(catalog.refused).toEqual([])
        expect(events).toEqual(["first"])
        yield* fs.remove(`${root}/flows/early`, { recursive: true })
        expect((yield* refresh.flow("early"))._tag).toBe("Removed")
        expect(catalog.executables).toEqual([])
        expect(events).toEqual(["first", "second"])
      })).pipe(Effect.ensuring(Effect.sync(() => {
        delete globals[key]
      })))
  }, 60_000)

  it.effect("drops the entry when the flow it names is gone from disk", () => {
    const registered: Array<string> = []
    return withProject(registered, (root) =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const catalog = yield* Executable.Catalog
        const refresh = yield* Executable.Refresh
        yield* fs.remove(`${root}/flows/early`, { recursive: true })

        expect((yield* refresh.flow("early"))._tag).toBe("Removed")
        expect(catalog.executables).toEqual([])
      }))
  }, 60_000)
})
