import { RunNotFound } from "@smthrs/control/ControlError"
import * as ControlRuntime from "@smthrs/control/ControlRuntime"
import * as Digest from "@smthrs/core/Digest"
import { DurableEngineState } from "@smthrs/engine-store"
import * as RunCatalogRead from "@smthrs/engine-store/RunCatalogRead"
import { Flow } from "@smthrs/flow"
import * as RunStore from "@smthrs/run-store/RunStore"
import { Effect, Exit, Layer, Schema } from "effect"
import assert from "node:assert/strict"
import { test } from "node:test"
import { initialSetup, setupCandidate } from "../../packages/rpc/src/RepositorySetup.ts"
import { CodingError } from "../coding/schema.ts"
import { verifyTrialChecks } from "../repository/checks.ts"
import { RepositoryJob } from "../repository/jobs.ts"
import { completedJob, priorSetupReceipt } from "../repository/receipts.ts"
import { Draft, type JobInput, JobResult, OperationResult, type SetupInput } from "../repository/schema.ts"

const source = "a".repeat(40), base = "b".repeat(40)
const json = (value: unknown): Schema.Json => JSON.parse(JSON.stringify(value))
const fixture = (
  options: {
    status?: "passed" | "failed" | "skipped" | "error"
    policy?: "report" | "required"
    summary?: string
    nested?: boolean
    omitted?: boolean
    emptyExamined?: boolean
    evidence?: readonly string[]
    wrongPolicy?: boolean
    duplicateId?: boolean
    secondSkipped?: boolean
    baselineOnly?: boolean
    wrongSource?: boolean
    builtInReview?: boolean
  } = {}
) => {
  const job = options.builtInReview ? "review" : "ci", bridge = `repository-jobs/${job}`
  const setup = initialSetup("example/repo", job, "maintainer"),
    policy = options.builtInReview ? "report" : options.policy ?? "report"
  setup.draft.checks = [{
    id: "observability",
    name: "Observability",
    kind: "ai",
    rule: "Handlers record telemetry",
    paths: ["src/**"],
    policy
  }]
  if (options.builtInReview) setup.draft.checks = []
  if (options.duplicateId) setup.draft.checks.push({ ...setup.draft.checks[0]!, kind: "command", rule: "true" })
  if (options.secondSkipped) setup.draft.checks.push({ ...setup.draft.checks[0]!, id: "second-rule" })
  const input: JobInput = {
    repo: setup.repo,
    job,
    revision: setup.revision,
    digest: setupCandidate(setup),
    sourceRevision: source,
    configuration: Schema.decodeUnknownSync(Draft)(setup.draft),
    event: {
      source: "smithers-cloud",
      type: "issues",
      action: "opened",
      issueNumber: 42,
      deliveryKey: "trial:42",
      trial: true,
      payload: { issue: { title: "Run checks", body: "PR 42" } }
    }
  }
  const status = options.status ?? "passed",
    blocked = policy === "required" && (status === "failed" || status === "error")
  const proposal = [{ path: "src/handler.ts", beforeDigest: null, content: "export const handler = () => 1\n" }]
  const checkedSource = options.wrongSource
    ? "f".repeat(40)
    : options.nested
    ? `${source}+${Digest.digest(Digest.canonical(proposal))}`
    : source
  const checks = {
    base: options.nested ? source : base,
    candidate: checkedSource,
    gate: blocked ? "blocked" : "passed",
    results: options.omitted ? [] : [{
      checkId: options.builtInReview ? "review-review" : "observability",
      policy: options.wrongPolicy ? "report" : policy,
      status,
      summary: options.summary ?? status,
      executionId: "ai-execution",
      evidence: options.evidence ??
        [`execution:ai-execution`, `source:${checkedSource}`, `base:${options.nested ? source : base}`],
      detail: status === "error" || status === "skipped" ?
        null :
        {
          verdict: status === "passed" ? "pass" : "fail",
          summary: "Checked the handler",
          examinedPaths: options.emptyExamined ? [] : ["src/handler.ts"],
          findings: status === "failed" ? [{ path: "src/handler.ts", line: 1, message: "Missing telemetry" }] : []
        }
    }]
  }
  if (options.secondSkipped) {
    checks.results.push({ ...checks.results[0]!, checkId: "second-rule", status: "skipped", detail: null })
  }
  const step = {
    stepId: options.builtInReview ? "review" : "checks",
    status: blocked ? "error" as const : "completed" as const,
    summary: "Checked",
    executionId: "check-step",
    evidence: [`source:${checkedSource}`],
    output: json(checks)
  }
  const final = options.baselineOnly
    ? {
      ...step,
      output: json({
        ...checks,
        results: checks.results.map((value) => ({ ...value, status: "skipped", detail: null }))
      })
    }
    : step
  const result: JobResult = {
    repo: input.repo,
    job: input.job,
    revision: input.revision,
    digest: input.digest,
    sourceRevision: source,
    eventKey: input.event.deliveryKey,
    status: blocked ? "partial" : "completed",
    publicActions: [],
    results: [
      options.nested
        ? {
          ...step,
          output: json({ status: "checked-proposal", checks: [step, final], proposal, children: [], question: "" })
        } :
        step
    ]
  }
  const setupInput: SetupInput = {
    requestId: "trial-request",
    repo: input.repo,
    job: input.job,
    operation: "trial",
    revision: input.revision,
    digest: input.digest,
    draft: input.configuration
  }
  const receipt: typeof OperationResult.Type = {
    requestId: setupInput.requestId,
    revision: input.revision,
    digest: input.digest,
    receipt: {
      requestId: setupInput.requestId,
      runId: "setup-root",
      revision: input.revision,
      operation: "trial",
      phase: "completed",
      digest: input.digest,
      updatedAt: 1,
      results: [],
      sourceRevision: source,
      trialIssue: { source: "smithers-cloud", number: 42 },
      evidence: ["run:job-root", "execution:job", `source:${source}`]
    }
  }
  const row = (
    runId: string,
    flowName: string,
    payload: unknown,
    parentRunId: string | null,
    result?: unknown
  ): RunStore.RunRow => ({
    runId,
    status: "completed",
    createdAtMs: 1,
    startedAtMs: 1,
    finishedAtMs: 2,
    owner: null,
    heartbeatAtMs: null,
    claim: null,
    claimedAtMs: null,
    cancelRequestedAtMs: null,
    parentRunId,
    stateJson: JSON.stringify({
      version: 1,
      flowName,
      payload,
      ...(parentRunId ? { parentExecutionId: parentRunId } : {}),
      ...(result ? { result } : {})
    })
  })
  const rows = new Map([
    [
      "job",
      row(
        "job",
        RepositoryJob._tag,
        input,
        "job-bridge",
        Schema.encodeSync(Schema.toCodecJson(Flow.Result({ success: JobResult, error: RepositoryJob.errorSchema })))(
          new Flow.Complete({ exit: Exit.succeed(result) })
        )
      )
    ],
    ["job-bridge", row("job-bridge", bridge, { input }, "job-root")],
    ["job-root", row("job-root", "agent/run", { planId: "job-plan" }, null)],
    [
      "setup",
      row(
        "setup",
        "repository/Setup",
        setupInput,
        "setup-bridge",
        Schema.encodeSync(Schema.toCodecJson(Flow.Result({ success: OperationResult, error: CodingError })))(
          new Flow.Complete({ exit: Exit.succeed(receipt) })
        )
      )
    ],
    ["setup-bridge", row("setup-bridge", "repository/setup", { input: setupInput }, "setup-root")],
    ["setup-root", row("setup-root", "agent/run", { planId: "setup-plan" }, null)]
  ])
  const catalog: RunCatalogRead.Service = {
    listRunIds: () => Effect.die("Receipt lookup must use the bounded filtered catalog"),
    listRuns: (options) =>
      Effect.succeed({
        source: "0".repeat(32),
        revision: 1,
        cursor: null,
        runs: [...rows.values()].filter((row) => JSON.parse(row.stateJson).flowName === options?.filters?.flowName).map(
          (row) => ({
            _tag: "Observed",
            runId: row.runId,
            source: "0".repeat(32),
            revision: 1,
            status: row.status,
            flowName: JSON.parse(row.stateJson).flowName,
            createdAtMs: 1,
            startedAtMs: 1,
            finishedAtMs: 2,
            parentRunId: row.parentRunId,
            lineageId: row.runId,
            roundOrdinal: 0,
            cancellation: { requestedAtMs: null, acknowledgement: null },
            waiting: null
          })
        )
      })
  }
  // Only the real receipt reader's ports are substituted; its state codecs,
  // approved input, bridge ancestry and terminal-result checks all execute.
  const control = {
    getRun: (runId: string) =>
      runId === "job-root" || runId === "setup-root"
        ? Effect.succeed({
          runId,
          status: "completed",
          flowId: runId === "job-root" ? bridge : "repository/setup",
          planId: runId === "job-root" ? "job-plan" : "setup-plan",
          planDigest: "approved-plan"
        }) :
        Effect.fail(new RunNotFound({ runId })),
    getPlan: (id: string) =>
      Effect.succeed({
        decision: "approved",
        decodedInput: id === "job-plan" ? input : setupInput,
        card: { digest: "approved-plan", flowId: id === "job-plan" ? bridge : "repository/setup" }
      })
  } as unknown as ControlRuntime.Service
  const services = Layer.mergeAll(
    Layer.succeed(ControlRuntime.ControlRuntime, control),
    Layer.succeed(RunCatalogRead.RunCatalogRead, catalog),
    Layer.succeed(DurableEngineState.DurableEngineState, {
      runParents: () => Effect.succeed([])
    } as unknown as DurableEngineState.Service),
    RunStore.layerNoop({
      get: (id) =>
        rows.has(id)
          ? Effect.succeed(rows.get(id)!)
          : Effect.fail(
            new RunStore.RunStoreError({
              code: "not_found_row",
              method: "get",
              message: "Missing fixture receipt",
              cause: { runId: id }
            })
          )
    })
  )
  return {
    input,
    result,
    rows,
    services,
    trial: (trial = true) =>
      Effect.runPromise(
        completedJob("job-root", input, { source: "smithers-cloud", issueNumber: 42, trial }).pipe(
          Effect.provide(services)
        )
      ),
    apply: () =>
      Effect.runPromise(
        priorSetupReceipt({ ...setupInput, operation: "apply" }, "trial").pipe(Effect.provide(services))
      )
  }
}

