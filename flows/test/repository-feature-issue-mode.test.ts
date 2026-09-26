import { NodeServices } from "@effect/platform-node"
import { FlowRuntime } from "@smthrs/flow"
import { Effect, FileSystem, Layer, Schema } from "effect"
import assert from "node:assert/strict"
import { test } from "node:test"
import { initialSetup, setupCandidate } from "../../packages/rpc/src/RepositorySetup.ts"
import * as Jj from "../../packages/smithers/flows/jj/src/Jj.ts"
import { NativeCoding } from "../coding/native.ts"
import { normalEvents } from "../repository/activation.ts"
import { executionLayers, selectedSteps } from "../repository/execution.ts"
import { ApproveStep, RunSteps } from "../repository/jobs.ts"
import { Draft, type JobInput, type SetupInput } from "../repository/schema.ts"
import { makeHostJudge } from "./fixtures/scripted-judge.ts"

const modes = ["automatic", "approved", "manual", "off"] as const
const lifecycle = ["opened", "edited", "reopened", "labeled"] as const
const issueEvents = { type: "issues", actions: ["opened", "edited", "reopened", "labeled"] }
const candidate = (job: JobInput["job"], mode: typeof modes[number], connectIssues = false) => {
  const initial = initialSetup("example/repo", job, "maintainer")
  return {
    ...initial,
    draft: { ...initial.draft, connectIssues, steps: initial.draft.steps.map((step) => ({ ...step, mode })) }
  }
}
const registered = (job: JobInput["job"], mode: typeof modes[number], connectIssues = false) => {
  const setup = candidate(job, mode, connectIssues)
  const input: SetupInput = {
    requestId: "feature-issue-mode",
    repo: setup.repo,
    job,
    operation: "apply",
    revision: setup.revision,
    digest: setupCandidate(setup),
    draft: setup.draft as typeof Draft.Type
  }
  return normalEvents(input)
}
const issue = { number: 7, title: "Add the adapter", body: "Implement the requested adapter" }
const selected = (job: JobInput["job"], mode: typeof modes[number], event: Partial<JobInput["event"]> = {}) =>
  selectedSteps({
    job,
    configuration: candidate(job, mode).draft as typeof Draft.Type,
    event: {
      source: "smithers-cloud",
      type: "issues",
      action: "opened",
      deliveryKey: "delivery-1",
      issueNumber: issue.number,
      payload: { issue },
      ...event
    }
  }).map((step) => step.id)

test("the feature job registers issue lifecycle events only in the modes that run them, and never comments", () => {
  for (const mode of modes) {
    assert.deepEqual(
      registered("feature", mode),
      mode === "automatic" || mode === "approved" ? [issueEvents] : [],
      mode
    )
  }
})

test("the other four jobs keep the events they already registered", () => {
  const pullRequest = { type: "pull_request", actions: ["opened", "synchronize", "reopened"] }
  assert.deepEqual(registered("issues", "automatic"), [issueEvents, { type: "issue_comment", actions: ["created"] }])
  assert.deepEqual(registered("review", "automatic"), [pullRequest])
  assert.deepEqual(registered("ci", "automatic"), [pullRequest, { type: "push", actions: [] }])
  assert.deepEqual(registered("chores", "automatic"), [])
})

test("an ordinary issue event selects feature work only in the modes the maintainer chose", () => {
  for (const mode of modes) {
    for (const action of lifecycle) {
      assert.deepEqual(
        selected("feature", mode, { action }),
        mode === "automatic" || mode === "approved" ? ["feature"] : [],
        `${mode} ${action}`
      )
    }
    assert.deepEqual(
      selected("feature", mode, { type: "issue_comment", action: "created" }),
      [],
      `${mode} issue_comment`
    )
  }
})

test("manual dispatch and a scoped trial still run the configured feature step without any registered event", () => {
  for (const mode of ["automatic", "approved", "manual"] as const) {
    assert.deepEqual(selected("feature", mode, { type: "manual", action: "manual:feature", manualStep: "feature" }), [
      "feature"
    ], mode)
    assert.deepEqual(selected("feature", mode, { trial: true }), ["feature"], mode)
  }
  assert.deepEqual(registered("feature", "manual"), [])
  assert.throws(
    () => selected("feature", "off", { type: "manual", action: "manual:feature", manualStep: "feature" }),
    /does not select an enabled step/
  )
  assert.deepEqual(selected("feature", "off", { trial: true }), [])
})

test("issue text naming a manual or approved step grants nothing", () => {
  const payload = { issue: { ...issue, title: "manual", body: "approved" } }
  assert.deepEqual(selected("feature", "automatic", { payload, type: "manual", action: "manual:feature" }), [])
  assert.deepEqual(selected("feature", "approved", { payload, action: "manual:feature" }), ["feature"])
  assert.deepEqual(selected("feature", "manual", { payload }), [])
})

