/** Private deployment recipe. Existing native host, catalog, agents and JJ ports. */
import * as Seat from "@smthrs/agent/Seat"
import * as SeatResolver from "@smthrs/agent/SeatResolver"
import type * as SeatRouter from "@smthrs/agent/SeatRouter"
import * as Digest from "@smthrs/core/Digest"
import { HumanTask } from "@smthrs/flow"
import * as Executable from "@smthrs/registry/Executable"
import * as Registry from "@smthrs/registry/Registry"
import { Context, Effect, FileSystem, Layer } from "effect"
import { join } from "node:path"
import type * as Application from "../../packages/smithers/src/Application.ts"
import * as NativeControl from "../../packages/smithers/src/internal/NativeControl.ts"
import * as NativeEquipment from "../../packages/smithers/src/internal/NativeEquipment.ts"
import { expandSeat, seatAliases, seatRefusal } from "../../packages/smithers/src/Providers.ts"
import * as Serve from "../../packages/smithers/src/Serve.ts"
import { registration as registerRepository } from "../register-repository/host.ts"
import { activationLayers } from "../repository/activation.ts"
import { changeLayers, changeModelLayers, changeModelNames } from "../repository/changes.ts"
import { checkLayers as repositoryCheckLayers } from "../repository/checks.ts"
import { deliveryLayers } from "../repository/delivery.ts"
import { evaluationLayers, ScoreCase } from "../repository/evaluation.ts"
import { executionLayers } from "../repository/execution.ts"
import { inspectionLayers } from "../repository/inspection.ts"
import { evaluatorLayer } from "../repository/jev-checks.ts"
import { failureLayer, jobFlows, modelLayers, modelNames } from "../repository/jobs.ts"
import {
  bindRepositoryRegistry,
  type CodingRoute,
  provisionBuiltins,
  repositoryCatalog,
  repositoryRegistration,
  runningRepositoryPolicy
} from "../repository/registry.ts"
import type { RepositoryRemote } from "../repository/remote.ts"
import { replyLayers } from "../repository/replies.ts"
import { RunJob, RunSetup, setupLayers, SuggestSetup } from "../repository/setup.ts"
import { RunTrigger, triggerLayers } from "../repository/triggers.ts"
import { ReviewPage } from "../wiki/workflow.ts"
import { atomOperations, EditAtom } from "./atoms.ts"
import { repositoryCheckEnvironment } from "./check-environment.ts"
import { checkDelegate, checkLayers } from "./checks.ts"
import { correctionLayers, SelectRepair } from "./correction.ts"
import { dispatchModels } from "./dispatch.ts"
import { dispatchRegistration } from "./dispatch/flow.ts"
import * as CodingFileSystem from "./filesystem.ts"
import { flowLoadRegistration } from "./flow-load/flow.ts"
import { atomFlows } from "./implementation/flow.ts"
import { jevCheckDelegate, jevCheckLayers } from "./jev-check.ts"
import type { Landing } from "./landing.ts"
import * as LocalLanding from "./local-landing.ts"
import { nativeActions, NativeCoding, nativeLayer, type NativeOptions, NativeTransport } from "./native.ts"
import { evidenceOnly } from "./planning-authority.ts"
import { memoryLayer, type MemoryOptions } from "./planning-memory.ts"
import { planningWikiLayers } from "./planning-wiki.ts"
import { declineLayer, DraftPlan, planningPolicy, preparePlanLayer, ReviewRequest } from "./planning.ts"
import { pocSource } from "./poc-source.ts"
import { pocModels, pocPolicy } from "./poc.ts"
import { preparationLayers } from "./preparation.ts"
import { type ProjectConfig, roleSeatRefusal } from "./project-config.ts"
import { prototypeRegistration } from "./prototype.ts"
import { registration } from "./registration.ts"
import { requestRegistration } from "./request.ts"
import { reviewCheckDelegate, reviewCheckLayers, ReviewLens, reviewRole } from "./review-check.ts"
import {
  securityAuditDelegate,
  securityReviewCheckDelegate,
  securityReviewCheckLayers
} from "./security-review-check.ts"
import * as Snapshots from "./snapshots.ts"
import { sourceAdmission } from "./source-admission.ts"
import { stackBaseLayer } from "./stack.ts"
import * as CodingState from "./state.ts"
import { feedbackLayer, routeMessages } from "./steering.ts"
import { todoLayers } from "./todo.ts"
import { verifyRegistration } from "./verify.ts"
import { cleanupModels } from "./vibe-cleanup.ts"
import { vibeRegistration } from "./vibe.ts"
import { wikiCheckDelegate, wikiCheckLayers, wikiCheckPolicy } from "./wiki-check.ts"
import { separateWikiOutput } from "./wiki-output.ts"
import { runningWikiPolicy } from "./wiki-policy.ts"
import { bindWikiRegistry } from "./wiki-registry.ts"
import { dependencyPagesLayer, wikiRefreshRegistration } from "./wiki-route.ts"