/** Walk run 3's two refused production trials: the only change a trial of the
 * issues or chores draft produces is its own test issue, so the check step
 * never records a result for a configured rule to be judged on. */
const untouchedScope = (job: "issues" | "chores", policy: "report" | "required") => {
  const setup = initialSetup("codeplanesmithers/canary-sandbox", job, "maintainer")
  setup.draft.checks = [
    job === "issues"
      ? {
        id: "docs-preserve",
        name: "Documentation edits preserve existing content",
        kind: "ai",
        policy,
        rule: "Documentation edits preserve existing content",
        paths: ["docs/**"]
      }
      : {
        id: "chore-scope",
        name: "Chore stays within its requested scope",
        kind: "ai",
        policy,
        rule: "A chore changes only what it was asked to change",
        paths: []
      }
  ]
  const configuration = Schema.decodeUnknownSync(Draft)(setup.draft)
  const results = job === "issues"
    ? configuration.steps.filter((step) => step.mode === "automatic").map((step) => ({
      stepId: step.id,
      status: "completed" as const,
      summary: "Answered the test issue",
      executionId: `execution-${step.id}`,
      evidence: [`source:${source}`],
      output: json({ classification: "question", summary: "Answered the test issue", citations: [], question: "" })
    }))
    : [{
      stepId: "chore",
      status: "completed" as const,
      summary: "No proposed changes",
      executionId: "execution-chore",
      evidence: [`source:${source}`],
      output: json({
        status: "proposal",
        summary: "No proposed changes",
        source: { commitId: source },
        proposal: [],
        children: [],
        checks: [],
        question: ""
      })
    }]
  const result: JobResult = {
    repo: setup.repo,
    job,
    revision: setup.revision,
    digest: setupCandidate(setup),
    sourceRevision: source,
    eventKey: "trial:68",
    status: "completed",
    publicActions: [],
    results
  }
  return { configuration, result, name: configuration.checks[0]!.name }
}

