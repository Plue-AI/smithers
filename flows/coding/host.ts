/** Private deployment recipe. Existing native host, catalog, agents and JJ ports. */
import * as Seat from "@smthrs/agent/Seat"
import * as SeatResolver from "@smthrs/agent/SeatResolver"
import * as SeatRouter from "@smthrs/agent/SeatRouter"
import * as Digest from "@smthrs/core/Digest"
import { HumanTask, Interpreter } from "@smthrs/flow"
import * as Executable from "@smthrs/registry/Executable"
import * as Registry from "@smthrs/registry/Registry"
import { Context, Effect, FileSystem, Layer } from "effect"
import type * as Application from "../../packages/smithers/src/Application.ts"
import * as NativeControl from "../../packages/smithers/src/internal/NativeControl.ts"
import * as NativeEquipment from "../../packages/smithers/src/internal/NativeEquipment.ts"
import {
  expandSeat,
  isDecisionSeat,
  seatAliases,
  seatDescriptions,
  seatRefusal
} from "../../packages/smithers/src/Providers.ts"
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
import { checkDelegate, checkLayers } from "./checks.ts"
import { correctionLayers, SelectRepair } from "./correction.ts"
import { dispatchModels } from "./dispatch.ts"
import { dispatchRegistration } from "./dispatch/flow.ts"
import * as CodingFileSystem from "./filesystem.ts"
import { atomFlows } from "./implementation/flow.ts"
import { jevCheckDelegate, jevCheckLayers } from "./jev-check.ts"
import type { Landing } from "./landing.ts"
import { nativeActions, NativeCoding, nativeLayer, type NativeOptions } from "./native.ts"
import { evidenceOnly } from "./planning-authority.ts"
import { memoryLayer, type MemoryOptions } from "./planning-memory.ts"
import { planningWikiLayers } from "./planning-wiki.ts"
import { declineLayer, DraftPlan, planningPolicy, PreparePlan, ReviewRequest } from "./planning.ts"
import { pocSource } from "./poc-source.ts"
import { pocModels, pocPolicy } from "./poc.ts"
import { preparationLayers } from "./preparation.ts"
import type { ProjectConfig } from "./project-config.ts"
import { prototypeRegistration } from "./prototype.ts"
import { registration } from "./registration.ts"
import { requestRegistration } from "./request.ts"
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
import { wikiRefreshRegistration } from "./wiki-route.ts"

/** Operator configuration, never accepted from a workflow or gateway request. */
export interface Options extends NativeOptions {
  /** Same operator credential used by Serve; enables the existing native gateway delegation. */
  readonly credential?: string | undefined
  /** Existing authority override, including a narrower operator policy. */
  readonly approvalAuthority?: Application.Config["approvalAuthority"]
  readonly gatewayId: string
  readonly implementationModel: string
  readonly exporterPath?: string | undefined
  readonly checkEnvironment?: Readonly<Record<string, string>> | undefined
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
    })
    | undefined
  readonly planningModel?: string | undefined
  readonly pocModel?: string | undefined
  readonly wikiModel?: string | undefined
  /** Operator role→seat pins (`SMITHERS_CODING_SEATS`); they win over the repository's `seats`. */
  readonly seats?: Readonly<Record<string, string>> | undefined
  /**
   * Deployment-owned landing adapter over the reserved repository credential.
   * Repository automation uses it on its own; `coding/vibe` is registered only
   * when `planning` configures the prompt route as well.
   */
  readonly landing?: Layer.Layer<Landing> | undefined
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
  ...(options.planning === undefined || options.landing === undefined
    ? []
    : [{ name: "coding/vibe" as const, capability: "coding-vibe/v1" }]),
  // The mythical stack verifies rebased candidates with the same checks.
  ...(options.planning === undefined ? [] : [{ name: "coding/verify" as const, capability: "coding-verify/v1" }]),
  // The stack service refreshes the repository wiki the project declares.
  ...(options.planning?.wiki === true ? [{ name: "coding/wiki" as const, capability: "coding-wiki/v1" }] : [])
]

/** The built-ins this configured host writes: the defaults plus its configured coding routes. */
export const provisionHostBuiltins = (
  stateRoot: string,
  policy: string,
  options: Pick<Options, "planning" | "landing">
) => provisionBuiltins(stateRoot, policy, configuredCodingRoutes(options).map((route) => route.name))

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
    ["coding", undefined],
    ["coding/dispatch", undefined],
    ["coding/implementation", undefined],
    ...configuredCodingRoutes(options).map((route) => [route.name, undefined] as const),
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

