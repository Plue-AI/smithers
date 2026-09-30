import { NodeServices } from "@effect/platform-node"
import * as Digest from "@smthrs/core/Digest"
import { FlowEngine } from "@smthrs/engine"
import { Action, FlowRuntime } from "@smthrs/flow"
import * as Evaluator from "@smthrs/model/Evaluator"
import { Effect, FileSystem, Layer, ManagedRuntime, Result, Schema } from "effect"
import assert from "node:assert/strict"
import { test } from "node:test"
import * as Jj from "../../packages/smithers/flows/jj/src/Jj.ts"
import { CodingError } from "../coding/schema.ts"
import type { CheckContext } from "../repository/check-context.ts"
import * as Checks from "../repository/checks.ts"
import {
  AICheck,
  checkLayers,
  type CheckOutput,
  type CheckPlan,
  type CheckResult,
  type Comparison,
  inconclusiveCheck,
  RunChecks,
  verifyTrialChecks
} from "../repository/checks.ts"
import { batches, hunks, jevSemanticCheck, MAX_STATES, proposalHunks } from "../repository/jev-checks.ts"
import type { Work } from "../repository/jobs.ts"
import type { Check, Draft, JobResult, StepResult } from "../repository/schema.ts"

const base = "a".repeat(40), candidate = "b".repeat(40)
const lines = (count: number, prefix: string) =>
  Array.from({ length: count }, (_, index) => `const ${prefix}${index + 1} = ${index + 1}`).join("\n") + "\n"
const sourceA = lines(30, "a"), sourceB = lines(12, "b")

/** Two files, three hunks: one at the top of a.ts, one deeper in a.ts, one in b.ts. */
const diff = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,4 +1,5 @@
 const a1 = 1
+const added = 2
 const a2 = 2
 const a3 = 3
 const a4 = 4
@@ -20,3 +21,4 @@ context
 const a20 = 20
 const a21 = 21
+const twelfth = 12
 const a22 = 22
diff --git a/src/b.ts b/src/b.ts
index 3333333..4444444 100644
--- a/src/b.ts
+++ b/src/b.ts
@@ -7,2 +7,3 @@
 const b7 = 7
+const beta = 2
 const b8 = 8
