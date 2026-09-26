import { NodeServices } from "@effect/platform-node"
import * as Digest from "@smthrs/core/Digest"
import { Action, FlowRuntime } from "@smthrs/flow"
import { Effect, FileSystem, Layer, Schema } from "effect"
import assert from "node:assert/strict"
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { test, type TestContext } from "node:test"
import * as Jj from "../../packages/smithers/flows/jj/src/Jj.ts"
import type { ImmutableSourceOptions } from "../coding/immutable-source.ts"
import { CodingError } from "../coding/schema.ts"
import {
  CaptureChecks,
  checkLayers,
  type CheckOutput,
  RetainSemantic,
  reviewCheck,
  RunChecks,
  type SemanticVerdict,
  verifyTrialChecks
} from "../repository/checks.ts"
import { assessScore } from "../repository/evaluation.ts"
import type { Work } from "../repository/jobs.ts"
import type { Check, EvalCase, JobResult, Step, StepResult } from "../repository/schema.ts"
import { makeHostJudge } from "./fixtures/scripted-judge.ts"

const base = "fb8c7b08f0d0feb5887cabbec5650e28dae2e6c1", candidate = "989b1f1c0c4c153d3917d89de00f2caee95292d0"
const treeId = "2c9d4b3a17f6e5d0c8b7a69584736251f0e1d2c3"
const key = "899f48bc0a28af10ca78ffa4f5fdc13e87c8e29107ab907cfb122512f0bf2933"
const readme = "# Canary sandbox\n\nOpen this repository in Smithers.\nReview changes in the cloud before landing.\n"
const diff =
  `diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1,2 +1,4 @@\n # Canary sandbox\n \n+Open this repository in Smithers.\n+Review changes in the cloud before landing.\n`
const refused = "The production flow did not complete its evaluated work"
/** The reviewed configuration `writeCandidate` writes into the repository and
 * snapshots (`flows/repository/setup.ts:151-174`), at the production digest the
 * receipt records as its own evidence. Every comparison a review of this
 * repository computes carries whichever of these the snapshots added. */
const retained =
  ".smithers/repository-jobs/review/b3d570a73c2ad2f3ab7c003fe980a9cf02c1df62d553f95ba732459da2ecb577/candidate.json"
const retainedText =
  `{\n  "repo": "codeplanesmithers/canary-sandbox",\n  "job": "review",\n  "draft": "RETAINED_CONFIGURATION"\n}\n`
const hunk = (path: string) =>
  `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,1 +1,2 @@\n export const kept = 1\n+export const added = 2\n`
/** More changed sources than the context capture's own file budget. */
const modules = Object.fromEntries(
  Array.from(
    { length: 26 },
    (
      _,
      index
    ) => [`src/module${String(index + 1).padStart(2, "0")}.ts`, `export const kept = 1\nexport const added = 2\n`]
  )
)

/** A two-commit repository whose candidate tree holds exactly these files. The
 * exporter and the merge-base query stand in for the host's own binaries. */
const fixture = async (t: TestContext, tree: Record<string, string> = { "README.md": readme }) => {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), "review-eval-")))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const root = join(temporary, "repo"), bin = join(temporary, "bin")
  await mkdir(root, { recursive: true })
  await mkdir(bin, { recursive: true })
  for (const [path, text] of Object.entries(tree)) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), text)
  }
  const exporter = join(bin, "export")
  const emit = Object.entries(tree).map(([path, text]) =>
    `mkdir -p "$out/${dirname(path)}"\ncat > "$out/${path}" <<'SOURCE'\n${text}SOURCE\n`
  ).join("")
  await writeFile(
    exporter,
    `#!/bin/sh\nout="$3/tree"\nmkdir -p "$out"\n${emit}printf '{"commitId":"%s","changeId":"reviewcandidate","treeId":"${treeId}","path":"%s","fileCount":${
      Object.keys(tree).length
    }}\\n' "$2" "$out"\n`
  )
  await writeFile(join(bin, "jj"), `#!/bin/sh\nprintf '${base}\\n'\n`)
  await chmod(exporter, 0o755)
  await chmod(join(bin, "jj"), 0o755)
  const fs = await Effect.runPromise(FileSystem.FileSystem.pipe(Effect.provide(NodeServices.layer)))
  return {
    options: { repositoryPath: root, fs, exporterPath: exporter, environment: { PATH: `${bin}:/usr/bin:/bin` } }
  }
}

