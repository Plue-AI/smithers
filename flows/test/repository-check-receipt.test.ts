import { NodeCrypto, NodeHttpClient } from "@effect/platform-node"
import { RunNotFound } from "@smthrs/control/ControlError"
import { ControlRuntime } from "@smthrs/control/ControlRuntime"
import { FlowEngine } from "@smthrs/engine"
import { DurableEngineState } from "@smthrs/engine-store"
import * as RunCatalogRead from "@smthrs/engine-store/RunCatalogRead"
import { Action, Flow } from "@smthrs/flow"
import * as RunStore from "@smthrs/run-store/RunStore"
import { Effect, Exit, Layer, ManagedRuntime, Schema } from "effect"
import assert from "node:assert/strict"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { test, type TestContext } from "node:test"
import { initialSetup, setupCandidate } from "../../packages/rpc/src/RepositorySetup.ts"
import { ModuleOwner } from "../../packages/smithers/src/internal/ModuleOwner.ts"
import { type BackendLanding, Landing } from "../coding/landing.ts"
import { NativeCoding } from "../coding/native.ts"
import { CodingError } from "../coding/schema.ts"
import { make, pinnedPolicy, RepositoryCheckReceipts, verifiedCheckStep } from "../repository/check-receipt.ts"
import { CheckStep } from "../repository/checks.ts"
import {
  type CiPolicy,
  composeCiChecks,
  inheritedCheckId,
  readCiPolicy,
  revalidateCiPolicy
} from "../repository/ci-policy.ts"
import * as Delivery from "../repository/delivery.ts"
import { finalCheckWork } from "../repository/jobs.ts"
import { completedJob } from "../repository/receipts.ts"
import { RepositoryRemote } from "../repository/remote.ts"
import { StepResult } from "../repository/schema.ts"

const changeId = "k".repeat(31) + "m"
const mainCommit = "a1".repeat(20), mainTree = "a2".repeat(20)
const sourceCommit = "b1".repeat(20), sourceTree = "b2".repeat(20)
const operationId = "c3".repeat(64), workspaceId = "11111111-1111-4111-a111-111111111111"
const registrationId = "33333333-3333-4333-a333-333333333333"
const repo = "example/repo", deadlineAt = 4_000_000_000_000, sourceRevision = "a".repeat(40)
const reviewed = [{
  id: "verify",
  name: "Verify",
  kind: "command" as const,
  rule: "true",
  paths: [] as string[],
  policy: "required" as const
}, {
  id: "review",
  name: "Review",
  kind: "ai" as const,
  rule: "Reads correctly",
  paths: ["api/**"],
  policy: "required" as const
}]
const advisory = [{
  id: "shape",
  name: "Shape",
  kind: "ai" as const,
  rule: "Reads well",
  paths: [] as string[],
  policy: "report" as const
}]
const localCheck = {
  id: "style",
  name: "Style",
  kind: "command" as const,
  rule: "true",
  paths: [] as string[],
  policy: "report" as const
}
const step = { id: "feature", name: "Feature", mode: "manual" as const, prompt: "Update code.txt" }
const event = {
  source: "smithers-cloud" as const,
  type: "manual",
  action: "manual:feature",
  manualStep: "feature",
  deliveryKey: "feature",
  payload: {}
}
/** The pinned policy under test is exactly what the policy lane's reader emits. */
const registrationRow = (revision: number, checks: unknown[] = reviewed) => {
  const setup = initialSetup(repo, "ci", "maintainer")
  setup.revision = revision
  setup.draft.checks = structuredClone(checks) as typeof setup.draft.checks
  const digest = setupCandidate(setup)
  return {
    id: registrationId,
    repository_id: 3,
    workspace_id: workspaceId,
    user_id: 7,
    job: "ci",
    mode: "enabled",
    revision,
    digest,
    source_revision: sourceRevision,
    flow_id: "repository-jobs/ci",
    enabled: true,
    configuration: {
      repo,
      workspace_id: workspaceId,
      flow_id: "repository-jobs/ci",
      revision,
      digest,
      source_revision: sourceRevision,
      execution_digest: "f".repeat(64),
      mode: "enabled",
      input: setup.draft
    }
  }
}
const readPinned = (revision: number, checks: unknown[] = reviewed) => {
  const policy = readCiPolicy(repo, [registrationRow(revision, checks)])
  if (policy.kind !== "pinned") throw new Error("expected a pinned policy")
  return policy
}
const pinned = readPinned(7), ref = pinned.ref
const inherited = (rawId: string, into = pinned) => inheritedCheckId(into.ref, rawId)
const base = {
  kind: "resolved" as const,
  changeId: "k".repeat(32),
  commitId: mainCommit,
  treeId: mainTree,
  operationId,
  parentCommitIds: []
}
const source = {
  kind: "resolved" as const,
  changeId,
  commitId: sourceCommit,
  treeId: sourceTree,
  operationId,
  parentCommitIds: [mainCommit]
}
const creation = {
  status: "created" as const,
  replayed: false,
  requestId: "22222222-2222-4222-a222-222222222222",
  requestDigest: "d".repeat(64),
  repositoryId: 3,
  workspaceId,
  operationId,
  parentOperationId: operationId,
  base: { changeId: base.changeId, commitId: mainCommit, treeId: mainTree, parentCommitIds: [] },
  head: source,
  source,
  publicationReady: true
}
const checkExecutionId = "job-run/checks"
const results = [
  {
    checkId: inherited("verify"),
    policy: "required",
    status: "passed",
    summary: "Exit 0",
    evidence: [],
    executionId: `${checkExecutionId}/verify`,
    detail: null
  },
  {
    checkId: inherited("review"),
    policy: "required",
    status: "skipped",
    summary: "No changed paths match this check",
    evidence: [],
    executionId: `${checkExecutionId}/review`,
    detail: null
  },
  {
    checkId: localCheck.id,
    policy: "report",
    status: "failed",
    summary: "Exit 1",
    evidence: [],
    executionId: `${checkExecutionId}/style`,
    detail: null
  }
]
const evidence = {
  repo,
  source: { changeId: base.changeId, commitId: mainCommit, treeId: mainTree, operationId, parentCommitIds: [] },
  files: [],
  missing: [],
  history: [],
  records: [],
  sources: []
}
const workFor = (policy: CiPolicy) => ({
  repo,
  job: "feature" as const,
  step,
  event,
  evidence,
  deadlineAt,
  checks: composeCiChecks([localCheck], policy),
  landing: "checks" as const,
  replies: "draft" as const,
  executionMode: "live" as const,
  policy
})
const work = workFor(pinned)
/** The dispatched job input the registered bridge and approved plan both carry. */
const jobInputFor = (
  options: { repo?: string; steps?: unknown[]; job?: "feature" | "chores"; event?: unknown } = {}
) => {
  const setup = initialSetup(options.repo ?? repo, options.job ?? "feature", "maintainer")
  setup.revision = 4
  setup.draft.steps = (options.steps ?? [step]) as typeof setup.draft.steps
  setup.draft.checks = structuredClone([localCheck]) as typeof setup.draft.checks
  setup.draft.landing = "checks"
  setup.draft.replies = "draft"
  return {
    repo: options.repo ?? repo,
    job: options.job ?? "feature",
    revision: setup.revision,
    digest: setupCandidate(setup),
    sourceRevision,
    configuration: setup.draft,
    event: options.event ?? event
  }
}
const jobInput = jobInputFor()
const checkOutput = (candidate = sourceCommit, values = results, gate = "passed") => ({
  base: mainCommit,
  candidate,
  gate,
  results: values
})
const checks = (candidate = sourceCommit, values = results, gate = "passed") => ({
  stepId: "checks",
  status: "completed",
  summary: "1 checks passed",
  evidence: [],
  executionId: checkExecutionId,
  output: checkOutput(candidate, values, gate)
})
const result = (candidate = sourceCommit, values = results, gate = "passed", stepId = "feature") => ({
  stepId,
  status: "completed",
  summary: "Implemented",
  evidence: [],
  executionId: "job-run/implement",
  output: {
    status: "implemented",
    source,
    creation,
    checks: candidate === "" ? undefined : checks(candidate, values, gate)
  }
})

