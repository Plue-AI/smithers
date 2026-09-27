/**
 * Telling an invalid probe from a failing check.
 *
 * A non-zero exit is a runner's verdict about the code it ran. It is not the
 * runner's verdict about the command it was handed. When an invocation names a
 * test, a file, a module, an environment, or a program that does not exist, the
 * runner never reaches any code and still exits non-zero — and at the tool
 * boundary that is indistinguishable from the bug reproducing. A SWE-bench run
 * lost thirty-nine frames to exactly that: the reproduction named a test method
 * the class does not define, so it read `exitCode: 1` before the edit and
 * `exitCode: 1` after it, and the agent could not tell it had already won.
 *
 * This module names that class. The taxonomy is one idea — *the invocation
 * named something that does not exist* — and {@link Reason} enumerates the five
 * things that something can be. An enumerated answer over prose is a judgment,
 * so Jev makes it: {@link classify} asks the `probe/attribution` classifier
 * whether this exit describes the tree or one of the five, and whether a runner
 * ran anything at all. Nothing here reads the output itself. The judgment used
 * to be nine regexes over runner wording, vetoed by two more over runner
 * tallies, and every phrase they matched is also printed by genuine failures —
 * a bug that *is* an import error, a test that asserts on a shell message — so
 * precision cost recall and both cost maintenance.
 *
 * Two things are still decided here, because they are facts rather than
 * readings. A zero exit is never classified: a command that ran is a command
 * that ran, whatever it printed. And {@link posix} reads the two exit codes
 * POSIX reserves for the shell's own refusal to start the command — 127 not
 * found, 126 found and not executable — which no runner reaches its own tests
 * and then reports. Neither costs a call.
 *
 * There is no third path. When the judge does not answer, {@link unjudged}
 * turns its failure into the caller's typed failure: a guess about whether a
 * reproduction reproduced is worth less than nothing, and the caller can say
 * that a result was not judged where it cannot say that a guess was wrong.
 *
 * A flow that can tell the difference reports it under the reserved output key
 * {@link key}. The harness reads that key off an otherwise opaque call result
 * and refuses to count such a result as evidence that anything about the tree
 * changed, which is what stops a broken probe from being cited as a
 * reproduction.
 *
 * @since 1.0.0
 */

import * as Classifier from "@smthrs/model/Classifier"
import type * as Evaluator from "@smthrs/model/Evaluator"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { truncateBytes } from "./internal/Text.ts"
import * as StdError from "./StdError.ts"

/**
 * The reserved output key a flow reports an invalid probe under.
 *
 * Stated as a constant because it is a wire contract with the harness rather
 * than a shared type: `@smthrs/harness` reads this key off a `Schema.Json`
 * result and must not depend on the tool library to do it.
 *
 * @category identifiers
 * @since 1.0.0
 */
export const key = "invalidProbe"

/**
 * What the invocation named that does not exist.
 *
 * Five members, and the classifier offers exactly these five beside `tree`.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Reason = Schema.Literals([
  "unknown-command",
  "unknown-test",
  "unknown-path",
  "unknown-module",
  "unknown-environment"
])

/**
 * What the invocation named that does not exist.
 *
 * @category models
 * @since 1.0.0
 */
export type Reason = typeof Reason.Type

/**
 * One command's failure, attributed to the command rather than to the tree.
 *
 * @category schemas
 * @since 1.0.0
 */
export const InvalidProbe = Schema.Struct({
  reason: Reason.annotate({ description: "Which kind of name the command could not resolve" }),
  evidence: Schema.String.annotate({
    description: "What this attribution rests on: the shell's own exit code, or the judge's reading and how sure it is"
  }),
  message: Schema.String.annotate({ description: "What the failure does and does not prove, stated for the caller" })
})

/**
 * One command's failure, attributed to the command rather than to the tree.
 *
 * @category models
 * @since 1.0.0
 */
export type InvalidProbe = typeof InvalidProbe.Type

/**
 * What one command's exit code was attributed to.
 *
 * `to` is the tree, or the kind of name the command could not resolve, and
 * `invalidProbe` is present in exactly the second case, ready to report under
 * {@link key}. `executed` is the judge's separate reading of whether a runner
 * ran any test, absent when nothing was asked.
 *
 * @category models
 * @since 1.0.0
 */
export interface Attribution {
  readonly to: "tree" | Reason
  readonly executed?: boolean
  readonly invalidProbe?: InvalidProbe
}

/**
 * The confidence an attribution needs before it outranks the tree.
 *
 * Below it the failure is the tree's, which is the reading that leaves the
 * caller the output it would have had anyway. A missed invalid probe costs a
 * reader nothing it had; a false one tells it its reproduction proved nothing.
 *
 * @category constants
 * @since 1.0.0
 */
export const CONFIDENCE_FLOOR = 0.7

/**
 * The most output bytes one judgment carries, newest kept.
 *
 * A runner prints its refusal last, and the classifier's whole state is held
 * to 32 KiB.
 *
 * @category constants
 * @since 1.0.0
 */
export const MAX_OUTPUT_BYTES = 32 * 1024

/** What each reason means, in the second half of one sentence. */
const named: Record<Reason, string> = {
  "unknown-command": "the shell could not find the program it was asked to run",
  "unknown-test": "the test runner could not find the test that was named",
  "unknown-path": "the file or directory that was named does not exist",
  "unknown-module": "the module that was imported does not exist here",
  "unknown-environment": "the runner has no environment by that name"
}

const explain = (reason: Reason): string =>
  `This command never ran a check: ${
    named[reason]
  }. The non-zero exit describes the command, not the code under test, so it is not a reproduction and reads the same before and after a correct fix. Find the real names, repair the command, and run it again before drawing any conclusion from it.`

