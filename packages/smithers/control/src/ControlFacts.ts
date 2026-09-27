/**
 * Versioned control lifecycle facts and their shared read projection.
 * @since 1.0.0
 */

import { Journal, JournalEvent } from "@smthrs/journal"
import { Effect, Schema } from "effect"
import type * as ControlRuntime from "./ControlRuntime.ts"
import * as ControlSchema from "./ControlSchema.ts"

/** This is the control producer contract, independent of the harness journal format.
 * @category facts
 * @since 1.0.0
 */
export const version = 1

/** A committed control snapshot. A baseline claims no history before its sequence.
 * @category facts
 * @since 1.0.0
 */
export const RunFact = Schema.Struct({
  factVersion: Schema.Literal(version),
  baseline: Schema.Literals(["created", "legacy"]),
  run: ControlSchema.RunSummary
})

/** Capture the exact result of a fenced write, inside its journal transaction.
 * @category facts
 * @since 1.0.0
 */
export const runFact = (
  run: ControlSchema.RunSummary,
  baseline: "created" | "legacy" = "legacy"
): typeof RunFact.Type => {
  if (run.executionObservation !== undefined || run.executionView !== undefined) {
    throw new Error("A control fact cannot persist an executor observation")
  }
  return Schema.decodeUnknownSync(RunFact)({ factVersion: version, baseline, run: structuredClone(run) })
}

/** The identity-bearing request admitted with its approval token.
 * @category facts
 * @since 1.0.0
 */
export const ApprovalRequestFact = Schema.Struct({
  factVersion: Schema.Literal(version),
  runId: Schema.String,
  requestId: Schema.String,
  question: Schema.String,
  payload: ControlSchema.ApprovalPayload
})

/** The exact target a committed decision resolves; old target-tag fields remain readable.
 * @category facts
 * @since 1.0.0
 */
export const ApprovalDecisionFact = Schema.Struct({
  factVersion: Schema.Literal(version),
  tokenId: Schema.String,
  approvalTarget: ControlSchema.ApprovalTarget
})

/** Capture and validate the target the decision writer has actually resolved.
 * @category facts
 * @since 1.0.0
 */
export const approvalDecisionFact = (
  tokenId: string,
  approvalTarget: ControlSchema.ApprovalTarget
): typeof ApprovalDecisionFact.Type =>
  Schema.decodeUnknownSync(ApprovalDecisionFact)({
    factVersion: version,
    tokenId,
    approvalTarget: structuredClone(approvalTarget)
  })

/** Commit a fenced control write and the exact resulting lifecycle fact together.
 * @category facts
 * @since 1.0.0
 */
export const commitRun = <E, R>(
  journal: Journal.Service,
  change: Effect.Effect<ControlSchema.RunSummary, E, R>,
  sourceId: string,
  eventType: string,
  detail: Readonly<Record<string, unknown>> = {},
  baseline: "created" | "legacy" = "legacy"
) =>
  journal.transact(Effect.gen(function*() {
    const run = yield* change
    yield* journal.emitDurableUnfenced(
      new JournalEvent.Input({
        runId: JournalEvent.RunId.make(run.runId),
        sourceId: JournalEvent.SourceId.make(sourceId),
        eventType,
        payload: JSON.parse(
          JSON.stringify({ ...detail, runId: run.runId, status: run.status, ...runFact(run, baseline) })
        )
      })
    )
    return run
  }))

/** The token and submit-ready request have one durable admission boundary.
 * @category facts
 * @since 1.0.0
 */
export const commitApprovalRequest = (
  journal: Journal.Service,
  runtime: Pick<ControlRuntime.Service, "registerApproval">,
  input: Omit<typeof ApprovalRequestFact.Type, "factVersion">,
  sourceId: string
) =>
  Effect.suspend(() => {
    const fact = Schema.decodeUnknownSync(ApprovalRequestFact)({ ...structuredClone(input), factVersion: version })
    const target = fact.payload.target
    if (target._tag !== "Node" || target.runId !== fact.runId || target.requestId !== fact.requestId) {
      return Effect.fail(
        new Journal.JournalError({
          code: "invalid_event",
          message: "Approval request identity does not match its target"
        })
      )
    }
    return journal.transact(Effect.gen(function*() {
      const token = yield* runtime.registerApproval(target)
      if (token._tag === "Pending") {
        yield* journal.emitDurableUnfenced(
          new JournalEvent.Input({
            runId: JournalEvent.RunId.make(fact.runId),
            sourceId: JournalEvent.SourceId.make(sourceId),
            eventType: "control.approval.requested",
            payload: JSON.parse(JSON.stringify(fact))
          })
        )
      }
      return token
    }))
  })