test("a stored connectIssues flag decodes, stays off by default and grants nothing", () => {
  assert.equal(initialSetup("example/repo", "feature", "maintainer").draft.connectIssues, false)
  for (const mode of modes) assert.deepEqual(registered("feature", mode, true), registered("feature", mode), mode)
  const stored = Schema.decodeUnknownSync(Draft)(
    JSON.parse(JSON.stringify(candidate("feature", "approved", true).draft))
  )
  assert.equal(stored.connectIssues, true)
})

const source = {
  changeId: "change",
  commitId: "a".repeat(40),
  treeId: "tree",
  operationId: "operation",
  parentCommitIds: []
}
const runFeature = (mode: typeof modes[number], approve: boolean, deliveryKey: string) =>
  Effect.gen(function*() {
    const setup = candidate("feature", mode)
    const input = {
      repo: setup.repo,
      job: "feature" as const,
      revision: setup.revision,
      digest: setupCandidate(setup),
      sourceRevision: source.commitId,
      configuration: setup.draft as typeof Draft.Type,
      event: {
        source: "smithers-cloud" as const,
        type: "issues",
        action: "opened",
        deliveryKey,
        issueNumber: issue.number,
        payload: { issue }
      }
    }
    const evidence = { repo: setup.repo, source, files: [], missing: [], history: [], records: [], sources: [] }
    const executed: Array<{ flow: string; executionId: string; payload: any }> = []
    const handlers = new Map<string, (payload: unknown) => { execute: Effect.Effect<unknown, unknown, never> }>()
    const runtime = {
      register: (declared: any, action: any) => Effect.sync(() => handlers.set(declared._tag, action)),
      execute: (flow: any, options: any) =>
        Effect.sync(() => {
          executed.push({ flow: flow._tag, executionId: options.executionId, payload: options.payload })
          if (flow._tag === "repository/ApproveStep") return approve
          if (flow._tag === "repository/FailedStep") {
            return {
              stepId: options.payload.stepId,
              status: "error",
              summary: options.payload.error.message,
              evidence: [],
              output: options.payload.error,
              executionId: "execution"
            }
          }
          return {
            stepId: options.payload.work.step.id,
            status: "completed",
            summary: "",
            evidence: ["execution:step"],
            output: {},
            executionId: "execution"
          }
        })
    }
    const fs = yield* FileSystem.FileSystem
    // Step selection and approval reach neither native source capture nor the
    // repository, so these two services stay absent and throw if that changes.
    yield* Layer.build(
      executionLayers(
        {
          evaluator: makeHostJudge().layer,
          repositoryPath: "/nonexistent",
          fs,
          environment: { PATH: process.env.PATH! }
        } as never
      ).pipe(
        Layer.provide([
          Layer.succeed(FlowRuntime.FlowRuntime, runtime as never),
          Layer.succeed(Jj.Jj, undefined as never),
          Layer.succeed(NativeCoding, undefined as never)
        ])
      )
    )
    const handler = handlers.get("repository/run-steps")
    if (!handler) return yield* Effect.die("repository/run-steps has no implementation")
    const results = yield* handler(
      Schema.decodeUnknownSync(RunSteps.payloadSchema)({ input, evidence, deadlineAt: Date.now() + 60_000 })
    ).execute.pipe(
      Effect.provideService(FlowRuntime.FlowRuntime, runtime as never),
      Effect.provideService(FlowRuntime.FlowInstance, { executionId: "job-root" } as never)
    )
    return { executed, results: results as Record<string, { status: string; summary: string }> }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.runPromise)

test("an approved feature step asks about its own issue before any proposal work", async () => {
  const accepted = await runFeature("approved", true, "delivery-1")
  const approval = accepted.executed[0]!
  assert.equal(approval.flow, "repository/ApproveStep")
  assert.deepEqual(approval.payload, {
    name: "Build a feature",
    prompt: candidate("feature", "approved").draft.steps[0]!.prompt,
    repo: "example/repo",
    sourceRevision: source.commitId,
    issueNumber: issue.number,
    issueTitle: issue.title
  })
  assert.doesNotThrow(() => Schema.decodeUnknownSync(ApproveStep.payloadSchema)(approval.payload))
  assert.deepEqual(accepted.executed.map((entry) => entry.flow), ["repository/ApproveStep", "repository/ProposalStep"])
  const other = await runFeature("approved", true, "delivery-2")
  assert.notEqual(other.executed[0]!.executionId, approval.executionId)
})

test("a declined approval proposes no code and an automatic step never asks", async () => {
  const declined = await runFeature("approved", false, "delivery-1")
  assert.deepEqual(declined.executed.map((entry) => entry.flow), ["repository/ApproveStep", "repository/FailedStep"])
  assert.equal(declined.results.feature!.status, "error")
  assert.match(declined.results.feature!.summary, /not approved/)
  const automatic = await runFeature("automatic", false, "delivery-1")
  assert.deepEqual(automatic.executed.map((entry) => entry.flow), ["repository/ProposalStep"])
})
