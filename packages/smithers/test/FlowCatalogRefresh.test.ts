/**
 * The agent-led builder loop, on the host a production box composes.
 *
 * A native host builds its executable catalog once, while it starts. Every
 * later plan reads that snapshot, so a flow one of the host's own runs writes
 * into `flows/` had a descriptor and no executable: `flow.plan` answered
 * `FlowNotFound`, the canvas had nothing to draw, and only a restart fixed it.
 * The authoring demo worked anyway because its fixture pre-registered the flow
 * it was about to author, which is a fixture mechanism and not a host.
 *
 * This suite is the host doing it for real, with nothing pre-registered: one
 * `NodeControl.layerControl` over a real registry, a real catalog, the durable
 * control plane and the native engine. A run writes `flows/authored/flow.ts`
 * through the workspace sandbox, the engine journals the copy-back, the
 * observer that bridges those records into the control journal rebuilds that
 * one catalog entry before the receipt is readable, and the next plan is a
 * real plan of the delegate the new file names — which the host then runs.
 *
 * What is real here: the registry, the discovery scan, the module import of
 * the authored bytes, the executable, the control plane, the engine, the
 * sandbox boundary, the diff bundle, the copy-back and the bridge. Nothing is
 * pre-registered on the flow's behalf and no journal record is hand-written.
 */