/** Both steps and both prompts are the reviewed draft of the production
 * registration in `.artifacts/mvp-canary-walk-20260917/B-23-state-review-evals.json`. */
const step: typeof Step.Type = {
  id: "review",
  name: "Review changes",
  mode: "approved",
  prompt:
    "Review the actual proposed revision and compare with the correct base. Report concrete findings with code evidence. Do not invent findings for a clean change. Update existing feedback after new commits."
}
const followup: typeof Step.Type = {
  id: "followup",
  name: "Review new commits",
  mode: "approved",
  prompt: "Review material updates to the same PR. Recheck prior findings and avoid duplicate comments."
}
/** The exact Work RunSteps builds for a review step: the reviewed draft configures
 * no checks, and an evaluation inherits no CI policy, so the step's own review
 * check is the only one it runs. The event is the frozen case's own event. */
const reviewWork: typeof Work.Type = {
  repo: "example/repo",
  job: "review",
  step,
  checks: [reviewCheck(step)],
  landing: "ask",
  replies: "draft",
  executionMode: "evaluation",
  deadlineAt: Date.now() + 120_000,
  event: {
    source: "github",
    type: "pull_request",
    action: "opened",
    deliveryKey: key,
    payload: {
      pull_request: {
        title: "Canary: read-only repository summary",
        body:
          "Durable production fixture. The Multi concierge should mention this open pull request in its repository update.",
        base: { sha: base },
        head: { sha: candidate }
      }
    }
  },
  evidence: {
    repo: "example/repo",
    source: {
      changeId: "reviewcandidate",
      commitId: candidate,
      treeId,
      operationId: "operation",
      parentCommitIds: [base]
    },
    files: [],
    missing: [],
    history: [],
    records: [],
    sources: []
  }
}
const workFor = (value: typeof Step.Type, configured: readonly (typeof Check.Type)[] = []): typeof Work.Type => ({
  ...reviewWork,
  step: value,
  checks: [reviewCheck(value), ...configured]
})

/** The production check step runs for real; only the checker's verdict is
 * scripted, and null stands for a checker execution that never finished.
 * `expired` is a durable run whose budget ran out between its two actions. */
const runReviewStep = (
  options: ImmutableSourceOptions,
  verdict: typeof SemanticVerdict.Type | null,
  extra: { work?: typeof Work.Type; diff?: string; expired?: boolean } = {}
) => {
  const work = extra.work ?? reviewWork
  const handlers = new Map<string, (payload: unknown) => { execute: Effect.Effect<unknown, unknown, never> }>()
  const runtime = {
    register: (
      declared: { _tag: string },
      action: (payload: unknown) => { execute: Effect.Effect<unknown, unknown, never> }
    ) => Effect.sync(() => handlers.set(declared._tag, action)),
    execute: (
      flow: { _tag: string },
      request: { executionId: string; payload: { plan: unknown; check: unknown; comparison: unknown } }
    ) => {
      if (flow._tag !== "repository/AICheck") return Effect.die(`unexpected child flow ${flow._tag}`)
      if (!verdict) {
        return Effect.fail(new CodingError({ code: "execution", message: "The checker execution was lost" }))
      }
      return handlers.get(RetainSemantic.name)!(
        Schema.decodeUnknownSync(RetainSemantic.payloadSchema)({
          plan: request.payload.plan,
          check: request.payload.check,
          comparison: request.payload.comparison,
          verdict
        })
      ).execute.pipe(Effect.provideService(FlowRuntime.FlowInstance, { executionId: request.executionId } as never))
    }
  }
  return Effect.gen(function*() {
    yield* Layer.build(
      checkLayers({ ...options, evaluator: makeHostJudge().layer }).pipe(
        Layer.provide([Layer.succeed(FlowRuntime.FlowRuntime, runtime as never), Action.layerImplementations])
      )
    )
    const captured = Schema.decodeUnknownSync(RunChecks.payloadSchema)(
      yield* handlers.get(CaptureChecks.name)!(Schema.decodeUnknownSync(CaptureChecks.payloadSchema)({ work })).execute
    )
    const plan = extra.expired ? { ...captured, work: { ...captured.work, deadlineAt: Date.now() - 1 } } : captured
    const step = (yield* handlers.get(RunChecks.name)!(plan).execute.pipe(
      Effect.provideService(FlowRuntime.FlowInstance, { executionId: `step-${work.step.id}` } as never)
    )) as typeof StepResult.Type
    return { step, plan: captured }
  }).pipe(
    Effect.scoped,
    Effect.provideService(FlowRuntime.FlowRuntime, runtime as never),
    Effect.provide([Jj.layerNoop({ diff: () => Effect.succeed(extra.diff ?? diff) }), NodeServices.layer])
  )
}
/** The evaluator's own evidence index over a recorded job (`evaluation.ts:19`). */
const references = (
  job: JobResult
): string[] => [...new Set(job.results.flatMap((result) => [`execution:${result.executionId}`, ...result.evidence]))]
const recorded = (step: typeof StepResult.Type) =>
  (step.output as typeof CheckOutput.Type).results
    .map((result) => ({ status: result.status, summary: result.summary, evidence: [...result.evidence] }))

