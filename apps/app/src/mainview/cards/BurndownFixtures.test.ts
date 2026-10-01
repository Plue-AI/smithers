import { describe, expect, test } from "bun:test"
import { Exit, Schema } from "effect"
import { ExecutionFact } from "@smthrs/journal"
import * as EngineEvent from "@smthrs/journal/EngineEvent"
import * as JournalEvent from "@smthrs/journal/JournalEvent"
import run3 from "../../../e2e/fixtures/burndown/run-3.json"
import exhausted from "../../../e2e/fixtures/burndown/exhausted.json"
import cancelled from "../../../e2e/fixtures/burndown/cancelled.json"
import sleeping from "../../../e2e/fixtures/burndown/sleeping.json"
import completed from "../../../e2e/fixtures/burndown/completed.json"
import failed from "../../../e2e/fixtures/burndown/failed.json"
import empty from "../../../e2e/fixtures/burndown/empty.json"
import overflow from "../../../e2e/fixtures/burndown/overflow.json"

/*
 * The burndown fixtures as the engine would write them. run-3 was recorded;
 * the rest were synthesized, so each engine row is decoded with the journal's
 * own schemas: a fixture that drifts from the engine fails here, not silently
 * in a projection that reads what the engine never writes.
 */

/* The control bridge's envelope, as FlowGraphStatus.ts and gateway EngineTrace.ts decode it. */
const Envelope = Schema.Struct({
  version: Schema.Literal(1),
  executionId: JournalEvent.RunId,
  generation: JournalEvent.NonNegativeQuantity,
  sequence: JournalEvent.Seq,
  eventId: Schema.String,
  sourceId: JournalEvent.SourceId,
  sourceSequence: JournalEvent.SourceSeq,
  emittedAtMs: JournalEvent.TimestampMs,
  eventType: Schema.NonEmptyString,
  payload: Schema.Json,
  meta: Schema.Json
})

const strict = { onExcessProperty: "error" } as const
const PAYLOADS: Readonly<Record<string, (payload: unknown) => boolean>> = {
  [EngineEvent.nodeEventTypes.nodeScheduled]: (payload) => Exit.isSuccess(Schema.decodeUnknownExit(EngineEvent.NodeScheduledPayload, strict)(payload)),
  [EngineEvent.nodeEventTypes.nodeSettled]: (payload) => Exit.isSuccess(Schema.decodeUnknownExit(EngineEvent.NodeSettledPayload, strict)(payload)),
  // A decision either carries the execution's fact, which must be one, or is a diagnostic naming its decision.
  // A `created` decision keeps only its state's payload: a work child's is the work flow's, the rounds' is the sweep's input.
  "flows.engine.run-decision": (payload) => {
    const fields = payload as { readonly decision?: unknown; readonly executionFact?: unknown; readonly state?: unknown }
    const flowName = (fields.executionFact as { readonly observation?: { readonly flowName?: unknown } } | undefined)?.observation?.flowName
    const decodes = typeof flowName === "string" ? CREATED_STATE[flowName] : undefined
    return typeof fields.decision === "string" && (fields.executionFact === undefined || Schema.is(ExecutionFact.Fact)(fields.executionFact)) &&
      (fields.state === undefined || (fields.decision === "created" && decodes !== undefined && decodes(fields.state)))
  }
}

/*
 * The created payloads the projection reads, as flows/issue-sweep declares
 * them: the work flow's Payload (its placement) and the sweep's Input under
 * `Rounds.child({ input })`. `cloudAgents` is the cloud-overflow input.
 */
const SweepInput = Schema.Struct({
  repo: Schema.String,
  maxAgents: Schema.optional(Schema.Int),
  attempt: Schema.optional(Schema.Int),
  placement: Schema.optional(Schema.Literals(["local", "vm"])),
  landers: Schema.optional(Schema.Int),
  cloudAgents: Schema.optional(Schema.Int)
})
const WorkState = Schema.Struct({
  payload: Schema.Struct({ repo: Schema.String, issue: Schema.Number, placement: Schema.optional(Schema.Literals(["local", "vm", "cloud"])) })
})
const RoundsState = Schema.Struct({ payload: Schema.Struct({ input: SweepInput }) })
const CREATED_STATE: Readonly<Record<string, (state: unknown) => boolean>> = {
  "issue-sweep/work": (state) => Exit.isSuccess(Schema.decodeUnknownExit(WorkState, strict)(state)),
  "issue-sweep/rounds": (state) => Exit.isSuccess(Schema.decodeUnknownExit(RoundsState, strict)(state))
}

const FIXTURES = { "run-3": run3, exhausted, cancelled, sleeping, completed, failed, empty, overflow } as const

describe("every burndown fixture's engine rows decode with the journal's schemas", () => {
  for (const [name, fixture] of Object.entries(FIXTURES)) {
    test(name, () => {
      const rows = (fixture.events as ReadonlyArray<{ readonly kind: string; readonly payload: unknown }>)
        .filter((event) => event.kind === "control.engine.event")
      expect(rows.length).toBeGreaterThan(0)
      const refused = rows.flatMap((row, index) => {
        const envelope = Schema.decodeUnknownExit(Envelope)(row.payload)
        if (Exit.isFailure(envelope)) return [`row ${index}: envelope`]
        const decode = PAYLOADS[envelope.value.eventType]
        if (decode === undefined) return [`row ${index}: unknown event type ${envelope.value.eventType}`]
        return decode(envelope.value.payload) ? [] : [`row ${index}: ${envelope.value.eventType}`]
      })
      expect(refused).toEqual([])
    })
  }
})

test("run-3 keeps every work child's created decision with the payload naming its placement, and the rounds' with the run's input", () => {
  const created = (run3.events as ReadonlyArray<{ readonly payload: { readonly eventType?: string; readonly payload?: { readonly decision?: string; readonly state?: { readonly payload?: { readonly placement?: string } } } } }>)
    .filter((event) => event.payload.eventType === "flows.engine.run-decision" && event.payload.payload?.state !== undefined)
  const work = created.filter((event) => event.payload.payload?.state?.payload?.placement !== undefined)
  expect(work).toHaveLength(42)
  expect(work.every((event) => event.payload.payload?.decision === "created" && event.payload.payload.state?.payload?.placement === "vm")).toBe(true)
  // And the rounds' one, which carries the sweep's input.
  expect(created).toHaveLength(43)
})
