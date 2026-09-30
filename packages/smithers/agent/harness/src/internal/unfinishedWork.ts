/**
 * The completion that says, in its own words, that the work is not done.
 *
 * The claim brake's `complete` question may only ask for another frame: its
 * corpus found honest answers and honest reports of unfinished work reading
 * equally low, so a low reading alone is no verdict. What that left open is
 * the run that has no bounce left and still writes "I could not finish X
 * because Y": nothing refused it, so it stood, and a host settled a run that
 * did nothing as a completed one (#3009).
 *
 * So the verdict is asked separately and only there. Where the claim brake
 * read the completion as not done and has no bounce left to spend, one more
 * question asks whether the completion itself reports the work unfinished.
 * A completion that does ends the run as `completion_incomplete`, a typed
 * failure that quotes the run's own report, instead of standing. The question
 * is about the sentence, not the task: an answer, a delivered edit, or a note
 * that something went unverified is not a report of unfinished work, and
 * never reaches this question unless the claim brake had already read it as
 * not done.
 *
 * @since 1.0.0-rc.1
 * @private
 */

import * as Classifier from "@smthrs/model/Classifier"
import * as Evaluator from "@smthrs/model/Evaluator"
import { Effect } from "effect"
import * as CompletionClaim from "../CompletionClaim.ts"
import { HarnessError } from "../HarnessError.ts"
import * as Judgement from "../Judgement.ts"
import { failedReading } from "./paidUsage.ts"

/**
 * The one question, asked of the evidence the claim brake already sent.
 *
 * @since 1.0.0-rc.1
 * @private
 */
export const classifier = Classifier.make("completion/unfinished", {
  description:
    "Judge whether one agent's completion message itself reports that the work it was asked to do is unfinished.",
  state: CompletionClaim.Evidence,
  questions: {
    unfinished: Classifier.boolean({
      instructions:
        "Does the completion explicitly report that the requested work is unfinished, failed, or blocked? Judge what the completion says about its own outcome, not whether the task is actually done.",
      criteria: {
        true:
          "the completion plainly says it could not finish, could not fix, or was stopped from doing the requested work, instead of reporting success",
        false:
          "the completion reports success, supplies the requested answer, or only notes that something it did was not verified"
      }
    })
  }
})

/**
 * At or above this probability of "unfinished", the completion ends the run
 * as a failure rather than standing.
 *
 * @since 1.0.0-rc.1
 * @private
 */
export const reportedAt = 0.9

/**
 * One reading of {@link classifier}, and what asking it cost.
 *
 * @since 1.0.0-rc.1
 * @private
 */
export interface Reading {
  readonly unfinished: number
  readonly latencyMs: number
  readonly usage?: Evaluator.Usage | undefined
  readonly asked: Judgement.Read<typeof classifier.questions>["asked"]
}

/**
 * Asks the question over the claim brake's evidence. A reading that cannot
 * be had fails the turn as `completion_unjudged`, as the claim brake's own
 * does, and the cause carries what it paid with what the `earlier` readings
 * of the same completion paid, so a failed verdict does not lose their spend.
 *
 * @since 1.0.0-rc.1
 * @private
 */
export const read = (
  evidence: CompletionClaim.Evidence,
  earlier: Evaluator.Usage | undefined
): Effect.Effect<Reading, HarnessError, Evaluator.Evaluator> =>
  Judgement.measured(classifier, evidence).pipe(
    Effect.map(({ answers, asked }): Reading => ({
      unfinished: answers.unfinished.probability,
      latencyMs: asked.latencyMs,
      ...(asked.usage === undefined ? {} : { usage: asked.usage }),
      asked
    })),
    Effect.mapError((error) =>
      CompletionClaim.unjudged(
        error.code,
        Evaluator.publicMessage(error),
        evidence.claim,
        failedReading(error, earlier)
      )
    )
  )

/**
 * The failure a completion reporting its own work unfinished ends the run
 * with. It quotes the report, so the person keeps the run's explanation of
 * what is left, and carries both readings that decided it.
 *
 * @since 1.0.0-rc.1
 * @private
 */
export const incomplete = (complete: number, unfinished: number, claim: string): HarnessError =>
  new HarnessError({
    code: "completion_incomplete",
    message: `A completion reporting its own work unfinished: unfinished ${unfinished.toFixed(2)} (complete ${
      complete.toFixed(2)
    }). The run's report, word for word:\n\n${CompletionClaim.refused(claim)}`
  })
