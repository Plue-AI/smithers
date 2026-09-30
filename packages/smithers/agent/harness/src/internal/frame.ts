/**
 * The decisions one controller frame takes from what it measured.
 *
 * `CellTurn` seals a model step and runs a cell, and both need a model, a
 * sandbox and an engine. What the frame decides from the result needs none of
 * them: what it did to the run's ledgers, whether a completion is handed back,
 * and which interventions the next frame is handed are functions of the state
 * the frame opened on and the facts it measured. Each phase here returns a
 * value, events included, instead of writing a variable a later exit reads, so
 * each one is read and tested without running a frame.
 *
 * @since 1.0.0-rc.0
 * @private
 */

import { ModelRequest } from "@smthrs/model"
import type * as Evaluator from "@smthrs/model/Evaluator"
import { Effect, Option, type Schema } from "effect"
import * as AgentEvent from "../AgentEvent.ts"
import * as CallLedger from "../CallLedger.ts"
import type { State } from "../CellTurn.ts"
import * as CompletionClaim from "../CompletionClaim.ts"
import type * as ContextWindow from "../ContextWindow.ts"
import type * as EngineLike from "../EngineLike.ts"
import * as FailedCall from "../FailedCall.ts"
import type * as HarnessError from "../HarnessError.ts"
import * as NarrowedCheck from "../NarrowedCheck.ts"
import * as Sufficiency from "../Sufficiency.ts"
import * as TruncatedOutput from "../TruncatedOutput.ts"
import * as UnmovedTree from "../UnmovedTree.ts"
import * as UnresolvedFailure from "../UnresolvedFailure.ts"
import * as VariablesPanel from "../VariablesPanel.ts"
import * as bytes from "./bytes.ts"
import * as DemandText from "./demandText.ts"
import * as elide from "./elide.ts"
import { paidTogether } from "./paidUsage.ts"
import * as UnfinishedWork from "./unfinishedWork.ts"
import * as UnobservedCall from "./unobservedCall.ts"

/** The one journal-event-type table; see `AgentEvent.eventType`. */
const eventType = AgentEvent.eventType

/**
 * The fields of controller state one step changes; everything else is carried.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export type StateChanges = Partial<ConstructorParameters<typeof State>[0]>

/**
 * Whether the frame budget leaves a frame after this one.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const hasNextFrame = (state: State): boolean => state.maxFrames === 0 || state.frame + 1 < state.maxFrames

/**
 * Whether a completion can be handed back: a frame is left to answer in, and
 * spending it cannot end the run at the read-only cap. See `judgeCompletion`.
 *
 * @since 1.0.0-rc.1
 * @private
 */
export const handBackRoom = (state: State, readOnlyFrames: number): boolean =>
  hasNextFrame(state) && (state.readOnlyCap === 0 || readOnlyFrames + 1 < state.readOnlyCap * 2)

/**
 * One call a cell made this frame, as the frame's accounting reads it.
 *
 * Every call the frame settles is remembered so a raise can hand the model its
 * partial work. Without this, one uncaught throw discarded the frame's reads
 * and the next cell re-did them — often raising the same way again. Prime
 * Agent's tool errors return stdout-so-far plus the traceback for exactly this
 * reason.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export interface ObservedCall {
  readonly flow: string
  readonly ok: boolean
  readonly summary: string
  /** Where this call lands in the run's ledger, so a salvage line can name it. */
  readonly ordinal: number
  /**
   * Whether the call reached the engine declaring a write, which is what
   * breaks a read-only run. A call the boundary refused is not one: it
   * declared a write and performed none.
   */
  readonly mutates: boolean
  /**
   * Whether the write behind `mutates` was measured on a tree the host's
   * workspace walk does not cover: the result carried the reserved `mutated`
   * key, which `bash` sets by fingerprinting a container's working directory
   * either side of the command. The read-only cap counts such a write like
   * any other; the unmoved-tree demand and the claim judge need to know that
   * the host digests holding still says nothing about it.
   */
  readonly remote: boolean
  /**
   * What this invocation asked for, as `CellTurn`'s `signatureOf` names it,
   * with the tree it asked about folded in.
   *
   * The repeat ledger reads this one, because the identical command against
   * a pinned tree and against the live tree are two different questions and
   * a run that asks both has learned twice.
   */
  readonly signature: string
  /**
   * The same, with the tree left out: what the call asked, of whatever
   * tree.
   *
   * The check ledgers read this one, because `Sufficiency` matches a
   * failing reading against the passing reading that answered it, and the
   * whole shape this surface exists for takes those two readings of one
   * command over two different trees. Keyed on the tree they would never
   * meet. For a call on the live tree the two are the same string, so
   * nothing that existed before checkpoints re-keys.
   */
  readonly subject: string
  /** The checkpoint this call ran against, when it named one. */
  readonly at: string | undefined
  /** What this invocation asked for, verbatim, for the narrowing ledger. */
  readonly input: Schema.Json
  /** What the call resolved with, verbatim, for the call ledger's digest. */
  readonly value: Schema.Json
  /** What the flow said about a failure, for the call ledger's digest. */
  readonly message: string | undefined
  /** What the flow said about its own failure, when it said it ran nothing. */
  readonly invalidProbe: { readonly reason: string; readonly message: string } | undefined
  /**
   * Whether the result reported a failing exit status about its subject.
   *
   * A call that declared an invalid probe is never failing here, whatever
   * its exit status: the flow itself said the failure was about the command
   * and not about the code, so the result is not a statement about the tree
   * at all. See `UnresolvedFailure` `failed`.
   */
  readonly failing: boolean
  /**
   * Whether the result reported a passing exit status about its subject.
   *
   * Not the negation of `failing`: a flow that reports no exit status is
   * neither, and `Sufficiency` needs the difference between a check that
   * passed and a call that never checked anything. An invalid probe is
   * neither either, for the same reason it is never failing — the flow
   * itself said the result is not a statement about the tree.
   */
  readonly passing: boolean
}

/**
 * States, unambiguously, that a call this frame failed about itself.
 *
 * The whole defect this closes is that `exitCode: 1` reads the same whether the
 * bug reproduced or the command named a test that does not exist. The flow that
 * ran the command is the only party that can tell, so it says so in its result;
 * this turns that into a sentence the next frame cannot summarise away.
 */
