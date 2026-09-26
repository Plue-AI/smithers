import { NodeServices } from "@effect/platform-node"
import { ControlRuntime } from "@smthrs/control/ControlRuntime"
import * as DurableEngineState from "@smthrs/engine-store/DurableEngineState"
import { Action, FlowRuntime } from "@smthrs/flow"
import * as RunStore from "@smthrs/run-store/RunStore"
import { Effect, Layer, Schema } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import assert from "node:assert/strict"
import { test } from "node:test"
import { initialSetup, setupCandidate } from "../../packages/rpc/src/RepositorySetup.ts"
import * as Jj from "../../packages/smithers/flows/jj/src/Jj.ts"
import { NativeCoding } from "../coding/native.ts"
import { activationLayers, normalEvents, Register } from "../repository/activation.ts"
import { finalCheckWork } from "../repository/changes.ts"
import { captureChecks } from "../repository/checks.ts"
import { selectedSteps } from "../repository/execution.ts"
import { finalCheckWork as definedInJobs } from "../repository/jobs.ts"
import { RepositoryRemote } from "../repository/remote.ts"
import { Draft, JobInput, SetupInput } from "../repository/schema.ts"

const modes = ["automatic", "approved", "manual", "off"] as const
const choreEvents = ["none", "push", "labeled"] as const
const issueEvents = { type: "issues", actions: ["opened", "edited", "reopened", "labeled"] }
const pullRequest = { type: "pull_request", actions: ["opened", "synchronize", "reopened"] }
const source = "a".repeat(40), base = "b".repeat(40)

const candidate = (
  job: JobInput["job"],
  mode: typeof modes[number],
  draft: Partial<
    { choreEvent: typeof choreEvents[number]; label: string; schedule: string; scope: "label" | "future" }
  > = {}
) => {
  const initial = initialSetup("example/repo", job, "maintainer")
  return {
    ...initial,
    draft: { ...initial.draft, ...draft, steps: initial.draft.steps.map((step) => ({ ...step, mode })) }
  }
}
const setupInput = (
  job: JobInput["job"],
  mode: typeof modes[number],
  draft: Parameters<typeof candidate>[2] = {},
  operation: SetupInput["operation"] = "apply"
): SetupInput => {
  const setup = candidate(job, mode, draft)
  return {
    requestId: "chore-events",
    repo: setup.repo,
    job,
    operation,
    revision: setup.revision,
    digest: setupCandidate(setup),
    draft: setup.draft as typeof Draft.Type
  }
}
const registered = (job: JobInput["job"], mode: typeof modes[number], draft: Parameters<typeof candidate>[2] = {}) =>
  normalEvents(setupInput(job, mode, draft))

const pushPayload = (ref: string, defaultBranch: string | null = "main") => ({
  ref,
  before: base,
  after: source,
  created: false,
  deleted: false,
  repository: defaultBranch === null ? {} : { default_branch: defaultBranch }
})
const selected = (
  job: JobInput["job"],
  mode: typeof modes[number],
  event: Partial<JobInput["event"]>,
  draft: Parameters<typeof candidate>[2] = {}
) =>
  selectedSteps({
    job,
    configuration: candidate(job, mode, draft).draft as typeof Draft.Type,
    event: {
      source: "smithers-cloud",
      type: "issues",
      action: "opened",
      deliveryKey: "delivery-1",
      payload: { issue: { number: 3, title: "Tidy up", body: "Remove the dead module" } },
      ...event
    }
  }).map((step) => step.id)
const pushed = (job: JobInput["job"], mode: typeof modes[number], ref: string, defaultBranch: string | null = "main") =>
  selected(job, mode, {
    source: "github",
    type: "push",
    action: "pushed",
    deliveryKey: `push:${ref}`,
    payload: pushPayload(ref, defaultBranch)
  }, { choreEvent: "push" })

