import { NodeServices } from "@effect/platform-node"
import { ControlRuntime } from "@smthrs/control/ControlRuntime"
import * as DurableEngineState from "@smthrs/engine-store/DurableEngineState"
import { Action, FlowRuntime } from "@smthrs/flow"
import * as RunStore from "@smthrs/run-store/RunStore"
import { Effect, Layer, Redacted, Schema } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { test, type TestContext } from "node:test"
import { initialSetup, setupCandidate } from "../../packages/rpc/src/RepositorySetup.ts"
import * as Jj from "../../packages/smithers/flows/jj/src/Jj.ts"
import { NativeCoding } from "../coding/native.ts"
import { activationLayers, Register } from "../repository/activation.ts"
import { makeRemote, RepositoryRemote } from "../repository/remote.ts"
import { Draft, SetupInput } from "../repository/schema.ts"

const source = "a".repeat(40), gateway = "11111111-1111-4111-8111-111111111111"
const workspace = "22222222-2222-4222-8222-222222222222"
/** The draft the canary pinned: the only required check is a command, so the
 * feature step's landing path exists and the draft has to pass a live trial. */
const candidate = (revision: number) => {
  const initial = initialSetup("codeplanesmithers/canary-sandbox", "feature", "maintainer")
  const draft = {
    ...initial.draft,
    landing: "checks" as const,
    revision,
    steps: initial.draft.steps.map((step) => ({ ...step, mode: "approved" as const })),
    checks: [{
      id: "docs-only-scope",
      name: "Docs only",
      kind: "ai" as const,
      policy: "report" as const,
      paths: ["docs/**"],
      rule: "Only documentation changes belong in this scope."
    }, {
      id: "5ebc63b3-8e2e-4faf-8d84-0522c838c910",
      name: "Hello file",
      kind: "command" as const,
      policy: "required" as const,
      paths: ["docs/nested/hello.txt"],
      rule: "test -f docs/nested/hello.txt"
    }]
  }
  const setup = { ...initial, revision, draft }
  return { ...setup, digest: setupCandidate(setup) }
}
const setupInput = (requestId: string, revision = 11): SetupInput => {
  const setup = candidate(revision)
  return {
    requestId,
    repo: setup.repo,
    job: "feature",
    operation: "trial",
    revision,
    digest: setup.digest,
    draft: setup.draft as typeof Draft.Type,
    workspaceId: workspace
  }
}

/** The four plue rules a second press of Test depends on:
 * `internal/services/repository_job_trial.go` keys a trial by (repository,
 * job, request id); the native issue trigger admits one event per created
 * issue with its own delivery key (`db/schema.sql`
 * `admit_native_repository_job_issue`); `db/queries/repository_jobs.sql`
 * re-registers one (repository, job, mode) row at a higher revision, or at an
 * equal revision when the candidate, flow and workspace are unchanged — and,
 * for `mode='trial'`, whatever the press moved as long as its trial issue only
 * grows, so the newest press owns the trial; `ListRepositoryJobAdmissions`
 * dispatches a trial event only at the registration's own trial issue and
 * only once per (registration, revision, delivery key).
 * It models nothing else: no `enabled`/user identity comparison, no plan,
 * no lease, and a settled dispatch instead of a verified native receipt. */
