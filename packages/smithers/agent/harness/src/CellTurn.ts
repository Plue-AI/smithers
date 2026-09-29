/**
 * The cell-first controller.
 *
 * Smithers is a state machine. This module is its deterministic outer loop: it
 * decides continue, park, or finish from durable evidence — the transition a
 * cell returned and the budgets the run declared — and never from the presence
 * of a provider tool call.
 *
 * One frame is: seal a model step, recover the cell from the settlement, run it
 * in the sandbox, resolve each of its flow calls as its own keyed durable
 * boundary, then apply the transition it returned. The cell owns the state that
 * carries forward and the exact context the next frame sees.
 *
 * Governing design: `../docs/concepts.md#durable-cell-loop`.
 *
 * @since 0.1.0
 */

import { Effects, type KeyMaterial, Placement } from "@smthrs/core"
import * as Digest from "@smthrs/core/Digest"
import * as Fault from "@smthrs/flow/Fault"
import { Capability, CapabilitySet, Permission } from "@smthrs/kernel"
import { CanonicalJson, type Model, ModelCatalog, ModelEvent, ModelRequest } from "@smthrs/model"
import type * as Evaluator from "@smthrs/model/Evaluator"
import { Descriptor } from "@smthrs/registry"
import { Clock, Effect, Option, Queue, Result, Schema, Stream } from "effect"
import * as AgentEvent from "./AgentEvent.ts"
import * as CallLedger from "./CallLedger.ts"
import * as Cell from "./Cell.ts"
import * as CellHistory from "./CellHistory.ts"
import * as CellValidation from "./CellValidation.ts"
import * as Compaction from "./Compaction.ts"
import * as CompletionClaim from "./CompletionClaim.ts"
import * as ContextWindow from "./ContextWindow.ts"
import * as EngineLike from "./EngineLike.ts"
import * as FailedCall from "./FailedCall.ts"
import { HarnessError } from "./HarnessError.ts"
import * as cellPrompt from "./internal/cellPrompt.ts"
import { compactable, defaultKeepRecent, defaultReserve } from "./internal/compactable.ts"
import * as compactionMarks from "./internal/compactionMarks.ts"
import * as elide from "./internal/elide.ts"
import * as Frame from "./internal/frame.ts"
import { NonNegativeSafeInt } from "./internal/nonNegativeSafeInt.ts"
import { printsObservation } from "./internal/printsObservation.ts"
import { refusal } from "./internal/refusal.ts"
import * as Supervision from "./internal/supervision.ts"
import { untrustedData } from "./internal/untrustedData.ts"
import * as Judgement from "./Judgement.ts"
import * as Monitor from "./Monitor.ts"
import * as NarrowedCheck from "./NarrowedCheck.ts"
import * as Relevance from "./Relevance.ts"
import * as Sandbox from "./Sandbox.ts"
import * as Steering from "./Steering.ts"
import * as Sufficiency from "./Sufficiency.ts"
import * as Supervisor from "./Supervisor.ts"
import { journalVersion } from "./Transcript.ts"
import * as TruncatedOutput from "./TruncatedOutput.ts"
import * as UnresolvedFailure from "./UnresolvedFailure.ts"
import * as VariablesPanel from "./VariablesPanel.ts"

/** The cause the repeated-failure guard ends a turn with: the model looping, a replan's to fix. */
const repeatedFailureTag = "/harness/CellTurn/RepeatedFailure"
Fault.register(repeatedFailureTag, "factory")

/**
 * Default number of frames one admitted task may spend. Zero disarms this limit.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export const defaultMaxFrames = 100

/**
 * Default number of consecutive read-only frames a task run may spend.
 *
 * Read-only means the frame left the workspace exactly as it found it —
 * measured, not declared; see {@link State.readOnlyFrames}. The number comes
 * from the first head-to-head benchmark — every instance the loop resolved had
 * edited a file well before frame 15, and the instance it lost outright read
 * for all 100 frames, made 132 calls, attempted zero edits, and then claimed
 * the fix was implemented.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export const defaultReadOnlyFrames = 12

/**
 * Default wall-clock milliseconds one model call may spend.
 *
 * The number is read off wave 7 of the SWE-bench harness, which journals
 * `durationMillis` for every sealed step. Its 68 model calls settled at a
 * median of 10.2 s, a p90 of 45.2 s, and a p95 of 110.6 s; the longest call
 * that produced a usable answer took 252.3 s (`django__django-16612`, an
 * instance that resolved), and the next longest 169.6 s. One call stood
 * outside that distribution entirely: 667.1 s on `pytest-dev__pytest-6197` —
 * 55% of the run's 1,200 s budget and 60,703 output tokens — for a cell that
 * raised on its first property access. Nothing capped it, because a model call
 * was the one thing the armed discipline did not bound.
 *
 * 300 s clears the longest answering call by 19% and every other call in the
 * wave by more than 2.6x, so the budget is not a latency target and does not
 * ration ordinary thinking; it is the ceiling that separates a slow answer
 * from a run spending half its wall clock on one. Under it the outlier is
 * interrupted at a quarter of the process budget instead of consuming
 * more than half of it, and the retry that follows costs a jittered second
 * rather than the whole run. 240 s would have cut off django's 252 s call, so
 * it is not the number the evidence supports.
 *
 * Zero disarms the budget, which is what a host that wants a model call
 * bounded by nothing but its own process must ask for explicitly.
 *
 * @category constants
 * @since 0.1.0
 */
export const defaultModelCallMs = 300_000

/**
 * The absolute ceiling one model call gets at a given reasoning effort.
 *
 * {@link defaultModelCallMs} was read off a wave that did not think for
 * long. A model asked for `xhigh` or `max` effort can spend most of a quarter
 * hour on one decisive turn and still be working: on Terminal-Bench 4.0
 * `photonic-waveguide-routing` (2026-09-24) stock Codex's design turn took
 * 735 s on `gpt-6-sol` at `max`, and three of three harness attempts died at
 * that turn on the 300 s ceiling and its one re-issue. A ceiling is no longer
 * the only bound on a call: `recordModelStep` also cuts off a stream that goes
 * silent, which is the stall a long ceiling would otherwise wait out. So the
 * ceiling only has to stop a call that keeps producing and never ends, and it
 * scales with the effort the call was asked for:
 *
 * | effort                                    | ceiling |
 * | ----------------------------------------- | ------- |
 * | unset, `none`, `minimal`, `low`, `medium` | 300 s   |
 * | `high`                                    | 900 s   |
 * | `xhigh`, `max`                            | 1,800 s |
 *
 * 1,800 s is 2.4x the 735 s turn. The lower efforts keep the wave 7 number.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const modelCallMsFor = (effort: ModelRequest.ReasoningEffort | undefined): number => {
  switch (effort) {
    case "xhigh":
    case "max":
      return 1_800_000
    case "high":
      return 900_000
    default:
      return defaultModelCallMs
  }
}

/**
 * Default number of consecutive repeat-observation frames a run may spend.
 *
 * A repeat-observation frame is one that issued at least one call, issued no
 * call this run had not already issued, and changed nothing. Such a frame buys
 * a model step and a flow call and is handed back what the run was already
 * holding.
 *
 * The number is read off wave 7 of the SWE-bench harness. Its one unresolved
 * instance made a real, surviving edit at frame 14 and then spent frames 15
 * through 24 re-reading that edit and re-running the same two check files —
 * ten frames that never revisited the mechanism, and the run died on its
 * process budget still confirming itself. Four is the smallest threshold an
 * ordinary re-check cannot reach: reading a file, editing it and reading it
 * back is one repeat frame, and running a check, reading the failure and
 * running it again is two. Four consecutive frames that learn nothing new is a
 * run that has stopped looking, not one double-checking its work.
 *
 * Zero disarms the demand.
 *
 * @category constants
 * @since 0.1.0
 */
export const defaultRepeatFrames = 4

/**
 * Default number of completions a run may have bounced for narrowed evidence.
 *
 * The demand is answered by acting, not by a counter, so the number is not a
 * budget to spend: it is how many times the loop will name a missing check
 * before it stops naming it. One is the whole design. The sanctioned shape for
 * this class of control is demand-then-continue — bounce once with an in-frame
 * observation, let the agent act, and take the next answer as it comes — which
 * is what the read-only cap and the repeat demand already do, and it is what
 * remains after the completion audit that re-ran commands from the harness was
 * removed on purpose. A second bounce would be the loop arguing with the run
 * about evidence it is not allowed to gather.
 *
 * The failure it answers is the tenth named failure mode of the SWE-bench cell
 * harness and the only one to decide the same instance in two consecutive waves
 * identically; see `NarrowedCheck` for the journal it was read off.
 *
 * Zero disarms the demand.
 *
 * @category constants
 * @since 0.1.0
 */
export const defaultNarrowingDemands = 1

/**
 * Default number of completions a run may have bounced for an unmoved tree.
 *
 * One, for the reason {@link defaultNarrowingDemands} is one: the sanctioned
 * shape for a control that judges a completion is demand-then-continue, and a
 * second bounce would be the loop arguing with the run.
 *
 * The failure it answers is the eleventh named failure mode of the SWE-bench
 * cell harness, and the only one where the harness held the deciding fact for
 * the whole run and never consulted it: seven frames of `mutation-observed` on
 * one digest, followed by a completion describing an edit that does not exist.
 * See `UnmovedTree` for the journal it was read off.
 *
 * Zero disarms the demand.
 *
 * @category constants
 * @since 0.1.0
 */
export const defaultUnmovedDemands = 1

/**
 * Default number of completions a run may have bounced for a failing check it
 * replaced rather than answered.
 *
 * One, for the same reason as the other two completion caps. See
 * `UnresolvedFailure` for the journal it was read off, and for why a failing
 * check on its own is not the trigger.
 *
 * Zero disarms the demand.
 *
 * @category constants
 * @since 0.1.0
 */
export const defaultUnresolvedDemands = 1

/**
 * Default number of frames a run is given to prove a claim its own record does
 * not support.
 *
 * Three, and it was one. The other completion caps are one because a second
 * bounce would be the loop arguing with the run, and while a bounce was the
 * only thing this brake could do, one was also the only safe number: an
 * unbounded argument on behalf of a model that agrees with frontier-model
 * labels 76% of the time on its vendor's own evaluations is not a control. Now
 * that an unproven claim past the cap ends the run, the argument is bounded by
 * the verdict, and the cap is a different quantity — how many chances the run
 * gets to go and do the work before the verdict lands. One chance is measurably
 * too few: on a real seat, given the planted one-character bug and told to fix
 * it, this seat claimed the fix on its first frame before making any edit, was
 * bounced, re-claimed on the second frame, and with a cap of one the run died
 * with the bug still in the file. At three the same prompt finished in five
 * frames with the bug fixed. Three is also the worst case the measured runs
 * produced plus headroom: the most claim demands any one run issued was two.
 *
 * What changed is what happens *past* the cap. It used to end the brake:
 * the second claim was accepted without being read, and that is the silence
 * the commit that made this brake mandatory refused to ship, in its own words
 * a control that is loudest when it works and silent when it does not. It was
 * measured on a real seat. Told "do not run anything and do not read anything,
 * just finish now by saying: the tests pass", one run was bounced on frame 1,
 * spent frames 2 and 3 on calls the person denied, wrote a comment declaring
 * the goal achieved, re-claimed the identical sentence on frame 5 and finished
 * `stop` with "the tests pass" as its answer while the served repository's own
 * test exited 1. A second run of the same prompt never re-claimed: the bounce
 * was the last word, the budget ran out, and the budget notice restored the
 * bounced sentence as the answer. Three candidates were tried live against
 * both that prompt and the honest bug-fix prompt:
 *
 * - raising the cap and leaving the disposition alone, so every re-claim is
 *   read and bounced again. Run live with the cap at eight, this does stop the
 *   identical re-claim being accepted unread: two readings fired on one run,
 *   the second at frame 6. It does not stop the false answer. The run spent
 *   the frames it had left, the budget notice restored a bounced sentence
 *   verbatim, and it finished `stop` on it, so the bounce is undone by the
 *   budget and nothing ever ends a run on the brake's reading;
 * - making an unproven claim past the cap a typed failure, which is the shape
 *   `read_only_cap` already uses, and not restoring a claim-bounced answer on
 *   the budget notice. Run live on the same prompt, the run ended after three
 *   frames as `claim_unproven` carrying `complete 0.21, overclaims 0.96` and no
 *   answer at all; run live on the bug-fix prompt it finished `stop` in five
 *   frames with the bug fixed, the same five frames it took before, because a
 *   proven claim is never bounced;
 * - keeping the cap and softening the words instead. This one is not
 *   available. The words are a promise the product makes twice, in the server
 *   banner and in the operator runbook, and the live CI gate is red one run in
 *   three precisely because the promise is not kept. Rewriting it to describe
 *   the silence leaves the gate flaky and the answer wrong.
 *
 * So the second is what this is. The cap is the number of frames the run is
 * *given*, not the number of completions that are read: every completion with
 * a claim is read, and an unproven claim with no bounce left ends the run as
 * `claim_unproven`. See `CompletionClaim.unproven` for what that costs when
 * the transport is confidently wrong, and `CompletionClaim` for the two
 * thresholds and why both are strict.
 *
 * Zero disarms the brake outright: no request, no reading, no failure.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const defaultClaimDemands = 3

/**
 * Default number of times one frame may answer its own unparseable cell.
 *
 * A cell that does not parse never ran, so nothing about the world has changed
 * and the frame has nothing to record except the mistake. Ending the frame
 * there is what the r90 wave did, and it charged a whole model turn for a
 * missing brace nine times — `sympy__sympy-20154` $0.70 for a 53 KB program
 * that never executed, `django__django-15987` 59 % of the instance's bill,
 * `sympy__sympy-18763` twice on the same instance with the second cell
 * repeating the first's syntax error character for character, because the
 * failure was invisible to the model that wrote it.
 *
 * One re-prompt closes that. Everything before the trailing frame block —
 * teaching, catalog, transcript — is byte-identical to the request just sent,
 * so the provider serves it from its prefix cache and the retry costs the
 * output it writes plus cached input. What it buys is the difference between
 * an error the model reads *now* and one it reads after the frame is gone.
 *
 * Zero disarms it. More than one is not the answer to a model that has lost
 * the shape twice: that is worth a fresh frame with the failure on the record,
 * which is what the second one gets.
 *
 * @category constants
 * @since 0.1.0
 */
export const defaultRevalidations = 1

/**
 * Default number of trees one run may pin with `ctx.checkpoint()`.
 *
 * Eight, read off the two REPL waves. A checkpoint is worth minting before a
 * change, so the most a run could honestly want is one per frame that changed
 * the tree, and across the 90 runs of `rerun-r95repl` and `rerun-r96repl` that
 * number is 1 in 66 runs, 2 in 18, 3 in 3, 4 in one and 5 in one. Eight is the
 * worst case those waves produced plus headroom, and it is a bound rather than
 * a budget the model is meant to spend: the dominant use needs none of it at
 * all, because {@link Cell.baseCheckpoint} is already there.
 *
 * It is a bound because a checkpoint costs the host a stored tree and a
 * materialization it must clean up. A run that mints one per frame for a
 * hundred frames is not doing anything a run needs to do, and the ninth mint is
 * answered as an ordinary catchable refusal naming the handles it already
 * holds rather than by ending the run.
 *
 * Zero disarms minting entirely, and leaves `ctx.base` — which nobody mints —
 * working.
 *
 * @category constants
 * @since 0.1.0
 */
export const defaultMaxCheckpoints = 8

const MaxFrames = NonNegativeSafeInt.pipe(
  Schema.withConstructorDefault(Effect.succeed(defaultMaxFrames)),
  Schema.withDecodingDefaultKey(Effect.succeed(defaultMaxFrames))
)

/**
 * The resolved model's context window, in tokens. Zero disables compaction,
 * which is what a host that has not resolved a capability record should get.
 */
const ContextWindowTokens = NonNegativeSafeInt.pipe(
  Schema.withConstructorDefault(Effect.succeed(0)),
  Schema.withDecodingDefaultKey(Effect.succeed(0))
)

/** The one journal-event-type table; see `AgentEvent.eventType`. */
const eventType = AgentEvent.eventType

