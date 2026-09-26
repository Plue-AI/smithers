/**
 * Who a role task runs as, decided by the host at dispatch.
 *
 * A role task's payload names its principal by id and the roster snapshot it
 * was composed against by revision; it never carries the principal's
 * profile or grants. The host resolves both from a trusted
 * {@link RosterRegistry} that only host code fills — from the organization's
 * files on disk — and a profile, grant, or prompt placed in a payload is
 * therefore either ignored (unknown keys are not read) or refused:
 *
 * - the revision must be one the registry pinned;
 * - the principal must be active, with every principal up its hiring chain
 *   active, both in the pinned snapshot and in the registry's current one, so
 *   pausing or retiring a principal or an ancestor stops tasks composed
 *   against an older snapshot;
 * - the pinned grants must still be inside the current grants;
 * - the seat must be the profile's seat;
 * - the composition (common instructions, charter, skills, task, context)
 *   is recomposed from the snapshot and must match the payload's digest and
 *   prompt exactly;
 * - a workspace must be granted, belong to a granted repository, and have
 *   been prepared by the same execution.
 *
 * {@link layer} installs these checks around the `organization/role-task`
 * handlers of an action layer, the way `flows/coding/planning-authority.ts`
 * wraps evidence actions: it wraps `FlowRuntime.register` and
 * `Action.Implementations.add`, reads the composition's `AgentAction.Host`
 * at execution, and runs the handler under a {@link RoleHost} built for the
 * principal and under `CapabilitySet.attenuate` of that host's envelope.
 *
 * @since 1.0.0
 */
import * as AgentAction from "@smthrs/agent/AgentAction"
import { FlowEngine } from "@smthrs/engine"
import { Action, FlowRuntime } from "@smthrs/flow"
import { HarnessError } from "@smthrs/harness/HarnessError"
import * as CapabilitySet from "@smthrs/kernel/CapabilitySet"
import * as Sandbox from "@smthrs/sandbox/Sandbox"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import type * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as Ref from "effect/Ref"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import type * as Config from "./Config.ts"
import * as Grants from "./Grants.ts"
import * as Confined from "./internal/confined.ts"
import { canonicalDigest, sha256Hex } from "./internal/digest.ts"
import * as RetrievalLog from "./internal/retrievalLog.ts"
import * as WikiEdit from "./internal/wikiEdit.ts"
import * as Profile from "./Profile.ts"
import * as Prompt from "./Prompt.ts"
import * as RoleHost from "./RoleHost.ts"
import * as Roster from "./Roster.ts"
import * as Skills from "./Skills.ts"
import * as Workspace from "./Workspace.ts"

/**
 * Everything a role task is composed from, pinned together: the roster, the
 * common operating instructions, and the skill pack.
 *
 * @category models
 * @since 1.0.0
 */
export interface Snapshot {
  /** SHA-256 over the roster revision, the common instructions, and the pack revision. */
  readonly revision: string
  readonly roster: Roster.Roster
  readonly common: Prompt.Common
  readonly skills: Skills.Pack
}

/**
 * A snapshot that could not be built: a roster that breaks an invariant, or
 * organization files that could not be read.
 *
 * @category errors
 * @since 1.0.0
 */
export class AuthorityError extends Schema.TaggedError<AuthorityError>()(
  "@smthrs/organization/Authority/AuthorityError",
  {
    code: Schema.Literals(["invalid-roster", "load-failed"]),
    message: Schema.String,
    violations: Schema.Array(Roster.Violation)
  }
) {}

/**
 * Validates a roster against its skill pack and pins it with its common
 * instructions.
 *
 * @category constructors
 * @since 1.0.0
 */
export const makeSnapshot = (input: {
  readonly roster: Roster.Roster
  readonly common: Prompt.Common
  readonly skills: Skills.Pack
  readonly weeklyMeeting?: boolean | undefined
  readonly hireSeats?: ReadonlyArray<string> | undefined
}): Result.Result<Snapshot, AuthorityError> => {
  const violations = Roster.validate([...input.roster.profiles.values()], {
    weeklyMeeting: input.weeklyMeeting ?? false,
    skills: [...input.skills.skills.keys()],
    hireSeats: input.hireSeats
  })
  if (violations.length > 0) {
    return Result.fail(
      new AuthorityError({
        code: "invalid-roster",
        message: `the roster breaks ${violations.length} invariant(s)`,
        violations
      })
    )
  }
  return Result.succeed({
    revision: canonicalDigest({
      roster: input.roster.revision,
      common: { id: input.common.id, version: input.common.version, digest: sha256Hex(input.common.text) },
      skills: input.skills.revision
    }),
    roster: input.roster,
    common: input.common,
    skills: input.skills
  })
}