const plue = async (t: TestContext, options: { refuse?: string } = {}) => {
  const issues: number[] = [], registrations: string[] = []
  const trials = new Map<string, { number: number; revision: number; digest: string; title: string; body: string }>()
  const events: Array<{ issueNumber: number; deliveryKey: string }> = []
  const dispatches: Array<
    {
      id: string
      registrationId: string
      revision: number
      digest: string
      deliveryKey: string
      issueNumber: number
      runId: string
    }
  > = []
  const rows = new Map<
    string,
    {
      id: string
      revision: number
      digest: string
      configuration: string
      sourceRevision: string
      flowId: string
      trialIssue: number
    }
  >()
  const refuse = (response: import("node:http").ServerResponse, message: string) => {
    response.statusCode = 409
    response.end(JSON.stringify({ code: "CONFLICT", fault: "user", message }))
  }
  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json")
    let text = ""
    for await (const chunk of request) text += chunk
    const body = JSON.parse(text || "{}")
    const path = decodeURIComponent(request.url ?? "")
    const trial = /^\/api\/gateways\/([^/]+)\/repository-jobs\/([^/]+)\/trials\/(.+)$/.exec(path)
    if (trial) {
      const existing = trials.get(trial[3]!)
      if (
        existing && (existing.revision !== body.revision || existing.digest !== body.digest ||
          existing.title !== body.title || existing.body !== body.body)
      ) {
        refuse(response, "trial request already belongs to a different candidate")
        return
      }
      const number = existing?.number ?? trials.size + 60
      if (!existing) {
        issues.push(number)
        trials.set(trial[3]!, {
          number,
          revision: body.revision,
          digest: body.digest,
          title: body.title,
          body: body.body
        })
        events.push({ issueNumber: number, deliveryKey: `native:${number}` })
      }
      response.end(
        JSON.stringify({
          request_id: trial[3],
          source: "smithers-cloud",
          number,
          issue_id: number,
          api_path: `/repos/${body.repo}/issues/${number}`
        })
      )
      return
    }
    const dispatched = /^\/api\/repos\/[^/]+\/[^/]+\/repository-jobs\/([^/]+)\/dispatches$/.exec(path)
    if (dispatched) {
      for (const row of rows.values()) {
        for (const event of events) {
          if (event.issueNumber !== row.trialIssue) continue
          if (
            dispatches.some((value) =>
              value.registrationId === row.id && value.revision === row.revision &&
              value.deliveryKey === event.deliveryKey
            )
          ) continue
          dispatches.push({
            id: `dispatch-${dispatches.length + 1}`,
            registrationId: row.id,
            revision: row.revision,
            digest: row.digest,
            deliveryKey: event.deliveryKey,
            issueNumber: event.issueNumber,
            runId: `run-${dispatches.length + 1}`
          })
        }
      }
      response.end(
        JSON.stringify({
          items: dispatches.map((value) => ({
            id: value.id,
            registration_id: value.registrationId,
            revision: value.revision,
            digest: value.digest,
            delivery_key: value.deliveryKey,
            source: "smithers-cloud",
            issue_number: value.issueNumber,
            status: "failed",
            run_id: value.runId,
            error:
              `The trial recorded an unavailable check in ${value.runId}: docs-only-scope — The AI check did not establish complete scope coverage`
          }))
        })
      )
      return
    }
    const registration = /^\/api\/gateways\/([^/]+)\/repository-jobs\/([^/]+)$/.exec(path)
    assert(registration, `unexpected request ${path}`)
    if (options.refuse) {
      refuse(response, options.refuse)
      return
    }
    const key = `${registration[2]}:${body.mode}`, stored = rows.get(key), configuration = JSON.stringify(body)
    const retained = stored !== undefined && stored.revision === body.revision && stored.digest === body.digest &&
      stored.flowId === body.flow_id
    if (
      stored && !(stored.revision < body.revision || (retained && (body.mode === "trial"
        ? stored.trialIssue <= (body.trial_issue_number ?? 0)
        : stored.configuration === configuration && stored.sourceRevision === body.source_revision)))
    ) {
      refuse(response, "registration was paused, replaced, or changed; apply a newer reviewed revision")
      return
    }
    rows.set(key, {
      id: stored?.id ?? `registration-${rows.size + 1}`,
      revision: body.revision,
      digest: body.digest,
      configuration,
      sourceRevision: body.source_revision,
      flowId: body.flow_id,
      trialIssue: body.trial_issue_number ?? 0
    })
    registrations.push(configuration)
    response.end(
      JSON.stringify({
        registration_id: rows.get(key)!.id,
        revision: body.revision,
        digest: body.digest,
        source_revision: body.source_revision,
        mode: body.mode,
        enabled: true
      })
    )
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())))
  const address = server.address()
  assert(address && typeof address !== "string")
  const remote = await Effect.runPromise(
    makeRemote({
      apiBaseUrl: `http://127.0.0.1:${address.port}/api`,
      repositorySlug: "codeplanesmithers/canary-sandbox",
      repositoryId: 3,
      workspaceId: workspace,
      token: Redacted.make("fixture-token"),
      gatewayId: gateway,
      credential: "fixture-gateway"
    })
      .pipe(Effect.provide(FetchHttpClient.layer))
  )
  return { remote, issues, registrations, rows, dispatches }
}

/** The real actions, their real HTTP remote, and stubs only for the services a
 * registration or a probe reads but does not decide with. */
