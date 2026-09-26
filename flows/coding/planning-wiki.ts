/** The verified repository wiki refresh the host runs for `coding/wiki` and the wiki check. */
import * as Digest from "@smthrs/core/Digest"
import * as RunCatalogRead from "@smthrs/engine-store/RunCatalogRead"
import { RunState } from "@smthrs/engine-store/RunState"
import { Action, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import type * as Evaluator from "@smthrs/model/Evaluator"
import { Node } from "@smthrs/plan"
import * as RunStore from "@smthrs/run-store/RunStore"
import { Effect, Exit, FileSystem, Layer, Option, Schema } from "effect"
import Wiki from "../wiki/flow.ts"
import { IncrementalWiki, policySources, Pool, reuseLayers } from "../wiki/reuse.ts"
import { actionLayers } from "../wiki/runtime.ts"
import { Input as WikiInput, type PageSpec, Receipt, WikiError } from "../wiki/schema.ts"
import { separateWikiOutput } from "./wiki-output.ts"

/** Operator configuration, never model-supplied paths, catalog or reviewer. */
export interface PlanningWikiOptions {
  readonly repositoryPath: string
  readonly wikiOutput: string
  readonly pages: ReadonlyArray<PageSpec>
  readonly reviewer: string
  /** Trusted running-host fingerprint; never a model or target-repo assertion. */
  readonly hostPolicy?: string | undefined
  /** The evaluator the citation check asks, defaulting to the host's own gateway
   * transport. An offline test names a scripted one the way it scripts the
   * reviewer; nothing here weakens the check, which still refuses a page whose
   * citations nobody could judge. */
  readonly evaluator?: Layer.Layer<Evaluator.Evaluator> | undefined
}
const Config = Schema.Struct({
  ...WikiInput.fields,
  mode: Schema.Literal("verified"),
  scopeDigest: Schema.String,
  output: Schema.String
})
export const Refreshed = Schema.Struct({ scopeDigest: Schema.String, wikiRunId: Schema.String, receipt: Receipt })
const Configure = Action.make("coding/configure-planning-wiki", {
  payload: {},
  success: Config,
  error: WikiError,
  nondeterministic: true
})
const Prior = Action.make("coding/find-planning-wiki-review", {
  payload: { config: Config },
  success: Schema.NullOr(Schema.String),
  error: WikiError,
  nondeterministic: true
})
const Generate = Action.make("coding/refresh-planning-wiki", {
  payload: { config: Config, priorRunId: Schema.NullOr(Schema.String), pool: Schema.optionalKey(Schema.NullOr(Pool)) },
  success: Refreshed,
  error: WikiError,
  nondeterministic: true
})
/**
 * The verified wiki for this host's catalog. It reuses the last compatible
 * review run in this engine, else the review pool the caller carried from an
 * earlier run elsewhere (the stack service keeps it between wiki workspaces).
 */
export const RefreshWiki = Flow.make("coding/RefreshWiki", {
  payload: { pool: Schema.optionalKey(Schema.NullOr(Pool)) },
  success: Refreshed,
  error: WikiError,
  body: (input) =>
    Configure.call({}).pipe(
      Node.bindPlanned((config) =>
        Prior.call({ config }).pipe(
          Node.bindPlanned((priorRunId) => Generate.call({ config, priorRunId, pool: input.pool ?? null }))
        )
      )
    )
})

const maximumCatalogBytes = 128 * 1024
const maximumSources = 256
const maximumCandidates = 20
const maximumLookupRuns = 256
const maximumCandidateBytes = 256 * 1024
const maximumLookupBytes = 1024 * 1024
const bytes = (value: string) => new TextEncoder().encode(value).length
const fail = (message: string, code: WikiError["code"] = "invalid-input") => new WikiError({ code, message })
const guarded = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.mapError((error) => error instanceof WikiError ? error : fail(String(error).slice(0, 8192), "review-failed"))
  )

/** Private recipe lookup over the existing latest insertion window. A large
 * intervening workload can exhaust the bound; that is a normal cold-review miss. */
export const findPlanningWikiReview = (config: typeof Config.Type) =>
  guarded(Effect.gen(function*() {
    const catalog = yield* RunCatalogRead.RunCatalogRead, store = yield* RunStore.RunStore
    // listRuns is ascending by creation time. listRunIds already supplies an
    // indexed latest window, returned oldest first. Reverse that bounded window.
    const ids = yield* catalog.listRunIds({ limit: maximumLookupRuns })
    let inspectedBytes = 0, candidates = 0
    for (const id of ids.toReversed()) {
      const row = yield* store.get(id).pipe(
        Effect.catch((error) => error.code === "not_found_row" ? Effect.succeed(null) : Effect.fail(error))
      )
      if (row === null) continue
      inspectedBytes += bytes(row.stateJson)
      if (inspectedBytes > maximumLookupBytes) break
      if (bytes(row.stateJson) > maximumCandidateBytes || row.status !== "completed") continue
      const state = Schema.decodeUnknownOption(Schema.fromJsonString(RunState))(row.stateJson)
      if (Option.isNone(state) || state.value.flowName !== RefreshWiki._tag) continue
      if (++candidates > maximumCandidates) break
      const result = Schema.decodeUnknownOption(
        Schema.toCodecJson(Flow.Result({ success: Refreshed, error: WikiError }))
      )(state.value.result)
      if (Option.isNone(result) || result.value._tag !== "Complete" || Exit.isFailure(result.value.exit)) continue
      const previous = result.value.exit.value
      if (
        previous.scopeDigest !== config.scopeDigest || previous.receipt.verification !== "verified" ||
        previous.receipt.pages !== config.pages.length
      ) continue
      const child = yield* store.get(previous.wikiRunId).pipe(
        Effect.catch((error) => error.code === "not_found_row" ? Effect.succeed(null) : Effect.fail(error))
      )
      // A retained parent does not prove its child survived retention. Continue
      // looking; it must not hide another compatible complete child in the window.
      if (child?.status === "completed") return previous.wikiRunId
    }
    return null
  }))