const invalidProbeNotice = (calls: ReadonlyArray<ObservedCall>): string | undefined => {
  const lines = calls.flatMap((call) =>
    call.invalidProbe === undefined
      ? []
      : [`- ${call.flow} (${call.invalidProbe.reason}): ${call.invalidProbe.message}`]
  )
  if (lines.length === 0) return undefined
  return `Invalid probe — ${lines.length} call${
    lines.length === 1 ? "" : "s"
  } this frame failed about the command, not about the code:\n${
    lines.join("\n")
  }\nThat result is not a reproduction and is not a regression: it reads identically on a broken tree and on a fixed one, so it can neither prove the bug nor prove the repair. Repair the command before editing anything — find the real names first — and do not store it as \`state.verification\` or name it when you complete.`
}

/**
 * How many distinct call signatures one run carries forward.
 *
 * The ledger is durable controller state, so it is bounded. Sixty-four covers a
 * whole run at the rate a graded wave actually calls flows — its longest run
 * issued 43 calls across 24 frames — so a call is recognised as a repeat
 * however early the run first made it. A run that outlives the bound forgets
 * its oldest distinct calls first, which can cost a demand and can never
 * invent one.
 */
const retainedSignatures = 64

/**
 * Folds one frame's signatures into the run's ledger, newest last and bounded.
 *
 * A repeated signature moves to the newest position rather than taking a
 * second slot, so a run looping on one command cannot push everything it
 * learned earlier out of the ledger.
 */
const remember = (
  known: ReadonlyArray<string>,
  made: ReadonlyArray<string>
): ReadonlyArray<string> => {
  const newest = new Set(known)
  for (const digest of made) {
    newest.delete(digest)
    newest.add(digest)
  }
  const distinct = [...newest]
  return distinct.slice(Math.max(0, distinct.length - retainedSignatures))
}

/**
 * The frame's own record of what it did to the world, computed once and
 * carried out through every exit that continues the run.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export interface Accounting {
  /** Whether the frame changed the workspace, by declaration or by measurement. */
  readonly mutated: boolean
  /** The journal's record of how that answer was reached. */
  readonly observed: AgentEvent.MutationObserved
  /**
   * The digest the frame closed on, when its closing measurement covered the
   * tree; empty otherwise, which makes every demand that reads it inert.
   */
  readonly workspaceDigest: string
  /** This frame's readings of the live tree, in the order they settled. */
  readonly frameChecks: ReadonlyArray<NarrowedCheck.Check>
  /**
   * Every call the frame settled, verbatim, in the order they settled.
   *
   * The ledgers above are what a run carries forward, and they are bounded
   * and lossy on purpose: a durable check entry keeps a clipped label and two
   * exit-status flags, never a result. This is the one place the whole result
   * of a call still exists, and it exists for one frame. `CompletionClaim`
   * quotes the last check out of it; nothing else reads it.
   */
  readonly calls: ReadonlyArray<ObservedCall>
  /** The cell the frame ran, verbatim, for `FailedCall`. */
  readonly source: string
  /** The frame's own broken probes, stated once for whichever exit it takes. */
  readonly probeNotice: string | undefined
  /**
   * Every state field the frame's measurements settle.
   *
   * A continuing exit states only what it changes on top of these, so a field
   * measured here is carried whichever exit the frame leaves by. The read-only
   * streak is one of them: when each exit passed it by hand, the frame's
   * accounting was only as complete as the exit that remembered to.
   */
  readonly facts:
    & StateChanges
    & Required<
      Pick<StateChanges, "readOnlyFrames" | "repeatFrames" | "checks" | "failures" | "mutations" | "remoteMutations">
    >
    & Required<Pick<StateChanges, "openingDigest" | "callLedger" | "reported">>
}

