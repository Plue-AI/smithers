/** One repository flow, registered once on the schedule a person approved. */
import * as Digest from "@smthrs/core/Digest"
import * as SeatResolver from "@smthrs/agent/SeatResolver"
import * as Descriptor from "@smthrs/registry/Descriptor"
import * as Executable from "@smthrs/registry/Executable"
import * as Registry from "@smthrs/registry/Registry"
import { ControlRuntime } from "@smthrs/control/ControlRuntime"
import * as RunCatalogRead from "@smthrs/engine-store/RunCatalogRead"
import { Action, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Effect, Layer, Option, Schema } from "effect"
import { ModuleOwner } from "../../packages/smithers/src/internal/ModuleOwner.ts"
import * as Jj from "../../packages/smithers/flows/jj/src/Jj.ts"
import { NativeCoding } from "../coding/native.ts"
import { CodingError } from "../coding/schema.ts"
import { deploymentMinutes, deploymentTokens, StartBudget } from "./inspection.ts"
import { RepositoryRemote } from "./remote.ts"
import { TriggerRegistration, TriggerRequest, TriggerResult, triggerCandidate } from "./schema.ts"

const invalid = (message: string) => new CodingError({ code: "invalid_receipt", message })
const json = (value: unknown): Schema.Json => JSON.parse(JSON.stringify(value))
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
const rows = (value: unknown): Array<unknown> => Array.isArray(value) ? value : Array.isArray(record(value).items) ? record(value).items as Array<unknown> : []
const requireRemote = Effect.gen(function*() {
  const remote = yield* Effect.serviceOption(RepositoryRemote)
  return Option.isSome(remote) ? remote.value : yield* invalid("Connect the repository host before registering a schedule")
})
/** The five reviewed responsibilities and this registrar are the host's own. */
const reservedFlow = (name: string) => name === "repository/setup" || name === "repository/trigger" ||
  /^repository-jobs\/(issues|review|ci|feature|chores)$/.test(name) || name === "coding" || name.startsWith("coding/")

export const Dispatched = Schema.Struct({ requestId: Schema.String, slug: Schema.String, flow: Schema.String,
  dispatchId: Schema.String, registrationId: Schema.String, revision: Schema.Int, digest: Schema.String,
  status: Schema.String, runId: Schema.optionalKey(Schema.String) })
export const TriggerOutcome = Schema.Union([TriggerResult, Dispatched])
const Planned = Schema.Struct({ planId: Schema.String, planDigest: Schema.String, executionDigest: Schema.String,
  envelope: Schema.Json, sourceRevision: Schema.String, revision: Schema.Int, candidate: Schema.String,
  testRunId: Schema.optionalKey(Schema.String) })

/** Recover only the exact saved, reviewed configuration, never defaults from the browser. */
export const recoverTriggerRequest = (request: TriggerRequest, inventory: unknown, workspaceId: string): TriggerRequest | string => {
  const row = rows(inventory).map(record).find(value => value.job === `flow:${request.slug}` && value.mode === "enabled")
  if (!row) return "The paused schedule could not be found."
  if (row.enabled !== false) return "The schedule is already enabled."
  const saved = record(row.configuration)
  const budget = record(record(saved.envelope).budget)
  if (row.workspace_id !== workspaceId || saved.workspace_id !== workspaceId || saved.repo !== request.repo) return "Resume the schedule on its original workspace."
  if (!Number.isSafeInteger(row.revision) || Number(row.revision) < 1 || saved.revision !== row.revision || saved.digest !== row.digest ||
      saved.flow_id !== row.flow_id || saved.schedule !== row.schedule || !Object.hasOwn(saved, "input")) return "The saved schedule configuration could not be verified."
  const recovered = Schema.decodeUnknownOption(TriggerRequest)({
    ...request, operation: "register", flow: row.flow_id, schedule: row.schedule, input: saved.input,
    workspaceId, budget: { tokens: budget.tokens, milliseconds: budget.milliseconds },
    approvedPlanId: saved.approved_plan_id, approvedPlanDigest: saved.approved_plan_digest, expectedRevision: row.revision
  })
  if (Option.isNone(recovered) || !recovered.value.approvedPlanId || !recovered.value.approvedPlanDigest ||
      triggerCandidate(recovered.value) !== row.digest) return "The saved schedule approval could not be verified. Review and register it again."
  return recovered.value
}