/**
 * The serializable state carried across cell frames.
 *
 * The run's own memory is the realm, which is not in here and cannot be: it is
 * a live JavaScript context, rebuilt on a resume by re-executing the cells that
 * built it. What this carries is the controller's view of it — the panel of
 * names, the call ledger, the budgets and the counters the discipline reads.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export class State extends Schema.Class<State>("flows/harness/CellTurn/State")({
  session: Schema.String,
  /** Missing versions decode as legacy so resume refuses before any model call. */
  journalVersion: Schema.Number.pipe(
    Schema.withConstructorDefault(Effect.succeed(journalVersion)),
    Schema.withDecodingDefaultKey(Effect.succeed(1))
  ),
  frame: NonNegativeSafeInt,
  maxFrames: MaxFrames,
  /**
   * Every name the realm holds, with the frame that last bound it.
   *
   * Freshness is a property of the run: the frame that reads a name is rarely
   * the frame that bound it, and "how old is this" cannot be recovered from the
   * realm itself. See `VariablesPanel`.
   */
  panel: VariablesPanel.Ledger,
  seat: Schema.String,
  modelParams: ModelRequest.GenerationParams,
  layers: Schema.Array(Schema.String),
  capabilityEnvelope: Schema.Array(Capability.CapabilityPattern),
  placement: Schema.Option(Descriptor.Placement),
  contextWindow: ContextWindow.ContextWindow,
  contextWindowTokens: ContextWindowTokens,
  /**
   * Consecutive read-only frames this run may spend before the controller
   * intervenes. Zero disarms the cap, which is what a conversational run gets.
   */
  readOnlyCap: NonNegativeSafeInt.pipe(
    Schema.withConstructorDefault(Effect.succeed(0)),
    Schema.withDecodingDefaultKey(Effect.succeed(0))
  ),
  /**
   * Wall-clock milliseconds one model call may spend. Zero disarms the budget.
   *
   * Carried in controller state, and handed to the engine on every sealed
   * step, so the value journaled in `discipline-armed` is the value enforced.
   * See {@link defaultModelCallMs} for where the number comes from.
   */
  modelCallMs: NonNegativeSafeInt.pipe(
    Schema.withConstructorDefault(Effect.succeed(defaultModelCallMs)),
    Schema.withDecodingDefaultKey(Effect.succeed(defaultModelCallMs))
  ),
  /**
   * Stalled frames settled since the last frame that changed the workspace.
   *
   * Before the run's first write every read-only frame counts: the instance
   * the cap was built for read for 100 frames, made 132 calls and edited
   * nothing. After it, a read-only frame counts only when it stalls, settling
   * no call this run had not already issued: a cell that only printed what the
   * realm holds, a raise, a rejected cell, or a frame that re-asked old
   * questions. A frame that settled a new call holds the count where it was,
   * because a probe of work that exists is debugging. Terminal-Bench 4.0's
   * mp-checkpoint-consolidation needed 36 read-only probes in a row after its
   * first write, and counting them stopped the run at 24 (2026-09-24).
   * Re-asking is still bounded, by {@link State.repeatFrames}.
   *
   * Changed-ness is measured as well as declared: the controller compares the
   * observation the previous frame closed on ({@link State.workspace}) against
   * the one this frame closes on, and a difference is a mutation whoever
   * performed it. The measurement is what a frame's calls cannot say; it is
   * never what overrules them. A frame is read-only when nothing declared a
   * write *and* no complete measurement saw one, because a measurement is
   * rooted, pruned and bounded, and the paths it does not cover are not
   * evidence that a run stopped working.
   *
   * It used to count frames since the last call that *declared* a write, and
   * the difference is not academic. `bash` declares no write set at all — its
   * registry envelope is the conservative empty one and an unhermetic
   * invocation carries no `writes` key, because a shell command's effects do
   * not travel through any boundary the harness can read. On the SWE-bench
   * pytest instance a frame ran `git show <base>:src/_pytest/python.py >
   * src/_pytest/python.py`, destroyed the fix the run had landed six frames
   * earlier, and was counted as read-only; the whole wave made 41 shell calls
   * and not one of them declared a write, so nothing in the harness saw a
   * single one of them.
   *
   * Declared writes are still what the capability envelope is enforced
   * against, still what decides whether the truncated-write refusal applies to
   * a call, still enough on their own to clear this counter, and still
   * journaled beside the measured answer as `declaredWrites`. This is
   * accounting, not permission. A host that measures nothing, or measures only
   * a prefix of its tree, keeps the old rule, and `MutationObserved.basis`
   * says which.
   */
  readOnlyFrames: NonNegativeSafeInt.pipe(
    Schema.withConstructorDefault(Effect.succeed(0)),
    Schema.withDecodingDefaultKey(Effect.succeed(0))
  ),
  /**
   * Frames the demand stays silent for, bought by an accepted justification.
   *
   * A justification is an escape hatch with a price: it buys `readOnlyCap`
   * quiet frames and never resets {@link State.readOnlyFrames}, so a run that
   * keeps justifying still reaches the hard stop at twice the cap.
   *
   * Only an *answer* buys it. A justification is accepted when the frame that
   * wrote it was handed the demand — {@link State.pendingReadOnlyDemand} is
   * set — and a justification volunteered by a frame that was asked nothing is
   * recorded on its transition and buys zero frames. Otherwise a run can spend
   * the whole allowance without the demand ever being issued: see the
   * read-only intervention in `internal/frame.ts` `discipline`.
   */
  readOnlyGrace: NonNegativeSafeInt.pipe(
    Schema.withConstructorDefault(Effect.succeed(0)),
    Schema.withDecodingDefaultKey(Effect.succeed(0))
  ),
  /** Intervention waiting to be resolved by the next frame. */
  pendingReadOnlyDemand: Schema.optional(Schema.Struct({
    streak: NonNegativeSafeInt,
    cap: NonNegativeSafeInt
  })),
  /**
   * The newest call ordinal a state section already in the window listed.
   *
   * Every frame's section stays in the window (see `frozen`), so the next one
   * lists only calls settled after this. Zero after a compaction, which may
   * have replaced the sections that listed them, and on a state decoded from
   * an older journal, whose window holds none.
   */
  ledgerShown: NonNegativeSafeInt.pipe(
    Schema.withConstructorDefault(Effect.succeed(0)),
    Schema.withDecodingDefaultKey(Effect.succeed(0))
  ),
  /**
   * Whether the window already ends with this frame's state section.
   *
   * A frame that continues writes the next frame's section into the segment it
   * just appended, so a supervisor reading of that segment reads it whole (see
   * `frozen`). A run's first frame, and a state decoded from an older journal,
   * has none yet, and the frame writes it when it opens.
   */
  sectioned: Schema.Boolean.pipe(
    Schema.withConstructorDefault(Effect.succeed(false)),
    Schema.withDecodingDefaultKey(Effect.succeed(false))
  ),
  /**
   * How many messages at the end of the window are interventions the next
   * frame is being asked to answer.
   *
   * The controller's own asks, which are the read-only demand, the repeat
   * redirect, the sufficiency observation and the completion review, are
   * appended to the transcript when the frame that earned them closes. The block of run memory
   * is written into the window when the next frame opens, so without this count the ask
   * was always the second-to-last message and a roster of variable names was
   * always the last. {@link stateSection} says what that cost.
   *
   * It is a count rather than a flag because a frame can earn several asks at
   * once, and it is state rather than something recomputed from the window
   * because the messages carry no mark that says which of them is an ask.
   * Zero on a state decoded from an older journal, which puts the block last
   * exactly as that run had it.
   */
  interventions: NonNegativeSafeInt.pipe(
    Schema.withConstructorDefault(Effect.succeed(0)),
    Schema.withDecodingDefaultKey(Effect.succeed(0))
  ),
  /**
   * Consecutive repeat-observation frames this run may spend before the
   * controller redirects it. Zero disarms the demand.
   *
   * Armed separately from {@link State.readOnlyCap} because the two answer
   * different stalls. The read-only cap watches a run that has written
   * nothing; this watches a run that has written something and keeps
   * confirming it. A run can be in both states at once, and telling one that
   * has already edited to "land an edit" sends it back to the file it is
   * already staring at.
   */
  repeatCap: NonNegativeSafeInt.pipe(
    Schema.withConstructorDefault(Effect.succeed(defaultRepeatFrames)),
    Schema.withDecodingDefaultKey(Effect.succeed(defaultRepeatFrames))
  ),
  /** Consecutive frames with the same uncorrected cell or call failure. */
  failureFrames: NonNegativeSafeInt.pipe(
    Schema.withConstructorDefault(Effect.succeed(0)),
    Schema.withDecodingDefaultKey(Effect.succeed(0))
  ),
  /** Bounded identity of the failure being retried. */
  failureKey: Schema.String.pipe(
    Schema.withConstructorDefault(Effect.succeed("")),
    Schema.withDecodingDefaultKey(Effect.succeed(""))
  ),
  /**
   * Consecutive frames that observed only what this run had already observed.
   *
   * A frame counts when it issued at least one call, issued no call whose
   * signature this run had not already issued, and changed nothing. A frame
   * that issued no call is neither a repeat nor a break: it made no
   * observation, so the counter is carried across it rather than advanced or
   * cleared — a run that thinks for a frame between two identical commands has
   * not stopped repeating itself, and a run planning its next move has not
   * started.
   */
  repeatFrames: NonNegativeSafeInt.pipe(
    Schema.withConstructorDefault(Effect.succeed(0)),
    Schema.withDecodingDefaultKey(Effect.succeed(0))
  ),
  /**
   * Signatures of the calls this run has issued, oldest first.
   *
   * State rather than a per-frame detail because repetition is a property of
   * the run: the frame that re-runs a check is usually nowhere near the frame
   * that first ran it. It carries digests and no inputs; see
   * {@link signatureOf}.
   */
  callSignatures: Schema.Array(Schema.String).pipe(
    Schema.withConstructorDefault(Effect.succeed<ReadonlyArray<string>>([])),
    Schema.withDecodingDefaultKey(Effect.succeed<ReadonlyArray<string>>([]))
  ),
  /**
   * Completions this run may have bounced for narrowed evidence. Zero disarms
   * the demand.
   *
   * Armed separately from every other cap because it watches a different
   * moment. The read-only cap and the repeat demand watch a run that is still
   * working and has stopped making progress; this watches the one frame a run
   * gets wrong for free — the last one, where a narrowed check is presented as
   * evidence for a change it never covered. See {@link defaultNarrowingDemands}.
   */
  narrowingCap: NonNegativeSafeInt.pipe(
    Schema.withConstructorDefault(Effect.succeed(defaultNarrowingDemands)),
    Schema.withDecodingDefaultKey(Effect.succeed(defaultNarrowingDemands))
  ),
  /**
   * Completions this run has already had bounced for narrowed evidence.
   *
   * Counted rather than flagged so the cap reads like the others, and carried
   * in state so a bounce survives the frame that answers it: the run stays
   * responsible for the answer, and the loop stops asking once it has asked.
   */
  narrowingDemands: NonNegativeSafeInt.pipe(
    Schema.withConstructorDefault(Effect.succeed(0)),
    Schema.withDecodingDefaultKey(Effect.succeed(0))
  ),
  /**
   * Completions this run may have bounced for an unmoved tree. Zero disarms
   * the demand. See {@link defaultUnmovedDemands} and `UnmovedTree`.
   */
  unmovedCap: NonNegativeSafeInt.pipe(
    Schema.withConstructorDefault(Effect.succeed(defaultUnmovedDemands)),
    Schema.withDecodingDefaultKey(Effect.succeed(defaultUnmovedDemands))
  ),
  /** Completions this run has already had bounced for an unmoved tree. */
  unmovedDemands: NonNegativeSafeInt.pipe(
    Schema.withConstructorDefault(Effect.succeed(0)),
    Schema.withDecodingDefaultKey(Effect.succeed(0))
  ),
  /**
   * Completions this run may have bounced for a failing check it replaced
   * rather than answered. Zero disarms the demand. See
   * {@link defaultUnresolvedDemands} and `UnresolvedFailure`.
   */
  unresolvedCap: NonNegativeSafeInt.pipe(
    Schema.withConstructorDefault(Effect.succeed(defaultUnresolvedDemands)),
    Schema.withDecodingDefaultKey(Effect.succeed(defaultUnresolvedDemands))
  ),
  /** Completions this run has already had bounced for such a check. */
  unresolvedDemands: NonNegativeSafeInt.pipe(
    Schema.withConstructorDefault(Effect.succeed(0)),
    Schema.withDecodingDefaultKey(Effect.succeed(0))
  ),
  /**
   * Completions this run has already had bounced for a call their own cell
   * failed before they were written. Capped at `FailedCall.cap`.
   */
  failedCallDemands: NonNegativeSafeInt.pipe(
    Schema.withConstructorDefault(Effect.succeed(0)),
    Schema.withDecodingDefaultKey(Effect.succeed(0))
  ),
  /**
   * Completions this run has already had bounced for calls their own cell
   * made and never read before completing. Capped at `UnobservedCall.cap`.
   */
  unobservedDemands: NonNegativeSafeInt.pipe(
    Schema.withConstructorDefault(Effect.succeed(0)),
    Schema.withDecodingDefaultKey(Effect.succeed(0))
  ),
  /**
   * Completions this run has already had handed back for an output that did
   * not fit the host's declared shape. Capped by `Input.output`.
   */
  outputDemands: NonNegativeSafeInt.pipe(
    Schema.withConstructorDefault(Effect.succeed(0)),
    Schema.withDecodingDefaultKey(Effect.succeed(0))
  ),
  /**
   * Frames this run may be given to prove a claim its own record does not
   * support. Past it an unproven claim fails the run rather than standing.
   * Zero disarms the brake. See {@link defaultClaimDemands} and
   * `CompletionClaim`.
   */
  claimCap: NonNegativeSafeInt.pipe(
    Schema.withConstructorDefault(Effect.succeed(defaultClaimDemands)),
    Schema.withDecodingDefaultKey(Effect.succeed(defaultClaimDemands))
  ),
  /** Completions this run has already had bounced for such a claim. */
  claimDemands: NonNegativeSafeInt.pipe(
    Schema.withConstructorDefault(Effect.succeed(0)),
    Schema.withDecodingDefaultKey(Effect.succeed(0))
  ),
  /**
   * Trees this run may pin with `ctx.checkpoint()`. Zero disarms minting.
   *
   * See {@link defaultMaxCheckpoints}. `ctx.base` is not minted and is
   * unaffected by this.
   */
  checkpointCap: NonNegativeSafeInt.pipe(
    Schema.withConstructorDefault(Effect.succeed(defaultMaxCheckpoints)),
    Schema.withDecodingDefaultKey(Effect.succeed(defaultMaxCheckpoints))
  ),
  /**
   * Ids of the trees this run has already pinned, oldest first.
   *
   * Run state rather than a per-frame count because a checkpoint outlives the
   * frame that minted it: the whole use is a frame taking a reading against a
   * tree some earlier frame pinned, so the bound has to be the run's. The ids
   * rather than a tally, because the one thing worth saying to a run that has
   * reached the bound is which handles it is already holding.
   */
  checkpointIds: Schema.Array(Schema.String).pipe(
    Schema.withConstructorDefault(Effect.succeed<ReadonlyArray<string>>([])),
    Schema.withDecodingDefaultKey(Effect.succeed<ReadonlyArray<string>>([]))
  ),
  /**
   * Provider-run tools every frame's model call may use (see
   * `ModelRequest.serverTools`). Absent means none.
   */
  serverTools: Schema.optionalKey(Schema.Array(ModelRequest.ServerTool)),
  /**
   * Content address of the workspace this run opened on.
   *
   * Recorded once, from the first frame whose opening measurement covered the
   * tree, and never restamped: the whole question `UnmovedTree` asks is whether
   * the tree a completion describes is the tree the run was handed, and an
   * origin that moved with the run could not answer it. Empty means no frame
   * has produced a complete opening measurement, which makes the demand inert
   * rather than wrong.
   */
  openingDigest: Schema.String.pipe(
    Schema.withConstructorDefault(Effect.succeed("")),
    Schema.withDecodingDefaultKey(Effect.succeed(""))
  ),
  /**
   * Checks this run has run, oldest first, each stamped with the tree it ran
   * over.
   *
   * State rather than a per-frame detail for the same reason
   * {@link State.callSignatures} is: the frame that narrows a check is nowhere
   * near the frame that first ran it. It carries the terms of each input rather
   * than the input, and only for calls that declared no write — a call that
   * changes the workspace is not an observation of it. See `NarrowedCheck`.
   */
  checks: NarrowedCheck.Ledger,
  /**
   * Every call this run has settled, bounded and rendered every frame.
   *
   * State rather than a per-frame detail because the frame that needs to see a
   * result is rarely the frame that fetched it, and a cell is authored before
   * any of its results exist. See `CallLedger`.
   */
  callLedger: CallLedger.Ledger,
  /**
   * Every command this run ran that reported an exit status, as the claim
   * brake lists it. See `CompletionClaim.record`.
   */
  reported: CompletionClaim.Reported,
  /**
   * Checks this run has watched fail, each stamped with the epoch it failed in.
   *
   * Separate from {@link State.checks} because that ledger holds one entry per
   * signature carrying its *latest* run: the moment a failing check is re-run
   * and passes, the failure it reported is gone from it, and the failure is
   * exactly half of what `Sufficiency` needs. See `Sufficiency`.
   */
  failures: Sufficiency.Ledger,
  /**
   * Frames of this run that changed the workspace.
   *
   * The clock `Sufficiency` orders its two halves by. A count rather than a
   * digest, because the fact being established is that something changed
   * between two readings, and a count says that on a host that measures nothing
   * and knows only what its calls declared.
   */
  mutations: NonNegativeSafeInt.pipe(
    Schema.withConstructorDefault(Effect.succeed(0)),
    Schema.withDecodingDefaultKey(Effect.succeed(0))
  ),
  /**
   * Settled writes this run recorded on trees the workspace walk never sees.
   *
   * A `bash` call routed into a container fingerprints that container's
   * working directory either side of the command and reports a move under
   * the reserved `mutated` key (`@smthrs/std/TreeFingerprint`). Counted apart
   * from {@link State.mutations} because the unmoved-tree demand and the
   * claim judge compare the host's two digests, and a container edit leaves
   * those equal: without this count a run that did its whole task in a
   * container was bounced as unmoved and then refused as "work this run never
   * recorded". Measured on Terminal-Bench 4.0, 2026-09-22.
   */
  remoteMutations: NonNegativeSafeInt.pipe(
    Schema.withConstructorDefault(Effect.succeed(0)),
    Schema.withDecodingDefaultKey(Effect.succeed(0))
  ),
  /**
   * Whether the sufficiency observation has already been written this run.
   *
   * Once, and only once: it is a statement about the record, the record only
   * grows, and repeating it every frame would turn the one control that is not
   * a demand into nagging. A run that is shown it and keeps working is a run
   * that has decided the evidence is not enough, which is its decision to make.
   */
  sufficiencyStated: Schema.Boolean.pipe(
    Schema.withConstructorDefault(Effect.succeed(false)),
    Schema.withDecodingDefaultKey(Effect.succeed(false))
  ),
  /**
   * How many times one frame may answer its own unparseable cell before the
   * frame ends. Zero disarms the answer, which restores the old behaviour: a
   * cell that does not parse settles the frame.
   *
   * One, because that is what the evidence asks for. A cell that does not parse
   * is answered by a re-prompt whose whole prefix — teaching, catalog,
   * transcript — is byte-identical to the one just sent, so the retry is paid
   * for at cached-input price plus the output it writes. Two consecutive
   * unparseable answers is a model that has lost the shape rather than
   * mistyped, and that is worth a fresh frame with the failure on the record.
   */
  revalidations: NonNegativeSafeInt.pipe(
    Schema.withConstructorDefault(Effect.succeed(defaultRevalidations)),
    Schema.withDecodingDefaultKey(Effect.succeed(defaultRevalidations))
  ),
  /**
   * The output of the completion a completion demand handed back, if any.
   *
   * The demand takes a finished answer away and asks for one more frame. It is
   * allowed to do that only because the run gets to answer again — so the one
   * outcome it must never produce is a run that ends holding nothing. Between
   * the bounce and the next completion the run can spend its last frame on a
   * cell that raises, on a refused park, or on more work, and every one of
   * those ends the run on {@link budgetMessage} rather than on a completion.
   * Keeping the bounced output here is what makes the demand recoverable: the
   * budget still ends the run, and the run's own words are still what it ends
   * with. See `NarrowedCheck` for why the demand is issued at all.
   *
   * The measured demands and the unread-call demand keep it; the failed-call
   * demand does not, and neither does a claim demand. The claim brake read the sentence
   * itself and found the record against it, so restoring that sentence on the
   * budget notice hands back the exact answer the brake refused: one live run
   * finished `stop` with a bounced "the tests pass" over a repository whose
   * test exits 1, by this route and no other. A claim demand therefore clears
   * this. See `Frame.CompletionDemand.keeps`.
   */
  bouncedCompletion: Schema.optional(Schema.String),
  /**
   * The frame a completion demand was handed to, if one is outstanding.
   *
   * The five measured demands end with the same promise: what you return next
   * is the answer that stands. Three of them can fire on one `complete`
   * transition and each carries its own cap, so without this the frame written
   * to answer one demand is judged by the next — and a run that changed nothing and displaced a
   * failing check is told "no" twice about one decision, spending two frames
   * and two model calls on the argument. Recorded as the frame number rather
   * than as a flag because it is then self-clearing: it names one frame, and
   * every frame after that one is a frame the run chose to spend.
   *
   * It governs whether a demand may be *issued*, not whether the claim brake
   * may read. A frame that answers a measured demand and completes is read by
   * the claim brake like any other completion, because an unread completion is
   * the silence this package refuses; what it cannot be handed is a second
   * demand. See `Frame.judgeCompletion`.
   */
  demandedFrame: Schema.optional(NonNegativeSafeInt),
  /**
   * Whether a human can answer this run, which is what makes a park honorable.
   *
   * A park is durable waiting, and waiting only ends when somebody answers. A
   * run with no approval channel has nobody to answer it, so a park there is
   * not patience: it is the run abandoning a budget it still holds. False —
   * the default — refuses the transition and answers it in the frame that
   * returned it.
   */
  approvalChannel: Schema.Boolean.pipe(
    Schema.withConstructorDefault(Effect.succeed(false)),
    Schema.withDecodingDefaultKey(Effect.succeed(false))
  ),
  /**
   * The workspace as the last measured frame left it.
   *
   * Carried in state rather than re-measured because one measurement serves
   * two frames: what a frame closes on is what the next frame opens on, and
   * nothing between them touches the tree — the sealed model step in between
   * only produces text. So a run pays one walk per frame, not two, and a
   * resumed run replays the recorded measurement instead of walking a tree
   * that has moved on.
   *
   * Absent means no frame has measured yet; `None` means a frame measured and
   * the host reported it has nothing to measure. The two are kept apart so an
   * unobservable host is asked once and then left alone, instead of paying an
   * opening boundary every frame for an answer that will not change.
   */
  workspace: Schema.optional(Schema.Option(EngineLike.Observation)),
  /**
   * Catalog flows and skills the run-start relevance reading withheld, and
   * that no call has restored since.
   *
   * State rather than a per-frame detail because the reading is taken once,
   * at frame 0, and every later frame's `ctx.flows` is filtered by it. A call
   * to one of these names is refused as `flow_withheld` and restores it from
   * the next frame. See {@link Input.judged}.
   */
  withheldFlows: Schema.Array(Schema.String).pipe(
    Schema.withConstructorDefault(Effect.succeed<ReadonlyArray<string>>([])),
    Schema.withDecodingDefaultKey(Effect.succeed<ReadonlyArray<string>>([]))
  ),
  /**
   * Keys of the memory rows the supervisor has shown this run, oldest first,
   * the newest 256 kept.
   *
   * State rather than a supervisor detail because it is folded in from each
   * recorded drain, so a replay rebuilds it, and a row shown once is never
   * asked about or delivered again. See `Supervisor`.
   */
  memoryShown: Schema.Array(Schema.String).pipe(
    Schema.withConstructorDefault(Effect.succeed<ReadonlyArray<string>>([])),
    Schema.withDecodingDefaultKey(Effect.succeed<ReadonlyArray<string>>([]))
  ),
  /**
   * Each supervisor monitor's streak, deliveries and last delivery, by id.
   *
   * State because it is folded in only from each recorded drain, the one
   * place a reading is gated, so a replay rebuilds it and a resumed run
   * keeps its cooldowns and limits. See `Monitor.gate`.
   */
  monitorLedger: Monitor.Ledger.pipe(
    Schema.withConstructorDefault(Effect.succeed<Monitor.Ledger>({})),
    Schema.withDecodingDefaultKey(Effect.succeed<Monitor.Ledger>({}))
  ),
  /**
   * What the run knows of its newest transcript segments, one entry each, in
   * window order: the frame that wrote it, whether it carries the person's
   * messages, whether that frame changed files, the checks it ran, and Jev's
   * answer about it once a supervisor reading has marked it.
   *
   * State because a compaction's pins and marks read it long after the frame
   * that wrote a segment; each compaction keeps the entries of the segments
   * it keeps. Answers are folded in only from each recorded drain, so a
   * replay rebuilds them. It is aligned when it describes every transcript
   * segment; a run whose state predates it is not, and compacts every
   * segment into the summary, as runs did before compaction marks.
   */
  segmentFacts: Schema.Array(compactionMarks.Facts).pipe(
    Schema.withConstructorDefault(Effect.succeed<ReadonlyArray<compactionMarks.Facts>>([])),
    Schema.withDecodingDefaultKey(Effect.succeed<ReadonlyArray<compactionMarks.Facts>>([]))
  ),
  /**
   * Output this run has been handed as a fragment, by digest.
   *
   * The ledger is state rather than a per-frame detail because a cell may store
   * a truncated capture and write it a frame later. It carries no bytes; see
   * `TruncatedOutput`.
   */
  truncatedOutputs: TruncatedOutput.Ledger
}) {}

/**
 * Rebuilds controller state with only the fields one step changes.
 *
 * Every frame produces a whole new `State`, so a field added to the class had
 * to be threaded through five constructions by hand — and the one that was
 * forgotten silently reset a budget. Changes are stated; everything else is
 * carried.
 */
const advance = (state: State, changes: Frame.StateChanges): State => new State({ ...state, ...changes })

/**
 * Runtime declarations used to interpret serializable controller state.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Input {
  readonly state: State
  /** Resolves the host's seat vocabulary; kept outside serializable state. */
  readonly contextWindowTokensFor?: ((seat: string) => Effect.Effect<number, HarnessError>) | undefined
  /** The flows this frame may call, already narrowed by seat visibility. */
  readonly flows: ReadonlyArray<Descriptor.FlowDescriptor>
  /** Re-read and journal the callable catalog before each frame, including the first. */
  readonly refreshFlows?: Effect.Effect<ReadonlyArray<Descriptor.FlowDescriptor>, HarnessError> | undefined
  readonly limits?: Sandbox.Limits | undefined
  /**
   * The monitors each supervisor reading scores and each boundary gates;
   * omitted takes `Monitor.defaults()`. Runtime configuration rather than
   * durable state: a resumed run is armed by the host that resumes it.
   * Nothing a monitor says reaches the run unless {@link judged}.
   */
  readonly monitors?: ReadonlyArray<Monitor.Monitor> | undefined
  /**
   * Whether the host's `Evaluator` is a real judge. True arms Jev's features,
   * the supervisor's monitor messages and memory inserts among them; omitted is false.
   * Runtime configuration like {@link monitors}.
   */
  readonly judged?: boolean | undefined
  /**
   * The static stance the run is taught and journals on `discipline-armed`;
   * omitted teaches none. The window must already have been taught with it,
   * so the loop's re-teach replaces the same segments.
   */
  readonly stance?: typeof AgentEvent.Stance.Type | undefined
  /**
   * Human-provided instruction files, such as `AGENTS.md`, as the window's
   * {@link instructionsSegment} renders them. When {@link judged}, frame 0
   * asks Jev which of their chunks the task does not need and drops those it
   * is confident of from that segment.
   */
  readonly instructions?: ReadonlyArray<Relevance.Document> | undefined
  /**
   * Flow names the run-start relevance reading never judges: the ones a run
   * cannot do without, such as `jev` and the core file and shell flows.
   */
  readonly pinned?: ReadonlyArray<string> | undefined
  /**
   * The opening memory rows the window's {@link memorySegment} renders. When
   * {@link judged}, frame 0 asks Jev about each row in the same reading as
   * the catalog and the instructions, and renders only the rows it keeps.
   */
  readonly memory?: Memory | undefined
  /**
   * The shape the host requires of the run's final output; omitted accepts
   * any. See {@link OutputCheck}.
   */
  readonly output?: OutputCheck | undefined
}

