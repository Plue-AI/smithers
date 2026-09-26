/** Repository CI runs cheap commands first and records semantic checks on exact source. */
import * as Digest from "@smthrs/core/Digest"
import type * as Evaluator from "@smthrs/model/Evaluator"
import { Action, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Effect, Layer, Option, Path, Schema } from "effect"
import { matchesGlob } from "node:path"
import * as Jj from "../../packages/smithers/flows/jj/src/Jj.ts"
import { contained, runSourceProcess, withImmutableSource, type ImmutableSourceOptions } from "../coding/immutable-source.ts"
import { normalizePath, Source } from "../coding/planning-sources.ts"
import { CodingError } from "../coding/schema.ts"
import { currentExecutionId } from "./inspection.ts"
import { retainedStepError, Work } from "./jobs.ts"
import { Check, Proposal, StepResult, type Draft, type JobResult, type Step } from "./schema.ts"
import { captureCheckContext, CheckContext, contextFailure, privatePath, rulePaths } from "./check-context.ts"
import { jevSemanticCheck } from "./jev-checks.ts"
import { admitSourcePath, withCapturedCommit } from "./source.ts"

const invalid = (message: string) => new CodingError({ code: "invalid_receipt", message })
const object = (value: unknown): Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
const json = (value: unknown): Schema.Json => JSON.parse(JSON.stringify(value))
const Commit = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/))
export const Comparison = Schema.Struct({ base: Commit, candidate: Schema.NonEmptyString, diff: Schema.String,
  paths: Schema.Array(Schema.String), files: Schema.Array(Source),
  changes: Schema.Array(Schema.Struct({ path: Schema.String, before: Schema.NullOr(Schema.String), after: Schema.NullOr(Schema.String) })) })
export const CheckSource = Schema.Struct({ path: Schema.NonEmptyString, present: Schema.Boolean })
export const CheckPlan = Schema.Struct({ work: Work, comparison: Comparison, contexts: Schema.Array(CheckContext),
  baseContexts: Schema.optionalKey(Schema.Array(CheckContext)), searched: Schema.optionalKey(Schema.Array(CheckSource)) })
export const CheckResult = Schema.Struct({ checkId: Schema.String, policy: Check.fields.policy,
  status: Schema.Literals(["passed", "failed", "error", "skipped"]), summary: Schema.String,
  evidence: Schema.Array(Schema.String), executionId: Schema.String, detail: Schema.Json })
/** Code findings can block policy even though the check executed correctly. */
export const CheckOutput = Schema.Struct({ base: Commit, candidate: Schema.NonEmptyString,
  gate: Schema.Literals(["blocked", "passed"]), results: Schema.Array(CheckResult).check(Schema.isMinLength(1)) })
const Finding = Schema.Struct({ path: Schema.NonEmptyString, line: Schema.Int.check(Schema.isGreaterThan(0)), message: Schema.NonEmptyString })
/** Which model reached the verdict a row retained. Jev is the only one that
 * can now, but `seat` stays in the literals so rows stored while a frontier
 * checker existed keep decoding, and the key stays optional because rows
 * older than the field carry neither. `RetainSemantic` is its only writer, so
 * a checker that names itself in its own output cannot forge the record. */
export const DecidedBy = Schema.Literals(["jev", "seat"])
export const SemanticVerdict = Schema.Struct({ verdict: Schema.Literals(["pass", "fail", "uncertain"]),
  summary: Schema.NonEmptyString, examinedPaths: Schema.Array(Schema.String), findings: Schema.Array(Finding).check(Schema.isMaxLength(40)),
  decidedBy: Schema.optionalKey(DecidedBy) })
/** Shared by review execution, its trial verifier and the evaluator. */
export const reviewCheckId = (stepId: string): string => `review-${stepId}`
/** A review's product is what it found on the exact source, so its own finding
 * cannot be the reason its step failed: a required synthesized rule made every
 * finding-bearing review an errored step with a blocked gate, which no eval
 * case and no live trial could ever complete. Promoting an AI rule to a
 * required gate stays the maintainer's separate decision (`suggestedChecks`). */
export const reviewCheck = (step: typeof Step.Type): typeof Check.Type => ({
  id: reviewCheckId(step.id), name: step.name, kind: "ai", rule: step.prompt, paths: [], policy: "report"
})
export interface RecordedCheck {
  readonly step: typeof StepResult.Type
  readonly output: typeof CheckOutput.Type
  readonly phase: "baseline" | "candidate"
}
/** Read only the host's direct check or proposal.checks shape, never arbitrary
 * nested model JSON. Baselines remain measured evidence, not final coverage. */