`

const comparison: typeof Comparison.Type = {
  base,
  candidate,
  diff,
  paths: ["src/a.ts", "src/b.ts"],
  files: [{ path: "src/a.ts", text: sourceA, digest: Digest.digest(sourceA), truncated: false }, {
    path: "src/b.ts",
    text: sourceB,
    digest: Digest.digest(sourceB),
    truncated: false
  }],
  changes: [{ path: "src/a.ts", before: "old", after: sourceA }, { path: "src/b.ts", before: "old", after: sourceB }]
}

const rule = "Every exported constant carries a unit in its name"
const check: typeof Check.Type = { id: "units", name: "Units", kind: "ai", rule, paths: ["src/**"], policy: "required" }

const context: CheckContext = {
  checkId: check.id,
  source: candidate,
  files: comparison.files,
  reads: comparison.files.map((file) => ({
    path: file.path,
    from: file.path,
    reason: "source" as const,
    required: true,
    status: "read" as const,
    digest: file.digest
  }))
}

const work: typeof Work.Type = {
  repo: "example/repo",
  job: "ci",
  step: { id: "checks", name: "Checks", mode: "automatic", prompt: "Run configured checks" },
  checks: [check],
  landing: "ask",
  replies: "draft",
  executionMode: "live",
  deadlineAt: Date.now() + 120_000,
  event: {
    source: "github",
    type: "pull_request",
    action: "opened",
    deliveryKey: "event-1",
    payload: { pull_request: { base: { sha: base }, head: { sha: candidate } } }
  },
  evidence: {
    repo: "example/repo",
    source: {
      commitId: candidate,
      treeId: "c".repeat(40),
      changeId: "d".repeat(32),
      parentCommitIds: [base],
      operationId: "e".repeat(32)
    },
    files: [],
    missing: [],
    history: [],
    records: [],
    sources: []
  }
}
const plan: typeof CheckPlan.Type = { work, comparison, contexts: [context] }

test("hunk extraction reports every changed hunk and its first candidate line", () => {
  assert.deepEqual(hunks(comparison).map((hunk) => ({ path: hunk.path, line: hunk.line })), [
    { path: "src/a.ts", line: 2 },
    { path: "src/a.ts", line: 23 },
    { path: "src/b.ts", line: 8 }
  ])
  const [first, second, third] = hunks(comparison)
  assert.ok(first!.hunk.startsWith("@@ -1,4 +1,5 @@") && first!.hunk.includes("+const added = 2"))
  assert.ok(!first!.hunk.includes("twelfth"), "a hunk carries its own lines, not the next hunk's")
  assert.ok(second!.hunk.includes("+const twelfth = 12"))
  assert.ok(third!.hunk.startsWith("@@ -7,2 +7,3 @@") && !third!.hunk.includes("diff --git"))
  assert.deepEqual(hunks({ ...comparison, diff: "" }), [], "no diff is no hunk, never a silent clean sweep")
})

/** A proposal is checked before it is a commit, so `captureChecks` hands it no
 * diff at all. With the frontier seat gone, a proposal with no state would
 * make every produced change's required review uncertain. */
test("a proposal with no diff is judged from its exact changes", async () => {
  const proposal: typeof Comparison.Type = {
    base,
    candidate: `${base}+${"1".repeat(64)}`,
    diff: "",
    paths: ["src/a.ts"],
    files: [{
      path: "src/a.ts",
      text: "const width = 3\n",
      digest: Digest.digest("const width = 3\n"),
      truncated: false
    }],
    changes: [{ path: "src/a.ts", before: "const w = 3\n", after: "const width = 3\n" }]
  }
  assert.deepEqual(hunks(proposal), [], "the parser still reads only a real diff")
  assert.deepEqual(proposalHunks(proposal), [{
    path: "src/a.ts",
    line: 1,
    hunk: "@@ -1,1 +1,1 @@\n-const w = 3\n+const width = 3",
    complete: true
  }])
  const asked: Array<string> = []
  const verdict = await Effect.runPromise(
    jevSemanticCheck(proposal, check).pipe(
      Effect.provide(Evaluator.layerScripted((request) => {
        asked.push((request.state as { hunk: string }).hunk)
        return { violates: { probability: 0.95 } }
      }))
    )
  )
  assert.equal(asked.length, 1, "the proposed change is one state Jev can actually judge")
  assert.equal(verdict.verdict, "fail")
  assert.deepEqual([...verdict.findings], [{ path: "src/a.ts", line: 1, message: rule }])
})

test("a deleted proposal path is judged as the removal it is", () => {
  assert.deepEqual(
    proposalHunks({
      ...comparison,
      diff: "",
      changes: [{ path: "src/gone.ts", before: "const a = 1\n", after: null }]
    }),
    [{ path: "src/gone.ts", line: 1, hunk: "@@ -1,1 +0,0 @@\n-const a = 1", complete: true }]
  )
})

/** A replacement hunk of two files each within the 32 KiB source bound is
 * larger than one state, so Jev sees only its prefix. That prefix never clears
 * the path: the check is uncertain and its assessment errors. */
test("a clipped hunk leaves its path unexamined and never passes", async () => {
  const marker = "REGRESSION_AT_END"
  const before = lines(1000, "old"), after = `${lines(1050, "new")}const last = "${marker}"\n`
  assert.ok(before.length < 32_768 && after.length < 32_768 && before.length + after.length > 32_768)
  const judge = (proposal: typeof Comparison.Type) => {
    const asked: Array<string> = []
    return Effect.runPromise(
      jevSemanticCheck(proposal, check).pipe(
        Effect.provide(Evaluator.layerScripted((request) => {
          const { hunk } = request.state as { hunk: string }
          asked.push(hunk)
          return { violates: { probability: hunk.includes(marker) ? 0.95 : 0.02 } }
        }))
      )
    ).then((verdict) => ({ verdict, asked }))
  }
  const proposal = (text: string): typeof Comparison.Type => ({
    base,
    candidate: `${base}+${"1".repeat(64)}`,
    diff: "",
    paths: ["src/change.ts"],
    files: [{ path: "src/change.ts", text, digest: Digest.digest(text), truncated: false }],
    changes: [{ path: "src/change.ts", before, after: text }]
  })
  const large = proposal(after)
  assert.deepEqual(proposalHunks(large).map((hunk) => hunk.complete), [false])
  const clipped = await judge(large)
  assert.equal(clipped.asked.length, 1)
  assert.ok(!clipped.asked[0]!.includes(marker), "the judged prefix omits the final added line")
  assert.equal(clipped.verdict.verdict, "uncertain")
  assert.deepEqual([...clipped.verdict.examinedPaths], [], "a clipped prefix is not path coverage")
  assert.match(clipped.verdict.summary, /only part of the changes to src\/change\.ts/)
  const clippedContext = {
    ...context,
    source: large.candidate,
    files: large.files,
    reads: [{ ...context.reads[0]!, path: "src/change.ts", digest: large.files[0]!.digest }]
  }
  assert.deepEqual(Checks.assessSemantic(large, clipped.verdict, clippedContext), {
    status: "error",
    summary: inconclusiveCheck
  })

  // The same marker in a hunk Jev sees whole is a decisive failure.
  const short = proposal(`const last = "${marker}"\n`)
  assert.deepEqual(proposalHunks(short).map((hunk) => hunk.complete), [true])
  const whole = await judge(short)
  assert.equal(whole.verdict.verdict, "fail")
  assert.deepEqual([...whole.verdict.examinedPaths], ["src/change.ts"])
  const shortContext = {
    ...clippedContext,
    files: short.files,
    reads: [{ ...clippedContext.reads[0]!, digest: short.files[0]!.digest }]
  }
  assert.equal(Checks.assessSemantic(short, whole.verdict, shortContext).status, "failed")

  // A committed diff hunk clipped the same way, beside a complete clean hunk,
  // keeps the complete path examined and the clipped one out.
  const big = Array.from({ length: 2000 }, (_, index) => `+const added${index} = ${index}`).join("\n")
  const committed: typeof Comparison.Type = {
    ...comparison,
    diff:
      `${diff}diff --git a/src/c.ts b/src/c.ts\n--- a/src/c.ts\n+++ b/src/c.ts\n@@ -0,0 +1,2001 @@\n${big}\n+const tail = "${marker}"\n`,
    paths: [...comparison.paths, "src/c.ts"]
  }
  assert.deepEqual(hunks(committed).map((hunk) => [hunk.path, hunk.complete]), [
    ["src/a.ts", true],
    ["src/a.ts", true],
    ["src/b.ts", true],
    ["src/c.ts", false]
  ])
  const partial = await judge(committed)
  assert.equal(partial.verdict.verdict, "uncertain")
  assert.deepEqual([...partial.verdict.examinedPaths], ["src/a.ts", "src/b.ts"])
})

test("a batch carries at most 64 states and keeps every one", () => {
  const seventy = Array.from({ length: 70 }, (_, index) => index)
  assert.equal(MAX_STATES, 64)
  assert.deepEqual(batches(seventy).map((batch) => batch.length), [64, 6])
  assert.deepEqual(batches(seventy).flat(), seventy)
  assert.deepEqual(batches([]), [])
})

test("seventy hunks are judged in two batches and every one is answered", async () => {
  const body = Array.from(
    { length: 70 },
    (_, index) =>
      `@@ -${index * 10 + 1},1 +${index * 10 + 1},2 @@\n const a${index * 10 + 1} = 1\n+const added${index} = ${index}`
  ).join("\n")
  const many: typeof Comparison.Type = {
    ...comparison,
    paths: ["src/a.ts"],
    diff: `diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n${body}\n`
  }
  assert.equal(hunks(many).length, 70)
  assert.deepEqual(batches(hunks(many)).map((batch) => batch.length), [64, 6])
  let calls = 0
  const verdict = await Effect.runPromise(
    jevSemanticCheck(many, check).pipe(
      Effect.provide(Evaluator.layerScripted(() => {
        calls++
        return { violates: { probability: 0.01 } }
      }))
    )
  )
  assert.equal(calls, 70, "no hunk is dropped between the batches")
  assert.equal(verdict.verdict, "pass")
  assert.equal(verdict.summary, "Jev found no hunk violating Units")
  assert.deepEqual([...verdict.examinedPaths], ["src/a.ts"])
})

/** One AI check run end to end through the real `AICheck` flow with a scripted
 * Jev, so the branch under test is the deployed one. Jev is the only model in
 * the flow: there is no seat to script, and an evaluator that cannot answer
 * fails the flow rather than routing anywhere. */
const runCheck = async (
  probability: (path: string, line: number) => number | undefined,
  evaluator?: Layer.Layer<Evaluator.Evaluator>
) => {
  const asked: Array<string> = []
  const fs = await Effect.runPromise(FileSystem.FileSystem.pipe(Effect.provide(NodeServices.layer)))
  const scripted = evaluator ?? Evaluator.layerScripted((request) => {
    const state = request.state as { path: string; line: number; rule: string; hunk: string }
    assert.equal(state.rule, rule, "Jev is asked the maintainer's own rule")
    assert.ok(state.hunk.startsWith("@@"), "Jev is asked about one hunk")
    asked.push(`${state.path}:${state.line}`)
    const value = probability(state.path, state.line)
    if (value === undefined) {
      return Effect.fail(new Evaluator.EvaluatorError({ code: "refused", message: "scripted refusal" }))
    }
    return { violates: { probability: value } }
  })
  const runtime = ManagedRuntime.make(
    checkLayers({ repositoryPath: "/nonexistent", fs, evaluator: scripted }).pipe(
      Layer.provide(Jj.layerNoop({})),
      Layer.provideMerge(Action.layerImplementations),
      Layer.provideMerge(FlowEngine.layerMemory),
      Layer.provideMerge(NodeServices.layer)
    )
  )
  try {
    const outcome = await runtime.runPromise(
      AICheck.execute({ plan, check, comparison, context }, { executionId: "jev-check" }).pipe(Effect.result)
    )
    return { outcome, asked }
  } finally {
    await runtime.dispose()
  }
}
type Outcome = Result.Result<typeof CheckResult.Type, unknown>
const retained = (outcome: Outcome): typeof CheckResult.Type => {
  assert.ok(Result.isSuccess(outcome), `expected a retained check row, got ${JSON.stringify(outcome)}`)
  return outcome.success
}
const refusal = (outcome: Outcome): CodingError => {
  assert.ok(Result.isFailure(outcome), `expected a typed failure, got ${JSON.stringify(outcome)}`)
  assert.ok(outcome.failure instanceof CodingError, `expected a CodingError, got ${String(outcome.failure)}`)
  return outcome.failure
}

const verdictOf = (result: typeof CheckResult.Type) =>
  Schema.decodeUnknownSync(Schema.Struct({
    verdict: Schema.String,
    summary: Schema.String,
    examinedPaths: Schema.Array(Schema.String),
    findings: Schema.Array(Schema.Struct({ path: Schema.String, line: Schema.Int, message: Schema.String })),
    decidedBy: Schema.optionalKey(Schema.String)
  }))(result.detail)

test("every hunk decisively clean is a pass Jev decides on its own", async () => {
  const { outcome, asked } = await runCheck(() => 0.02)
  const result = retained(outcome)
  assert.equal(result.status, "passed")
  assert.deepEqual(asked, ["src/a.ts:2", "src/a.ts:23", "src/b.ts:8"])
  const verdict = verdictOf(result)
  assert.equal(verdict.verdict, "pass")
  assert.equal(verdict.decidedBy, "jev")
  assert.deepEqual(verdict.findings, [])
  assert.deepEqual([...verdict.examinedPaths], ["src/a.ts", "src/b.ts"])
  assert.equal(verdict.summary, "Jev found no hunk violating Units")
})

test("one decisively violating hunk is a fail whose finding is the rule itself", async () => {
  const { outcome } = await runCheck((path, line) => path === "src/a.ts" && line === 23 ? 0.95 : 0.02)
  const result = retained(outcome)
  assert.equal(result.status, "failed")
  const verdict = verdictOf(result)
  assert.equal(verdict.verdict, "fail")
  assert.equal(verdict.decidedBy, "jev")
  assert.deepEqual([...verdict.findings], [{ path: "src/a.ts", line: 23, message: rule }])
  assert.equal(verdict.summary, "Jev flagged 1 of 3 hunks against Units")
})

test("an indecisive hunk is Jev's own uncertain verdict, retained as it stands", async () => {
  const { outcome, asked } = await runCheck((path, line) => path === "src/b.ts" && line === 8 ? 0.5 : 0.02)
  const result = retained(outcome)
  assert.equal(asked.length, 3, "Jev judges every hunk and nothing else is asked")
  assert.equal(result.status, "error", "an uncertain verdict is never a pass")
  assert.equal(result.summary, inconclusiveCheck)
  const verdict = verdictOf(result)
  assert.equal(verdict.verdict, "uncertain")
  assert.equal(verdict.decidedBy, "jev", "the uncertainty is Jev's decision, not a missing one")
  assert.equal(verdict.summary, "Jev was unsure about 1 of 3 hunks against Units")
})

test("a required rule Jev is unsure of cannot pass its trial gate", async () => {
  const { outcome } = await runCheck((path, line) => path === "src/b.ts" && line === 8 ? 0.5 : 0.02)
  const result = retained(outcome)
  assert.equal(result.policy, "required")
  assert.notEqual(result.status, "passed")
  // Even a receipt that claims a passing gate is refused: the row itself says
  // the required rule was never established on this source.
  const output: typeof CheckOutput.Type = { base, candidate, gate: "passed", results: [result] }
  const step: typeof StepResult.Type = {
    stepId: "checks",
    executionId: "step-checks",
    status: "completed",
    summary: "1 of 1 checks passed",
    evidence: [...result.evidence],
    output: JSON.parse(JSON.stringify(output))
  }
  const configuration: Pick<typeof Draft.Type, "checks" | "steps"> = { checks: [check], steps: [work.step] }
  const job: typeof JobResult.Type = {
    repo: "example/repo",
    job: "ci",
    revision: 1,
    digest: "f".repeat(64),
    sourceRevision: candidate,
    eventKey: "event-1",
    publicActions: [],
    results: [step],
    status: "completed"
  }
  assert.throws(
    () => verifyTrialChecks(configuration, job),
    /The trial recorded an unavailable check: units — The AI check did not establish complete scope coverage/
  )
})

test("an unavailable evaluator fails the check and reaches no other model", async () => {
  const { outcome } = await runCheck(() => 0.02, Evaluator.layerUnavailable())
  assert.equal(refusal(outcome).code, "unavailable")
})

test("a refused evaluation fails the check, never a verdict", async () => {
  const { outcome } = await runCheck(() => undefined)
  const error = refusal(outcome)
  assert.equal(error.code, "unavailable")
  assert.equal(error.message, "Jev could not judge Units: refused — scripted refusal")
})

test("the frontier checker seat is gone from the AI check surface", () => {
  const surface = Checks as Record<string, unknown>
  assert.equal(surface.SemanticCheck, undefined, "there is no seat action to fall back to")
  assert.equal(surface.checkModelLayers, undefined, "and no model layer that only served it")
  assert.equal(surface.checkModelNames, undefined)
})

/** The real `repository/run-checks` over one AI check whose flow failed the way
 * an unreachable Jev fails it, so the recorded row is the deployed one. */
const runChecksWith = (failure: CodingError) =>
  Effect.gen(function*() {
    const handlers = new Map<string, (payload: unknown) => { execute: Effect.Effect<unknown, unknown, never> }>()
    const runtime = {
      register: (
        declared: { _tag: string },
        action: (payload: unknown) => { execute: Effect.Effect<unknown, unknown, never> }
      ) => Effect.sync(() => handlers.set(declared._tag, action)),
      execute: (flow: { _tag: string }) =>
        flow._tag === "repository/AICheck" ?
          Effect.fail(failure)
          : Effect.die(`unexpected child flow ${flow._tag}`)
    }
    const fs = yield* FileSystem.FileSystem
    yield* Layer.build(
      checkLayers({ repositoryPath: "/nonexistent", fs, evaluator: Evaluator.layerUnavailable() }).pipe(
        Layer.provide([Layer.succeed(FlowRuntime.FlowRuntime, runtime as never), Action.layerImplementations])
      )
    )
    return (yield* handlers.get(RunChecks.name)!(Schema.decodeUnknownSync(RunChecks.payloadSchema)(plan)).execute.pipe(
      Effect.provideService(FlowRuntime.FlowInstance, { executionId: "step-checks" } as never),
      Effect.provideService(FlowRuntime.FlowRuntime, runtime as never)
    )) as typeof StepResult.Type
  }).pipe(Effect.scoped, Effect.provide([Jj.layerNoop({}), NodeServices.layer]), Effect.runPromise)

test("an evaluator failure is an errored row carrying its typed error, and blocks the gate", async () => {
  const failure = new CodingError({
    code: "unavailable",
    message: "Jev could not judge Units: unreachable — No evaluator is installed on this host"
  })
  const step = await runChecksWith(failure)
  assert.equal(step.status, "error")
  const output = step.output as unknown as typeof CheckOutput.Type
  assert.equal(output.gate, "blocked", "a required rule nobody could judge never passes")
  assert.equal(output.results.length, 1)
  const row = output.results[0]!
  assert.equal(row.status, "error")
  assert.equal(row.checkId, "units")
  assert.deepEqual(row.detail, {
    _tag: "coding/Error",
    code: "unavailable",
    message: "Jev could not judge Units: unreachable — No evaluator is installed on this host"
  })
})