const invalid = (reason: Reason, evidence: string): InvalidProbe => ({
  reason,
  evidence,
  message: explain(reason)
})

/**
 * The shell's own refusal to start the command, read from its exit code.
 *
 * POSIX reserves 127 for "not found" and 126 for "found and not executable".
 * No runner reaches its own tests and then reports either one, so this needs
 * no judgment and asks for none.
 *
 * @category classification
 * @since 1.0.0
 */
export const posix = (exitCode: number): InvalidProbe | undefined =>
  exitCode === 127 || exitCode === 126 ? invalid("unknown-command", `the command exited ${exitCode}`) : undefined

/** How the judge's own reading is quoted back to the caller. */
const judged = (reason: Reason, confidence: number, executed: boolean): string =>
  `the judge read this output as ${reason} at confidence ${confidence.toFixed(2)}${
    executed ? ", although the runner also reported that it ran tests" : ""
  }`

/** Which typed failure each way the judge can fail to answer is. */
const unjudgedCode: Record<Evaluator.EvaluatorErrorCode, StdError.Code> = {
  unreachable: "provider_unavailable",
  refused: "provider_unavailable",
  empty: "provider_unavailable",
  timeout: "timeout",
  invalid_answer: "request_failed",
  invalid_question: "request_failed"
}

/**
 * The standard-flow failure a judge that did not answer is.
 *
 * A handler that cannot say whether a failing command failed about itself has
 * no result to return: reporting the exit code alone is the reading that lost
 * the thirty-nine frames. So the call fails, the code names which way the
 * gateway went wrong, and the message says what is missing and how a host
 * supplies it.
 *
 * @category errors
 * @since 1.0.0
 */
export const unjudged = (error: Classifier.ClassifierError): StdError.StdError =>
  new StdError.StdError({
    code: unjudgedCode[error.code],
    message:
      `This result was not judged: the attribution judge answered ${error.code}. ${error.message} Nothing here says whether the non-zero exit is the code's failure or the command's, and a guess at that is worth less than no answer. Connect a subscription seat for the evaluator, then run the command again.`
  })

/**
 * What one failed command's exit code describes: the tree, or a name the
 * command could not resolve.
 *
 * No cell calls this classifier. {@link classify} asks it on behalf of the
 * `test` flow, which has the command and its output and has no task to judge
 * them against, so the state is the three facts of the run and the questions
 * carry every criterion themselves. It is declared here rather than in a
 * catalog a host binds: a door for the model to ask this would be a door onto
 * a judgment the flow has already made.
 *
 * @category classifiers
 * @since 1.0.0
 */
export const probeAttribution = Classifier.make("probe/attribution", {
  description:
    "Judge one failed command: whether it ran the tests it named and failed about the code, or never resolved a name it was given.",
  state: Schema.Struct({
    command: Schema.String.annotate({ description: "The command that ran" }),
    exitCode: Schema.Int.annotate({ description: "Its exit code, which is not zero" }),
    output: Schema.String.annotate({ description: "Its captured stdout and stderr, newest bytes when clipped" })
  }),
  questions: {
    attribution: Classifier.choice({
      instructions: "What does this non-zero exit describe?",
      criteria: {
        tree: "the command ran the intended tests and the failure is the code's",
        "unknown-command": "the shell could not find the program it was asked to run",
        "unknown-test": "the test runner could not find the test that was named",
        "unknown-path": "the file or directory that was named does not exist",
        "unknown-module": "the module that was imported does not exist here",
        "unknown-environment": "the runner has no environment by that name"
      }
    }),
    executed: Classifier.boolean({
      instructions: "Did a test runner actually run tests?",
      criteria: {
        true: "the runner reported its own tally of tests that ran, such as a count of passes or failures",
        false: "nothing in the output reports that any test was executed"
      }
    })
  }
})

/**
 * Attributes one command result to the tree, or to a name the command could
 * not resolve.
 *
 * A zero exit and the two reserved exit codes are settled here, from facts.
 * Everything else is Jev's: the `probe/attribution` classifier reads the
 * command, its exit code, and the newest {@link MAX_OUTPUT_BYTES} of its
 * output, and answers which of the six this exit describes and whether a
 * runner ran anything. An answer under {@link CONFIDENCE_FLOOR} is the tree's
 * failure, reported with the `executed` reading beside it.
 *
 * Pass the text the caller will actually return, so the judgment is made on
 * the output the reader can see.
 *
 * @category classification
 * @since 1.0.0
 */
export const classify = Effect.fn("Probe.classify")(function*(result: {
  readonly command: string
  readonly exitCode: number
  readonly output: string
}): Effect.fn.Return<Attribution, Classifier.ClassifierError, Evaluator.Evaluator> {
  if (result.exitCode === 0) return { to: "tree" }
  const shell = posix(result.exitCode)
  if (shell !== undefined) return { to: shell.reason, invalidProbe: shell }
  const answers = yield* probeAttribution.evaluate({
    command: result.command,
    exitCode: result.exitCode,
    output: truncateBytes(result.output, MAX_OUTPUT_BYTES, { keep: "tail" }).text
  })
  const executed = answers.executed.value
  const decided = Option.getOrUndefined(Classifier.confident(answers.attribution, CONFIDENCE_FLOOR))
  return decided === undefined || decided === "tree"
    ? { to: "tree", executed }
    : {
      to: decided,
      executed,
      invalidProbe: invalid(decided, judged(decided, answers.attribution.confidence, executed))
    }
})