export const recordedChecks = (step: typeof StepResult.Type, sourceRevision: string): ReadonlyArray<RecordedCheck> | undefined => {
  const raw = object(step.output), direct = Schema.decodeUnknownOption(CheckOutput)(step.output)
  if (Option.isSome(direct)) {
    if (direct.value.candidate !== sourceRevision) throw invalid("The recorded check names another source")
    return [{ step, output: direct.value, phase: "candidate" }]
  }
  if (!("checks" in raw)) {
    if ("gate" in raw || "results" in raw) throw invalid("The recorded check output is malformed")
    return undefined
  }
  const nested = Schema.decodeUnknownOption(Schema.Array(StepResult))(raw.checks)
  const proposal = Schema.decodeUnknownOption(Proposal)(raw.proposal)
  if (Option.isNone(nested) || Option.isNone(proposal)) throw invalid("The proposed check results are malformed")
  if (!nested.value.length) {
    if (raw.status === "checked-proposal") throw invalid("The completed proposal has no recorded checks")
    return undefined
  }
  const finalCandidate = `${sourceRevision}+${Digest.digest(Digest.canonical(proposal.value))}`
  return nested.value.map(check => {
    const output = Schema.decodeUnknownOption(CheckOutput)(check.output)
    if (Option.isNone(output)) throw invalid("A proposed check result is malformed")
    const value = output.value
    if (value.base !== sourceRevision || !value.candidate.startsWith(sourceRevision + "+") ||
        !/^[0-9a-f]{64}$/.test(value.candidate.slice(sourceRevision.length + 1))) throw invalid("A proposed check names another source")
    return { step: check, output: value, phase: value.candidate === finalCandidate ? "candidate" as const : "baseline" as const }
  })
}
/** The checker's own recorded admission that it could not conclude on the
 * supplied scope. `assessSemantic` is the only writer of this summary. */
export const inconclusiveCheck = "The AI check did not establish complete scope coverage"
/** A valid failed required check is a policy finding. It is not an unavailable
 * execution. Report-only model/tool errors still invalidate eval/trial proof.
 * The single recorded error a reviewed step may be judged on is its own check
 * reporting, against this exact source, that it could not conclude: a
 * contradicted verdict, a citation outside the captured evidence, a missing
 * context, an expired deadline and a lost execution all stay unavailable. */
export const unavailableCheck = ({ output }: RecordedCheck, reviewedId?: string): typeof CheckResult.Type | undefined =>
  output.results.find(check => check.status === "error" && !(check.checkId === reviewedId && check.summary === inconclusiveCheck &&
    check.evidence.includes(`execution:${check.executionId}`) && check.evidence.includes(`source:${output.candidate}`)))
/** The refusal carries the check and its measured reason: a report-only rule
 * the gate deliberately ignored still stops the trial, and the bare fact that
 * something was unavailable sent the last operator to a retained workspace
 * file the product's file door cannot serve. Evaluation reads only the boolean. */