const Recover = Action.make("repository/recover-trigger", {
  payload: { request: TriggerRequest, deadlineAt: Schema.Number }, success: TriggerRequest, error: CodingError, nondeterministic: true
})
const RecoverTrigger = Flow.make("repository/RecoverTrigger", { payload: Recover.payloadSchema, success: TriggerRequest, error: CodingError, body: value => Recover.call(value) })

const Prepare = Action.make("repository/prepare-trigger", {
  payload: { request: TriggerRequest, deadlineAt: Schema.Number }, success: Planned, error: CodingError, nondeterministic: true
})
const PrepareTrigger = Flow.make("repository/PrepareTrigger", { payload: Prepare.payloadSchema, success: Planned, error: CodingError, body: value => Prepare.call(value) })
const Activate = Action.make("repository/activate-trigger", {
  payload: { request: TriggerRequest, plan: Planned, deadlineAt: Schema.Number }, success: TriggerResult, error: CodingError, nondeterministic: true
})
const ActivateTrigger = Flow.make("repository/ActivateTrigger", { payload: Activate.payloadSchema, success: TriggerResult, error: CodingError, body: value => Activate.call(value) })
const Fire = Action.make("repository/fire-trigger", {
  payload: { request: TriggerRequest, dispatchKey: Schema.String, deadlineAt: Schema.Number }, success: Dispatched, error: CodingError, nondeterministic: true
})
const FireTrigger = Flow.make("repository/FireTrigger", { payload: Fire.payloadSchema, success: Dispatched, error: CodingError, body: value => Fire.call(value) })

export const ExecuteTrigger = Action.make("repository/execute-trigger", {
  payload: { request: TriggerRequest, deadlineAt: Schema.Number }, success: TriggerOutcome, error: CodingError, nondeterministic: true
})
export const Trigger = Flow.make("repository/Trigger", {
  payload: TriggerRequest, success: TriggerOutcome, error: CodingError,
  body: request => StartBudget.call({ minutes: deploymentMinutes }).pipe(Node.bindPlanned(deadlineAt => ExecuteTrigger.call({ request, deadlineAt })))
})
const RefuseTrigger = Action.make("repository/refuse-trigger", { payload: {}, success: TriggerOutcome, error: CodingError })
export const RunTrigger = Flow.make("repository/RunTrigger", { payload: Executable.Invocation, success: TriggerOutcome, error: CodingError,
  body: invocation => {
    const decoded = Schema.decodeUnknownOption(TriggerRequest)(invocation.input)
    return Option.isSome(decoded) ? Trigger.child(decoded.value) : RefuseTrigger.call({})
  }
})

/** The form gate of the supported-flow contract, decided before any plan is
 * made. Every refusal names the flow and what about it cannot be scheduled.
 * A schedule runs one single-file markdown flow through the prompt branch
 * `AgentSession` launches, so the gate asks what that branch asks: a markdown
 * body, a `model:` line, and a seat this workspace resolves. */
export const admittedEntry = (flow: string) => Effect.gen(function*() {
  if (reservedFlow(flow)) return yield* invalid(`"${flow}" is a reserved repository job; register it through repository setup.`)
  const registry = yield* Registry.Registry
  const found = yield* registry.getOption(flow)
  if (Option.isNone(found)) {
    const names = (yield* registry.list()).filter(candidate => !reservedFlow(candidate.name) &&
      candidate.body._tag === "Markdown" && Option.isSome(candidate.model)).map(candidate => candidate.name).sort()
    return yield* invalid(`No flow "${flow}" is registered on this workspace. The workspace has: ${names.join(", ") || "no repository flows"}.`)
  }
  const descriptor = found.value
  if (descriptor.body._tag !== "Markdown") {
    return yield* invalid(`"${flow}" is a ${descriptor.body.path.split("/").at(-1) ?? descriptor.body.path}. Schedules run flow.mdx.`)
  }
  if (Object.hasOwn(descriptor.frontmatter, "input") || Object.hasOwn(descriptor.frontmatter, "schema")) {
    return yield* invalid(`"${flow}" declares an input schema the engine ignores (discovery warning unsupported_input_schema). Remove it: a trigger delivers your registered input to the flow as JSON, unvalidated.`)
  }
  if (descriptor.body.contentDigest === undefined) return yield* invalid(`"${flow}" has unmeasured source bytes and has no executable identity.`)
  if (Option.isNone(descriptor.model)) return yield* invalid(`Add a model to "${flow}" to schedule it.`)
  const model = descriptor.model.value
  // The resolve `AgentSession.launch` makes, moved to registration so a
  // missing provider is read before the schedule exists instead of at fire.
  // Every seat of an ordered fallback list must resolve, since any may run.
  const resolver = yield* SeatResolver.SeatResolver
  for (const seat of typeof model === "string" ? [model] : model) {
    yield* resolver.resolve(seat).pipe(
      Effect.mapError(() => invalid(`Connect ${seat.split(":")[0]} to schedule "${flow}".`)))
  }
  return descriptor
})