/**
 * What one frame that ran a cell did to the run's ledgers.
 *
 * Read off the calls the cell made and the two workspace measurements either
 * side of them, and nothing else: no model, sandbox or engine is consulted, so
 * a replayed frame accounts exactly as its original attempt did.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const account = (options: {
  /** The state the frame opened on. */
  readonly state: State
  /** Every call the cell made, in the order they settled. */
  readonly calls: ReadonlyArray<ObservedCall>
  /** The workspace before the frame's calls. */
  readonly opened: Option.Option<EngineLike.Observation>
  /** The workspace after them. */
  readonly closed: Option.Option<EngineLike.Observation>
  /** Ids of the trees the frame pinned, oldest first. */
  readonly minted: ReadonlyArray<string>
  /** What the realm holds after the frame, for the variables panel. */
  readonly bindings: ReadonlyArray<VariablesPanel.Binding>
  /** Output the run has been handed as a fragment, this frame's included. */
  readonly captures: ReadonlyArray<TruncatedOutput.Capture>
  /** The cell the frame ran, verbatim; omitted reads as a cell that inspects nothing. */
  readonly source?: string | undefined
}): Accounting => {
  const { calls, closed, opened, state } = options

  // `declaredWrites` is what the frame's calls said about themselves and the
  // measurement is what the workspace says. A measurement adds a mutation
  // nothing declared — the shell redirect this exists for — and it does not
  // take away a declaration made by a call that *succeeded*, because it does
  // not cover the whole world: it stops at a bound, it prunes directories,
  // and it is rooted at one path, so a real edit outside what it covers
  // would read as an idle frame and twice the cap later the run would fail
  // as `read_only_cap` having edited files the whole time.
  //
  // A declaration made by a call that *failed* is a different claim. It says
  // what the call would have written, and a complete measurement that saw
  // the workspace hold still contradicts it directly rather than merely
  // failing to confirm it: nothing was written, so nothing was written
  // outside the bound either. Wave 7 recorded two such frames on one
  // instance — an anchor miss reporting `Failed to find expected lines`, and
  // an edit reporting `oldString does not occur` — each of which cleared a
  // read-only streak the run had not broken. Where the measurement is
  // partial or absent the old rule stands, because then the digest holding
  // still is not evidence of anything.
  const declaredWrites = calls.filter((call) => call.mutates).length
  const measured = Option.isSome(opened) && Option.isSome(closed)
  const covered = measured && opened.value.complete && closed.value.complete
  const standingWrites = calls.filter((call) => call.mutates && (call.ok || !covered)).length
  const mutated = standingWrites > 0 || (covered && opened.value.digest !== closed.value.digest)
  // Writes the host measurement could not have seen. A failed call measured
  // nothing, so only a settled one counts; see `ObservedCall.remote`.
  const remoteWrites = calls.filter((call) => call.ok && call.mutates && call.remote).length
  const closingDigest = Option.match(closed, { onNone: () => "", onSome: (value) => value.digest })

  // The frame's own repetition, measured the same way and carried the same
  // way: a frame repeats when it issued calls, issued none this run had not
  // already issued, and changed nothing. A signature the ledger has
  // forgotten reads as new, which delays a demand and never fabricates one.
  const signatures = calls.map((call) => call.signature)
  const asked = new Set(state.callSignatures)
  const novel = signatures.some((signature) => !asked.has(signature))
  const repeatFrames = signatures.length === 0
    ? state.repeatFrames
    : novel || mutated
    ? 0
    : state.repeatFrames + 1

  // The frame's own checks, and the tree they were taken over.
  //
  // Only a call that succeeded and declared no write is a check: a failed
  // call observed nothing, and a call that changes the workspace is not an
  // observation of it. The digest is the frame's own closing measurement, and
  // only when that measurement covered the tree — under a partial or absent
  // one a moved digest is as likely to be a bound moving as work, and this
  // ledger's entire purpose is to say that the tree changed since a check
  // ran. An empty digest makes an entry inert rather than wrong.
  const workspaceDigest = covered ? closingDigest : ""
  // Where the frame's writes sit among its calls, so a check can be stamped
  // with the tree it actually read. `calls` settle in order, so a check with
  // no standing write after it read the tree the frame closed on, whatever
  // the frame did before it; a check with one after it read an earlier tree
  // and the closing digest would be somebody else's answer. A measurement
  // that moved with nothing declaring it cannot be placed among the calls at
  // all, so that frame stamps nothing as read.
  const standingAt = calls.map((call) => call.mutates && (call.ok || !covered))
  const lastStandingWrite = standingAt.lastIndexOf(true)
  const unattributedMutation = mutated && lastStandingWrite === -1
  const readings = (checkpointed: boolean) =>
    calls.flatMap((call, index) => {
      if (!call.ok || call.mutates || (call.at !== undefined) !== checkpointed) return []
      const recorded = NarrowedCheck.check({
        flow: call.flow,
        signature: call.subject,
        input: call.input,
        // A reading taken against a checkpoint is a reading of a tree that is
        // not this workspace, so it carries no workspace digest: every ledger
        // that reads one asks a question about the tree the run is standing
        // on, and an entry stamped with this frame's digest would answer that
        // question with somebody else's tree. Empty makes it inert there.
        digest: checkpointed ? "" : workspaceDigest,
        failing: call.failing,
        passing: call.passing,
        // Whether the tree stamped above is the tree this call read. Every
        // write the frame declared is a call with a position among these ones,
        // so the answer is positional: a check with no standing write after it
        // read the closing tree, and one with a write after it read a tree
        // that is gone. That is what lets the loop a real agent runs — edit,
        // then run the check that was red, in one frame — hold its own
        // evidence, while `check, then edit` still stamps nothing.
        //
        // A checkpointed reading is stable for a different reason: the tree it
        // read was pinned and cannot move, so the ordering is established by
        // the pin rather than by position — which is exactly what that surface
        // exists to buy, and what the run used to buy by reverting its work.
        stable: checkpointed || (!unattributedMutation && index > lastStandingWrite)
      })
      return recorded === undefined ? [] : [recorded]
    })
  const frameChecks = readings(false)

  return {
    mutated,
    calls,
    source: options.source ?? "",
    observed: new AgentEvent.MutationObserved({
      eventType: eventType.mutationObserved,
      basis: covered ? "observed" : measured ? "partial" : "declared",
      mutated,
      digest: closingDigest,
      paths: Option.match(closed, { onNone: () => 0, onSome: (value) => value.paths }),
      declaredWrites
    }),
    workspaceDigest,
    frameChecks,
    probeNotice: invalidProbeNotice(calls),
    facts: {
      // Seeded from what earlier frames were handed and appended to as this
      // frame's calls settled.
      truncatedOutputs: TruncatedOutput.retain(options.captures),
      workspace: closed,
      // A frame is read-only when it changed nothing; see
      // `State.readOnlyFrames` for why that is measured and not declared.
      // Once the run has written something, a read-only frame that settled a
      // call this run had not issued before holds the streak where it was: it
      // asked a new question about work that exists, which is debugging, not a
      // stall. Before the first write every read-only frame counts, because a
      // run that only ever reads new things is the failure the cap was built
      // for. Zero-call and repeat-only frames always advance it.
      readOnlyFrames: mutated
        ? 0
        : novel && state.mutations > 0
        ? state.readOnlyFrames
        : state.readOnlyFrames + 1,
      repeatFrames,
      callSignatures: remember(state.callSignatures, signatures),
      // Ids this frame pinned: a checkpoint a frame minted before it raised is
      // still a tree the run holds, and forgetting it would leak a stored tree
      // nothing can name.
      checkpointIds: options.minted.length === 0 ? state.checkpointIds : [...state.checkpointIds, ...options.minted],
      // Live readings only. Every consumer of this ledger — the narrowing
      // demand, the unresolved-failure demand, the vacuous-verification notice
      // — asks whether the tree the run is completing on was checked, and a
      // checkpointed reading is not a reading of that tree.
      checks: NarrowedCheck.remember(state.checks, frameChecks),
      // What this frame asked, folded into what the run had already asked. A
      // raise carries it too: a call that settled before the throw is work
      // the run paid for, and the ledger is the only place the next model turn
      // can read it.
      callLedger: CallLedger.remember(state.callLedger, calls),
      // Every call that reported an exit status, writes included, for the
      // claim brake. See `CompletionClaim.record`.
      reported: CompletionClaim.record(state.reported, calls),
      // Which of this frame's checks failed before any change did, and how
      // many frames have changed the workspace. Both, because this is the one
      // ledger a checkpointed reading belongs in: its whole question is an
      // ordering — this failed, then something changed, then that passed — and
      // a pinned tree answers the first half honestly from a frame that also
      // did the changing.
      failures: Sufficiency.remember(state.failures, {
        frame: [...readings(true), ...frameChecks],
        epoch: state.mutations
      }),
      mutations: state.mutations + (mutated ? 1 : 0),
      remoteMutations: state.remoteMutations + remoteWrites,
      // The tree the run was handed, fixed the first time a frame measured one
      // and never restamped. See `State.openingDigest`.
      openingDigest: state.openingDigest !== ""
        ? state.openingDigest
        : Option.match(opened, {
          onNone: () => "",
          onSome: (value) => value.complete ? value.digest : ""
        }),
      // The panel the next frame opens with, stamped by the frame that ran.
      panel: VariablesPanel.stamp(state.panel, options.bindings, state.frame),
      ...(mutated ? { readOnlyGrace: 0, pendingReadOnlyDemand: undefined } : {})
    }
  }
}

