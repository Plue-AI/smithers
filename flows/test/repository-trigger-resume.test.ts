import { NodeServices } from "@effect/platform-node"
import * as SeatResolver from "@smthrs/agent/SeatResolver"
import { ControlRuntime } from "@smthrs/control/ControlRuntime"
import * as DurableEngineState from "@smthrs/engine-store/DurableEngineState"
import { Action, FlowRuntime } from "@smthrs/flow"
import * as Descriptor from "@smthrs/registry/Descriptor"
import * as Registry from "@smthrs/registry/Registry"
import * as RunStore from "@smthrs/run-store/RunStore"
import { Effect, Layer, Option } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import assert from "node:assert/strict"
import { test } from "node:test"
import * as Jj from "../../packages/smithers/flows/jj/src/Jj.ts"
import { NativeCoding } from "../coding/native.ts"
import { RepositoryRemote } from "../repository/remote.ts"
import { triggerCandidate, type TriggerRequest } from "../repository/schema.ts"
import { recoverTriggerRequest, triggerLayers } from "../repository/triggers.ts"

const workspace = "22222222-2222-4222-8222-222222222222"
const original: TriggerRequest = {
  operation: "register",
  repo: "will/flows",
  slug: "nightly",
  flow: "review",
  schedule: "0 9 * * *",
  input: { args: "keep the reviewed input", nested: { count: 7 } },
  workspaceId: workspace,
  budget: { tokens: 100_000, milliseconds: 600_000 },
  approvedPlanId: "approved-plan",
  approvedPlanDigest: "a".repeat(64)
}
const request: TriggerRequest = {
  operation: "resume",
  repo: original.repo,
  slug: original.slug,
  flow: "stale-browser-flow",
  schedule: "",
  input: {}
}
const row = () => ({
  job: "flow:nightly",
  mode: "enabled",
  enabled: false,
  workspace_id: workspace,
  revision: 4,
  digest: triggerCandidate(original),
  flow_id: original.flow,
  schedule: original.schedule,
  configuration: {
    repo: original.repo,
    workspace_id: workspace,
    revision: 4,
    digest: triggerCandidate(original),
    flow_id: original.flow,
    schedule: original.schedule,
    input: original.input,
    envelope: { budget: original.budget },
    approved_plan_id: original.approvedPlanId,
    approved_plan_digest: original.approvedPlanDigest
  }
})

test("resume recovers the exact reviewed input and budget, ignoring browser defaults", () => {
  assert.deepEqual(recoverTriggerRequest(request, { items: [row()] }, workspace), { ...original, expectedRevision: 4 })
})
for (
  const [name, change] of [
    ["already enabled", (value: ReturnType<typeof row>) => {
      value.enabled = true
    }],
    ["wrong workspace", (value: ReturnType<typeof row>) => {
      value.workspace_id = "another-workspace"
    }],
    ["changed revision", (value: ReturnType<typeof row>) => {
      value.revision++
    }],
    ["redacted input", (value: ReturnType<typeof row>) => {
      value.configuration.input = {}
    }],
    ["missing approval", (value: ReturnType<typeof row>) => {
      value.configuration.approved_plan_id = undefined
    }]
  ] as const
) {
  test(`resume refuses ${name}`, () => {
    const value = row()
    change(value)
    assert.equal(typeof recoverTriggerRequest(request, [value], workspace), "string")
  })
}

const descriptor = new Descriptor.FlowDescriptor({
  name: original.flow,
  description: "Review",
  path: "/flows/review/flow.mdx",
  body: new Descriptor.BodyRefMarkdown({
    path: "/flows/review/flow.mdx",
    baseDirectory: "/flows/review",
    contentDigest: "b".repeat(64)
  }),
  input: new Descriptor.SchemaRefMarkdownArgs({}),
  output: new Descriptor.SchemaRefMarkdownOutput({}),
  model: Option.some("codex:default"),
  flows: [],
  capabilities: [],
  effects: { reads: [], writes: [], mode: "hermetic", onConflict: "serialize", tier: "sealed" },
  placement: Option.none(),
  modelInvocable: true,
  frontmatter: {},
  provenance: new Descriptor.Provenance({ source: "test", root: "/flows" })
})