const drive = (remote: Parameters<typeof RepositoryRemote.of>[0], action: string, payload: unknown) =>
  Effect.gen(function*() {
    const handlers = new Map<string, (payload: unknown) => { execute: Effect.Effect<unknown, unknown, never> }>()
    const runtime = {
      register: (declared: { _tag: string }, action: unknown) =>
        Effect.sync(() => handlers.set(declared._tag, action as never)),
      execute: () => Effect.succeed(undefined)
    }
    const services = Layer.mergeAll(
      Layer.succeed(FlowRuntime.FlowRuntime, runtime as never),
      Layer.succeed(RepositoryRemote, remote),
      Layer.succeed(Jj.Jj, { snapshot: () => Effect.void } as never),
      Layer.succeed(
        NativeCoding,
        { read: () => Effect.succeed({ head: { kind: "resolved", commitId: source } }) } as never
      ),
      Layer.succeed(
        ControlRuntime,
        {
          plan: (planned: { flowId: string }) =>
            Effect.succeed({
              card: {
                flowId: planned.flowId,
                executionDigest: "c".repeat(64),
                envelope: { budget: { milliseconds: 600_000, tokens: 100_000 } }
              }
            })
        } as never
      ),
      Layer.succeed(SqlClient.SqlClient, undefined as never),
      Layer.succeed(RunStore.RunStore, undefined as never),
      Layer.succeed(DurableEngineState.DurableEngineState, undefined as never),
      Action.layerImplementations,
      FetchHttpClient.layer
    )
    yield* Layer.build(activationLayers.pipe(Layer.provide(services)))
    const handler = handlers.get(action)
    if (!handler) return yield* Effect.die(`${action} has no implementation`)
    return yield* handler(payload).execute.pipe(Effect.provide(services), Effect.result)
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.runPromise)

const pressTest = (remote: Parameters<typeof RepositoryRemote.of>[0], input: SetupInput) =>
  drive(
    remote,
    "repository/register-candidate",
    Schema.decodeUnknownSync(Register.payloadSchema)({ input, mode: "trial", deadlineAt: Date.now() + 600_000 })
  )
const probeTrial = (remote: Parameters<typeof RepositoryRemote.of>[0], input: SetupInput, activation: unknown) =>
  drive(remote, "repository/probe-trial", { input, activation, deadlineAt: Date.now() + 600_000, attempt: 1 })

const failure = (outcome: { _tag: string; failure?: unknown }) =>
  outcome._tag === "Failure" ? String((outcome.failure as { message?: unknown }).message) : ""
const activated = (outcome: { _tag: string; success?: unknown }) =>
  outcome.success as { trialIssue?: { number: number } }
const probed = (outcome: { _tag: string; success?: unknown }) =>
  (outcome.success as { output: { status: string; error?: string } }).output

test("a second press of Test trials the same draft again and reports its own run", async (t) => {
  const host = await plue(t)
  const first = await pressTest(host.remote, setupInput("press-1"))
  assert.equal(first._tag, "Success", failure(first))
  const firstRun = probed(await probeTrial(host.remote, setupInput("press-1"), activated(first)))
  assert.equal(firstRun.status, "failed")
  assert.match(firstRun.error ?? "", /run-1/)
  const second = await pressTest(host.remote, setupInput("press-2"))
  assert.equal(failure(second), "", "a second trial of the same candidate must not be refused")
  assert.deepEqual(host.issues, [60, 61], "each press opens the trial issue that dispatches its own run")
  assert.equal(activated(second).trialIssue?.number, 61)
  assert.equal(host.registrations.length, 2)
  assert.notEqual(host.registrations[0], host.registrations[1], "the re-registration names the new trial issue")
  const secondRun = probed(await probeTrial(host.remote, setupInput("press-2"), activated(second)))
  assert.equal(secondRun.status, "failed")
  assert.match(secondRun.error ?? "", /run-2/)
  assert.deepEqual(host.dispatches.map((value) => value.issueNumber), [60, 61], "the retry dispatches its own run")
  const later = await pressTest(host.remote, setupInput("press-3", 12))
  assert.equal(later._tag, "Success", failure(later))
  assert.deepEqual(host.issues, [60, 61, 62], "a new candidate revision opens its own trial issue")
})

test("a registration the repository refuses names the operation, never a cause it cannot know", async (t) => {
  for (
    const reason of [
      "registration was paused, replaced, or changed; apply a newer reviewed revision",
      "the registration workspace is unavailable",
      "repository ownership changed"
    ]
  ) {
    const host = await plue(t, { refuse: reason })
    const refused = await pressTest(host.remote, setupInput("press-1"))
    const message = failure(refused)
    assert.doesNotMatch(message, /\b409\b/, message)
    assert.equal(message, `The feature trial registration was refused: ${reason}`)
  }
})

test("a different candidate at the same revision is still refused", async (t) => {
  const host = await plue(t)
  const first = await pressTest(host.remote, setupInput("press-1"))
  assert.equal(first._tag, "Success", failure(first))
  const stored = host.rows.get("feature:trial")!
  host.rows.set("feature:trial", { ...stored, digest: "d".repeat(64) })
  const refused = await pressTest(host.remote, setupInput("press-2"))
  assert.equal(
    failure(refused),
    "The feature trial registration was refused: "
      + "registration was paused, replaced, or changed; apply a newer reviewed revision"
  )
})