const configured = (options: Options) => {
  if (seatRefusal(options.implementationModel) !== undefined) {
    throw new Error(
      "Set SMITHERS_CODING_IMPLEMENT_MODEL to a seat alias or an explicit provider:model for coding/implement"
    )
  }
  for (const model of [options.planningModel, options.pocModel, options.wikiModel]) {
    if (model !== undefined && seatRefusal(model) !== undefined) {
      throw new Error("Coding role models must be seat aliases or explicit provider:model values")
    }
  }
  for (const [role, seat] of Object.entries(options.seats ?? {})) {
    const refusal = seatRefusal(seat)
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
 * names, and may name roles only its flows declare (`model: triage`).
 */
export const roleResolver = (
  base: SeatResolver.Service,
  implementationModel: string,
  models: RoleModels = {}
): SeatResolver.Service => {
  const roles = effectiveRoles(implementationModel, models)
  return SeatResolver.make({
    resolve: (id) =>
      base.resolve(Object.hasOwn(roles, id) ? roles[id]! : id).pipe(
        Effect.map((seat) => Object.hasOwn(roles, id) ? Seat.make({ ...seat, id }) : seat)
      )
  })
}

/**
 * The seats Jev may route an undeclared or `model: auto` flow to: one role per
 * configured model, keeping the first role that names it, so Jev picks only
 * among the models the operator configured.
 */
export const roleCatalog = (implementationModel: string, models: RoleModels = {}): SeatRouter.Service => {
  const roles = Object.entries(effectiveRoles(implementationModel, models)).map(([role, seat]) =>
    [role, seat, expandSeat(seat)] as const
  )
  const described = new Map(Object.entries(seatAliases).map(([alias, seat]) => [seat, seatDescriptions[alias]]))
  return {
    variants: SeatRouter.defaultVariants,
    candidates: Effect.succeed(
      roles
        .filter(([, , seat], index) =>
          roles.findIndex(([, , other]) => other === seat) === index && !isDecisionSeat(seat)
        )
        .map(([role, declared, seat]) => ({ id: role, description: `${role}: ${described.get(seat) ?? declared}` }))
    )
  }
}

type RoleModels = Pick<Options, "planningModel" | "pocModel" | "wikiModel"> & {
  readonly seats?: Readonly<Record<string, string>> | undefined
}

/** Every role this host resolves: its defaults with the repository's and the operator's seats over them. */
const effectiveRoles = (implementationModel: string, models: RoleModels): Readonly<Record<string, string>> => ({
  ...defaultRoles(implementationModel, models),
  ...models.seats
})

/** The native host's seats: the role resolver over the credential route, and the role catalog beside it. */
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
      SeatRouter.layer(roleCatalog(options.implementationModel, models))
    )
}

const defaultRoles = (
  implementationModel: string,
  models: Pick<Options, "planningModel" | "pocModel" | "wikiModel">
): Readonly<Record<string, string>> => ({
  "coding/implement": implementationModel,
  // A dispatched turn that names no model runs on the implementation seat,
  // because that is the seat this host was configured to write code with.
  "coding/dispatch": implementationModel,
  "coding/plan": models.planningModel ?? implementationModel,
  "coding/poc": models.pocModel ?? implementationModel,
  "wiki/reviewer": models.wikiModel ?? implementationModel,
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
              repositoryPolicy
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
          Interpreter.layer(PreparePlan),
          HumanTask.layer,
          correctionLayers,
          sourceAdmission,
          stackBaseLayer,
          requestRegistration,
          todoLayers(evaluator),
          feedbackLayer,
          verifyRegistration,
          pocPolicy,
          pocModels,
          pocSource({ ...options, fs }),
          evidenceOnly(Layer.mergeAll(ReviewRequest.layer, DraftPlan.layer, SelectRepair.layer, ReviewPage.layer)),
          ...(options.landing === undefined
            ? []
            : [vibeRegistration.pipe(Layer.provide(options.landing)), cleanupModels])
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
            environment: options.checkEnvironment,
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
          jevCheckLayers(evaluator)
        )
          .pipe(
            Layer.provideMerge(nativeLayer(options)),
            (layers) =>
              options.repositoryRemote === undefined
                ? layers
                : layers.pipe(Layer.provideMerge(options.repositoryRemote)),
            (layers) => options.landing === undefined ? layers : layers.pipe(Layer.provideMerge(options.landing))
          )
        // Loading verified declaration bytes reserves a sibling temporary module.
        // This is host startup work. Register the resulting flows only after that
        // read/import effect ends, under the original guarded handler context.
        const executableOptions = {
          delegates: [
            checkDelegate,
            jevCheckDelegate,
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