export const checkExecutionFailure = (recorded: RecordedCheck, reviewedId?: string): string | undefined => {
  const unavailable = unavailableCheck(recorded, reviewedId)
  const measured = unavailable?.summary.slice(0, 200).trim()
  if (unavailable) return `The trial recorded an unavailable check: ${unavailable.checkId}${measured ? ` — ${measured}` : ""}`
  const blocked = recorded.output.results.some(check => check.policy === "required" && check.status !== "passed" && check.status !== "skipped")
  return recorded.output.gate !== (blocked ? "blocked" : "passed") || recorded.step.status !== (blocked ? "error" : "completed")
    ? `The trial recorded an inconsistent ${recorded.step.stepId} check step: gate ${recorded.output.gate} with status ${recorded.step.status}` : undefined
}
export const checkExecutionFailed = (recorded: RecordedCheck, reviewedId?: string): boolean => checkExecutionFailure(recorded, reviewedId) !== undefined
/** Only the owned trial receipt uses this gate. Unrelated live events may skip. */
export const verifyTrialChecks = (configuration: Pick<Draft, "checks" | "steps">, result: JobResult): void => {
  // A review trial selects its core review step. Other event/manual steps and
  // disabled steps do not become extra requirements for this particular trial.
  const reviewed = result.job === "review" ? configuration.steps.filter(step => step.mode !== "off" &&
    step.id !== "checks" && result.results.some(value => value.stepId === step.id)).map(reviewCheck) : []
  const checks = [...configuration.checks, ...reviewed]
  const subjects = new Set(reviewed.map(check => check.id))
  const ai = checks.filter(check => check.kind === "ai")
  if (!ai.length) return
  if (checks.some(check => !check.id) || new Set(checks.map(check => check.id)).size !== checks.length) throw invalid("AI trial checks need unique configured IDs")
  const outputs = result.results.flatMap(step => {
    const recorded = recordedChecks(step, result.sourceRevision)
    const unavailable = (recorded ?? []).map(check => checkExecutionFailure(check)).find(reason => reason !== undefined)
    if (unavailable) throw invalid(unavailable)
    const final = recorded?.at(-1)
    return final?.phase === "candidate" && final.step.status === "completed" && final.output.gate === "passed" ? [final.output] : []
  })
  for (const check of ai) {
    const ran = outputs.some(output => {
      const matches = output.results.filter(value => value.checkId === check.id)
      if (matches.length !== 1) return false
      const value = matches[0]!, verdict = Schema.decodeUnknownOption(SemanticVerdict)(value.detail)
      if (value.policy !== check.policy || (value.status !== "passed" && (check.policy !== "report" || value.status !== "failed")) ||
          !value.executionId || !value.evidence.includes(`execution:${value.executionId}`) ||
          !value.evidence.includes(`source:${output.candidate}`) || !value.evidence.includes(`base:${output.base}`) || Option.isNone(verdict)) return false
      const observed = verdict.value
      return observed.examinedPaths.length > 0 && observed.examinedPaths.every(path => !check.paths.length || check.paths.some(pattern => matchesGlob(path, pattern))) &&
        (value.status === "passed" ? observed.verdict === "pass" && !observed.findings.length : observed.verdict === "fail" && observed.findings.length > 0)
    })
    // Only a required rule holds a trial and its activation. A report-only rule
    // informs, so a trial whose change touches nothing in its scope leaves it
    // unexercised and finishes; a review a review trial exists to prove is that
    // trial's own subject, and a report-only rule that did record a result
    // still has to have recorded a real one.
    if (!ran && (check.policy === "required" || subjects.has(check.id) ||
        outputs.some(output => output.results.some(value => value.checkId === check.id && value.status !== "skipped")))) {
      throw invalid(`AI check ${check.name || check.id} has no completed in-scope trial result; test a change that exercises it`)
    }
  }
}
export const CaptureChecks = Action.make("repository/capture-checks", { payload: { work: Work }, success: CheckPlan, error: CodingError, nondeterministic: true })
export const ExecuteCommand = Action.make("repository/execute-command-check", { payload: { plan: CheckPlan, check: Check }, success: CheckResult, error: CodingError, nondeterministic: true })
export const RetainSemantic = Action.make("repository/retain-semantic-check", {
  payload: { plan: CheckPlan, check: Check, comparison: Comparison, verdict: SemanticVerdict, decidedBy: Schema.optionalKey(DecidedBy) },
  success: CheckResult, error: CodingError
})
/** Jev judges the maintainer's rule one changed hunk at a time. An answer
 * between the two thresholds is Jev deciding it is unsure, and comes back
 * `uncertain`; an evaluation it could not make at all — a missing gateway, a
 * refused call, a timeout, a malformed answer — fails this action with the
 * evaluator's typed error. There is no second model behind it. */
export const JevSemanticCheck = Action.make("repository/jev-semantic-check", {
  payload: { check: Check, comparison: Comparison }, success: SemanticVerdict, error: CodingError, nondeterministic: true
})
export const CommandCheck = Flow.make("repository/CommandCheck", { payload: ExecuteCommand.payloadSchema, success: CheckResult, error: CodingError,
  body: input => ExecuteCommand.call(input) })
/** Jev decides, and its verdict is the check's verdict — `uncertain`
 * included, which `assessSemantic` records as an errored check rather than a
 * pass. When Jev cannot answer, the flow fails with its typed error and
 * `RunChecks` retains that as the check's error row. Nothing falls back to a
 * frontier seat. */
export const AICheck = Flow.make("repository/AICheck", {
  payload: { plan: CheckPlan, check: Check, comparison: Comparison, context: CheckContext, baseContext: Schema.optionalKey(CheckContext) }, success: CheckResult, error: CodingError,
  body: input => JevSemanticCheck.call({ check: input.check, comparison: input.comparison }).pipe(
    Node.bindPlanned(verdict => RetainSemantic.call({ ...input, verdict, decidedBy: "jev" as const })))
})
export const RunChecks = Action.make("repository/run-checks", { payload: CheckPlan, success: StepResult, error: CodingError })
export const CheckStep = Flow.make("repository/CheckStep", { payload: { work: Work }, success: StepResult, error: CodingError,
  body: input => CaptureChecks.call(input).pipe(Node.bindPlanned(plan => RunChecks.call(plan))) })