test("a chore registers exactly the event rule its draft chose", () => {
  for (const mode of modes) {
    for (const choreEvent of choreEvents) {
      assert.deepEqual(
        registered("chores", mode, { choreEvent, label: "chore" }),
        choreEvent === "push" ?
          [{ type: "push", actions: [] }]
          : choreEvent === "labeled"
          ? [{ type: "issues", actions: ["labeled"] }]
          : [],
        `${mode} ${choreEvent}`
      )
    }
  }
})

// The digest the pre-stack code at 1f7d9b40bcc5 computed for this draft. A job
// registered or a setup operation stored then carries no choreEvent key at all.
const storedChoreDigest = "bbf342a61d1c36d83ecd20c7f7372dbc27cf61bf121f36590b874196b6ffdf35"

test("a job and a setup operation registered before the chore event existed still decode here", () => {
  const setup = initialSetup("example/repo", "chores", "maintainer")
  const { choreEvent: _absent, ...configuration } = setup.draft
  const job = Schema.decodeUnknownSync(JobInput)({
    repo: setup.repo,
    job: "chores",
    revision: setup.revision,
    digest: storedChoreDigest,
    sourceRevision: source,
    configuration,
    event: { source: "schedule", type: "schedule", action: "", deliveryKey: "schedule:1", payload: {} }
  })
  assert.equal(job.configuration.choreEvent, "none")
  const input = Schema.decodeUnknownSync(SetupInput)({
    requestId: "stored-request",
    repo: setup.repo,
    job: "chores",
    operation: "apply",
    revision: setup.revision,
    digest: storedChoreDigest,
    draft: configuration
  })
  assert.equal(input.draft.choreEvent, "none")
})

test("the other four jobs register byte-identical events whatever a chore chose", () => {
  assert.deepEqual(registered("issues", "automatic"), [issueEvents, { type: "issue_comment", actions: ["created"] }])
  assert.deepEqual(registered("review", "automatic"), [pullRequest])
  assert.deepEqual(registered("ci", "automatic"), [pullRequest, { type: "push", actions: [] }])
  assert.deepEqual(registered("feature", "automatic"), [issueEvents])
  assert.deepEqual(registered("feature", "manual"), [])
  for (const job of ["issues", "review", "ci", "feature"] as const) {
    for (const choreEvent of choreEvents) {
      assert.deepEqual(
        registered(job, "automatic", { choreEvent, label: "chore" }),
        registered(job, "automatic"),
        `${job} ${choreEvent}`
      )
    }
  }
})

test("only a push to the repository's default branch starts a chore", () => {
  for (const mode of ["automatic", "approved"] as const) {
    assert.deepEqual(pushed("chores", mode, "refs/heads/main"), ["chore"], mode)
    assert.deepEqual(pushed("chores", mode, "refs/heads/release", "release"), ["chore"], mode)
    assert.deepEqual(pushed("chores", mode, "refs/heads/feature/x"), [], mode)
    assert.deepEqual(pushed("chores", mode, "refs/tags/v1.0.0"), [], mode)
    assert.deepEqual(pushed("chores", mode, "refs/heads/main", null), [], mode)
  }
  for (const mode of ["manual", "off"] as const) assert.deepEqual(pushed("chores", mode, "refs/heads/main"), [], mode)
})

test("a chore starts only on the event its own draft chose", () => {
  const labeled = { type: "issues", action: "labeled" } as const
  const push = {
    source: "github" as const,
    type: "push",
    action: "pushed",
    deliveryKey: "push:main",
    payload: pushPayload("refs/heads/main")
  }
  const schedule = { source: "schedule" as const, type: "schedule", action: "", deliveryKey: "schedule:1", payload: {} }
  for (const mode of ["automatic", "approved"] as const) {
    assert.deepEqual(selected("chores", mode, labeled, { choreEvent: "none" }), [], mode)
    assert.deepEqual(selected("chores", mode, labeled, { choreEvent: "push" }), [], mode)
    assert.deepEqual(selected("chores", mode, push, { choreEvent: "none" }), [], mode)
    assert.deepEqual(selected("chores", mode, push, { choreEvent: "labeled", label: "chore" }), [], mode)
    assert.deepEqual(
      selected("chores", mode, { type: "issues", action: "opened" }, { choreEvent: "labeled", label: "chore" }),
      [],
      mode
    )
    assert.deepEqual(
      selected("chores", mode, { type: "issue_comment", action: "created" }, { choreEvent: "labeled", label: "chore" }),
      [],
      mode
    )
    assert.deepEqual(selected("chores", mode, schedule, { schedule: "0 9 * * *" }), ["chore"], mode)
  }
})

