/**
 * Reads one run's journal back into the facts its controller decided on.
 *
 *   import { read } from "./lib/journal-facts.mjs"
 *   const facts = read("journals/django__django-16612-r3/engine.db")
 *
 * The harness writes every fact a completion is judged on: the input and result
 * of every call, the workspace digest each frame closed on, whether that frame
 * moved the tree, and the transition it applied. This rebuilds the controller's
 * own view out of those events and hands it back — frames, the narrowing ledger,
 * the failure ledger, the demands that were issued, tokens and span.
 *
 * It re-runs no detector of its own. `NarrowedCheck`, `Sufficiency`,
 * `UnresolvedFailure` and `UnmovedTree` are imported from `@smthrs/harness`
 * source and asked the same questions `CellTurn` asks them, in the same order
 * and with the same inputs, so a reading taken here and the demand the run
 * actually got cannot drift apart. Everything this module adds is the fold from
 * an event stream back into per-frame state.
 *
 * Three places where the journal is thinner than the controller's memory, all
 * of them documented here rather than guessed at silently:
 *
 * - **Whether a call declared a write** is per frame in the journal, not per
 *   call. A call is treated as mutating when its flow is one of the editing
 *   flows, which is the same list `lib/narrowing-journals.mjs` and
 *   `fixtures/make-fixture.mjs` use. A misclassification can only drop a check
 *   from the ledger, never add one.
 * - **The call signature** is the canonical form of `[flow, input]` rather than
 *   the controller's digest of it. Both are injective over the same value, so
 *   the equivalence classes — which is all any caller asks about — are identical.
 * - **A call's `invalidProbe`** is read off the reserved result key, as
 *   `CellTurn` reads it: a result carrying an object there is a flow saying the
 *   failure was about the command and not about the tree, and is neither failing
 *   nor passing.
 *
 * @since 0.1.0
 */
import * as NarrowedCheck from "../../../packages/smithers/agent/harness/src/NarrowedCheck.ts"
import * as Sufficiency from "../../../packages/smithers/agent/harness/src/Sufficiency.ts"
import * as UnresolvedFailure from "../../../packages/smithers/agent/harness/src/UnresolvedFailure.ts"
import { journalRows } from "./journal-rows.mjs"

/** Flows whose calls change the workspace, so they are never checks. */
const editing = new Set(["write", "edit", "apply_patch"])

/** The reserved result key a flow reports "I could not run this" under. */
const invalidProbeKey = "invalidProbe"

/**
 * A stable, injective rendering of one value, used only as an identity.
 *
 * Keys are emitted in sorted order so two spellings of one input collapse to one
 * signature, which is the whole requirement: nothing reads this text, and
 * nothing outside this module ever sees it.
 */