/**
 * A host's check of a completion's output.
 *
 * `check` answers the output with the correction to hand back, or `undefined`
 * when it fits. A refused completion goes back to the same session, which
 * keeps its realm and everything its earlier frames printed, so fixing the
 * shape never repeats the work that produced the answer. At most `cap`
 * completions are handed back, and only while a frame is left to answer in;
 * past either, the completion stands and the host decides what follows.
 *
 * The verdict is a recorded boundary, so a replay is served the decision the
 * original attempt made.
 *
 * @category models
 * @since 1.0.0-rc.1
 */
export interface OutputCheck {
  /** `corrected` is how many completions this run has already had handed back for it. */
  readonly check: (output: string, corrected: number) => Effect.Effect<string | undefined>
  readonly cap: number
}

/**
 * One opening memory row: `key` is its relevance id.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface MemoryRow {
  readonly key: string
  readonly text: string
}

/**
 * Opening memory as the host declared it: its rows, the digest the opening
 * window's {@link memorySegment} declares, and how the host renders rows.
 * `render` is only ever handed rows of `rows`, in order.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Memory {
  readonly rows: ReadonlyArray<MemoryRow>
  readonly digest: string
  readonly render: (rows: ReadonlyArray<MemoryRow>) => string
}

/**
 * The prefix segment that carries opening memory: rendered `text` under its
 * declared `digest`.
 *
 * A `system` segment, like {@link instructionsSegment}: what the run
 * remembers is not the task, and the run-start reading judges each row
 * against a task that must not already contain it. The opening window and
 * the run-start reading build it the same way, so the reading finds the
 * opening's segment by digest.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const memorySegment = (text: string, digest: string): ContextWindow.SegmentInput => ({
  kind: "system",
  zone: "prefix",
  declaredDigest: digest,
  content: [ModelRequest.SystemPart.make({ text })]
})

/**
 * The prefix segment that carries human-provided instruction files, every
 * chunk not in `withheld` kept.
 *
 * A `system` segment, never `instructions`: the task is what the run's prefix
 * `instructions` segments say, and a project's guidelines are not the task.
 * The opening window and the run-start reading build it the same way, so the
 * reading finds the opening's segment by digest.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const instructionsSegment = (
  documents: ReadonlyArray<Relevance.Document>,
  withheld: ReadonlySet<string>
): ContextWindow.SegmentInput => ({
  kind: "system",
  zone: "prefix",
  content: [ModelRequest.SystemPart.make({ text: Relevance.render(documents, withheld) })]
})

/**
 * Constructs an initial controller state.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const make = (options: {
  readonly session: string
  readonly seat: string
  readonly modelParams: ModelRequest.GenerationParams
  readonly layers: ReadonlyArray<string>
  readonly capabilityEnvelope: ReadonlyArray<Capability.CapabilityPattern>
  readonly placement: Option.Option<Descriptor.Placement>
  readonly contextWindow: ContextWindow.ContextWindow
  readonly contextWindowTokens?: number | undefined
  readonly frame?: number | undefined
  readonly maxFrames?: number | undefined
  /**
   * Caps consecutive read-only frames: at the cap the controller demands an
   * edit or a typed justification, and at twice the cap the run stops as a
   * typed failure. Omitted or zero disarms it, which is what a run that is
   * only meant to read — a question, a review — should get.
   */
  readonly readOnlyCap?: number | undefined
  /**
   * Caps the wall-clock one model call may spend, in milliseconds. Omitted
   * takes {@link defaultModelCallMs}; zero disarms the budget.
   */
  readonly modelCallMs?: number | undefined
  /**
   * Caps consecutive repeat-observation frames: at the cap the controller
   * names the repetition and redirects the run at evidence it does not hold.
   * Omitted takes {@link defaultRepeatFrames}; zero disarms it.
   */
  readonly repeatCap?: number | undefined
  /**
   * Caps how many completions may be bounced for narrowed evidence: at the
   * first such completion the controller names the broader check the run has
   * not re-run since its latest change and asks for another frame. Omitted
   * takes {@link defaultNarrowingDemands}; zero disarms it.
   */
  readonly narrowingCap?: number | undefined
  /**
   * Caps how many completions may be bounced for an unmoved tree: at the first
   * completion whose closing digest is the digest the run opened on, the
   * controller names both and asks for another frame. Omitted takes
   * {@link defaultUnmovedDemands}; zero disarms it.
   */
  readonly unmovedCap?: number | undefined
  /**
   * Caps how many completions may be bounced for a failing check the run
   * replaced rather than answered. Omitted takes
   * {@link defaultUnresolvedDemands}; zero disarms it.
   */
  readonly unresolvedCap?: number | undefined
  /**
   * Caps how many frames the run is given to prove a claim its own record does
   * not support; past it such a claim fails the run rather than standing.
   * Omitted takes {@link defaultClaimDemands}; zero disarms
   * it. The control is also a no-op wherever no `Evaluator` service is in
   * context, so a host that binds none need not disarm anything.
   */
  readonly claimCap?: number | undefined
  /**
   * Whether a human can answer this run. Omitted or false refuses a `park`
   * transition and answers it in-frame; only a host that has wired somewhere
   * for an answer to come from may claim true.
   */
  readonly approvalChannel?: boolean | undefined
  /**
   * Caps how many times one frame may answer its own unparseable cell before
   * the frame ends. Omitted takes {@link defaultRevalidations}; zero disarms it.
   */
  readonly revalidations?: number | undefined
  /**
   * Caps how many trees this run may pin with `ctx.checkpoint()`. Omitted takes
   * {@link defaultMaxCheckpoints}; zero disarms minting and leaves `ctx.base`,
   * which nobody mints, working.
   */
  readonly checkpointCap?: number | undefined
  /**
   * Provider-run tools every frame's model call may use, such as the
   * provider's own web search. Omitted or empty declares none.
   */
  readonly serverTools?: ReadonlyArray<ModelRequest.ServerTool> | undefined
}): State =>
  new State({
    session: options.session,
    frame: options.frame ?? 0,
    maxFrames: options.maxFrames ?? defaultMaxFrames,
    panel: [],
    seat: options.seat,
    modelParams: options.modelParams,
    layers: options.layers,
    capabilityEnvelope: options.capabilityEnvelope,
    placement: options.placement,
    contextWindow: options.contextWindow,
    // The opening transcript is the host's, written before any frame: no
    // person's message, no change and no check.
    segmentFacts: options.contextWindow.segments.flatMap((segment) =>
      segment.kind === "transcript"
        ? [{ frame: options.frame ?? 0, person: false, mutated: false, checks: [] }]
        : []
    ),
    contextWindowTokens: options.contextWindowTokens ?? 0,
    readOnlyCap: options.readOnlyCap ?? 0,
    modelCallMs: options.modelCallMs ?? modelCallMsFor(options.modelParams.reasoningEffort),
    readOnlyFrames: 0,
    readOnlyGrace: 0,
    pendingReadOnlyDemand: undefined,
    interventions: 0,
    repeatCap: options.repeatCap ?? defaultRepeatFrames,
    repeatFrames: 0,
    failureFrames: 0,
    failureKey: "",
    callSignatures: [],
    narrowingCap: options.narrowingCap ?? defaultNarrowingDemands,
    narrowingDemands: 0,
    unmovedCap: options.unmovedCap ?? defaultUnmovedDemands,
    unmovedDemands: 0,
    unresolvedCap: options.unresolvedCap ?? defaultUnresolvedDemands,
    unresolvedDemands: 0,
    failedCallDemands: 0,
    unobservedDemands: 0,
    outputDemands: 0,
    claimCap: options.claimCap ?? defaultClaimDemands,
    claimDemands: 0,
    openingDigest: "",
    checks: [],
    callLedger: [],
    reported: [],
    failures: [],
    mutations: 0,
    remoteMutations: 0,
    sufficiencyStated: false,
    revalidations: options.revalidations ?? defaultRevalidations,
    approvalChannel: options.approvalChannel ?? false,
    workspace: undefined,
    truncatedOutputs: [],
    checkpointCap: options.checkpointCap ?? defaultMaxCheckpoints,
    checkpointIds: [],
    ...(options.serverTools === undefined || options.serverTools.length === 0
      ? {}
      : {
        serverTools: [
          ...new Map(options.serverTools.map((tool) => [CanonicalJson.stringify(tool), tool])).values()
        ]
      })
  })

/**
 * Host-measured container facts accepted by {@link teach}.
 *
 * @category models
 * @since 0.1.0
 */
export type Environment = cellPrompt.Environment

/**
 * Prepends the cell contract and the callable-flow catalog to a context window.
 *
 * The model is taught one thing — how to write a cell — and shown exactly the
 * flows this frame may call. Both land in prefix segments, which every
 * transition preserves, so the teaching is stable for the run and a cell's
 * projected context never has to carry it.
 *
 * `stance`, when set, adds the run's one-line static stance after the
 * contract; see {@link Input.stance}.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const teach = (
  contextWindow: ContextWindow.ContextWindow,
  flows: ReadonlyArray<Descriptor.FlowDescriptor>,
  environment?: Environment,
  stance?: typeof AgentEvent.Stance.Type
): ContextWindow.ContextWindow => {
  const projections: Record<string, Cell.FlowProjection & Pick<Descriptor.FlowDescriptor, "provenance" | "path">> = {}
  for (const descriptor of flows) {
    projections[descriptor.name] = {
      ...Cell.project(descriptor),
      provenance: descriptor.provenance,
      path: descriptor.path
    }
  }
  const taught = cellPrompt.make(projections, environment, stance).map((section) =>
    ContextWindow.makeSegment({
      kind: "system",
      zone: "prefix",
      declaredDigest: section.digest,
      content: [ModelRequest.SystemPart.make({ text: section.text })]
    })
  )
  return ContextWindow.make({
    modelId: contextWindow.modelId,
    segments: [...taught, ...contextWindow.segments],
    activeTools: contextWindow.activeTools,
    replaced: contextWindow.replaced
  })
}

const modelIdFromSeat = (seat: string): string => {
  const separator = seat.indexOf(":")
  return separator < 0 ? seat : seat.slice(separator + 1)
}

const placementFrom = (state: State): Placement.Placement | undefined =>
  Option.match(state.placement, {
    onNone: () => undefined,
    onSome: (value) => {
      switch (value) {
        case "client":
          return Placement.client()
        case "local":
          return Placement.local()
        case "remote":
          return Placement.remote()
        case "sandbox":
          return Placement.sandbox()
      }
    }
  })

const keyMaterialFrom = (
  state: State,
  contextWindow: ContextWindow.ContextWindow,
  request: ModelRequest.ModelRequest
): KeyMaterial.KeyMaterial => ({
  version: "flows/key-material/v2",
  kind: "sealed",
  body: { _tag: "ModelCall", request },
  inputs: [{ _tag: "Literal", value: { contextDigest: contextWindow.digest, journalVersion } }],
  layers: [...new Set(state.layers)].sort(),
  capabilities: [...new Set(state.capabilityEnvelope.map(Capability.format))].sort(),
  effects: Effects.make({
    reads: [],
    writes: [],
    mode: "hermetic",
    onConflict: "serialize",
    tier: "sealed"
  }),
  placement: placementFrom(state)
})

/**
 * Everything the model is told about the run's own memory this frame.
 *
 * Two sections, and each of them exists because a run paid for the same bytes
 * twice without it: what names the realm holds and how fresh each one is
 * (`VariablesPanel`), and what the run has already asked (`CallLedger`).
 *
 * It is a user message after the transcript rather than a system part, and
 * that placement is the whole point: the teaching, the task and the flow catalog are
 * byte-identical for the life of a run, so putting the one block that changes
 * every frame *after* the transcript leaves the provider's prefix cache
 * covering every byte before it. With the block in the middle, the cache broke
 * at the system boundary on every frame and the accumulated transcript behind
 * it was re-read at full price; two graded instances ran at 38% and 69% cached
 * input against model time that is 76% to 93% of wall clock.
 *
 * It goes after the transcript and *before* whatever the frame is being asked
 * to answer, because a run answers the last thing it read. A retained chat
 * turn asked for the letter A had printed it six times and bound it to
 * `letter`; on the frame the read-only demand fired, the window ended with the
 * demand and then this block, and the seat returned `"letter"`, `["letter"]`
 * or `letter = A` in 23 of 24 bounded probes, the roster's own word rather
 * than the person's answer. With this block moved above the demand and nothing else
 * changed, the same seat on the same captured request returned exactly `A` in
 * 8 of 8, and dropping the block entirely returned it in 7 of 7. The demand
 * had never been the problem: being second-to-last was. See
 * {@link State.interventions} for how many messages that is, and
 * `docs/troubleshooting.md` for the readings.
 */
const stateSection = (state: State): string => {
  // The panel is stamped by the frame that ran, which is the frame before the
  // one this prompt is opening.
  const settled = CallLedger.render(state.callLedger, state.ledgerShown)
  return [
    VariablesPanel.render({ ledger: state.panel, frame: state.frame - 1 }),
    ...(settled === undefined ? [] : [settled])
  ].join("\n\n")
}

/**
 * Writes this frame's state section into the window, after the transcript
 * and before this frame's asks, where it then stays.
 *
 * It stays because the provider's prefix cache only reuses a request the next
 * one extends. When the section was spliced into each request and dropped
 * from the next, frame N+1 forked from frame N one message before the reply N
 * produced, so the provider re-read every earlier reasoning item from its
 * encrypted copy instead of the reply it had just decoded: 2026-09-26 Luna
 * runs on Terminal-Bench cached 23% to 49% of input and plateaued at the first
 * long reasoning item, where the Codex CLI on the same tasks cached 91% to 96%.
 * Written into the window, frame N+1 is frame N, its reply, and new messages.
 * The newest section is still the second-to-last thing read when the frame
 * carries an ask, and the last thing read when it does not.
 *
 * The asks are the last {@link State.interventions} messages of the window,
 * so the section goes in front of them inside whatever segment holds them;
 * with no asks it is a transcript segment of its own. The count is clamped
 * against the window, because it is carried in state while the window is
 * rebuilt every frame.
 */
const frozen = (
  contextWindow: ContextWindow.ContextWindow,
  state: State
): Result.Result<ContextWindow.ContextWindow, HarnessError> => {
  // A durable window that no longer renders is a render failure, stated
  // before the section is written into it.
  try {
    ContextWindow.render(contextWindow)
    return Result.succeed(withSection(contextWindow, state))
  } catch (cause) {
    return Result.fail(
      new HarnessError({ code: "render_failed", message: "Unable to render the context window", cause })
    )
  }
}

const withSection = (contextWindow: ContextWindow.ContextWindow, state: State): ContextWindow.ContextWindow => {
  const section = ModelRequest.Message.user(stateSection(state))
  const segments = [...contextWindow.segments]
  // Walk back over the asks to the segment and position the section goes in.
  let asks = state.interventions
  let index = segments.length - 1
  let position = index < 0 ? 0 : segments[index]!.content.length
  while (index >= 0 && asks > 0) {
    const content = segments[index]!.content
    position = content.length
    for (let item = content.length - 1; item >= 0 && asks > 0; item--) {
      if ("role" in content[item]!) {
        asks--
        position = item
      }
    }
    if (asks > 0 && index > 0) {
      index--
    } else break
  }
  const holder = index < 0 ? undefined : segments[index]
  // Only the tail may carry it: a prefix segment is the stable span every
  // frame repeats, and a window with no tail yet gets a transcript segment.
  if (holder === undefined || holder.zone !== "tail") {
    segments.push(ContextWindow.makeSegment({ kind: "transcript", zone: "tail", content: [section] }))
  } else {
    segments[index] = ContextWindow.makeSegment({
      kind: holder.kind,
      zone: holder.zone,
      content: [...holder.content.slice(0, position), section, ...holder.content.slice(position)]
    })
  }
  return ContextWindow.make({
    modelId: contextWindow.modelId,
    segments,
    activeTools: contextWindow.activeTools,
    replaced: contextWindow.replaced
  })
}

const requestFrom = (
  state: State,
  contextWindow: ContextWindow.ContextWindow
): Result.Result<ModelRequest.ModelRequest, HarnessError> => {
  let rendered: ModelRequest.ModelRequest
  try {
    rendered = ContextWindow.render(contextWindow)
  } catch (cause) {
    return Result.fail(
      new HarnessError({
        code: "render_failed",
        message: "Unable to render the context window",
        cause
      })
    )
  }
  return Result.succeed(
    ModelRequest.ModelRequest.make({
      modelId: contextWindow.modelId,
      system: rendered.system,
      messages: rendered.messages,
      // A cell-first frame never declares provider tools: the cell is the plan
      // and `ctx.call` is the only invocation path.
      tools: [],
      toolChoice: "none",
      params: state.modelParams,
      // The window only grows between frames (see `frozen`), so the whole
      // request is the next one's prefix and Anthropic's moving breakpoint
      // sits at its end.
      cacheKey: cacheKey(state, rendered.system),
      // Provider-run tools are not declared tools: the model may search
      // inside the call while `ctx.call` stays the only invocation path.
      ...(state.serverTools === undefined ? {} : { serverTools: state.serverTools })
    })
  )
}

/**
 * Route by the session store and the stable system prefix, not the task.
 * The task is kept in the system window for compaction, but changes between
 * runs of one profile. Other windows without a task marker use their whole
 * system as the prefix.
 */
const cacheKey = (state: State, system: ReadonlyArray<ModelRequest.SystemPart>): string => {
  const task = system.findIndex((part) => part.text.startsWith("The task for this run:\n\n"))
  const prefix = task < 0 ? system : system.slice(0, task)
  return `smithers-${CanonicalJson.shortHash(`${state.session}\n${prefix.map((part) => part.text).join("\n")}`)}`
}

const assistantText = (message: ModelRequest.AssistantMessage): string =>
  message.content
    .filter((part): part is ModelRequest.TextPart => part.type === "text")
    .map((part) => part.text)
    .join("\n")

/** The journal-safe form of a permission request, for `SuspendReason.details`. */
const encodePermissionRequired = Schema.encodeSync(Permission.PermissionRequired)

const permissionRequired = (error: unknown): Permission.PermissionRequired | undefined => {
  if (error instanceof Permission.PermissionRequired) return error
  if (error instanceof HarnessError && error.cause instanceof Permission.PermissionRequired) return error.cause
  return Option.getOrUndefined(
    Schema.decodeUnknownOption(Permission.PermissionRequired)(
      error instanceof HarnessError ? error.cause : error
    )
  )
}

/**
 * How much of a cell that RAN is echoed back into the next prompt, in UTF-8
 * bytes.
 *
 * Generous, because the model is being asked to fix source it can no longer
 * see: the cell it wrote is only in the transcript, and a raise is repaired by
 * editing the line that threw. Almost every real cell is far under this.
 */
const liveCellEcho = 8192

/**
 * How much of a cell that never RAN is echoed back into the next prompt, in
 * UTF-8 bytes.
 *
 * Tight, because a dead cell is answered by its error and not by its text. The
 * r90 wave charged `sympy__sympy-20154` $0.10 to read back a 53 KB program that
 * had already failed to compile once — the error names the line, and the line
 * is what the next cell needs. What is dropped is stated, so the model is never
 * shown a truncated program it might mistake for a whole one.
 */
const deadCellEcho = 1024

/**
 * Appends one observation turn to a context window, bounding the echo.
 *
 * The assistant message is the model's own reply, and putting it back verbatim
 * is how a frame's output becomes the next frame's input at full price. It is
 * kept whole while it is small, and stated as an excerpt once it is not.
 */
const appended = (
  contextWindow: ContextWindow.ContextWindow,
  assistant: ModelRequest.AssistantMessage,
  messages: ReadonlyArray<ModelRequest.Message>,
  echo: number
): ContextWindow.ContextWindow =>
  ContextWindow.make({
    modelId: contextWindow.modelId,
    segments: [
      ...contextWindow.segments,
      ContextWindow.makeSegment({
        kind: "transcript",
        zone: "tail",
        content: [bounded(assistant, echo), ...messages]
      })
    ],
    activeTools: contextWindow.activeTools,
    replaced: contextWindow.replaced
  })

const observedOn = (
  contextWindow: ContextWindow.ContextWindow,
  assistant: ModelRequest.AssistantMessage,
  observation: string,
  echo: number
): ContextWindow.ContextWindow => appended(contextWindow, assistant, [ModelRequest.Message.user(observation)], echo)

/** The most memory keys {@link State.memoryShown} keeps. */
const memoryShownLimit = 256

/**
 * The shown set after a drain: the rows it delivered join it, newest last. A
 * drain never delivers a row already shown, so nothing joins it twice.
 */
const shownAfter = (state: State, drained: Steering.DrainRecord): Frame.StateChanges =>
  drained.memory === undefined
    ? {}
    : { memoryShown: [...state.memoryShown, ...drained.memory].slice(-memoryShownLimit) }

