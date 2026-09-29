/** The host judge answers a maintainer's rule one changed hunk at a time. */
import { environmentDispatcher, layerRebuildableRequestExecutor, layerSeatEvaluator } from "@smthrs/cli/NodeControl"
import * as Classifier from "@smthrs/model/Classifier"
import type * as Evaluator from "@smthrs/model/Evaluator"
import { Effect, Layer, Result, Schema } from "effect"
import type * as HttpClient from "effect/unstable/http/HttpClient"
import { matchesGlob } from "node:path"
import { CodingError } from "../coding/schema.ts"
import type { Comparison, SemanticVerdict } from "./checks.ts"
import type { Check } from "./schema.ts"

/** A hunk Jev is asked about: the candidate file, the first line the hunk
 * changes in the candidate, and the hunk's own unified diff text. */
export interface Hunk {
  readonly path: string
  readonly line: number
  readonly hunk: string
}

/** At or above this probability the hunk violates the rule and becomes a
 * finding. This is the review policy's decision threshold, not a calibrated
 * guarantee about whichever subscription model the host resolves. */
export const FLAG_PROBABILITY = 0.8
/** At or below this probability the hunk keeps the rule. Between the two
 * thresholds, the judge's uncertainty makes the check inconclusive. */
export const CLEAN_PROBABILITY = 0.2
/** The most bytes one hunk may take, matching `@smthrs/std`'s per-state bound. */
export const MAX_HUNK_BYTES = 32 * 1024
/** The most hunks one batched evaluation may carry, matching `@smthrs/std`. */
export const MAX_STATES = 64

const encoder = new TextEncoder()
const bytes = (value: string): number => encoder.encode(value).length
/** Clips one string to a byte budget without splitting a surrogate pair. Every
 * classifier in this directory holds its state to the same 32 KiB, so they all
 * clip the same way. */
export const clip = (value: string, limit: number): string => {
  if (limit <= 0) return ""
  if (bytes(value) <= limit) return value
  let end = Math.min(value.length, limit)
  while (end > 0 && bytes(value.slice(0, end)) > limit) end -= 1
  if (end > 0 && value.codePointAt(end - 1)! >= 0xd800 && value.codePointAt(end - 1)! <= 0xdbff) end -= 1
  return value.slice(0, end)
}
const bounded = (text: string): string => clip(text, MAX_HUNK_BYTES)

/** One boolean per (rule, hunk). The state is exactly what the rule can be
 * judged against, so a hunk that needs more than itself reads indecisive. */
export const ruleClassifier = Classifier.make("check/rule", {
  description: "Judge one changed hunk against one maintainer rule: does the hunk, as written, violate the rule?",
  state: Schema.Struct({
    rule: Schema.String.annotate({ description: "The maintainer's rule, in their own words" }),
    path: Schema.String.annotate({ description: "The changed file's path in the candidate" }),
    line: Schema.Int.annotate({ description: "The hunk's first changed line in the candidate" }),
    hunk: Schema.String.annotate({
      description: "The unified diff hunk, its @@ header included, kept under the 32 KiB the whole state may take"
    })
  }),
  questions: {
    violates: Classifier.boolean({
      instructions: "Does this hunk violate the rule as stated?",
      criteria: {
        true: "the changed lines break the rule as written, and the hunk itself shows the violation",
        false: "the changed lines keep the rule, or the rule does not apply to them"
      }
    })
  }
})

/** The state one hunk is judged as. */
export type RuleState = typeof ruleClassifier.state.Type

const hunkHeader = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/
const fileHeader = /^diff --git a\/(.+) b\/(.+)$/m

/** Every changed hunk of the candidate, in diff order.
 *
 * These are read from the same unified diff `diffPaths` already validated and
 * split on the same `diff --git` boundary, rather than re-derived from the
 * whole-file preimages in `changes`. `line` is the first line the hunk adds in
 * the candidate; a hunk that only deletes reports the candidate line the
 * deletion sits at. A path this parser reads is only ever judged when
 * `jevSemanticCheck` finds it in the check's scope, so an encoding the
 * validated diff would have refused cannot reach a finding. */