/**
 * The distinct terms of everything the harness itself put in front of the run.
 *
 * The prefix zone is exactly that text — the cell contract, the flow catalog,
 * memory, and the task — and nothing else: transcript, observations, and
 * compaction summaries all land in the tail, so no term a model wrote can
 * reach this set. `NarrowedCheck.findOnly` reads it as the vocabulary the run
 * was taught, which no completion may be bounced for repeating: a run that
 * invokes the runner its task prescribes, with the flag its task prescribes,
 * added no condition of its own. Prefix parts that carry no text — a tool
 * declaration, a structured message — teach no terms.
 */
const taughtTerms = (window: ContextWindow.ContextWindow): ReadonlyArray<string> =>
  NarrowedCheck.terms(
    window.segments
      .filter((segment) => segment.zone === "prefix")
      .flatMap((segment) => segment.content)
      .map((part) => "text" in part && typeof part.text === "string" ? part.text : "")
      .join("\n")
  )

/**
 * One completion handed back, and what handing it back costs.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export interface CompletionDemand {
  /** The control event that names the demand in the journal. */
  readonly event:
    | AgentEvent.UnmovedDemanded
    | AgentEvent.UnresolvedDemanded
    | AgentEvent.FailedCallDemanded
    | AgentEvent.UnobservedDemanded
    | AgentEvent.NarrowedDemanded
    | AgentEvent.NarrowOnlyDemanded
    | AgentEvent.ClaimDemanded
  /** The in-frame observation the next frame answers. */
  readonly note: string
  /**
   * Whether the answer this demand takes away may come back as the run's
   * answer when the frame budget runs out; see `CellTurn.budgetMessage`.
   *
   * True for the measured demands except `FailedCall`, whose answer was
   * written over a call that failed. `UnobservedCall` keeps its answer: the
   * brake reads the source, not the sentence, so an answer it refused may be
   * right, and a run that ends on the budget should end on it rather than on
   * a bare notice. Each of the others says the record is
   * missing a fact, not that the sentence is wrong, so a run that spends its
   * last frame and never completes again is better served by the answer it
   * wrote than by a bare budget notice.
   *
   * For the claim brake it depends on which of its two heights fired, because
   * they mean different things. A reading between `CompletionClaim.unsupportedAt`
   * and `CompletionClaim.inventedAt` is a bounce that would let the same
   * sentence stand if the run re-stated it, so discarding it against an
   * exhausted budget would throw away an answer the brake was never going to
   * refuse. A reading at or above `inventedAt` is one the brake *would* refuse:
   * restoring that sentence on the budget notice is how one measured run turned
   * a bounced "the tests pass" into its final answer with a `stop` finish over a
   * repository whose test exits 1. A bounce that cannot be re-judged must not be
   * undone by the budget. See `CompletionClaim.unrecorded`.
   */
  readonly keeps: boolean
  /** The cap the demand spends. */
  readonly spent: StateChanges
}

/**
 * What judging one completion produced: at most one demand, and at most one
 * reading to journal whichever way it went.
 *
 * `observed` exists for the sixth brake alone. The five before it are derived
 * from measurements the journal already carries, so a grader recomputes them
 * and there is nothing to write when they stay silent; the claim brake asks a
 * model, and a reading nobody records is a reading nobody can grade. It is set
 * only where that brake ran and issued no demand — when it does demand, the
 * same event travels on `demand.event`, so exactly one `claim-demanded` is
 * written per evaluation.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export interface CompletionJudgement {
  /** The claim brake's reading, when it ran and issued no demand. */
  readonly observed: AgentEvent.ClaimDemanded | undefined
  /** The demand that hands the completion back, when one of the six issued. */
  readonly demand: CompletionDemand | undefined
  /**
   * The failure the run ends with when the claim brake read a claim the
   * evidence does not support and no bounce was left to spend. It travels on
   * the judgement rather than as the effect's own failure so the caller
   * journals `observed` first: a reading that ends a run is the one a grader
   * most needs, and an effect that failed would take it with it.
   */
  readonly unproven: HarnessError.HarnessError | undefined
  /**
   * The claim brake's whole decision, whenever it read one: the evidence, the
   * questions and the answers behind the three numbers `observed` or the
   * demand carries. Set on every way a reading comes out, because the record a
   * reader reopens a decision from is needed most for the one that acted.
   */
  readonly decision: AgentEvent.DecisionSettled | undefined
  /** The per-sentence decision, when the brake asked for one. */
  readonly sentenceDecision?: AgentEvent.DecisionSettled | undefined
  /**
   * Whether the completion reported its own work unfinished, when the verdict
   * asked. See `UnfinishedWork`.
   */
  readonly unfinishedDecision?: AgentEvent.DecisionSettled | undefined
}

/** Nothing to say about this completion: it stands. */
const stands: CompletionJudgement = {
  observed: undefined,
  demand: undefined,
  unproven: undefined,
  decision: undefined
}

/** One demand, with the brake's decision beside it when the brake issued it. */
const handBack = (demand: CompletionDemand, decision?: AgentEvent.DecisionSettled): CompletionJudgement => ({
  observed: undefined,
  demand,
  unproven: undefined,
  decision
})