/** A nonempty diff with unsupported path encoding cannot become an empty scope. */
export const diffPaths = (diff: string): Array<string> => {
  const paths = new Set<string>()
  for (const line of diff.split("\n")) {
    if (!line.startsWith("diff --git ")) continue
    const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line)
    if (!match) throw invalid("This diff uses a path encoding that requires maintainer review")
    for (const path of [match[1]!, match[2]!]) {
      if (normalizePath(path) !== path) throw invalid("The comparison contains an unsafe source path")
      paths.add(path)
    }
  }
  if (diff.trim() && !paths.size) throw invalid("The native comparison did not identify the files it changed")
  return [...paths].sort()
}
const matched = (check: typeof Check.Type, path: string) => !check.paths.length || check.paths.some(pattern => matchesGlob(path, pattern))
/** A job's own retained configuration is written into the repository by
 * `writeCandidate` and refused by the context reader, so a change that touches
 * it is recorded evidence and never reviewable scope a semantic check is asked
 * to cover: supplying it would hand the checker the job's own configuration,
 * and requiring it makes every such review error before the checker runs. */
const reviewable = (check: typeof Check.Type, path: string) => check.kind !== "ai" || !privatePath(path)
export const selectedComparison = (comparison: typeof Comparison.Type, check: typeof Check.Type): typeof Comparison.Type => {
  if (check.paths.some(pattern => pattern.startsWith("/") || pattern.split("/").includes(".."))) throw invalid("Check paths must stay inside the repository")
  const paths = comparison.paths.filter(path => matched(check, path) && reviewable(check, path))
  return { ...comparison, paths, files: comparison.files.filter(file => paths.includes(file.path)), changes: comparison.changes.filter(file => paths.includes(file.path)) }
}
export const refusedComparison = (comparison: typeof Comparison.Type, check: typeof Check.Type): Array<string> =>
  comparison.paths.filter(path => matched(check, path) && !reviewable(check, path))

/** Full-file proposals alter only the private exported tree and name their exact preimages. */
export const materializeProposal = (options: ImmutableSourceOptions, root: string, proposal: typeof Proposal.Type) => Effect.gen(function* () {
  const path = yield* Path.Path, fs = options.fs
  const changes: Array<typeof Comparison.Type["changes"][number]> = []
  if (new Set(proposal.map(file => file.path)).size !== proposal.length) return yield* invalid("A proposal names the same path twice")
  let bytes = 0
  for (const file of proposal) {
    if (normalizePath(file.path) !== file.path || file.path === ".jj" || file.path.startsWith(".jj/") || file.path === ".git" || file.path.startsWith(".git/")) return yield* invalid("A proposal cannot alter repository metadata or escape its source tree")
    const target = yield* admitSourcePath(options, root, file.path)
    const exists = yield* fs.exists(target)
    let before: string | null = null
    if (exists) {
      const resolved = yield* fs.realPath(target)
      if (!contained(root, resolved, path) || resolved !== target) return yield* invalid("A proposal cannot write through a symbolic link or escape its source")
      const stat = yield* fs.stat(target)
      if (stat.type !== "File" || stat.size > 512_000n) return yield* invalid("A proposal needs a bounded regular source file")
      before = yield* fs.readFileString(target)
    }
    if ((before === null ? null : Digest.digest(before)) !== file.beforeDigest) return yield* invalid("The proposal preimage differs from the captured source")
    bytes += new TextEncoder().encode((before ?? "") + (file.content ?? "")).length
    if (bytes > 256_000) return yield* invalid("The proposal exceeds the bounded source review size")
    if (file.content === null) {
      if (!exists) return yield* invalid("A proposal cannot delete a missing file")
      yield* fs.remove(target)
    } else {
      yield* fs.makeDirectory(path.dirname(target), { recursive: true })
      if (!contained(root, yield* fs.realPath(path.dirname(target)), path)) return yield* invalid("The proposal directory escapes its source tree")
      yield* fs.writeFileString(target, file.content)
    }
    changes.push({ path: file.path, before, after: file.content })
  }
  return changes
}).pipe(Effect.mapError(error => error instanceof CodingError ? error : invalid("The proposal could not be materialized on its exact source")))