/**
 * The largest common-instructions page {@link loadSnapshot} reads.
 *
 * @category constants
 * @since 1.0.0
 */
export const maxCommonBytes = 65_536

/**
 * Loads a snapshot from a wiki root and its loaded organization
 * configuration: the roster under `rosterDir`, the skills under `skillsDir`
 * (an empty pack when unset), and the common instructions page `commonFile`
 * (empty when unset), each read confined to the root's real path.
 *
 * @category loading
 * @since 1.0.0
 */
export const loadSnapshot = (
  root: string,
  loaded: Pick<Config.Loaded, "organization">
): Effect.Effect<Snapshot, AuthorityError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const path = yield* Path.Path
    const organization = loaded.organization
    const failed = (message: string) => new AuthorityError({ code: "load-failed", message, violations: [] })
    const roster = yield* Roster.load(path.join(root, organization.rosterDir)).pipe(
      Effect.mapError((error) => failed(`the roster could not be loaded: ${error.message}`))
    )
    const skills: Skills.Pack = organization.skillsDir === undefined
      ? { revision: Skills.revisionOf([]), skills: new Map() }
      : yield* Skills.loadPack(path.join(root, organization.skillsDir)).pipe(
        Effect.mapError((error) => failed(`the skills could not be loaded: ${error.path} ${error.message}`))
      )
    const commonFile = organization.commonFile
    const text = commonFile === undefined ? "" : yield* Confined.readText({
      root,
      relative: commonFile,
      maxBytes: maxCommonBytes,
      admit: () => true
    }).pipe(Effect.mapError((refusal) => failed(`${commonFile} ${refusal.message}`)))
    const common: Prompt.Common = {
      id: commonFile ?? "none",
      version: sha256Hex(text).slice(0, 16),
      text
    }
    return yield* Effect.fromResult(
      makeSnapshot({
        roster,
        common,
        skills,
        weeklyMeeting: organization.weeklyMeeting,
        hireSeats: organization.hireSeats
      })
    )
  })

/**
 * Why a role task was refused at dispatch.
 *
 * @category schemas
 * @since 1.0.0
 */
export const RefusalReason = Schema.Literals([
  "malformed-payload",
  "unknown-revision",
  "unknown-principal",
  "inactive",
  "grants-narrowed",
  "seat-mismatch",
  "composition-failed",
  "composition-mismatch",
  "workspace-not-granted",
  "repository-not-granted",
  "workspace-foreign",
  "workspace-unavailable",
  "host-unavailable"
])

/**
 * Why a role task was refused.
 *
 * @category models
 * @since 1.0.0
 */
export type RefusalReason = typeof RefusalReason.Type

/**
 * A role task the host refused to run.
 *
 * @category errors
 * @since 1.0.0
 */
export class DispatchRefused extends Schema.TaggedError<DispatchRefused>()(
  "@smthrs/organization/Authority/DispatchRefused",
  { reason: RefusalReason, message: Schema.String }
) {}

const refuse = (reason: RefusalReason, message: string) => new DispatchRefused({ reason, message })

const fromDenied = (denied: Grants.Denied, when: string): DispatchRefused =>
  refuse(denied.reason === "unknown-principal" ? "unknown-principal" : "inactive", `${when}: ${denied.message}`)

/**
 * Resolves the principal a task pinned at `pinned` may run as now.
 *
 * The profile comes from the pinned roster. It and every principal up its
 * hiring chain must be active there and in `current`, and its pinned grants
 * must still be inside its current grants; otherwise the task is refused.
 *
 * @category authority
 * @since 1.0.0
 */
export const resolvePrincipal = (
  pinned: Pick<Roster.Roster, "profiles">,
  current: Pick<Roster.Roster, "profiles">,
  id: string
): Result.Result<Profile.Profile, DispatchRefused> => {
  const profile = Roster.resolveActive(pinned, id)
  if (Result.isFailure(profile)) return Result.fail(fromDenied(profile.failure, "in the pinned roster"))
  const live = Roster.resolveActive(current, id)
  if (Result.isFailure(live)) return Result.fail(fromDenied(live.failure, "in the current roster"))
  const widened = Grants.widenings(profile.success.grants, live.success.grants, { hired: false })
  if (widened.length > 0) {
    return Result.fail(
      refuse("grants-narrowed", `${id}'s grants were narrowed since the task was composed (${widened[0]!.detail})`)
    )
  }
  return Result.succeed(profile.success)
}