export const hunks = (comparison: typeof Comparison.Type): ReadonlyArray<Hunk> => {
  const found: Array<Hunk> = []
  for (const part of comparison.diff.split(/(?=^diff --git )/m)) {
    const header = fileHeader.exec(part)
    if (!header) continue
    const path = header[2]!
    const lines = part.split("\n")
    for (let index = 0; index < lines.length; index++) {
      const start = hunkHeader.exec(lines[index]!)
      if (!start) continue
      const body = [lines[index]!]
      let candidate = Number(start[1]), first = 0
      for (index++; index < lines.length; index++) {
        const text = lines[index]!
        if (text.startsWith("@@") || text.startsWith("diff --git ")) break
        body.push(text)
        if (text.startsWith("+")) {
          if (!first) first = candidate
          candidate++
        } else if (text.startsWith(" ") || text === "") candidate++
      }
      index--
      found.push({ path, line: first || Math.max(1, Number(start[1])), hunk: bounded(body.join("\n")) })
    }
  }
  return found
}

/** Every changed path of a proposal, as one whole-file replacement hunk.
 *
 * A proposal is checked before it is a commit, so `captureChecks` gives its
 * comparison no unified diff at all — the change is carried in `changes`, each
 * entry holding the exact preimage and the exact proposed text. While a
 * frontier seat existed that gap was invisible: Jev answered `uncertain` on
 * every proposal and the seat read `changes` itself. With Jev the only
 * checker, a proposal with no state would make every produced change's
 * required review uncertain, so the change is rendered as the unified hunk it
 * will become. `line` is 1 because the hunk covers the file from its first
 * line, and `cited` pulls a finding back onto the captured text. */
export const proposalHunks = (comparison: typeof Comparison.Type): ReadonlyArray<Hunk> =>
  comparison.changes.map((change) => {
    const before = change.before === null ? [] : change.before.replace(/\n$/, "").split("\n")
    const after = change.after === null ? [] : change.after.replace(/\n$/, "").split("\n")
    const header = `@@ -${before.length ? 1 : 0},${before.length} +${after.length ? 1 : 0},${after.length} @@`
    return {
      path: change.path,
      line: 1,
      hunk: bounded([header, ...before.map((text) => `-${text}`), ...after.map((text) => `+${text}`)].join("\n"))
    }
  })

/** The states of one evaluation, at most {@link MAX_STATES} each. */
export const batches = <A>(states: ReadonlyArray<A>): ReadonlyArray<ReadonlyArray<A>> => {
  const grouped: Array<ReadonlyArray<A>> = []
  for (let index = 0; index < states.length; index += MAX_STATES) grouped.push(states.slice(index, index + MAX_STATES))
  return grouped
}

/** The changed paths this check is configured to cover, matched the way
 * `verifyTrialChecks` matches them. */
export const scopedPaths = (comparison: typeof Comparison.Type, check: typeof Check.Type): ReadonlyArray<string> =>
  comparison.paths.filter((path) => !check.paths.length || check.paths.some((pattern) => matchesGlob(path, pattern)))

/** A finding cites captured evidence or the check errors instead of failing,
 * so a line the hunk arithmetic put past the captured source is pulled back
 * onto it rather than thrown away, which would turn a fail into a pass. */
const cited = (comparison: typeof Comparison.Type, path: string, line: number): number => {
  const text = comparison.files.find((file) => file.path === path)?.text
    ?? comparison.changes.find((change) => change.path === path && change.after === null)?.before ?? undefined
  return text === undefined || text === null ? line : Math.min(line, Math.max(1, text.split("\n").length))
}

/** One answer per hunk becomes one verdict.
 *
 * A probability at or above {@link FLAG_PROBABILITY} flags the hunk, one at or
 * below {@link CLEAN_PROBABILITY} clears it, and anything between or a missing
 * answer is indecisive. Every answer decisive and none flagged is a pass, a
 * decisive flag is a fail, and one indecisive hunk makes the whole check
 * uncertain. An evaluation Jev could not answer at all never reaches here:
 * {@link jevSemanticCheck} fails instead of inventing a verdict. */
