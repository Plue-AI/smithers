/** Lint on Jev: a registered check whose body declares maintainer rules, judged
 * one changed hunk at a time by the host's evaluator. It reads no files: the
 * only input is the unified diff between the implementation's immutable parent
 * and head, so a resumed run judges exactly what the first attempt judged. */
import { Action, Flow, Interpreter } from "@smthrs/flow"
import type * as Classifier from "@smthrs/model/Classifier"
import type * as Evaluator from "@smthrs/model/Evaluator"
import * as Executable from "@smthrs/registry/Executable"
import { Effect, Layer, Result, Schema } from "effect"
import * as Jj from "../../packages/smithers/flows/jj/src/Jj.ts"
import { privatePath } from "../repository/check-context.ts"
import type { Comparison } from "../repository/checks.ts"
import {
  batches,
  hunks,
  jevUnavailable,
  jevVerdict,
  MAX_HUNK_BYTES,
  ruleClassifier,
  scopedPaths
} from "../repository/jev-checks.ts"
import type { Check as RepositoryCheck } from "../repository/schema.ts"
import { Check, checkInputDigest, CodingError, type Finding, Implementation, Receipt } from "./schema.ts"

/** The most rules one check body may declare. */
export const MAX_RULES = 8
/** The most (rule, hunk) questions one check may ask Jev; a larger change is refused unasked. */
export const MAX_QUESTIONS = 256
/** The most diff bytes one check reads. */
export const MAX_DIFF_BYTES = 1_000_000

const Rule = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,63}$/)),
  rule: Schema.NonEmptyString.check(Schema.isMaxLength(4_000)),
  paths: Schema.Array(Schema.NonEmptyString.check(Schema.isMaxLength(500))).check(Schema.isMaxLength(20))
})
/** The registered Markdown flow's verified body, as its first nonempty line. */
export const Rules = Schema.Struct({
  rules: Schema.Array(Rule).check(Schema.isMinLength(1), Schema.isMaxLength(MAX_RULES))
})
const Input = Schema.Struct({ implementation: Implementation, check: Check })
const invalid = (message: string) => new CodingError({ code: "invalid_receipt", message })

export const CheckRules = Action.make("coding/check-jev-rules", {
  // Invocation includes the pinned body, so rule changes change action keys.
  payload: Executable.Invocation,
  success: Receipt,
  error: CodingError,
  nondeterministic: true
})
export const jevCheckDelegate = Flow.make("coding/JevCheck", {
  payload: Executable.Invocation,
  success: Receipt,
  error: CodingError,
  body: (invocation) => CheckRules.call(invocation)
})

const encoder = new TextEncoder()
const gitHeader = "diff --git a/"

/** One changed file of a unified diff: its path, every path it touches, its section text, and whether git rendered it as binary. */
export interface DiffFile {
  readonly path: string
  readonly sides: ReadonlyArray<string>
  readonly text: string
  readonly binary: boolean
}

/** The extended header lines git and jj write between `diff --git` and `---`. */
const extended =
  /^(index |new file mode |deleted file mode |old mode |new mode |similarity index |dissimilarity index |rename from |rename to |copy from |copy to |Binary files |GIT binary patch$)/

/**
 * True when the lines are only hunks whose bodies hold exactly the lines their
 * `@@` counts declare, so no stray line (such as a filename's second line) can
 * ride inside a section it does not belong to.
 */
const wellFormedHunks = (lines: ReadonlyArray<string>): boolean => {
  let index = 0
  while (index < lines.length) {
    const start = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(lines[index]!)
    if (!start) return false
    let before = Number(start[1] ?? 1), after = Number(start[2] ?? 1)
    for (index++; before > 0 || after > 0; index++) {
      const line = lines[index]
      if (line === undefined) return false
      if (line.startsWith("\\")) continue
      const kind = line === "" ? " " : line[0]
      if (kind === " ") {
        before--
        after--
      } else if (kind === "-") before--
      else if (kind === "+") after--
      else return false
      if (before < 0 || after < 0) return false
    }
    while (lines[index]?.startsWith("\\")) index++
  }
  return true
}

/**
 * Splits a unified diff into files whose path is unambiguous, or names why it
 * cannot. Each section must be the header, known extended header lines, then
 * either nothing or `---`, `+++` and a hunk, and the header must spell exactly
 * the `---`/`+++` paths, so a filename carrying a newline or ` b/` cannot pass
 * for another file. Quoted (escaped) paths are refused.
 */
