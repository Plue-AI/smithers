/**
 * The proof that was already true before anything changed.
 *
 * **This control is not wired into `CellTurn`. Nothing in a production run
 * reads it, and no run is told anything by it.** The module, this suite and
 * `AgentEvent.VacuousVerificationObserved` are kept intact so it can be
 * measured on its own, in its own wave, against the contract text r92
 * measured. Everything below describes what it does when an arm turns it on.
 *
 * **Its input no longer exists.** {@link stored} reads the reserved
 * `verification` key out of the durable state a cell filed by hand, and the
 * filing surface was deleted on 2026-08-24: `Cell.Continue.state` decodes and
 * is populated by nothing. An arm that re-wires this module reads nothing until
 * it first decides where a realm run declares its verification — a name bound
 * in the realm, a print, or a new field — so the wave that turns this back on
 * carries that decision with it. {@link stored} is left reading `Schema.Json`
 * because that decision has not been made and the r90–r96 journals it can be
 * replayed against are still filing journals.
 *
 * It was live for exactly one wave. the r93 wave report reads
 * the result off the 45 journals, and the reason it is off is that the wave
 * cannot price it:
 *
 * - It fired **twice in 45 journals**, and on neither of the instances the
 *   diagnosis or the replay predicted. `django__django-14351`, the run it was
 *   written for, resolved that wave with **no observation on its journal at
 *   all** — so the row it was built to close was closed by something else, and
 *   two prompt rules landed in the same round.
 * - `sympy__sympy-13878` is the firing that worked: told at frame 1 that its
 *   stored check was already green, the run replaced it, spent seventeen more
 *   frames on a different proof, and resolved — cheaper and in fewer frames
 *   than any earlier wave.
 * - `django__django-15732` is the firing that did not. The observation landed
 *   on frame 7, which is the frame that made the correct edit. On frame 8 the
 *   run made a second edit that rewrote the enclosing block and restored the
 *   first edit's text **byte for byte**. Both edits reported `mutated: true`
 *   on an `observed` basis, the final tree equalled the base, and the captured
 *   diff was zero bytes. The instance had resolved in r90, r91 and r92; it is
 *   the wave's only empty patch.
 *
 * Nothing in this module's contract asks a run to revert, and one instance is
 * not a mechanism. But it is the first evidence that a fact delivered on the
 * `invalidProbe` channel can be read by a run as an instruction to retreat,
 * and the one consequential firing in the wave preceded the wave's only
 * revert-to-empty-patch. Two firings is not a rate. Turning this back on is a
 * wave of its own — this control alone, on r92's contract text, with
 * `django__django-15732` and `sympy__sympy-13878` as the rows to read — and
 * not a change that rides along with another.
 *
 * A run is asked to store the check it verified with as
 * `state.verification: { flow, input }` and to re-run that exact check after
 * its edit. Nothing in that rule says the check ever failed. A run may pick a
 * command that was green on the tree it was handed, watch it stay green after
 * the edit, and complete citing a before-and-after that never moved.
 *
 * That is not a hypothetical either. `django__django-14351` lost a baseline
 * verdict across two waves, and its journal says why in two rows: the same
 * verification script — one content digest — ran at sequence 260, before any
 * frame of the run had changed a byte, and exited 0; then again at sequence
 * 582, after the edit, and exited 0. Both readings are true and the pair
 * establishes nothing. The contract already says the words — *a command
 * becomes evidence only once you have SEEN it fail on the unmodified tree* —
 * and the run stored a check it had watched pass there instead.
 *
 * The harness can see this without re-running anything. It already records
 * every check a frame ran, whether that check reported a passing exit status,
 * and how many frames of the run had changed the workspace when it ran. A
 * check that passed while that count was zero, in a frame that itself changed
 * nothing, is a check that passed on the tree the run was handed. If a later
 * cell stores that exact call as its verification, the run is standing on a
 * proof that cannot distinguish its own change from no change at all.
 *
 * One reading takes it back: the same call reported *failing* over that same
 * untouched tree. Then the run has watched the red the contract asks for, and a
 * second, green reading of it before any edit says the command is unsteady
 * rather than that the run never saw it fail. Such a signature is never
 * admitted, so the observation can only ever be made about a check this run has
 * no pre-edit failure for.
 *
 * So the harness says so, and does nothing else. It is delivered on the
 * `invalidProbe` channel — the one place the loop already contradicts a
 * reading of a result the flow itself could see through — because it is the
 * same class of fact: a result that reads identically on a broken tree and on
 * a fixed one. No bounce, no demand, no cap: the run continues on the
 * transition it wrote. A harness that refused the completion would be grading
 * the agent's work with its own, which is the line every control in this
 * package holds, and it would be refusing on a *guess* — a check that was
 * green before an edit is the right check for a task whose bug is a crash the
 * command never reached, and only the run knows which it has.
 *
 * It fires at most once per distinct verification input. The fact is about a
 * call, the record only grows, and a run that has been told and stored the
 * same check again has decided, which is its decision to make.
 *
 * @since 0.1.0
 */