/**
 * The trusted roster registry: snapshots by revision, and the current one.
 *
 * @category models
 * @since 1.0.0
 */
export interface Registry {
  /** Pins a snapshot, makes it current, and returns its revision. */
  readonly pin: (snapshot: Snapshot) => Effect.Effect<string>
  readonly current: Effect.Effect<Snapshot>
  readonly get: (revision: string) => Effect.Effect<Snapshot, DispatchRefused>
  /** {@link resolvePrincipal} of `id` against the pinned `revision` and the current snapshot. */
  readonly resolve: (
    revision: string,
    id: string
  ) => Effect.Effect<{ readonly profile: Profile.Profile; readonly snapshot: Snapshot }, DispatchRefused>
}

/**
 * The roster registry tag.
 *
 * @category services
 * @since 1.0.0
 */
export const RosterRegistry: Context.Service<RosterRegistry, Registry> = Context.Service(
  "@smthrs/organization/Authority/RosterRegistry"
)

/**
 * The roster registry.
 *
 * @category services
 * @since 1.0.0
 */
export type RosterRegistry = Registry

/**
 * A registry holding `initial` as its current snapshot.
 *
 * @category constructors
 * @since 1.0.0
 */
export const makeRegistry = (initial: Snapshot): Effect.Effect<Registry> =>
  Effect.gen(function*() {
    const state = yield* Ref.make({ current: initial, pinned: new Map([[initial.revision, initial]]) })
    const get = (revision: string) =>
      Effect.flatMap(Ref.get(state), ({ pinned }) => {
        const snapshot = pinned.get(revision)
        return snapshot === undefined
          ? Effect.fail(refuse("unknown-revision", `roster revision ${revision} is not pinned by this host`))
          : Effect.succeed(snapshot)
      })
    return {
      pin: (snapshot) =>
        Ref.update(state, ({ pinned }) => ({
          current: snapshot,
          pinned: new Map([...pinned, [snapshot.revision, snapshot]])
        })).pipe(Effect.as(snapshot.revision)),
      current: Effect.map(Ref.get(state), ({ current }) => current),
      get,
      resolve: (revision, id) =>
        Effect.gen(function*() {
          const snapshot = yield* get(revision)
          const { current } = yield* Ref.get(state)
          const profile = yield* Effect.fromResult(resolvePrincipal(snapshot.roster, current.roster, id))
          return { profile, snapshot }
        })
    }
  })

/**
 * Provides a {@link RosterRegistry} over `initial`.
 *
 * @category layers
 * @since 1.0.0
 */
export const layerRegistry = (initial: Snapshot): Layer.Layer<RosterRegistry> =>
  Layer.effect(RosterRegistry)(makeRegistry(initial))

/**
 * The action tag whose handlers {@link layer} guards.
 *
 * @category constants
 * @since 1.0.0
 */
export const roleTaskTag = "organization/role-task"

/**
 * A workspace a role task works in: its key and the repository it holds.
 *
 * @category schemas
 * @since 1.0.0
 */
export const TaskWorkspace = Schema.Struct({
  key: Workspace.Key,
  repository: Profile.Container,
  /** The host commit the workspace was seeded from; the session refuses a machine seeded otherwise. */
  commit: Schema.optionalKey(Workspace.CommitId)
})

/**
 * A role task's payload. It names the principal and snapshot; the profile,
 * grants, and system prompt are the host's.
 *
 * @category schemas
 * @since 1.0.0
 */
export const RoleTaskPayload = Schema.Struct({
  revision: Schema.NonEmptyString,
  principal: Profile.PrincipalId,
  seat: Profile.Seat,
  task: Profile.TaskContract,
  context: Schema.Array(Prompt.ContextEntry),
  digest: Schema.NonEmptyString,
  workspace: Schema.optionalKey(TaskWorkspace)
})

/**
 * A role task's payload.
 *
 * @category models
 * @since 1.0.0
 */
export type RoleTaskPayload = typeof RoleTaskPayload.Type

/**
 * The prompt of a role task: the task contract, then its fenced context.
 * This is exactly the prompt half of `Prompt.compose`.
 *
 * @category prompts
 * @since 1.0.0
 */