test("the CI job keeps starting on a side branch push", () => {
  assert.deepEqual(pushed("ci", "automatic", "refs/heads/feature/x"), ["checks"])
  assert.deepEqual(pushed("ci", "automatic", "refs/tags/v1.0.0"), ["checks"])
})

test("a labeled chore selects its step from the issue event Plue filtered", () => {
  for (const mode of modes) {
    assert.deepEqual(
      selected("chores", mode, { type: "issues", action: "labeled" }, { choreEvent: "labeled", label: "chore" }),
      mode === "automatic" || mode === "approved" ? ["chore"] : [],
      mode
    )
  }
})

test("manual dispatch and the scoped trial ignore the chosen chore event", () => {
  for (const choreEvent of choreEvents) {
    for (const mode of ["automatic", "approved", "manual"] as const) {
      assert.deepEqual(
        selected("chores", mode, { type: "manual", action: "manual:chore", manualStep: "chore" }, { choreEvent }),
        ["chore"],
        `${mode} ${choreEvent}`
      )
      assert.deepEqual(selected("chores", mode, { trial: true }, { choreEvent }), ["chore"], `${mode} ${choreEvent}`)
    }
    assert.deepEqual(selected("chores", "off", { trial: true }, { choreEvent }), [], choreEvent)
  }
})

