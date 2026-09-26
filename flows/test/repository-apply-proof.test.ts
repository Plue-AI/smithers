import { NodeServices } from "@effect/platform-node"
import { RunNotFound } from "@smthrs/control/ControlError"
import * as ControlRuntime from "@smthrs/control/ControlRuntime"
import { DurableEngineState } from "@smthrs/engine-store"
import * as RunCatalogRead from "@smthrs/engine-store/RunCatalogRead"
import { Action, Flow, FlowRuntime } from "@smthrs/flow"
import * as RunStore from "@smthrs/run-store/RunStore"
import { Effect, Exit, FileSystem, Layer, Schema } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test, type TestContext } from "node:test"
import { initialSetup, setupCandidate } from "../../packages/rpc/src/RepositorySetup.ts"
import * as Jj from "../../packages/smithers/flows/jj/src/Jj.ts"
import { ModuleOwner } from "../../packages/smithers/src/internal/ModuleOwner.ts"
import { NativeCoding } from "../coding/native.ts"
import { CodingError } from "../coding/schema.ts"
import { RepositoryJob } from "../repository/jobs.ts"
import { RepositoryRemote } from "../repository/remote.ts"
import { Draft, JobInput, JobResult, OperationResult, SetupInput } from "../repository/schema.ts"
import { setupLayers } from "../repository/setup.ts"

/*
 * Walk run 3, defect C3-N3: the paused `feature` registration held revision 6,
 * the restored draft reached revision 12 with digest f21783f0…, its evals
 * (run-21) and its live trial (run-22, cloud trial issue #66) both completed at
 * that exact revision and digest — and both applies were refused with
 * "failed — invalid_receipt: Run evals for this exact candidate before
 * continuing" (run-20, run-24).
 * `.artifacts/mvp-canary-walk-20260917/C-REPORT.md`, C3-10/C3-11 receipts.
 */
const repo = "codeplanesmithers/canary-sandbox", job = "feature"
const trialSource = "9685b529" + "0".repeat(32), pausedSource = "e24a5889" + "0".repeat(32)
const appliedRevision = 6, candidateRevision = 12
const json = (value: unknown): Schema.Json => JSON.parse(JSON.stringify(value))

const reviewedDraft = () => {
  const initial = initialSetup(repo, job, "maintainer")
  return Schema.decodeUnknownSync(Draft)({
    ...initial.draft,
    landing: "checks",
    budgetMinutes: 12,
    steps: initial.draft.steps.map((step) => ({ ...step, mode: "approved" })),
    cases: [{
      id: "feature-line",
      name: "Appends the requested line",
      input: "a recorded feature request",
      expected: "One appended line in docs/nested/hello.txt",
      required: true
    }]
  })
}
const draft = reviewedDraft()
const candidateDigest = setupCandidate({ repo, job, revision: candidateRevision, draft: json(draft) as never })
const pausedDigest = setupCandidate({ repo, job, revision: appliedRevision, draft: json(draft) as never })
const setupInput = (requestId: string, operation: SetupInput["operation"]): SetupInput =>
  Schema.decodeUnknownSync(SetupInput)({
    requestId,
    repo,
    job,
    operation,
    revision: candidateRevision,
    digest: candidateDigest,
    draft
  })

const jobInput: JobInput = Schema.decodeUnknownSync(JobInput)({
  repo,
  job,
  revision: candidateRevision,
  digest: candidateDigest,
  sourceRevision: trialSource,
  configuration: draft,
  event: {
    source: "smithers-cloud",
    type: "issues",
    action: "opened",
    deliveryKey: "native:66",
    issueNumber: 66,
    trial: true,
    payload: { issue: { number: 66, title: "[Smithers test] Build a feature", body: "Append one line" } }
  }
})
const jobResult: JobResult = {
  repo,
  job,
  revision: candidateRevision,
  digest: candidateDigest,
  sourceRevision: trialSource,
  eventKey: "native:66",
  status: "completed",
  publicActions: [],
  results: [{
    stepId: "feature",
    status: "completed",
    summary: "Appended the requested line",
    executionId: "feature-step",
    evidence: [`source:${trialSource}`],
    output: json({
      status: "checked-proposal",
      summary: "One appended line",
      proposal: [],
      children: [],
      checks: [],
      question: ""
    })
  }]
}