import * as ScriptedJudge from "@smthrs/agent/ScriptedJudge"
import { Control } from "@smthrs/control"
import * as Executable from "@smthrs/registry/Executable"
import { Effect, type FileSystem, Layer, Stream } from "effect"
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { mkdir, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { expect, it } from "vitest"
import * as NodeControl from "../src/NodeControl.ts"

const fixtures = fileURLToPath(new URL("./fixtures/.catalog-refresh", import.meta.url))
const modulesRoot = fileURLToPath(new URL("../agent/node_modules", import.meta.url))

/** The registry entry the run writes, named by the directory it sits in. */
const AUTHORED = "flows/authored/flow.ts"

/**
 * The `@smthrs/flow` GRAPH file a run writes, named by the directory it sits
 * in. A declaration names a delegate the host already holds; a graph file IS
 * the body, and nothing has a delegate for it.
 */
const GRAPH = "flows/review/flow.ts"

/** The action that file's body names. The project implements it by name. */
const REVIEW_STEP = "example/Review/Read"

/**
 * That file, lifted out of the instructions an authoring agent is given.
 *
 * `flows/create-flow/scaffold/flow.mdx` is the whole of what the scaffolder
 * reads before it writes `flows/<name>/flow.ts`. If its one example and this
 * host's loader drift apart, every agent-written flow is refused and the
 * document is what taught the refusal. Reading the fence rather than a copy of
 * it is what keeps the two together.
 */
const scaffoldExample = (): string => {
  const document = readFileSync(
    fileURLToPath(new URL("../../../flows/create-flow/scaffold/flow.mdx", import.meta.url)),
    "utf8"
  )
  const fence = /```ts\n([\s\S]*?)\n```/.exec(document)
  if (fence === null) throw new Error("flows/create-flow/scaffold/flow.mdx no longer holds a TypeScript example")
  return `${fence[1]!}\n`
}

/**
 * What a discovered module flow is: a declaration naming the delegate that
 * runs it. The authored file is one of these, written by a run.
 */
const declaration = (name: string, delegate: string, writes: ReadonlyArray<string>) =>
  `import { Flow } from "@smthrs/core"
import { Schema } from "effect"
export default ({
  name: ${JSON.stringify(name)},
  description: "Written by a run of this host",
  input: Schema.Struct({}),
  output: Schema.Unknown,
  capabilities: ["fs:read:**", "fs:write:**"],
  flows: [${JSON.stringify(delegate)}],
  effects: {
    reads: [],
    writes: ${JSON.stringify(writes)},
    mode: "expected",
    onConflict: "serialize",
    tier: "irreversible"
  }
})
`

/**
 * The delegates the host registers, declared inside the project it serves.
 *
 * Their location is the point of the `declaredAt` assertion: a plan card
 * carries each node's declaration site relative to the project root, and a
 * site outside that root is dropped whole rather than published as somebody's
 * home directory. A project registers its own flows from its own files, so
 * this file stands where `flows/repository/registry.ts` stands in this
 * repository.
 */
const delegates = `import { Action, Flow, Interpreter } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import * as Executable from "@smthrs/registry/Executable"
import { Effect, FileSystem, Layer, Schema } from "effect"

const Probe = Action.make("catalog/Probe", { payload: { step: Schema.String }, success: Schema.String })

/** The delegate the authored declaration names. Its body is the plan's graph. */
export const Authored = Flow.make("catalog/Authored", {
  payload: Executable.Invocation,
  success: Schema.Unknown,
  error: Schema.Unknown,
  body: () => Probe.call({ step: "first" }).pipe(Node.andThen(Probe.call({ step: "second" })))
})

/** The delegate an EDITED declaration names. One step, where Authored has two. */
export const Revised = Flow.make("catalog/Revised", {
  payload: Executable.Invocation,
  success: Schema.Unknown,
  error: Schema.Unknown,
  body: () => Probe.call({ step: "only" })
})

const Write = Action.make("catalog/Write", {
  payload: { text: Schema.String, revision: Schema.Number },
  success: Schema.String,
  implementationVersion: "1",
  fileBoundary: { readSet: [], writeSet: [${JSON.stringify(AUTHORED)}], boundaryMode: "hard" },
  idempotencyKey: ({ revision }) => "author-" + revision
})

const WriteGraph = Action.make("catalog/WriteGraph", {
  payload: { text: Schema.String },
  success: Schema.String,
  implementationVersion: "1",
  fileBoundary: { readSet: [], writeSet: [${JSON.stringify(GRAPH)}], boundaryMode: "hard" },
  idempotencyKey: () => "author-graph"
})

/** The delegate that writes a @smthrs/flow graph file rather than a declaration. */
export const AuthorGraph = Flow.make("catalog/AuthorGraph", {
  payload: Executable.Invocation,
  success: Schema.Unknown,
  error: Schema.Unknown,
  body: ({ input }) => WriteGraph.call({ text: (input as { readonly text: string }).text })
})

/** The delegate the authoring flow names: one sealed write of one entry file. */
export const Author = Flow.make("catalog/Author", {
  payload: Executable.Invocation,
  success: Schema.Unknown,
  error: Schema.Unknown,
  body: ({ input }) =>
    Write.call({
      text: (input as { readonly text: string }).text,
      revision: (input as { readonly revision: number }).revision
    })
})

/** Everything this project registers with the host it runs on. */
export const registrations = Layer.mergeAll(
  Interpreter.layer(Author),
  Interpreter.layer(AuthorGraph),
  Interpreter.layer(Authored),
  Interpreter.layer(Revised),
  Probe.toLayer(({ step }) => Effect.succeed(step)),
  Action.make(${JSON.stringify(REVIEW_STEP)}, { payload: { change: Schema.String }, success: Schema.String })
    .toLayer(({ change }) => Effect.succeed("reviewed " + change)),
  WriteGraph.toLayer(
    ({ text }) =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        yield* fs.makeDirectory("flows/review", { recursive: true })
        yield* fs.writeFileString(${JSON.stringify(GRAPH)}, text)
        return ${JSON.stringify(GRAPH)}
      }).pipe(Effect.orDie),
    { implementationVersion: "1" }
  ),
  Write.toLayer(
    ({ text }) =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        yield* fs.makeDirectory("flows/authored", { recursive: true })
        yield* fs.writeFileString(${JSON.stringify(AUTHORED)}, text)
        return ${JSON.stringify(AUTHORED)}
      }).pipe(Effect.orDie),
    { implementationVersion: "1" }
  )
)
`

/** A project root this process can import out of, removed when the test ends. */
const project = async (authored?: string) => {
  // Inside the package, so this process loads the registration file below as
  // its own module rather than a second copy of `@smthrs/flow`, and gitignored,
  // so a killed run leaves no scratch tree in the checkout.
  mkdirSync(fixtures, { recursive: true })
  const root = mkdtempSync(join(fixtures, "root-"))
  await writeFile(join(root, "package.json"), "{\"type\":\"module\"}\n")
  await symlink(modulesRoot, join(root, "node_modules"), "dir")
  await mkdir(join(root, "flows", "author"), { recursive: true })
  await writeFile(join(root, "flows", "author", "flow.ts"), declaration("author", "catalog/Author", ["flows/**"]))
  await writeFile(join(root, "delegate.ts"), delegates)
  if (authored !== undefined) {
    await mkdir(join(root, "flows", "authored"), { recursive: true })
    await writeFile(join(root, "flows", "authored", "flow.ts"), authored)
  }
  return root
}

/**
 * What the project's registration file hands back: the two delegates the host
 * resolves declarations against, and the one layer that registers them.
 */
interface Delegates {
  readonly Author: Executable.Delegate
  readonly AuthorGraph: Executable.Delegate
  readonly Authored: Executable.Delegate
  readonly Revised: Executable.Delegate
  readonly registrations: Layer.Layer<never, never, Executable.Registration | FileSystem.FileSystem>
}

it("plans and runs a flow one of its own runs wrote, without restarting", async () => {
  const root = await project()
  try {
    // Loaded the way the project's own registration file would be, so the
    // nodes it declares are declared inside the root the host serves.
    const registered = await import(pathToFileURL(join(root, "delegate.ts")).href) as unknown as Delegates
    const authoredText = declaration("authored", "catalog/Authored", [])
    const registry = NodeControl.layerRegistry(root)
    const modules = Executable.layer({
      delegates: [registered.Author, registered.Authored, registered.Revised]
    }).pipe(
      Layer.provideMerge(registered.registrations),
      Layer.orDie
    )

    const observed = await Effect.runPromise(Effect.scoped(
      Effect.gen(function*() {
        const control = yield* Control.Control
        const launch = (planId: string, digest: string, envelope: never, key: string) =>
          Effect.gen(function*() {
            const receipt = yield* control.run({ _tag: "Plan", planId, digest, envelope, idempotencyKey: key })
            if (receipt._tag !== "Accepted" || receipt.runId === undefined) return yield* Effect.die("launch refused")
            return receipt.runId
          })
        const settle = (runId: string) =>
          control.watch({ runId, follow: true }).pipe(
            // The RUN's own terminal status, which lands after the projection
            // settles: a watcher that closed on the projection stopped one event
            // short of the status this asserts on.
            Stream.takeUntil((event) => event.kind === "control.run.completed" || event.kind === "control.run.failed"),
            Stream.runCollect
          )

        // Nothing on disk names it yet, so the host refuses by name rather than
        // answering with a plan that has no nodes.
        const before = yield* Effect.flip(control.plan({ flowId: "authored", input: {} }))

        const author = yield* control.plan({ flowId: "author", input: { text: authoredText, revision: 1 } })
        yield* control.approve(author.approval)
        const authorRun = yield* launch(author.planId, author.digest, author.envelope as never, "author")
        const authorEvents = yield* settle(authorRun)

        // The plan the host can answer NOW, with no restart between the receipt
        // and the question.
        const after = yield* control.plan({ flowId: "authored", input: {} })
        yield* control.approve(after.approval)
        const authoredRun = yield* launch(after.planId, after.digest, after.envelope as never, "authored")
        const authoredEvents = yield* settle(authoredRun)

        const bridged = (events: ReadonlyArray<{ readonly kind: string; readonly payload: unknown }>) =>
          events.filter((event) => event.kind === "control.engine.event")
            .map((event) => event.payload as { readonly eventType: string; readonly payload: Record<string, unknown> })
        const receipt = (eventType: string) =>
          bridged(authorEvents).filter((row) => row.eventType === eventType).map((row) => row.payload)
        return {
          before: before._tag,
          captured: receipt("flows.engine.diff-bundle-captured").map((row) => row["changedPaths"]),
          // The pairing the app applies to these same two records, applied here
          // to the host's own copies: a capture is a proposal, and only its
          // settled twin says the bytes reached the workspace.
          bundles: {
            captured: receipt("flows.engine.diff-bundle-captured").map((row) => row["bundleIdentity"]),
            settled: receipt("flows.engine.copy-back-settled").map((row) => row["bundleIdentity"])
          },
          nodes: after.nodes.map((node) => node.id),
          keys: after.nodes.map((node) => node.key),
          sites: (after.graph?.nodes ?? []).map((node) => ({ id: node.id, declaredAt: node.declaredAt })),
          actions: bridged(authoredEvents).filter((row) =>
            row.eventType === "flows.engine.node-settled" && row.payload["outcome"] === "built"
          ).map((row) => row.payload["action"]).filter((action) => action !== null && action !== undefined),
          status: authoredEvents.filter((event) => event.kind.startsWith("control.run.")).map((event) => event.kind)
        }
      }).pipe(
        Effect.provide(
          NodeControl.layerControl(
            { root, rebuildAuthoredFlows: true, evaluator: ScriptedJudge.layer },
            registry,
            undefined,
            modules
          )
        )
      )
    ))

    // Before: the flow does not exist on this host at all.
    expect(observed.before).toBe("/control/FlowNotFound")
    // The run really wrote the entry file, and the engine really applied it.
    expect(observed.captured).toEqual([[AUTHORED]])
    expect(observed.bundles.settled).toEqual(observed.bundles.captured)
    expect(observed.bundles.settled).toHaveLength(1)
    // After: a real plan of the delegate the authored file names, keyed.
    expect(observed.nodes).toEqual([
      "root.flow.flow.andThen",
      "root.flow.flow.then",
      "root.flow.flow",
      "root.flow",
      "root"
    ])
    expect(observed.keys.every((key) => /^key1_[0-9a-f]{64}$/.test(key))).toBe(true)
    // Every node that names a declaration says where it is, relative to the
    // project root, so a reader of this plan can open the code it will run.
    // The two structural nodes — the composition and the root — declare
    // nothing, and a site this host could not make relative would be dropped
    // rather than published as somebody's home directory.
    expect(observed.sites.filter((node) => node.declaredAt !== undefined).map((node) => node.id)).toEqual([
      "root.flow.flow.andThen",
      "root.flow.flow.then",
      "root.flow"
    ])
    expect(new Set(observed.sites.map((node) => node.declaredAt?.path))).toEqual(
      new Set(["delegate.ts", undefined])
    )
    // And the rebuilt entry is registered, not merely plannable: the host ran
    // the authored flow, its delegate, and both of the delegate's steps.
    expect(observed.actions).toEqual(["catalog/Probe", "catalog/Probe", "catalog/Authored", "authored"])
    expect(observed.status).toContain("control.run.completed")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 300_000)

it("re-plans and runs a flow one of its own runs edited, without restarting", async () => {
  // The builder's edit step. `flows/authored/flow.ts` is on disk before the
  // host starts, so the control plane's own registry build already describes
  // it; a run then rewrites it to name a different delegate. The next plan
  // has to describe the body it will run — a stale descriptor beside a
  // rebuilt plan is an approval card for one body and an execution of
  // another, which the control plane then refuses `execution_changed`, on
  // that plan and on every replacement plan that carries the same digest.
  const root = await project(declaration("authored", "catalog/Authored", []))
  try {
    const registered = await import(pathToFileURL(join(root, "delegate.ts")).href) as unknown as Delegates
    const registry = NodeControl.layerRegistry(root)
    const modules = Executable.layer({
      delegates: [registered.Author, registered.Authored, registered.Revised]
    }).pipe(
      Layer.provideMerge(registered.registrations),
      Layer.orDie
    )

    const observed = await Effect.runPromise(Effect.scoped(
      Effect.gen(function*() {
        const control = yield* Control.Control
        const launch = (planId: string, digest: string, envelope: never, key: string) =>
          Effect.gen(function*() {
            const receipt = yield* control.run({ _tag: "Plan", planId, digest, envelope, idempotencyKey: key })
            if (receipt._tag !== "Accepted" || receipt.runId === undefined) {
              return yield* Effect.die(`launch refused: ${JSON.stringify(receipt)}`)
            }
            return receipt.runId
          })
        const settle = (runId: string) =>
          control.watch({ runId, follow: true }).pipe(
            // The RUN's own terminal status, which lands after the projection
            // settles: a watcher that closed on the projection stopped one event
            // short of the status this asserts on.
            Stream.takeUntil((event) => event.kind === "control.run.completed" || event.kind === "control.run.failed"),
            Stream.runCollect
          )
        const plan = (flowId: string, input: unknown, key: string) =>
          Effect.gen(function*() {
            const card = yield* control.plan({ flowId, input })
            yield* control.approve(card.approval)
            return { card, events: yield* settle(yield* launch(card.planId, card.digest, card.envelope as never, key)) }
          })

        const before = yield* control.plan({ flowId: "authored", input: {} })
        const edit = yield* plan(
          "author",
          { text: declaration("authored", "catalog/Revised", []), revision: 1 },
          "edit"
        )
        const after = yield* plan("authored", {}, "authored")

        const actions = (events: ReadonlyArray<{ readonly kind: string; readonly payload: unknown }>) =>
          events.filter((event) => event.kind === "control.engine.event")
            .map((event) => event.payload as { readonly eventType: string; readonly payload: Record<string, unknown> })
            .filter((row) => row.eventType === "flows.engine.node-settled" && row.payload["outcome"] === "built")
            .map((row) => row.payload["action"])
            .filter((action) => action !== null && action !== undefined)
        return {
          before: {
            digest: before.digest,
            flows: (before.envelope as { readonly flows: ReadonlyArray<string> }).flows,
            nodes: before.nodes.map((node) => node.id)
          },
          wrote: actions(edit.events),
          after: {
            digest: after.card.digest,
            flows: (after.card.envelope as { readonly flows: ReadonlyArray<string> }).flows,
            nodes: after.card.nodes.map((node) => node.id),
            actions: actions(after.events),
            status: after.events.filter((event) => event.kind.startsWith("control.run.")).map((event) => event.kind)
          }
        }
      }).pipe(
        Effect.provide(
          NodeControl.layerControl(
            { root, rebuildAuthoredFlows: true, evaluator: ScriptedJudge.layer },
            registry,
            undefined,
            modules
          )
        )
      )
    ))

    // Before the edit: the delegate the file on disk named, two steps deep.
    expect(observed.before.flows).toEqual(["catalog/Authored"])
    expect(observed.before.nodes).toEqual([
      "root.flow.flow.andThen",
      "root.flow.flow.then",
      "root.flow.flow",
      "root.flow",
      "root"
    ])
    expect(observed.wrote).toEqual(["catalog/Write", "catalog/Author", "author"])

    // After it: a card that describes the new body. A card still carrying the
    // pre-edit digest is one the control plane will not launch.
    expect(observed.after.flows).toEqual(["catalog/Revised"])
    expect(observed.after.nodes).toEqual(["root.flow.flow", "root.flow", "root"])
    expect(observed.after.digest).not.toBe(observed.before.digest)
    expect(observed.after.actions).toEqual(["catalog/Probe", "catalog/Revised", "authored"])
    expect(observed.after.status).toContain("control.run.completed")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 300_000)

/**
 * The same host, with the rebuild left off, which is the default.
 *
 * The rebuild's cost is the IMPORT: top-level code in an agent-written
 * `flows/<id>/flow.ts` runs in the serving process, with that host's
 * credentials, the moment copy-back settles, and nothing approves it. A host
 * that holds credentials therefore keeps its startup snapshot until an
 * operator says otherwise, and this is what that host does instead — which
 * has to be the refusal it has always answered with, and not a plan of no
 * nodes standing in for one.
 */
it("leaves a flow its run wrote unplannable until it is started again, when the rebuild is off", async () => {
  const root = await project()
  try {
    const registered = await import(pathToFileURL(join(root, "delegate.ts")).href) as unknown as Delegates
    const authoredText = declaration("authored", "catalog/Authored", [])
    const registry = NodeControl.layerRegistry(root)
    const modules = Executable.layer({
      delegates: [registered.Author, registered.Authored, registered.Revised]
    }).pipe(Layer.provideMerge(registered.registrations), Layer.orDie)

    const served = (config: { readonly rebuildAuthoredFlows?: boolean }) =>
      Effect.gen(function*() {
        const control = yield* Control.Control
        const before = yield* Effect.flip(control.plan({ flowId: "authored", input: {} }))
        const author = yield* control.plan({ flowId: "author", input: { text: authoredText, revision: 1 } })
        yield* control.approve(author.approval)
        const receipt = yield* control.run({
          _tag: "Plan",
          planId: author.planId,
          digest: author.digest,
          envelope: author.envelope as never,
          idempotencyKey: "author"
        })
        if (receipt._tag !== "Accepted" || receipt.runId === undefined) return yield* Effect.die("launch refused")
        yield* control.watch({ runId: receipt.runId, follow: true }).pipe(
          // The run's own terminal status; see `settle` above.
          Stream.takeUntil((event) => event.kind === "control.run.completed" || event.kind === "control.run.failed"),
          Stream.runCollect
        )
        const after = yield* Effect.flip(control.plan({ flowId: "authored", input: {} }))
        return { before: before._tag, after: after._tag }
      }).pipe(
        Effect.provide(
          NodeControl.layerControl({ root, ...config, evaluator: ScriptedJudge.layer }, registry, undefined, modules)
        )
      )

    const observed = await Effect.runPromise(Effect.scoped(served({})))

    expect(observed.before).toBe("/control/FlowNotFound")
    // The run wrote the file. The host that served it will not import it, and
    // says exactly that: the same typed refusal, not an empty plan.
    expect(observed.after).toBe("/control/FlowNotFound")

    // A host STARTED over the same directory holds it: the file is discovered
    // at startup, so what the rebuild buys is the restart, and nothing else.
    const restarted = await Effect.runPromise(Effect.scoped(
      Effect.flatMap(Control.Control, (control) => control.plan({ flowId: "authored", input: {} })).pipe(
        Effect.provide(NodeControl.layerControl({ root, evaluator: ScriptedJudge.layer }, registry, undefined, modules))
      )
    ))
    expect(restarted.nodes.length).toBeGreaterThan(1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 300_000)

/**
 * The same loop, over the file the scaffold actually teaches an agent to write.
 *
 * The two cases above author a `@smthrs/core` DECLARATION: metadata naming a
 * delegate the host already registered, whose nodes are declared in the
 * project's own `delegate.ts`. `flows/create-flow/scaffold/flow.mdx` teaches
 * the author to write a `@smthrs/flow` GRAPH instead — one flow,
 * default-exported, whose body is the whole of what runs — so the file a real
 * builder loop produces is one nothing has a delegate for. It is its own
 * delegate, and its nodes are declared in IT.
 *
 * The bytes are LIFTED OUT of that document rather than copied into this file,
 * because the document and the loader drifting apart is the defect: an example
 * the loader refuses is an instruction to write flows this host cannot run,
 * and nothing else in the repository reads it.
 *
 * Which is also what makes the declaration sites the property under test. A
 * reader of this plan opens the code it will run (D-068), so every site has to
 * name the entry file on disk.
 */
it("plans and runs the @smthrs/flow graph file the scaffold teaches, whose nodes name that file", async () => {
  const root = await project()
  try {
    // The authoring half: a declaration naming the delegate that writes a
    // graph file, standing where the project's own flows stand.
    await mkdir(join(root, "flows", "author-graph"), { recursive: true })
    await writeFile(
      join(root, "flows", "author-graph", "flow.ts"),
      declaration("author-graph", "catalog/AuthorGraph", ["flows/**"])
    )
    const registered = await import(pathToFileURL(join(root, "delegate.ts")).href) as unknown as Delegates
    const registry = NodeControl.layerRegistry(root)
    const modules = Executable.layer({
      delegates: [registered.Author, registered.AuthorGraph, registered.Authored, registered.Revised]
    }).pipe(Layer.provideMerge(registered.registrations), Layer.orDie)

    const observed = await Effect.runPromise(Effect.scoped(
      Effect.gen(function*() {
        const control = yield* Control.Control
        const launch = (planId: string, digest: string, envelope: never, key: string) =>
          Effect.gen(function*() {
            const receipt = yield* control.run({ _tag: "Plan", planId, digest, envelope, idempotencyKey: key })
            if (receipt._tag !== "Accepted" || receipt.runId === undefined) {
              return yield* Effect.die(`launch refused: ${JSON.stringify(receipt)}`)
            }
            return receipt.runId
          })
        const settle = (runId: string) =>
          control.watch({ runId, follow: true }).pipe(
            Stream.takeUntil((event) => event.kind === "control.run.completed" || event.kind === "control.run.failed"),
            Stream.runCollect
          )
        const plan = (flowId: string, input: unknown, key: string) =>
          Effect.gen(function*() {
            const card = yield* control.plan({ flowId, input })
            yield* control.approve(card.approval)
            return { card, events: yield* settle(yield* launch(card.planId, card.digest, card.envelope as never, key)) }
          })

        // Nothing on disk names it, so the host refuses by name.
        const before = yield* Effect.flip(control.plan({ flowId: "review", input: { change: "one line" } }))
        yield* plan("author-graph", { text: scaffoldExample() }, "author-graph")
        const after = yield* plan("review", { change: "one line" }, "review")
        return {
          before: before._tag,
          nodes: after.card.nodes.map((node) => node.id),
          sites: (after.card.graph?.nodes ?? []).map((node) => node.declaredAt?.path),
          actions: after.events.filter((event) => event.kind === "control.engine.event")
            .map((event) => event.payload as { readonly eventType: string; readonly payload: Record<string, unknown> })
            .filter((row) => row.eventType === "flows.engine.node-settled" && row.payload["outcome"] === "built")
            .map((row) => row.payload["action"])
            .filter((action) => action !== null && action !== undefined),
          status: after.events.filter((event) => event.kind.startsWith("control.run.")).map((event) => event.kind)
        }
      }).pipe(
        Effect.provide(
          NodeControl.layerControl(
            { root, rebuildAuthoredFlows: true, evaluator: ScriptedJudge.layer },
            registry,
            undefined,
            modules
          )
        )
      )
    ))

    expect(observed.before).toBe("/control/FlowNotFound")
    // A plan of the file's OWN graph: the step its body names, keyed.
    expect(observed.nodes.length).toBeGreaterThan(1)
    // Every node that names a declaration names the entry file the run wrote.
    expect(new Set(observed.sites)).toEqual(new Set([GRAPH, undefined]))
    // And the host really ran it: the step the document's example declares.
    expect(observed.actions).toContain(REVIEW_STEP)
    expect(observed.status).toContain("control.run.completed")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 300_000)
