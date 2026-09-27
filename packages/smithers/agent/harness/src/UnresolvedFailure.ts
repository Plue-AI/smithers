/**
 * The failing check a completion stepped around.
 *
 * `NarrowedCheck` names a completion whose last check is a *narrower* version
 * of one the run already ran, taken after the workspace moved. This module
 * names the case one step further along: the run's reading of some subject
 * reported a failure, over the very tree the run is now completing on, and the
 * run neither re-ran it nor left it alone — it took a *different* reading of the
 * same subject and completed on that one instead.
 *
 * It is not hypothetical. On a graded benchmark, one run edited a source file at
 * frame 11, ran `pytest -rA testing/python/collect.py` at frame 12 — the whole
 * file, unfiltered, over the tree it would go on to finish with — and was told
 * "2 failed, 72 passed". At frame 13 it ran a command naming four cases out of
 * that same file, was told "4 passed", and at frame 14 it completed. The broad
 * result was never re-run, never retracted, and never mentioned. Its graded
 * patch passed both target tests and 144 of 145 neighbours.
 *
 * ## Why a failing check alone is not the trigger
 *
 * "Some check failed and the run finished anyway" is not a defect, and reading
 * it as one would be the harness deciding whose failures matter. The same wave
 * contains the counter-example: an instance that **resolved** ran
 * `pytest -rA astropy/io/fits/tests/test_header.py` after its edit, was told "2
 * failed, 148 passed", and completed — correctly, because those two failures
 * were nothing to do with its change. Nothing in the record distinguishes those
 * two failure counts, and nothing may: counting failures means parsing a
 * runner's output, which makes this a rule about pytest instead of a rule about
 * evidence.
 *
 * What separates the two runs is what happened *after* the failing check. The
 * resolved run walked away from that subject entirely: no later call it made
 * names `astropy/io/fits/tests/test_header.py` at all. The unresolved run went
 * back to exactly the subject that had failed, asked a smaller question about
 * it, and reported the smaller answer. That is the shape this module names, and
 * it is one the run's own record establishes: the run itself demonstrated the
 * subject was still live by returning to it.
 *
 * So the demand is not "you have a failing test". It is: *the reading you
 * replaced reported a failure, and you replaced it rather than answering it.*
 * The run may answer either way — fix what the check reported, or complete again
 * saying why those failures are expected. The loop asks once and accepts what
 * comes back, because a harness that decided which failures counted would be
 * grading the agent's work with its own.
 *
 * @since 0.1.0
 */

import type { Schema } from "effect"
import * as DemandText from "./internal/demandText.ts"
import type * as NarrowedCheck from "./NarrowedCheck.ts"
import { targeting } from "./NarrowedCheck.ts"

/**
 * The reserved key a flow reports its subject's exit status under.
 *
 * The second of the two conventions the loop reads off an otherwise opaque call
 * result, alongside `invalidProbe`. It is not a shared type — the controller
 * must not depend on the tool library — so it is a documented wire key.
 * `@smthrs/std` `Bash` and `ShellCommand` are the producing half and own what
 * the number means; the controller only has to know that a result carrying a
 * non-zero number under this key is a result whose subject reported failure.
 *
 * @category identifiers
 * @since 0.1.0
 */
export const exitStatusKey = "exitCode"

/**
 * Whether a settled call's result reports a failing exit status.
 *
 * A result that declares no exit status is not a failure and not a success: it
 * is a call whose flow does not report one, and reading its absence either way
 * would be an assumption. `false` is the answer that costs a demand rather than
 * inventing one.
 *
 * @category predicates
 * @since 0.1.0
 */
export const failed = (value: Schema.Json): boolean => {
  const status = exitStatus(value)
  return status !== undefined && status !== 0
}

/**
 * The exit status a settled call's result reports about its subject, or
 * nothing where it reports none.
 *
 * The one reader of {@link exitStatusKey}, so the two predicates below and
 * every caller that wants the number itself agree by construction rather than
 * by three copies of the same shape test.
 *
 * @category getters
 * @since 1.0.0-rc.0
 */
export const exitStatus = (value: Schema.Json): number | undefined => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined
  const status = (value as Record<string, unknown>)[exitStatusKey]
  return typeof status === "number" ? status : undefined
}

/**
 * Whether a settled call's result reports a passing exit status.
 *
 * The mirror of {@link failed}, and not its negation. A result that declares no
 * exit status is neither: `false` from both predicates is a call whose flow
 * does not report one, which is what a read and a search are. `Sufficiency`
 * builds a completion signal out of this answer, so silence has to read as
 * silence — a file read that "did not fail" is not a check that passed.
 *
 * @category predicates
 * @since 0.1.0
 */
export const passed = (value: Schema.Json): boolean => exitStatus(value) === 0

/**
 * A failing check, paired with the reading the run took in its place.
 *
 * @category models
 * @since 0.1.0
 */