/** A repository configures checks in workflow files, manifests and task
 * scripts. The step probes those locations on its own immutable source, so its
 * report never borrows the paths a triggering event happened to mention. */
export const checkLocations = [".github/workflows", "package.json", "Makefile", "tox.ini", "pyproject.toml", "Cargo.toml", "go.mod"]
export const probeCheckLocations = (options: ImmutableSourceOptions, root: string) => Effect.gen(function* () {
  const path = yield* Path.Path, fs = options.fs
  const searched: Array<typeof CheckSource.Type> = []
  for (const name of checkLocations) {
    const resolved = yield* fs.realPath(path.join(root, name)).pipe(Effect.orElseSucceed(() => ""))
    searched.push({ path: name, present: resolved !== "" && contained(root, resolved, path) })
  }
  return searched
})

export const captureChecks = (options: ImmutableSourceOptions, work: typeof Work.Type) => Effect.gen(function* () {
  if (!work.checks.length) return yield* invalid("Configure at least one repository check before running CI")
  if (Date.now() >= work.deadlineAt) return yield* invalid("The configured check deadline expired")
  const payload = object(work.event.payload), pr = object(payload.pull_request)
  const candidate = object(pr.head).sha ?? payload.head_commit_id ?? payload.candidateCommitId
  const base = object(pr.base).sha ?? payload.base_commit_id ?? payload.baseCommitId
  const isPR = work.event.type === "pull_request" || Object.keys(pr).length > 0
  if (isPR && (typeof candidate !== "string" || typeof base !== "string")) return yield* invalid("A PR check requires the actual immutable base and candidate")
  if (candidate !== undefined && candidate !== work.evidence.source.commitId) return yield* invalid("The workspace source is not the event's candidate revision")
  const proposal = work.proposal ?? []
  let comparisonBase = proposal.length ? work.evidence.source.commitId : typeof base === "string" ? base : work.evidence.source.parentCommitIds[0]
  if (!comparisonBase || !/^[0-9a-f]{40}$/.test(comparisonBase)) return yield* invalid("The check needs an immutable comparison base")
  if (isPR && !proposal.length) {
    const mergeBase = yield* runSourceProcess(options, ["jj", "log", "--ignore-working-copy", "--no-graph", "-r",
      `heads(::commit_id("${comparisonBase}") & ::commit_id("${work.evidence.source.commitId}"))`, "-T", "commit_id"], options.repositoryPath, Math.min(30_000, work.deadlineAt - Date.now()))
    if (mergeBase.exitCode !== 0 || mergeBase.stdout.truncated || !/^[0-9a-f]{40}$/.test(mergeBase.stdout.text.trim())) return yield* invalid("The PR has no single captured merge base")
    comparisonBase = mergeBase.stdout.text.trim()
  }
  const semantic = work.checks.filter(check => check.kind === "ai")
  const entireDiff = proposal.length || !semantic.length ? "" : yield* (yield* Jj.Jj).diff(comparisonBase, work.evidence.source.commitId)
  const paths = proposal.length ? proposal.map(file => file.path) : yield* Effect.try({ try: () => diffPaths(entireDiff), catch: error => error instanceof CodingError ? error : invalid("Invalid comparison paths") })
  const selected = new Set<string>()
  for (const check of semantic) {
    const scoped = yield* Effect.try({ try: () => selectedComparison({ base: comparisonBase, candidate: work.evidence.source.commitId, diff: "", paths, files: [], changes: [] }, check),
      catch: error => error instanceof CodingError ? error : invalid("Invalid configured scope") })
    for (const name of scoped.paths) selected.add(name)
  }
  // A lockfile outside the AI rule's scope must not prevent ordinary command
  // checks. Complete diff metadata determines scope before content is bounded.
  const diff = entireDiff.split(/(?=^diff --git )/m).filter(part => part.trim() && diffPaths(part).some(path => selected.has(path))).join("")
  if (new TextEncoder().encode(diff).length > 256_000) return yield* invalid("The selected comparison is too large for a complete semantic check")
  return yield* withImmutableSource(options, work.evidence.source, (_tree, root) => Effect.gen(function* () {
    const path = yield* Path.Path, fs = options.fs
    const changes = proposal.length ? yield* materializeProposal(options, root, proposal) : []
    const files: Array<typeof Source.Type> = [], deleted = new Set<string>()
    let bytes = 0
    for (const name of selected) {
      const target = path.join(root, name)
      if (!(yield* fs.exists(target))) { deleted.add(name); continue }
      if (!contained(root, yield* fs.realPath(target), path)) return yield* invalid("Changed source escapes the immutable tree")
      const stat = yield* fs.stat(target)
      if (stat.type !== "File" || stat.size > 32_768n) return yield* invalid("A changed file cannot be completely reviewed within the check source bound")
      const text = yield* fs.readFileString(target)
      bytes += new TextEncoder().encode(text).length
      if (text.includes("\u0000") || bytes > 128_000) return yield* invalid("Changed source is binary or exceeds the complete review bound")
      files.push({ path: name, text, digest: Digest.digest(text), truncated: false })
    }
    const comparison = { base: comparisonBase, candidate: proposal.length
      ? `${work.evidence.source.commitId}+${Digest.digest(Digest.canonical(proposal))}` : work.evidence.source.commitId, diff, paths, files, changes }
    // A rule can explicitly name a removed file outside its changed-path
    // scope. Only actual diff/proposal paths may use historical rule evidence.
    for (const name of new Set(semantic.flatMap(check => rulePaths(check.rule)))) {
      if (paths.includes(name) && !(yield* fs.exists(path.join(root, name)))) deleted.add(name)
    }
    const contexts = yield* Effect.forEach(semantic, check => captureCheckContext(options, root, {
      source: comparison.candidate, check, paths: selectedComparison(comparison, check).paths.filter(name => !deleted.has(name)),
      ruleInputs: rulePaths(check.rule).filter(name => !deleted.has(name)), conventionPaths: selectedComparison(comparison, check).paths,
      refusedPaths: refusedComparison(comparison, check), deadlineAt: work.deadlineAt
    }))
    const baseChecks = semantic.filter(check => {
      const scoped = selectedComparison(comparison, check).paths
      return scoped.length && (scoped.some(name => deleted.has(name)) || rulePaths(check.rule).some(name => deleted.has(name)))
    })
    const baseContexts = baseChecks.length ? yield* withCapturedCommit(options, comparison.base, work.evidence.source.operationId, baseRoot =>
      Effect.forEach(baseChecks, check => captureCheckContext(options, baseRoot, {
        source: comparison.base, check, paths: selectedComparison(comparison, check).paths.filter(name => deleted.has(name)),
        ruleInputs: rulePaths(check.rule).filter(name => deleted.has(name)), deadlineAt: work.deadlineAt
      }))) : []
    // Real committed deletions need the same complete preimage evidence as
    // materialized proposals. An absent/refused historical file is not a deletion proof.
    for (const name of selected) if (deleted.has(name)) {
      const before = baseContexts.flatMap(context => context.files).find(file => file.path === name)
      if (!before || before.truncated || Digest.digest(before.text) !== before.digest) return yield* invalid("A deleted source has no complete captured base preimage")
      const proposed = changes.find(change => change.path === name)
      if (proposed && (proposed.after !== null || proposed.before !== before.text)) return yield* invalid("The deleted proposal disagrees with its captured base")
      if (!proposed) changes.push({ path: name, before: before.text, after: null })
    }
    return { work, comparison, contexts, baseContexts, searched: yield* probeCheckLocations(options, root) }
  }))
}).pipe(Effect.mapError(error => error instanceof CodingError ? error : invalid("The check comparison could not be captured")))