/**
 * The prose the harness itself put in front of the run as its task.
 *
 * The `instructions` segments of the prefix zone and nothing else: `Agent`
 * writes the task there, while the cell contract, the flow catalog, the
 * project's instructions and the host's memory go in as `system` and the
 * transcript goes in the tail. So this is the closest thing the controller holds to the task as
 * the person stated it, and it cannot pick up a sentence the model wrote.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const taskText = (window: ContextWindow.ContextWindow): string =>
  window.segments
    .filter((segment) => segment.zone === "prefix" && segment.kind === "instructions")
    .flatMap((segment) => segment.content)
    .map((part) => "text" in part && typeof part.text === "string" ? part.text : "")
    .filter((text) => text !== "")
    .join("\n\n")

/**
 * The last reading of the completing frame that reported an exit status.
 *
 * The verbatim result exists for exactly one frame, the one being judged, so
 * this is the only check the brake can quote in full, and a completing frame
 * that ran none sends none rather than sending a description of one.
 *
 * It is not the run's evidence, only the newest page of it. `CompletionClaim.record`
 * is the rest, and the two are separate because one measured live failure was
 * exactly the difference: a run that fixed the planted bug, ran the
 * repository's test, and then ran `git diff` to show its work sent the
 * `git diff` and not the test, so its true sentence reported a result nothing
 * in the payload recorded. See `CompletionClaim.Evidence`.
 */
const lastCheck = (calls: ReadonlyArray<ObservedCall>): CompletionClaim.Check | undefined => {
  for (let index = calls.length - 1; index >= 0; index--) {
    const call = calls[index]!
    if (!call.ok || call.mutates) continue
    const status = UnresolvedFailure.exitStatus(call.value)
    if (status === undefined) continue
    return {
      command: CompletionClaim.quote(call.input),
      exitCode: status,
      output: CompletionClaim.newest(CompletionClaim.quote(call.value))
    }
  }
  return undefined
}

/**
 * The demands a completion's own measurements produce, in precedence order —
 * `FailedCall`, `UnobservedCall`, then the three below — or nothing. The
 * `UnmovedTree` demand is not one of them: an unmoved tree is the right tree
 * for a question, so it is issued only when the claim brake reads the
 * completion as unsupported. See `judgeCompletion`. Every fact read here was taken by the frame that is
 * completing or by an earlier one, so this is a pure function of the state
 * and the accounting and it is what `judgeCompletion` consults first.
 *
 * @since 1.0.0-rc.0
 * @private
 */
const measuredDemand = (
  state: State,
  accounting: Accounting,
  contextWindow: ContextWindow.ContextWindow,
  nextFrame: number,
  claim: string
): CompletionDemand | undefined => {
  const { calls, facts, frameChecks, workspaceDigest } = accounting
  // First, because the others read a record this completion was written
  // without: its own cell failed a call before the claim existed. It is the
  // one measured demand whose answer is not kept, because the answer it takes
  // away is the sentence written blind. See `FailedCall`.
  if (state.failedCallDemands < FailedCall.cap) {
    const failures = FailedCall.find(calls, claim, accounting.source)
    if (failures.length > 0) {
      return {
        event: new AgentEvent.FailedCallDemanded({
          eventType: eventType.failedCallDemanded,
          failures: failures.map((failure) => ({ flow: failure.flow, message: failure.message })),
          nextFrame
        }),
        note: FailedCall.demand(failures),
        keeps: false,
        spent: { failedCallDemands: state.failedCallDemands + 1 }
      }
    }
  }
  // Second, for the same reason: the claim was written before any result of
  // its own cell existed, so every demand below would grade a sentence the
  // model wrote without reading. Kept, unlike the one above: the source was
  // read, not the sentence, so it stays the run's answer at the budget. See
  // `UnobservedCall`.
  if (state.unobservedDemands < UnobservedCall.cap) {
    const unread = UnobservedCall.find(calls, accounting.source)
    if (unread.length > 0) {
      return {
        event: new AgentEvent.UnobservedDemanded({
          eventType: eventType.unobservedDemanded,
          calls: unread,
          nextFrame
        }),
        note: UnobservedCall.demand(unread),
        keeps: true,
        spent: { unobservedDemands: state.unobservedDemands + 1 }
      }
    }
  }
  if (state.unresolvedDemands < state.unresolvedCap) {
    const unresolved = UnresolvedFailure.find({ ledger: facts.checks, digest: workspaceDigest })
    if (unresolved !== undefined) {
      return {
        event: new AgentEvent.UnresolvedDemanded({
          eventType: eventType.unresolvedDemanded,
          flow: unresolved.failed.flow,
          failed: unresolved.failed.label,
          instead: unresolved.instead.label,
          currentDigest: workspaceDigest,
          nextFrame
        }),
        note: UnresolvedFailure.demand(unresolved),
        keeps: true,
        spent: { unresolvedDemands: state.unresolvedDemands + 1 }
      }
    }
  }
  if (state.narrowingDemands >= state.narrowingCap) return undefined
  const spent = { narrowingDemands: state.narrowingDemands + 1 }
  const narrowing = NarrowedCheck.find({ ledger: state.checks, frame: frameChecks, digest: workspaceDigest })
  if (narrowing !== undefined) {
    return {
      event: new AgentEvent.NarrowedDemanded({
        eventType: eventType.narrowedDemanded,
        flow: narrowing.earlier.flow,
        broader: narrowing.earlier.label,
        narrower: narrowing.later.label,
        broaderDigest: narrowing.earlier.digest,
        currentDigest: workspaceDigest,
        nextFrame
      }),
      note: NarrowedCheck.demand(narrowing),
      keeps: true,
      spent
    }
  }
  const only = NarrowedCheck.findOnly({
    ledger: facts.checks,
    before: state.checks.map((entry) => entry.signature),
    frame: frameChecks,
    taught: taughtTerms(contextWindow)
  })
  if (only === undefined) return undefined
  return {
    event: new AgentEvent.NarrowOnlyDemanded({
      eventType: eventType.narrowOnlyDemanded,
      flow: only.later.flow,
      check: only.later.label,
      targets: only.targets,
      currentDigest: workspaceDigest,
      nextFrame
    }),
    note: NarrowedCheck.demandOnly(only),
    keeps: true,
    spent
  }
}