const receipt = (operation: "evaluate" | "trial", requestId: string, runId: string): typeof OperationResult.Type => ({
  requestId,
  revision: candidateRevision,
  digest: candidateDigest,
  receipt: {
    requestId,
    runId,
    revision: candidateRevision,
    operation,
    phase: "completed",
    digest: candidateDigest,
    updatedAt: 1,
    sourceRevision: trialSource,
    results: operation === "evaluate"
      ? [{
        caseId: "feature-line",
        status: "passed",
        observed: "One appended line",
        evidence: ["execution:evaluation"],
        executionId: "evaluation"
      }]
      : [],
    ...(operation === "trial" ? { trialIssue: { source: "smithers-cloud" as const, number: 66 } } : {}),
    evidence: operation === "trial"
      ? [`.smithers/repository-jobs/${job}/${candidateDigest}/candidate.json`, "run:job-root", "execution:job"]
      : [`.smithers/repository-jobs/${job}/${candidateDigest}/candidate.json`, "execution:evaluation"]
  }
})

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
const setupResult = (value: typeof OperationResult.Type) =>
  Schema.encodeSync(Schema.toCodecJson(Flow.Result({ success: OperationResult, error: CodingError })))(
    new Flow.Complete({ exit: Exit.succeed(value) })
  )
const proven = (operation: "evaluate" | "trial", requestId: string) => {
  const input = setupInput(requestId, operation)
  return {
    input,
    rows: [
      [
        `${operation}-run`,
        row(
          `${operation}-run`,
          "repository/Setup",
          input,
          `${operation}-bridge`,
          setupResult(receipt(operation, requestId, `${operation}-root`))
        )
      ],
      [`${operation}-bridge`, row(`${operation}-bridge`, "repository/setup", { input }, `${operation}-root`)],
      [`${operation}-root`, row(`${operation}-root`, "agent/run", { planId: `${operation}-plan` }, null)]
    ] as const
  }
}