const resultCodec = Schema.toCodecJson(Flow.Result({ success: StepResult, error: CodingError }))
/** The run driver stores every payload through the flow's own JSON codec, so
 * these rows hold what the durable boundary holds, never the decoded value. */
const checkPayloadCodec = Schema.toCodecJson(CheckStep.payloadSchema)
/** FinishChange rechecks the retained source under exactly the delivered Work. */
const stepState = (
  options: { candidate?: string; values?: typeof results; flowName?: string; work?: unknown; parent?: string | null } =
    {}
) =>
  JSON.stringify({
    version: 1,
    flowName: options.flowName ?? CheckStep._tag,
    payload: Schema.encodeSync(checkPayloadCodec)({
      work: finalCheckWork((options.work ?? work) as never, { head: source as never, base: mainCommit })
    }),
    ...(options.parent === undefined || options.parent === null ? {} : { parentExecutionId: options.parent }),
    result: Schema.encodeSync(resultCodec)(
      new Flow.Complete({
        exit: Exit.succeed(
          Schema.decodeUnknownSync(StepResult)(
            checks(options.candidate ?? sourceCommit, options.values ?? results)
          )
        )
      })
    )
  })
const row = (
  id: string,
  stateJson: string,
  status: RunStore.RunRow["status"] = "completed",
  parentRunId: string | null = null
): RunStore.RunRow => ({
  runId: id,
  status,
  createdAtMs: 1,
  startedAtMs: 1,
  finishedAtMs: 2,
  owner: null,
  heartbeatAtMs: null,
  claim: null,
  claimedAtMs: null,
  parentRunId,
  cancelRequestedAtMs: null,
  stateJson
})
const jobState = JSON.stringify({ version: 1, flowName: "repository/RepositoryJob", payload: {} })
const bridgeState = (input: unknown = jobInput, flow = "repository-jobs/feature") =>
  JSON.stringify({ version: 1, flowName: flow, payload: { input } })
const rootState = (planId = "plan-1") => JSON.stringify({ version: 1, flowName: "agent/run", payload: { planId } })
const runSummary = (status: string, planId = "plan-1", runId = "control-run", flow = "repository-jobs/feature") => ({
  runId,
  flowId: flow,
  status,
  planId,
  planDigest: "digest-1",
  createdAt: 1,
  updatedAt: 2
})
const storedPlan = (decision = "approved", decodedInput: unknown = jobInput, flow = "repository-jobs/feature") => ({
  decision,
  decodedInput,
  card: {
    planId: "plan-1",
    flowId: flow,
    digest: "digest-1",
    inputSummary: "",
    envelope: { capabilities: [], flows: [], budget: {} },
    deployClass: false,
    executionDigest: ref.executionDigest,
    nodes: [],
    approval: {}
  }
})

/** The durable stores the verifier reads: a completed CheckStep under a job run
 * that is still delivering, under its registered bridge and approved root. */
const stores = (
  options: {
    rows?: Record<string, RunStore.RunRow>
    runStatus?: string
    decision?: string
    planId?: string
    planInput?: unknown
    bridge?: unknown
    rootId?: string
    flow?: string
    parents?: Record<string, readonly string[]>
  } = {}
) => {
  const rootId = options.rootId ?? "control-run", flow = options.flow ?? "repository-jobs/feature"
  const rows = options.rows ??
    {
      [checkExecutionId]: row(checkExecutionId, stepState(), "completed", "job-run"),
      "job-run": row("job-run", jobState, "running", "bridge-run"),
      "bridge-run": row("bridge-run", bridgeState(options.bridge, flow), "running", rootId),
      [rootId]: row(rootId, rootState(), "running", null)
    }
  const reads: string[] = []
  const control = {
    getRun: (runId: string) =>
      runId === rootId
        ? Effect.succeed(runSummary(options.runStatus ?? "running", options.planId, rootId, flow)) :
        Effect.fail(new RunNotFound({ code: "run_not_found", runId })),
    getPlan: () => Effect.succeed(storedPlan(options.decision, options.planInput ?? jobInput, flow))
  }
  return {
    reads,
    rows,
    layer: Layer.mergeAll(
      RunStore.layerNoop({
        get: (id) =>
          Effect.suspend(() => {
            reads.push(id)
            const found = rows[id]
            return found
              ? Effect.succeed(found)
              : Effect.fail(
                new RunStore.RunStoreError({
                  code: "not_found_row",
                  method: "get",
                  message: `Missing ${id}`,
                  cause: { runId: id }
                })
              )
          })
      }),
      Layer.succeed(
        DurableEngineState.DurableEngineState,
        {
          runParents: (childId: string) =>
            Effect.succeed(
              (options.parents?.[childId] ??
                (rows[childId]?.parentRunId === null || rows[childId]?.parentRunId === undefined
                  ? []
                  : [rows[childId]!.parentRunId!]))
                .map((parentId) => ({ parentId, childId }))
            )
        } as unknown as DurableEngineState.DurableEngineState["Service"]
      ),
      Layer.succeed(
        RunCatalogRead.RunCatalogRead,
        {
          listRuns: () => Effect.succeed({ source: "0".repeat(32), revision: 1, cursor: null, runs: [] }),
          listRunIds: () => Effect.succeed([])
        } as unknown as RunCatalogRead.Service
      ),
      Layer.succeed(ControlRuntime, control as unknown as ControlRuntime["Service"])
    )
  }
}