const observed = (...results: readonly (typeof StepResult.Type)[]): JobResult => ({
  repo: "example/repo",
  job: "review",
  revision: 3,
  digest: "b".repeat(64),
  sourceRevision: candidate,
  eventKey: key,
  publicActions: [],
  results,
  status: results.some((result) => result.status === "error") ? "partial" : "completed"
})
/** The frozen production case, verbatim from the receipt named above: both of
 * its assertions, its event payload and its expected text. Only the redacted
 * delivery key is this fixture's own. */
const heldOut: typeof EvalCase.Type = {
  id: "review-open-canary-pr",
  name: "Review the open canary summary PR against its base",
  required: true,
  expected:
    "The review step runs on the open pull request 'Canary: read-only repository summary' and compares the head revision against the correct base. The repository is a documentation-only canary fixture whose README describes opening the repo in Smithers, requesting a small change via Chat, and reviewing changes in the cloud before landing. A correct run grounds every finding in the actual changed files: it reports concrete findings with code evidence if the diff introduces a problem, and explicitly reports no findings for a clean change rather than inventing issues. It must not modify files, and its summary identifies what was reviewed and the verdict reached.",
  input: JSON.stringify({
    event: reviewWork.event,
    sourceRevision: candidate,
    assertions: [{ path: "/results/0/stepId", equals: "review" }, { path: "/results/0/status", equals: "completed" }]
  })
}
const score = {
  verdict: "pass" as const,
  reason: "The review reports what the diff actually changes.",
  evidenceIds: [0]
}
const inconclusive: typeof SemanticVerdict.Type = {
  verdict: "uncertain",
  summary: "The supplied diff does not carry earlier commits to recheck.",
  examinedPaths: ["README.md"],
  findings: []
}
const clean: typeof SemanticVerdict.Type = {
  verdict: "pass",
  summary: "The change only updates documentation.",
  examinedPaths: ["README.md"],
  findings: []
}
const reported: typeof SemanticVerdict.Type = {
  verdict: "fail",
  summary: "The summary claims a feature the diff does not add.",
  examinedPaths: ["README.md"],
  findings: [{ path: "README.md", line: 3, message: "Unsupported claim" }]
}

test("the frozen production case is scored on the review's substance, whatever the review concluded", async (t) => {
  const f = await fixture(t)
  for (const verdict of [clean, reported, inconclusive]) {
    const { step: result } = await Effect.runPromise(runReviewStep(f.options, verdict))
    assert.equal(result.status, "completed", `a review that ran completes its step: ${verdict.verdict}`)
    assert.equal((result.output as typeof CheckOutput.Type).gate, "passed")
    const assessment = assessScore(heldOut, observed(result), score)
    assert.equal(assessment.status, "passed", assessment.observed)
    assert.equal(assessment.observed, score.reason)
    assert.equal(assessScore(heldOut, observed(result), { ...score, verdict: "fail" }).status, "failed")
  }
})