export const promptOf = (payload: Pick<RoleTaskPayload, "task" | "context">): string => {
  const task = Prompt.renderTask(payload.task)
  return payload.context.length === 0
    ? task
    : `${task}\n\n# Context\n\n${payload.context.map(Prompt.renderContext).join("\n\n")}`
}

/**
 * Composes a principal's task from a snapshot: its common instructions, the
 * profile's charter and skills, the task, and the context.
 *
 * @category prompts
 * @since 1.0.0
 */
export const compose = (
  snapshot: Snapshot,
  profile: Profile.Profile,
  task: Profile.TaskContract,
  context: ReadonlyArray<Prompt.ContextEntry>
): Result.Result<Prompt.Composed, DispatchRefused> => {
  const skills = Skills.select(snapshot.skills, profile.skills)
  if (Result.isFailure(skills)) {
    return Result.fail(refuse("composition-failed", `${profile.id}: ${skills.failure.path} ${skills.failure.message}`))
  }
  return Result.mapError(
    Prompt.compose({ common: snapshot.common, profile, task, skills: skills.success, context }),
    (error) => refuse("composition-failed", `${profile.id}: ${error.message}`)
  )
}

/**
 * A role task the host admitted: the principal, the snapshot, and the
 * trusted composition.
 *
 * @category models
 * @since 1.0.0
 */
export interface Authorized {
  readonly profile: Profile.Profile
  readonly snapshot: Snapshot
  readonly composed: Prompt.Composed
  readonly workspace: typeof TaskWorkspace.Type | undefined
}

const decodePayload = Schema.decodeUnknownEffect(RoleTaskPayload)

/**
 * Every dispatch-time check on a role task's payload, for one execution.
 *
 * @category authority
 * @since 1.0.0
 */
export const authorize = (
  raw: unknown,
  executionId: string
): Effect.Effect<Authorized, DispatchRefused, RosterRegistry> =>
  Effect.gen(function*() {
    const payload = yield* decodePayload(raw).pipe(
      Effect.mapError(() => refuse("malformed-payload", "the role task payload does not decode"))
    )
    const registry = yield* RosterRegistry
    const { profile, snapshot } = yield* registry.resolve(payload.revision, payload.principal)
    if (payload.seat !== profile.seat) {
      return yield* refuse("seat-mismatch", `${profile.id} runs on its profile's seat, not ${payload.seat}`)
    }
    const composed = yield* Effect.fromResult(compose(snapshot, profile, payload.task, payload.context))
    if (composed.digest !== payload.digest || composed.prompt !== promptOf(payload)) {
      return yield* refuse("composition-mismatch", `the task does not match ${profile.id}'s composition`)
    }
    const workspace = payload.workspace
    if (workspace !== undefined) {
      if (!profile.grants.tools.includes("workspace")) {
        return yield* refuse("workspace-not-granted", `${profile.id} does not hold workspace`)
      }
      if (!profile.grants.repositories.includes(workspace.repository)) {
        return yield* refuse("repository-not-granted", `${profile.id} holds no grant for ${workspace.repository}`)
      }
      if (!workspace.key.startsWith(`${executionId}/${workspace.repository}/`)) {
        return yield* refuse("workspace-foreign", `workspace ${workspace.key} was not prepared by this execution`)
      }
    }
    return { profile, snapshot, composed, workspace }
  })

const refusedAsFailure = (refused: DispatchRefused): HarnessError =>
  new HarnessError({
    code: "assembly_failed",
    message: `organization/role-task refused (${refused.reason}): ${refused.message}`,
    cause: { reason: refused.reason }
  })

/**
 * Runs one role-task handler for `raw` under its principal's host.
 */
