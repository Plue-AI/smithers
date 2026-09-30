import { Journal, JournalEvent } from "@smthrs/journal"
import { Effect, Stream } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { Control } from "../src/Control.ts"
import * as ControlExecutor from "../src/ControlExecutor.ts"
import * as Facts from "../src/ControlFacts.ts"
import { ControlRuntime } from "../src/ControlRuntime.ts"
import type { ControlEvent } from "../src/ControlSchema.ts"
import { delegateApproval } from "./ApprovalFixtures.ts"
import { durable, fileBundle } from "./DurableStack.ts"

const directory = mkdtempSync(join(tmpdir(), "smithers-control-facts-"))
afterAll(() => rmSync(directory, { recursive: true, force: true }))
const stack = (name: string) =>
  durable({
    executor: { ...ControlExecutor.makeNoop(), launch: () => Effect.succeed("accepted" as const) },
    database: fileBundle(join(directory, name)),
    approvalAuthority: delegateApproval({ id: "reviewer", kind: "operator" })
  })
const start = Effect.gen(function*() {
  const control = yield* Control
  const card = yield* control.plan({ flowId: "system/test", input: {} })
  yield* control.approve(card.approval)
  const receipt = yield* control.run({
    _tag: "Plan",
    planId: card.planId,
    digest: card.digest,
    envelope: card.envelope,
    idempotencyKey: "facts:launch"
  })
  if (receipt._tag !== "Accepted" || receipt.runId === undefined) return yield* Effect.die("run not admitted")
  return { runId: receipt.runId, envelope: card.envelope }
})
const history = (runId: string) =>
  Effect.gen(function*() {
    const journal = yield* Journal.Journal
    const page = yield* journal.entries({ runId: JournalEvent.RunId.make(runId), limit: 100 })
    return page.entries.map((entry): ControlEvent => ({
      kind: entry.eventType,
      payload: entry.payload as ControlEvent["payload"],
      runId: entry.runId,
      sequence: entry.seq,
      occurredAt: entry.emittedAtMs
    }))
  })
const refuseAfterInsert = (journal: Journal.Service) =>
  Journal.make({
    ...journal,
    emitDurableUnfenced: (input) =>
      Effect.andThen(
        journal.emitDurableUnfenced(input),
        Effect.fail(new Journal.JournalError({ code: "sink_failed", message: "injected after insert" }))
      )
  })

describe("production control fact commit helpers over file SQLite", () => {
  it("rolls back a fenced status and its inserted event, publishes neither, and retries once", async () => {
    const runId = await Effect.runPromise(
      Effect.gen(function*() {
        const runtime = yield* ControlRuntime
        const journal = yield* Journal.Journal
        const { runId } = yield* start
        const before = yield* runtime.getRun(runId)
        const baseline = yield* history(runId)
        expect(Facts.fold(baseline, before).provenance).toMatchObject({ control: "events", baseline: "created" })
        const published: Array<string> = []
        const changes = yield* journal.changes
        yield* Stream.fromSubscription(changes).pipe(
          // The run's own stream: the run store's ownership facts publish on
          // the run's companion stream, which this assertion is not about.
          Stream.runForEach((entry) =>
            Effect.sync(() => {
              if (entry.runId === runId) published.push(entry.eventType)
            })
          ),
          Effect.forkChild
        )
        const change = Effect.flatMap(runtime.claimFence(runId), (fence) => runtime.writeStatus(runId, fence, "failed"))
        yield* Effect.flip(Facts.commitRun(refuseAfterInsert(journal), change, "test/executor", "control.run.failed"))
        expect(yield* runtime.getRun(runId)).toEqual(before)
        expect(yield* history(runId)).toEqual(baseline)
        yield* Effect.sleep("10 millis")
        expect(published).toEqual([])
        const after = yield* Facts.commitRun(journal, change, "test/executor", "control.run.failed", {
          cause: "model refused"
        })
        yield* Effect.sleep("10 millis")
        expect(published).toEqual(["control.run.failed"])
        const facts = yield* history(runId)
        expect(Facts.fold(facts, after).run).toEqual(after)
        expect(facts.at(-1)?.payload).toMatchObject({
          factVersion: 1,
          run: JSON.parse(JSON.stringify(after)),
          cause: "model refused"
        })
        return runId
      }).pipe(Effect.provide(stack("status.sqlite")), Effect.scoped)
    )
    await Effect.runPromise(
      Effect.gen(function*() {
        const runtime = yield* ControlRuntime
        const run = yield* runtime.getRun(runId)
        const facts = yield* history(runId)
        expect(Facts.fold(facts, run).run?.status).toBe("failed")
        expect(Facts.fold(facts, run).provenance.control).toBe("events")
      }).pipe(Effect.provide(stack("status.sqlite")), Effect.scoped)
    )
  })

  it("admits token/request together, and a decided request cannot be re-announced on retry", async () => {
    await Effect.runPromise(
      Effect.gen(function*() {
        const runtime = yield* ControlRuntime
        const journal = yield* Journal.Journal
        const control = yield* Control
        const sql = yield* SqlClient.SqlClient
        const { runId, envelope } = yield* start
        const input = {
          runId,
          requestId: "gate",
          question: "Ship?",
          payload: {
            target: { _tag: "Node" as const, runId, requestId: "gate", digest: "review-v1", envelope },
            scope: "run" as const,
            idempotencyKey: "gate:decision"
          }
        }
        yield* Effect.flip(Facts.commitApprovalRequest(refuseAfterInsert(journal), runtime, input, "test/executor"))
        expect(yield* sql`SELECT token_id FROM control_tokens WHERE run_id = ${runId}`).toHaveLength(0)
        expect((yield* history(runId)).filter((entry) => entry.kind === "control.approval.requested")).toHaveLength(0)
        expect((yield* Facts.commitApprovalRequest(journal, runtime, input, "test/executor"))._tag).toBe("Pending")
        yield* control.approve({ ...input.payload, principal: { id: "reviewer", kind: "operator", stampedAt: 1 } })
        expect((yield* Facts.commitApprovalRequest(journal, runtime, input, "test/executor"))._tag).toBe("Approved")
        const facts = yield* history(runId)
        expect(facts.filter((entry) => entry.kind === "control.approval.requested")).toHaveLength(1)
        expect(Facts.fold(facts).approvals[0]?.status).toBe("approved")
        expect(facts.find((entry) => entry.kind === "control.approval.approved")?.payload).toMatchObject({
          factVersion: 1,
          approvalTarget: input.payload.target
        })
      }).pipe(Effect.provide(stack("approval.sqlite")), Effect.scoped)
    )
  })
})
