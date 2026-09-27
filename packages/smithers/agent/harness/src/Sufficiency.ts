/**
 * The evidence that is already complete.
 *
 * Every armed control in this package pushes a run to do more. The read-only
 * cap says nothing has been written. The repeat demand says nothing new has
 * been learned. `UnmovedTree` says there is no change behind the completion,
 * `UnresolvedFailure` says a failing check was stepped around, `NarrowedCheck`
 * says the evidence is narrower than it looks. Five brakes and no accelerator,
 * and the asymmetry is not free: on a graded benchmark the best rounds pay one
 * frame re-checking work they had already proved and one more frame doing
 * nothing but writing the completion, because nothing ever tells a careful run
 * that it is finished. Two of the seventeen strokes those rounds spent over par
 * are that, measured.
 *
 * Pure braking also produces compliance rather than work. The wave that armed
 * the completion demands answered the read-only demand with a paragraph and no
 * write, and answered the unmoved-tree demand with "no change is needed" and an
 * empty patch. A control set that only ever says *not yet* teaches a run to
 * write the sentence that makes the notice go away.
 *
 * This is the counterweight, and it is built out of what the controller already
 * records. Three facts, in this order:
 *
 * 1. a check reported a failing exit status over a tree the run had not yet
 *    changed;
 * 2. the run changed the workspace after that;
 * 3. the same check, or a broader one, reported a passing exit status after the
 *    change.
 *
 * That is failing-before and passing-after over one subject, which is the whole
 * of what the contract asks a run to hold before it completes. So the harness
 * says so, once, in one sentence, and asks for nothing: the run may complete
 * citing it or name what is still missing. It is an observation and not a
 * demand — nothing is bounced, nothing is refused, no cap is spent — because a
 * harness that decided a run was finished would be grading the agent's work
 * with its own, which is the line every other control in this package holds.
 *
 * It reads no output and parses no runner. `exitCode` is the one wire key the
 * controller already reads, `UnresolvedFailure` owns what it means, and the
 * ordering comes from the run's own count of frames that changed the workspace.
 *
 * @since 0.1.0
 */

import { Effect, Schema } from "effect"
import { NonNegativeSafeInt } from "./internal/nonNegativeSafeInt.ts"
import * as NarrowedCheck from "./NarrowedCheck.ts"

/**
 * How many distinct failing checks one run carries forward.
 *
 * The ledger is durable controller state, so it is bounded, and it holds only
 * the checks that reported a failure — a small fraction of what a run runs. The
 * longest graded run recorded nine of them across 42 frames, so sixteen covers
 * a whole run with room to spare. A run that outlives the bound forgets its
 * oldest failures first, which can cost the observation and can never invent
 * one.
 *
 * @category constants
 * @since 0.1.0
 */
export const retained = 16

/**
 * One check that reported a failure, and where the run was when it did.
 *
 * @category models
 * @since 0.1.0
 */
export class Failure extends Schema.Class<Failure>("flows/harness/Sufficiency/Failure")({
  /** The flow the call named. */
  flow: Schema.String,
  /** The call's identity, as the controller's own signature names it. */
  signature: Schema.String,
  /** The distinct terms of the call's input, sorted; see `NarrowedCheck` `terms`. */
  terms: Schema.Array(Schema.String),
  /** The call's input as it was written, clipped, for the observation to quote. */
  label: Schema.String,
  /**
   * How many frames had changed the workspace when this check failed.
   *
   * The run's own count of mutating frames is the clock here, rather than a
   * workspace digest, because the fact being established is an ordering — this
   * failed, then something changed, then that passed — and a count is an
   * ordering on any host, including one that measures nothing and knows only
   * what its calls declared.
   */
  epoch: NonNegativeSafeInt
}) {}

/**
 * The failing checks this run carries, oldest first and bounded.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Ledger = Schema.Array(Failure).pipe(
  Schema.withConstructorDefault(Effect.succeed<ReadonlyArray<Failure>>([])),
  Schema.withDecodingDefaultKey(Effect.succeed<ReadonlyArray<Failure>>([]))
)

/**
 * The failing checks this run carries, oldest first and bounded.
 *
 * @category models
 * @since 0.1.0
 */
export type Ledger = typeof Ledger.Type

/**
 * Records one frame's failing checks against the epoch it ran in.
 *
 * A check from a frame that also changed the workspace is dropped rather than
 * recorded. A frame's calls are not ordered against its edits in anything the
 * harness records, so such a check might have failed before the change or after
 * it, and a failure stamped on the wrong side of an edit is exactly the false
 * before-and-after this module must never manufacture. `UnresolvedFailure`
 * refuses the same stamp for the same reason; see `NarrowedCheck` `Check`
 * `stable`.
 *
 * A repeated signature moves to the newest position and restamps, so a check
 * that failed again over a later tree is remembered where it last failed.
 *
 * @category combinators
 * @since 0.1.0
 */
