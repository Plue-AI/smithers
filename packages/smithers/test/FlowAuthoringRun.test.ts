/**
 * The agent-led builder loop on the bridged stack, with nothing pre-registered.
 *
 * A scripted author writes `flows/authoring-demo/flow.ts` through the engine's
 * workspace sandbox; the engine captures the diff bundle and copies it back;
 * the observer that bridges those records into the control journal rebuilds
 * that one catalog entry before the receipt is readable; and the next plan is
 * a real plan of the file's own graph, which the host then runs.
 *
 * What is real: the registry, the discovery scan, the measured module import,
 * the executable, the control plane, the engine, both journals, the sandbox
 * boundary, the diff bundle, the copy-back and the bridge. Nothing is
 * registered on the authored flow's behalf, and no journal record is
 * hand-written (D-081).
 */
import { Control } from "@smthrs/control/Control"
import type { PlanCard } from "@smthrs/control/ControlSchema"
import { Projections } from "@smthrs/gateway/Projections"
import { Effect } from "effect"
import { expect, it } from "vitest"
import { authoredPath } from "./AuthoringFixture.ts"
import { Engine, relayPrincipal, runOn, stackWith } from "./BridgedEngineRun.ts"

it("authors two source versions through engine copy-back, replans from disk, and runs the edited graph", {
  timeout: 120000
}, async () => {
  await runOn(
    stackWith({ authoring: true }),
    Effect.gen(function*() {
      const control = yield* Control
      const engine = yield* Engine
      const projections = yield* Projections
      const launch = (card: PlanCard) =>
        Effect.gen(function*() {
          yield* control.approve({ ...card.approval, principal: relayPrincipal })
          const result = yield* control.run({
            _tag: "Plan",
            planId: card.planId,
            digest: card.digest,
            envelope: card.envelope,
            idempotencyKey: `run:${card.planId}`
          })
          if (result._tag !== "Accepted" || !result.runId) return yield* Effect.die("No accepted run")
          return result.runId
        })
      /**
       * The barrier a reader of the receipt already crosses.
       *
       * The rebuild runs inside the observation that copies the engine's records
       * into the control journal, and that observation marks itself settled when
       * it has drained. The ENGINE row reaching `completed` is earlier than that
       * and says nothing about the catalog.
       */
      const drained = (runId: string) =>
        Effect.gen(function*() {
          for (let attempt = 0; attempt < 20_000; attempt += 1) {
            const page = yield* projections.snapshot({ _tag: "run-events", runId })
            if (page.rows.some((row) => row.kind === "control.engine.projection-settled")) return
            yield* Effect.sleep("2 millis")
          }
          return yield* Effect.die(`the observation of ${runId} never drained`)
        })

      // Nothing on disk names it, so the host refuses by name rather than
      // answering with a plan of no nodes.
      const before = yield* Effect.flip(control.plan({ flowId: "authoring-demo", input: {} }))
      expect(before._tag).toBe("/control/FlowNotFound")

      const author = yield* launch(yield* control.plan({ flowId: "create-flow", input: { args: "Build a flow" } }))
      expect(yield* engine.settled(author)).toBe("completed")
      yield* drained(author)

      // The plan the host can answer NOW, with no restart: the file's own graph,
      // and every node that names a declaration names the file the run wrote.
      const first = yield* control.plan({ flowId: "authoring-demo", input: {} })
      expect(first.nodes.some((node) => node.id.endsWith(".read"))).toBe(true)
      expect(first.nodes.some((node) => node.id.endsWith(".validate"))).toBe(false)
      expect(new Set((first.graph?.nodes ?? []).map((node) => node.declaredAt?.path)))
        .toEqual(new Set([authoredPath, undefined]))

      const editor = yield* launch(yield* control.plan({ flowId: "create-flow", input: { args: "Add validation" } }))
      expect(yield* engine.settled(editor)).toBe("completed")
      yield* drained(editor)
      const second = yield* control.plan({ flowId: "authoring-demo", input: {} })
      expect(second.nodes.some((node) => node.id.endsWith(".validate"))).toBe(true)
      expect(second.digest).not.toBe(first.digest)

      // Editing the workspace must not change what an earlier approved plan
      // runs. It is refused rather than run: the card was approved against an
      // execution identity this host no longer holds, which is the check
      // `AgentSession.approvedModule` makes before it dispatches a module flow.
      const oldRun = yield* launch(first)
      expect(yield* engine.settled(oldRun)).toBe("failed")
      const run = yield* launch(second)
      expect(yield* engine.settled(run)).toBe("completed")
      // Wait on the bridge's actual completion marker, not the control verdict.
      const records = yield* Effect.gen(function*() {
        for (let attempt = 0; attempt < 2000; attempt += 1) {
          const pages = yield* Effect.forEach(
            [author, editor, oldRun, run],
            (runId) => projections.snapshot({ _tag: "run-events", runId })
          )
          if (
            pages.every((page) => page.rows.some((row) => row.kind === "control.engine.projection-settled"))
          ) return pages.flatMap((page) => page.rows)
          yield* Effect.sleep("2 millis")
        }
        return yield* Effect.die("authoring journal never drained")
      })
      const bridged = records.filter((row) => row.kind === "control.engine.event").map((row) =>
        row.payload as { eventType: string; payload: { changedPaths: string[]; bundleIdentity: string } }
      )
      const captures = bridged.filter((row) => row.eventType === "flows.engine.diff-bundle-captured")
      const copies = bridged.filter((row) => row.eventType === "flows.engine.copy-back-settled")
      expect(captures).toHaveLength(2)
      expect(copies).toHaveLength(2)
      expect(captures.map((row) => row.payload.changedPaths)).toEqual([[authoredPath], [authoredPath]])
      expect(copies.map((row) => row.payload.bundleIdentity).sort()).toEqual(
        captures.map((row) => row.payload.bundleIdentity).sort()
      )
      // The authored flow runs as its own child execution, the way `AgentSession`
      // dispatches an approved module flow, so action settlements are the
      // evidence that the source version actually executed.
      const actions = (runId: string) =>
        records.filter((row) => row.runId === runId && row.kind === "control.engine.event")
          .map((row) => row.payload as { eventType: string; payload: { action?: string; outcome?: string } })
          .filter((row) => row.eventType === "flows.engine.node-settled" && row.payload.outcome === "built")
          .map((row) => row.payload.action)
      expect(actions(oldRun)).toEqual([])
      expect(actions(run)).toContain("authoring/Read")
      expect(actions(run)).toContain("authoring/Validate")
    })
  )
})