/** Honest coverage of the displayed lifecycle; engine rows are a separate authority.
 * @category facts
 * @since 1.0.0
 */
export const LifecycleProvenance = Schema.Struct({
  control: Schema.Literals(["events", "legacy-snapshot", "unverified-snapshot"]),
  execution: Schema.Literals(["control", "engine-observed", "engine-missing"]),
  baseline: Schema.optional(Schema.Literals(["created", "legacy"])),
  fromSequence: Schema.optional(Schema.Number),
  throughSequence: Schema.optional(Schema.Number)
})

/** Submit-ready approval state derived solely from admitted facts.
 * @category facts
 * @since 1.0.0
 */
export interface Approval {
  readonly runId: string
  readonly waitRunId?: string | undefined
  readonly questionProvenance?: "events" | "legacy-observation" | "unverified-observation" | undefined
  readonly requestId: string
  readonly title: string
  readonly request: ControlSchema.ControlEvent["payload"]
  readonly payload: ControlSchema.ApprovalPayload
  readonly requestedAt: number
  readonly status: "pending" | "approved" | "denied"
}

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
const string = (value: unknown): string | undefined => typeof value === "string" ? value : undefined
const key = (runId: string, requestId: string): string => JSON.stringify([runId, requestId])
const lifecycleKinds = new Set([
  "control.run.accepted",
  "control.run.running",
  "control.run.pending",
  "control.run.parked",
  "control.run.waiting-approval",
  "control.run.completed",
  "control.run.failed",
  "control.run.cancelled",
  "control.run.resume",
  "control.run.claimed",
  "control.steer.woke"
])
const consistentStatus = (kind: string, run: ControlSchema.RunSummary): boolean => {
  if (kind === "control.run.pending") return run.status === "accepted"
  if (kind === "control.run.resume" || kind === "control.run.claimed" || kind === "control.steer.woke") return true
  return kind === `control.run.${run.status}`
}
const coordinationFields = [
  "runId",
  "flowId",
  "createdAt",
  "updatedAt",
  "planId",
  "planDigest",
  "ownerId",
  "parkedBy"
] as const

/**
 * One fold for gateway snapshots and subscriptions. Current writers are strict;
 * legacy unnamed decisions may close only a legacy request in the same run.
 * Observed human waits may seed the approval projection without claiming a
 * journaled request. They still require an exact named decision, and share the
 * same digest binding as admitted requests.
 * Duplicate requests never reopen decisions, and a new-style unknown identity
 * never consumes another gate. Snapshot fallback is explicitly unverified.
 * @category facts
 * @since 1.0.0
 */