test("the frozen case passes whichever of the draft's two steps could not conclude", async (t) => {
  const f = await fixture(t)
  const { step: reviewed } = await Effect.runPromise(runReviewStep(f.options, inconclusive))
  const { step: second } = await Effect.runPromise(runReviewStep(f.options, clean, { work: workFor(followup) }))
  assert.equal(second.stepId, "followup")
  assert.equal(assessScore(heldOut, observed(reviewed, second), score).status, "passed")
  const { step: other } = await Effect.runPromise(runReviewStep(f.options, inconclusive, { work: workFor(followup) }))
  const { step: first } = await Effect.runPromise(runReviewStep(f.options, clean))
  assert.equal(assessScore(heldOut, observed(first, other), score).status, "passed")
})

test("a review trial that reports grounded findings verifies its own check", async (t) => {
  const f = await fixture(t)
  const { step: result } = await Effect.runPromise(runReviewStep(f.options, reported))
  assert.doesNotThrow(() => verifyTrialChecks({ checks: [], steps: [step, followup] }, observed(result)))
  const { step: lost } = await Effect.runPromise(runReviewStep(f.options, null))
  assert.throws(
    () => verifyTrialChecks({ checks: [], steps: [step, followup] }, observed(lost)),
    /The trial recorded an unavailable check: review-review — /
  )
})

test("a checker that contradicts its findings or cites source it never captured stays an execution failure", async (t) => {
  const f = await fixture(t)
  const { step: contradicted } = await Effect.runPromise(
    runReviewStep(f.options, { ...clean, findings: reported.findings })
  )
  const first = assessScore(heldOut, observed(contradicted), score)
  assert.equal(first.status, "error", first.observed)
  assert.equal(first.observed, `${refused}: step review completed — The AI verdict contradicts its recorded findings`)
  const { step: invented } = await Effect.runPromise(
    runReviewStep(f.options, {
      ...reported,
      findings: [{ path: "README.md", line: 9000, message: "Unsupported claim" }]
    })
  )
  const second = assessScore(heldOut, observed(invented), score)
  assert.equal(second.status, "error", second.observed)
  assert.equal(
    second.observed,
    `${refused}: step review completed — The AI check cited source outside its captured evidence`
  )
})

test("an inconclusive maintainer check is still an unavailable execution", async (t) => {
  const f = await fixture(t)
  const configured: typeof Check.Type = {
    id: "coverage",
    name: "Coverage",
    kind: "ai",
    rule: "Every documented claim is supported.",
    paths: [],
    policy: "required"
  }
  const { step: result } = await Effect.runPromise(
    runReviewStep(f.options, inconclusive, { work: workFor(step, [configured]) })
  )
  assert.equal(result.status, "error", "the maintainer's own required rule still blocks its gate")
  const assessment = assessScore(heldOut, observed(result), score)
  assert.equal(assessment.status, "error")
  assert.equal(
    assessment.observed,
    `${refused}: step review error — The AI check did not establish complete scope coverage`
  )
})

test("a review whose checker never finished still refuses, naming the step and why", async (t) => {
  const f = await fixture(t)
  const { step: result } = await Effect.runPromise(runReviewStep(f.options, null))
  const assessment = assessScore(heldOut, observed(result), score)
  assert.equal(assessment.status, "error")
  assert.equal(
    assessment.observed,
    `${refused}: step review completed — The check could not finish; inspect its execution`
  )
})