const canonical = (value) => {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`
}

const probed = (value) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const probe = value[invalidProbeKey]
  return probe !== null && typeof probe === "object" && !Array.isArray(probe)
}

/**
 * Reads a run's journal into the facts its controller decided on.
 *
 * @category conversions
 * @since 0.1.0
 */
export const read = (databasePath) => {
  // `control.db` beside the archived `engine.db` holds the `control.*` rows
  // of a current run; `journalRows` reads both (see lib/journal-rows.mjs).
  const rows = journalRows(
    databasePath,
    "event_type like 'control.%' or event_type = 'flows.time-travel.effect-boundary'"
  )

  const frames = []
  const started = []
  const demands = { unmoved: [], unresolved: [], narrowed: [], narrowOnly: [], readOnly: [], repeat: [], claim: [] }
  // The run's arming as its first frame journaled it: the frame budget and
  // whether a park had anyone to answer it. Absent from a journal that
  // predates `discipline-armed`.
  let armed
  const sufficiencyEvents = []
  const usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0 }
  let seat
  let openedDigest
  let modelCalls = 0
  let firstAt
  let lastAt
  let frame
  // The task as the run was handed it. The first frame's request writes its
  // whole system prefix, in segment order: the cell contract, the flow
  // catalog, any host teaching, memory, and the task last (see `opening` in
  // `@smthrs/agent`'s Agent.ts). Later requests write `system` only when it
  // moved, so the first one is the one read.
  let task = ""

  for (const row of rows) {
    const payload = JSON.parse(row.payload_json)
    if (firstAt === undefined) firstAt = row.emitted_at_ms
    lastAt = row.emitted_at_ms
    switch (row.event_type) {
      case "flows.time-travel.effect-boundary": {
        // The run's opening measurement, recorded as the first frame's
        // `workspace-open` boundary. An incomplete walk says nothing about the
        // tree, so it is read as no measurement at all — the same reading
        // `CellTurn` takes when it fixes `openingDigest`.
        const effect = payload.effect
        if (
          openedDigest === undefined && effect?.kind === "harness/boundary/workspace-open"
          && effect.status === "succeeded" && effect.output?._tag === "Some"
        ) {
          openedDigest = effect.output.value.complete ? effect.output.value.digest : ""
        }
        break
      }
      case "control.agent.model-requested": {
        if (task === "" && payload.purpose === "frame" && Array.isArray(payload.system)) {
          const last = payload.system[payload.system.length - 1]
          if (typeof last === "string") task = last
        }
        break
      }
      case "control.agent.turn-opened":
        if (seat === undefined) seat = payload.seat
        frame = {
          index: frames.length,
          seq: row.seq,
          calls: [],
          basis: "declared",
          digest: "",
          /** Paths the closing workspace measurement covered; zero unmeasured. */
          paths: 0,
          mutated: false,
          declaredWrites: 0,
          transition: "none",
          transitionSeq: undefined,
          // What the model wrote and what its cell printed, as the journal
          // bounded them; a field the journal replaced by a truncation
          // marker reads as empty rather than as the marker's JSON.
          cell: "",
          prose: "",
          printed: "",
          /** `raised` or `rejected` when the cell settled no transition. */
          outcome: "settled"
        }
        frames.push(frame)
        break
      case "control.agent.model-settled":
        modelCalls += 1
        if (frame !== undefined && typeof payload.text === "string") frame.prose = payload.text
        usage.inputTokens += payload.usage?.inputTokens ?? 0
        usage.cachedInputTokens += payload.usage?.cachedInputTokens ?? 0
        usage.outputTokens += payload.usage?.outputTokens ?? 0
        usage.reasoningTokens += payload.usage?.reasoningTokens ?? 0
        break
      case "control.agent.cell-call-started":
        started.push(payload)
        break
      case "control.agent.cell-call-settled": {
        const opened = started.shift()
        if (frame === undefined) break
        const ok = payload.outcome === "success"
        const probe = ok && probed(payload.value)
        frame.calls.push({
          seq: row.seq,
          flow: payload.flowName,
          input: opened?.input ?? null,
          signature: canonical([payload.flowName, opened?.input ?? null]),
          ok,
          mutates: editing.has(payload.flowName),
          failing: ok && !probe && UnresolvedFailure.failed(payload.value),
          passing: ok && !probe && UnresolvedFailure.passed(payload.value)
        })
        break
      }
      case "control.agent.cell-produced":
        if (frame !== undefined && typeof payload.text === "string") frame.cell = payload.text
        break
      case "control.agent.cell-printed":
        if (frame !== undefined && typeof payload.text === "string") frame.printed = payload.text
        break
      case "control.agent.cell-settled":
        if (frame === undefined) break
        if (payload.outcome?._tag === "raised" || payload.outcome?._tag === "rejected") {
          frame.outcome = payload.outcome._tag
        }
        break
      case "control.agent.mutation-observed":
        if (frame === undefined) break
        frame.basis = payload.basis
        frame.digest = payload.digest
        frame.paths = typeof payload.paths === "number" ? payload.paths : 0
        frame.mutated = payload.mutated
        frame.declaredWrites = payload.declaredWrites ?? 0
        break
      case "control.agent.transition-applied":
        if (frame === undefined) break
        frame.transition = payload.transition?._tag ?? "none"
        frame.transitionSeq = row.seq
        break
      case "control.agent.unmoved-demanded":
        demands.unmoved.push({ seq: row.seq, ...payload })
        break
      case "control.agent.unresolved-demanded":
        demands.unresolved.push({ seq: row.seq, ...payload })
        break
      case "control.agent.narrowed-demanded":
        demands.narrowed.push({ seq: row.seq, ...payload })
        break
      case "control.agent.narrow-only-demanded":
        demands.narrowOnly.push({ seq: row.seq, ...payload })
        break
      case "control.agent.read-only-demanded":
        demands.readOnly.push({ seq: row.seq, ...payload })
        break
      case "control.agent.repeat-demanded":
        demands.repeat.push({ seq: row.seq, ...payload })
        break
      case "control.agent.claim-demanded":
        // Written on every reading of the claim brake; `demanded` marks the
        // ones that handed the completion back, which are the ones
        // `State.claimDemands` counts.
        demands.claim.push({ seq: row.seq, ...payload })
        break
      case "control.agent.discipline-armed":
        if (armed === undefined) armed = payload
        break
      case "control.agent.sufficiency-observed":
        sufficiencyEvents.push({ seq: row.seq, ...payload })
        break
      default:
        break
    }
  }

  // The per-frame fold `CellTurn` runs, in its order: this frame's checks are
  // stamped with the tree it closed on, remembered against the epoch the frame
  // *opened* at, and judged against the epoch it closes at.
  let checkLedger = []
  let failureLedger = []
  let mutations = 0
  for (const entry of frames) {
    const workspaceDigest = entry.basis === "observed" ? entry.digest : ""
    entry.epoch = mutations
    // `CellTurn` stamps a check stable when it read the tree the frame closed
    // on, which its position among the frame's calls answers: every write the
    // frame declared is a call, and calls settle in order. Read the same way
    // here, or a replayed journal disagrees with the run that wrote it.
    const covered = entry.basis === "observed"
    const standingAt = entry.calls.map((call) => call.mutates && (call.ok || !covered))
    const lastStandingWrite = standingAt.lastIndexOf(true)
    const unattributedMutation = entry.mutated && lastStandingWrite === -1
    entry.checks = entry.calls.flatMap((call, index) => {
      if (!call.ok || call.mutates) return []
      const recorded = NarrowedCheck.check({
        flow: call.flow,
        signature: call.signature,
        input: call.input,
        digest: workspaceDigest,
        failing: call.failing,
        passing: call.passing,
        stable: !unattributedMutation && index > lastStandingWrite
      })
      return recorded === undefined ? [] : [{ check: recorded, seq: call.seq }]
    })
    const frameChecks = entry.checks.map((held) => held.check)
    entry.ledgerBefore = checkLedger
    entry.failuresBefore = failureLedger
    failureLedger = Sufficiency.remember(failureLedger, { frame: frameChecks, epoch: mutations })
    checkLedger = NarrowedCheck.remember(checkLedger, frameChecks)
    mutations += entry.mutated ? 1 : 0
    entry.closingEpoch = mutations
    entry.workspaceDigest = workspaceDigest
    entry.ledger = checkLedger
    entry.failures = failureLedger
    entry.frameChecks = frameChecks
  }

  const measured = frames.filter((entry) => entry.workspaceDigest !== "")
  const completing = frames.filter((entry) => entry.transition === "complete")

  return {
    frames,
    demands,
    sufficiencyEvents,
    /** The task text the first frame's request carried; empty when the journal predates `model-requested`. */
    task,
    /** The first `discipline-armed` payload, or nothing when the journal has none. */
    armed,
    seat,
    modelCalls,
    usage,
    spanMillis: firstAt === undefined ? 0 : lastAt - firstAt,
    /** The digest the run opened on; empty when the run never measured one. */
    openedDigest: openedDigest ?? "",
    /** The digest the last measured frame closed on; empty when none did. */
    finalDigest: measured.length === 0 ? "" : measured[measured.length - 1].workspaceDigest,
    /** Frames whose transition was `complete`; the last one is what the run submitted on. */
    completing,
    /** Frames that changed the workspace. */
    mutating: frames.filter((entry) => entry.mutated)
  }
}