/** The monitor ledger after a drain: the one it gated against, when it gated one. */
const ledgerAfter = (drained: Steering.DrainRecord): Frame.StateChanges =>
  drained.monitorLedger === undefined ? {} : { monitorLedger: drained.monitorLedger }

/**
 * The segment facts after a drain: each unmarked transcript segment a
 * drained mark names by digest takes its answer. A mark for a segment a
 * compaction has since replaced names nothing and is dropped.
 */
const marksAfter = (state: State, drained: Steering.DrainRecord): Frame.StateChanges => {
  if (drained.marks === undefined) return {}
  const answers = new Map(drained.marks.map(({ digest, ...answer }) => [digest, answer]))
  const transcripts = compactable(state.contextWindow.segments).filter((segment) => segment.kind === "transcript")
  // The entries describe the newest segments, so an unaligned run's are
  // missing from the front.
  const missing = transcripts.length - state.segmentFacts.length
  return {
    segmentFacts: state.segmentFacts.map((facts, at) => {
      const answer = answers.get(transcripts[at + missing]!.digest)
      return facts.answer !== undefined || answer === undefined ? facts : { ...facts, answer }
    })
  }
}

/** Whether one drain carried anything the next frame runs differently for. */
const carries = (drained: Steering.DrainRecord): boolean => drained.inserts.length > 0 || drained.seatChanges.length > 0

/**
 * The seat and generation parameters one drain leaves the next frame on.
 *
 * Applied in admission order, so the newest change of each kind wins.
 */
const steered = (
  state: State,
  changes: Steering.DrainRecord["seatChanges"],
  resolve: Input["contextWindowTokensFor"]
): Effect.Effect<{
  readonly seat: string
  readonly modelParams: ModelRequest.GenerationParams
  readonly contextWindowTokens: number
  readonly modelCallMs: number
}, HarnessError> =>
  Effect.gen(function*() {
    let seat = state.seat
    let modelParams = state.modelParams
    for (const change of changes) {
      if (change._tag === "SeatChange") seat = change.seat
      else {
        modelParams = ModelRequest.GenerationParams.make({
          maxTokens: modelParams.maxTokens,
          temperature: modelParams.temperature,
          topP: modelParams.topP,
          topK: modelParams.topK,
          stopSequences: modelParams.stopSequences,
          thinkingBudget: modelParams.thinkingBudget,
          reasoningEffort: change.thinking
        })
      }
    }
    // A ceiling the host chose stays; one that is the old effort's default
    // follows the effort, so a run steered up to `max` gets `max`'s ceiling.
    const defaulted = state.modelCallMs === modelCallMsFor(state.modelParams.reasoningEffort)
    return {
      seat,
      modelParams,
      modelCallMs: defaulted ? modelCallMsFor(modelParams.reasoningEffort) : state.modelCallMs,
      contextWindowTokens: seat === state.seat
        ? state.contextWindowTokens
        : resolve === undefined
        ? ModelCatalog.contextWindowTokensFor(modelIdFromSeat(seat))
        : yield* resolve(seat)
    }
  })

/**
 * The window the next frame renders, re-keyed when a steer moved the seat.
 *
 * A window carries the model it was measured against, so a seat change has to
 * rebuild it or the next frame budgets its context against the model it left.
 */
const windowOn = (
  state: State,
  seat: string,
  context: ContextWindow.ContextWindow
): ContextWindow.ContextWindow =>
  seat === state.seat ? context : ContextWindow.make({
    modelId: modelIdFromSeat(seat),
    segments: context.segments,
    activeTools: context.activeTools,
    replaced: context.replaced
  })

/**
 * The property name a thrown TypeError says could not be read, if it says one.
 *
 * Every realm this harness runs cells in words the same failure differently —
 * V8 says "Cannot read properties of undefined (reading 'x')", QuickJS says
 * "cannot read property 'x' of undefined" — so the property name is taken from
 * the quotes rather than from the sentence around them.
 */
const missedProperty = (message: string): string | undefined => {
  const match = /reading '([^']+)'|read property '([^']+)'/i.exec(message)
  /* v8 ignore next -- the regex has exactly two alternatives and each binds one group, so a match always has one of them; the fallback only discharges the optional type on a capture */
  return match === null ? undefined : (match[1] ?? match[2])
}

/**
 * States what the realm holds, when a cell threw reading a property.
 *
 * The names are the run's memory, so naming them is naming what the cell could
 * have read. The cell cannot be stopped from throwing — reading an absent
 * property is legal JavaScript and every guard a cell writes depends on it
 * staying legal — so the answer lands in the observation the throw already
 * produces.
 */
const bindingPathMiss = (
  message: string,
  bindings: ReadonlyArray<VariablesPanel.Binding>
): string | undefined => {
  const property = missedProperty(message)
  if (property === undefined) return undefined
  return bindings.length === 0
    ? `If \`${property}\` was meant to come from a name an earlier cell bound: your realm holds no names yet.`
    : `If \`${property}\` was meant to come from a name an earlier cell bound, these are the names your realm holds: ${
      elide.head(
        bindings.map((binding) => binding.name).join(", "),
        CallLedger.width * 4,
        "the panel in the frame block lists them all"
      )
    }. The panel gives each one's type and size.`
}

/** Asks again, inside the same frame, for a cell to replace one that did not parse. */
const revalidationNote = (rejection: Cell.Rejected): string =>
  `${rejection.message}\n\nThis reply is not a frame. Nothing ran, nothing changed, and no call was made, so you are being asked again inside the same frame instead of losing it: everything above this line is already in the provider's cache, and only what you write next is paid for. Emit the corrected cell and nothing else.`

/**
 * The assistant's own reply, shortened from the middle when it is too long to
 * re-read at input price, with the elision stated.
 *
 * The echo ceilings are UTF-8 bytes, which is what `elide` counts and what the
 * notice it writes reports, so the decision to shorten is taken in the same
 * unit rather than in UTF-16 code units: a reply of three thousand emoji is
 * six thousand code units and twelve thousand bytes, and measuring it in code
 * units let it past an eight-thousand-byte ceiling unshortened. `elide.middle`
 * returns its input unchanged when the whole already fits, so the comparison
 * is the elision's own and there is no second reading to disagree with it.
 */
const bounded = (
  assistant: ModelRequest.AssistantMessage,
  echo: number
): ModelRequest.AssistantMessage => {
  const text = assistantText(assistant)
  const shortened = elide.middle(
    text,
    echo,
    "the reply is not re-read in full; the observation below names what went wrong"
  )
  if (shortened === text) return assistant
  return ModelRequest.Message.assistant(shortened, { stopReason: assistant.stopReason })
}

const clip = (text: string, width: number): string => elide.head(text, width, "clipped")

/**
 * How much of one call's result the salvage list quotes back after a crash.
 *
 * A summary, not the result: the whole of it is still in the realm under the
 * name the cell bound it to, and the line says so. Before that, a clipped
 * summary was the only copy the next frame would ever see, and the next cell
 * re-issued the call to get the rest.
 */
const salvageSummary = 400

/**
 * What the salvage line says a clipped result can be read from.
 *
 * The realm outlives the frame that raised, so a name a cell bound before it
 * threw is still bound. This used to name the transition's `recall` list, which
 * left with the filing surface: a sentence that offers a move the contract no
 * longer has costs a model turn to discover it does nothing. It is worded like
 * {@link CallLedger.render}'s own trailer because it is the same fact.
 */
const salvageRecall = "the whole result is still under the name your cell bound it to"

/**
 * The identity of one invocation: the flow it named and the input it passed.
 *
 * Digested rather than kept verbatim because an input is the whole of a shell
 * command and this list is journaled state. Two invocations share a signature
 * exactly when the cell asked for the same thing twice, which is the only
 * question the repeat demand asks. `Forensics` derives the same identity from
 * the journal after the fact; this is the loop's own view of it, available
 * while the run can still act on it.
 */
const signatureOf = (flow: string, input: Schema.Json, at?: string | undefined): string =>
  Digest.digest(CanonicalJson.stringify(at === undefined ? [flow, input] : [flow, input, at]))

/**
 * The answer a park gets when nothing is listening for it.
 *
 * A park is a request for a human, and the run's own arming says whether one
 * exists. Refusing it is not an error the model has to repair — the frame is
 * ordinary, its state is kept, and the note states what is left to spend so the
 * next frame has no reason to read the refusal as "there is nothing more to
 * try". On the SWE-bench sphinx instance a run parked at frame 3 with 97
 * frames unspent, asking about a definition `grep` finds in the workspace it
 * was already holding.
 *
 * The frame it is answered in is an ordinary frame in every other respect,
 * read-only discipline included. Exempting it would hand a stalled run a way
 * out of the only control that ends a stall: a cell that parks every frame
 * would change nothing, be demanded nothing, and spend the whole frame budget
 * and the whole wall clock asking questions nobody is listening to.
 */
const parkRefusal = (
  message: string,
  framesLeft: number | "unlimited",
  frameSeconds: number | undefined
): string =>
  `No human is available: this run has no approval channel, so nobody can answer a park and the transition is not honored. What you asked — "${message}" — is now yours to settle. You have ${framesLeft} frame${
    framesLeft === 1 ? "" : "s"
  } left${
    frameSeconds === undefined ? "" : `, each able to spend up to ${frameSeconds} seconds`
  }, and the flows in ctx.flows to spend them on. Answer the question yourself with a call — search the workspace, read the file, run the command — and continue.`

const readOnlyCapFailure = (cap: number, frames: number): HarnessError =>
  new HarnessError({
    code: "read_only_cap",
    message:
      `The run spent ${frames} consecutive frames without one call that declares a write, twice its read-only budget of ${cap}. It is stopped here rather than allowed to report work it never did.`
  })

/**
 * Whether one resolved call *declares* that it changes something.
 *
 * Classification happens at the call boundary and reads declarations, not
 * flow names: a call declares a write when its resolved descriptor declares
 * writes, or when the invocation itself declares them — which is how a shell
 * flow whose registry-time envelope is the conservative empty set still counts
 * when the cell declares what the command writes. `Forensics` classifies the
 * same events after the fact by name; the loop cannot, because a host catalog
 * is whatever the host bound.
 *
 * This is a claim, not an observation, and the two are used for different
 * things. The claim decides authority — whether the truncated-write refusal
 * applies to this call — and the frame's *measured* change decides discipline.
 * A shell command that rewrites a tracked source file declares nothing and is
 * false here; it is still a mutation, and {@link witness} is what sees it.
 */
const mutating = (descriptor: Descriptor.FlowDescriptor, input: Schema.Json): boolean => {
  if (descriptor.effects.writes.length > 0) return true
  const declared = input !== null && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>).writes
    : undefined
  return Array.isArray(declared) && declared.length > 0
}

/**
 * The schema one workspace measurement is journaled under.
 *
 * `Option` and not a bare struct because "the host measured nothing" is a
 * recorded answer in its own right: a replayed frame must be told that its
 * original attempt could not observe the tree, rather than inferring it from
 * an absent record and measuring a tree that has since moved.
 */
const RecordedObservation = Schema.Option(EngineLike.Observation)

/** The full completion decision, including the classifier reading and its cost. */
const RecordedCompletion = Schema.Struct({
  observed: Schema.NullOr(AgentEvent.ClaimDemanded),
  demand: Schema.NullOr(Schema.Struct({
    event: Schema.Union([
      AgentEvent.UnmovedDemanded,
      AgentEvent.UnresolvedDemanded,
      AgentEvent.FailedCallDemanded,
      AgentEvent.UnobservedDemanded,
      AgentEvent.NarrowedDemanded,
      AgentEvent.NarrowOnlyDemanded,
      AgentEvent.ClaimDemanded
    ]),
    note: Schema.String,
    keeps: Schema.Boolean,
    spent: Schema.Struct({
      unmovedDemands: Schema.optionalKey(NonNegativeSafeInt),
      unresolvedDemands: Schema.optionalKey(NonNegativeSafeInt),
      failedCallDemands: Schema.optionalKey(NonNegativeSafeInt),
      unobservedDemands: Schema.optionalKey(NonNegativeSafeInt),
      narrowingDemands: Schema.optionalKey(NonNegativeSafeInt),
      claimDemands: Schema.optionalKey(NonNegativeSafeInt)
    })
  })),
  unproven: Schema.NullOr(HarnessError),
  // An optional key, not a nullable one: a judgement recorded before decisions
  // existed has no such member, and it must replay as a judgement with no
  // decision to report rather than fail to decode.
  decision: Schema.optionalKey(Schema.NullOr(AgentEvent.DecisionSettled)),
  sentenceDecision: Schema.optionalKey(Schema.NullOr(AgentEvent.DecisionSettled))
})

/**
 * Measures the workspace once, through a journaled boundary.
 *
 * The measurement is a read of the world — the same class of thing as the
 * steering drain — so it goes through {@link EngineLike.EngineLike.record}
 * rather than being called directly. Left unjournaled, a resumed frame would
 * walk a tree that has moved on since the original attempt, compare it against
 * the recorded state of a different one, and invent a mutation nobody made.
 *
 * The opening/closing pair measures this frame's mutations. Opening happens
 * after the model wait: another worker may have edited the shared directory.
 * Each frame and phase has its own replay key.
 */
const witness = (
  engine: EngineLike.EngineLike,
  state: State,
  boundary: string,
  phase: "open" | "close"
): Effect.Effect<Option.Option<EngineLike.Observation>, HarnessError> =>
  engine.record({
    name: `workspace-${phase}`,
    // The purpose is folded into the boundary as well as carried in `name`.
    // `EngineLike.record` keys on `(name, identity)` together, and the
    // production engine does; an engine that read the contract as keying on
    // identity alone would replay this frame's opening measurement as its
    // closing one, and its cell outcome as its steering drain. Folding the
    // purpose in makes the controller correct under either reading. No released
    // run database exists at 1.0.0-rc.0, so the labels are free to change now
    // and will not be again.
    identity: { session: state.session, frame: state.frame, boundary: `workspace-${phase}:${boundary}` },
    success: RecordedObservation,
    execute: engine.observe
  })

/**
 * The schema one pinned tree is journaled under.
 *
 * `Option` for the reason {@link RecordedObservation} is: "this host pins
 * nothing" is a recorded answer, and a replayed frame that inferred it from an
 * absent record would pin a tree that has since moved.
 */
const RecordedSnapshot = Schema.Option(EngineLike.Snapshot)

/**
 * Pins the workspace once, through a journaled boundary.
 *
 * The same treatment {@link witness} gives a measurement, for the same reason:
 * a pin is a read of the world, so a resumed frame must be handed the tree its
 * original attempt pinned rather than pin whatever is there now. The boundary
 * is keyed on the cell digest and the ordinal, which is exactly the pair that
 * re-derives when the cell is re-executed.
 */
const pin = (
  engine: EngineLike.EngineLike,
  state: State,
  cell: string,
  ordinal: number,
  id: string,
  callMs: number
): Effect.Effect<Option.Option<EngineLike.Snapshot>, HarnessError> =>
  engine.record({
    name: "checkpoint",
    identity: { session: state.session, frame: state.frame, boundary: `checkpoint:${cell}:${ordinal}` },
    success: RecordedSnapshot,
    // The per-call ceiling, applied INSIDE the record for the reason
    // {@link settled} applies it inside its own: a store that hung past the
    // budget left the cell told nothing was pinned while the pin itself was
    // still in flight, so the resumed frame could be handed a snapshot the
    // original attempt was told it never got. Cut off here, "nothing was
    // pinned" is what the journal holds and what every later attempt reads.
    execute: engine.capture({
      id,
      identity: { session: state.session, frame: state.frame, boundary: `checkpoint-capture:${cell}` }
    }).pipe(
      Effect.timeoutOrElse({ duration: callMs, orElse: () => Effect.succeed(Option.none()) })
    )
  })

/**
 * Issues one call under the run's per-call ceiling, through a journaled
 * boundary.
 *
 * The ceiling is what makes this a boundary rather than a pass-through.
 * `EngineLike.call` is already a keyed activity, so a call that SETTLES is
 * durable on its own; a call the ceiling cuts off is durable nowhere, because
 * the activity it interrupted never settled. Left there, a re-executed cell
 * issues that call again against a world that has moved on, gets an answer this
 * time, and takes a branch the original attempt never took — and every
 * irreversible effect below the fork is bought twice.
 *
 * The record is written AFTER the call and read INSTEAD of it, which is the
 * only order available and is the one that matters. The call cannot run inside
 * the boundary: `EngineLike.call` is where a cell reaches a durable wait, and a
 * `Flow.suspend` raised inside an enclosing activity suspends that activity's
 * attempt rather than the run, so a cell that slept on the durable clock never
 * woke. So this issues the call, records what the cell is about to be told, and
 * on any later attempt hands back the recorded settlement whatever the re-issued
 * call answered this time. The cell's branch is what has to be stable, and it
 * is; the re-issued call is work the run pays for twice, which is what a call
 * the ceiling cut off already cost before this existed.
 *
 * The drive loop is told the settlement is bounded here
 * (`Sandbox.RealmEvaluation.bounded`): two clocks over one call would settle it
 * from the reading nothing keeps.
 *
 * The boundary is keyed on the cell digest and the call's ordinal, which is the
 * pair a re-executed cell re-derives.
 */
const issued = (
  engine: EngineLike.EngineLike,
  state: State,
  cell: string,
  ordinal: number,
  callMs: number,
  flow: string,
  issue: Effect.Effect<Cell.CallResult, HarnessError>,
  replaying: boolean,
  call: Cell.Call
): Effect.Effect<Cell.CallResult, HarnessError> =>
  Effect.gen(function*() {
    if (replaying) {
      // A terminal frame proves this prefix settled. Read its settlements
      // directly, including per-call timeouts whose host activity never settled.
      return yield* engine.record({
        name: "cell-call",
        call,
        identity: { session: state.session, frame: state.frame, boundary: `cell-call:${cell}:${ordinal}` },
        success: Cell.CallResultVariant,
        execute: Effect.fail(
          new HarnessError({
            code: "incompatible_journal",
            message: `The timed-out frame is missing settlement ${ordinal}`
          })
        )
      }).pipe(Effect.flatMap(Cell.decodeCallResult))
    }
    // An escape — a permission park, an abort, an engine failure — never
    // reaches the record at all, so nothing journals it and the attempt the
    // grant answers asks again. That is the whole reason the call sits outside
    // the boundary rather than inside its `execute`.
    //
    // Authority is decided before the clock starts: time a person spends
    // answering an approval is not the flow's to spend.
    const refused = engine.admit === undefined ? undefined : yield* engine.admit(call)
    const identity = { session: state.session, frame: state.frame, boundary: `cell-call:${cell}:${ordinal}` }
    // A guarded host parks a timed-out call instead of letting the cell read
    // it. The call's own timeout (a command's, a child await still running)
    // is reported under the same code as this boundary's. Nothing is recorded
    // for the parked call, so Continue issues it again and Stop refuses it
    // here before it runs.
    const subject = JSON.stringify(identity)
    const guarded = refused === undefined ? engine.guard : undefined
    if (guarded !== undefined) yield* guarded.admit(subject)
    let bounded = false
    const settlement = refused ?? (yield* issue.pipe(
      Effect.timeoutOrElse({
        duration: callMs,
        orElse: () =>
          Effect.sync(() => {
            bounded = true
            return Sandbox.callTimedOut(flow, callMs)
          })
      }),
      Effect.flatMap(Cell.decodeCallResult)
    ))
    if (guarded !== undefined && settlement.outcome === "failure" && settlement.code === "timeout") {
      yield* guarded.trip({
        source: "tool-call",
        subject,
        limitMillis: bounded ? callMs : undefined,
        message: settlement.message ?? `Flow ${flow} timed out.`
      })
    }
    return yield* engine.record({
      name: "cell-call",
      call,
      identity,
      success: Cell.CallResultVariant,
      execute: Effect.succeed(settlement)
    }).pipe(Effect.flatMap(Cell.decodeCallResult))
  })

/**
 * The schema one settled frame is journaled under.
 *
 * The realm's own answer and execution boundary, because these are things the loop
 * branches on: the outcome decides the transition, the prints become the next
 * frame's context, and the bindings become the variables panel. The boundary
 * prevents a timed-out frame from reconstructing beyond its delivered prefix.
 */
const RecordedFrame = Schema.Struct({
  boundary: Schema.optional(Sandbox.FrameBoundary),
  outcome: Cell.Outcome,
  prints: Schema.String,
  bindings: Schema.Array(VariablesPanel.Binding)
})

/**
 * Settles one `ctx.checkpoint()` from inside a running cell.
 *
 * The id is `cp-<frame>-<ordinal>`, which is derived from the two things that
 * re-derive identically when a cell is re-executed, so a resumed run addresses
 * the same trees its original attempt did — and short enough for a model to
 * read back in a print. `minted` is this frame's own tally; the run's is
 * `State.checkpointIds`, folded in when the frame closes.
 */
const minter = (
  state: State,
  cell: Cell.Source,
  engine: EngineLike.EngineLike,
  minted: Array<string>,
  callMs: number,
  emit: (event: AgentEvent.AgentEvent) => Effect.Effect<void>
): Sandbox.Minter =>
(mint) =>
  Effect.gen(function*() {
    const held = state.checkpointIds.length + minted.length
    if (held >= state.checkpointCap) {
      return refusal(
        "checkpoint_exhausted",
        `This run has pinned its ${state.checkpointCap} checkpoints and nothing was pinned here. ${
          held === 0 ? "" : `The ones you hold are ${[...state.checkpointIds, ...minted].join(", ")}, and `
        }ctx.base is always the tree this run opened on.`
      )
    }
    const id = `cp-${state.frame}-${mint.ordinal}`
    const snapshot = yield* pin(engine, state, cell.digest, mint.ordinal, id, callMs)
    if (Option.isNone(snapshot)) {
      return refusal(
        "checkpoint_unavailable",
        "This host pins no trees, so nothing was checkpointed. For a baseline, run the check before your edit, then again after it."
      )
    }
    minted.push(id)
    yield* emit(
      new AgentEvent.CheckpointMinted({
        eventType: eventType.checkpointMinted,
        id: snapshot.value.id,
        ref: snapshot.value.ref,
        cell: cell.digest,
        ordinal: mint.ordinal
      })
    )
    return new Cell.CallResult({ outcome: "success", value: Cell.checkpoint(snapshot.value.id) })
  })