/** Drive the real recovery, approval validation and activation handlers. Host services are fixtures. */
const drive = (
  options: { decision?: string; changedSource?: boolean; changedInput?: boolean; changedRevision?: boolean } = {}
) => {
  const registrations: Array<Record<string, unknown>> = []
  return Effect.gen(function*() {
    const handlers = new Map<string, (payload: unknown) => { execute: Effect.Effect<unknown, unknown, never> }>()
    const runtime = {
      register: (declared: { _tag: string }, action: unknown) =>
        Effect.sync(() => handlers.set(declared._tag, action as never)),
      execute: () => Effect.void
    }
    const card = {
      planId: original.approvedPlanId,
      flowId: original.flow,
      digest: original.approvedPlanDigest,
      executionDigest: Descriptor.executionDigest(descriptor),
      envelope: { budget: original.budget }
    }
    let reads = 0
    const services = Layer.mergeAll(
      Layer.succeed(FlowRuntime.FlowRuntime, runtime as never),
      Layer.succeed(RepositoryRemote, {
        repo: original.repo,
        workspaceId: workspace,
        registrations: Effect.sync(() => {
          const value = row()
          if (++reads > 1 && options.changedRevision) value.revision++
          return { items: [value] }
        }),
        register: (_job: string, body: Record<string, unknown>) =>
          Effect.sync(() => {
            registrations.push(body)
            return {
              registration_id: "reg-1",
              revision: body.revision,
              digest: body.digest,
              source_revision: body.source_revision,
              schedule: body.schedule,
              enabled: true,
              mode: "enabled",
              next_fire_at: null,
              timezone: "UTC"
            }
          })
      } as never),
      Layer.succeed(
        Registry.Registry,
        { getOption: () => Effect.succeed(Option.some(descriptor)), loadBody: () => Effect.succeed("review") } as never
      ),
      Layer.succeed(SeatResolver.SeatResolver, { resolve: () => Effect.void } as never),
      Layer.succeed(Jj.Jj, { snapshot: () => Effect.void } as never),
      Layer.succeed(
        NativeCoding,
        { read: () => Effect.succeed({ head: { kind: "resolved", commitId: "c".repeat(40) } }) } as never
      ),
      Layer.succeed(ControlRuntime, {
        getPlan: () =>
          Effect.succeed({
            card,
            decodedInput: options.changedInput ? {} : original.input,
            decision: options.decision ?? "approved"
          }),
        plan: () =>
          Effect.succeed({ card: options.changedSource ? { ...card, executionDigest: "d".repeat(64) } : card })
      } as never),
      Layer.succeed(SqlClient.SqlClient, undefined as never),
      Layer.succeed(RunStore.RunStore, undefined as never),
      Layer.succeed(DurableEngineState.DurableEngineState, undefined as never),
      Action.layerImplementations
    )
    yield* Layer.build(triggerLayers.pipe(Layer.provide(services)))
    const invoke = (tag: string, payload: unknown) =>
      handlers.get(`repository/${tag}`)!(payload).execute.pipe(Effect.provide(services))
    const deadlineAt = Date.now() + 60_000
    const outcome = yield* Effect.gen(function*() {
      const recovered = yield* invoke("recover-trigger", { request, deadlineAt })
      const plan = yield* invoke("prepare-trigger", { request: recovered, deadlineAt })
      return yield* invoke("activate-trigger", { request: recovered, plan, deadlineAt })
    }).pipe(Effect.result)
    return { outcome, registrations }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.runPromise)
}

test("resume validates the saved approval and registers a new revision with the original configuration", async () => {
  const { outcome, registrations } = await drive()
  assert.equal(outcome._tag, "Success", JSON.stringify(outcome))
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0]?.revision, 5)
  assert.deepEqual(registrations[0]?.input, original.input)
  assert.deepEqual(registrations[0]?.envelope, { budget: original.budget })
  assert.equal(registrations[0]?.approved_plan_id, original.approvedPlanId)
  assert.equal(registrations[0]?.digest, triggerCandidate(original))
})
for (
  const [options, reason] of [
    [{ decision: "denied" }, /is denied/],
    [{ decision: "pending" }, /is pending/],
    [{ changedSource: true }, /no longer reproduces/],
    [{ changedInput: true }, /different input/],
    [{ changedRevision: true }, /changed while resuming/]
  ] as const
) {
  test(`resume registers nothing when approval cannot be reused: ${JSON.stringify(options)}`, async () => {
    const { outcome, registrations } = await drive(options)
    assert.equal(outcome._tag, "Failure", JSON.stringify(outcome))
    assert.match(outcome._tag === "Failure" ? String((outcome.failure as { message: string }).message) : "", reason)
    assert.equal(registrations.length, 0)
  })
}