export const files = (diff: string): ReadonlyArray<DiffFile> | string => {
  const found: Array<DiffFile> = []
  const ambiguous = "The implementation diff names a file the Jev check cannot read unambiguously"
  for (const text of diff.split(/(?=^diff --git )/m)) {
    if (!text.startsWith("diff --git ")) {
      if (text.trim() === "") continue
      return "The implementation diff has text outside a file section"
    }
    const lines = text.replace(/\n$/, "").split("\n"), header = lines[0]!
    if (!header.startsWith(gitHeader)) return ambiguous
    let index = 1
    while (index < lines.length && extended.test(lines[index]!)) index++
    const meta = lines.slice(1, index)
    const binary = meta.some((line) => line.startsWith("Binary files ") || line === "GIT binary patch")
    const label = (line: string | undefined, prefix: string) =>
      line?.startsWith(prefix) ? line.slice(prefix.length).replace(/\t$/, "") : undefined
    const renamedFrom = label(meta.find((line) => line.startsWith("rename from ")), "rename from ")
    const renamedTo = label(meta.find((line) => line.startsWith("rename to ")), "rename to ")
    let sides: ReadonlyArray<string>
    if (index === lines.length) {
      if (binary && renamedTo === undefined) {
        const both = header.slice(gitHeader.length), half = (both.length - 3) / 2
        if (!Number.isInteger(half) || half <= 0 || both !== `${both.slice(0, half)} b/${both.slice(0, half)}`) {
          return ambiguous
        }
        sides = [both.slice(0, half)]
      } else if (renamedFrom !== undefined && renamedTo !== undefined) {
        if (header !== `${gitHeader}${renamedFrom} b/${renamedTo}`) return ambiguous
        sides = [renamedTo, renamedFrom]
      } else {
        const both = header.slice(gitHeader.length), half = (both.length - 3) / 2
        if (!Number.isInteger(half) || half <= 0 || both !== `${both.slice(0, half)} b/${both.slice(0, half)}`) {
          return ambiguous
        }
        sides = [both.slice(0, half)]
      }
    } else {
      const before = lines[index], after = lines[index + 1], hunk = lines[index + 2]
      if (hunk === undefined || !hunk.startsWith("@@ ")) return ambiguous
      const old = before === "--- /dev/null" ? null : label(before, "--- a/")
      const next = after === "+++ /dev/null" ? null : label(after, "+++ b/")
      if (old === undefined || next === undefined || (old === null && next === null)) return ambiguous
      if (header !== `${gitHeader}${old ?? next} b/${next ?? old}`) return ambiguous
      if (renamedTo !== undefined && (renamedTo !== next || renamedFrom !== old)) return ambiguous
      sides = [...new Set([(next ?? old)!, (old ?? next)!])]
      if (!wellFormedHunks(lines.slice(index + 2))) return ambiguous
    }
    if (sides.some((path) => path === "" || path.startsWith("\"") || path.includes("\t"))) return ambiguous
    found.push({ path: sides[0]!, sides, text, binary })
  }
  return found
}