test("a report-only rule the trial's own change never exercised does not refuse the trial", async () => {
  for (const job of ["issues", "chores"] as const) {
    const reported = untouchedScope(job, "report")
    assert.doesNotThrow(() => verifyTrialChecks(reported.configuration, reported.result), job)
    const required = untouchedScope(job, "required")
    assert.throws(
      () => verifyTrialChecks(required.configuration, required.result),
      new RegExp(`AI check ${required.name} has no completed in-scope trial result; test a change that exercises it`),
      job
    )
  }
  const unchecked = untouchedScope("issues", "required")
  assert.doesNotThrow(
    () => verifyTrialChecks({ ...unchecked.configuration, checks: [] }, unchecked.result),
    "no configured rule holds this trial"
  )
  // The check step ran and recorded the rule skipped for want of a path in its scope.
  assert.equal((await fixture({ status: "skipped" }).trial())?.executionId, "job")
  assert.equal((await fixture({ secondSkipped: true }).trial())?.executionId, "job")
  assert.equal((await fixture({ nested: true, baselineOnly: true }).trial())?.executionId, "job")
  await assert.rejects(
    fixture({ policy: "required", status: "skipped" }).trial(),
    /AI check Observability has no completed in-scope trial result; test a change that exercises it/
  )
})

test("live trial proof rejects unmatched required, missing and unavailable AI rules", async () => {
  for (
    const options of [
      { policy: "required", status: "skipped" },
      { status: "error" },
      { omitted: true },
      { emptyExamined: true },
      { evidence: [] },
      { policy: "required", wrongPolicy: true },
      { policy: "required", secondSkipped: true },
      { wrongSource: true },
      { policy: "required", nested: true, baselineOnly: true }
    ] as const
  ) {
    await assert.rejects(fixture(options).trial(), /AI|check|trial/i, JSON.stringify(options))
  }
  assert.throws(
    () => fixture({ duplicateId: true }),
    /unique id/,
    "the shared candidate schema already refuses duplicate configured IDs"
  )
})