export const fold = (
  events: ReadonlyArray<ControlSchema.ControlEvent>,
  snapshot?: ControlSchema.RunSummary,
  observedApprovals: ReadonlyArray<Approval> = []
): {
  readonly run: ControlSchema.RunSummary | undefined
  readonly provenance: typeof LifecycleProvenance.Type
  readonly approvals: ReadonlyArray<Approval>
} => {
  let latest: { readonly fact: typeof RunFact.Type; readonly sequence: number } | undefined
  let first: { readonly baseline: "created" | "legacy"; readonly sequence: number } | undefined
  let uncovered = false
  const requests = new Map<string, { readonly row: Approval; readonly versioned: boolean }>()
  for (const row of observedApprovals) {
    if (snapshot !== undefined && row.runId !== snapshot.runId) continue
    const target = row.payload.target
    if (target._tag !== "Node" || target.runId !== row.runId || target.requestId !== row.requestId) continue
    requests.set(key(row.runId, row.requestId), { row: { ...row, status: "pending" }, versioned: true })
  }
  const decisions = new Map<string, { readonly status: "approved" | "denied"; readonly digest?: string }>()
  for (const event of events) {
    if (snapshot !== undefined && event.runId !== snapshot.runId) continue
    const payload = record(event.payload)
    if (lifecycleKinds.has(event.kind) || payload.factVersion !== undefined && event.kind.startsWith("control.run.")) {
      if (
        Schema.is(RunFact)(payload) && payload.run.runId === event.runId &&
        payload.run.executionObservation === undefined && payload.run.executionView === undefined &&
        consistentStatus(event.kind, payload.run)
      ) {
        latest = { fact: payload, sequence: event.sequence }
        first ??= { baseline: payload.baseline, sequence: event.sequence }
        // This full snapshot establishes a new baseline after a gap; the
        // earlier prefix can no longer be claimed as continuously covered.
        if (uncovered) first = { baseline: "legacy", sequence: event.sequence }
        uncovered = false
      } else if (payload.factVersion !== undefined || latest !== undefined) uncovered = true
    }
    if (event.kind === "control.approval.requested") {
      const versioned = payload.factVersion !== undefined
      if (versioned && !Schema.is(ApprovalRequestFact)(payload)) continue
      const runId = string(payload.runId) ?? event.runId
      const requestId = string(payload.requestId)
      if (
        runId === undefined || requestId === undefined || event.runId !== runId ||
        payload.payload === undefined
      ) continue
      // Historical payloads were open JSON. Preserve their read-only display;
      // only the versioned contract can establish exact target correspondence.
      const submitted = payload.payload as ControlSchema.ApprovalPayload
      if (
        versioned &&
        (submitted.target._tag !== "Node" || submitted.target.runId !== runId ||
          submitted.target.requestId !== requestId)
      ) continue
      const identity = key(runId, requestId)
      if (requests.has(identity)) continue
      const decision = decisions.get(identity)
      requests.set(identity, {
        versioned,
        row: {
          runId,
          requestId,
          title: string(payload.question) ?? `Approval needed — ${requestId}`,
          request: event.payload,
          payload: submitted,
          requestedAt: typeof payload.at === "number" && Number.isFinite(payload.at) ? payload.at : event.occurredAt,
          status: decision !== undefined &&
              (decision.digest === undefined || decision.digest === record(record(submitted).target).digest)
            ? decision.status :
            "pending"
        }
      })
    }
    if (event.kind === "control.approval.approved" || event.kind === "control.approval.denied") {
      const status = event.kind === "control.approval.approved" ? "approved" : "denied"
      let identity: string | undefined
      let digest: string | undefined
      if (payload.factVersion !== undefined) {
        if (
          !Schema.is(ApprovalDecisionFact)(payload) || payload.approvalTarget._tag !== "Node" ||
          payload.approvalTarget.runId !== event.runId || payload.tokenId !== payload.approvalTarget.requestId
        ) continue
        identity = key(payload.approvalTarget.runId, payload.approvalTarget.requestId)
        digest = payload.approvalTarget.digest
      } else {
        const tokenId = string(payload.tokenId) ?? string(payload.requestId)
        if (tokenId !== undefined && event.runId !== undefined) identity = key(event.runId, tokenId)
        else {identity = [...requests].find(([, request]) =>
            !request.versioned && request.row.status === "pending" &&
            request.row.runId === event.runId
          )?.[0]}
      }
      if (identity === undefined || decisions.has(identity)) continue
      const request = requests.get(identity)
      if (
        request !== undefined && digest !== undefined && record(record(request.row.payload).target).digest !== digest
      ) continue
      decisions.set(identity, { status, ...(digest === undefined ? {} : { digest }) })
      if (request !== undefined) requests.set(identity, { ...request, row: { ...request.row, status } })
    }
  }
  const matches = !uncovered && latest !== undefined && (snapshot === undefined ||
    coordinationFields.every((field) => latest.fact.run[field] === snapshot[field]) &&
      (snapshot.executionObservation === "observed" || latest.fact.run.status === snapshot.status))
  const run = snapshot === undefined ? uncovered ? undefined : latest?.fact.run : matches
    ? {
      ...snapshot,
      ...latest!.fact.run,
      ...(snapshot.executionObservation === "observed" ?
        {
          status: snapshot.status,
          waitingReason: snapshot.waitingReason,
          parentRunId: snapshot.parentRunId,
          lineageId: snapshot.lineageId,
          roundOrdinal: snapshot.roundOrdinal,
          pendingWaits: snapshot.pendingWaits
        } :
        {})
    }
    : snapshot
  return {
    run,
    provenance: {
      control: uncovered
        ? "unverified-snapshot"
        : latest === undefined
        ? "legacy-snapshot"
        : matches
        ? "events"
        : "unverified-snapshot",
      execution: snapshot?.executionObservation === "observed" ?
        "engine-observed"
        : snapshot?.executionObservation === "missing"
        ? "engine-missing"
        : "control",
      ...(first === undefined ? {} : { baseline: first.baseline, fromSequence: first.sequence }),
      ...(latest === undefined ? {} : { throughSequence: latest.sequence })
    },
    approvals: [...requests.values()].map(({ row }) => row)
  }
}