/** The same private configuration identity is used by planning and slow wiki checks. */
export const planningWikiConfiguration = (options: PlanningWikiOptions, hostFilesystem?: FileSystem.FileSystem) =>
  guarded(Effect.gen(function*() {
    const fs = hostFilesystem ?? (yield* FileSystem.FileSystem)
    const input = yield* Schema.decodeUnknownEffect(WikiInput)({
      pages: options.pages,
      mode: "verified",
      reviewer: options.reviewer
    })
    if (!input.reviewer.trim() || bytes(JSON.stringify(input)) > maximumCatalogBytes) {
      return yield* fail("Wiki reviewer and catalog must fit 128 KiB")
    }
    const sources = new Set(input.pages.flatMap((page) => [page.document, ...page.inputs]))
    if (sources.size > maximumSources) return yield* fail("The planning wiki catalog exceeds 256 distinct source files")
    if (options.hostPolicy === undefined && policySources.some((source) => !sources.has(source))) {
      return yield* fail("The planning wiki catalog must capture its existing reviewer policy sources")
    }
    const root = yield* fs.realPath(options.repositoryPath)
    const output = yield* separateWikiOutput(options.repositoryPath, options.wikiOutput).pipe(
      Effect.provideService(FileSystem.FileSystem, fs)
    )
    // Configuration identity excludes changing source bytes: existing Collect
    // and Load/Select independently measure those and invalidate affected pages.
    const scopeDigest = Digest.digest(
      Digest.canonical({
        policy: "coding/wiki-refresh/v1",
        root,
        output,
        input,
        policySources: options.hostPolicy === undefined ? policySources : [],
        hostPolicy: options.hostPolicy ?? null,
        maximumCatalogBytes,
        maximumSources,
        maximumCandidates,
        maximumLookupRuns,
        maximumCandidateBytes,
        maximumLookupBytes
      })
    )
    return { ...input, mode: "verified" as const, scopeDigest, output }
  }))

/** Reuse existing actions, journal, catalog and platform; the caller supplies the
 * authority-narrowed ReviewPage layer and existing planning/agent services. */
export const planningWikiLayers = (options: PlanningWikiOptions, hostFilesystem?: FileSystem.FileSystem) => {
  const publicationRoot = separateWikiOutput(options.repositoryPath, options.wikiOutput).pipe(
    (effect) =>
      hostFilesystem === undefined ? effect : Effect.provideService(effect, FileSystem.FileSystem, hostFilesystem)
  )
  return Layer.mergeAll(
    Interpreter.layer(RefreshWiki),
    Interpreter.layer(Wiki),
    actionLayers({
      root: options.repositoryPath,
      output: options.wikiOutput,
      fs: hostFilesystem,
      publicationRoot,
      evaluator: options.evaluator
    }),
    reuseLayers({
      root: options.repositoryPath,
      output: options.wikiOutput,
      fs: hostFilesystem,
      publicationRoot,
      hostPolicy: options.hostPolicy
    }),
    Configure.toLayer(() => planningWikiConfiguration(options, hostFilesystem)),
    Prior.toLayer(({ config }) => findPlanningWikiReview(config)),
    Generate.toLayer(({ config, priorRunId, pool }) =>
      guarded(Effect.gen(function*() {
        const currentOutput = yield* publicationRoot
        if (currentOutput !== config.output) {
          return yield* fail("Wiki output boundary changed after configuration", "output-conflict")
        }
        const instance = yield* FlowRuntime.FlowInstance, runtime = yield* FlowRuntime.FlowRuntime
        const wikiRunId = Digest.digest(
          Digest.canonical(["coding/wiki-child/v1", instance.executionId, config, priorRunId, pool ?? null])
        )
        const input = { pages: config.pages, mode: "verified" as const, reviewer: config.reviewer }
        const carried = priorRunId === null && pool != null && Object.keys(pool.candidates).length > 0
          ? pool
          : undefined
        const receipt = yield* (priorRunId !== null
          ? runtime.execute(IncrementalWiki, { executionId: wikiRunId, payload: { ...input, priorRunId } })
          : carried !== undefined
          ? runtime.execute(IncrementalWiki, { executionId: wikiRunId, payload: { ...input, pool: carried } })
          : runtime.execute(Wiki, { executionId: wikiRunId, payload: input }))
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Receipt)))
        const fs = hostFilesystem ?? (yield* FileSystem.FileSystem)
        const output = yield* fs.realPath(config.output)
        if (receipt.verification !== "verified" || receipt.output !== output || receipt.pages !== config.pages.length) {
          return yield* fail("Wiki generation did not return the configured verified publication", "review-failed")
        }
        return { scopeDigest: config.scopeDigest, wikiRunId, receipt }
      }))
    )
  ).pipe(Layer.provideMerge(RunCatalogRead.layer))
}