/** Operator configuration, never accepted from a workflow or gateway request. */
export interface Options extends NativeOptions {
  /** Exact system names from the backend's packaged flow catalog. */
  readonly systemFlows: ReadonlyArray<string>
  /** Same operator credential used by Serve; enables the existing native gateway delegation. */
  readonly credential?: string | undefined
  /** Existing authority override, including a narrower operator policy. */
  readonly approvalAuthority?: Application.Config["approvalAuthority"]
  readonly gatewayId: string
  readonly implementationModel: string
  readonly exporterPath?: string | undefined
  readonly checkEnvironment?: Readonly<Record<string, string>> | undefined
  /** The read-only build-cache credential, added only to repository checks' environment. */
  readonly cacheEnvironment?: Readonly<Record<string, string>> | undefined
  /** Exact packaged host bytes and owning-process fence for the Go bridge. */
  readonly runtimeArtifactDigest?: string | undefined
  readonly runtimeSourceRevision?: string | undefined
  readonly ownerGeneration?: number | undefined
  /** Enables the private prompt route using this repository's owning memory/check configuration. */
  readonly planning?:
    | (Omit<MemoryOptions, "repositoryPath"> & {
      readonly reviewer?: string
      readonly seats?: Readonly<Record<string, string>>
      readonly limits?: ProjectConfig["limits"]
      readonly landing?: ProjectConfig["landing"]
      readonly detected?: ProjectConfig["detected"]
    })
    | undefined
  readonly planningModel?: string | undefined
  readonly pocModel?: string | undefined
  readonly wikiModel?: string | undefined
  /** The `coding/review` seat; unset, the host picks one on a provider other than the implementer's. */
  readonly reviewModel?: string | undefined
  /** Operator role→seat pins (`SMITHERS_CODING_SEATS`); they win over the repository's `seats`. */
  readonly seats?: Readonly<Record<string, string>> | undefined
  /**
   * Deployment-owned landing adapter over the reserved repository credential.
   * Repository automation uses it on its own; `coding/vibe` is registered only
   * when `planning` configures the prompt route as well. Without it, the
   * project's `landing` selects a local lander (`local-landing.ts`).
   */
  readonly landing?: Layer.Layer<Landing> | undefined
  /** What a local lander's `jj`, `git` and `gh` processes see; defaults to `checkEnvironment`. */
  readonly landingEnvironment?: Readonly<Record<string, string>> | undefined
  readonly repositoryRemote?: Layer.Layer<RepositoryRemote> | undefined
  /**
   * Where this host keeps `control.db`, `engine.db` and their WAL companions.
   * Defaults to `CodingState.defaultStateRoot(repositoryPath)`, beside the
   * served working copy. A path inside the working copy is refused unless
   * `SMITHERS_CODING_STATE_IN_ROOT` opts in; see `./state.ts`.
   */
  readonly stateRoot?: string | undefined
}

/** The optional routes advertised by this configured host. */
export const configuredCodingRoutes = (
  options: Pick<Options, "planning" | "landing">
): ReadonlyArray<{ readonly name: CodingRoute; readonly capability: string }> => [
  ...(options.planning === undefined ? [] : [{ name: "coding/request" as const, capability: "coding-request/v1" }]),
  ...(options.planning === undefined || (options.landing === undefined && options.planning.landing === undefined)
    ? []
    : [{ name: "coding/vibe" as const, capability: "coding-vibe/v1" }]),
  // The mythical stack verifies rebased candidates with the same checks.
  ...(options.planning === undefined ? [] : [{ name: "coding/verify" as const, capability: "coding-verify/v1" }]),
  // The stack service refreshes the repository wiki the project declares.
  ...(options.planning?.wiki === true ? [{ name: "coding/wiki" as const, capability: "coding-wiki/v1" }] : []),
  // The stack service loads main's flows after every main move (§11.3.1).
  ...(options.planning === undefined ? [] : [{ name: "flow-load" as const, capability: "flow-load/v1" }])
]