export const remember = (
  ledger: Ledger,
  options: {
    /** The checks this frame ran. */
    readonly frame: ReadonlyArray<NarrowedCheck.Check>
    /** Frames that had changed the workspace before this one. */
    readonly epoch: number
  }
): Ledger => {
  const newest = new Map(ledger.map((entry) => [entry.signature, entry]))
  for (const check of options.frame) {
    if (!check.failing || !check.stable) continue
    newest.delete(check.signature)
    newest.set(
      check.signature,
      new Failure({
        flow: check.flow,
        signature: check.signature,
        terms: check.terms,
        label: check.label,
        epoch: options.epoch
      })
    )
  }
  const distinct = [...newest.values()]
  return distinct.slice(Math.max(0, distinct.length - retained))
}

/**
 * A failure this run has answered, and the check that answered it.
 *
 * @category models
 * @since 0.1.0
 */
export interface Sufficient {
  /** The check that reported a failure before the run changed anything. */
  readonly failed: Failure
  /** The check that reported a pass after it, over the changed tree. */
  readonly passed: NarrowedCheck.Check
}

/**
 * Finds a failing-before, passing-after pair this frame has completed.
 *
 * Four conditions, each read off the run's own record:
 *
 * 0. no check of this frame reported a *failing* exit status. The sentence says
 *    the evidence the contract asks for exists, and a frame that is looking at
 *    a red check right now is a frame for which that reading is at best half
 *    the record — a narrow probe going green while the broad check beside it
 *    stays red is the exact shape that has lost one graded instance for six
 *    consecutive waves. The harness will not pick the good half out of a frame
 *    that holds both; it says nothing and lets the run finish reading. This
 *    only ever suppresses the observation and can never manufacture one, and it
 *    changes neither of the two frames that fire across the ten journals two
 *    graded waves recorded;
 * 1. some stable check of this frame reported a *passing* exit status — silence
 *    is not a pass, and an unstable reading may precede this frame's edits.
 *    Checkpoint-attributed readings are already stamped stable by `CellTurn`;
 * 2. some remembered failure names the same flow and is the same call, or one
 *    that check is broader than, as `NarrowedCheck` `narrows` reads "broader":
 *    every term of the passing check is carried by the failing one, which added
 *    conditions to it.
 *    A broader reading passing is stronger evidence than the narrow one
 *    passing, never weaker, so it is admitted;
 * 3. the run changed the workspace between the two — the failure's epoch is
 *    below the epoch this frame closes at.
 *
 * The broadest qualifying passing check wins — fewest terms, the least
 * constrained question — so the sentence quotes the strongest evidence the run
 * holds rather than the first one found. Ties go to the earliest-settled check.
 * Among the failures that check answers, the most recent one wins, because it
 * is the reading the run was working against most lately.
 *
 * @category conversions
 * @since 0.1.0
 */
export const find = (options: {
  /** Failing checks this run has remembered, oldest first. */
  readonly ledger: Ledger
  /** The checks this frame ran, in the order they settled. */
  readonly frame: ReadonlyArray<NarrowedCheck.Check>
  /** Frames that have changed the workspace, this one included. */
  readonly epoch: number
}): Sufficient | undefined => {
  if (options.frame.some((check) => check.failing)) return undefined
  let found: Sufficient | undefined = undefined
  for (const passed of options.frame) {
    if (!passed.passing || !passed.stable) continue
    if (found !== undefined && found.passed.terms.length <= passed.terms.length) continue
    let answered: Failure | undefined = undefined
    for (const failed of options.ledger) {
      if (failed.epoch >= options.epoch) continue
      if (failed.flow !== passed.flow) continue
      if (failed.signature !== passed.signature && !NarrowedCheck.narrows(failed.terms, passed.terms)) continue
      answered = failed
    }
    if (answered !== undefined) found = { failed: answered, passed }
  }
  return found
}

/**
 * States that the run holds both halves of its own evidence.
 *
 * It quotes both readings and says what they establish, then names the two
 * things the run may do with that — complete citing it, or say what is still
 * missing — as equals. It asks for nothing and refuses nothing: the harness
 * does not know whether the change is right, only that the evidence the
 * contract asks for exists, and the sentence claims exactly that much.
 *
 * @category constructors
 * @since 0.1.0
 */
export const observation = (found: Sufficient): string =>
  `Evidence held — you have watched a check fail before your change and pass after it, which is the evidence this contract asks for.

- failed, before the workspace changed: ${found.failed.flow} ${found.failed.label}
- passed, after it changed: ${found.passed.flow} ${found.passed.label}

Nothing is being asked of you and nothing has been refused; this is the record read back. If that pair is the proof of the change you set out to make, complete now and name both commands and what they printed in your output. If it is not — the pair covers less than you changed, or a check you have not run yet is the one that would tell you — say in your next context which reading is still missing and go take it. This notice is written once per run.`
