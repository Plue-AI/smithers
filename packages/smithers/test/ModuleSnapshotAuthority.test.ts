/** Real control/native children with explicit catalog and verification fault injection. */
import * as ScriptedJudge from "@smthrs/agent/ScriptedJudge"
import { Control } from "@smthrs/control"
import { Action, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import * as Descriptor from "@smthrs/registry/Descriptor"
import * as Executable from "@smthrs/registry/Executable"
import * as Registry from "@smthrs/registry/Registry"
import { Cause, Effect, Exit, Layer, Schema, Stream } from "effect"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as NodeControl from "../src/NodeControl.ts"

const source = `import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"
export default Flow.make("snapshot", {
  description: "Snapshot authority control", payload: {}, success: Schema.Unknown,
  capabilities: [], effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "sealed" },
  body: Node.capture({}, () => Node.succeed(null))
})
`

describe("module snapshot authority", () => {
  it.each(["retain", "refresh", "failed", "digest"] as const)(
    "checks approval and exact executable identity; only successful verification is retained (%s)",
    async (mode) => {
      const root = await mkdtemp(join(tmpdir(), "smithers-module-snapshot-authority-"))
      const observed: Array<number> = []
      const loads: Array<string> = []
      const outcomes: Array<boolean> = []
      const failures: Array<string> = []
      let entries: ReadonlyArray<Executable.Executable> = []
      let approvedDigest: string | undefined
      let verifiedAtFirst = 0
      let verifiedAfterChildren = 0
      try {
        await mkdir(join(root, "flows", "snapshot"), { recursive: true })
        const filename = join(root, "flows", "snapshot", "flow.ts")
        await writeFile(filename, source)
        const Probe = Action.make("snapshot/Probe", { payload: { index: Schema.Number }, success: Schema.Number })
        const Child = Flow.make("snapshot/Child", {
          payload: { index: Schema.Number },
          success: Schema.Number,
          body: Node.capture({}, Probe.call)
        })
        const Dispatch = Action.make("snapshot/Dispatch", { payload: {}, success: Schema.Unknown })
        const Main = Flow.make("snapshot", {
          description: "Snapshot authority control",
          capabilities: [],
          effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "sealed" },
          payload: {},
          success: Schema.Unknown,
          body: Node.capture({}, Dispatch.call)
        })
        // Unit-only loader injection makes catalog replacement deterministic;
        // ModuleSourceSnapshotCli independently uses the actual default loader.
        const base = Executable.layer({
          delegates: [],
          load: () =>
            Effect.succeed({
              default: Main,
              layer: Layer.mergeAll(
                Interpreter.layer(Child),
                Probe.toLayer(({ index }) =>
                  Effect.gen(function*() {
                    observed.push(index)
                    if (index === 1) {
                      verifiedAtFirst = loads.length
                      yield* Effect.promise(() => writeFile(filename, `${source}// edited\n`))
                      if (mode !== "retain") {
                        entries = entries.map((entry) => ({
                          ...entry,
                          descriptor: mode === "digest" && entry.descriptor.body._tag === "Module"
                            ? new Descriptor.FlowDescriptor({
                              ...entry.descriptor,
                              body: new Descriptor.BodyRefModule({
                                ...entry.descriptor.body,
                                contentDigest: "0".repeat(64)
                              })
                            })
                            : entry.descriptor
                        }))
                      }
                    }
                    return index
                  })
                ),
                Dispatch.toLayer(() =>
                  Effect.gen(function*() {
                    const instance = yield* FlowRuntime.FlowInstance
                    for (const index of [1, 2, 3]) {
                      if (index === 3 && mode === "failed") yield* Effect.promise(() => writeFile(filename, source))
                      const exit = yield* Child.execute({ index }, {
                        executionId: `${instance.executionId}/child-${index}`
                      })
                        .pipe(Effect.exit)
                      outcomes.push(Exit.isSuccess(exit))
                      if (Exit.isFailure(exit)) failures.push(Cause.pretty(exit.cause))
                      if (index === 1) verifiedAtFirst = loads.length
                    }
                    verifiedAfterChildren = loads.length
                    return outcomes
                  })
                )
              )
            })
        }).pipe(Layer.orDie)
        const modules = Layer.effect(
          Executable.Catalog,
          Effect.map(Executable.Catalog, (catalog) => {
            entries = catalog.executables
            return {
              get executables() {
                return entries
              },
              refused: catalog.refused
            }
          })
        ).pipe(Layer.provideMerge(base))
        const registry = Layer.effect(
          Registry.Registry,
          Effect.map(Registry.Registry, (service) =>
            Registry.Registry.of({
              ...service,
              loadBody: (name, digest) =>
                Effect.suspend(() => {
                  loads.push(name)
                  return service.loadBody(name, digest)
                })
            }))
        ).pipe(Layer.provide(NodeControl.layerRegistry(root)))
        const engine = NodeControl.engineDurable(root, registry)
        const result = await Effect.runPromise(
          Effect.gen(function*() {
            const control = yield* Control.Control
            const deniedCard = yield* control.plan({ flowId: "snapshot", input: {} })
            const unapproved = yield* control.run({
              _tag: "Plan",
              planId: deniedCard.planId,
              digest: deniedCard.digest,
              envelope: deniedCard.envelope,
              idempotencyKey: "unapproved"
            })
            expect(unapproved._tag).toBe("Parked")
            expect(observed).toEqual([])
            yield* control.deny(deniedCard.approval)
            const card = yield* control.plan({ flowId: "snapshot", input: {} })
            approvedDigest = card.executionDigest
            yield* control.approve(card.approval)
            const receipt = yield* control.run({
              _tag: "Plan",
              planId: card.planId,
              digest: card.digest,
              envelope: card.envelope,
              idempotencyKey: "approved"
            })
            if (receipt._tag !== "Accepted" || receipt.runId === undefined) return yield* Effect.die(receipt)
            return yield* control.watch({ runId: receipt.runId, follow: true }).pipe(
              Stream.takeUntil((event) =>
                event.kind === "control.run.completed" || event.kind === "control.run.failed"
              ),
              Stream.runCollect,
              Effect.timeout("30 seconds")
            )
          }).pipe(
            Effect.provide(
              NodeControl.layerControl({ root, evaluator: ScriptedJudge.layer }, registry, engine, modules)
            ),
            Effect.scoped
          )
        )
        expect(result.at(-1)?.kind).toBe("control.run.completed")
        if (mode === "retain") {
          // A fresh registry has no retained host closure. Durable admission
          // must still verify the approved body after the workspace changes.
          const restored = await Effect.runPromise(
            Effect.gen(function*() {
              const fresh = yield* Registry.Registry
              return yield* fresh.loadBody("snapshot", approvedDigest)
            }).pipe(Effect.provide(NodeControl.layerRegistry(root)), Effect.scoped)
          )
          expect(restored._tag).toBe("Module")
        }
        expect(observed).toEqual(mode === "digest" ? [1] : [1, 2, 3])
        expect(outcomes).toEqual(
          mode === "digest" ? [true, false, false] : [true, true, true]
        )
        expect(verifiedAfterChildren - verifiedAtFirst).toBe(mode === "retain" || mode === "digest" ? 0 : 1)
        expect(failures).toHaveLength(mode === "digest" ? 2 : 0)
        for (const failure of failures) {
          expect(failure).toContain(mode === "digest" ? "approved executable identity" : "body_unavailable")
        }
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
    60_000
  )
})