test("matched report findings and required passes prove actual direct or nested trial work", async () => {
  for (const nested of [false, true]) {
    for (const options of [{ status: "passed" }, { status: "failed" }, { policy: "required" }] as const) {
      const proof = await fixture({ ...options, nested }).trial()
      assert.equal(proof?.executionId, "job")
    }
  }
  await assert.rejects(fixture({ policy: "required", status: "failed" }).trial(), /did not complete/)
})

test("activation rechecks older successful trial receipts against their owned actual AI results", async () => {
  await assert.rejects(fixture({ policy: "required", status: "skipped" }).apply(), /AI|check|trial/i)
  assert.equal(
    (await fixture({ status: "skipped" }).apply()).phase,
    "completed",
    "a report-only rule the change never exercised does not hold activation either"
  )
  assert.equal((await fixture().apply()).phase, "completed")
  const missing = fixture()
  missing.rows.delete("job")
  await assert.rejects(missing.apply(), /matching|receipt|trial/i)
})

test("unrelated normal events can still skip AI rules and receipt ownership stays exact", async () => {
  assert.equal((await fixture({ status: "skipped" }).trial(false))?.output.status, "completed")
  const wrongOwner = fixture()
  const row = wrongOwner.rows.get("job-bridge")!, state = JSON.parse(row.stateJson)
  state.payload.input = { ...state.payload.input, digest: "f".repeat(64) }
  wrongOwner.rows.set("job-bridge", { ...row, stateJson: JSON.stringify(state) })
  await assert.rejects(wrongOwner.trial(), /bridge does not match/)
})

test("the selected built-in PR review must run without requiring other event or disabled steps", async () => {
  await assert.rejects(fixture({ builtInReview: true, status: "skipped" }).trial(), /AI check Review changes/)
  assert.equal(
    (await fixture({ builtInReview: true }).trial())?.executionId,
    "job",
    "the separate followup event is not required by this review trial"
  )
  const configured = fixture({ builtInReview: true })
  const draft = {
    ...configured.input.configuration,
    steps: [...configured.input.configuration.steps, {
      id: "disabled-review",
      name: "Disabled",
      mode: "off" as const,
      prompt: "Unused"
    }]
  }
  // Disabled steps never create a required check in the proof verifier.
  assert.doesNotThrow(() => verifyTrialChecks(draft, configured.result))
})

test("an unavailable trial check names itself and its recorded reason", async () => {
  const reason = "The AI check did not establish complete scope coverage"
  for (const nested of [false, true]) {
    const refused = await fixture({ status: "error", summary: reason, nested }).trial().then(
      () => undefined,
      (error) => String(error)
    )
    assert.match(refused ?? "accepted", /observability/, `nested ${nested}`)
    assert.match(refused ?? "accepted", new RegExp(reason), `nested ${nested}`)
  }
  const silent = fixture({ status: "error", summary: "" })
  assert.throws(
    () => verifyTrialChecks(silent.input.configuration, silent.result),
    (error) => /unavailable check: observability$/.test(String((error as { message: string }).message))
  )
  const inconsistent = fixture({ policy: "required", status: "failed" })
  const step = inconsistent.result.results[0]!
  assert.throws(
    () =>
      verifyTrialChecks(inconsistent.input.configuration, {
        ...inconsistent.result,
        results: [{ ...step, status: "completed" }]
      }),
    /gate blocked with status completed/
  )
})

test("a successful AI invocation cannot mask another unavailable invocation in the same trial", () => {
  const passed = fixture(), unavailable = fixture({ status: "error" }), skipped = fixture({ status: "skipped" })
  assert.throws(
    () =>
      verifyTrialChecks(passed.input.configuration, {
        ...passed.result,
        results: [...passed.result.results, ...unavailable.result.results]
      }),
    /AI|check|trial/i
  )
  assert.doesNotThrow(
    () =>
      verifyTrialChecks(passed.input.configuration, {
        ...passed.result,
        results: [...passed.result.results, ...skipped.result.results]
      }),
    "another unrelated step may legitimately skip once the rule has actually run"
  )
})
