import * as ScriptedJudge from "@smthrs/agent/ScriptedJudge"
import { Control } from "@smthrs/control"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import * as GatewayProjection from "@smthrs/gateway/GatewayProjection"
import * as Steering from "@smthrs/harness/Steering"
import * as Executable from "@smthrs/registry/Executable"
import { Deferred, Effect, Layer, Schema, Stream } from "effect"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const runtime = process.argv[2]
const driftRescan = process.argv[3] === "drift-rescan"
const recovery = process.argv[3] === "recovery" || driftRescan
const drift = process.argv[3] === "drift"
const cancel = process.argv[3] === "cancel"
const started = Date.now()
const trace = (phase: string) => process.stderr.write(`[native host fixture] ${phase} (${Date.now() - started} ms)\n`)
const bounded = <A, E, R>(label: string, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.timeoutOrElse({
      duration: "60 seconds",
      orElse: () => Effect.die(new Error(`Timed out waiting for ${label}`))
    })
  )
const host = runtime === "bun"
  ? (await import("../../src/internal/BunControl.ts")).native
  : (await import("../../src/internal/NodeControlHost.ts")).native
trace("platform imported")
const root = await mkdtemp(join(tmpdir(), `smithers-native-${runtime}-`))
try {
  await mkdir(join(root, "flows", "native"), { recursive: true })
  await writeFile(
    join(root, "flows", "native", "flow.ts"),
    `
import * as Flow from "@smthrs/core/Flow"
import { Schema } from "effect"
export default ({  name: "native", description: "Portable native delegate", input: Schema.Struct({ value: Schema.String }), output: Schema.String,
  capabilities: [], flows: ["portable/Delegate"], effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "sealed" }  })
`
  )
  const Probe = Action.make("portable/Probe", {
    payload: { value: Schema.String },
    success: Schema.String,
    error: Schema.Unknown
  })
  const Delegate = Flow.make("portable/Delegate", {
    payload: Executable.Invocation,
    success: Schema.String,
    error: Schema.Unknown,
    body: ({ input }) => Probe.call({ value: (input as { value: string }).value })
  })
  const calls: string[] = []
  const entered = Deferred.makeUnsafe<void>()
  let interrupted = false
  const steeringSeen: string[] = []
  const registrations = Layer.mergeAll(
    Interpreter.layer(Delegate),
    Probe.toLayer(({ value }) =>
      Effect.suspend(() => {
        if ((recovery || drift || cancel) && !interrupted) {
          interrupted = true
          // Let shutdown overlap the real action's interruption cleanup.
          return Deferred.succeed(entered, undefined).pipe(Effect.andThen(
            Effect.never.pipe(Effect.ensuring(driftRescan ? Effect.sleep("100 millis") : Effect.void))
          ))
        }
        return Effect.gen(function*() {
          if (recovery) {
            const source = yield* Steering.Source
            const drain = yield* source.drain({ boundary: "frame-0", wouldIdle: false })
            steeringSeen.push(JSON.stringify(drain.inserts))
            const replay = yield* source.drain({ boundary: "frame-0", wouldIdle: false })
            assert.deepEqual(replay.inserts, drain.inserts)
            assert.equal(replay.duplicate, true)
          }
          calls.push(value)
          return value
        })
      })
    )
  )
  const modules = Executable.layer({
    delegates: [Delegate],
    load: () =>
      Effect.succeed({
        default: ({
          // The registry name the module's path derives.
          name: "native",
          description: "Portable native delegate",
          input: Schema.Struct({ value: Schema.String }),
          output: Schema.String,
          capabilities: [],
          flows: ["portable/Delegate"],
          effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "sealed" }
        })
      })
  }).pipe(Layer.provideMerge(registrations), Layer.orDie)
  const observe = (control: Control.Service, runId: string) =>
    control.watch({ runId, follow: true }).pipe(
      Stream.takeUntil((event) => event.kind === "control.engine.projection-settled"),
      Stream.runCollect,
      (effect) => bounded("native projection settlement", effect),
      Effect.tap((events) =>
        Effect.sync(() => {
          assert(events.some((event) => event.kind === "control.engine.projection-started"))
          assert(events.some((event) => event.kind === "control.engine.event"))
          assert(events.some((event) => event.kind === "control.engine.projection-settled"))
          const gaps = events.filter((event) => event.kind === "control.engine.projection-gap")
          assert.equal(gaps.length, 0, JSON.stringify(gaps))
        })
      )
    )
  let runId: string | undefined
  trace("opening configured host")
  await Effect.runPromise(Effect.scoped(
    Effect.gen(function*() {
      trace("configured host opened")
      const control = yield* Control.Control
      const card = yield* control.plan({ flowId: "native", input: { value: "native-executed" } })
      yield* control.approve(card.approval)
      const receipt = yield* control.run({
        _tag: "Plan",
        planId: card.planId,
        digest: card.digest,
        envelope: card.envelope,
        idempotencyKey: "portable"
      })
      assert.equal(receipt._tag, "Accepted")
      if (receipt._tag !== "Accepted" || receipt.runId === undefined) throw new Error("expected run")
      runId = receipt.runId
      trace("run accepted")
      if (cancel) {
        yield* bounded("native action before cancellation", Deferred.await(entered))
        yield* control.cancel({ runId, idempotencyKey: "portable-cancel" })
        const events = yield* observe(control, runId)
        const requests = events.filter((event) => event.kind === "control.engine.event").map((event) =>
          event.payload as {
            executionId?: string
            sourceId?: string
            payload?: { decision?: string; executionFact?: { observation?: { cancelRequestedAtMs?: number } } }
          }
        ).filter((event) =>
          event.executionId === runId && event.sourceId === "native-control:execution-facts:v1" &&
          event.payload?.decision === "cancel-requested"
        )
        assert.equal(requests.length, 1, "the active native cancellation callback must commit its exact intent once")
        assert.equal(typeof requests[0]?.payload?.executionFact?.observation?.cancelRequestedAtMs, "number")
        const listed = yield* control.list({ _tag: "runs", filters: { runId } })
        assert.equal(listed._tag, "runs")
        if (listed._tag !== "runs" || listed.items[0] === undefined) throw new Error("cancelled run not listed")
        const projected = GatewayProjection.runSummary(listed.items[0], events)
        assert.equal(projected.status, "cancelled")
        assert.equal(projected.executionProvenance?.source, "events", JSON.stringify(projected.executionProvenance))
        assert.deepEqual(calls, [])
        return
      }
      if (recovery || drift) {
        yield* bounded("the initial native action", Deferred.await(entered))
        if (recovery) {
          yield* control.steer({
            runId,
            message: {
              messageId: "portable-steer",
              runId,
              body: "Keep the durable root steering",
              principal: { id: "local", kind: "human", stampedAt: 1 },
              createdAt: 1
            },
            idempotencyKey: "portable-steer"
          })
          if (driftRescan) {
            // A monitoring read of an active run refreshes the live registry's
            // current-code snapshot while its native action is still in flight.
            const listed = yield* bounded(
              "native in-flight monitoring read",
              control.list({ _tag: "runs", filters: { runId } })
            )
            assert.equal(listed._tag, "runs")
            if (listed._tag !== "runs") throw new Error("expected monitored runs")
            assert.equal(listed.items[0]?.runId, runId)
            assert.deepEqual(calls, [], "the native action must still be in flight during the drift rescan")
            trace("in-flight run monitored")
          }
        }
        trace("native action entered")
        return
      }
      const events = yield* control.watch({ runId: receipt.runId, follow: true }).pipe(
        Stream.filter((event) => event.kind === "control.run.completed" || event.kind === "control.run.failed"),
        Stream.take(1),
        Stream.runCollect,
        (effect) => bounded("control completion", effect)
      )
      assert.equal(events[0]?.kind, "control.run.completed")
      assert.deepEqual(calls, ["native-executed"])
      yield* observe(control, receipt.runId)
    }).pipe(Effect.provide(host.layerHost({ root, evaluator: ScriptedJudge.layer }, modules)))
  ))
  trace("configured host closed")
  if (recovery || drift) {
    const driver = runtime === "bun" ? await import("bun:sqlite") : await import("node:sqlite")
    const Database = runtime === "bun"
      ? (driver as typeof import("bun:sqlite")).Database
      : (driver as typeof import("node:sqlite")).DatabaseSync
    const read = () => {
      const db = new Database(join(root, ".flows", "engine.db"))
      try {
        return db.prepare("SELECT status FROM flows_runs WHERE run_id = ?").get(runId!) as { status: string }
      } finally {
        db.close()
      }
    }
    assert.equal(read().status, "suspended")
    if (drift) {
      await writeFile(
        join(root, "flows", "native", "flow.ts"),
        `
import * as Flow from "@smthrs/core/Flow"
import { Schema } from "effect"
export default ({  description: "Changed after approval", input: Schema.Struct({ value: Schema.String }), output: Schema.String,
  capabilities: [], flows: ["portable/Delegate"], effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "sealed" }  })
`
      )
    }
    trace("opening ordinary host")
    await Effect.runPromise(Effect.scoped(
      Effect.gen(function*() {
        const control = yield* Control.Control
        trace("ordinary host opened")
        if (drift) {
          const events = yield* control.watch({ runId: runId!, follow: true }).pipe(
            Stream.filter((event) => event.kind === "control.run.completed" || event.kind === "control.run.failed"),
            Stream.take(1),
            Stream.runCollect,
            (effect) => bounded("source drift refusal", effect)
          )
          assert.equal(events[0]?.kind, "control.run.failed", "invalid approved source must fail explicitly")
          assert.deepEqual(calls, [])
          return
        }
        yield* Effect.sleep("2 seconds")
        assert.equal(read().status, "suspended", "ordinary executor must leave a configured module parked")
        assert.deepEqual(calls, [])
      }).pipe(Effect.provide(host.layerHost({ root, evaluator: ScriptedJudge.layer })))
    ))
    trace("ordinary host closed")
    const poll: Effect.Effect<void> = Effect.suspend(() =>
      read().status === "completed"
        ? Effect.void
        : Effect.sleep("50 millis").pipe(Effect.andThen(poll))
    )
    if (!drift) {
      trace("opening recovery host")
      await Effect.runPromise(Effect.scoped(
        Effect.gen(function*() {
          const control = yield* Control.Control
          trace("recovery host opened")
          yield* bounded("native recovery", poll)
          trace("native recovery completed")
          assert.deepEqual(calls, ["native-executed"])
          assert.equal(steeringSeen.length, 1)
          assert(steeringSeen[0]!.includes("Keep the durable root steering"))
          yield* observe(control, runId!)
          trace("native observation settled")
        }).pipe(Effect.provide(host.layerHost({ root, evaluator: ScriptedJudge.layer }, modules)))
      ))
    }
  }
  trace("all host scopes closed")
  process.stdout.write(
    JSON.stringify({
      runtime,
      recovery,
      driftRescan,
      drift,
      cancel,
      passed: true,
      checks: "discovery, approved plan, native delegate, engine/control SQLite, completion, scope shutdown"
    }) + "\n"
  )
} finally {
  await rm(root, { recursive: true, force: true })
}