export const executeCommand = (options: ImmutableSourceOptions, plan: typeof CheckPlan.Type, check: typeof Check.Type, executionId: string) => Effect.gen(function* () {
  const remaining = plan.work.deadlineAt - Date.now()
  if (!check.rule.trim() || remaining <= 0) return yield* invalid("The configured command or its time budget is missing")
  return yield* withImmutableSource(options, plan.work.evidence.source, (_tree, root) => Effect.gen(function* () {
    yield* materializeProposal(options, root, plan.work.proposal ?? [])
    const measured = yield* runSourceProcess(options, ["/bin/sh", "-eu", "-c", check.rule], root, Math.min(remaining, 600_000))
    return { checkId: check.id, policy: check.policy, executionId,
      status: measured.exitCode === 0 ? "passed" as const : measured.exitCode === 126 || measured.exitCode === 127 ? "error" as const : "failed" as const,
      summary: `Exit ${measured.exitCode}`, evidence: [`execution:${executionId}`, `source:${plan.comparison.candidate}`],
      detail: json({ base: plan.comparison.base, candidate: plan.comparison.candidate, command: check.rule, exitCode: measured.exitCode,
        stdout: measured.stdout.text, stderr: measured.stderr.text, truncated: measured.stdout.truncated || measured.stderr.truncated }) }
  }))
}).pipe(Effect.mapError(error => error instanceof CodingError ? error : new CodingError({ code: "execution", message: "The configured check could not execute" })))