/**
 * Whether a `complete` transition stands, or which demand hands it back.
 *
 * The completion's own evidence, judged once per demand. A run gets exactly
 * one frame wrong for free — the last one — and five things can be wrong with
 * it, four of them read off measurements the controller already took, under
 * four caps:
 *
 * 1. `UnmovedTree`: the tree it is completing on is the tree it opened on, so
 *    there is no change for any evidence to be about. This one is not read
 *    alone: a question is answered on the tree it was asked on, so it is
 *    issued only where the claim brake (5) found the completion unsupported,
 *    and then in the brake's place;
 * 2. `UnresolvedFailure`: a check over this exact tree reported a failing exit
 *    status and the run answered it with a different reading of the same
 *    subject rather than with the check itself;
 * 3. `NarrowedCheck.find`: this frame's check repeats an earlier, broader one
 *    and adds conditions to it, run after a change the broader one never saw;
 * 4. `NarrowedCheck.findOnly`: the check this frame ended on is the run's only
 *    reading of what it names — nothing broader was ever taken, so there was
 *    no broader check for (3) to find — and it carries a condition the run
 *    itself added, one taught neither by the prefix this harness wrote nor by
 *    the run's own other checks.
 *
 * Demands 3 and 4 share one cap. They are two readings of one question —
 * whether the evidence covers what it looks like it covers — and a run that
 * answers either has answered the question; a second bounce would be the loop
 * asking it twice in different words.
 *
 * 5. `CompletionClaim`: the last brake and the only one that is not a
 *    measurement. The four above have said nothing, which means the tree
 *    moved, no check was stepped around, and whatever the run checked it
 *    checked whole — and none of that reads the sentence the run wrote. So
 *    the claim, the task, the tree fact, every check the run took over this
 *    tree and the verbatim result of the last one go to Jev, and a claim that
 *    reports a command or a result none of that records hands the frame back
 *    from a cap of its own. It is last because it is the only one
 *    that costs a request, and because a run one of the four already named
 *    has a demand to answer: asking a model to add a second one would hand
 *    the frame two questions. It never falls back: a completion Jev could
 *    not judge — no evaluator on the host, a refusal, a deadline, an answer
 *    that does not decode — fails the turn as `completion_unjudged` carrying
 *    the reason, the way `read_only_cap` ends a run, rather than standing.
 *    `Evaluator` is therefore a required service of this function and of
 *    every turn above it.
 *
 * The fifth is the one that is read on *every* completion, and the three
 * things below that take a demand away do not take the reading away. The
 * others are recomputable from the journal, so skipping them costs a grader
 * nothing and a skipped one lets a completion stand that the truth bar still
 * judges. This one is a sentence being checked against the record, it is what
 * the server banner and the operator docs promise happens to every completion,
 * and the run's answer is the product. So when there is no bounce left to
 * spend — the cap is used up, or none of the room below exists — a claim that
 * reports work the record does not record ends the run as `claim_unproven`
 * instead of standing. That is the shape `read_only_cap` already uses, and it
 * is the only shape that keeps the promise: a cap that stops at the bounce
 * means the second identical claim is accepted unread, which is what a live
 * run did.
 *
 * The verdict is narrower than the bounce, and that is the whole of what this
 * lane changed. A completion the brake merely finds thin is handed back once
 * and then stands; only a completion at `CompletionClaim.inventedAt` — a
 * sentence reporting a command or a result nothing in the run produced — is
 * refused. Arming the verdict on "is the task done" instead killed roughly one
 * honest run in four, including five question-shaped turns in a row and one
 * live CI dispatch whose planted bug was fixed. `CompletionClaim`'s header
 * carries the eighteen-state corpus that measured it.
 *
 * A thin completion that stands is still not a success when it says so
 * itself. Where the verdict is reached on a completion read as not done, one
 * more question asks whether the completion reports its own work unfinished,
 * and one that does ends the run as `completion_incomplete` quoting that
 * report, so a host never settles "I could not finish" as a completed run.
 * See `UnfinishedWork`.
 *
 * At most one is named, in that order, because they are in descending order of
 * how fundamental the missing thing is: there is nothing to check, then the
 * check said no, then the check said less than it looks like it said, then
 * nothing in the record matches what the run said it did. Naming two at once
 * would ask the run to answer a question it has not been given a frame for.
 *
 * The loop names what is missing and hands the frame back; it does not re-run
 * anything, and it does not judge the answer that comes back.
 *
 * Asking costs the run a frame it can answer in, so a demand is issued only
 * where that frame exists, and three separate things take it away (and leave
 * the claim brake reading anyway, as above):
 *
 * - the frame budget, which has no frame left to spend, and turning a
 *   completion into an exhausted budget would lose the run's answer to make a
 *   point about it;
 * - the read-only cap, which is the other budget that ends a run and ends it as
 *   a typed failure carrying nothing. A run that changed nothing is exactly the
 *   run `UnmovedTree` fires on, so a completion one frame short of twice the
 *   cap would be bounced, spend that frame reading, and die as `read_only_cap`
 *   with the answer it had already written discarded — a demand turning a
 *   finished run into a failure, which is the one outcome none of these may
 *   produce;
 * - a demand this run has already answered. Each demand ends by promising that
 *   what comes back next is the answer that stands, and three of them fire on
 *   one transition, so the frame written to answer one is never judged by the
 *   next. See `State.demandedFrame`.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const judgeCompletion = (
  state: State,
  accounting: Accounting,
  contextWindow: ContextWindow.ContextWindow,
  claim: string,
  read: typeof CompletionClaim.read = CompletionClaim.read
): Effect.Effect<CompletionJudgement, HarnessError.HarnessError, Evaluator.Evaluator> =>
  Effect.gen(function*() {
    const { calls, facts, workspaceDigest } = accounting
    const room = handBackRoom(state, facts.readOnlyFrames) && state.demandedFrame !== state.frame
    const nextFrame = state.frame + 1
    if (room) {
      const measured = measuredDemand(state, accounting, contextWindow, nextFrame, claim)
      // A measured demand names a missing fact, so the answer it takes away
      // is worth restoring if the budget runs out, unless the demand says the
      // answer was written blind. See `CompletionDemand`.
      if (measured !== undefined) return handBack(measured)
    }

    // The sixth brake, and the only one that leaves this package to decide.
    // `claimCap` of zero disarms it: no request, no event, no failure, which
    // is what a host that does not want a model in this path asks for.
    if (state.claimCap === 0) return stands
    // A host may put prior conversation before the current request. Keep
    // both ends of the task; clipping its head alone can leave only history.
    // Reserve the elision notice inside the task's byte budget.
    const originalTask = taskText(contextWindow).trim()
    const recallTask = "the run record has the whole task"
    const task = elide.middle(
      originalTask,
      CompletionClaim.proseBytes - elide.noticeCost(bytes.size(originalTask), recallTask),
      recallTask
    )
    const check = lastCheck(calls)
    const unmovedTree = UnmovedTree.find({
      opened: facts.openingDigest,
      digest: workspaceDigest,
      elsewhere: facts.remoteMutations
    })
    const evidence: CompletionClaim.Evidence = {
      task,
      claim: CompletionClaim.prose(claim),
      // The `UnmovedTree` fact, read the other way round. An unmeasured tree
      // reads as moved, which is the reading that asks for nothing.
      treeMoved: unmovedTree === undefined,
      checksRun: facts.reported,
      callsRun: facts.callLedger.map((entry) => ({
        flow: entry.flow,
        input: entry.subject,
        ok: entry.ok,
        resultSummary: entry.digest
      })),
      ...(check === undefined ? {} : { lastCheck: check })
    }
    const reading = yield* read(evidence)
    if (reading === undefined) return stands
    const found = CompletionClaim.find(reading)
    // One bounce while the cap and a frame allow it; the verdict after that,
    // and only over the readings the verdict is about.
    const bounced = found !== undefined && room && state.claimDemands < state.claimCap
    // An unmoved tree alone is not a demand: a read-only question is answered
    // on exactly the tree it was asked on, and bouncing that answer discarded
    // correct replies (#2937). The tree fact names what is missing only when
    // this reading found the claim unsupported, and then its wording is the
    // more precise of the two, so it takes the bounce while its cap lasts and
    // the reading is journaled beside it as one that did not demand.
    const unmoved = found !== undefined && room && state.unmovedDemands < state.unmovedCap
      ? unmovedTree
      : undefined
    // The third way a reading comes out, stated on the event because nothing
    // downstream can derive it: a reading that neither stands nor hands the
    // frame back is the one that ends the run, and a projection that could not
    // tell it from a reading that stood wrote no card for it. See
    // `AgentEvent.ClaimDemanded.refused`.
    const refused = found !== undefined && !bounced && unmoved === undefined && CompletionClaim.unrecorded(found)
    // A completion read as not done, with no bounce left and nothing to
    // refuse, used to stand here whatever it said, so a run reporting its own
    // work unfinished settled as a completed one (#3009). Whether it said so
    // is one more question, asked only here; see `UnfinishedWork`.
    const unfinished = found !== undefined && !bounced && unmoved === undefined && !refused &&
        reading.complete <= CompletionClaim.disprovenAt
      ? yield* UnfinishedWork.read(evidence, reading.usage)
      : undefined
    const incomplete = unfinished !== undefined && unfinished.unfinished >= UnfinishedWork.reportedAt
    const usage = paidTogether(reading.usage, unfinished?.usage)
    const event = new AgentEvent.ClaimDemanded({
      eventType: eventType.claimDemanded,
      complete: reading.complete,
      overclaims: reading.overclaims,
      invented: reading.invented,
      latencyMs: reading.latencyMs + (unfinished?.latencyMs ?? 0),
      ...(usage === undefined ? {} : { usage }),
      demanded: bounced && unmoved === undefined,
      refused,
      currentDigest: workspaceDigest,
      nextFrame
    })
    // The same reading with what it was a reading OF. `acted` is the two ways
    // a reading changes what the run does next, and a reader that reported no
    // evidence journals no decision: see `CompletionClaim.Reading.asked`.
    const decision = reading.asked === undefined ? undefined : new AgentEvent.DecisionSettled({
      eventType: eventType.decisionSettled,
      scope: state.session,
      frame: state.frame,
      classifier: CompletionClaim.classifier.id,
      digest: CompletionClaim.classifier.digest,
      state: reading.asked.state,
      questions: CompletionClaim.classifier.questions,
      answers: reading.asked.answers,
      latencyMs: reading.latencyMs,
      acted: bounced || refused || unmoved !== undefined || incomplete,
      decidedBy: "jev"
    })
    const unfinishedDecision = unfinished === undefined ? undefined : new AgentEvent.DecisionSettled({
      eventType: eventType.decisionSettled,
      scope: state.session,
      frame: state.frame,
      classifier: unfinished.asked.classifier,
      digest: unfinished.asked.digest,
      state: unfinished.asked.state,
      questions: unfinished.asked.questions,
      answers: unfinished.asked.answers,
      latencyMs: unfinished.latencyMs,
      acted: incomplete,
      decidedBy: "jev"
    })
    // The per-sentence reading, journaled as its own decision because it is
    // one: its own classifier, questions and answers. See
    // `CompletionClaim.sentenceClassifier`.
    const sentenceDecision = reading.sentences === undefined ? undefined : new AgentEvent.DecisionSettled({
      eventType: eventType.decisionSettled,
      scope: state.session,
      frame: state.frame,
      classifier: reading.sentences.classifier,
      digest: reading.sentences.digest,
      state: reading.sentences.state,
      questions: reading.sentences.questions,
      answers: reading.sentences.answers,
      latencyMs: reading.sentences.latencyMs,
      acted: bounced || refused || unmoved !== undefined,
      decidedBy: "jev"
    })
    if (found === undefined) {
      return { observed: event, demand: undefined, unproven: undefined, decision, sentenceDecision }
    }
    if (unmoved !== undefined) {
      return {
        ...handBack({
          event: new AgentEvent.UnmovedDemanded({
            eventType: eventType.unmovedDemanded,
            openedDigest: unmoved.opened,
            currentDigest: unmoved.closed,
            nextFrame
          }),
          note: UnmovedTree.demand(unmoved),
          keeps: !CompletionClaim.unrecorded(found),
          spent: { unmovedDemands: state.unmovedDemands + 1 }
        }, decision),
        observed: event,
        sentenceDecision
      }
    }
    if (bounced) {
      return {
        ...handBack({
          event,
          note: CompletionClaim.demand(),
          // A bounce the brake would not refuse is worth restoring against an
          // exhausted budget; one it would refuse is not. See `CompletionDemand`.
          keeps: !CompletionClaim.unrecorded(found),
          spent: { claimDemands: state.claimDemands + 1 }
        }, decision),
        sentenceDecision
      }
    }
    // Out of bounces. A claim the brake only found thin stands here: it was
    // handed back once, the run answered, and refusing the answer as well is
    // the price that destroyed honest runs. Only an unrecorded claim is
    // refused, and only a completion reporting its own work unfinished fails.
    return {
      observed: event,
      demand: undefined,
      // Either bounce handed the claim back: the unmoved demand spends its
      // own cap in the claim brake's place.
      unproven: refused
        ? CompletionClaim.unproven(found, state.claimDemands + state.unmovedDemands > 0, claim)
        : incomplete
        ? UnfinishedWork.incomplete(reading.complete, unfinished.unfinished, claim)
        : undefined,
      decision,
      sentenceDecision,
      ...(unfinishedDecision === undefined ? {} : { unfinishedDecision })
    }
  })

/**
 * The interventions one ordinary continuing frame hands to the next.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export interface Discipline {
  /** The control events that issue them, in journal order. */
  readonly events: ReadonlyArray<AgentEvent.AgentEvent>
  /** The messages the next frame reads after the steering it was sent. */
  readonly messages: ReadonlyArray<ModelRequest.Message>
  /** What issuing them changes on top of the frame's facts. */
  readonly changes: StateChanges
}