/**
 * The built-ins this configured host writes: the defaults, its configured
 * coding routes and the check flows of the commands it detected.
 */
export const provisionHostBuiltins = (
  stateRoot: string,
  policy: string,
  options: Pick<Options, "planning" | "landing">
) =>
  provisionBuiltins(
    stateRoot,
    policy,
    configuredCodingRoutes(options).map((route) => route.name),
    options.planning?.detected ?? []
  )

/**
 * The executables a configured host refuses to serve without, by name.
 *
 * A module that IS its own flow reports no delegate, so `undefined` is the
 * whole of what this host requires of it. A flow that regressed into
 * delegating reports a name here and fails the same check.
 */
export const missingCodingExecutables = (
  built: Pick<Executable.Catalog, "executables">,
  options: Pick<Options, "planning" | "landing">
): ReadonlyArray<string> => {
  const required: ReadonlyArray<readonly [string, string | undefined]> = [
    ...[
      "coding",
      "coding/dispatch",
      "coding/implementation",
      ...configuredCodingRoutes(options).map((route) => route.name)
    ]
      .map((name) => [name, undefined] as const),
    ["repository/setup", RunSetup._tag],
    ["repository/trigger", RunTrigger._tag],
    ["repository-jobs/issues", RunJob._tag]
  ]
  return required.filter(([name, delegate]) =>
    !built.executables.some((entry) => entry.descriptor.name === name && entry.delegate === delegate)
  ).map(([name]) => name)
}

/** Resolve at host startup, including accounts connected since workspace boot. */
export const optionsFromEnv = (environment: Readonly<Record<string, string | undefined>>) =>
  Effect.gen(function*() {
    // A blank pin also stays blank: provisioning uses it to refuse an unavailable explicit model.
    const pinned = environment.SMITHERS_CODING_IMPLEMENT_MODEL
    return {
      implementationModel: pinned ?? (yield* NativeEquipment.accountPoolDefaultModel(environment)) ??
        environment.SMITHERS_CODING_FALLBACK_MODEL ?? ""
    }
  })

const validSystemFlows = (value: unknown): value is ReadonlyArray<string> =>
  Array.isArray(value) && value.length > 0 &&
  value.every((name) => typeof name === "string" && name.length > 0 && name.trim() === name) &&
  new Set(value).size === value.length

/** Missing or malformed launch policy refuses startup before registry imports. */
export const systemFlowsFromEnv = (
  environment: Readonly<Record<string, string | undefined>>
): ReadonlyArray<string> => {
  let value: unknown
  try {
    value = JSON.parse(environment.SMITHERS_SYSTEM_FLOWS ?? "")
  } catch {
    throw new Error("SMITHERS_SYSTEM_FLOWS must be a non-empty JSON array of unique system names")
  }
  if (!validSystemFlows(value)) {
    throw new Error("SMITHERS_SYSTEM_FLOWS must be a non-empty JSON array of unique system names")
  }
  return value
}

const configured = (options: Options) => {
  if (!validSystemFlows(options.systemFlows)) {
    throw new Error("SMITHERS_SYSTEM_FLOWS must supply the backend's system flow names")
  }
  if (seatRefusal(options.implementationModel) !== undefined) {
    throw new Error(
      "Set SMITHERS_CODING_IMPLEMENT_MODEL to a seat alias or an explicit provider:model for coding/implement"
    )
  }
  for (const model of [options.planningModel, options.pocModel, options.wikiModel, options.reviewModel]) {
    if (model !== undefined && seatRefusal(model) !== undefined) {
      throw new Error("Coding role models must be seat aliases or explicit provider:model values")
    }
  }
  for (const [role, seat] of Object.entries(options.seats ?? {})) {
    const refusal = roleSeatRefusal(seat)
    if (refusal !== undefined || !/^[a-z0-9][a-z0-9/_-]{0,63}$/.test(role)) {
      throw new Error(`SMITHERS_CODING_SEATS ${role}: ${refusal ?? "invalid role id"}`)
    }
  }
  if (
    options.planning?.wiki === true &&
    (!options.planning.reviewer?.trim() || !options.planning.wikiOutput?.trim() || !options.planning.pages?.length)
  ) {
    throw new Error("Enabled Wiki requires an explicit reviewer, publication path and page configuration")
  }
  if (
    !/^(?!00000000-0000-0000-0000-000000000000$)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      options.gatewayId
    )
  ) {
    throw new Error("A configured coding host requires its owning SMITHERS_GATEWAY_ID")
  }
  if (!options.credential?.trim() && options.approvalAuthority === undefined) {
    throw new Error(
      "A configured coding host requires SMITHERS_API_KEY or an explicit approval authority, including on loopback"
    )
  }
  if (
    options.runtimeArtifactDigest !== undefined && (
      !/^[a-f0-9]{64}$/.test(options.runtimeArtifactDigest) ||
      !/^[a-f0-9]{40}$/.test(options.runtimeSourceRevision ?? "") ||
      !Number.isSafeInteger(options.ownerGeneration ?? 1) || (options.ownerGeneration ?? 1) <= 0
    )
  ) {
    throw new Error(
      "Runtime bridge identity requires an artifact digest, source revision, and positive owner generation"
    )
  }
}