/** Candidate and historical reads each prove their own source; helpers never
 * substitute across trees. Only verified deletion preimages use old line numbers. */
const comparisonContextFailure = (comparison: typeof Comparison.Type, checkId: string, context: CheckContext | undefined, baseContext?: CheckContext): string | undefined => {
  if (!context) return "The AI check has no captured supporting context"
  const deleted = comparison.paths.filter(path => comparison.changes.some(change => change.path === path && change.after === null && change.before !== null) && !comparison.files.some(file => file.path === path))
  const incomplete = contextFailure(context, comparison.candidate, checkId, comparison.paths.filter(path => !deleted.includes(path)))
  if (incomplete) return incomplete
  if (deleted.length && !baseContext) return "Deleted source has no captured base context"
  if (baseContext) {
    const missing = contextFailure(baseContext, comparison.base, checkId, deleted)
    if (missing) return missing
    if (deleted.some(path => baseContext.files.find(file => file.path === path)?.text !== comparison.changes.find(change => change.path === path)?.before)) return "Deleted source differs from its captured base preimage"
  }
  return undefined
}
export const assessSemantic = (comparison: typeof Comparison.Type, verdict: typeof SemanticVerdict.Type, context?: CheckContext, baseContext?: CheckContext) => {
  const incomplete = context === undefined && baseContext === undefined ? undefined : comparisonContextFailure(comparison, context?.checkId ?? baseContext!.checkId, context, baseContext)
  if (incomplete) return { status: "error" as const, summary: incomplete }
  const examined = new Set(verdict.examinedPaths)
  if (verdict.verdict === "uncertain" || comparison.paths.some(path => !examined.has(path)) || verdict.examinedPaths.some(path => !comparison.paths.includes(path))) return { status: "error" as const, summary: inconclusiveCheck }
  if ((verdict.verdict === "pass" && verdict.findings.length) || (verdict.verdict === "fail" && !verdict.findings.length)) return { status: "error" as const, summary: "The AI verdict contradicts its recorded findings" }
  for (const finding of verdict.findings) {
    const file = comparison.files.find(file => file.path === finding.path)
    const deleted = comparison.changes.find(file => file.path === finding.path && file.after === null)
    if (!comparison.paths.includes(finding.path) || (!file && !deleted) || finding.line > (file?.text ?? deleted?.before ?? "").split("\n").length) return { status: "error" as const, summary: "The AI check cited source outside its captured evidence" }
  }
  return { status: verdict.verdict === "pass" ? "passed" as const : "failed" as const, summary: verdict.summary }
}

/** A configured check that never ran is not a measured pass, so a run that
 * measured nothing says so and names the locations this step probed. */
export const checksSummary = (plan: typeof CheckPlan.Type, results: ReadonlyArray<typeof CheckResult.Type>): string => {
  const blocking = results.filter(result => result.policy === "required" && (result.status === "failed" || result.status === "error"))
  if (blocking.length) return `${blocking.length} required checks blocked`
  const ran = results.filter(result => result.status !== "skipped")
  const skipped = results.filter(result => result.status === "skipped")
  if (ran.length) return `${ran.filter(result => result.status === "passed").length} of ${ran.length} checks passed${skipped.length ? `, ${skipped.length} skipped` : ""}`
  const kinds = [...new Set(skipped.flatMap(result => plan.work.checks.filter(check => check.id === result.checkId).map(check => check.kind)))].sort()
  const searched = plan.searched ?? []
  const found = searched.filter(source => source.present).map(source => source.path)
  return `No checks ran${skipped.length ? ` (${skipped.length} configured ${kinds.length ? `${kinds.join("/")} ` : ""}check${skipped.length === 1 ? "" : "s"} skipped)` : ""}.${searched.length
    ? ` Searched for workflow files, manifests and scripts in ${searched.map(source => source.path).join(", ")}: ${found.length ? `found ${found.join(", ")}` : "none present"}.` : ""}`
}

/** Every composition must supply its judge. Omitting it is a type error;
 * an offline fixture supplies an evidence-based script, never a gateway key. */