test("a review receipt that contradicts its gate or names another source stays an execution failure", async (t) => {
  const f = await fixture(t)
  const { step: result } = await Effect.runPromise(runReviewStep(f.options, inconclusive))
  const output = result.output as typeof CheckOutput.Type
  const contradicted = assessScore(
    heldOut,
    observed({ ...result, output: JSON.parse(JSON.stringify({ ...output, gate: "blocked" })) }),
    score
  )
  assert.equal(contradicted.status, "error", "a contradictory recorded gate is not a reviewed verdict")
  assert.ok(contradicted.observed.startsWith(`${refused}: step review completed`), contradicted.observed)
  const elsewhere = assessScore(heldOut, { ...observed(result), sourceRevision: "c".repeat(40) }, score)
  assert.equal(elsewhere.status, "error")
  assert.equal(
    elsewhere.observed,
    `${refused}: step review completed — The recorded check names another source` +
      ` (the case's pinned commit ${
        candidate.slice(0, 12)
      } was not held by this workspace; scored against cccccccccccc)`
  )
})

/** A changed source whose local import does not resolve is a gap in the
 * repository itself: the checker cannot establish compliance on source that is
 * not there, so this branch keeps refusing. */
const handler = "import './missing.ts'\nexport const kept = 1\nexport const added = 2\n"
const wide: typeof SemanticVerdict.Type = {
  verdict: "fail",
  summary: "Two modules duplicate the same constant.",
  examinedPaths: Object.keys(modules),
  findings: [{ path: "src/module01.ts", line: 2, message: "Duplicate constant" }]
}
/** The execution a review check earns once it actually runs (`checks.ts:351`). */
const checkExecution = (value: typeof Step.Type) =>
  Digest.digest(Digest.canonical(["repository/check/v1", `step-${value.id}`, candidate, reviewCheck(value)]))
const reachedChecker = [
  `execution:step-review`,
  `execution:${checkExecution(step)}`,
  `source:${candidate}`,
  `base:${base}`,
  `execution:step-followup`,
  `execution:${checkExecution(followup)}`
]

test("the production receipt's four evidence references are a check that never reached its checker", async (t) => {
  const f = await fixture(t, { "src/handler.ts": handler })
  const run = (work: typeof Work.Type) =>
    Effect.runPromise(runReviewStep(f.options, clean, { work, diff: hunk("src/handler.ts") }))
  const { step: first } = await run(reviewWork)
  const { step: next } = await run(workFor(followup))
  assert.deepEqual(recorded(first), [{
    status: "error",
    summary: "Supporting context src/missing.ts: unresolved",
    evidence: [`source:${candidate}`, `base:${base}`]
  }])
  assert.deepEqual(references(observed(first, next)), [
    "execution:step-review",
    `source:${candidate}`,
    `base:${base}`,
    "execution:step-followup"
  ])
  assert.equal(
    assessScore(heldOut, observed(first, next), score).observed,
    `${refused}: step review completed — Supporting context src/missing.ts: unresolved`
  )
})

test("a review of the configuration this product writes into the repository reaches its checker", async (t) => {
  const f = await fixture(t, { "README.md": readme, [retained]: retainedText })
  const changed = diff + hunk(retained)
  const run = (work: typeof Work.Type) => Effect.runPromise(runReviewStep(f.options, clean, { work, diff: changed }))
  const { step: first, plan } = await run(reviewWork)
  const { step: next } = await run(workFor(followup))
  assert.deepEqual(references(observed(first, next)), reachedChecker)
  assert.deepEqual(recorded(first).map(({ status, summary }) => ({ status, summary })), [{
    status: "passed",
    summary: clean.summary
  }])
  assert.equal(first.status, "completed")
  const assessment = assessScore(heldOut, observed(first, next), score)
  assert.equal(assessment.status, "passed", assessment.observed)
  assert.equal(assessment.observed, score.reason)
  assert(
    !JSON.stringify(plan.comparison).includes("RETAINED_CONFIGURATION"),
    "retained configuration is not reviewable source"
  )
  assert.deepEqual(
    [...plan.comparison.paths].sort(),
    [retained, "README.md"].sort(),
    "the comparison still records what the change touched"
  )
  assert.deepEqual(
    plan.contexts[0]!.reads.filter((read) => read.path === retained).map((read) => ({
      reason: read.reason,
      required: read.required,
      status: read.status
    })),
    [{ reason: "source", required: false, status: "refused" }],
    "the exclusion is recorded evidence, not a silent drop"
  )
})