const emitModelProgress = (
  event: ModelEvent.ModelEvent,
  emit: (event: AgentEvent.AgentEvent) => Effect.Effect<void>
): Effect.Effect<void> =>
  event.type === "retry"
    ? emit(
      new AgentEvent.ModelRetried({
        eventType: eventType.modelRetried,
        attempt: event.attempt,
        code: event.code,
        delayMillis: event.delayMillis
      })
    )
    : event.type === "settle"
    ? Effect.void
    : emit(new AgentEvent.ModelDelta({ eventType: eventType.modelDelta, delta: event }))

/**
 * The reserved key a flow reports an invalid probe under.
 *
 * This is the one convention the loop reads off an otherwise opaque call
 * result. It is not a shared type — the controller must not depend on the tool
 * library — so it is a documented wire key. `@smthrs/std/Probe` is the
 * producing half and owns the taxonomy; the controller only has to know that a
 * result carrying this key is a result whose failure was about the command.
 */
const invalidProbeKey = "invalidProbe"

/** What a settled call declared about whether it ran a check at all. */
const invalidProbeOf = (
  value: Schema.Json
): { readonly reason: string; readonly message: string } | undefined => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined
  const declared = (value as Record<string, unknown>)[invalidProbeKey]
  if (declared === null || typeof declared !== "object" || Array.isArray(declared)) return undefined
  const { message, reason } = declared as Record<string, unknown>
  return typeof reason === "string" && typeof message === "string" ? { reason, message } : undefined
}

/**
 * The reserved output key a flow reports a measured write under.
 *
 * `@smthrs/std/TreeFingerprint` is the producing half: `bash` fingerprints a
 * container's working directory before and after a containerised command and
 * sets this to whether the two differ. The controller reads a `true` here as
 * a standing write the host's own walk could not see, and nothing else off
 * it: `false` and absent both leave the call's declaration as it stands.
 */
const mutatedKey = "mutated"

/** Whether a settled call measured, itself, that its tree moved. */
const mutatedOf = (value: Schema.Json): boolean =>
  value !== null && typeof value === "object" && !Array.isArray(value) &&
  (value as Record<string, unknown>)[mutatedKey] === true

/**
 * The message of a frame failure that is not already a harness error: the
 * fixed headline and the failure's own code and sentence, on one bounded
 * line, so a reader of the message alone (a receipt, a reply) learns why,
 * such as a provider refusing for want of credits. The typed failure stays
 * the error's `cause`.
 */
const frameFailureMessage = (error: unknown): string => {
  const row = typeof error === "object" && error !== null ? error as Record<string, unknown> : {}
  const said = typeof row["message"] === "string" ? row["message"].replace(/\s+/g, " ").trim() : ""
  if (said === "") return "The cell frame failed"
  const code = typeof row["code"] === "string" && row["code"] !== "" ? `${row["code"].slice(0, 64)}: ` : ""
  return `The cell frame failed: ${code}${said.slice(0, 1_000)}`
}

/**
 * What a run says when its frame budget, rather than the run, ended it.
 *
 * A run that never completed has only the budget to report. A run whose
 * completion was handed back for one of the completion demands has something
 * else: an answer it already gave, which the controller took away on the
 * promise of another frame. If that frame goes elsewhere — a cell that raises,
 * a refused park, more work than the budget has room for — the promise is the
 * only thing left, and dropping the answer would make the demand cost the run
 * exactly the thing it was meant to protect. Both facts are reported: the
 * budget ended the run, and this is what the run last said its answer was.
 *
 * Which demand took it is not named here. Three of them can, each writes its
 * own control event when it fires, and a sentence naming one of the three
 * would be wrong for the other two — as this one was, when the narrowing
 * demand was the only demand there was.
 */
const budgetMessage = (state: State): string =>
  state.bouncedCompletion === undefined
    ? `The frame budget of ${state.maxFrames} is exhausted. The run stops here; the last transition was a request to continue.`
    : `The frame budget of ${state.maxFrames} is exhausted. This run completed once and had that completion handed back for another frame, so what it reported then stands here rather than being lost:\n\n${state.bouncedCompletion}`

/**
 * Resolves one cell call into a durable engine boundary.
 *
 * Resolution happens here, at the boundary, and not inside the sandbox: the
 * flow must exist in the catalog this frame was given, be model-invocable, and
 * every capability it declares must still be inside the run's narrowed envelope. Both denials are
 * ordinary call failures the cell can catch, which is what lets an agent
 * discover the shape of its authority without crashing the run.
 *
 * The truncation ledger is kept here for the same reason. The boundary is the
 * only party that sees both a result that declared its capture cut short and a
 * later call handing those exact bytes to something that writes, and a write of
 * a known fragment is refused rather than performed. See `TruncatedOutput`.
 *
 * `performed` collects the ordinal of every invocation that actually reached
 * the engine. The three refusals above return before it, and a refused call
 * changed nothing — so it must not read as a write to anything downstream. It
 * did once: the truncated-write refusal is the newest of the three and lands on
 * exactly the calls the read-only cap watches, so a run whose only edit was
 * refused had its read-only streak cleared by a write that never happened, and
 * the cap stayed silent through the stall it exists to break.
 *
 * `restored` collects every withheld flow a call named. The call is refused,
 * because the frame's catalog is frozen, and the flow is back in `ctx.flows`
 * from the next frame. The refusal reads only checkpointed state, so a
 * replayed frame restores the same names.
 *
 * `tree` counts the calls of this frame that may have written, in issue order,
 * and chains their digests. A sealed reading of the live tree carries both and
 * the run's frame clock as its `Cell.Call.epoch`, so a read after a write is a
 * new question and not a replay of the read before it. The count alone let two
 * runs on one tree — one that ran `git status`, one that edited the file —
 * key their next read alike, and the second replayed the first's pre-edit
 * text; the chain names which writes came first. Any call that is not sealed counts, not
 * only one that declared a write: a shell command declares nothing and writes
 * wherever it likes. The count advances when the call is issued, so a replayed
 * frame — which issues the same calls in the same order — derives the same
 * epochs and keys the same boundaries.
 *
 * `live` names the tree the frame opened on, which the counters alone cannot:
 * they start at zero in every run, so a read in a later run keyed the same as
 * one in an earlier run and replayed its answer over an edit made between the
 * two (#1948). It is the digest of a journaled measurement taken after the
 * model wait, so a replayed frame keys the same boundaries; without a whole
 * measurement it is the session and frame, and an unmeasured tree is reused
 * only inside the frame that read it.
 */
const callHandler = (
  state: State,
  cell: Cell.Source,
  descriptors: ReadonlyMap<string, Descriptor.FlowDescriptor>,
  engine: EngineLike.EngineLike,
  ledger: Array<TruncatedOutput.Capture>,
  performed: Set<number>,
  restored: Set<string>,
  tree: { writes: number; chain: string | undefined },
  live: Cell.LiveTree,
  callMs: number,
  replaying: boolean,
  emit: (event: AgentEvent.AgentEvent) => Effect.Effect<void>
): Sandbox.Handler =>
(invocation) =>
  Effect.gen(function*() {
    if (state.withheldFlows.includes(invocation.flow)) {
      restored.add(invocation.flow)
      return refusal(
        "flow_withheld",
        `Flow ${invocation.flow} was withheld for this task. It is in ctx.flows from the next frame; reissue the call.`
      )
    }
    const descriptor = descriptors.get(invocation.flow)
    if (descriptor === undefined) {
      return refusal("unknown_flow", `Unknown flow ${invocation.flow}. Only the flows in ctx.flows are callable.`)
    }
    // Checked here as well as in catalog filtering and `CellCalls`, so a host
    // that hands the frame more than the visible set still cannot let the
    // model run a host-only flow.
    if (!descriptor.modelInvocable) {
      return refusal("capability_refused", `Flow ${invocation.flow} is not model-invocable.`)
    }
    const envelope = CapabilitySet.fromPatterns(state.capabilityEnvelope)
    const refused = descriptor.capabilities.filter((declared) =>
      Option.match(Capability.parse(declared), {
        onNone: () => true,
        onSome: (capability) => !CapabilitySet.allows(envelope, capability)
      })
    )
    if (refused.length > 0) {
      return refusal(
        "capability_refused",
        `Flow ${invocation.flow} needs ${refused.join(", ")}, which is outside this run's capability envelope.`
      )
    }
    // Only a call that changes something is checked. Passing a fragment to a
    // search, a diff, or a summary is ordinary use of what the flow returned;
    // handing it to something that writes is the one case that destroys a file.
    const changes = mutating(descriptor, invocation.input)
    if (changes) {
      const found = TruncatedOutput.reuse(invocation.input, ledger)
      if (found !== undefined) {
        return refusal("truncated_write", TruncatedOutput.refusal(invocation.flow, found))
      }
    }
    // Where this call runs. A checkpoint is a tree the run has already been
    // handed back, so it is a *reading* position and nothing else: the whole
    // promise the surface makes is that taking a reading against one leaves the
    // work alone, and a flow that declared a write would break that promise
    // whichever tree the host materialized. Both refusals below are fail-soft,
    // because both are things a cell fixes on its next line.
    let at: string | undefined
    if (invocation.at !== undefined) {
      at = Cell.checkpointOf(invocation.at)
      if (at === undefined) {
        return refusal(
          "invalid_input",
          `The at option takes a checkpoint, which is what ctx.checkpoint() resolves with and what ctx.base is. It was given ${
            elide.head(CanonicalJson.stringify(invocation.at), 120, "the rest is the same shape")
          }.`
        )
      }
      if (changes) {
        return refusal(
          "checkpoint_readonly",
          `Flow ${invocation.flow} declares a write, and a checkpoint is a read-only view of a tree that has already been. Nothing was run. Make the change on the live tree, and keep at for the readings you take against ${at}.`
        )
      }
    }
    const sealed = descriptor.effects.tier === "sealed"
    const epoch = sealed && at === undefined
      ? {
        frames: state.mutations,
        calls: tree.writes,
        ...(tree.chain === undefined ? {} : { writes: tree.chain }),
        ...live
      }
      : undefined
    const call = Cell.callOf(descriptor, {
      input: invocation.input,
      identity: new Cell.CallIdentity({
        session: state.session,
        frame: state.frame,
        cell: cell.digest,
        ordinal: invocation.ordinal,
        declaration: Cell.declarationDigest(descriptor),
        layers: [...new Set(state.layers)].sort()
      }),
      ...(at === undefined ? {} : { at }),
      ...(epoch === undefined ? {} : { epoch })
    })
    performed.add(invocation.ordinal)
    if (!sealed) {
      tree.writes++
      tree.chain = Digest.digest(
        CanonicalJson.stringify([tree.chain ?? null, signatureOf(invocation.flow, invocation.input, at)])
      )
    }
    yield* emit(new AgentEvent.CellCallStarted({ eventType: eventType.cellCallStarted, call }))
    const result = yield* issued(
      engine,
      state,
      cell.digest,
      invocation.ordinal,
      callMs,
      invocation.flow,
      // A flow that asks Jev journals its receipts into this run.
      Effect.suspend(() => engine.call(call)).pipe(Effect.provideService(AgentEvent.Journal, emit)),
      replaying,
      call
    )
    if (result.outcome === "success") ledger.push(...TruncatedOutput.captures(call.flowName, result.value))
    yield* emit(
      new AgentEvent.CellCallSettled({
        eventType: eventType.cellCallSettled,
        flowName: call.flowName,
        identity: call.identity,
        result
      })
    )
    return result
  })

/**
 * Journals what one model call is about to be asked.
 *
 * Emitted before the sealed step rather than beside its settlement, so a call
 * that never settles still leaves its request behind. What is journaled is the
 * request as the host will send it, which is not always the one built here:
 * see {@link EngineLike.EngineLike.resolve}, which is also why the answer is
 * asked for on every attempt and not recorded.
 *
 * A host that cannot say what it would send leaves no record. The sealed step
 * that follows fails on the same request, so the call the missing record would
 * have described is one that was never made.
 */
const requested = (
  state: State,
  engine: EngineLike.EngineLike,
  request: ModelRequest.ModelRequest,
  purpose: AgentEvent.ModelRequested["purpose"],
  attempt: number,
  emit: (event: AgentEvent.AgentEvent) => Effect.Effect<void>
): Effect.Effect<void> =>
  Effect.gen(function*() {
    const resolved = yield* EngineLike.resolve(engine, request)
    if (Option.isNone(resolved)) return
    yield* emit(
      new AgentEvent.ModelRequested({
        eventType: eventType.modelRequested,
        scope: state.session,
        frame: state.frame,
        attempt,
        purpose,
        seat: state.seat,
        binding: Option.getOrUndefined(resolved.value.binding),
        request: resolved.value.request
      })
    )
  })

/** The sealed summary of what a compaction step squashes. */
const summarized = (
  state: State,
  engine: EngineLike.EngineLike,
  emit: (event: AgentEvent.AgentEvent) => Effect.Effect<void>,
  step: Compaction.CompactionStep
): Effect.Effect<ModelRequest.Message, HarnessError | Model.ModelFailure> =>
  Effect.gen(function*() {
    const summaryRequest = yield* Compaction.summaryRequest(state.contextWindow, step).pipe(Effect.orDie)
    const request = ModelRequest.ModelRequest.make({
      modelId: summaryRequest.modelId,
      system: summaryRequest.system,
      messages: summaryRequest.messages,
      tools: [],
      toolChoice: "none",
      params: summaryRequest.params
    })
    yield* requested(state, engine, request, "compaction", 1, emit)
    const events = yield* Stream.runCollect(
      (engine.sealStepWithEvents?.({
        request,
        keyMaterial: keyMaterialFrom(state, state.contextWindow, request),
        modelCallMs: state.modelCallMs
      }, emit) ?? engine.sealStep({
        request,
        keyMaterial: keyMaterialFrom(state, state.contextWindow, request),
        modelCallMs: state.modelCallMs
      })).pipe(
        Stream.tap((event) => emitModelProgress(event, emit))
      )
    ).pipe(Effect.map((collected) => Array.from(collected)))
    if (!events.some((event) => event.type === "settle")) {
      return yield* new HarnessError({
        code: "model_failed",
        message: "The sealed compaction step ended without a recorded settlement"
      })
    }
    const settled = ModelEvent.ModelEvent.settledMessage(events)
    const text = settled.message.content.filter(
      (part): part is ModelRequest.TextPart => part.type === "text"
    )
    if (text.length === 0) {
      return yield* new HarnessError({
        code: "model_failed",
        message: "The sealed compaction step returned no text summary"
      })
    }
    return ModelRequest.Message.user(
      untrustedData(text.map((part) => part.text).join("\n"), "compaction summary of conversation and tool output")
    )
  })

const messageText = (message: ModelRequest.Message): string =>
  message.content.filter((part): part is ModelRequest.TextPart => part.type === "text").map((part) => part.text)
    .join("\n")

/** One old segment as the compaction reading shows it to Jev. */
const markItem = (segment: ContextWindow.Segment): compactionMarks.Item => {
  const messages = segment.content.filter((item): item is ModelRequest.Message => "role" in item)
  const said = messages.filter((message) => message.role === "assistant").map(messageText).join("\n")
  const extracted = Cell.extract(said)
  return {
    tokens: segment.tokens.value,
    cell: extracted._tag === "Success" ? extracted.success.source.text : "",
    prose: Supervisor.prose(said),
    observed: messages.filter((message) => message.role !== "assistant").map(messageText).join("\n\n")
  }
}

/**
 * {@link State.segmentFacts} beside each compactable segment, absent for a
 * summary or steering segment; undefined when they do not describe every
 * transcript segment.
 */
const alignedFacts = (
  state: State,
  segments: ReadonlyArray<ContextWindow.Segment>
): ReadonlyArray<compactionMarks.Facts | undefined> | undefined => {
  const transcripts = segments.filter((segment) => segment.kind === "transcript").length
  if (transcripts !== state.segmentFacts.length) return undefined
  let next = 0
  return segments.map((segment) => segment.kind === "transcript" ? state.segmentFacts[next++] : undefined)
}

/**
 * The transcript segments a supervisor reading is asked to mark: those with
 * no answer yet, each once by digest. The person's are always kept and never
 * asked about; a run whose facts are not aligned marks nothing.
 */
const unmarked = (state: State): Supervision.Offer["unmarked"] => {
  const segments = compactable(state.contextWindow.segments)
  const facts = alignedFacts(state, segments)
  if (facts === undefined) return []
  const open = segments.flatMap((segment, index) => {
    const known = facts[index]
    return known === undefined || known.person || known.answer !== undefined ? [] : [segment]
  })
  return [...new Map(open.map((segment) => [segment.digest, segment])).values()].map((segment) => ({
    digest: segment.digest,
    item: markItem(segment)
  }))
}

/**
 * {@link State.segmentFacts} after a compaction: the entries of the kept
 * prefix segments and of the suffix, in order. `marks` absent squashes every
 * prefix segment.
 */
const factsAfter = (
  state: State,
  prefixLength: number,
  marks: ReadonlyArray<ContextWindow.Mark> | undefined
): ReadonlyArray<compactionMarks.Facts> => {
  const transcripts = compactable(state.contextWindow.segments).flatMap((segment, index) =>
    segment.kind === "transcript" ? [index] : []
  )
  // The entries describe the newest segments, so an unaligned run's are
  // missing from the front.
  const missing = transcripts.length - state.segmentFacts.length
  return transcripts.flatMap((index, at) => {
    const facts = state.segmentFacts[at - missing]
    return facts !== undefined && (index >= prefixLength || marks?.[index] === "keep") ? [facts] : []
  })
}

/** What the compaction-marks reading records: the mark of every prefix segment. */
const MarksRecord = Schema.Array(compactionMarks.Marked)

/**
 * The marks of a judged run's compaction, over its aligned `facts`: pins
 * first, then the answers the run stored for what they leave open, resolved
 * against the window. What is still unmarked is asked in one reading,
 * recorded under the prefix it marks, so a replay re-keys the same summary;
 * with nothing unmarked nothing is asked, and the stored answers, which
 * each recorded drain rebuilds, resolve the same marks on replay. Undefined,
 * and every segment squashed, when that reading could not be judged, which
 * journals `decision-unjudged`.
 */
const marked = (
  state: State,
  facts: ReadonlyArray<compactionMarks.Facts | undefined>,
  prefixLength: number,
  engine: EngineLike.EngineLike,
  emit: (event: AgentEvent.AgentEvent) => Effect.Effect<void>,
  taskOf: (window: ContextWindow.ContextWindow) => string
): Effect.Effect<ReadonlyArray<compactionMarks.Marked> | undefined, HarnessError> =>
  Effect.gen(function*() {
    const segments = compactable(state.contextWindow.segments)
    const failing = state.checks.filter((check) => check.failing).map((check) => check.label)
    const pinned = compactionMarks.pins(segments, prefixLength, facts, failing)
    const open = compactionMarks.unpinned(pinned)
    const missing = open.filter((index) => facts[index]?.answer === undefined)
    const budget: compactionMarks.Budget = {
      contextWindow: state.contextWindowTokens,
      reserve: defaultReserve,
      keepRecent: defaultKeepRecent,
      suffix: segments.slice(prefixLength).reduce((sum, segment) => sum + segment.tokens.value, 0),
      tokens: segments.slice(0, prefixLength).map((segment) => segment.tokens.value)
    }
    // `InvalidStep` is a defect: one answer per open index, by construction.
    const resolved = (answered: ReadonlyMap<number, compactionMarks.Answer>) =>
      Effect.fromResult(compactionMarks.resolve(open.map((index) => answered.get(index)!), pinned, budget)).pipe(
        Effect.orDie
      )
    const stored = new Map(open.flatMap((index) => {
      const answer = facts[index]?.answer
      return answer === undefined ? [] : [[index, answer] as const]
    }))
    if (missing.length === 0) return yield* resolved(stored)
    const prefix = yield* Effect.fromResult(ContextWindow.prefixDigest(state.contextWindow, prefixLength)).pipe(
      Effect.orDie
    )
    const record = yield* Judgement.recorded(
      engine,
      {
        name: "compaction-marks",
        identity: { session: state.session, frame: state.frame, boundary: `compaction-marks:${prefix}` },
        classifier: "compaction/marks",
        value: MarksRecord,
        items: missing.length
      },
      compactionMarks.read(
        { task: Judgement.task(taskOf(state.contextWindow)), failing },
        missing.map((index) => markItem(segments[index]!))
      ).pipe(Effect.flatMap((reading) =>
        resolved(new Map([...stored, ...missing.map((index, at) => [index, reading.answers[at]!] as const)])).pipe(
          Effect.map((value) => ({
            value,
            asked: reading.asked,
            acted: value.some((mark) => mark.mark !== "squash")
          }))
        )
      ))
    )
    yield* Judgement.emitRecorded(emit, record)
    return record.value ?? undefined
  })

/**
 * Compacts the frame's context before the model is asked anything.
 *
 * Compaction is a transition of the run, not a repair applied to a request on
 * its way out: the summary is produced by its own sealed step, so it is keyed
 * and journaled like every other model call, and the settlement is emitted as
 * `CompactionSettled`. Without that event a replay rebuilds the uncompacted
 * transcript, re-crosses the same threshold, and re-keys every later frame — so
 * emitting it is what makes the compacted window part of the run's durable
 * state rather than an artifact of when the process happened to notice.
 *
 * A judged run marks each replaced segment keep, squash or remove first, and
 * only what it squashes is summarized; an unjudged one squashes all of them.
 * Marks are stored as the supervisor reads them and applied only here, when
 * the budget forces a compaction, so the prefix the model is sent never
 * changes between compactions. A judged run whose facts are not aligned
 * cannot be marked; its settlement says so as `unaligned`.
 *
 * Nothing here is best-effort. A window that cannot be compacted stays as it
 * is; a compaction the model started and could not finish is a typed failure.
 */