export const checkLayers = (options: ImmutableSourceOptions & { readonly evaluator: Layer.Layer<Evaluator.Evaluator> }) => Layer.mergeAll(
  Interpreter.layer(CheckStep), Interpreter.layer(CommandCheck), Interpreter.layer(AICheck),
  JevSemanticCheck.toLayer(({ check, comparison }) => jevSemanticCheck(comparison, check)).pipe(
    Layer.provide(options.evaluator)),
  CaptureChecks.toLayer(({ work }) => captureChecks(options, work)),
  ExecuteCommand.toLayer(({ plan, check }) => currentExecutionId.pipe(Effect.flatMap(id => executeCommand(options, plan, check, id)))),
  RetainSemantic.toLayer(({ plan, check, comparison, verdict, decidedBy }) => Effect.gen(function* () {
    const executionId = yield* currentExecutionId
    const context = plan.contexts.find(value => value.checkId === check.id), baseContext = plan.baseContexts?.find(value => value.checkId === check.id)
    if (comparisonContextFailure(comparison, check.id, context, baseContext)) return yield* invalid("The semantic check has no complete supporting context")
    return { checkId: check.id, policy: check.policy, ...assessSemantic(comparison, verdict, context, baseContext), executionId,
      evidence: [`execution:${executionId}`, `source:${plan.comparison.candidate}`, `base:${plan.comparison.base}`],
      detail: json({ ...verdict, ...(decidedBy === undefined ? {} : { decidedBy }), context, ...(baseContext ? { baseContext } : {}) }) }
  })),
  RunChecks.toLayer(plan => Effect.gen(function* () {
    const runtime = yield* FlowRuntime.FlowRuntime, executionId = yield* currentExecutionId
    const results: Array<typeof CheckResult.Type> = []
    const ordered = [...plan.work.checks].sort((a, b) => Number(a.kind === "ai") - Number(b.kind === "ai"))
    for (const check of ordered) {
      const id = Digest.digest(Digest.canonical(["repository/check/v1", executionId, plan.comparison.candidate, check]))
      const base = { checkId: check.id, policy: check.policy, executionId: id, evidence: [] as Array<string>, detail: null }
      if (Date.now() >= plan.work.deadlineAt) { results.push({ ...base, status: "error", summary: "The configured check deadline expired" }); continue }
      if (check.kind === "ai" && results.some(result => result.policy === "required" && (result.status === "error" || result.status === "failed"))) {
        results.push({ ...base, status: "skipped", summary: "An earlier required check blocked this AI check" }); continue
      }
      const comparison = yield* Effect.try({ try: () => selectedComparison(plan.comparison, check), catch: error => error instanceof CodingError ? error : invalid("Invalid configured paths") })
      if (check.kind === "ai" && !comparison.paths.length) { results.push({ ...base, status: "skipped", summary: "No changed paths match this check", evidence: [`source:${plan.comparison.candidate}`] }); continue }
      const context = plan.contexts.find(value => value.checkId === check.id), baseContext = plan.baseContexts?.find(value => value.checkId === check.id)
      if (check.kind === "ai") {
        const incomplete = comparisonContextFailure(comparison, check.id, context, baseContext)
        if (incomplete) {
          results.push({ ...base, status: "error", summary: incomplete, detail: json({ context: context ?? null, ...(baseContext ? { baseContext } : {}) }),
            evidence: [`source:${plan.comparison.candidate}`, `base:${plan.comparison.base}`] }); continue
        }
      }
      const executed = yield* (check.kind === "command"
        ? runtime.execute(CommandCheck, { executionId: id, payload: { plan, check } })
        : runtime.execute(AICheck, { executionId: id, payload: { plan, check, comparison, context: context!, ...(baseContext ? { baseContext } : {}) } })).pipe(
          Effect.timeoutOrElse({ duration: Math.max(1, plan.work.deadlineAt - Date.now()), orElse: () => Effect.fail(invalid("The check timed out")) }), Effect.result)
      // A check whose flow failed is an errored row, never a pass, and it
      // carries the typed failure it stands for: an unreachable or refused
      // evaluator is named in `detail` the way a command check that could not
      // run names its exit code there.
      results.push(executed._tag === "Success" ? executed.success
        : { ...base, status: "error", summary: "The check could not finish; inspect its execution",
          evidence: [`execution:${id}`], detail: retainedStepError(executed.failure) })
    }
    const required = results.filter(result => result.policy === "required")
    const blocking = required.filter(result => result.status === "failed" || result.status === "error")
    return { stepId: plan.work.step.id, executionId, status: blocking.length ? "error" as const : "completed" as const,
      summary: checksSummary(plan, results),
      evidence: [...new Set(results.flatMap(result => result.evidence))], output: json({ base: plan.comparison.base, candidate: plan.comparison.candidate,
        gate: blocking.length ? "blocked" : "passed", results } satisfies typeof CheckOutput.Type) }
  }))
)