/** The current row for this slug, so a re-apply raises the revision the upsert
 * admits instead of colliding with the row a person already approved. */
const currentRegistration = (slug: string) => Effect.gen(function*() {
  const remote = yield* requireRemote
  const existing = rows(yield* remote.registrations).map(record).find(row => row.job === `flow:${slug}`)
  return { revision: typeof existing?.revision === "number" ? existing.revision : 0,
    digest: typeof existing?.digest === "string" ? existing.digest : "" }
})

export const triggerLayers = Layer.mergeAll(
  Interpreter.layer(Trigger), Interpreter.layer(RunTrigger), Interpreter.layer(PrepareTrigger),
  Interpreter.layer(ActivateTrigger), Interpreter.layer(FireTrigger), Interpreter.layer(RecoverTrigger),
  Recover.toLayer(({ request, deadlineAt }) => Effect.gen(function*() {
    if (Date.now() >= deadlineAt) return yield* invalid("The resume request reached its configured time limit")
    const remote = yield* requireRemote
    if (remote.repo !== request.repo) return yield* invalid("The schedule belongs to another repository")
    const recovered = recoverTriggerRequest(request, yield* remote.registrations, remote.workspaceId)
    return typeof recovered === "string" ? yield* invalid(recovered) : recovered
  })),
  RefuseTrigger.toLayer(() => Effect.fail(invalid("A schedule registration names one repository flow, one slug, one UTC cron schedule and the plan a person approved"))),
  Prepare.toLayer(({ request, deadlineAt }) => Effect.gen(function*() {
    if (Date.now() >= deadlineAt) return yield* invalid("The registration reached its configured time limit")
    const remote = yield* requireRemote
    if (remote.repo !== request.repo || (request.workspaceId !== undefined && request.workspaceId !== remote.workspaceId)) {
      return yield* invalid("The schedule belongs to another workspace")
    }
    const fields = request.schedule.trim().split(/\s+/).filter(field => field !== "")
    if (fields.length !== 5) return yield* invalid("schedule must have five cron fields in UTC")
    // Plue admits `* * * * *`, which at this registrar's token ceiling is 288
    // million tokens a day on one schedule. A literal minute is the floor.
    if (!/^\d{1,2}$/.test(fields[0]!)) return yield* invalid("Schedules run at most once an hour.")
    const approvedPlanId = request.approvedPlanId ?? "", approvedPlanDigest = request.approvedPlanDigest ?? ""
    if (!approvedPlanId || !/^[a-f0-9]{64}$/.test(approvedPlanDigest)) return yield* invalid("a flow trigger must name the plan a person approved")
    const descriptor = yield* admittedEntry(request.flow)
    const executionDigest = Descriptor.executionDigest(descriptor)
    // Discovery measured these bytes once, at host start. This is the second
    // read, before the snapshot whose revision the receipt names, so a
    // working copy edited after the approval cannot be labelled as approved.
    yield* (yield* Registry.Registry).loadBody(request.flow, executionDigest).pipe(
      Effect.mapError(() => invalid(`"${request.flow}" changed on disk. Review the preview and approve it again.`)))
    yield* (yield* Jj.Jj).snapshot("repository trigger registration")
    const source = (yield* (yield* NativeCoding).read()).head
    if (source.kind !== "resolved") return yield* invalid("Resolve native source conflicts before registering a schedule")
    const control = yield* ControlRuntime
    // The plan a person approved, read by the id the app sent. The app owns
    // its own idempotency key; reproducing one here would couple both halves
    // to a shared string and mint a second, unapproved plan when they differ.
    const stored = yield* control.getPlan(approvedPlanId).pipe(
      Effect.mapError(() => invalid(`The approved plan for "${request.flow}" is not stored on this workspace.`)))
    const card = stored.card
    if (card.flowId !== request.flow) return yield* invalid(`The approved plan is for "${card.flowId}", not "${request.flow}".`)
    if (card.executionDigest !== executionDigest) {
      return yield* invalid(`The approved plan no longer reproduces for "${request.flow}"; review the preview and approve it again.`)
    }
    if (card.digest !== approvedPlanDigest) return yield* invalid(`The approved plan for "${request.flow}" does not match the digest you sent.`)
    if (Digest.canonical(stored.decodedInput) !== Digest.canonical(request.input)) {
      return yield* invalid(`The approved plan for "${request.flow}" was made for different input.`)
    }
    // The limits this registration names bound every unattended fire of it, and
    // the envelope carrying them is what Smithers Cloud stores and validates.
    // A flow that declares its own ceiling keeps it when the registration names
    // none; the deployment ceiling caps either one.
    const budget = request.budget ?? card.envelope.budget
    if (!card.executionDigest || budget.milliseconds === undefined || budget.tokens === undefined ||
        budget.milliseconds < 1 || budget.tokens < 1 ||
        budget.milliseconds > deploymentMinutes * 60_000 || budget.tokens > deploymentTokens) {
      return yield* invalid("The job declaration has no bounded reviewed execution policy")
    }
    // Step 3 of the approval sequence, re-verified here: this host asks its own
    // journal whether a person decided this exact plan. The registrar never
    // decides one, and a pending or denied plan registers nothing.
    if (stored.decision !== "approved") return yield* invalid(`The plan for "${request.flow}" is ${stored.decision}; a person approves the preview before it can be scheduled.`)
    // Planned once more with no key, so this reads the flow as it is now
    // instead of replaying the card the key already stored. A discovery
    // snapshot that moved under the approval stops here.
    const fresh = yield* control.plan({ flowId: request.flow, input: request.input }).pipe(
      Effect.mapError(() => invalid(`"${request.flow}" could not be planned on this workspace`)))
    if (fresh.card.digest !== approvedPlanDigest || fresh.card.executionDigest !== card.executionDigest) {
      return yield* invalid(`The approved plan no longer reproduces for "${request.flow}"; review the preview and approve it again.`)
    }
    const testRunId = request.testRunId
    if (testRunId !== undefined) {
      const run = yield* control.getRun(testRunId).pipe(Effect.mapError(() => invalid("The named test run is not a run of this workspace")))
      if (run.planId !== card.planId || run.planDigest !== card.digest || run.status !== "completed") {
        return yield* invalid("The named test run is not a completed run of the plan you approved")
      }
    }
    const current = yield* currentRegistration(request.slug)
    if (request.expectedRevision !== undefined && current.revision !== request.expectedRevision) return yield* invalid("The schedule changed while resuming. Read it again before retrying.")
    return { planId: card.planId, planDigest: card.digest, executionDigest: card.executionDigest,
      envelope: json({ ...card.envelope, budget }),
      sourceRevision: source.commitId, revision: current.revision + 1, candidate: triggerCandidate(request),
      ...(testRunId === undefined ? {} : { testRunId }) }
  }).pipe(Effect.mapError(error => error instanceof CodingError ? error : invalid("The schedule could not be prepared")))),
  Activate.toLayer(({ request, plan, deadlineAt }) => Effect.gen(function*() {
    if (Date.now() >= deadlineAt) return yield* invalid("The registration reached its configured time limit")
    const remote = yield* requireRemote
    const body = { repo: request.repo, workspace_id: remote.workspaceId, flow_id: request.flow, revision: plan.revision,
      digest: plan.candidate, source_revision: plan.sourceRevision, execution_digest: plan.executionDigest,
      envelope: plan.envelope, mode: "enabled", events: [], schedule: request.schedule, input: request.input,
      approved_plan_id: request.approvedPlanId, approved_plan_digest: request.approvedPlanDigest }
    const registration = yield* remote.register(`flow:${request.slug}`, json(body)).pipe(Effect.flatMap(Schema.decodeUnknownEffect(TriggerRegistration)),
      Effect.mapError(error => error instanceof CodingError ? error : invalid("The schedule registration returned an invalid receipt")))
    if (registration.revision !== plan.revision || registration.digest !== plan.candidate || registration.source_revision !== plan.sourceRevision ||
        registration.schedule !== request.schedule || !registration.enabled) {
      return yield* invalid("Registration did not retain the exact candidate and source")
    }
    return { requestId: request.requestId ?? plan.candidate, slug: request.slug, flow: request.flow, planId: plan.planId,
      planDigest: plan.planDigest, executionDigest: plan.executionDigest, envelope: plan.envelope,
      sourceRevision: plan.sourceRevision, ...(plan.testRunId === undefined ? {} : { testRunId: plan.testRunId }), registration }
  }).pipe(Effect.mapError(error => error instanceof CodingError ? error : invalid("The exact schedule could not be registered")))),
  Fire.toLayer(({ request, dispatchKey, deadlineAt }) => Effect.gen(function*() {
    const remote = yield* requireRemote
    if (!remote.manual || Date.now() >= deadlineAt) return yield* invalid("The manual request is unavailable or expired")
    if (remote.repo !== request.repo || (request.workspaceId !== undefined && request.workspaceId !== remote.workspaceId)) {
      return yield* invalid("The schedule belongs to another workspace")
    }
    const current = yield* currentRegistration(request.slug)
    if (current.revision < 1 || !current.digest) return yield* invalid(`No schedule "${request.slug}" is registered on this repository.`)
    // One durable fire step, one dispatch. The registration's revision is the
    // same for every "run now", so an id derived from it made Plue return the
    // first dispatch again instead of enqueuing a second.
    const requestId = request.requestId ?? dispatchKey
    const response = yield* remote.manual(`flow:${request.slug}`, requestId, json({ repo: request.repo, workspace_id: remote.workspaceId,
      revision: current.revision, digest: current.digest, step_id: "fire", prompt: `Run ${request.slug} now.` }))
    const row = record(response)
    if (typeof row.registration_id !== "string" || !String(row.dispatch_id) || row.revision !== current.revision || row.digest !== current.digest) {
      return yield* invalid("The manual dispatch did not retain the exact registered schedule")
    }
    return { requestId, slug: request.slug, flow: request.flow, dispatchId: String(row.dispatch_id), registrationId: row.registration_id,
      revision: current.revision, digest: current.digest, status: typeof row.status === "string" ? row.status : "submitted",
      ...(typeof row.run_id === "string" && row.run_id ? { runId: row.run_id } : {}) }
  }).pipe(Effect.mapError(error => error instanceof CodingError ? error : invalid("The schedule could not be fired")))),
  ExecuteTrigger.toLayer(({ request, deadlineAt }) => Effect.gen(function*() {
    const owning = yield* Effect.serviceOption(ModuleOwner)
    if (Option.isNone(owning) || owning.value.flowId !== "repository/trigger") return yield* invalid("A schedule registration needs its approved Control entry")
    const runtime = yield* FlowRuntime.FlowRuntime, instance = yield* FlowRuntime.FlowInstance
    const key = (part: string) => Digest.digest(Digest.canonical(["repository/trigger/v1", instance.executionId, request.slug, part]))
    if (request.operation === "fire") return yield* runtime.execute(FireTrigger, { executionId: key("fire"), payload: { request, dispatchKey: key("fire"), deadlineAt } })
    const registration = request.operation === "resume"
      ? yield* runtime.execute(RecoverTrigger, { executionId: key("recover"), payload: { request, deadlineAt } }) : request
    const plan = yield* runtime.execute(PrepareTrigger, { executionId: key("prepare"), payload: { request: registration, deadlineAt } })
    return yield* runtime.execute(ActivateTrigger, { executionId: key("activate"), payload: { request: registration, plan, deadlineAt } })
  }).pipe(Effect.mapError(error => error instanceof CodingError ? error : new CodingError({ code: "execution", message: "The schedule registration did not complete; inspect the retained run" }))))
).pipe(Layer.provideMerge(RunCatalogRead.layer))