const guarded = <A, E, R>(
  raw: unknown,
  executionId: string | undefined,
  handler: Effect.Effect<A, E, R>,
  services: Context.Context<RosterRegistry | RoleHost.Resources>,
  workspaces: Option.Option<Workspace.Service>,
  retrievalStore: RetrievalLog.Store
) =>
  Effect.gen(function*() {
    const instance = yield* Effect.serviceOption(FlowRuntime.FlowInstance)
    const execution = Option.isSome(instance) ? instance.value.executionId : executionId
    if (execution === undefined) {
      return yield* Effect.die(new Error("organization/role-task requires its flow execution"))
    }
    const base = yield* Effect.serviceOption(AgentAction.Host)
    if (Option.isNone(base)) {
      return yield* Effect.die(new Error("organization/role-task requires its runtime AgentAction.Host"))
    }
    const authorized = yield* authorize(raw, execution).pipe(
      Effect.provide(services),
      Effect.mapError(refusedAsFailure)
    )
    return yield* Effect.scoped(Effect.gen(function*() {
      let tools: RoleHost.WorkspaceTools | undefined
      let boundary: typeof FlowEngine.SnapshotBoundary.Service | undefined
      if (authorized.workspace !== undefined) {
        if (Option.isNone(workspaces)) {
          return yield* refusedAsFailure(refuse("workspace-unavailable", "this host configured no workspaces"))
        }
        const key = authorized.workspace.key
        const session = yield* workspaces.value.session(key, { commit: authorized.workspace.commit }).pipe(
          Effect.mapError((error) => refusedAsFailure(refuse("workspace-unavailable", error.message)))
        )
        const context = yield* Layer.build(
          Sandbox.layerHost({ acquire: () => Effect.succeed(session) }, { session: key })
        )
        tools = { services: context, workdir: session.workdir }
        boundary = RoleHost.snapshotBoundary(session)
      }
      const resources = Context.get(services, RoleHost.Resources)
      // Every page the task retrieves, and every page of the run it cites,
      // becomes url evidence on its result.
      const retrievals = authorized.profile.grants.tools.includes("retrieval")
        ? RetrievalLog.task(retrievalStore, execution)
        : undefined
      // Every wiki page the task edits becomes file evidence on its result.
      const edited: Array<RoleHost.WikiEdited> = []
      const built = yield* RoleHost.make({
        base: base.value,
        profile: authorized.profile,
        system: authorized.composed.system,
        executionId: execution,
        resources,
        workspace: tools,
        retrievals: retrievals?.log,
        edits: { record: (edit) => Effect.sync(() => void edited.push(edit)) }
      })
      const hosted = handler.pipe(
        Effect.provideService(AgentAction.Host, built.host),
        CapabilitySet.attenuate(built.envelope)
      )
      // Compensable workspace edits snapshot the machine's workspace, never
      // the host repository the engine's own boundary would reach.
      const result = yield* (boundary === undefined
        ? hosted
        : Effect.provideService(hosted, FlowEngine.SnapshotBoundary, boundary))
      const withEdits = WikiEdit.withEvidence(result, edited)
      if (retrievals === undefined) return withEdits
      return RetrievalLog.withEvidence(withEdits, yield* retrievals.entries)
    }))
  })

/**
 * Guards the `organization/role-task` handlers `actions` registers, and
 * passes every other registration through unchanged: each execution is
 * authorized by
 * {@link authorize} and runs under its principal's {@link RoleHost} and
 * capability envelope. A refusal fails the task with an `assembly_failed`
 * `HarnessError` naming the reason, before any model call.
 *
 * Apply it directly around the action layers, above the composition's
 * shared runtime and implementation table.
 *
 * @category layers
 * @since 1.0.0
 */
export const layer = <A, E, R>(
  actions: Layer.Layer<A, E, R>
): Layer.Layer<
  A,
  E,
  | Exclude<R, FlowRuntime.FlowRuntime | Action.Implementations>
  | FlowRuntime.FlowRuntime
  | Action.Implementations
  | RosterRegistry
  | RoleHost.Resources
> => {
  const included = (name: string) => name === roleTaskTag
  return actions.pipe(
    Layer.provide(Layer.unwrap(Effect.gen(function*() {
      const services = yield* Effect.context<RosterRegistry | RoleHost.Resources>()
      const workspaces = yield* Effect.serviceOption(Workspace.Workspace)
      const retrievalStore = RetrievalLog.store(Context.get(services, RoleHost.Resources).retrieval?.logDir)
      return Layer.mergeAll(
        Layer.effect(FlowRuntime.FlowRuntime)(Effect.map(FlowRuntime.FlowRuntime, (runtime) => ({
          ...runtime,
          register: (flow, handler) =>
            runtime.register(
              flow,
              included(flow._tag)
                ? (payload, executionId) =>
                  guarded(payload, executionId, handler(payload, executionId), services, workspaces, retrievalStore)
                : handler
            )
        }))),
        Layer.effect(Action.Implementations)(Effect.map(Action.Implementations, (table) => ({
          ...table,
          add: (implementation, options) =>
            table.add(
              included(implementation.name)
                ? {
                  ...implementation,
                  action: (payload) =>
                    guarded(payload, undefined, implementation.action(payload), services, workspaces, retrievalStore)
                }
                : implementation,
              options
            )
        })))
      )
    })))
  )
}