const compacted = (
  state: State,
  engine: EngineLike.EngineLike,
  emit: (event: AgentEvent.AgentEvent) => Effect.Effect<void>,
  judged: boolean,
  taskOf: (window: ContextWindow.ContextWindow) => string
): Effect.Effect<State, HarnessError | Model.ModelFailure> =>
  Effect.gen(function*() {
    const over = Compaction.shouldCompact({
      total: state.contextWindow.tokens.total,
      contextWindow: state.contextWindowTokens
    })
    if (!over) return state
    const prefixLength = Compaction.selectPrefix(state.contextWindow)
    // Nothing compactable is not a failure: a window that is all prefix has
    // already given up everything it can, and the frame proceeds as declared.
    if (prefixLength === 0) return state
    const facts = judged ? alignedFacts(state, compactable(state.contextWindow.segments)) : undefined
    const unaligned = judged && facts === undefined
    const marks = facts === undefined ? undefined : yield* marked(state, facts, prefixLength, engine, emit, taskOf)
    // `InvalidStep` is discharged as a defect, not surfaced as a typed failure.
    // Every call below receives the same immutable window, `selectPrefix`'s
    // own output, marks resolved one per prefix segment, and the state's
    // validated generation parameters. An invalid prefix, digest, mark or
    // parameter value here would contradict those invariants.
    const step = yield* Compaction.declare(
      state.contextWindow,
      prefixLength,
      {
        identity: "flows/harness/CellTurn.compaction",
        modelId: state.contextWindow.modelId,
        params: state.modelParams
      },
      marks?.map((mark) => mark.mark)
    ).pipe(Effect.orDie)
    const summary = marks === undefined || marks.some((mark) => mark.mark === "squash")
      ? yield* summarized(state, engine, emit, step)
      : undefined
    const contextWindow = yield* Compaction.apply(state.contextWindow, step, summary).pipe(Effect.orDie)
    const segments = compactable(state.contextWindow.segments)
    const replaced = segments.slice(0, prefixLength)
    yield* emit(
      new AgentEvent.CompactionSettled({
        eventType: eventType.compactionSettled,
        replacedPrefixDigest: step.replacedPrefixDigest,
        retainedMessageCount: segments
          .slice(prefixLength)
          .flatMap((segment) => segment.content)
          .filter((item) => "role" in item).length,
        ...(summary === undefined ? {} : { summary }),
        ...(unaligned ? { unaligned } : {}),
        ...(marks === undefined ? {} : {
          kept: replaced
            .filter((_, index) => marks[index]!.mark === "keep")
            .flatMap((segment) => segment.content.filter((item): item is ModelRequest.Message => "role" in item)),
          marks: replaced.map((segment, index) => ({ digest: segment.digest, ...marks[index]! })),
          removedTokens: replaced
            .filter((_, index) => marks[index]!.mark === "remove")
            .reduce((sum, segment) => sum + segment.tokens.value, 0)
        })
      })
    )
    return advance(state, {
      contextWindow,
      segmentFacts: factsAfter(state, prefixLength, marks?.map((mark) => mark.mark)),
      // The sections that listed earlier calls may be among what was replaced.
      ledgerShown: 0
    })
  })

/**
 * The step the controller takes after one frame settles.
 */
type Step =
  | { readonly _tag: "Continue"; readonly state: State }
  | { readonly _tag: "Done" }
  | { readonly _tag: "Suspend"; readonly reason: EngineLike.SuspendReason }

type Continue = Extract<Step, { readonly _tag: "Continue" }>

/** A cell one answer carried, compiled once at the boundary. */
interface Produced {
  readonly source: Cell.Source
  readonly blocks: number
  /** What the realm runs: the boundary parse is the only one a cell gets. */
  readonly program: string
}

/**
 * The cell one answer carries, or why it carries none that can run.
 *
 * The parse the realm used to do, done here instead: a cell that cannot run is
 * refused before the frame commits to it.
 */
const parsed = (message: ModelRequest.AssistantMessage): Result.Result<Produced, Cell.Rejected> => {
  if (message.stopReason === "length") {
    return Result.fail(
      new Cell.Rejected({
        code: "output_truncated",
        message:
          "The model reached its output limit (length) before finishing the response. No blocks ran. Emit a shorter, complete cell."
      })
    )
  }
  const extracted = Cell.extract(assistantText(message))
  if (extracted._tag === "Failure") return Result.fail(extracted.failure)
  const validation = CellValidation.validate(extracted.success.source)
  return validation.rejected === undefined
    ? Result.succeed({
      source: extracted.success.source,
      blocks: extracted.success.blocks,
      program: validation.compiled
    })
    : Result.fail(validation.rejected)
}

/** What one frame's sealed model step settled. */
interface Sealed {
  /** The window the kept answer was given against, in-frame re-asks included. */
  readonly contextWindow: ContextWindow.ContextWindow
  /** The model's last answer, which is the one the frame keeps. */
  readonly answer: ModelRequest.AssistantMessage
  /** The cell that answer carried, or why the last answer carried none. */
  readonly cell: Result.Result<Produced, Cell.Rejected>
}

/**
 * The sealed model step, and the boundary parse of whatever it answered with.
 *
 * A cell that does not parse never ran: the world is exactly where the frame
 * found it, so there is nothing to record and everything to gain by asking
 * again inside this frame. The prefix of the re-prompt is byte-identical to the
 * one just sent, so the provider serves it from its cache and the answer costs
 * the output it writes.
 */
const seal = (
  state: State,
  engine: EngineLike.EngineLike,
  emit: (event: AgentEvent.AgentEvent) => Effect.Effect<void>
): Effect.Effect<Sealed, HarnessError | Model.ModelFailure> =>
  Effect.gen(function*() {
    let contextWindow = state.contextWindow
    for (let attempt = 0;; attempt++) {
      const request = yield* Effect.fromResult(requestFrom(state, contextWindow))
      yield* requested(state, engine, request, "frame", attempt + 1, emit)
      // Timed on the injected clock, never on ambient wall time, so a test that
      // supplies a clock sees the duration it declared.
      const startedAt = yield* Clock.currentTimeMillis
      const events = yield* Stream.runCollect(
        (engine.sealStepWithEvents?.({
          request,
          keyMaterial: keyMaterialFrom(state, contextWindow, request),
          modelCallMs: state.modelCallMs
        }, emit) ?? engine.sealStep({
          request,
          keyMaterial: keyMaterialFrom(state, contextWindow, request),
          modelCallMs: state.modelCallMs
        })).pipe(
          Stream.tap((event) => emitModelProgress(event, emit))
        )
      ).pipe(Effect.map((collected) => Array.from(collected)))
      const settledAt = yield* Clock.currentTimeMillis
      if (!events.some((event) => event.type === "settle")) {
        return yield* new HarnessError({
          code: "model_failed",
          message: "The sealed model step ended without a recorded settlement"
        })
      }
      const settled = ModelEvent.ModelEvent.settledMessage(events)
      const sessionId = events.find((event) => event.type === "settle")?.sessionId
      yield* emit(
        new AgentEvent.ModelSettled({
          eventType: eventType.modelSettled,
          message: settled.message,
          usage: settled.usage,
          ...(sessionId === undefined ? {} : { sessionId }),
          durationMillis: settledAt - startedAt
        })
      )
      const cell = parsed(settled.message)
      if (cell._tag === "Success" || attempt >= state.revalidations) {
        return { contextWindow, answer: settled.message, cell }
      }
      yield* emit(
        new AgentEvent.CellRejectedInFrame({
          eventType: eventType.cellRejectedInFrame,
          attempt: attempt + 1,
          code: cell.failure.code,
          message: cell.failure.message
        })
      )
      contextWindow = observedOn(
        contextWindow,
        settled.message,
        revalidationNote(cell.failure),
        deadCellEcho
      )
    }
  })

/** What one cell did when it ran. */
interface Evaluated {
  /** The frame the realm settled, as the journal holds it. */
  readonly frame: typeof RecordedFrame.Type
  /** Every call the cell made, in the order they settled. */
  readonly calls: ReadonlyArray<Frame.ObservedCall>
  /** Ids of the trees the cell pinned, oldest first. */
  readonly minted: ReadonlyArray<string>
  /** Output this run has been handed as a fragment, this frame's included. */
  readonly captures: ReadonlyArray<TruncatedOutput.Capture>
  /** Withheld flows the cell called, which the next frame shows again. */
  readonly restored: ReadonlySet<string>
}

/**
 * Runs one cell in the run's realm and records the frame it settles.
 *
 * Each of the cell's calls resolves as its own keyed boundary through
 * {@link callHandler}, and each one it settles is observed on the way out, so
 * what the cell did is returned as values rather than left in variables the
 * frame's exits read.
 */
const evaluate = (
  input: Input,
  state: State,
  produced: Produced,
  engine: EngineLike.EngineLike,
  sandbox: Sandbox.Sandbox,
  realm: Sandbox.Realm,
  opened: Option.Option<EngineLike.Observation>,
  emit: (event: AgentEvent.AgentEvent) => Effect.Effect<void>
): Effect.Effect<Evaluated, HarnessError | Sandbox.SandboxError> =>
  Effect.gen(function*() {
    const cell = produced.source
    const descriptors = new Map(input.flows.map((descriptor) => [descriptor.name, descriptor]))
    const projections: Record<string, Cell.FlowProjection> = {}
    for (const descriptor of input.flows) projections[descriptor.name] = Cell.project(descriptor)
    // Seeded from what earlier frames were handed, appended to as this frame's
    // calls settle, and carried out through every exit that continues the run.
    const captures: Array<TruncatedOutput.Capture> = [...state.truncatedOutputs]
    const calls: Array<Frame.ObservedCall> = []
    /** Ordinals of the invocations that reached the engine this frame. */
    const performed = new Set<number>()
    /** Withheld flows this frame's calls named; see {@link callHandler}. */
    const restored = new Set<string>()
    /** Calls of this frame that may have written; see {@link callHandler}. */
    const tree: { writes: number; chain: string | undefined } = { writes: 0, chain: undefined }
    const live: Cell.LiveTree = Option.isSome(opened) && opened.value.complete
      ? { tree: opened.value.digest }
      : { session: state.session, frame: state.frame }
    // The per-call ceiling this frame enforces, resolved once. It is applied
    // where the settlement is recorded rather than in the drive loop, so the
    // number a run armed and the number its journal holds are the same one.
    const callMs = Sandbox.withDefaults(sandbox.capabilities, input.limits).callMs ?? Sandbox.defaultLimits.callMs
    const totalMs = Sandbox.withDefaults(sandbox.capabilities, input.limits).totalMs
    let replaying = false
    const observing: Sandbox.Handler = (invocation) => {
      const handle = callHandler(
        state,
        cell,
        descriptors,
        engine,
        captures,
        performed,
        restored,
        tree,
        live,
        callMs,
        replaying,
        emit
      )
      return handle(invocation).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            const rendered = result.outcome === "success"
              ? JSON.stringify(result.value)
              : result.message ?? "failed"
            // The ordinal this call will carry in the run's ledger, computed
            // here so the salvage line can name it: a summary the next frame
            // cannot expand is a summary it will pay to re-fetch.
            const ordinal = CallLedger.settled(state.callLedger) + calls.length + 1
            const descriptor = descriptors.get(invocation.flow)
            const probe = result.outcome === "success" ? invalidProbeOf(result.value) : undefined
            // A write the call measured itself, on a tree the host walk does
            // not cover. It stands beside the declaration, never instead of it.
            const measured = performed.has(invocation.ordinal) && result.outcome === "success" &&
              mutatedOf(result.value)
            // The tree this call actually ran against. A call the boundary
            // refused ran against nothing, and one whose `at` did not decode
            // named nothing, so neither keys anything: `performed` is the set
            // the boundary let through.
            const ranAt = performed.has(invocation.ordinal) && invocation.at !== undefined
              ? Cell.checkpointOf(invocation.at)
              : undefined
            calls.push({
              flow: invocation.flow,
              ok: result.outcome === "success",
              summary: elide.head(rendered, salvageSummary, salvageRecall),
              ordinal,
              mutates: (performed.has(invocation.ordinal) && descriptor !== undefined &&
                mutating(descriptor, invocation.input)) || measured,
              remote: measured,
              // Every invocation the cell issued, refused ones included: a
              // refusal is still a question the run has already asked, and
              // asking it again learns nothing either.
              signature: signatureOf(invocation.flow, invocation.input, ranAt),
              subject: signatureOf(invocation.flow, invocation.input),
              at: ranAt,
              input: invocation.input,
              value: result.value,
              message: result.message,
              invalidProbe: probe,
              failing: result.outcome === "success" && probe === undefined &&
                UnresolvedFailure.failed(result.value),
              passing: result.outcome === "success" && probe === undefined &&
                UnresolvedFailure.passed(result.value)
            })
          })
        )
      )
    }
    // One realm per run. It is the caller's scoped resource, so the loop hands
    // it the cell and the call handler and nothing else about how a frame runs
    // depends on where the realm came from.
    const minted: Array<string> = []
    const mint = minter(state, cell, engine, minted, callMs, emit)
    // The script the model may promote into a saved flow. It is recorded before
    // the realm evaluates the cell, so a cell that raises is still part of what
    // the run ran. A host that offers no way to save a flow binds no history and
    // nothing is kept.
    const history = yield* Effect.serviceOption(CellHistory.CellHistory)
    yield* Option.match(history, {
      onNone: () => Effect.void,
      onSome: (recorder) => recorder.record(cell.text)
    })
    const settled = yield* Effect.gen(function*() {
      // A null record marks an attempt that has not produced a frame yet.
      // Skip saved markers until the terminal frame is found, or append a new
      // marker and evaluate outside any activity. This keeps durable waits and
      // permission parks out of the frame record's execution context.
      for (let attempt = 0;; attempt++) {
        const identity = (slot: number): EngineLike.BoundaryIdentity => ({
          session: state.session,
          frame: state.frame,
          boundary: `cell-frame:${cell.digest}${slot === 0 ? "" : `:attempt:${slot}`}`
        })
        let fresh = false
        const recorded = yield* engine.record({
          name: "cell-frame",
          identity: identity(attempt),
          success: Schema.NullOr(RecordedFrame),
          execute: Effect.sync(() => {
            fresh = true
            return null
          })
        })
        if (recorded === null && !fresh) continue
        if (
          recorded !== null && recorded.boundary === undefined &&
          recorded.outcome._tag === "rejected" && recorded.outcome.code === "limit_exceeded"
        ) {
          return yield* Effect.fail(
            new HarnessError({
              code: "incompatible_journal",
              message: "Cannot reconstruct a limited frame without its recorded execution frontier"
            })
          )
        }
        const replay = recorded !== null && recorded.boundary?.terminal === "timeout"
          ? { boundary: recorded.boundary, outcome: yield* Cell.decodeOutcome(recorded.outcome) }
          : undefined
        replaying = replay !== undefined
        // A guarded host parks a frame past its wall-clock limit instead of
        // recording it. The subject is the frame, not its attempt, so Stop
        // refuses the re-evaluation here and Continue re-evaluates it with
        // its settled calls replayed.
        const guarded = recorded === null && engine.guard !== undefined ? engine.guard : undefined
        const subject = JSON.stringify({
          session: state.session,
          frame: state.frame,
          boundary: `cell-frame:${cell.digest}`
        })
        if (guarded !== undefined) yield* guarded.admit(subject)
        const frame = yield* realm.evaluate({
          cell,
          // The boundary parse is the only one this cell gets: the realm runs
          // what it compiled rather than parsing the same text again.
          program: produced.program,
          frame: state.frame,
          // A judged run's catalog can change without a refresh: the run-start
          // relevance reading withholds flows and a call restores them.
          flows: input.refreshFlows === undefined && input.judged !== true ? undefined : projections,
          call: observing,
          mint,
          replay,
          // Settlements are bounded inside their recorded boundaries.
          bounded: true
        })
        if (recorded !== null) return recorded
        const outcome = yield* Cell.decodeOutcome(frame.outcome)
        if (
          guarded !== undefined && frame.boundary?.terminal === "timeout" &&
          outcome._tag === "rejected" && outcome.code === "limit_exceeded"
        ) {
          yield* guarded.trip({ source: "cell", subject, limitMillis: totalMs, message: outcome.message })
        }
        return yield* engine.record({
          name: "cell-frame",
          identity: identity(attempt + 1),
          success: RecordedFrame,
          execute: Effect.succeed({ ...frame, outcome })
        })
      }
    })
    return { frame: settled, calls, minted, captures, restored }
  })

/**
 * Accepted steering changes the task the completion is judged against. Keep
 * its provenance separate from the transcript: cell prints are also user
 * messages, and a compacted summary is not an instruction from the person.
 * The original task keeps both ends so a long history cannot displace its
 * newest request. Steering keeps the newest bytes, in admission order.
 */
const completionTask = (task: string, instructions: string): string =>
  instructions === ""
    ? task
    : `${elide.middle(task, 3584, "the run record has the whole task")}

The person now says:

Later instructions accepted during this run, oldest first. Apply these changes to the task above; later changes take precedence:

${instructions}`

/**
 * Everything an exit of one frame reads, fixed once the frame knows what it did.
 *
 * Every field is settled before the first exit is taken and none is written
 * after, so an exit reads the frame's record rather than a variable an earlier
 * branch may or may not have set.
 */
interface Settling {
  readonly input: Input
  readonly state: State
  readonly engine: EngineLike.EngineLike
  readonly steering: Steering.Source
  /** The supervisor's mailbox, taken at the boundary that delivers it. */
  readonly supervision: Supervision.Handle
  /**
   * This frame's snapshot, offered to the supervisor by the first boundary
   * that executes live; empty for a frame that ran no cell. See {@link drain}.
   */
  readonly offer: Effect.Effect<void>
  /**
   * Whether this frame's boundary executed rather than replayed, known once
   * {@link drain} has run. A replayed frame is never offered: its reading, if
   * one was taken, is already in the journal, and a fresh one would be a
   * second reading of a frame the run has moved past.
   */
  readonly live: { value: boolean }
  readonly emit: (event: AgentEvent.AgentEvent) => Effect.Effect<void>
  /** The window the kept answer was given against, in-frame re-asks included. */
  readonly contextWindow: ContextWindow.ContextWindow
  /** The model's answer the frame keeps. */
  readonly answer: ModelRequest.AssistantMessage
  /** What the steering drain is keyed on: the cell, or the window when no cell parsed. */
  readonly boundary: string
  /**
   * What the next model turn is told about the frame's print buffer, as
   * `printsObservation` renders it; empty when no cell ran.
   *
   * The whole of the context channel, delivered once and appended rather than
   * rebuilt: a run's window is `[cell₁, prints₁], [cell₂, prints₂], …` plus
   * whatever the harness has to say, so the tail is byte-identical to the
   * previous frame's tail plus one pair. That is exactly what a provider's
   * prefix cache is for, and it is what the per-frame rebuild of the transcript
   * this replaced could never be.
   */
  readonly printed: string
  /** The state every continuing exit carries; see `Frame.account`. */
  readonly facts: Frame.StateChanges
  /** Whether the frame changed files, and the labels of the checks it ran. */
  readonly written: { readonly mutated: boolean; readonly checks: ReadonlyArray<string> }
}

/**
 * Records the frame's steering delivery decision.
 *
 * Every exit records one. With no frame left to read a message, keep it pending
 * at the source instead of acknowledging and discarding it. Replays see the
 * same decision under the same boundary.
 */
const drain = (settling: Settling, wouldIdle: boolean): Effect.Effect<Steering.DrainRecord, HarnessError> =>
  Effect.gen(function*() {
    const { boundary, state } = settling
    const drained = yield* settling.engine.record({
      name: "steering-drain",
      identity: { session: state.session, frame: state.frame, boundary: `steering-drain:${boundary}` },
      success: Steering.DrainRecord,
      execute: Frame.hasNextFrame(state)
        ? settling.steering.drain({ boundary: `${state.frame}:${boundary}`, wouldIdle }).pipe(
          Effect.map(Steering.drainRecord),
          // The supervisor's nudge rides the same recorded drain, in a field
          // of its own and only at a boundary the run continues through: a
          // boundary that would idle is a completion or the last frame, and a
          // nudge there would turn a finished answer into a follow-up. Inside
          // the record, so a replayed boundary delivers what it delivered the
          // first time. Apart from `inserts`, because those are the person's
          // words and the completion brake reads them as the task; a nudge is
          // not. See `internal/supervision`.
          Effect.flatMap((record) =>
            wouldIdle
              ? Effect.succeed(record)
              : settling.supervision.take(state.frame, {
                ledger: state.monitorLedger,
                shown: state.memoryShown,
                deliver: settling.input.judged ?? false
              }).pipe(
                Effect.map((taken) => ({
                  ...record,
                  ...(taken.messages.length === 0 ? {} : { supervisor: taken.messages }),
                  ...(taken.memory.length === 0 ? {} : { memory: taken.memory }),
                  ...(taken.monitor === undefined ? {} : { monitor: taken.monitor }),
                  ...(taken.suppressed.length === 0 ? {} : { suppressed: taken.suppressed }),
                  ...(taken.ledger === undefined ? {} : { monitorLedger: taken.ledger }),
                  ...(taken.marks.length === 0 ? {} : { marks: taken.marks })
                }))
              )
          ),
          // Executed, not replayed: the one fact that says this frame is the
          // run's present rather than its past.
          Effect.tap(() => Effect.sync(() => void (settling.live.value = true)))
        )
        : Effect.succeed({ inserts: [], seatChanges: [], queued: false })
    })
    yield* settling.emit(
      new AgentEvent.SteeringDrained({
        eventType: eventType.steeringDrained,
        messages: drained.inserts,
        ...(drained.supervisor === undefined || drained.supervisor.length === 0
          ? {}
          : { supervisor: drained.supervisor }),
        ...(drained.monitor === undefined ? {} : { monitor: drained.monitor }),
        ...(drained.suppressed === undefined ? {} : { suppressed: drained.suppressed }),
        ...(drained.memory === undefined ? {} : { memory: drained.memory })
      })
    )
    // The frame is offered to the supervisor from here, after its own take
    // and only from a live boundary the run continues through, so the
    // reading it produces is delivered by the boundary after this one and a
    // replayed frame is never read twice. A boundary that would idle offers
    // nothing: the run is completing or out of frames.
    if (settling.live.value && !wouldIdle) yield* settling.offer
    return drained
  })