const registerCandidate = (mode: "trial" | "enabled", input: SetupInput) =>
  Effect.gen(function*() {
    const calls: Array<{ readonly name: string; readonly body: unknown }> = []
    const record = (name: string) => (...body: ReadonlyArray<unknown>) => {
      calls.push({ name, body: body[body.length - 1] })
      return Effect.succeed(
        {
          registration_id: "registration",
          revision: input.revision,
          digest: input.digest,
          source_revision: source,
          mode,
          enabled: true
        } as never
      )
    }
    const remote = RepositoryRemote.of(
      {
        repo: input.repo,
        workspaceId: "workspace",
        history: Effect.succeed({ records: [], sources: [] }),
        register: record("register"),
        pause: record("pause"),
        dispatches: record("dispatches"),
        createTrial: (job: never, requestId: string) => {
          calls.push({ name: "createTrial", body: requestId })
          return Effect.succeed(
            {
              source: "smithers-cloud",
              number: 4,
              issue_id: 4,
              request_id: requestId,
              api_path: "/api/issues/4"
            } as never
          )
        }
      } as never
    )
    const runtime = {
      register: (declared: { _tag: string }, action: unknown) =>
        Effect.sync(() => handlers.set(declared._tag, action as never)),
      execute: () => Effect.succeed(undefined)
    }
    const handlers = new Map<string, (payload: unknown) => { execute: Effect.Effect<unknown, unknown, never> }>()
    const services = Layer.mergeAll(
      Layer.succeed(FlowRuntime.FlowRuntime, runtime as never),
      Layer.succeed(RepositoryRemote, remote),
      Layer.succeed(Jj.Jj, {
        snapshot: (message: string) =>
          Effect.sync(() => {
            calls.push({ name: "snapshot", body: message })
          })
      } as never),
      Layer.succeed(NativeCoding, {
        read: () => Effect.succeed({ head: { kind: "resolved", commitId: source } })
      } as never),
      Layer.succeed(ControlRuntime, {
        plan: (planned: { flowId: string }) =>
          Effect.succeed({
            card: {
              flowId: planned.flowId,
              executionDigest: "c".repeat(64),
              envelope: { budget: { milliseconds: 600_000, tokens: 100_000 } }
            }
          })
      } as never),
      Layer.succeed(SqlClient.SqlClient, undefined as never),
      Layer.succeed(RunStore.RunStore, undefined as never),
      Layer.succeed(DurableEngineState.DurableEngineState, undefined as never),
      Action.layerImplementations
    )
    yield* Layer.build(activationLayers.pipe(Layer.provide(services)))
    const handler = handlers.get("repository/register-candidate")
    if (!handler) {
      return yield* Effect.die("repository/register-candidate has no implementation")
    }
    const outcome = yield* handler(
      Schema.decodeUnknownSync(Register.payloadSchema)({ input, mode, deadlineAt: Date.now() + 600_000 })
    )
      .execute.pipe(Effect.provide(services), Effect.result)
    return { calls, outcome }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.runPromise)

const message = (outcome: { _tag: string; failure?: unknown }) =>
  outcome._tag === "Failure" ? String((outcome.failure as { message?: unknown }).message) : ""

test("enabling a chore registers its chosen event, label and schedule", async () => {
  const labeled = await registerCandidate(
    "enabled",
    setupInput("chores", "automatic", { choreEvent: "labeled", label: "chore", schedule: "0 9 * * *" })
  )
  const body = labeled.calls.find((call) => call.name === "register")!.body as Record<string, unknown>
  assert.deepEqual(body.events, [{ type: "issues", actions: ["labeled"] }])
  assert.equal(body.label, "chore")
  assert.equal(body.schedule, "0 9 * * *")
  const pushing = await registerCandidate(
    "enabled",
    setupInput("chores", "automatic", { choreEvent: "push", label: "chore" })
  )
  const pushBody = pushing.calls.find((call) => call.name === "register")!.body as Record<string, unknown>
  assert.deepEqual(pushBody.events, [{ type: "push", actions: [] }])
  assert.equal(pushBody.label, undefined)
})

test("a typed apply of a manual-only chore refuses before any registration side effect", async () => {
  for (
    const draft of [{ schedule: "0 9 * * *" }, { choreEvent: "push" as const }, {
      choreEvent: "labeled" as const,
      label: "chore"
    }]
  ) {
    const refused = await registerCandidate("enabled", setupInput("chores", "manual", draft))
    assert.equal(message(refused.outcome), "Set the chore to run automatically or on approval.", JSON.stringify(draft))
    assert.deepEqual(refused.calls, [], JSON.stringify(draft))
  }
  const off = await registerCandidate("enabled", setupInput("chores", "off", { choreEvent: "push" }))
  assert.equal(message(off.outcome), "Set the chore to run automatically or on approval.")
})

test("a label-scoped candidate refuses a blank label before any registration side effect", async () => {
  for (
    const [name, input] of [
      ["labeled chore", setupInput("chores", "automatic", { choreEvent: "labeled", label: "" })],
      ["blank labeled chore", setupInput("chores", "automatic", { choreEvent: "labeled", label: "  " })],
      ["label-scoped issues", setupInput("issues", "automatic", { scope: "label", label: "" })],
      ["blank label-scoped issues", setupInput("issues", "automatic", { scope: "label", label: " \t" })]
    ] as const
  ) {
    const refused = await registerCandidate("enabled", input)
    assert.equal(message(refused.outcome), "Choose the issue label.", name)
    assert.deepEqual(refused.calls, [], name)
  }
})

test("the chosen label reaches registration exactly as it was typed", async () => {
  const scoped = await registerCandidate(
    "enabled",
    setupInput("issues", "automatic", { scope: "label", label: "triage" })
  )
  assert.equal(scoped.outcome._tag, "Success")
  assert.equal((scoped.calls.find((call) => call.name === "register")!.body as Record<string, unknown>).label, "triage")
  const chore = await registerCandidate(
    "enabled",
    setupInput("chores", "automatic", { choreEvent: "labeled", label: "chore" })
  )
  assert.equal(chore.outcome._tag, "Success")
  assert.equal((chore.calls.find((call) => call.name === "register")!.body as Record<string, unknown>).label, "chore")
  const trial = await registerCandidate(
    "trial",
    setupInput("chores", "automatic", { choreEvent: "labeled", label: "" }, "trial")
  )
  assert.equal(trial.outcome._tag, "Success", "a scoped trial registers no label-scoped event")
})

test("a padded label is refused before any registration side effect, like a blank one", async () => {
  for (
    const [name, input] of [
      ["labeled chore", setupInput("chores", "automatic", { choreEvent: "labeled", label: " chore " })],
      ["label-scoped issues", setupInput("issues", "automatic", { scope: "label", label: "triage " })]
    ] as const
  ) {
    const refused = await registerCandidate("enabled", input)
    assert.equal(message(refused.outcome), "Remove the spaces around the issue label.", name)
    assert.deepEqual(refused.calls, [], name)
  }
})

test("the refusal spares an unscheduled chore, an automatic chore and the scoped trial", async () => {
  const unscheduled = await registerCandidate("enabled", setupInput("chores", "manual"))
  assert.equal(unscheduled.outcome._tag, "Success")
  const automatic = await registerCandidate("enabled", setupInput("chores", "automatic", { choreEvent: "push" }))
  assert.equal(automatic.outcome._tag, "Success")
  const approved = await registerCandidate("enabled", setupInput("chores", "approved", { schedule: "0 9 * * *" }))
  assert.equal(approved.outcome._tag, "Success")
  const trial = await registerCandidate("trial", setupInput("chores", "manual", { choreEvent: "push" }, "trial"))
  assert.equal(trial.outcome._tag, "Success")
  assert.ok(trial.calls.some((call) => call.name === "createTrial"))
})

// The revision that CAUSED a job and the revision it PRODUCES are different
// facts; only the produced one is what fresh checks verify.
// An incomplete tree id stops the real capture at its export boundary, which
// is proof that the candidate guard and comparison base were both satisfied.
const produced = "d".repeat(40), tree = ""
const checkWork = (
  job: JobInput["job"],
  event: Partial<JobInput["event"]>,
  source: { commitId: string; treeId: string }
) => ({
  repo: "example/repo",
  job,
  step: { id: job === "chores" ? "chore" : "checks", name: "Step", prompt: "Do the work", mode: "automatic" as const },
  event: { source: "github" as const, type: "push", action: "", deliveryKey: "delivery-1", payload: {}, ...event },
  evidence: {
    repo: "example/repo",
    source: {
      changeId: "k".repeat(32),
      commitId: source.commitId,
      treeId: source.treeId,
      operationId: "f".repeat(64),
      parentCommitIds: [base]
    },
    files: [],
    missing: [],
    history: [],
    records: [],
    sources: []
  },
  checks: [{
    id: "unit",
    name: "Unit",
    kind: "command" as const,
    policy: "required" as const,
    rule: "true",
    paths: []
  }],
  landing: "checks" as const,
  replies: "draft" as const,
  executionMode: "live" as const,
  deadlineAt: Date.now() + 60_000,
  proposal: []
})
const checkFailure = async (work: ReturnType<typeof checkWork>) => {
  const outcome = await Effect.runPromise(
    Effect.result(captureChecks({} as never, work as never)).pipe(
      Effect.provideService(Jj.Jj, undefined as never),
      Effect.provide(NodeServices.layer)
    )
  )
  return outcome._tag === "Failure" ? String((outcome.failure as { message?: unknown }).message) : "completed"
}
const mismatch = "The workspace source is not the event's candidate revision"
const reachedSource = "Checks require full immutable native commit and tree IDs"

test("a review or CI job is still refused when its workspace source is not the event's candidate", async () => {
  assert.equal(
    await checkFailure(
      checkWork("review", {
        type: "pull_request",
        action: "opened",
        payload: { pull_request: { head: { sha: source }, base: { sha: base } } }
      }, { commitId: produced, treeId: tree })
    ),
    mismatch
  )
  assert.equal(
    await checkFailure(
      checkWork("ci", {
        payload: { ref: "refs/heads/main", before: base, after: source, candidateCommitId: source, baseCommitId: base }
      }, { commitId: produced, treeId: tree })
    ),
    mismatch
  )
})

test("a push chore's produced change is checked against its own source while the push stays provenance", async () => {
  const trigger = { ref: "refs/heads/main", before: base, after: source, candidateCommitId: source, baseCommitId: base }
  assert.equal(
    await checkFailure(checkWork("chores", { payload: trigger }, { commitId: produced, treeId: tree })),
    mismatch
  )
  const work = checkWork("chores", { payload: { trigger, candidateCommitId: produced, baseCommitId: source } }, {
    commitId: produced,
    treeId: tree
  })
  assert.equal(await checkFailure(work), reachedSource)
  assert.deepEqual((work.event.payload as { trigger: unknown }).trigger, trigger)
})

test("a labeled-issue chore's produced change is checked against its own source too", async () => {
  const trigger = { issue: { number: 7, title: "Tidy up", body: "Remove the dead module" } }
  assert.equal(
    await checkFailure(
      checkWork("chores", { type: "issues", action: "labeled", payload: trigger }, { commitId: produced, treeId: tree })
    ),
    reachedSource
  )
  assert.equal(
    await checkFailure(
      checkWork("chores", {
        type: "issues",
        action: "labeled",
        payload: { trigger, candidateCommitId: produced, baseCommitId: source }
      }, { commitId: produced, treeId: tree })
    ),
    reachedSource
  )
})

// L25's CI receipt verifier rebuilds the fresh-check payload with this exact
// function, so the transform lives in one place for both.
const todaysTransform = (
  work: ReturnType<typeof checkWork>,
  head: ReturnType<typeof checkWork>["evidence"]["source"]
) => ({ ...work, evidence: { ...work.evidence, source: head }, proposal: [] })
const producedSource = (commitId: string): ReturnType<typeof checkWork>["evidence"]["source"] => ({
  changeId: "k".repeat(32),
  commitId,
  treeId: tree,
  operationId: "f".repeat(64),
  parentCommitIds: [source]
})
const eventKinds = [
  { type: "issues", action: "opened", payload: { issue: { number: 7, title: "Tidy", body: "Remove it" } } },
  {
    type: "issue_comment",
    action: "created",
    payload: { issue: { number: 7, title: "Tidy", body: "Remove it" }, comment: { body: "please" } }
  },
  { type: "manual", action: "manual:chore", payload: { manual: { prompt: "Update the module" } } },
  { type: "schedule", action: "", payload: {} },
  { type: "issues", action: "opened", trial: true, payload: { issue: { number: 7, title: "Tidy", body: "Remove it" } } }
] as const

test("finalCheckWork is the one transform both the producer and the CI receipt verifier call", () => {
  assert.equal(finalCheckWork, definedInJobs)
})

test("finalCheckWork leaves an event that carries no commit exactly as it is today", () => {
  for (const event of eventKinds) {
    const work = checkWork("chores", event, { commitId: produced, treeId: tree })
    const final = finalCheckWork(work as never, { head: producedSource(produced), base: source })
    assert.deepEqual(final, todaysTransform(work, producedSource(produced)) as never, event.type)
    assert.deepEqual(work.event.payload, event.payload, "the input work is never mutated")
  }
})

test("finalCheckWork replaces a carried candidate with the produced change and keeps the trigger", () => {
  const push = { ref: "refs/heads/main", before: base, after: source, candidateCommitId: source, baseCommitId: base }
  const pull = { pull_request: { head: { sha: source }, base: { sha: base } } }
  for (
    const [name, trigger] of [["push", push], ["pull_request", pull], ["head_commit_id", {
      head_commit_id: source
    }]] as const
  ) {
    const work = checkWork("chores", { type: name === "pull_request" ? "pull_request" : "push", payload: trigger }, {
      commitId: produced,
      treeId: tree
    })
    const final = finalCheckWork(work as never, { head: producedSource(produced), base: source })
    assert.deepEqual(final.event.payload, { trigger, candidateCommitId: produced, baseCommitId: source }, name)
    assert.deepEqual(final.proposal, [], name)
    assert.equal(final.evidence.source.commitId, produced, name)
  }
})