test("a review of more changed sources than the context capture's own budget reaches its checker", async (t) => {
  const f = await fixture(t, modules)
  const changed = Object.keys(modules).map(hunk).join("")
  const run = (work: typeof Work.Type) => Effect.runPromise(runReviewStep(f.options, wide, { work, diff: changed }))
  const { step: first, plan } = await run(reviewWork)
  const { step: next } = await run(workFor(followup))
  assert.deepEqual(references(observed(first, next)), reachedChecker)
  assert.deepEqual(plan.contexts[0]!.reads.filter((read) => read.status === "limit").map((read) => read.path), [
    "src/module25.ts",
    "src/module26.ts"
  ], "the capture drops the sources past its file budget")
  assert.deepEqual(recorded(first).map(({ status, summary }) => ({ status, summary })), [{
    status: "failed",
    summary: wide.summary
  }])
  assert.equal(first.status, "completed")
  assert.equal(
    plan.comparison.files.length,
    Object.keys(modules).length,
    "the comparison still carries every changed source in full"
  )
  const assessment = assessScore(heldOut, observed(first, next), score)
  assert.equal(assessment.status, "passed", assessment.observed)
  assert.equal(assessment.observed, score.reason)
})

/** Every way a review step's check can end, and the eval status each earns. */
test("the gate table covers every terminal branch of a review check", async (t) => {
  const branches = [
    {
      name: "checker verdict",
      tree: { "README.md": readme },
      changed: diff,
      verdict: clean,
      check: { status: "passed", summary: clean.summary },
      status: "passed",
      observed: score.reason
    },
    {
      name: "scope",
      tree: { [retained]: retainedText },
      changed: hunk(retained),
      verdict: clean,
      check: { status: "skipped", summary: "No changed paths match this check" },
      status: "passed",
      observed: score.reason
    },
    {
      name: "context refused",
      tree: { "README.md": readme, [retained]: retainedText },
      changed: diff + hunk(retained),
      verdict: clean,
      check: { status: "passed", summary: clean.summary },
      status: "passed",
      observed: score.reason
    },
    {
      name: "context limit",
      tree: modules,
      changed: Object.keys(modules).map(hunk).join(""),
      verdict: wide,
      check: { status: "failed", summary: wide.summary },
      status: "passed",
      observed: score.reason
    },
    {
      name: "context missing",
      tree: { "src/handler.ts": handler },
      changed: hunk("src/handler.ts"),
      verdict: clean,
      check: { status: "error", summary: "Supporting context src/missing.ts: unresolved" },
      status: "error",
      observed: `${refused}: step review completed — Supporting context src/missing.ts: unresolved`
    },
    {
      name: "deadline",
      tree: { "README.md": readme },
      changed: diff,
      verdict: clean,
      expired: true,
      check: { status: "error", summary: "The configured check deadline expired" },
      status: "error",
      observed: `${refused}: step review completed — The configured check deadline expired`
    },
    {
      name: "lost execution",
      tree: { "README.md": readme },
      changed: diff,
      verdict: null,
      check: { status: "error", summary: "The check could not finish; inspect its execution" },
      status: "error",
      observed: `${refused}: step review completed — The check could not finish; inspect its execution`
    }
  ]
  for (const branch of branches) {
    const f = await fixture(t, branch.tree)
    const run = (work: typeof Work.Type) =>
      Effect.runPromise(
        runReviewStep(f.options, branch.verdict, {
          work,
          diff: branch.changed,
          ...(branch.expired ? { expired: true } : {})
        })
      )
    const { step: first } = await run(reviewWork)
    const { step: next } = await run(workFor(followup))
    assert.deepEqual(recorded(first).map(({ status, summary }) => ({ status, summary })), [branch.check], branch.name)
    assert.equal(first.status, "completed", `${branch.name}: a review reports, it does not block its own step`)
    const assessment = assessScore(heldOut, observed(first, next), score)
    assert.equal(assessment.status, branch.status, `${branch.name}: ${assessment.observed}`)
    assert.equal(assessment.observed, branch.observed, branch.name)
  }
})