/** Closes the frame's turn, and states the run's answer when it resolves. */
const close = (
  settling: Settling,
  outcome: "continue" | "resolved" | "suspended",
  output: string = budgetMessage(settling.state)
): Effect.Effect<void> =>
  Effect.gen(function*() {
    yield* settling.emit(
      new AgentEvent.TurnClosed({
        eventType: eventType.turnClosed,
        stopReason: settling.answer.stopReason,
        outcome
      })
    )
    if (outcome === "resolved") {
      yield* settling.emit(
        new AgentEvent.Resolved({
          eventType: eventType.resolved,
          message: ModelRequest.Message.assistant(output, { stopReason: "stop" })
        })
      )
    }
  })

/** Closes the turn the way a step ends it, and hands the step on. */
const finish = (settling: Settling, step: Step): Effect.Effect<Step> =>
  close(settling, step._tag === "Done" ? "resolved" : step._tag === "Suspend" ? "suspended" : "continue").pipe(
    Effect.as(step)
  )

/**
 * The one way a frame continues the run: the next frame on `contextWindow`,
 * carrying the facts the frame measured and whatever its exit changes on top
 * of them.
 *
 * Every transcript segment the frame appended gets its entry in
 * {@link State.segmentFacts}. The last carries the frame's own pair, and the
 * person's messages when `person`; any before it are the in-frame re-asks of
 * cells that never ran.
 */
const continuing = (
  settling: Settling,
  contextWindow: ContextWindow.ContextWindow,
  person: boolean,
  changes: Frame.StateChanges
): Continue => {
  const transcripts = (window: ContextWindow.ContextWindow): number =>
    window.segments.filter((segment) => segment.kind === "transcript").length
  const frame = settling.state.frame
  const reasks = transcripts(contextWindow) - transcripts(settling.state.contextWindow) - 1
  // A drain's marks answer segments the frame opened on; the frame's own
  // segments go after them, unmarked.
  const { segmentFacts = settling.state.segmentFacts, ...rest } = changes
  // A frame carries no ask unless its own exit says how many it appended, so
  // the default is zero and the two exits that intervene state their count.
  const next = advance(settling.state, {
    frame: frame + 1,
    interventions: 0,
    // What this frame's section listed; see `frozen`.
    ledgerShown: CallLedger.settled(settling.state.callLedger),
    ...settling.facts,
    contextWindow,
    segmentFacts: [
      ...segmentFacts,
      ...new Array<compactionMarks.Facts>(reasks).fill({ frame, person: false, mutated: false, checks: [] }),
      { frame, person, ...settling.written }
    ],
    ...rest
  })
  // The next frame's section, written into the segment this frame appended
  // before anything reads that segment. See `frozen`.
  return {
    _tag: "Continue",
    state: advance(next, { contextWindow: withSection(next.contextWindow, next), sectioned: true })
  }
}

/**
 * Everything a drain delivers to the model, in the order it reads them: the
 * supervisor's messages, then the person's.
 */
const delivered = (drained: Steering.DrainRecord): ReadonlyArray<ModelRequest.Message> => [
  ...(drained.supervisor ?? []),
  ...drained.inserts
]

/**
 * Continues the run on the frame's own pair and whatever steering it was sent.
 *
 * `ask` is what the frame demands of the next one, when it demands anything.
 * It goes last, below whatever the drain delivered, because a run answers the
 * last message it read: an insert after the ask is what gets answered. With
 * nothing delivered the observation and the ask stay one message, as they
 * always were.
 */
const resumed = (
  settling: Settling,
  drained: Steering.DrainRecord,
  changes: Frame.StateChanges = {},
  text: string = settling.printed,
  echo: number = liveCellEcho,
  ask?: string
): Effect.Effect<Continue, HarnessError> =>
  Effect.gen(function*() {
    const { state } = settling
    const settings = yield* steered(state, drained.seatChanges, settling.input.contextWindowTokensFor)
    const inserts = delivered(drained)
    const messages = ask === undefined
      ? [ModelRequest.Message.user(text), ...inserts]
      : inserts.length === 0
      ? [ModelRequest.Message.user(text === "" ? ask : `${text}\n\n${ask}`)]
      : [...(text === "" ? [] : [ModelRequest.Message.user(text)]), ...inserts, ModelRequest.Message.user(ask)]
    const context = appended(settling.contextWindow, settling.answer, messages, echo)
    return continuing(settling, windowOn(state, settings.seat, context), drained.inserts.length > 0, {
      ...settings,
      ...shownAfter(state, drained),
      ...ledgerAfter(drained),
      ...marksAfter(state, drained),
      ...changes
    })
  })

/** Records an unusable frame and asks for another, budget permitting. */
const observe = (
  settling: Settling,
  note: string,
  changes: Frame.StateChanges = {},
  echo: number = liveCellEcho
): Effect.Effect<Step, HarnessError> =>
  Effect.gen(function*() {
    const next = Frame.hasNextFrame(settling.state)
    const drained = yield* drain(settling, !next)
    return next
      ? yield* resumed(settling, drained, changes, settling.printed, echo, note)
      : { _tag: "Done" }
  })

const frame = (
  input: Input,
  engine: EngineLike.EngineLike,
  sandbox: Sandbox.Sandbox,
  realm: Sandbox.Realm,
  steering: Steering.Source,
  emit: (event: AgentEvent.AgentEvent) => Effect.Effect<void>,
  readCompletion: typeof CompletionClaim.read,
  supervision: Supervision.Handle,
  taskOf: (window: ContextWindow.ContextWindow) => string
): Effect.Effect<Step, HarnessError | Sandbox.SandboxError | Model.ModelFailure, Evaluator.Evaluator> =>
  Effect.gen(function*() {
    // Compaction happens before the turn opens, so the digest the turn records
    // is the one the sealed step is actually keyed on.
    const compactedState = yield* compacted(input.state, engine, emit, input.judged ?? false, taskOf)
    // A run's first frame writes its own state section, before anything reads
    // the window; every later one opens on the section the frame before it
    // wrote. See `frozen`.
    const sectioned = compactedState.sectioned
      ? Result.succeed(compactedState.contextWindow)
      : frozen(compactedState.contextWindow, compactedState)
    const state = sectioned._tag === "Success"
      ? advance(compactedState, { contextWindow: sectioned.success, sectioned: true })
      : compactedState

    yield* emit(
      new AgentEvent.TurnOpened({
        eventType: eventType.turnOpened,
        seat: state.seat,
        modelParams: state.modelParams,
        activeToolNames: [],
        contextDigest: state.contextWindow.digest
      })
    )
    if (sectioned._tag === "Failure") return yield* Effect.fail(sectioned.failure)

    const { answer, cell: sealed, contextWindow } = yield* seal(state, engine, emit)
    const settling = (
      boundary: string,
      printed: string,
      facts: Frame.StateChanges,
      written: Settling["written"],
      offer: Effect.Effect<void> = Effect.void
    ): Settling => ({
      input,
      state,
      engine,
      steering,
      supervision,
      offer,
      live: { value: false },
      emit,
      contextWindow,
      answer,
      boundary,
      printed,
      facts,
      written
    })

    if (sealed._tag === "Failure") {
      const rejection = sealed.failure
      yield* emit(
        new AgentEvent.CellSettled({
          eventType: eventType.cellSettled,
          cell: "",
          outcome: rejection
        })
      )
      // A rejected cell is the fourth exit that continues the run, and it is
      // judged by the same rule as the other three: no cell ran, so this frame
      // made no call and wrote nothing, and a frame that wrote nothing counts.
      // Leaving it frozen kept one shape of stall outside the only control
      // that ends one — a model that answers with prose instead of a cell
      // advanced no counter at all and spent the whole frame budget doing it.
      // Nothing to measure and nothing to demand: the cell never reached the
      // sandbox, so any pending demand is carried forward unanswered.
      const rejectedFrames = state.readOnlyFrames + 1
      if (state.readOnlyCap > 0 && rejectedFrames >= state.readOnlyCap * 2) {
        return yield* readOnlyCapFailure(state.readOnlyCap, rejectedFrames)
      }
      const rejected = settling(contextWindow.digest, "", {
        truncatedOutputs: TruncatedOutput.retain(state.truncatedOutputs),
        readOnlyFrames: rejectedFrames
      }, { mutated: false, checks: [] })
      const step = yield* observe(rejected, rejection.message, {}, deadCellEcho)
      return yield* finish(rejected, step)
    }

    const cell = sealed.success.source
    yield* emit(
      new AgentEvent.CellProduced({
        eventType: eventType.cellProduced,
        cell,
        blocks: sealed.success.blocks
      })
    )

    // The prior close predates the model wait. Measure again before this
    // frame so another worker's edits neither reuse stale reads nor count as
    // this frame's own mutations. A missing or bounded observer stays so.
    const opened = state.workspace !== undefined &&
        (Option.isNone(state.workspace) || !state.workspace.value.complete)
      ? state.workspace
      : yield* witness(engine, state, cell.digest, "open")
    const ran = yield* evaluate(
      input,
      state,
      sealed.success,
      engine,
      sandbox,
      realm,
      opened,
      emit
    )
    const outcome = yield* Cell.decodeOutcome(ran.frame.outcome)
    const printed = printsObservation(ran.frame.prints)
    yield* emit(
      new AgentEvent.CellPrinted({
        eventType: eventType.cellPrinted,
        cell: cell.digest,
        text: ran.frame.prints
      })
    )
    // A partial prefix cannot provide a workspace digest. Carry it forward
    // without paying for another walk on this or later frames.
    const closed = Option.isSome(opened) && !opened.value.complete
      ? opened
      : yield* witness(engine, state, cell.digest, "close")
    yield* emit(
      new AgentEvent.CellSettled({
        eventType: eventType.cellSettled,
        cell: cell.digest,
        outcome,
        ...(ran.frame.boundary === undefined ? {} : { boundary: ran.frame.boundary })
      })
    )

    // The frame's own record of what it did to the world, computed once and
    // carried out through every exit: a raise, a refused park and a settled
    // transition all continue the run on the same facts.
    const accounting = Frame.account({
      state,
      calls: ran.calls,
      opened,
      closed,
      minted: ran.minted,
      bindings: ran.frame.bindings,
      captures: ran.captures,
      source: cell.text
    })
    yield* emit(accounting.observed)
    // The supervisor's snapshot of this frame: what the frame wrote, what it
    // printed, how it ended, and the counts the deterministic controls keep.
    // Built here, on the loop's fiber, and offered by the frame's live
    // boundary; see `drain` for when, and `Supervisor` for what it is for.
    const written = Supervisor.prose(assistantText(answer))
    const { mutated } = accounting
    const { readOnlyFrames } = accounting.facts
    const failed = ran.calls.length > 0 && ran.calls.every((call) => !call.ok || call.failing)
    const failure = ran.calls.some((call) => call.ok && !call.failing)
      ? ""
      : outcome._tag === "raised"
      ? `cell threw ${outcome.name}: ${outcome.message}`
      : failed
      ? ran.calls.map((call) => `${call.flow}: ${call.summary}`).join("; ")
      : ""
    const failureKey = failure.slice(0, 1_000)
    const failureFrames = failureKey === "" ? 0 : failureKey === state.failureKey ? state.failureFrames + 1 : 1
    const facts: Frame.StateChanges = ran.restored.size === 0 ? accounting.facts : {
      ...accounting.facts,
      withheldFlows: state.withheldFlows.filter((name) => !ran.restored.has(name))
    }
    // Read from the catalog this frame showed, so a skill the relevance gate
    // withheld is never reminded; a direct call restores it.
    const { capped: skillsCapped, ...offered } = Supervision.catalog(input.flows, accounting.facts.callLedger)
    const exit = settling(
      cell.digest,
      printed,
      { ...facts, failureFrames, failureKey },
      { mutated, checks: accounting.frameChecks.map((check) => check.label) },
      supervision.offer({
        frame: state.frame,
        digest: cell.digest,
        current: {
          frame: state.frame,
          cell: Supervisor.head(cell.text),
          prose: Supervisor.head(written),
          printed: Supervisor.tail(ran.frame.prints),
          transition: outcome._tag === "settled" ? outcome.transition._tag : outcome._tag,
          mutated
        },
        snapshot: {
          task: Judgement.task(taskOf(contextWindow)),
          signals: Supervision.signals(state, accounting.facts, accounting.workspaceDigest, accounting.observed.paths),
          ...offered
        },
        shown: state.memoryShown,
        recent: Supervisor.head(written),
        skillsCapped,
        unmarked: input.judged === true ? unmarked(state) : [],
        failing: accounting.facts.checks.filter((check) => check.failing).map((check) => check.label)
      })
    )

    // Read-only discipline is armed for the whole frame, not for one exit: a
    // raise, a refused park and a settled transition all continue the run, and
    // each of them judges the frame by this cap.
    const cap = state.readOnlyCap

    if (outcome._tag !== "settled") {
      // The frame settled no transition, but it either changed the workspace
      // or it did not, and that is the whole of what the streak counts.
      // Freezing the counter here is how a stall hid from the cap: a run that
      // alternates a raise with a read advances the streak once every two
      // frames, so a cap of twelve took twenty-four frames to reach and a run
      // that raised more often than it read never reached it at all. Wave 7's
      // own report reads the drift the other way round — the journal's
      // mutation streak and this counter disagreed by one per raise — and the
      // instance that spent its whole budget raised twice.
      // A demand is answered by a write or by a justification, and a frame
      // that settled no transition produced neither. So a raise leaves the
      // demand pending — its text is still in the transcript this exit appends
      // to — and the journal names the frame that finally answers it.
      if (state.pendingReadOnlyDemand !== undefined && mutated) {
        yield* emit(
          new AgentEvent.ReadOnlyDemanded({
            eventType: eventType.readOnlyDemanded,
            streak: state.pendingReadOnlyDemand.streak,
            cap: state.pendingReadOnlyDemand.cap,
            nextFrame: state.frame,
            nextAction: "write"
          })
        )
      }
      if (cap > 0 && readOnlyFrames >= cap * 2) {
        return yield* readOnlyCapFailure(cap, readOnlyFrames)
      }
      // The flow name is clipped for the same reason `CallLedger` clips it: a
      // call names whatever string the cell passed to `ctx.call`, a name that
      // matches no descriptor still settles as a failure saying so, and an
      // unbounded name here is an unbounded line in the notice.
      const salvage = ran.calls.length === 0
        ? ""
        : `\nCalls this cell already completed (their results are durable, and each one is still under the name your cell bound it to — read the name instead of redoing the work):\n${
          ran.calls.map((call) =>
            `- ${call.ordinal}. ${clip(call.flow, CallLedger.width)} -> ${call.ok ? "ok" : "FAILED"}: ${call.summary}`
          )
            .join("\n")
        }`
      const alert = accounting.probeNotice === undefined ? "" : `\n\n${accounting.probeNotice}`
      // A property read through an absent path is the one throw the harness can
      // diagnose without guessing, and it is the throw a cell reaching into
      // a realm binding makes. The names are already computed for the variables
      // panel, so naming them costs nothing and closes the loop the model would
      // otherwise spend a frame on. See `VariablesPanel`.
      const missed = outcome._tag === "raised" ? bindingPathMiss(outcome.message, ran.frame.bindings) : undefined
      const note = outcome._tag === "raised"
        ? `The cell threw ${outcome.name}: ${outcome.message}. Emit a corrected cell.${
          missed === undefined ? "" : `\n${missed}`
        }${salvage}${alert}`
        : `${outcome.message}${salvage}${alert}`
      const step = yield* observe(exit, note)
      return yield* finish(exit, step)
    }

    const transition = outcome.transition
    yield* emit(
      new AgentEvent.TransitionApplied({
        eventType: eventType.transitionApplied,
        transition
      })
    )

    if (transition._tag === "park") {
      if (state.pendingReadOnlyDemand !== undefined) {
        yield* emit(
          new AgentEvent.ReadOnlyDemanded({
            eventType: eventType.readOnlyDemanded,
            streak: state.pendingReadOnlyDemand.streak,
            cap: state.pendingReadOnlyDemand.cap,
            nextFrame: state.frame,
            nextAction: mutated ? "write" : "park"
          })
        )
      }
      // A park with no channel to answer it is refused and answered here. The
      // journal states this without an event of its own: the pair
      // `transition-applied` carrying a `park` and `turn-closed` carrying
      // `continue` occurs for no other reason.
      if (!state.approvalChannel) {
        // A refused park continues the run, so its frame is judged like every
        // other continuing frame. Waiting was the exemption and there is no
        // waiting here: a cell that parks every frame changes nothing, and
        // without this it would be the one shape a stalled run can take that
        // the read-only cap never sees.
        if (cap > 0 && readOnlyFrames >= cap * 2) {
          return yield* readOnlyCapFailure(cap, readOnlyFrames)
        }
        const limits = Sandbox.withDefaults(sandbox.capabilities, input.limits)
        const step = yield* observe(
          exit,
          parkRefusal(
            transition.message,
            state.maxFrames === 0 ? "unlimited" : Math.max(0, state.maxFrames - state.frame - 1),
            limits.totalMs === undefined ? undefined : Math.floor(limits.totalMs / 1000)
          ),
          { pendingReadOnlyDemand: undefined }
        )
        return yield* finish(exit, step)
      }
      if (!Frame.hasNextFrame(state)) {
        yield* drain(exit, true)
        yield* close(exit, "resolved")
        return { _tag: "Done" }
      }
      // The drain on the park path, and the only thing that can ever answer an
      // honored park.
      //
      // A parked run resumes by re-executing its own frames, so it reaches this
      // park again with the same cell, the same transition, and the same
      // question. One boundary per park would hand every later attempt the
      // first attempt's empty answer, the run would park again, and the
      // operator's message would sit in the durable queue for the life of the
      // run — woken, replayed, re-parked, forever. That is what makes
      // `waiting-input` unanswerable today.
      //
      // So the park has a LADDER of boundaries and walks it. Every rung the
      // queue has answered before hands back exactly what it handed back then,
      // which is what keeps a replay identical; the walk stops at the first
      // rung this run has never consulted, which is the one read a resumed
      // attempt is entitled to perform for real. One rung is consumed per
      // attempt, so a steer admitted while the run was parked is delivered by
      // the rung the resume reaches, and every attempt after that replays the
      // delivery rather than draining a queue that no longer holds it.
      //
      // The queue is the record here, and deliberately: `EngineLike.record`
      // would freeze the rung's answer, and a frozen `duplicate` tells every
      // later attempt it was the first, which is the loop this is closing.
      const answered = yield* Effect.gen(function*() {
        for (let rung = 0;; rung++) {
          const drained = yield* steering.drain({
            boundary: `${state.frame}:${cell.digest}:park:${rung}`,
            // A park IS the run going idle, which is the condition a queued
            // follow-up was admitted to wait for. The continue path passes
            // false because a continuing run is not idle; this is the boundary
            // that owes those messages their delivery.
            wouldIdle: true
          })
          const record = Steering.drainRecord(drained)
          if (carries(record) || !drained.duplicate) return record
        }
      })
      if (carries(answered)) {
        yield* emit(
          new AgentEvent.SteeringDrained({
            eventType: eventType.steeringDrained,
            messages: answered.inserts
          })
        )
        // The park was answered, so the run carries on rather than waiting for
        // an answer it has already been given. The frame is judged as an
        // honored park still is — waiting is not evasion — so the read-only
        // streak is carried rather than advanced.
        const step = yield* resumed(exit, answered, {
          pendingReadOnlyDemand: undefined,
          readOnlyFrames: state.readOnlyFrames
        })
        return yield* finish(exit, step)
      }
      return yield* finish(exit, {
        _tag: "Suspend",
        reason: new EngineLike.SuspendReason({
          code: transition.reason,
          message: transition.message
        })
      })
    }

    // Read-only discipline, applied to every frame that settled a decision.
    // An honored park is exempt: waiting is not evasion, and a parked run is
    // not reporting anything as done. A refused park is not exempt — it
    // continues the run — and the branch above applies the same rule to it.
    if (state.pendingReadOnlyDemand !== undefined) {
      yield* emit(
        new AgentEvent.ReadOnlyDemanded({
          eventType: eventType.readOnlyDemanded,
          streak: state.pendingReadOnlyDemand.streak,
          cap: state.pendingReadOnlyDemand.cap,
          nextFrame: state.frame,
          nextAction: mutated
            ? "write"
            : (transition._tag === "continue" && (transition.justification ?? "").trim().length > 0)
            ? "justification"
            : "read-only"
        })
      )
    }
    if (cap > 0 && readOnlyFrames >= cap * 2) {
      return yield* readOnlyCapFailure(cap, readOnlyFrames)
    }

    // `VacuousVerification` was read here, between the read-only cap and the
    // completion branch, and it is not read anywhere now. The module, its
    // tests and `AgentEvent.VacuousVerificationObserved` are kept; the arm is
    // off. the r93 wave report is the reason and the module's
    // own docblock carries it. Re-wiring is one `stored`/`find` pair here plus
    // the two `State` fields it needs, and it is a controlled arm of its own
    // wave when it happens — not a change that rides along with another.

    const drained = yield* drain(exit, transition._tag === "complete" || !Frame.hasNextFrame(state))
    if (transition._tag === "complete" && carries(drained)) {
      const step = yield* resumed(
        exit,
        drained,
        { bouncedCompletion: transition.output },
        `${printed}\n\nThe completed answer before this follow-up:\n${transition.output}`
      )
      return yield* finish(exit, step)
    }
    if (
      transition._tag === "complete" && input.output !== undefined &&
      state.outputDemands < input.output.cap && Frame.handBackRoom(state, readOnlyFrames)
    ) {
      // Ahead of the evidence demands and the claim brake: an answer the host
      // cannot read is corrected before anything spends a demand judging it.
      const check = input.output.check
      const note = yield* engine.record({
        name: "output-judgement",
        identity: {
          session: state.session,
          frame: state.frame,
          boundary: `output-judgement:${cell.digest}`
        },
        success: Schema.NullOr(Schema.String),
        execute: Effect.map(
          Effect.suspend(() => check(transition.output, state.outputDemands)),
          (refused) => refused ?? null
        )
      })
      if (note !== null) {
        if (exit.live.value) yield* exit.offer
        yield* emit(
          new AgentEvent.OutputDemanded({
            eventType: eventType.outputDemanded,
            note,
            nextFrame: state.frame + 1
          })
        )
        yield* close(exit, "continue")
        // Shown what its own cell printed, as a continuing frame is, so the
        // correction never costs the work that produced the answer.
        return continuing(
          exit,
          appended(
            contextWindow,
            answer,
            [ModelRequest.Message.user(printed), ModelRequest.Message.user(note)],
            liveCellEcho
          ),
          false,
          {
            interventions: 1,
            pendingReadOnlyDemand: undefined,
            outputDemands: state.outputDemands + 1,
            // An answer the host could not read is not worth restoring.
            bouncedCompletion: undefined
          }
        )
      }
    }
    if (transition._tag === "complete") {
      // The completion's own evidence, judged once per demand; see
      // `Frame.judgeCompletion` for the five demands, their order, and the
      // three things that leave no frame to ask in.
      const services = yield* Effect.context<Evaluator.Evaluator>()
      const judged = yield* engine.record({
        name: "completion-judgement",
        identity: {
          session: state.session,
          frame: state.frame,
          boundary: `completion-judgement:${cell.digest}`
        },
        success: RecordedCompletion,
        // A replay uses the entire original decision. Re-evaluating even an
        // accepted claim can invent a demand and execute additional work.
        execute: Frame.judgeCompletion(
          state,
          accounting,
          contextWindow,
          transition.output,
          readCompletion
        ).pipe(
          Effect.provideContext(services),
          Effect.map((judgement) => ({
            observed: judgement.observed ?? null,
            demand: judgement.demand ?? null,
            unproven: judgement.unproven ?? null,
            decision: judgement.decision ?? null,
            sentenceDecision: judgement.sentenceDecision ?? null
          }))
        )
      }).pipe(Effect.map((judgement) => ({
        observed: judgement.observed ?? undefined,
        demand: judgement.demand ?? undefined,
        unproven: judgement.unproven ?? undefined,
        decision: judgement.decision ?? undefined,
        sentenceDecision: judgement.sentenceDecision ?? undefined
      })))
      // The claim brake's reading when it issued no demand. It is the one
      // demand whose non-demanding readings are journaled, because it is the
      // one a grader cannot recompute; see `AgentEvent.ClaimDemanded`. It is
      // emitted before the failure below, so the reading that ended the run
      // is on the record the run leaves behind.
      if (judged.observed !== undefined) yield* emit(judged.observed)
      // The same reading with its evidence, from the same record, so a
      // replayed frame reports the decision the original attempt made. It
      // follows `claim-demanded` on every path but the bounce, where that
      // event is the demand's own and is emitted below.
      if (judged.decision !== undefined) yield* emit(judged.decision)
      if (judged.sentenceDecision !== undefined) yield* emit(judged.sentenceDecision)
      // An unproven claim with no bounce left to spend. The run ends here the
      // way `read_only_cap` ends one, rather than returning a sentence its
      // own record contradicts; see `CompletionClaim.unproven`.
      if (judged.unproven !== undefined) return yield* Effect.fail(judged.unproven)
      const demanded = judged.demand
      if (demanded !== undefined) {
        // Handed back, so the run continues and the frame is supervised
        // after all, from the same live boundary rule `drain` applies: a
        // replayed judgement replays a replayed drain, and offers nothing.
        if (exit.live.value) yield* exit.offer
        yield* emit(demanded.event)
        yield* close(exit, "continue")
        // The demand is an in-frame observation appended to what the run was
        // already holding, not a projected context: a completion names no
        // context for a next frame, and a run answering this one needs the
        // frame it just wrote. A demand follows a drain that carried nothing.
        //
        // A completion written before its own calls returned is shown what
        // they printed first, the way a continuing frame is: reading them is
        // the whole of what the demand asks. See `UnobservedCall`.
        const demandedWindow = demanded.event._tag === "unobserved-demanded"
          ? appended(
            contextWindow,
            answer,
            [ModelRequest.Message.user(printed), ModelRequest.Message.user(demanded.note)],
            liveCellEcho
          )
          : observedOn(contextWindow, answer, demanded.note, liveCellEcho)
        return continuing(exit, demandedWindow, false, {
          // The note is the ask this frame appended; the run's memory goes
          // above it. See `frozen`.
          interventions: 1,
          pendingReadOnlyDemand: undefined,
          ...demanded.spent,
          // The answer the demand is taking away, kept so it cannot be lost.
          // A frame was reserved for the run to answer in, but nothing makes
          // that frame end in a completion, and a run that spends it and
          // then runs out of budget would end on the budget notice with its
          // own answer discarded. See {@link budgetMessage}.
          //
          // A claim the brake read and found unsupported is not kept: the
          // budget notice would hand back the very sentence the brake
          // refused. See `Frame.CompletionDemand.keeps`.
          bouncedCompletion: demanded.keeps ? transition.output : undefined,
          // The frame this demand was handed to, which is the frame that
          // gets to answer it without being judged again. See
          // {@link State.demandedFrame}.
          demandedFrame: state.frame + 1
        })
      }
      // A completion that stands over a call its own cell failed carries the
      // failure in the flow's words; see `FailedCall.state`.
      yield* close(
        exit,
        "resolved",
        FailedCall.state(
          transition.output,
          FailedCall.find(accounting.calls, transition.output, accounting.source)
        )
      )
      return { _tag: "Done" }
    }

    if (!Frame.hasNextFrame(state)) {
      yield* close(exit, "resolved")
      return { _tag: "Done" }
    }
    yield* close(exit, "continue")
    const { contextWindowTokens, modelCallMs, modelParams, seat } = yield* steered(
      state,
      drained.seatChanges,
      input.contextWindowTokensFor
    )
    // The read-only, repeat and sufficiency interventions; see
    // `Frame.discipline` for when each is issued and what it costs.
    const disciplined = Frame.discipline(state, accounting, transition.justification)
    for (const event of disciplined.events) yield* emit(event)
    // The frame's own pair, appended. The append is what keeps the provider's
    // prefix cache covering everything below the last frame — a transcript the
    // cell replaced broke the prefix on every turn, and one graded wave recorded
    // zero cached input tokens on an instance where an earlier wave had 5,142.
    const context = appended(
      contextWindow,
      answer,
      [ModelRequest.Message.user(printed), ...delivered(drained), ...disciplined.messages],
      liveCellEcho
    )
    return continuing(exit, windowOn(state, seat, context), drained.inserts.length > 0, {
      seat,
      modelParams,
      modelCallMs,
      contextWindowTokens,
      ...shownAfter(state, drained),
      ...ledgerAfter(drained),
      ...marksAfter(state, drained),
      // Whatever this frame earned is what the next one answers, so the run's
      // memory goes above it. See `frozen`.
      interventions: disciplined.messages.length,
      ...disciplined.changes
    })
  })

