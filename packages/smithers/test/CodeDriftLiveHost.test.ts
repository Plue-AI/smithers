/**
 * A long-lived host checks drift against the flow's code on disk, not its
 * cached catalog.
 *
 * The registry is a snapshot taken at startup. A flow edited or deleted while
 * the host stays up leaves that snapshot unchanged, so a drift check that read
 * it let the resume claim the run, and the executor then found the changed
 * bytes and failed the run (#1807).
 */
import * as ScriptedJudge from "@smthrs/agent/ScriptedJudge"
import { Control, ControlRuntime } from "@smthrs/control"
import { CodeDrift } from "@smthrs/control/ControlError"
import type { RunId } from "@smthrs/control/ControlSchema"
import { Flow, HumanTask, Interpreter } from "@smthrs/flow"
import * as Descriptor from "@smthrs/registry/Descriptor"
import * as Executable from "@smthrs/registry/Executable"
import * as Registry from "@smthrs/registry/Registry"
import { Effect, Layer, Schema } from "effect"
import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { expect, it } from "vitest"
import * as CoreFlow from "../flows/core/src/Flow.ts"
import * as NodeControl from "../src/NodeControl.ts"

const writeFlow = (root: string, prompt: string) => {
  const directory = join(root, "flows", "review")
  mkdirSync(directory, { recursive: true })
  writeFileSync(
    join(directory, "flow.mdx"),
    `---\ndescription: ${prompt}\nmodel: anthropic:test-model\n---\n${prompt}\n`
  )
}