export interface Displaced {
  /** The check that reported a failure and was never re-run. */
  readonly failed: NarrowedCheck.Check
  /** A later check over the same tree that revisits its subject. */
  readonly instead: NarrowedCheck.Check
}

/**
 * Whether a later check asks about the same subject as an earlier one.
 *
 * The relation is: same flow, a different call, and every *target* the earlier
 * check named is named again. Targets — the terms carrying a separator, as
 * `NarrowedCheck` `targeting` reads them — are the paths, files, modules and
 * node ids a call is about; everything else is a condition on them. So "same
 * subject" means the later call went back to all of the places the earlier one
 * looked, whether it asked a narrower question there, a broader one, or looked
 * somewhere else as well.
 *
 * It is deliberately weaker than `NarrowedCheck` `narrows`, which additionally
 * requires every *condition* to be carried and forbids adding a target. That
 * relation misses a compound command — a `git diff` of two source files joined
 * onto a test run — because the diff's own paths read as added targets. This one
 * does not, because the question it answers is not "is this the same question
 * again" but "did you come back to this".
 *
 * An earlier check that names no target at all is never revisited. Such a call
 * has no subject to return to, and treating it as revisited by any later call of
 * the same flow would make the relation vacuous.
 *
 * @category predicates
 * @since 0.1.0
 */
export const revisits = (
  later: NarrowedCheck.Check,
  earlier: NarrowedCheck.Check
): boolean => {
  if (later.flow !== earlier.flow) return false
  if (later.signature === earlier.signature) return false
  const carried = new Set(later.terms)
  let named = false
  for (const term of earlier.terms) {
    if (!targeting(term)) continue
    named = true
    if (!carried.has(term)) return false
  }
  return named
}

/**
 * Finds the failing check a completion replaced rather than answered.
 *
 * Every condition is read off something the harness already records:
 *
 * 1. the frame closed on a complete measurement, so a digest means something;
 * 2. some check in the ledger reported a failing exit status;
 * 3. that check was recorded over the tree this frame is completing on, so its
 *    result is a statement about the tree the completion stands on;
 * 4. it was recorded by a frame that changed nothing, so the digest stamped on
 *    it is the tree it actually ran over rather than a conservative guess;
 * 5. some *later* check {@link revisits} it.
 *
 * Condition 4 is the one that cannot be dropped. A frame's calls are not ordered
 * against its edits in anything the harness records, so a check taken in a frame
 * that also edited is stamped with that frame's closing digest — which reads a
 * check taken *before* the edit as though it ran after. `NarrowedCheck` accepts
 * that in the direction that suppresses demands; here the same stamp would
 * attribute a pre-edit failure to a tree the check never ran over, and invent
 * one. The same wave carries an instance where it would have: a reproduction run
 * in the same frame as the edit that fixed it, still reporting the bug.
 *
 * The ledger holds one entry per call signature, carrying that call's most
 * recent run, so "never re-ran it" needs no separate test: a check re-run and
 * passed is no longer failing, and a check re-run and failed again is still
 * unanswered. Ledger order is recency of last run, which is what makes
 * condition 5 a statement about time.
 *
 * The most recent such failing check wins, because it is the reading the
 * completion is standing closest to.
 *
 * @category conversions
 * @since 0.1.0
 */
export const find = (options: {
  /** Every check this run has run, oldest first, this frame's included. */
  readonly ledger: ReadonlyArray<NarrowedCheck.Check>
  /** The workspace digest the completing frame closed on; empty when unmeasured. */
  readonly digest: string
}): Displaced | undefined => {
  if (options.digest === "") return undefined
  let found: Displaced | undefined = undefined
  for (const [index, earlier] of options.ledger.entries()) {
    if (!earlier.failing || !earlier.stable) continue
    if (earlier.digest !== options.digest) continue
    const instead = options.ledger.slice(index + 1).find((candidate) => revisits(candidate, earlier))
    // Oldest first, keeping the last match: the ledger is ordered by when each
    // check last ran, so the surviving pair names the most recent failure.
    if (instead !== undefined) found = { failed: earlier, instead }
  }
  return found
}

/**
 * States which reading failed, which one replaced it, and what ends it.
 *
 * The text quotes both calls as the run wrote them and asserts only what the
 * record says: the first reported a failing exit status over this exact tree,
 * the second asked about the same subject, and the first was never run again.
 * It does not say the failures are the run's fault, because it does not know —
 * a pre-existing failure is a real answer and the demand names it as one of the
 * two ways out.
 *
 * It also says plainly that nothing re-runs anything for the run, and that the
 * next answer stands.
 *
 * @category constructors
 * @since 0.1.0
 */
export const demand = (found: Displaced): string =>
  DemandText.unresolved(found.failed.flow, found.failed.label, found.instead.label)