/**
 * Resolves the role through the existing workspace/user credential route.
 *
 * The operator environment supplies the defaults; the repository's own
 * `seats` declaration (`.smithers/coding-project.json`) wins for every role it
 * names, and may name roles only its flows declare (`model: triage`). A role
 * whose seat is `auto` has no fixed seat: the agent routes it by the routing
 * graph, as {@link rolePhases} names its phase.
 */
export const roleResolver = (
  base: SeatResolver.Service,
  implementationModel: string,
  models: RoleModels = {}
): SeatResolver.Service => {
  const roles = effectiveRoles(implementationModel, models)
  const routed = (id: string) => Object.hasOwn(roles, id) && roles[id] === Seat.auto
  // An unpinned review tries its default seats in order (reviewSeats).
  const reviewPinned = models.reviewModel !== undefined || Object.hasOwn(models.seats ?? {}, reviewRole)
  const candidates = (id: string): ReadonlyArray<string> =>
    id === reviewRole && !reviewPinned
      ? reviewSeats(models.seats?.["coding/implement"] ?? implementationModel)
      : [Object.hasOwn(roles, id) ? roles[id]! : id]
  return SeatResolver.make({
    resolve: (id) =>
      routed(id)
        ? Effect.fail(new Seat.SeatUnresolved({ seat: id, message: `${id} routes by the routing graph` }))
        : firstResolved(base, candidates(id)).pipe(
          Effect.map((seat) => Object.hasOwn(roles, id) ? Seat.make({ ...seat, id }) : seat)
        ),
    routedAs: (id) => routed(id) ? { phase: Object.hasOwn(rolePhases, id) ? rolePhases[id] : undefined } : undefined
  })
}

/** The first of `seats` that resolves, or the first one's refusal when none does. */
const firstResolved = (
  base: SeatResolver.Service,
  [first, ...rest]: ReadonlyArray<string>
): Effect.Effect<Seat.Seat, Seat.SeatUnresolved> =>
  rest.length === 0
    ? base.resolve(first!)
    : base.resolve(first!).pipe(
      Effect.catch((refusal) => firstResolved(base, rest).pipe(Effect.mapError(() => refusal)))
    )

/**
 * The phase each built-in role routes as when its seat is `auto`. A
 * repository's own role, and `coding/dispatch`, whose turn may be anything,
 * leave the phase to Jev.
 */
export const rolePhases: Readonly<Record<string, SeatRouter.Phase>> = {
  "coding/implement": "implement",
  "coding/plan": "plan",
  "coding/poc": "implement",
  [reviewRole]: "review",
  "wiki/reviewer": "review",
  "repository/research": "other",
  "repository/evaluator": "review",
  "repository/author": "implement",
  "flow/author": "implement"
}

type RoleModels = Pick<Options, "planningModel" | "pocModel" | "wikiModel" | "reviewModel"> & {
  readonly seats?: Readonly<Record<string, string>> | undefined
}

/** Harness prefixes that run another vendor's models. */
const harnessVendors: Readonly<Record<string, string>> = { codex: "openai" }

/**
 * Routers: one key serves every vendor's model by its `vendor/model` id
 * (`vercel:` is the AI Gateway).
 */
const routers: ReadonlyArray<string> = ["vercel", "openrouter"]

/** The model a router reviews on, by `vendor/model`: the first whose vendor is not the implementer's. */
const routedReviewModels: ReadonlyArray<string> = ["anthropic/claude-sonnet-4.5", "openai/gpt-5.1"]

/**
 * The vendor whose model a seat alias or `provider:model` runs: the prefix,
 * a harness's vendor (`codex:` is OpenAI), or a router's model owner
 * (`openrouter:openai/...` and `vercel:openai/...` are OpenAI). A bare model
 * id has none.
 */