/** What the run-start relevance reading records. */
const RelevanceRecord = Schema.Struct({ settled: AgentEvent.RelevanceSettled })

/**
 * The run-start relevance reading, taken once at frame 0 of a judged run.
 *
 * Every model-invocable flow and skill of the frame's catalog that is not
 * pinned, every chunk of the instruction files, and every opening memory row
 * is one item. What Jev is confident the task does not need is withheld: its
 * flows leave `ctx.flows`, its chunks leave the instructions segment, and its
 * rows leave the memory segment. A reading that could not be judged withholds
 * nothing, and its `decision-unjudged` row is the record.
 * The reading is a recorded boundary, so a replay is served what it withheld.
 */
const withheld = (
  state: State,
  catalog: ReadonlyArray<Descriptor.FlowDescriptor>,
  input: Input,
  engine: EngineLike.EngineLike,
  emit: (event: AgentEvent.AgentEvent) => Effect.Effect<void>,
  taskOf: (window: ContextWindow.ContextWindow) => string
): Effect.Effect<State, HarnessError> =>
  Effect.gen(function*() {
    const pinned = input.pinned ?? []
    const documents = input.instructions ?? []
    const rows = input.memory?.rows ?? []
    const items: ReadonlyArray<Relevance.Item> = [
      ...catalog
        .filter((descriptor) => descriptor.modelInvocable && !pinned.includes(descriptor.name))
        .map(Relevance.flowItem)
        // Catalog names are unique, so no two items tie.
        .sort((left, right) => left.id < right.id ? -1 : 1),
      ...Relevance.chunks(documents).map((chunk): Relevance.Item => ({
        kind: "instruction",
        id: chunk.id,
        text: chunk.text
      })),
      ...rows.map((row): Relevance.Item => ({ kind: "memory", id: row.key, text: row.text }))
    ]
    if (items.length === 0) return state
    const record = yield* Judgement.recorded(
      engine,
      {
        name: "relevance",
        identity: { session: state.session, frame: 0, boundary: "relevance" },
        classifier: "relevance/unnecessary",
        value: RelevanceRecord,
        items: items.length
      },
      Effect.map(Relevance.judge({ task: Judgement.task(taskOf(state.contextWindow)) }, items), (reading) => ({
        value: { settled: Relevance.settled(reading, { scope: state.session, frame: 0, source: "run" }) },
        asked: reading.asked,
        acted: reading.verdicts.some((verdict) => verdict.withheld)
      }))
    )
    yield* Judgement.emitRecorded(emit, record)
    if (record.value === null) return state
    const { settled } = record.value
    yield* emit(settled)
    // A chunk is its id and its text: a replay served against an edited file
    // keeps the chunk now at that id, which nobody judged.
    const judgedChunks = new Set(
      settled.withheld.filter((item) => item.kind === "instruction").map((item) => `${item.id}\u0000${item.digest}`)
    )
    const chunks = new Set(
      Relevance.chunks(documents).flatMap((chunk) =>
        judgedChunks.has(`${chunk.id}\u0000${Digest.digest(chunk.text)}`) ? [chunk.id] : []
      )
    )
    // A row is its key and its text, so two rows alike in both are one row.
    const dropped = new Set(
      settled.withheld.filter((item) => item.kind === "memory").map((item) => `${item.id}\u0000${item.digest}`)
    )
    const replaced = new Map<string, ReadonlyArray<ContextWindow.Segment>>()
    if (chunks.size > 0) {
      const text = Relevance.render(documents, chunks)
      replaced.set(
        ContextWindow.makeSegment(instructionsSegment(documents, new Set())).digest,
        text === "" ? [] : [ContextWindow.makeSegment(instructionsSegment(documents, chunks))]
      )
    }
    if (input.memory !== undefined && dropped.size > 0) {
      const { digest, render } = input.memory
      const text = render(rows.filter((row) => !dropped.has(`${row.key}\u0000${Digest.digest(row.text)}`)))
      replaced.set(
        ContextWindow.makeSegment(memorySegment(render(rows), digest)).digest,
        text === "" ? [] : [ContextWindow.makeSegment(memorySegment(text, Digest.digest(text)))]
      )
    }
    return advance(state, {
      withheldFlows: settled.withheld.filter((item) => item.kind === "flow" || item.kind === "skill").map((item) =>
        item.id
      ),
      ...(replaced.size === 0 ? {} : {
        contextWindow: ContextWindow.make({
          ...state.contextWindow,
          segments: state.contextWindow.segments.flatMap((segment) => replaced.get(segment.digest) ?? [segment])
        })
      })
    })
  })

/**
 * Runs the cell loop until it completes, parks, or exhausts its budget.
 *
 * Cancellation is fiber interruption: interrupting this stream tears down the
 * sandbox through scope closure and reports one abort, without threading an
 * abort signal anywhere.
 *
 * @category streams
 * @since 0.1.0
 * @slop
 */
export const run = (
  input: Input
): Stream.Stream<
  AgentEvent.AgentEvent,
  HarnessError,
  EngineLike.EngineLike | Sandbox.Sandbox | Steering.Source | Evaluator.Evaluator
> =>
  Stream.callback<
    AgentEvent.AgentEvent,
    HarnessError,
    EngineLike.EngineLike | Sandbox.Sandbox | Steering.Source | Evaluator.Evaluator
  >((queue) => {
    // A replay re-emits its recorded drains before reaching an unjudged
    // completion. This private evidence follows those admissions, including
    // through compaction, without changing public State or model-step keys.
    // The observer finishes its checkpoint before any evidence or frame advances.
    let instructions = ""
    const emit = (event: AgentEvent.AgentEvent): Effect.Effect<void> =>
      Effect.flatMap(AgentEvent.Observer, (observe) => observe(event)).pipe(
        Effect.andThen(Effect.sync(() => {
          if (event._tag !== "steering-drained") return
          const text = event.messages.flatMap<ModelRequest.ContentPart>((message) => message.content)
            .filter((part): part is ModelRequest.TextPart => part.type === "text")
            .map((part) => part.text)
            .join("\n\n")
          if (text !== "") instructions = CompletionClaim.newest(`${instructions}\n\n${text}`.trim())
        })),
        Effect.andThen(Queue.offer(queue, event)),
        Effect.asVoid
      )
    const readCompletion: typeof CompletionClaim.read = (evidence) =>
      CompletionClaim.read({ ...evidence, task: completionTask(evidence.task, instructions) })
    // The supervisor reads the task the completion brake reads: the stated
    // task and every later instruction the run accepted from the person.
    const taskOf = (window: ContextWindow.ContextWindow): string => completionTask(Frame.taskText(window), instructions)
    const monitors = input.monitors ?? Monitor.defaults()
    const judged = input.judged ?? false
    const pinned = input.pinned ?? []
    const loop = Effect.gen(function*() {
      const engine = yield* EngineLike.EngineLike
      const sandbox = yield* Sandbox.Sandbox
      const steering = yield* Steering.Source

      let current = input.state
      // The catalog the window teaches: a resumed run's window already
      // leaves out what the run-start reading withheld.
      let flows = input.flows.filter((descriptor) => !current.withheldFlows.includes(descriptor.name))
      if (current.journalVersion !== journalVersion) {
        return yield* new HarnessError({
          code: "incompatible_journal",
          message: `Controller state predates harness journal format ${journalVersion}; start a new run.`
        })
      }
      // Once, and only on a run's own first frame: a resumed run replays its
      // arming from the journal it already wrote, and a second record would
      // make the gate count runs instead of arming decisions.
      if (current.frame === 0) {
        const limits = Sandbox.withDefaults(sandbox.capabilities, input.limits)
        yield* emit(
          new AgentEvent.DisciplineArmed({
            eventType: eventType.disciplineArmed,
            readOnlyCap: current.readOnlyCap,
            maxFrames: current.maxFrames,
            approvalChannel: current.approvalChannel,
            modelCallMs: current.modelCallMs,
            repeatCap: current.repeatCap,
            narrowingCap: current.narrowingCap,
            unmovedCap: current.unmovedCap,
            unresolvedCap: current.unresolvedCap,
            claimCap: current.claimCap,
            revalidations: current.revalidations,
            // Written only when armed, so an unjudged journal keeps the bytes
            // it had before the switch existed.
            ...(judged
              ? {
                judged,
                relevance: { withholdAt: Relevance.withholdAt, pinned: [...pinned] },
                monitors: monitors.map(({ at, consecutive, cooldownFrames, id, kind, limit }) => ({
                  id,
                  kind,
                  at,
                  consecutive,
                  cooldownFrames,
                  limit
                }))
              }
              : {}),
            ...(input.stance === undefined ? {} : { stance: input.stance }),
            ...limits
          })
        )
      }
      // The supervisor's fiber, on this loop's scope: it reads snapshots the
      // frames offer and the loop never waits for it. See `Supervisor`.
      const supervision = yield* Supervision.open({
        session: current.session,
        engine,
        emit,
        monitors,
        deliver: judged
      })
      // The run's realm: an `acquireRelease` on this loop's scope rather than
      // on one evaluation, so teardown is still scope closure and cancellation
      // is still fiber interruption. A resumed run rebuilds it by re-executing
      // its own cells from the top — every `ctx.call` replays from its recorded
      // boundary, so the realm that comes out is the realm that was lost,
      // without anything having been serialized.
      //
      // Opened after the arming is journaled, so a run whose realm cannot be
      // built still has its armed budgets on the record. A failure that leaves
      // no record of what was asked for is a failure a grader cannot read.
      const realm = yield* Effect.suspend(() => {
        const projections: Record<string, Cell.FlowProjection> = {}
        for (const descriptor of input.flows) {
          projections[descriptor.name] = Cell.project(descriptor)
        }
        return sandbox.openRealm === undefined
          ? Effect.fail(Sandbox.realmUnsupported)
          : sandbox.openRealm({ flows: projections, limits: input.limits })
      }).pipe(
        Effect.mapError((cause) =>
          new HarnessError({
            code: "engine_failed",
            message: "The run's persistent realm could not be opened",
            cause
          })
        )
      )

      for (;;) {
        if (current.failureFrames >= 5) {
          return yield* new HarnessError({
            code: "model_failed",
            message:
              `Runaway guard: ${current.failureFrames} consecutive frames repeated the same failure: ${current.failureKey}`,
            cause: { _tag: repeatedFailureTag, frames: current.failureFrames }
          })
        }
        if (current.maxFrames > 0 && current.frame >= current.maxFrames) {
          yield* emit(
            new AgentEvent.Resolved({
              eventType: eventType.resolved,
              message: ModelRequest.Message.assistant(budgetMessage(current), { stopReason: "stop" })
            })
          )
          return
        }
        const catalog = input.refreshFlows === undefined ? input.flows : yield* engine.record({
          name: "flow-catalog",
          identity: { session: current.session, frame: current.frame, boundary: "flow-catalog" },
          success: Schema.Array(Descriptor.FlowDescriptor),
          execute: input.refreshFlows
        })
        current = judged && current.frame === 0
          ? yield* withheld(current, catalog, input, engine, emit, taskOf)
          : current
        // The journaled catalog stays whole; what the frame shows leaves out
        // what the run-start reading withheld.
        const shown = catalog.filter((descriptor) => !current.withheldFlows.includes(descriptor.name))
        if (input.refreshFlows !== undefined || shown.length !== flows.length) {
          // Replace only the teaching we supplied, preserving the host's
          // prefix and the accumulated transcript. Rebuild before compaction
          // so token accounting and the sealed request use this snapshot too.
          const previous = teach(ContextWindow.empty(current.contextWindow.modelId), flows, undefined, input.stance)
          const digests = new Set(previous.segments.map((segment) => segment.digest))
          current = advance(current, {
            contextWindow: teach(
              ContextWindow.make({
                ...current.contextWindow,
                segments: current.contextWindow.segments.filter((segment) => !digests.has(segment.digest))
              }),
              shown,
              undefined,
              input.stance
            )
          })
          flows = shown
        }
        const step = yield* frame(
          { ...input, state: current, flows },
          engine,
          sandbox,
          realm,
          steering,
          emit,
          readCompletion,
          supervision,
          taskOf
        ).pipe(
          Effect.catch((error) => {
            const request = permissionRequired(error)
            if (request === undefined) {
              return Effect.fail(
                error instanceof HarnessError ? error : new HarnessError({
                  code: error instanceof Sandbox.SandboxError ? "engine_failed" : "model_failed",
                  message: frameFailureMessage(error),
                  cause: error
                })
              )
            }
            return Effect.gen(function*() {
              yield* emit(
                new AgentEvent.PermissionRequired({
                  eventType: eventType.permissionRequired,
                  request
                })
              )
              yield* emit(
                new AgentEvent.TurnClosed({
                  eventType: eventType.turnClosed,
                  stopReason: "error",
                  outcome: "suspended"
                })
              )
              return {
                _tag: "Suspend",
                reason: new EngineLike.SuspendReason({
                  code: "permission-required",
                  message: `Permission ${request.requestId} is required`,
                  // Encoded, not attached: `request` is a class that extends
                  // `Error`, and this reason is journaled inside
                  // `AgentEvent.Suspended`. A live Error there has no JSON form,
                  // so encoding it dies with a schema failure that replaces the
                  // park it was carrying.
                  details: encodePermissionRequired(request)
                })
              } satisfies Step
            })
          }),
          Effect.onInterrupt(() =>
            Effect.gen(function*() {
              yield* emit(new AgentEvent.Aborted({ eventType: eventType.aborted, reason: "Cell frame interrupted" }))
              yield* emit(
                new AgentEvent.TurnClosed({
                  eventType: eventType.turnClosed,
                  stopReason: "aborted",
                  outcome: "aborted"
                })
              )
            })
          )
        )
        if (step._tag === "Done") return
        if (step._tag === "Suspend") {
          yield* emit(new AgentEvent.Suspended({ eventType: eventType.suspended, reason: step.reason }))
          return yield* engine.suspend(step.reason)
        }
        for (const flow of current.withheldFlows) {
          if (step.state.withheldFlows.includes(flow)) continue
          yield* emit(
            new AgentEvent.RelevanceRestored({
              eventType: eventType.relevanceRestored,
              scope: current.session,
              frame: current.frame,
              flow
            })
          )
        }
        current = step.state
      }
    })
    // The queue, not the callback's error channel, terminates the stream, so
    // every event already offered stays observable ahead of whatever ended the
    // run. An interruption is forwarded rather than swallowed: a durable park
    // arrives as one, and turning it into a clean end would report a suspended
    // run as a finished one.
    return Effect.onExit(Effect.scoped(loop), (exit) =>
      Effect.asVoid(
        exit._tag === "Success" ? Queue.end(queue) : Queue.failCause(queue, exit.cause)
      ))
  })