const fixture = async (t: TestContext, options: { evaluated?: boolean; trialled?: boolean } = {}) => {
  const evaluated = proven("evaluate", "7c0b8020-8494-41ef-bf75-8316e39f868b")
  const trialled = proven("trial", "597ae70b-e9b0-4186-87ef-7d91f4e595dd")
  const rows = new Map<string, RunStore.RunRow>([
    [
      "job",
      row(
        "job",
        RepositoryJob._tag,
        jobInput,
        "job-bridge",
        Schema.encodeSync(Schema.toCodecJson(Flow.Result({ success: JobResult, error: RepositoryJob.errorSchema })))(
          new Flow.Complete({ exit: Exit.succeed(jobResult) })
        )
      )
    ],
    ["job-bridge", row("job-bridge", `repository-jobs/${job}`, { input: jobInput }, "job-root")],
    ["job-root", row("job-root", "agent/run", { planId: "job-plan" }, null)],
    ...(options.evaluated === false ? [] : evaluated.rows),
    ...(options.trialled === false ? [] : trialled.rows)
  ])
  const plans: Record<string, unknown> = {
    "job-plan": jobInput,
    "evaluate-plan": evaluated.input,
    "trial-plan": trialled.input
  }
  const control = {
    getRun: (runId: string) =>
      runId.endsWith("-root") && plans[`${runId.replace(/-root$/, "")}-plan`] !== undefined
        ? Effect.succeed({
          runId,
          status: "completed",
          flowId: runId === "job-root" ? `repository-jobs/${job}` : "repository/setup",
          planId: `${runId.replace(/-root$/, "")}-plan`,
          planDigest: `${runId}-approved`
        })
        : Effect.fail(new RunNotFound({ runId })),
    getPlan: (id: string) =>
      Effect.succeed({
        decision: "approved",
        decodedInput: plans[id],
        card: {
          digest: `${id.replace(/-plan$/, "-root")}-approved`,
          flowId: id === "job-plan" ? `repository-jobs/${job}` : "repository/setup"
        }
      })
  } as unknown as ControlRuntime.Service
  const catalog: RunCatalogRead.Service = {
    listRunIds: () => Effect.die("Receipt lookup must use the bounded filtered catalog"),
    listRuns: (query) =>
      Effect.succeed({
        source: "0".repeat(32),
        revision: 1,
        cursor: null,
        runs: [...rows.values()].filter((value) => JSON.parse(value.stateJson).flowName === query?.filters?.flowName)
          .map((value) => ({
            _tag: "Observed",
            runId: value.runId,
            source: "0".repeat(32),
            revision: 1,
            status: value.status,
            flowName: JSON.parse(value.stateJson).flowName,
            createdAtMs: 1,
            startedAtMs: 1,
            finishedAtMs: 2,
            parentRunId: value.parentRunId,
            lineageId: value.runId,
            roundOrdinal: 0,
            cancellation: { requestedAtMs: null, acknowledgement: null },
            waiting: null
          }))
      })
  }
  const registered: unknown[] = []
  const paused = {
    id: "259ef97c-e71b-4735-acaa-6c0b4363b748",
    job,
    mode: "enabled",
    revision: appliedRevision,
    digest: pausedDigest,
    source_revision: pausedSource,
    enabled: false
  }
  const remote = RepositoryRemote.of(
    {
      repo,
      workspaceId: "af1e3bc5-6388-419e-98cc-e13372a89646",
      registrations: Effect.succeed(json({ items: [paused] })),
      register: (_job: string, body: unknown) =>
        Effect.sync(() => {
          registered.push(body)
          return json({
            registration_id: paused.id,
            revision: candidateRevision,
            digest: candidateDigest,
            source_revision: trialSource,
            mode: "enabled",
            enabled: true
          })
        })
    } as never
  )
  const root = await mkdtemp(join(tmpdir(), "repository-apply-proof-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  return { rows, control, catalog, remote, registered, root }
}

/** The real apply action, its real receipt reader and its real candidate
 * materialiser; only the registry write and the native read are substituted. */
const applyCandidate = (host: Awaited<ReturnType<typeof fixture>>) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const handlers = new Map<string, (payload: unknown) => { execute: Effect.Effect<unknown, unknown, never> }>()
    const activation = {
      registration: {
        registration_id: "259ef97c-e71b-4735-acaa-6c0b4363b748",
        revision: candidateRevision,
        digest: candidateDigest,
        source_revision: trialSource,
        mode: "enabled",
        enabled: true
      },
      source: {
        changeId: "srpxsynv",
        commitId: trialSource,
        treeId: "7d081d18",
        operationId: "f".repeat(128),
        parentCommitIds: []
      }
    }
    const runtime = {
      register: (declared: { _tag: string }, action: unknown) =>
        Effect.sync(() => handlers.set(declared._tag, action as never)),
      execute: () => Effect.succeed(activation)
    }
    const services = Layer.mergeAll(
      Layer.succeed(FlowRuntime.FlowRuntime, runtime as never),
      Layer.succeed(FlowRuntime.FlowInstance, { executionId: "apply-execution" } as never),
      Layer.succeed(ModuleOwner, { rootId: "apply-root", flowId: "repository/setup" }),
      Layer.succeed(RepositoryRemote, host.remote),
      Layer.succeed(Jj.Jj, { snapshot: () => Effect.void } as never),
      Layer.succeed(NativeCoding, {
        read: () => Effect.succeed({ head: { kind: "resolved", commitId: trialSource } })
      } as never),
      Layer.succeed(ControlRuntime.ControlRuntime, host.control),
      Layer.succeed(RunCatalogRead.RunCatalogRead, host.catalog),
      Layer.succeed(DurableEngineState.DurableEngineState, { runParents: () => Effect.succeed([]) } as never),
      RunStore.layerNoop({
        get: (id) =>
          host.rows.has(id) ?
            Effect.succeed(host.rows.get(id)!)
            : Effect.fail(
              new RunStore.RunStoreError({
                code: "not_found_row",
                method: "get",
                message: "Missing fixture receipt",
                cause: { runId: id }
              })
            )
      }),
      Layer.succeed(SqlClient.SqlClient, undefined as never),
      Action.layerImplementations,
      NodeServices.layer
    )
    yield* Layer.build(setupLayers({ repositoryPath: host.root, fs }).pipe(Layer.provide(services)))
    const handler = handlers.get("repository/execute-setup")
    if (!handler) return yield* Effect.die("repository/execute-setup has no implementation")
    return yield* handler({
      input: setupInput("84df7424-3306-4ab8-960b-aa862f4954a5", "apply"),
      deadlineAt: Date.now() + 600_000
    })
      .execute.pipe(Effect.provide(services), Effect.result)
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.runPromise)

const failure = (outcome: { _tag: string; failure?: unknown }) =>
  outcome._tag === "Failure" ? String((outcome.failure as { message?: unknown }).message) : ""

test("apply accepts the exact candidate its own evals and live trial completed at", async (t) => {
  const host = await fixture(t)
  const applied = await applyCandidate(host)
  assert.equal(failure(applied), "", "the receipts this apply asks for exist at its own revision and digest")
  const result = (applied as { success: typeof OperationResult.Type }).success
  assert.equal(result.receipt?.phase, "completed")
  assert.equal(result.revision, candidateRevision)
  assert.equal(result.digest, candidateDigest)
  assert.equal(result.receipt?.sourceRevision, trialSource, "the enabled registration keeps the trialled source")
  assert.equal(result.receipt?.registrationId, "259ef97c-e71b-4735-acaa-6c0b4363b748")
})

test("apply still refuses a candidate whose own evals or trial are missing", async (t) => {
  assert.equal(
    failure(await applyCandidate(await fixture(t, { evaluated: false }))),
    "Run evals for this exact candidate before continuing"
  )
  assert.equal(
    failure(await applyCandidate(await fixture(t, { trialled: false }))),
    "Run the live trial for this exact candidate before continuing"
  )
})