/** The private control identity ModuleAuthority restores at each native handler. */
const current = Layer.succeed(ModuleOwner, { rootId: "control-run", flowId: "repository-jobs/feature" })
const verify = (
  input: Parameters<typeof verifiedCheckStep>[0],
  layers: Layer.Layer<RunStore.RunStore | DurableEngineState.DurableEngineState | ControlRuntime> = stores().layer,
  owner: Layer.Layer<ModuleOwner> = current
) => Effect.runPromise(Effect.exit(verifiedCheckStep(input).pipe(Effect.provide(Layer.merge(layers, owner)))))
const request = {
  executionId: checkExecutionId,
  commitId: sourceCommit,
  baseCommitId: mainCommit,
  work,
  source,
  ref,
  checks: pinned.checks
}

test("the verifier accepts a completed CheckStep whose job is still awaiting landing", async () => {
  const verified = await verify(request)
  assert.equal(verified._tag, "Success")
  if (verified._tag !== "Success") return
  assert.deepEqual(verified.value, {
    runId: "control-run",
    executionId: checkExecutionId,
    candidate: sourceCommit,
    checks: [{ id: "verify", outcome: "passed" }, { id: "review", outcome: "skipped_no_matching_paths" }]
  })
})

test("the stored CheckStep payload is the encoded one the run driver writes", async () => {
  const stored = JSON.parse(stepState()) as { payload: { work: { evidence: { source: Record<string, unknown> } } } }
  assert.equal(
    "kind" in stored.payload.work.evidence.source,
    false,
    "the payload codec drops fields Revision does not declare"
  )
  assert.equal(stored.payload.work.evidence.source.commitId, sourceCommit)
  const verified = await verify(request)
  assert.equal(verified._tag, "Success")
})

test("completedJob still refuses the running job the verifier accepts", async () => {
  const f = stores()
  const refused = await Effect.runPromise(
    Effect.exit(
      completedJob("control-run", { repo, job: "feature", revision: 7, digest: "e".repeat(64) }, {
        source: "smithers-cloud",
        issueNumber: 0
      }).pipe(Effect.provide(f.layer))
    )
  )
  assert.equal(refused._tag, "Success")
  assert.equal(
    refused._tag === "Success" ? refused.value : "read",
    undefined,
    "a running control run is not a completed job"
  )
})

const running = (id: string, state: string, parent: string | null) => row(id, state, "running", parent)
for (
  const [name, input, layers] of [
    ["a fabricated execution id", { ...request, executionId: "no-such-execution" }, stores().layer],
    [
      "another run's CheckStep result",
      { ...request, executionId: "other-check" },
      stores({
        rows: {
          "other-check": row("other-check", stepState(), "completed", "other-job"),
          "other-job": row("other-job", jobState, "running", null)
        }
      }).layer
    ],
    [
      "a cancelled parent",
      request,
      stores({
        rows: {
          [checkExecutionId]: row(checkExecutionId, stepState(), "completed", "job-run"),
          "job-run": row("job-run", jobState, "cancelled", "bridge-run"),
          "bridge-run": running("bridge-run", bridgeState(), "control-run"),
          "control-run": running("control-run", rootState(), null)
        }
      }).layer
    ],
    [
      "a failed parent",
      request,
      stores({
        rows: {
          [checkExecutionId]: row(checkExecutionId, stepState(), "completed", "job-run"),
          "job-run": row("job-run", jobState, "failed", "bridge-run"),
          "bridge-run": running("bridge-run", bridgeState(), "control-run"),
          "control-run": running("control-run", rootState(), null)
        }
      }).layer
    ],
    ["a cancelled control run", request, stores({ runStatus: "cancelled" }).layer],
    ["an unapproved plan", request, stores({ decision: "pending" }).layer],
    ["ambiguous ancestry", request, stores({ parents: { [checkExecutionId]: ["job-run", "other-job"] } }).layer],
    ["a candidate that is not the delivered commit", { ...request, commitId: "c1".repeat(20) }, stores().layer],
    [
      "a check id reused under another policy digest",
      request,
      stores({
        rows: {
          [checkExecutionId]: row(
            checkExecutionId,
            stepState({ work: workFor(readPinned(8)) }),
            "completed",
            "job-run"
          ),
          "job-run": running("job-run", jobState, "bridge-run"),
          "bridge-run": running("bridge-run", bridgeState(), "control-run"),
          "control-run": running("control-run", rootState(), null)
        }
      }).layer
    ],
    [
      "an incomplete CheckStep execution",
      request,
      stores({ rows: { [checkExecutionId]: row(checkExecutionId, stepState(), "running", "job-run") } }).layer
    ],
    [
      "a required check reported by another flow",
      request,
      stores({
        rows: {
          [checkExecutionId]: row(checkExecutionId, stepState({ flowName: "user/Flow" }), "completed", "job-run"),
          "job-run": running("job-run", jobState, "bridge-run"),
          "bridge-run": running("bridge-run", bridgeState(), "control-run"),
          "control-run": running("control-run", rootState(), null)
        }
      }).layer
    ],
    ["a required check with no result", {
      ...request,
      ref: { ...ref, requiredCheckIds: ["verify", "review", "missing"] }
    }, stores().layer],
    [
      "a required check that failed",
      request,
      stores({
        rows: {
          [checkExecutionId]: row(
            checkExecutionId,
            stepState({
              values: [{ ...results[0]!, status: "failed" }, results[1]!, results[2]!]
            }),
            "completed",
            "job-run"
          ),
          "job-run": running("job-run", jobState, "bridge-run"),
          "bridge-run": running("bridge-run", bridgeState(), "control-run"),
          "control-run": running("control-run", rootState(), null)
        }
      }).layer
    ],
    // The five mutations the independent review measured as wrongly accepted.
    [
      "a checked Work pinned to another repository identity",
      request,
      stores({
        rows: {
          [checkExecutionId]: row(
            checkExecutionId,
            stepState({ work: { ...work, policy: { ...pinned, ref: { ...ref, repositoryId: 9 } } } }),
            "completed",
            "job-run"
          ),
          "job-run": running("job-run", jobState, "bridge-run"),
          "bridge-run": running("bridge-run", bridgeState(), "control-run"),
          "control-run": running("control-run", rootState(), null)
        }
      }).layer
    ],
    [
      "a checked Work carrying no configured checks",
      request,
      stores({
        rows: {
          [checkExecutionId]: row(
            checkExecutionId,
            stepState({ work: { ...work, checks: [] } }),
            "completed",
            "job-run"
          ),
          "job-run": running("job-run", jobState, "bridge-run"),
          "bridge-run": running("bridge-run", bridgeState(), "control-run"),
          "control-run": running("control-run", rootState(), null)
        }
      }).layer
    ],
    [
      "a checked Work from another repository",
      request,
      stores({
        rows: {
          [checkExecutionId]: row(
            checkExecutionId,
            stepState({ work: { ...work, repo: "other/repo" } }),
            "completed",
            "job-run"
          ),
          "job-run": running("job-run", jobState, "bridge-run"),
          "bridge-run": running("bridge-run", bridgeState(), "control-run"),
          "control-run": running("control-run", rootState(), null)
        }
      }).layer
    ],
    [
      "a control root with an extra ancestry parent",
      request,
      stores({ parents: { "control-run": ["above-the-root"] } }).layer
    ],
    [
      "an approved plan naming another input",
      request,
      stores({ planInput: jobInputFor({ repo: "other/repo" }) }).layer
    ],
    ["an approved plan the root does not name", request, stores({ planId: "plan-2" }).layer],
    [
      "a registered bridge dispatch for another repository",
      request,
      stores({ bridge: jobInputFor({ repo: "other/repo" }) }).layer
    ],
    [
      "a registered bridge dispatch without this step",
      request,
      stores({ bridge: jobInputFor({ steps: [{ ...step, prompt: "Something else" }] }) }).layer
    ]
  ] as const
) {
  test(`the verifier refuses ${name}`, async () => {
    const refused = await verify(input as Parameters<typeof verifiedCheckStep>[0], layers)
    assert.equal(refused._tag, "Failure")
  })
}