export const seatProvider = (seat: string): string => {
  const expanded = expandSeat(seat)
  const separator = expanded.indexOf(":")
  if (separator < 0) return ""
  const prefix = expanded.slice(0, separator).toLowerCase()
  const model = expanded.slice(separator + 1)
  if (routers.includes(prefix) && model.includes("/")) return model.slice(0, model.indexOf("/")).toLowerCase()
  return harnessVendors[prefix] ?? prefix
}

/**
 * The seats `coding/review` tries, in order, when nothing names one, so a
 * change is reviewed by a vendor other than the one whose model wrote it:
 *
 * 1. the implementer's router on a second vendor, so the key that pays for
 *    the code pays for its review (an install with only the AI Gateway key
 *    codes on `vercel:openai/...` and reviews on `vercel:anthropic/...`);
 * 2. each alias on another vendor, as its direct key allows;
 * 3. another router on a second vendor;
 * 4. the implementer's own seat, so a host with one vendor's key reviews
 *    rather than refusing every review.
 *
 * The first that resolves on the host's credentials wins (roleResolver). The
 * implementer is the effective one, after the repository's and the operator's
 * `seats`. An implementer the graph routes (`auto`) leaves the review to the
 * graph too.
 */
export const reviewSeats = (implementationSeat: string): ReadonlyArray<string> => {
  if (implementationSeat === Seat.auto) return [Seat.auto]
  const vendor = seatProvider(implementationSeat)
  const expanded = expandSeat(implementationSeat)
  const route = expanded.slice(0, Math.max(0, expanded.indexOf(":"))).toLowerCase()
  const secondVendor = routedReviewModels.find((model) => model.slice(0, model.indexOf("/")) !== vendor)!
  return [
    ...new Set([
      ...(routers.includes(route) ? [`${route}:${secondVendor}`] : []),
      ...Object.entries(seatAliases).filter(([, seat]) => seatProvider(seat) !== vendor).map(([alias]) => alias),
      ...routers.filter((router) => router !== route).map((router) => `${router}:${secondVendor}`),
      implementationSeat
    ])
  ]
}

/** Every role this host resolves: its defaults with the repository's and the operator's seats over them. */
const effectiveRoles = (implementationModel: string, models: RoleModels): Readonly<Record<string, string>> => ({
  ...defaultRoles(implementationModel, models),
  ...models.seats
})

/**
 * The native host's seats: the role resolver over the credential route, and
 * the host's seat catalog beside it, so an undeclared or `model: auto` flow
 * routes by the routing graph over the seats this host's credentials run.
 */
export const roleSeats = (options: Options, suppliedSeats?: SeatResolver.Service) => {
  const models = { ...options, seats: effectiveSeats(options) }
  return (environment: Readonly<Record<string, string | undefined>>) =>
    Layer.merge(
      Layer.effect(SeatResolver.SeatResolver)(
        Effect.map(SeatResolver.SeatResolver, (base) => roleResolver(base, options.implementationModel, models))
      ).pipe(
        Layer.provide(
          suppliedSeats === undefined
            ? NativeEquipment.layerSeatResolver(environment)
            : SeatResolver.layer(suppliedSeats)
        )
      ),
      NativeEquipment.layerSeatCatalog(environment)
    )
}

const defaultRoles = (implementationModel: string, models: RoleModels): Readonly<Record<string, string>> => ({
  "coding/implement": implementationModel,
  // A dispatched turn that names no model runs on the implementation seat,
  // because that is the seat this host was configured to write code with.
  "coding/dispatch": implementationModel,
  "coding/plan": models.planningModel ?? implementationModel,
  "coding/poc": models.pocModel ?? implementationModel,
  "wiki/reviewer": models.wikiModel ?? implementationModel,
  // The review check's lenses: a second vendor unless the operator pins one.
  // roleResolver tries every reviewSeats entry; this first one names the
  // role's seat for routing (`auto`).
  [reviewRole]: models.reviewModel ?? reviewSeats(models.seats?.["coding/implement"] ?? implementationModel)[0]!,
  "repository/research": models.planningModel ?? implementationModel,
  // The seat the built-in authoring bodies declare. They write a flow and
  // run its checks, so they run on the seat this host writes code with; the
  // alternative is a `provider:model` literal baked into a prompt file,
  // which would outlive whatever this deployment was configured with.
  "flow/author": implementationModel,
  "repository/evaluator": models.planningModel ?? implementationModel,
  "repository/author": implementationModel
})