import { Schema } from "effect"
import * as Effect from "effect/Effect"
import type * as NarrowedCheck from "./NarrowedCheck.ts"

/**
 * How many pristine-tree passes one run carries forward.
 *
 * The ledger is durable controller state, so it is bounded, and it only ever
 * grows while the run has changed nothing: the moment a frame edits, nothing
 * new is admitted. The longest graded run made 43 calls across 24 frames with
 * its first edit at frame 3, so sixteen covers every check a run takes before
 * it commits to a change. A run that outlives the bound forgets its oldest
 * passes first, which can cost the observation and can never invent one.
 *
 * @category constants
 * @since 0.1.0
 */
export const retained = 16

/**
 * One check that passed over the tree the run was handed.
 *
 * @category models
 * @since 0.1.0
 */
export class Pass extends Schema.Class<Pass>("flows/harness/VacuousVerification/Pass")({
  /** The flow the call named. */
  flow: Schema.String,
  /** The call's identity, as the controller's own signature names it. */
  signature: Schema.String,
  /** The call's input as it was written, clipped, for the observation to quote. */
  label: Schema.String
}) {}

/**
 * The pristine-tree passes this run carries, oldest first and bounded.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Ledger = Schema.Array(Pass).pipe(
  Schema.withConstructorDefault(Effect.succeed<ReadonlyArray<Pass>>([])),
  Schema.withDecodingDefaultKey(Effect.succeed<ReadonlyArray<Pass>>([]))
)

/**
 * The pristine-tree passes this run carries, oldest first and bounded.
 *
 * @category models
 * @since 0.1.0
 */
export type Ledger = typeof Ledger.Type

/**
 * Records one frame's passing checks, but only while the tree is untouched.
 *
 * Three conditions, and all of them are refusals rather than readings. `epoch`
 * is the run's own count of frames that changed the workspace *before* this
 * one, so a non-zero epoch means some earlier frame already edited and a pass
 * taken now says nothing about the tree the run was handed. `stable` is the
 * same question inside one frame: a frame's calls are not ordered against its
 * edits in anything the harness records, so a check from a frame that also
 * edited might have run on either side of it. `Sufficiency` refuses the same
 * stamp for the same reason; see `NarrowedCheck` `Check` `stable`.
 *
 * `failed` is the third, and it is the one that keeps the observation from
 * contradicting the record it is read off. A check the run has already watched
 * *fail* over the tree it was handed is a check the run has done the contract's
 * work on, whatever it printed the second time: it is red on the unmodified
 * tree, and a later green reading of it at the same epoch says the command is
 * unsteady, not that the run never saw it fail. Telling such a run its proof
 * was "already green" would be a sentence its own journal refutes, so the
 * signature is refused on the way in and evicted if an earlier pass already put
 * it there. The list is the run's failing-check ledger read at epoch zero —
 * `Sufficiency` already keeps it, stamped with the epoch each failure was
 * watched in — so nothing new is measured or stored for this. That ledger is
 * bounded, so a run with more distinct pre-edit failures than `Sufficiency`
 * retains can forget one; forgetting can cost the refusal and can never invent
 * a pass.
 *
 * A repeated signature keeps its first entry rather than taking a second slot:
 * the entries are all the same tree, so re-running one adds no information and
 * re-stamping it would only cost the ledger its oldest genuinely distinct pass.
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
    /** Signatures this run has watched fail over the tree it was handed. */
    readonly failed: ReadonlyArray<string>
  }
): Ledger => {
  const refused = new Set(options.failed)
  const kept = new Map(
    ledger.filter((entry) => !refused.has(entry.signature)).map((entry) => [entry.signature, entry])
  )
  if (options.epoch === 0) {
    for (const check of options.frame) {
      if (!check.passing || !check.stable) continue
      if (refused.has(check.signature)) continue
      if (kept.has(check.signature)) continue
      kept.set(check.signature, new Pass({ flow: check.flow, signature: check.signature, label: check.label }))
    }
  }
  const distinct = [...kept.values()]
  return distinct.slice(Math.max(0, distinct.length - retained))
}