/** One receipt from the rules Jev judged over one implementation's diff. */
export const judge = (
  invocation: typeof Executable.Invocation.Type
): Effect.Effect<Receipt, CodingError, Jj.Jj | Evaluator.Evaluator> =>
  Effect.gen(function*() {
    const { implementation, check } = yield* Schema.decodeUnknownEffect(Input)(invocation.input)
      .pipe(Effect.mapError(() => invalid("Check input must identify the implemented revision and declared check")))
    if (invocation.flow !== check.flow) return yield* invalid("The registered check flow does not match the plan")
    const { rules } = yield* Effect.try({
      try: () => JSON.parse(invocation.prompt.trimStart().split(/\r?\n/, 1)[0] ?? "") as unknown,
      catch: () => invalid("The registered Jev check body must be a JSON rules declaration")
    }).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Rules)),
      Effect.mapError(() =>
        invalid(`The registered Jev check body needs 1 to ${MAX_RULES} rules with id, rule and paths`)
      )
    )
    const base = implementation.parent.commitId, candidate = implementation.head.commitId
    const diff = yield* (yield* Jj.Jj).diff(base, candidate).pipe(Effect.mapError((error) =>
      new CodingError({
        code: "execution",
        message: `The Jev check could not read the implementation diff: ${error.message.slice(0, 512)}`
      })
    ))
    const receipt = (status: "passed" | "failed", evidence: unknown, findings: ReadonlyArray<Finding>): Receipt => ({
      checkId: check.id,
      target: check.target,
      tier: check.tier,
      change: implementation.change,
      commitId: candidate,
      treeId: implementation.head.treeId,
      inputDigest: checkInputDigest(implementation, check),
      status,
      evidence: JSON.stringify(evidence),
      findings
    })
    const finding = (message: string): Finding => ({
      owner: implementation.change,
      sourceCommitId: candidate,
      message: message.slice(0, 2_000)
    })
    if (new TextEncoder().encode(diff).length > MAX_DIFF_BYTES) {
      return receipt("failed", { refused: "diff_too_large", limitBytes: MAX_DIFF_BYTES }, [
        finding(`The change is too large for the Jev check (over ${MAX_DIFF_BYTES} diff bytes)`)
      ])
    }
    const parsed = files(diff)
    if (typeof parsed === "string") return receipt("failed", { refused: "unsupported_diff" }, [finding(parsed)])
    // A file touching a private repository-job path on either side never reaches Jev.
    const public_ = parsed.filter((file) => !file.sides.some(privatePath))
    const paths = public_.map((file) => file.path)
    const comparison: typeof Comparison.Type = { base, candidate, diff: "", paths, files: [], changes: [] }
    const changed = public_.flatMap((file) =>
      hunks({ ...comparison, diff: file.text }).map((hunk) => ({ ...hunk, path: file.path }))
    )
    const clipped = changed.find((hunk) => encoder.encode(hunk.hunk).length >= MAX_HUNK_BYTES - 3)
    if (clipped !== undefined) {
      return receipt("failed", { refused: "hunk_too_large", path: clipped.path, limitBytes: MAX_HUNK_BYTES }, [
        finding(`${clipped.path}:${clipped.line} has a hunk too large for the Jev check to judge whole`)
      ])
    }
    const checks = rules.map((rule): typeof RepositoryCheck.Type => ({
      id: rule.id,
      name: rule.id,
      kind: "ai",
      rule: rule.rule,
      paths: rule.paths,
      policy: "report"
    }))
    const scope = checks.map((rule) => {
      const scoped = new Set(scopedPaths(comparison, rule))
      return {
        rule,
        states: changed.filter((hunk) => scoped.has(hunk.path)).map((hunk) => ({ rule: rule.rule, ...hunk })),
        binary: public_.filter((file) => file.binary && scoped.has(file.path)).map((file) => file.path)
      }
    })
    const questions = scope.reduce((total, entry) => total + entry.states.length, 0)
    if (questions > MAX_QUESTIONS) {
      return receipt("failed", { refused: "too_many_questions", questions, limit: MAX_QUESTIONS }, [
        finding(`The change has ${questions} rule-hunk pairs; the Jev check asks at most ${MAX_QUESTIONS}`)
      ])
    }
    const verdicts: Array<
      {
        readonly rule: string
        readonly verdict: "pass" | "fail" | "uncertain"
        readonly summary: string
        readonly findings: ReadonlyArray<{ readonly path: string; readonly line: number; readonly message: string }>
      }
    > = []
    for (const { rule, states, binary } of scope) {
      // A changed file in scope with no text hunk cannot be judged, so it is never clean.
      if (binary.length) {
        verdicts.push({
          rule: rule.id,
          verdict: "uncertain",
          summary: `Jev cannot judge binary changes to ${binary.join(", ")}`,
          findings: []
        })
        continue
      }
      // A rule with nothing in scope passes without spending a question.
      if (!states.length) {
        verdicts.push({ rule: rule.id, verdict: "pass", summary: "No changed hunk in scope", findings: [] })
        continue
      }
      const answered = yield* Effect.forEach(batches(states), (batch) => ruleClassifier.evaluateAll(batch), {
        concurrency: 1
      })
      const answers: Array<{ readonly violates: Classifier.BooleanAnswer }> = []
      for (const answer of answered.flat()) {
        if (Result.isFailure(answer)) return yield* Effect.fail(jevUnavailable(rule, answer.failure))
        answers.push(answer.success)
      }
      const verdict = jevVerdict(comparison, rule, states, answers)
      verdicts.push({ rule: rule.id, verdict: verdict.verdict, summary: verdict.summary, findings: verdict.findings })
    }
    const findings = verdicts.flatMap((verdict) =>
      verdict.verdict === "fail"
        ? verdict.findings.map((found) => finding(`${found.path}:${found.line} ${verdict.rule}: ${found.message}`))
        : verdict.verdict === "uncertain"
        ? [finding(`${verdict.rule}: ${verdict.summary}`)]
        : []
    )
    return receipt(findings.length ? "failed" : "passed", { judge: "jev", questions, rules: verdicts }, findings)
  })

/** Supply this layer to the native action table and register {@link jevCheckDelegate}. */
export const jevCheckLayers = (evaluator: Layer.Layer<Evaluator.Evaluator>) =>
  Layer.mergeAll(
    Interpreter.layer(jevCheckDelegate),
    CheckRules.toLayer((invocation) => judge(invocation).pipe(Effect.provide(evaluator)))
  )