test("the verifier refuses a user-authored root flow that imitates the built-in job", async () => {
  const f = stores()
  const impostor = Layer.mergeAll(
    f.layer,
    Layer.succeed(
      ControlRuntime,
      {
        getRun: (runId: string) =>
          runId === "control-run"
            ? Effect.succeed({ ...runSummary("running"), flowId: "user/my-flow" }) :
            Effect.fail(new RunNotFound({ code: "run_not_found", runId })),
        getPlan: () => Effect.succeed({ ...storedPlan(), card: { ...storedPlan().card, flowId: "user/my-flow" } })
      } as unknown as ControlRuntime["Service"]
    )
  )
  const refused = await verify(request, impostor)
  assert.equal(refused._tag, "Failure")
})

test("the verifier refuses an approved proof that belongs to another current delivery root", async () => {
  const other = stores({ rootId: "another-current-delivery-root" })
  assert.equal((await verify(request, other.layer))._tag, "Failure")
})

test("the verifier refuses a durable result compared against another base", async () => {
  assert.equal((await verify({ ...request, baseCommitId: "c1".repeat(20) }))._tag, "Failure")
})

test("the verifier refuses when this host supplies no approved control owner", async () => {
  const code = await Effect.runPromise(
    verifiedCheckStep(request).pipe(Effect.provide(stores().layer), Effect.catch((error) => Effect.succeed(error.code)))
  )
  assert.equal(code, "unavailable")
})

test("an unreadable store is an unavailable failure, never a pass", async () => {
  const broken = Layer.mergeAll(
    RunStore.layerNoop({
      get: () =>
        Effect.fail(
          new RunStore.RunStoreError({ code: "persistence_failed", method: "get", message: "disk", cause: {} })
        )
    }),
    Layer.succeed(
      DurableEngineState.DurableEngineState,
      { runParents: () => Effect.succeed([]) } as unknown as DurableEngineState.DurableEngineState["Service"]
    ),
    Layer.succeed(
      ControlRuntime,
      {
        getRun: (runId: string) => Effect.fail(new RunNotFound({ code: "run_not_found", runId })),
        getPlan: () => Effect.die("no plan")
      } as unknown as ControlRuntime["Service"]
    )
  )
  assert.equal((await verify(request, broken))._tag, "Failure")
  const code = await Effect.runPromise(
    verifiedCheckStep(request).pipe(Effect.provide(broken), Effect.catch((error) => Effect.succeed(error.code)))
  )
  assert.equal(code, "unavailable")
})

test("a local check never reports or satisfies a required inherited id", async () => {
  const impersonating = [{ ...results[0]!, checkId: "verify" }, results[1]!, results[2]!]
  const f = stores({
    rows: {
      [checkExecutionId]: row(checkExecutionId, stepState({ values: impersonating }), "completed", "job-run"),
      "job-run": running("job-run", jobState, "bridge-run"),
      "bridge-run": running("bridge-run", bridgeState(), "control-run"),
      "control-run": running("control-run", rootState(), null)
    }
  })
  assert.equal((await verify(request, f.layer))._tag, "Failure")
})

test("a passing local check never reaches the reserved CI receipt", async () => {
  const passing = [results[0]!, results[1]!, { ...results[2]!, status: "passed" }]
  const f = stores({
    rows: {
      [checkExecutionId]: row(checkExecutionId, stepState({ values: passing }), "completed", "job-run"),
      "job-run": running("job-run", jobState, "bridge-run"),
      "bridge-run": running("bridge-run", bridgeState(), "control-run"),
      "control-run": running("control-run", rootState(), null)
    }
  })
  const verified = await verify(request, f.layer)
  assert.equal(verified._tag, "Success")
  if (verified._tag !== "Success") return
  assert.deepEqual(verified.value.checks, [{ id: "verify", outcome: "passed" }, {
    id: "review",
    outcome: "skipped_no_matching_paths"
  }])
})

