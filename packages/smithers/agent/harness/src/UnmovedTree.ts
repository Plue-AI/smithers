/**
 * The completion with nothing behind it.
 *
 * A run finishes by claiming its work is done. Every other control in this
 * package asks whether the *evidence* for that claim holds up. This one asks a
 * question that comes before evidence: is there anything for the evidence to be
 * about. A run that has not changed the workspace at any point in its life has
 * produced nothing, and a sentence describing a change it did not make is not a
 * result — it is a description of one.
 *
 * It is not hypothetical. On a graded benchmark one instance ran seven frames,
 * issued eleven flow calls — three `read`, seven `grep`, one `bash` — made no
 * editing call of any kind, and closed all seven frames on the identical
 * workspace digest the run had opened on. It then completed with "Updated
 * `AdminSite.catch_all_view()` to preserve query strings when `APPEND_SLASH`
 * redirects add a trailing slash." The captured patch was zero bytes. The same
 * instance had resolved in five frames one wave earlier.
 *
 * Every armed control let that through, and each for a reason that was correct
 * about its own subject: the read-only cap is a stall detector and the run
 * finished below it, the narrowing demand judges the shape of a check and there
 * was no check to narrow, and the phantom-write veto vetoes a write that was
 * declared and did not happen — this run declared none. The harness held the
 * fact that decides it the whole time, in seven `mutation-observed` events on
 * one digest, and never consulted it at the `complete` transition.
 *
 * The comparison is between two measurements the harness already took: the
 * digest of the tree the run opened on, and the digest the completing frame
 * closed on. Equal digests mean the tree the completion describes is the tree
 * the run was handed. Nothing here reads the completion's text, and nothing
 * here decides whether the run was right: "no change is needed" is a legitimate
 * answer to a task, and the demand names it as one of the two ways out.
 *
 * @since 0.1.0
 */

import * as DemandText from "./internal/demandText.ts"

/**
 * A completion taken over the tree the run was handed.
 *
 * @category models
 * @since 0.1.0
 */
export interface Unmoved {
  /** Content address of the workspace the run opened on. */
  readonly opened: string
  /** Content address of the workspace the completing frame closed on. */
  readonly closed: string
}

/**
 * Whether a completing frame is finishing on the tree the run started with.
 *
 * Both conditions are read off measurements the controller already took, and
 * both are required:
 *
 * 1. the run has an opening measurement that covered the whole tree, and the
 *    completing frame closed on one — an incomplete walk cannot say a tree held
 *    still, and an empty digest is recorded for exactly that case;
 * 2. the two digests are equal.
 *
 * Digest equality, rather than a count of frames that reported a mutation, is
 * what the demand's own sentence claims: that nothing in this workspace differs
 * from the tree the run opened on. That is true of a run that never wrote and
 * equally true of a run that wrote and undid it, and the sentence holds in both
 * cases. A run whose tree moved and stayed moved is not this failure, whatever
 * else may be wrong with it.
 *
 * @category conversions
 * @since 0.1.0
 */
export const find = (options: {
  /** The digest the run opened on; empty when the run never measured one. */
  readonly opened: string
  /** The digest the completing frame closed on; empty when unmeasured. */
  readonly digest: string
  /**
   * Writes this run recorded on trees the two digests do not cover.
   *
   * A `bash` call routed into a container measures that container's working
   * directory itself and reports a move under the reserved `mutated` key; the
   * host walk behind `opened` and `digest` never saw that tree. One such write
   * is the tree moving, and the two digests agreeing says nothing against it.
   * Absent or zero leaves the comparison exactly as it was.
   */
  readonly elsewhere?: number | undefined
}): Unmoved | undefined =>
  options.opened === "" || options.digest === "" || options.opened !== options.digest ||
    (options.elsewhere ?? 0) > 0
    ? undefined
    : { opened: options.opened, closed: options.digest }

/**
 * States that the tree never moved, and names the two answers that end it.
 *
 * The two ways out are stated as equals because they are equals. A task whose
 * right answer is "nothing needs changing" exists, and a run that reaches that
 * conclusion honestly must be able to say so and finish; a demand that only
 * accepted an edit would be pushing such a run into making one. What the demand
 * refuses is the third thing, which is what the recorded run did: a sentence
 * describing an edit, with no edit behind it.
 *
 * The second answer asks for its own working, and the wave that armed this is
 * why. The run this module was built from was bounced off a fabricated
 * completion and answered with "No change is needed", from a run that had made
 * *one* call in its whole life. Nothing is gated on the answer — the harness
 * cannot know whether the claim is true, and grading it would be the harness
 * deciding the task — but the sentence no longer hands the exit over for free:
 * a run that concluded the repository is already correct concluded it from
 * something, and saying what that was costs a truthful run nothing and costs a
 * run that checked nothing the whole answer.
 *
 * It also says plainly that nothing makes the change for the run, and that the
 * next answer stands. Anything softer invites a re-submission of the same
 * frame; anything harder would be the harness grading the run's conclusion.
 *
 * @category constructors
 * @since 0.1.0
 */
export const demand = (found: Unmoved): string => DemandText.unmoved(found.opened, found.closed)