/**
 * The read-only, repeat and sufficiency interventions for a frame that settled
 * a `continue` transition and has a frame after it.
 *
 * The read-only intervention. At the cap the next frame is told, structurally,
 * that it must write something or say why it cannot; a justification is typed
 * data on the transition, is recorded, and buys a bounded quiet spell without
 * resetting the counter that ends the run at twice the cap.
 *
 * A justification buys that spell only when it *answers* a demand this frame
 * was handed. A justification volunteered by a frame nobody asked is recorded —
 * it is a field on the transition and the journal writes the whole transition —
 * and buys nothing. The two cannot be the same price, because the counter runs
 * regardless of which one is written: a run that volunteers one every few
 * frames used to renew the quiet spell before the streak could ever hand the
 * demand out, so the demand was never issued, never journaled, and never got
 * its one chance to redirect the run, while the hard stop at twice the cap —
 * which no grace touches — killed the run anyway. Two SWE-bench waves lost
 * `pydata__xarray-7393` exactly so: ten volunteered justifications, zero
 * `read-only-demanded` events, and death at 24 frames against a cap of 12
 * without the control ever speaking.
 *
 * The convergence intervention. It is journaled when it is *issued* rather than
 * when the next frame answers it, because what answers it is the shape of that
 * frame's calls — which the journal already writes one by one — and not a
 * field on a transition the controller has to wait for. Issuing it restarts the
 * count, so a run that keeps repeating is told once every `repeatCap` frames
 * instead of every frame.
 *
 * The counterweight, and the only notice here that asks for nothing. It is
 * written on the frame that completes the pair rather than at a completion,
 * because its whole purpose is to reach a run that is still deciding whether to
 * keep working — a run at its `complete` transition has already decided. See
 * `Sufficiency`.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const discipline = (
  state: State,
  accounting: Accounting,
  justification: string | undefined
): Discipline => {
  const { facts } = accounting
  const cap = state.readOnlyCap
  const readOnly = !accounting.mutated
  const graceLeft = readOnly ? state.readOnlyGrace : 0
  const justified = readOnly && state.pendingReadOnlyDemand !== undefined &&
    (justification ?? "").trim().length > 0
  // Only a frame that advanced the streak earns the demand: a probing frame
  // holds the streak where it was, and repeating the demand to it every frame
  // would nag a run the cap has already decided is working.
  const advanced = readOnly && facts.readOnlyFrames > state.readOnlyFrames
  const demanded = cap > 0 && advanced && facts.readOnlyFrames >= cap && graceLeft === 0 && !justified
  const repeated = state.repeatCap > 0 && facts.repeatFrames >= state.repeatCap
  const sufficient = state.sufficiencyStated
    ? undefined
    : Sufficiency.find({ ledger: facts.failures, frame: accounting.frameChecks, epoch: facts.mutations })
  const nextFrame = state.frame + 1
  return {
    events: [
      ...(demanded
        ? [
          new AgentEvent.ReadOnlyDemandIssued({
            eventType: eventType.readOnlyDemandIssued,
            streak: facts.readOnlyFrames,
            cap,
            nextFrame
          })
        ]
        : []),
      ...(repeated
        ? [
          new AgentEvent.RepeatDemanded({
            eventType: eventType.repeatDemanded,
            frames: facts.repeatFrames,
            cap: state.repeatCap,
            nextFrame
          })
        ]
        : []),
      ...(sufficient === undefined ? [] : [
        new AgentEvent.SufficiencyObserved({
          eventType: eventType.sufficiencyObserved,
          flow: sufficient.failed.flow,
          failed: sufficient.failed.label,
          passed: sufficient.passed.label,
          epoch: sufficient.failed.epoch,
          nextFrame
        })
      ])
    ],
    messages: [
      ...(accounting.probeNotice === undefined ? [] : [ModelRequest.Message.user(accounting.probeNotice)]),
      ...(demanded ? [ModelRequest.Message.user(DemandText.readOnly(cap, facts.readOnlyFrames))] : []),
      ...(repeated ? [ModelRequest.Message.user(DemandText.repeat(facts.repeatFrames, state.repeatCap))] : []),
      ...(sufficient === undefined ? [] : [ModelRequest.Message.user(Sufficiency.observation(sufficient))])
    ],
    changes: {
      readOnlyGrace: justified ? cap : Math.max(0, graceLeft - 1),
      repeatFrames: repeated ? 0 : facts.repeatFrames,
      ...(sufficient === undefined ? {} : { sufficiencyStated: true }),
      pendingReadOnlyDemand: demanded ? { streak: facts.readOnlyFrames, cap } : undefined
    }
  }
}