/**
 * The `{ flow, input }` pair a cell stored as its verification, if it stored
 * one this module can read.
 *
 * The reserved key and its two fields are the contract's own words, and this
 * is the only thing the controller ever reads out of `agentState`. Anything
 * else under `verification` — a string, a bare command, a shape the contract
 * does not describe — reads as absent, because a state key the harness cannot
 * parse is the cell's own memory and not a claim about evidence.
 *
 * @category conversions
 * @since 0.1.0
 */
export const stored = (
  agentState: Schema.Json
): { readonly flow: string; readonly input: Schema.Json } | undefined => {
  if (agentState === null || typeof agentState !== "object" || Array.isArray(agentState)) return undefined
  const declared = (agentState as Record<string, Schema.Json>)["verification"]
  if (declared === null || declared === undefined || typeof declared !== "object" || Array.isArray(declared)) {
    return undefined
  }
  const { flow, input } = declared as Record<string, Schema.Json>
  return typeof flow === "string" && input !== undefined ? { flow, input } : undefined
}

/**
 * Finds the pristine-tree pass a stored verification is standing on.
 *
 * The match is on the controller's own call signature, so it is the *exact*
 * `{ flow, input }` the contract asks a run to reuse — a broadened or narrowed
 * command is a different call and is not this failure.
 *
 * `stated` is the run's record of what it has already been told, which is what
 * keeps this to one sentence per distinct input.
 *
 * @category conversions
 * @since 0.1.0
 */
export const find = (options: {
  /** Checks that passed over the tree the run was handed, oldest first. */
  readonly ledger: Ledger
  /** The signature of the `{ flow, input }` the cell stored. */
  readonly signature: string
  /** Verification signatures this run has already been told about. */
  readonly stated: ReadonlyArray<string>
}): Pass | undefined => {
  if (options.stated.includes(options.signature)) return undefined
  return options.ledger.find((entry) => entry.signature === options.signature)
}

/**
 * States that the stored proof was already green before anything changed.
 *
 * It quotes the call, says what the record establishes about it, and names the
 * two things the run may do — keep it, having a reason, or go find a reading
 * that can move. Neither is refused and neither is graded: a check that was
 * green before the edit is the right check for a task whose bug is a crash the
 * command never reached, and only the run knows whether that is this task.
 *
 * @category constructors
 * @since 0.1.0
 */
export const observation = (found: Pass): string =>
  `Vacuous verification — the check you stored as \`state.verification\` is a check this run already watched PASS on the unmodified tree, before any frame of it changed a byte.

- the stored check: ${found.flow} ${found.label}
- what this run saw it do on the tree it was handed: exit 0

Re-running it after your edit cannot show your change did anything: it reads identically on a broken tree and on a fixed one, so a green result after the edit is the same green result as before it. A proof is a check you have watched FAIL and then watched pass. Nothing is being asked of you and nothing has been refused — if this command is genuinely the only observable the task has, keep it and say in your output that it never failed and why. Otherwise the reading you still need is one that is red right now. This notice is written once per distinct verification.`