export const jevVerdict = (
  comparison: typeof Comparison.Type,
  check: typeof Check.Type,
  states: ReadonlyArray<RuleState>,
  answers: ReadonlyArray<{ readonly violates: Classifier.BooleanAnswer }>
): typeof SemanticVerdict.Type => {
  const examinedPaths = scopedPaths(comparison, check)
  const named = check.name || check.id
  if (!states.length) {
    return { verdict: "uncertain", summary: `Jev found no hunk to judge against ${named}`, examinedPaths, findings: [] }
  }
  const decided = states.map((_, index) => {
    const answer = answers[index]
    if (answer === undefined) return undefined
    const probability = answer.violates.probability
    return probability >= FLAG_PROBABILITY ? true : probability <= CLEAN_PROBABILITY ? false : undefined
  })
  const unsure = decided.filter((value) => value === undefined).length
  const flagged = states.filter((_, index) => decided[index] === true)
  if (unsure) {
    return {
      verdict: "uncertain",
      summary: `Jev was unsure about ${unsure} of ${states.length} hunks against ${named}`,
      examinedPaths,
      findings: []
    }
  }
  if (!flagged.length) {
    return { verdict: "pass", summary: `Jev found no hunk violating ${named}`, examinedPaths, findings: [] }
  }
  return {
    verdict: "fail",
    summary: `Jev flagged ${flagged.length} of ${states.length} hunks against ${named}`,
    examinedPaths,
    findings: flagged.slice(0, 40).map((state) => ({
      path: state.path,
      line: cited(comparison, state.path, state.line),
      message: check.rule
    }))
  }
}

/** The typed failure a hunk Jev could not answer becomes. It names the
 * evaluator's own code and message so an errored check row says which part of
 * the transport gave out, not merely that something did. */
export const jevUnavailable = (check: typeof Check.Type, failure: Classifier.ClassifierError): CodingError =>
  new CodingError({
    code: "unavailable",
    message: `Jev could not judge ${check.name || check.id}: ${failure.code} — ${failure.message}`
  })

/** Asks Jev about every in-scope hunk and reports what it decided.
 *
 * Jev is the only model that judges the rule. A host with no transport, a
 * refused provider, a timeout and a malformed answer all fail the call with
 * {@link jevUnavailable}; nothing else is asked and no verdict is invented.
 * An indecisive answer is different: that is Jev deciding it is unsure, and
 * the uncertain verdict it produces is the check's own verdict. */
export const jevSemanticCheck = (
  comparison: typeof Comparison.Type,
  check: typeof Check.Type
): Effect.Effect<typeof SemanticVerdict.Type, CodingError, Evaluator.Evaluator> =>
  Effect.gen(function*() {
    const scoped = new Set(scopedPaths(comparison, check))
    const rule = check.rule.trim()
    // A committed comparison carries its own diff. A proposal carries none,
    // so its exact changes are rendered as hunks instead.
    const parsed = hunks(comparison)
    const changed = parsed.length ? parsed : proposalHunks(comparison)
    const states: ReadonlyArray<RuleState> = !rule ?
      []
      : changed.filter((hunk) => scoped.has(hunk.path)).map((hunk) => ({ rule, ...hunk }))
    if (!states.length) return jevVerdict(comparison, check, [], [])
    const answered = yield* Effect.forEach(batches(states), (batch) => ruleClassifier.evaluateAll(batch), {
      concurrency: 1
    })
    const answers: Array<{ readonly violates: Classifier.BooleanAnswer }> = []
    for (const answer of answered.flat()) {
      if (Result.isFailure(answer)) return yield* Effect.fail(jevUnavailable(check, answer.failure))
      answers.push(answer.success)
    }
    return jevVerdict(comparison, check, states, answers)
  })

/** Use the native subscription judge over the host's proxy-aware transport.
 * Seat resolution is lazy, so newly connected accounts work without a restart.
 * Missing subscriptions and invalid verdicts fail closed when asked to judge. */
export const evaluatorLayer = (
  environment: Readonly<Record<string, string | undefined>>,
  jevHttp?: Layer.Layer<HttpClient.HttpClient>
): Layer.Layer<Evaluator.Evaluator> =>
  layerSeatEvaluator(environment, jevHttp).pipe(
    Layer.provide(layerRebuildableRequestExecutor(environmentDispatcher(environment)))
  )