/** The repository's role→seat declaration with the operator's pins over it. */
const effectiveSeats = (options: Pick<Options, "planning" | "seats">): Readonly<Record<string, string>> => ({
  ...options.planning?.seats,
  ...options.seats
})

/** Both platform entries call this one recipe; no second executor or store. */
export const layer = (platform: NativeControl.Platform, options: Options, suppliedSeats?: SeatResolver.Service) => {
  configured(options)
  // Refuse before provisioning builtins, starting native processes or opening stores.
  const evaluator = platform.evaluator ?? evaluatorLayer(process.env)
  // Resolved before any layer is built, so an in-root state directory is a
  // named startup refusal rather than a stale_revision three seconds into the
  // first plan. The engine writes to this tree on every step.
  const stateRoot = CodingState.resolveStateRoot({
    root: options.repositoryPath,
    explicit: options.stateRoot,
    environment: process.env
  })
  const native = NativeControl.make(
    {
      ...platform,
      agentLimits: options.planning?.limits,
      evaluator,
      jj: (root) => Snapshots.layerAt({ ...options, repositoryPath: root }),
      filesystem: (root, fs, spawner) =>
        fs.realPath(root).pipe(
          Effect.map((canonicalRoot) =>
            CodingFileSystem.make({ ...options, repositoryPath: root }, fs, spawner, canonicalRoot)
          ),
          Effect.orDie
        )
    },
    roleSeats(options, suppliedSeats),
    options.planning === undefined ? undefined : routeMessages
  )
  return Layer.suspend(() =>
    Layer.unwrap(
      Effect.gen(function*() {
        // Host-owned immutable wiki publication and scratch cleanup use the trusted
        // FS. Model actions and check processes retain the native host's guards.
        const fs = yield* FileSystem.FileSystem
        const wikiEnabled = options.planning?.wiki === true
        const reviewerPolicy = !wikiEnabled ? undefined : yield* runningWikiPolicy
        const wikiOutput = !wikiEnabled
          ? undefined
          : yield* separateWikiOutput(options.repositoryPath, options.planning.wikiOutput!)
        // No per-workspace identity (the gateway is the binding): the stack carries
        // reviews from one refresh workspace to the next.
        const wikiReviewer = !wikiEnabled ?
          undefined :
          Digest.canonical({
            policy: options.planning.reviewer,
            model: effectiveSeats(options)["wiki/reviewer"] ?? options.wikiModel ?? options.implementationModel,
            hostPolicy: reviewerPolicy
          })
        const wikiOptions = !wikiEnabled ?
          undefined :
          {
            ...options.planning,
            pages: options.planning.pages!,
            wikiOutput: wikiOutput!,
            repositoryPath: options.repositoryPath,
            reviewer: wikiReviewer!,
            hostPolicy: reviewerPolicy!,
            evaluator
          }
        // One Landing per host: the deployment's backend adapter, or the local
        // lander the project declares for a host without a repository binding.
        const landing = options.landing ?? (options.planning?.landing === undefined ? undefined : LocalLanding.layer({
          kind: options.planning.landing,
          repositoryPath: options.repositoryPath,
          fs,
          environment: options.landingEnvironment ?? options.checkEnvironment ?? {}
        }))
        const repositoryBundle = yield* runningRepositoryPolicy
        const repositoryPolicy = Digest.digest(
          Digest.canonical({
            bundle: repositoryBundle,
            implementationModel: options.implementationModel,
            researchModel: options.planningModel ?? options.implementationModel,
            gateway: options.gatewayId,
            seats: effectiveSeats(options)
          })
        )
        const builtins = yield* provisionHostBuiltins(stateRoot, repositoryPolicy, options)
        const registry = Layer.effect(Registry.Registry)(
          Effect.map(Registry.Registry, (base) =>
            bindRepositoryRegistry(
              wikiOptions === undefined ?
                base
                : bindWikiRegistry(base, wikiCheckPolicy(wikiOptions)),
              builtins.registry,
              repositoryPolicy,
              options.systemFlows
            ))
        ).pipe(Layer.provide(native.layerRegistry(options.repositoryPath)))
        const request = options.planning === undefined ? Layer.empty : Layer.mergeAll(
          memoryLayer({
            ...options.planning,
            ...(wikiOutput === undefined ? {} : { wikiOutput }),
            repositoryPath: options.repositoryPath
          }, fs),
          preparationLayers,
          prototypeRegistration,
          ...(wikiOptions === undefined ?
            [] :
            [
              planningWikiLayers(wikiOptions, fs),
              wikiRefreshRegistration(wikiOptions, fs),
              wikiCheckLayers({
                ...wikiOptions,
                fs,
                exporterPath: options.exporterPath,
                environment: options.checkEnvironment
              })
            ]),
          planningPolicy,
          declineLayer,
          preparePlanLayer(options.planning.limits?.toolMs),
          HumanTask.layer,
          correctionLayers,
          sourceAdmission,
          stackBaseLayer,
          dependencyPagesLayer(options.repositoryPath, fs),
          requestRegistration,
          todoLayers(evaluator),
          feedbackLayer,
          verifyRegistration,
          flowLoadRegistration(options.repositoryPath, options.systemFlows),
          pocPolicy,
          pocModels,
          pocSource({ ...options, fs }),
          evidenceOnly(Layer.mergeAll(ReviewRequest.layer, DraftPlan.layer, SelectRepair.layer, ReviewPage.layer)),
          ...(landing === undefined ? [] : [vibeRegistration.pipe(Layer.provide(landing)), cleanupModels])
        )
        // Jev, the decision-only model behind every enumerable answer this host
        // makes: the intake screen over each inbound event, the duplicates step,
        // each AI check's changed hunks, a reproduction review's verdict and an
        // evaluation row's verdict. It is the only model that answers any of them.
        // Selection happened before startup. The same real or scripted evaluator
        // serves the agent completion brake and every repository classifier.
        const repository = Layer.mergeAll(
          evaluator,
          inspectionLayers({
            repositoryPath: options.repositoryPath,
            fs,
            exporterPath: options.exporterPath,
            environment: options.checkEnvironment
          }),
          jobFlows,
          failureLayer,
          executionLayers({
            repositoryPath: options.repositoryPath,
            fs,
            exporterPath: options.exporterPath,
            environment: options.checkEnvironment,
            evaluator
          }),
          evaluationLayers({ evaluator }),
          setupLayers({
            repositoryPath: options.repositoryPath,
            fs,
            exporterPath: options.exporterPath,
            environment: options.checkEnvironment
          }),
          registerRepository({
            repositoryPath: options.repositoryPath,
            fs,
            environment: options.checkEnvironment ?? {},
            evaluator
          }),
          activationLayers,
          triggerLayers,
          replyLayers,
          deliveryLayers,
          repositoryCheckLayers({
            repositoryPath: options.repositoryPath,
            fs,
            exporterPath: options.exporterPath,
            environment: repositoryCheckEnvironment(options),
            evaluator
          }),
          changeLayers({
            repositoryPath: options.repositoryPath,
            fs,
            exporterPath: options.exporterPath,
            environment: options.checkEnvironment
          }),
          evidenceOnly(
            Layer.mergeAll(modelLayers, ScoreCase.layer, SuggestSetup.layer, changeModelLayers),
            new Set([...modelNames, ScoreCase.name, SuggestSetup.name, ...changeModelNames])
          )
        )
        const leaves = Layer.mergeAll(
          atomFlows,
          atomOperations,
          EditAtom.layer,
          nativeActions,
          request,
          repository,
          // A dispatched turn keeps the host's registry and capability envelope:
          // it is expected to edit the workspace, so it is not evidence-only.
          dispatchRegistration(),
          dispatchModels,
          checkLayers({
            repositoryPath: options.repositoryPath,
            fs,
            concurrency: 1,
            exporterPath: options.exporterPath,
            environment: options.checkEnvironment
          }),
          // Lint on Jev: a check body's rules judged over the implementation diff.
          jevCheckLayers(evaluator),
          // Review on a second provider: a check body's lenses read over the
          // same diff. Each lens answers about supplied evidence only.
          reviewCheckLayers,
          evidenceOnly(ReviewLens.layer),
          // The required security review: trusted policy over the change's
          // immutable trees, on the host's subscription seats. Findings stay in
          // a private store beside the host state; receipts carry summaries.
          securityReviewCheckLayers({
            repositoryPath: options.repositoryPath,
            fs,
            exporterPath: options.exporterPath,
            environment: options.checkEnvironment,
            store: join(stateRoot, "security-review")
          })
        )
          .pipe(
            // A local lander reads through the native helper, so it is provided first.
            (layers) => landing === undefined ? layers : layers.pipe(Layer.provideMerge(landing)),
            // The helper operations that read the workspace's protected binding
            // (read, source creation, import, publication) run on the host's raw
            // spawner (NativeTransport).
            Layer.provideMerge(nativeLayer(options).pipe(Layer.provide(NativeTransport.layerFrom(platform.host)))),
            (layers) =>
              options.repositoryRemote === undefined
                ? layers
                : layers.pipe(Layer.provideMerge(options.repositoryRemote))
          )
        // Loading verified declaration bytes reserves a sibling temporary module.
        // This is host startup work. Register the resulting flows only after that
        // read/import effect ends, under the original guarded handler context.
        const executableOptions = {
          delegates: [
            checkDelegate,
            jevCheckDelegate,
            reviewCheckDelegate,
            securityReviewCheckDelegate,
            securityAuditDelegate,
            RunSetup,
            RunJob,
            RunTrigger,
            ...(wikiEnabled ? [wikiCheckDelegate] : [])
          ]
        }
        const catalog = Layer.unwrap(
          repositoryCatalog(executableOptions, builtins.load).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            // The catalog this host serves is rebuildable one entry at a time, which
            // is what lets a run of this host author `flows/<id>/flow.ts` and have
            // the next plan draw it. A reserved job declaration is held fixed: its
            // bytes are the measured bundle this host shipped as, and rebuilding one
            // from the working tree would replace an admitted declaration with
            // whatever is on disk.
            Effect.map((built) => repositoryRegistration(executableOptions, built, leaves))
          )
        ).pipe(Layer.orDie)
        const modules = registration.pipe(
          Layer.provideMerge(catalog),
          Layer.tap((context) =>
            Effect.gen(function*() {
              const built = Context.get(context, Executable.Catalog)
              const [missing] = missingCodingExecutables(built, options)
              if (missing !== undefined) {
                return yield* Effect.die(
                  new Error(`Required coding executable ${missing} is unavailable; inspect the catalog refusal`)
                )
              }
              // Plue's adapter verifies the owning workspace binding. A missing native
              // binary, incorrect repository binding or invalid receipt prevents serve.
              const binding = yield* Context.get(context, NativeCoding).read()
              if (binding.head.kind !== "resolved") {
                return yield* Effect.die(
                  new Error("Resolve native JJ conflicts before starting the configured coding host")
                )
              }
              if (!binding.capabilities?.includes("apply-files/v1")) {
                return yield* Effect.die(
                  new Error(
                    "Update the workspace native adapter before starting repository jobs; apply-files/v1 is required"
                  )
                )
              }
              if (options.sourcePublication !== "local-only" && !binding.capabilities.includes("import-source/v1")) {
                return yield* Effect.die(
                  new Error(
                    "Update the workspace native adapter before starting repository jobs; import-source/v1 is required"
                  )
                )
              }
            })
          ),
          Layer.orDie
        )
        const host = native.layerHost(
          {
            root: options.repositoryPath,
            stateRoot,
            credential: options.credential,
            expectedSourceRevision: options.runtimeSourceRevision,
            approvalChannel: true,
            approvalAuthority: options.approvalAuthority ?? native.gatewayApprovalAuthority
          },
          modules,
          registry
        )
        return Layer.effect(Serve.GatewayHost)(Effect.map(Serve.GatewayHost, (gateway) => ({
          launch: (health, bind, root) =>
            gateway.launch({
              ...health,
              gatewayId: options.gatewayId,
              ...(options.runtimeArtifactDigest === undefined ? {} : {
                runtimeBridge: {
                  protocol: "smithers.flow-runtime/v1" as const,
                  runtimeArtifactDigest: options.runtimeArtifactDigest,
                  sourceRevision: options.runtimeSourceRevision!,
                  ownerGeneration: options.ownerGeneration ?? 1
                }
              }),
              capabilities: [
                ...new Set([
                  ...(health.capabilities ?? []),
                  "coding-plan/v1",
                  "coding-dispatch/v1",
                  "repository-jobs/v1",
                  "repository-source/v1",
                  ...configuredCodingRoutes(options).map((route) => route.capability),
                  ...(options.runtimeArtifactDigest === undefined ? [] : ["flow-runtime-bridge/v1"])
                ])
              ]
            }, {
              ...bind,
              ...(options.runtimeArtifactDigest === undefined ? {} : {
                runtimeBridge: {
                  runtimeArtifactDigest: options.runtimeArtifactDigest,
                  sourceRevision: options.runtimeSourceRevision!,
                  ownerGeneration: options.ownerGeneration ?? 1
                }
              })
            }, root)
        }))).pipe(Layer.provideMerge(host))
      }).pipe(Effect.provide(platform.host))
    )
  )
}