test("two reviewed rules that map to one inherited id refuse rather than guess", async () => {
  const refused = await verify({ ...request, checks: [pinned.checks[0]!, pinned.checks[0]!] })
  assert.equal(refused._tag, "Failure")
})

/** A scripted Plue that records every receipt request it is asked to store. */
const plue = async (
  t: TestContext,
  respond: (requestId: string, count: number, body: unknown) => { status: number; body: unknown }
) => {
  const seen: Array<{ method: string; url: string; authorization: string; body: unknown }> = []
  let count = 0
  const server: Server = createServer((incoming: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = []
    incoming.on("data", (chunk) => chunks.push(chunk as Buffer))
    incoming.on("end", () => {
      seen.push({
        method: incoming.method ?? "",
        url: incoming.url ?? "",
        authorization: incoming.headers.authorization ?? "",
        body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "null")
      })
      const answer = respond((incoming.url ?? "").split("/").at(-1) ?? "", count++, seen.at(-1)!.body)
      response.writeHead(answer.status, { "content-type": "application/json" })
      response.end(JSON.stringify(answer.body))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  t.after(() =>
    new Promise<void>((resolve) => {
      server.close(() => resolve())
    })
  )
  return { seen, port: (server.address() as AddressInfo).port }
}
const stored = (requestId: string, policy = pinned) => ({
  status: 201,
  body: {
    request_id: requestId,
    context: `repository-ci/${registrationId}@${policy.ref.revision}.${policy.ref.digest.slice(0, 12)}`,
    commit_id: sourceCommit,
    status: "success",
    status_id: 5
  }
})

/** Plue's own acceptance rule: only ids the stored policy holds, and every
 * required one, exactly once (L5 amendment A2). */
const plueRule = (policy = pinned) => (requestId: string, _count: number, body: unknown) => {
  const sent = ((body as { checks?: ReadonlyArray<{ id: string }> }).checks ?? []).map((check) => check.id)
  if (sent.some((id) => !policy.checks.some((check) => check.id === id))) {
    return { status: 422, body: { code: "repository_ci_check_unknown" } }
  }
  if (new Set(sent).size !== sent.length) return { status: 400, body: { code: "repository_ci_check_duplicate" } }
  if (policy.ref.requiredCheckIds.some((id) => !sent.includes(id))) {
    return { status: 422, body: { code: "repository_ci_check_uncovered" } }
  }
  return stored(requestId, policy)
}
const gatewayId = "44444444-4444-4444-a444-444444444444"
const landing = (calls: string[]): BackendLanding => ({
  kind: "backend",
  binding: { repositoryId: 3, workspaceId },
  readMain: Effect.sync(() => {
    calls.push("readMain")
    return mainCommit
  }),
  pinMain: Effect.die("repository delivery reads main"),
  readDelivery: Effect.die("repository delivery does not read the vibe policy"),
  openPull: () => Effect.die("repository delivery opens no pull request"),
  prepare: (input) =>
    Effect.sync(() => {
      calls.push("prepare")
      return { ...input, status: "prepared" as const, changes: [{ change_id: changeId, commit_id: sourceCommit }] }
    }),
  create: (requestId) =>
    Effect.sync(() => {
      calls.push("create")
      return { requestId, number: 1 }
    }),
  queue: (identity, preparation, request) =>
    Effect.sync(() => {
      calls.push("queue")
      return { ...identity, taskId: 1, preparation, request }
    }),
  observe: (queued) =>
    Effect.sync(() => {
      calls.push("observe")
      return {
        status: "landed" as const,
        task_id: 1,
        request: {
          change_ids: [sourceCommit],
          target_bookmark: "main" as const,
          expected_commit_id: mainCommit,
          operation_key: "fixture",
          append: {
            source_commit_id: sourceCommit,
            source_base_commit_id: mainCommit,
            description: queued.request.description
          }
        },
        result: { landed_count: 1, target_bookmark: "main" as const, target_commit_id: sourceCommit }
      }
    })
})
const native = {
  sourcePublication: "cloud" as const,
  read: () => Effect.die("no read"),
  apply: () => Effect.die("no apply"),
  publishOriginalSource: (input: { requestId: string }) =>
    Effect.succeed({
      status: "retained" as const,
      requestId: input.requestId,
      workspaceId,
      repositoryId: 3,
      ref: `refs/smithers/workspaces/${workspaceId}/sources/${sourceCommit}`,
      source: { changeId, commitId: sourceCommit, treeId: sourceTree, parentCommitIds: [mainCommit] }
    })
}

const deliver = async (
  t: TestContext,
  options: {
    port?: number
    work?: unknown
    publisher?: boolean
    store?: ReturnType<typeof stores>
    retryMs?: number
    values?: typeof results
    gate?: string
    owner?: Layer.Layer<ModuleOwner>
    stepId?: string
  }
) => {
  const calls: string[] = []
  const f = options.store ?? stores()
  const receipts = Layer.effect(RepositoryCheckReceipts)(
    make({
      apiBaseUrl: `http://127.0.0.1:${options.port}/api`,
      gatewayId,
      credential: "gateway-credential",
      repositorySlug: repo,
      workspaceId,
      unverifiedRunRetryMs: options.retryMs ?? 1
    })
  )
    .pipe(Layer.provide(NodeHttpClient.layerUndici))
  const services = Layer.mergeAll(
    Layer.succeed(NativeCoding, native as unknown as NativeCoding["Service"]),
    Layer.succeed(Landing, landing(calls)),
    f.layer,
    options.owner ?? current
  )
  const runtime = ManagedRuntime.make(Delivery.deliveryLayers.pipe(
    Layer.provide(options.publisher === false ? services : Layer.merge(services, receipts.pipe(Layer.orDie))),
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(FlowEngine.layerMemory),
    Layer.provideMerge(NodeCrypto.layer)
  ))
  t.after(() => runtime.dispose())
  const payload = {
    work: options.work ?? work,
    result: result(sourceCommit, options.values ?? results, options.gate, options.stepId)
  }
  const run = (executionId = "delivery") =>
    runtime.runPromise(Delivery.DeliverChange.execute(payload as never, { executionId }))
  return { calls, run, reads: f.reads }
}
const failure = (output: typeof StepResult.Type) =>
  (output.output as { deliveryError?: { code?: string } }).deliveryError?.code

test("a pinned policy reports the receipt with the gateway credential before any landing exists", async (t) => {
  const store = await plue(t, (requestId) => stored(requestId))
  const f = await deliver(t, { port: store.port })
  const output = await f.run()
  assert.equal(output.status, "completed", output.summary)
  assert.equal(store.seen.length, 1)
  const seen = store.seen[0]!
  assert.equal(seen.method, "PUT")
  assert.equal(seen.authorization, "Bearer gateway-credential")
  assert.match(seen.url, new RegExp(`^/api/gateways/${gatewayId}/repository-jobs/ci/check-receipts/[0-9a-f-]{36}$`))
  assert.deepEqual(seen.body, {
    repo,
    workspace_id: workspaceId,
    registration_id: registrationId,
    revision: ref.revision,
    digest: ref.digest,
    execution_digest: ref.executionDigest,
    run_id: "control-run",
    execution_id: checkExecutionId,
    commit_id: sourceCommit,
    change_id: changeId,
    base_commit_id: mainCommit,
    gate: "passed",
    checks: [{ id: "verify", outcome: "passed" }, { id: "review", outcome: "skipped_no_matching_paths" }]
  })
  assert.deepEqual(f.calls, ["readMain", "prepare", "create", "queue", "observe"])
})

test("a replay sends the identical request id and creates exactly one landing", async (t) => {
  const store = await plue(t, (requestId) => stored(requestId))
  const f = await deliver(t, { port: store.port })
  const first = await f.run()
  const second = await f.run()
  assert.deepEqual(second, first)
  assert.equal(store.seen.length, 1, "a durable replay never repeats the receipt")
  assert.equal(f.calls.filter((call) => call === "create").length, 1)
})

for (
  const [status, expected] of [[409, /policy/i], [422, /required/i], [404, /policy/i], [503, /unavailable|store/i], [
    403,
    /refus|receipt/i
  ]] as const
) {
  test(`HTTP ${status} fails delivery before the landing request is created`, async (t) => {
    const store = await plue(t, () => ({ status, body: { error: "refused" } }))
    const f = await deliver(t, { port: store.port })
    const output = await f.run()
    assert.equal(output.status, "needs-maintainer")
    assert.match(output.summary, expected)
    assert.equal(store.seen.length, 1)
    assert.deepEqual(f.calls, ["readMain", "prepare"], "no landing request is opened for an unproven source")
  })
}

test("an authoritative none policy delivers exactly as today with no receipt call", async (t) => {
  const store = await plue(t, () => ({ status: 500, body: {} }))
  const none = workFor({ kind: "none" })
  const f = await deliver(t, {
    port: store.port,
    work: none,
    store: stores({
      rows: { [checkExecutionId]: row(checkExecutionId, stepState({ work: none }), "completed", "job-run") }
    })
  })
  const output = await f.run()
  assert.equal(output.status, "completed")
  assert.equal(store.seen.length, 0)
  assert.deepEqual(f.calls, ["readMain", "prepare", "create", "queue", "observe"])
})

test("an unreadable policy refuses the delivery payload and is never treated as none", async (t) => {
  const store = await plue(t, () => ({ status: 201, body: {} }))
  const f = await deliver(t, {
    port: store.port,
    work: { ...work, policy: { kind: "pinned", ref: { ...ref, revision: 0 }, checks: [] } }
  })
  await assert.rejects(f.run(), "a malformed pinned policy never reaches the delivering flow")
  assert.equal(store.seen.length, 0)
  assert.deepEqual(f.calls, [])
})

test("a pinned policy with no receipt publisher fails delivery before Create", async (t) => {
  const f = await deliver(t, { publisher: false })
  const output = await f.run()
  assert.equal(output.status, "needs-maintainer")
  assert.equal(failure(output), "unavailable")
  assert.match(output.summary, /receipt publisher/i)
  assert.deepEqual(f.calls, ["readMain", "prepare"], "no landing request is opened without a receipt publisher")
})

test("an authoritative none policy still delivers without a receipt publisher", async (t) => {
  const none = workFor({ kind: "none" })
  const f = await deliver(t, {
    publisher: false,
    work: none,
    store: stores({
      rows: { [checkExecutionId]: row(checkExecutionId, stepState({ work: none }), "completed", "job-run") }
    })
  })
  const output = await f.run()
  assert.equal(output.status, "completed")
  assert.deepEqual(f.calls, ["readMain", "prepare", "create", "queue", "observe"])
})

test("the pinned policy is read from the job, and a malformed one is never none", async () => {
  assert.deepEqual(await Effect.runPromise(pinnedPolicy({ ...work, policy: undefined })), { kind: "none" })
  assert.deepEqual(await Effect.runPromise(pinnedPolicy(work)), pinned)
  const malformed = await Effect.runPromise(
    Effect.exit(pinnedPolicy({ ...work, policy: { kind: "pinned", ref: { ...ref, revision: 0 }, checks: [] } }))
  )
  assert.equal(malformed._tag, "Failure")
})

const fakeRemote = (registrations: () => unknown) =>
  Layer.succeed(
    RepositoryRemote,
    RepositoryRemote.of({
      repo,
      workspaceId,
      registrations: Effect.sync(() => registrations() as Schema.Json),
      history: Effect.succeed({ records: [], sources: [] }),
      register: () => Effect.succeed(null),
      pause: () => Effect.succeed(null),
      dispatches: () => Effect.succeed(null),
      createTrial: () => Effect.succeed(null)
    })
  )

test("a policy replaced after the pre-delivery re-read still refuses at the receipt with no landing", async (t) => {
  let served: unknown[] = [registrationRow(7)]
  const remote = fakeRemote(() => served)
  const current = await Effect.runPromise(Effect.exit(revalidateCiPolicy(repo, pinned).pipe(Effect.provide(remote))))
  assert.equal(current._tag, "Success", "the pre-delivery re-read sees the pinned policy")
  served = [registrationRow(8)]
  const store = await plue(t, () => ({ status: 409, body: { error: "replaced" } }))
  const f = await deliver(t, { port: store.port })
  const output = await f.run()
  assert.equal(output.status, "needs-maintainer")
  assert.equal(failure(output), "stale_revision")
  assert.equal(store.seen.length, 1)
  assert.deepEqual(f.calls, ["readMain", "prepare"], "the receipt PUT closes the window the re-read leaves open")
  const stale = await Effect.runPromise(Effect.exit(revalidateCiPolicy(repo, pinned).pipe(Effect.provide(remote))))
  assert.equal(stale._tag, "Failure")
})

const advisoryPolicy = readPinned(9, advisory)
const advisoryWork = workFor(advisoryPolicy)
const advisoryResult = (
  status: string
) => [{
  checkId: inherited("shape", advisoryPolicy),
  policy: "report",
  status,
  summary: "Advisory",
  evidence: [],
  executionId: `${checkExecutionId}/shape`,
  detail: null
}]
const advisoryStore = (status: string) =>
  stores({
    rows: {
      [checkExecutionId]: row(
        checkExecutionId,
        stepState({ work: advisoryWork, values: advisoryResult(status) as typeof results }),
        "completed",
        "job-run"
      ),
      "job-run": running("job-run", jobState, "bridge-run"),
      "bridge-run": running("bridge-run", bridgeState(), "control-run"),
      "control-run": running("control-run", rootState(), null)
    }
  })

test("an advisory-only policy whose report rule failed still attests the passed gate", async (t) => {
  const store = await plue(t, (requestId) => stored(requestId, advisoryPolicy))
  const f = await deliver(t, {
    port: store.port,
    work: advisoryWork,
    store: advisoryStore("failed"),
    values: advisoryResult("failed") as typeof results
  })
  const output = await f.run()
  assert.equal(output.status, "completed", output.summary)
  assert.equal(store.seen.length, 1)
  assert.deepEqual((store.seen[0]!.body as { checks: unknown }).checks, [])
  assert.deepEqual(f.calls, ["readMain", "prepare", "create", "queue", "observe"])
})

test("an advisory-only policy lists a report rule that passed", async (t) => {
  const store = await plue(t, (requestId) => stored(requestId, advisoryPolicy))
  const f = await deliver(t, {
    port: store.port,
    work: advisoryWork,
    store: advisoryStore("passed"),
    values: advisoryResult("passed") as typeof results
  })
  const output = await f.run()
  assert.equal(output.status, "completed", output.summary)
  assert.deepEqual((store.seen[0]!.body as { checks: unknown }).checks, [{ id: "shape", outcome: "passed" }])
})

test("one required rule with empty coverage refuses before any receipt is sent", async (t) => {
  const store = await plue(t, (requestId) => stored(requestId))
  const values = [{ ...results[0]!, status: "error" }, { ...results[1]!, status: "error" }] as typeof results
  const f = await deliver(t, {
    port: store.port,
    values,
    store: stores({
      rows: {
        [checkExecutionId]: row(checkExecutionId, stepState({ values }), "completed", "job-run"),
        "job-run": running("job-run", jobState, "bridge-run"),
        "bridge-run": running("bridge-run", bridgeState(), "control-run"),
        "control-run": running("control-run", rootState(), null)
      }
    })
  })
  const output = await f.run()
  assert.equal(output.status, "needs-maintainer")
  assert.equal(store.seen.length, 0)
  assert.deepEqual(f.calls, ["readMain", "prepare"])
})

const unverified = {
  status: 403,
  body: { code: "repository_ci_run_unverified", message: "dispatch has no run id yet" }
}

test("a lost Run acknowledgement retries the same receipt and lands once", async (t) => {
  const store = await plue(t, (requestId, count) => count < 2 ? unverified : stored(requestId))
  const f = await deliver(t, { port: store.port })
  const output = await f.run()
  assert.equal(output.status, "completed", output.summary)
  assert.equal(store.seen.length, 3)
  assert.equal(new Set(store.seen.map((seen) => seen.url)).size, 1, "every attempt reuses the one durable request id")
  assert.equal(f.calls.filter((call) => call === "create").length, 1)
  assert.equal(
    f.reads.filter((id) => id === checkExecutionId).length,
    1,
    "a retry never re-runs or re-reads the checks"
  )
})

test("a dispatch that never records its run id fails delivery with no landing request", async (t) => {
  const store = await plue(t, () => unverified)
  const f = await deliver(t, { port: store.port })
  const output = await f.run()
  assert.equal(output.status, "needs-maintainer")
  assert.equal(failure(output), "unavailable")
  assert.equal(store.seen.length, 5, "the retry is bounded")
  assert.deepEqual(f.calls, ["readMain", "prepare"])
})

test("a 403 that names no retryable code refuses immediately", async (t) => {
  const store = await plue(t, () => ({ status: 403, body: { code: "repository_job_forbidden" } }))
  const f = await deliver(t, { port: store.port })
  const output = await f.run()
  assert.equal(output.status, "needs-maintainer")
  assert.equal(failure(output), "invalid_receipt")
  assert.equal(store.seen.length, 1)
})

test("a hundred-character non-ASCII raw id reaches the receipt body unchanged", async (t) => {
  const rawId = "проверка-✅-".repeat(10).slice(0, 100)
  assert.equal(rawId.length, 100)
  const policy = readPinned(11, [{ ...reviewed[0]!, id: rawId }])
  const unicodeWork = workFor(policy)
  const values = [{ ...results[0]!, checkId: inherited(rawId, policy) }] as typeof results
  const store = await plue(t, (requestId) => stored(requestId, policy))
  const f = await deliver(t, {
    port: store.port,
    work: unicodeWork,
    values,
    store: stores({
      rows: {
        [checkExecutionId]: row(checkExecutionId, stepState({ work: unicodeWork, values }), "completed", "job-run"),
        "job-run": running("job-run", jobState, "bridge-run"),
        "bridge-run": running("bridge-run", bridgeState(), "control-run"),
        "control-run": running("control-run", rootState(), null)
      }
    })
  })
  const output = await f.run()
  assert.equal(output.status, "completed", output.summary)
  assert.deepEqual((store.seen[0]!.body as { checks: unknown }).checks, [{ id: rawId, outcome: "passed" }])
})

test("a disjoint local check leaves the CI receipt acceptable to Plue's own rule", async (t) => {
  const store = await plue(t, plueRule())
  const passing = [results[0]!, results[1]!, { ...results[2]!, status: "passed" }] as typeof results
  const f = await deliver(t, {
    port: store.port,
    values: passing,
    store: stores({
      rows: {
        [checkExecutionId]: row(checkExecutionId, stepState({ values: passing }), "completed", "job-run"),
        "job-run": running("job-run", jobState, "bridge-run"),
        "bridge-run": running("bridge-run", bridgeState(), "control-run"),
        "control-run": running("control-run", rootState(), null)
      }
    })
  })
  const output = await f.run()
  assert.equal(output.status, "completed", output.summary)
  assert.deepEqual((store.seen[0]!.body as { checks: unknown }).checks, [{ id: "verify", outcome: "passed" }, {
    id: "review",
    outcome: "skipped_no_matching_paths"
  }])
  assert.deepEqual(f.calls, ["readMain", "prepare", "create", "queue", "observe"])
})

test("a required local check that failed blocks delivery before any receipt", async (t) => {
  const store = await plue(t, plueRule())
  const values = [results[0]!, results[1]!, { ...results[2]!, policy: "required", status: "failed" }] as typeof results
  const f = await deliver(t, { port: store.port, values, gate: "blocked" })
  const output = await f.run()
  assert.equal(output.status, "needs-maintainer")
  assert.match(output.summary, /checks/i)
  assert.equal(store.seen.length, 0, "a blocked native gate never reaches the CI receipt")
  assert.deepEqual(f.calls, [], "a blocked gate refuses before any landing interaction")
})

test("the receipt action is not model invocable", () => {
  assert.deepEqual(Object.keys(Delivery).sort(), ["DeliverChange", "deliveryLayers"])
})

// The one case neither host lane could run alone: a push-triggered chore on the
// default branch delivering under a pinned required CI rule. FinishChange
// rewrote the event payload to the produced change's own candidate and base;
// the verifier rebuilds exactly that payload through the same finalCheckWork,
// so the triggering push stays provenance and never becomes the checked source.
const chorePush = {
  ref: "refs/heads/main",
  before: "c1".repeat(20),
  after: mainCommit,
  created: false,
  deleted: false,
  repository: { default_branch: "main" },
  candidateCommitId: mainCommit,
  baseCommitId: "c1".repeat(20)
}
const choreStep = { id: "chore", name: "Chore", mode: "automatic" as const, prompt: "Update code.txt" }
const choreEvent = {
  source: "github" as const,
  type: "push",
  action: "",
  deliveryKey: "github:signed-push",
  payload: chorePush
}
const choreWork = { ...workFor(pinned), job: "chores" as const, step: choreStep, event: choreEvent }
const choreJobInput = jobInputFor({ job: "chores", steps: [choreStep], event: choreEvent })
const choreOwner = Layer.succeed(ModuleOwner, { rootId: "control-run", flowId: "repository-jobs/chores" })
const choreStores = (options: { rows?: Record<string, RunStore.RunRow> } = {}) =>
  stores({
    flow: "repository-jobs/chores",
    bridge: choreJobInput,
    planInput: choreJobInput,
    rows: options.rows ??
      {
        [checkExecutionId]: row(checkExecutionId, stepState({ work: choreWork }), "completed", "job-run"),
        "job-run": row("job-run", jobState, "running", "bridge-run"),
        "bridge-run": row("bridge-run", bridgeState(choreJobInput, "repository-jobs/chores"), "running", "control-run"),
        "control-run": row("control-run", rootState(), "running", null)
      }
  })
const choreRequest = {
  executionId: checkExecutionId,
  commitId: sourceCommit,
  baseCommitId: mainCommit,
  work: choreWork,
  source,
  ref,
  checks: pinned.checks
}

test("a push chore under a pinned CI policy reports the receipt and lands the produced change", async (t) => {
  const store = await plue(t, plueRule())
  const f = await deliver(t, {
    port: store.port,
    work: choreWork,
    store: choreStores(),
    owner: choreOwner,
    stepId: "chore"
  })
  const output = await f.run("chore-delivery")
  assert.equal(output.status, "completed", output.summary)
  assert.equal(store.seen.length, 1)
  assert.deepEqual(store.seen[0]!.body, {
    repo,
    workspace_id: workspaceId,
    registration_id: registrationId,
    revision: ref.revision,
    digest: ref.digest,
    execution_digest: ref.executionDigest,
    run_id: "control-run",
    execution_id: checkExecutionId,
    commit_id: sourceCommit,
    change_id: changeId,
    base_commit_id: mainCommit,
    gate: "passed",
    checks: [{ id: "verify", outcome: "passed" }, { id: "review", outcome: "skipped_no_matching_paths" }]
  })
  assert.deepEqual(
    f.calls,
    ["readMain", "prepare", "create", "queue", "observe"],
    "the landing request follows the accepted receipt"
  )
  const stored = JSON.parse(choreStores().rows[checkExecutionId]!.stateJson) as {
    payload: { work: { event: { payload: Record<string, unknown> } } }
  }
  assert.deepEqual(stored.payload.work.event.payload, {
    trigger: chorePush,
    candidateCommitId: sourceCommit,
    baseCommitId: mainCommit
  }, "the checked payload names the produced change, with the push retained as provenance")
})

test("the same push chore refuses when the verifier is handed the trigger's after commit", async () => {
  const triggerSource = { ...source, commitId: chorePush.after, parentCommitIds: [chorePush.before] }
  const refused = await verify({ ...choreRequest, source: triggerSource }, choreStores().layer, choreOwner)
  assert.equal(refused._tag, "Failure")
  assert.match(String(refused._tag === "Failure" ? refused.cause : ""), /does not match its claimed flow and input/)
  const accepted = await verify(choreRequest, choreStores().layer, choreOwner)
  assert.equal(accepted._tag, "Success", "the produced change's own payload still verifies")
})

test("a failing required inherited check blocks the push chore before any receipt", async (t) => {
  const store = await plue(t, plueRule())
  const failing = results.map((value) =>
    value.checkId === inherited("verify") ? { ...value, status: "failed", summary: "Exit 7" } : value
  )
  const f = await deliver(t, {
    port: store.port,
    work: choreWork,
    owner: choreOwner,
    stepId: "chore",
    values: failing as typeof results,
    store: choreStores({
      rows: {
        [checkExecutionId]: row(
          checkExecutionId,
          stepState({ work: choreWork, values: failing as typeof results }),
          "completed",
          "job-run"
        ),
        "job-run": row("job-run", jobState, "running", "bridge-run"),
        "bridge-run": row("bridge-run", bridgeState(choreJobInput, "repository-jobs/chores"), "running", "control-run"),
        "control-run": row("control-run", rootState(), "running", null)
      }
    })
  })
  const output = await f.run("chore-blocked")
  assert.equal(output.status, "needs-maintainer")
  assert.equal(store.seen.length, 0, "a required inherited rule that failed never reaches Plue")
  assert.deepEqual(f.calls, ["readMain", "prepare"], "no landing request is opened")
})