/** Launches and parks a `review` run, runs `edit`, and reads the drift and the run. */
const afterEdit = async (edit: (root: string) => void) => {
  const root = mkdtempSync(join(tmpdir(), "smithers-drift-live-"))
  try {
    writeFlow(root, "Original review")
    const registry = NodeControl.layerRegistry(root)
    const engine = NodeControl.engineDurable(root, registry)
    return await Effect.runPromise(
      Effect.gen(function*() {
        const runtime = yield* ControlRuntime.ControlRuntime
        const { card } = yield* runtime.plan({ flowId: "review", input: {} })
        const token = yield* runtime.lookupApproval(card.approval.target)
        yield* runtime.resolveApproval(token, "approved", yield* runtime.stampPrincipal(), "run")
        const launched = yield* runtime.launch(card.planId, card.digest, card.envelope)
        if (launched._tag !== "Started") return yield* Effect.die(`expected a started run, got ${launched._tag}`)
        const runId: RunId = launched.run.runId
        yield* runtime.writeStatus(runId, yield* runtime.claimFence(runId), "parked")
        yield* Effect.sync(() => edit(root))
        const drift = yield* runtime.codeDrift(runId)
        const discovery = yield* Registry.Registry
        // Rescanned here only to learn the digest now on disk.
        yield* discovery.refresh()
        const current = yield* discovery.getOption("review")
        return {
          card,
          drift,
          after: yield* runtime.getRun(runId),
          current: current._tag === "Some" ? Descriptor.executionDigest(current.value) : undefined
        }
      }).pipe(Effect.provide(Layer.merge(engine.runtime, registry)), Effect.scoped)
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

it("refuses a flow edited on disk while the host stayed up", async () => {
  const { card, drift, after, current } = await afterEdit((root) => writeFlow(root, "Edited review"))
  expect(current).not.toBe(card.executionDigest)
  expect(drift).toEqual(
    new CodeDrift({ runId: after.runId, flowId: "review", recorded: card.executionDigest, current })
  )
  expect(after.status).toBe("parked")
  expect(after.ownerId).toBeUndefined()
})

it("refuses a flow deleted from disk while the host stayed up", async () => {
  const { card, drift, after } = await afterEdit((root) => rmSync(join(root, "flows", "review"), { recursive: true }))
  expect(drift).toEqual(new CodeDrift({ runId: after.runId, flowId: "review", recorded: card.executionDigest }))
  expect(after.status).toBe("parked")
})

it("passes a flow whose bytes on disk did not change", async () => {
  const { drift } = await afterEdit(() => undefined)
  expect(drift).toBeUndefined()
})

/**
 * The drift check reads the disk through a registry of its own. Refreshing the
 * one `plan` reads made a flow file a run wrote plannable on a host that does
 * not rebuild authored flows, as a plan of no nodes.
 */
it("reads drift without replacing the catalog a plan is made from", async () => {
  const root = mkdtempSync(join(tmpdir(), "smithers-drift-live-"))
  try {
    writeFlow(root, "Original review")
    const registry = NodeControl.layerRegistry(root)
    const engine = NodeControl.engineDurable(root, registry)
    const observed = await Effect.runPromise(
      Effect.gen(function*() {
        const runtime = yield* ControlRuntime.ControlRuntime
        const { card } = yield* runtime.plan({ flowId: "review", input: {} })
        const token = yield* runtime.lookupApproval(card.approval.target)
        yield* runtime.resolveApproval(token, "approved", yield* runtime.stampPrincipal(), "run")
        const launched = yield* runtime.launch(card.planId, card.digest, card.envelope)
        if (launched._tag !== "Started") return yield* Effect.die(`expected a started run, got ${launched._tag}`)
        const runId: RunId = launched.run.runId
        yield* runtime.writeStatus(runId, yield* runtime.claimFence(runId), "parked")

        // Unreadable on the first read: the same typed refusal a failed rescan gives.
        chmodSync(join(root, "flows"), 0o000)
        const unreadable = yield* Effect.flip(runtime.codeDrift(runId)).pipe(
          Effect.ensuring(Effect.sync(() => chmodSync(join(root, "flows"), 0o700)))
        )
        // Readable again, the next read is not stuck on that refusal.
        const unchanged = yield* runtime.codeDrift(runId)

        writeFlow(root, "Edited review")
        const edited = yield* runtime.codeDrift(runId)
        const replanned = yield* runtime.plan({ flowId: "review", input: {} })
        return { card, unreadable, unchanged, edited, replanned: replanned.card }
      }).pipe(Effect.provide(engine.runtime), Effect.scoped)
    )
    expect(observed.unreadable).toMatchObject({ _tag: "/control/PersistenceError" })
    expect(observed.unreadable.message).toContain("could not read source root")
    expect(observed.unchanged).toBeUndefined()
    expect(observed.edited?.recorded).toBe(observed.card.executionDigest)
    expect(observed.edited?.current).not.toBe(observed.card.executionDigest)
    // `plan` still answers from the catalog this host started with.
    expect(observed.replanned.executionDigest).toBe(observed.card.executionDigest)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/** A `flows/` directory missing on the first drift read is not missing for good. */
it("reads drift again once a flows directory missing on the first read returns", async () => {
  const root = mkdtempSync(join(tmpdir(), "smithers-drift-live-"))
  try {
    writeFlow(root, "Original review")
    const registry = NodeControl.layerRegistry(root)
    const engine = NodeControl.engineDurable(root, registry)
    const observed = await Effect.runPromise(
      Effect.gen(function*() {
        const runtime = yield* ControlRuntime.ControlRuntime
        const { card } = yield* runtime.plan({ flowId: "review", input: {} })
        const token = yield* runtime.lookupApproval(card.approval.target)
        yield* runtime.resolveApproval(token, "approved", yield* runtime.stampPrincipal(), "run")
        const launched = yield* runtime.launch(card.planId, card.digest, card.envelope)
        if (launched._tag !== "Started") return yield* Effect.die(`expected a started run, got ${launched._tag}`)
        const runId: RunId = launched.run.runId
        yield* runtime.writeStatus(runId, yield* runtime.claimFence(runId), "parked")

        renameSync(join(root, "flows"), join(root, "flows-away"))
        const missing = yield* runtime.codeDrift(runId)
        renameSync(join(root, "flows-away"), join(root, "flows"))
        const returned = yield* runtime.codeDrift(runId)
        return { card, runId, missing, returned }
      }).pipe(Effect.provide(engine.runtime), Effect.scoped)
    )
    expect(observed.missing).toEqual(
      new CodeDrift({ runId: observed.runId, flowId: "review", recorded: observed.card.executionDigest })
    )
    expect(observed.returned).toBeUndefined()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// A module flow runs the executable this host loaded, not the file on disk, so
// its drift has two halves: the source moved, and the host's catalog did not.
const moduleSource = `import * as Flow from "@smthrs/core/Flow"
import { Schema } from "effect"
export default Flow.make({name:"native",description:"Waits",input:Schema.Unknown,output:Schema.Json,capabilities:[],flows:["test/Wait"]})
`

/**
 * A host serving the `native` module flow, whose body parks on a human task,
 * and the digests of every entry it loaded.
 */
const moduleHost = (root: string) => {
  mkdirSync(join(root, "flows", "native"), { recursive: true })
  writeFileSync(join(root, "flows", "native", "flow.ts"), moduleSource)
  const loaded: Array<string> = []
  const Wait = Flow.make("test/Wait", {
    payload: Executable.Invocation,
    success: Schema.Json,
    error: HumanTask.HumanTaskFailed,
    body: () => HumanTask.action.call({ name: "probe", kind: "ask", prompt: "Continue?", maxAttempts: 3 })
  })
  const modules = Executable.layer({
    delegates: [Wait],
    load: (_path, source) =>
      Effect.suspend(() => {
        loaded.push(source.contentDigest)
        if (new TextDecoder().decode(source.bytes).includes("// broken")) {
          return Effect.fail(new Error("the entry does not load"))
        }
        return Effect.succeed({
          default: CoreFlow.make({
            name: "native",
            description: "Waits",
            input: Schema.Unknown,
            output: Schema.Json,
            capabilities: [],
            flows: ["test/Wait"]
          })
        })
      })
  }).pipe(Layer.provideMerge(Layer.merge(Interpreter.layer(Wait), HumanTask.layer)), Layer.orDie)
  const registry = NodeControl.layerRegistry(root)
  const engine = NodeControl.engineDurable(root, registry)
  return {
    loaded,
    layer: Layer.merge(
      NodeControl.layerControl({ root, evaluator: ScriptedJudge.layer }, registry, engine, modules),
      Layer.merge(engine.runtime, registry)
    )
  }
}

/** Launches `native` and waits for it to park on its human task. */
const launchParked = Effect.gen(function*() {
  const control = yield* Control.Control
  const card = yield* control.plan({ flowId: "native", input: {} })
  yield* control.approve(card.approval)
  const launched = yield* control.run({
    _tag: "Plan",
    planId: card.planId,
    digest: card.digest,
    envelope: card.envelope,
    idempotencyKey: "start"
  })
  if (launched._tag !== "Accepted" || launched.runId === undefined) {
    return yield* Effect.die(`expected an accepted run, got ${launched._tag}`)
  }
  return { card, runId: launched.runId, parked: yield* settled(launched.runId) }
})

/**
 * The run once it stops moving, and has moved since `since` when given. Read
 * off the control row: a listing reports the executor's parked view of a run
 * the control plane has already claimed.
 */
const settled = (runId: RunId, since?: number) =>
  Effect.gen(function*() {
    const runtime = yield* ControlRuntime.ControlRuntime
    for (let attempt = 0;; attempt++) {
      const run = yield* runtime.getRun(runId)
      const moved = since === undefined || run.updatedAt > since
      if (moved && run.status !== "running" && run.status !== "accepted") return run
      if (attempt >= 1_000) return yield* Effect.die(`run ${runId} never settled: ${JSON.stringify(run)}`)
      yield* Effect.sleep("10 millis")
    }
  })

/** The run as `status <run>` reports it, with the drift a resume would refuse. */
const status = (runId: RunId) =>
  Control.Control.pipe(
    Effect.flatMap((control) => control.list({ _tag: "runs", filters: { runId } })),
    Effect.map((page) => page._tag === "runs" ? page.items[0] : undefined)
  )

const onDisk = Effect.gen(function*() {
  const discovery = yield* Registry.Registry
  yield* discovery.refresh()
  const current = yield* discovery.getOption("native")
  return current._tag === "Some" ? Descriptor.executionDigest(current.value) : undefined
})

const withModuleHost = <A, E>(
  body: (
    root: string,
    loaded: ReadonlyArray<string>
  ) => Effect.Effect<A, E, Control.Control | ControlRuntime.ControlRuntime | Registry.Registry>
) => {
  const root = mkdtempSync(join(tmpdir(), "smithers-drift-module-"))
  const host = moduleHost(root)
  return Effect.runPromise(
    body(root, host.loaded).pipe(Effect.provide(host.layer), Effect.scoped, Effect.timeout("30 seconds"))
  ).finally(() => rmSync(root, { recursive: true, force: true }))
}

it("resume --allow-code-drift on an edited module flow runs it", async () => {
  const observed = await withModuleHost((root, loaded) =>
    Effect.gen(function*() {
      const control = yield* Control.Control
      const { card, runId, parked } = yield* launchParked
      yield* Effect.sync(() => writeFileSync(join(root, "flows", "native", "flow.ts"), `${moduleSource}// adopted\n`))
      const current = yield* onDisk
      const receipt = yield* control.resume({ runId, idempotencyKey: "resume", allowCodeDrift: true })
      const after = yield* settled(runId, parked.updatedAt)
      return { card, parked, receipt, current, after, reported: yield* status(runId), loaded: [...loaded] }
    })
  )
  expect(observed.parked.status).toBe("parked")
  expect(observed.current).not.toBe(observed.card.executionDigest)
  expect(observed.receipt._tag).toBe("Accepted")
  // The run re-entered the edited module and parked on its task again.
  expect(observed.after.status).toBe("parked")
  expect(observed.after.executionDigest).toBe(observed.current)
  expect(observed.reported?.codeDrift).toBeUndefined()
  // The host loaded the edited entry: two distinct entry digests.
  expect(new Set(observed.loaded).size).toBe(2)
})

it("refuses a module flow deleted from disk while its executable stays loaded", async () => {
  const observed = await withModuleHost((root) =>
    Effect.gen(function*() {
      const control = yield* Control.Control
      const runtime = yield* ControlRuntime.ControlRuntime
      const { card, runId } = yield* launchParked
      yield* Effect.sync(() => rmSync(join(root, "flows", "native"), { recursive: true }))
      const drift = yield* runtime.codeDrift(runId)
      const plain = yield* Effect.flip(control.resume({ runId, idempotencyKey: "plain" }))
      const allowed = yield* Effect.flip(control.resume({ runId, idempotencyKey: "allowed", allowCodeDrift: true }))
      return { card, runId, drift, plain, allowed, after: yield* settled(runId), reported: yield* status(runId) }
    })
  )
  const refusal = new CodeDrift({ runId: observed.runId, flowId: "native", recorded: observed.card.executionDigest })
  expect(observed.drift).toEqual(refusal)
  expect(observed.plain).toEqual(refusal)
  // There is no code to adopt: the run is left where it was, not accepted to fail.
  expect(observed.allowed).toEqual(refusal)
  expect(observed.after.status).toBe("parked")
  expect(observed.after.ownerId).toBeUndefined()
  expect(observed.reported?.codeDrift).toEqual({ recorded: observed.card.executionDigest })
})

it("a round of a run that adopted drift runs the adopted code the check admitted", async () => {
  const observed = await withModuleHost((root) =>
    Effect.gen(function*() {
      const control = yield* Control.Control
      const runtime = yield* ControlRuntime.ControlRuntime
      const { runId, parked } = yield* launchParked
      yield* Effect.sync(() => writeFileSync(join(root, "flows", "native", "flow.ts"), `${moduleSource}// adopted\n`))
      yield* control.resume({ runId, idempotencyKey: "resume", allowCodeDrift: true })
      const adopted = yield* settled(runId, parked.updatedAt)
      // What the engine writes for a trampoline round or fork: engine state,
      // a parent, and no control summary of its own.
      yield* Effect.sync(() => {
        const database = new DatabaseSync(NodeControl.databasePath(root))
        try {
          database.prepare(
            "INSERT INTO flows_runs (run_id, status, created_at_ms, parent_run_id, state_json) VALUES (?, 'suspended', 1, ?, ?)"
          ).run("round-1", runId, JSON.stringify({ version: 1, flowName: "native", payload: {} }))
        } finally {
          database.close()
        }
      })
      const round = "round-1" as RunId
      return {
        adopted,
        drift: yield* runtime.codeDrift(round),
        own: (yield* runtime.getRun(round)).executionDigest,
        executes: yield* runtime.recordedCode(round)
      }
    })
  )
  expect(observed.adopted.status).toBe("parked")
  // The check admits the round on its parent's adopted code, and the identity
  // the executor enters is that same code, not the row's own (none).
  expect(observed.drift).toBeUndefined()
  expect(observed.own).toBeUndefined()
  expect(observed.executes.executionDigest).toBe(observed.adopted.executionDigest)
})

it("an allowed drift to code this host cannot load leaves the run parked", async () => {
  const observed = await withModuleHost((root) =>
    Effect.gen(function*() {
      const control = yield* Control.Control
      const { card, runId } = yield* launchParked
      yield* Effect.sync(() => writeFileSync(join(root, "flows", "native", "flow.ts"), `${moduleSource}// broken\n`))
      const refused = yield* Effect.flip(control.resume({ runId, idempotencyKey: "allowed", allowCodeDrift: true }))
      return { card, refused, after: yield* settled(runId) }
    })
  )
  expect(observed.refused).toMatchObject({ _tag: "/control/CodeDrift", recorded: observed.card.executionDigest })
  expect(observed.after.status).toBe("parked")
  expect(observed.after.ownerId).toBeUndefined()
  expect(observed.after.executionDigest).toBe(observed.card.executionDigest)
})
