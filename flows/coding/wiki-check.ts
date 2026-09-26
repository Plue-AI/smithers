/** Slow semantic backpressure over one exact native source export. No publication. */
import * as AgentAction from "@smthrs/agent/AgentAction"
import * as Digest from "@smthrs/core/Digest"
import * as RunCatalogRead from "@smthrs/engine-store/RunCatalogRead"
import { RunState } from "@smthrs/engine-store/RunState"
import { Action, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import * as Descriptor from "@smthrs/registry/Descriptor"
import * as Executable from "@smthrs/registry/Executable"
import * as RunStore from "@smthrs/run-store/RunStore"
import { Effect, Exit, Layer, Option, Schema } from "effect"
import { operations } from "../wiki/operations.ts"
import { Bind, Pool, reuseOperations, Select } from "../wiki/reuse.ts"
import { Evidence, ReviewedPage, WikiError } from "../wiki/schema.ts"
import { ReviewPage, validateOrRepairReview } from "../wiki/workflow.ts"
import { withImmutableSource, type ImmutableSourceOptions } from "./immutable-source.ts"
import { findPlanningWikiReview, planningWikiConfiguration, type PlanningWikiOptions } from "./planning-wiki.ts"
import { Check, CodingError, Implementation, Receipt, checkInputDigest } from "./schema.ts"

export interface WikiCheckOptions extends ImmutableSourceOptions, PlanningWikiOptions {}
export const wikiCheckPolicy = (options: Pick<PlanningWikiOptions, "pages" | "reviewer" | "hostPolicy">) =>
  Digest.digest(Digest.canonical({ version: 1, pages: options.pages, reviewer: options.reviewer, hostPolicy: options.hostPolicy ?? null }))

const Input = Schema.Struct({ implementation: Implementation, check: Check })
const Captured = Schema.Struct({ ...Input.fields, reviewer: Schema.String, policy: Schema.String,
  pages: Schema.Array(Evidence), pool: Pool })
const CheckEvidence = Schema.Struct({ kind: Schema.Literal("coding/wiki-check/v1"), policy: Schema.String,
  reviewRunId: Schema.String, pages: Schema.Array(Schema.Struct({ id: Schema.String, inputDigest: Schema.String,
    status: Schema.Literals(["verified", "needs-changes"]) })) })
const Capture = Action.make("coding/capture-wiki-check", {
  payload: Executable.Invocation, success: Captured, error: Schema.Union([CodingError, WikiError]), nondeterministic: true
})
const Finish = Action.make("coding/finish-wiki-check", {
  payload: { captured: Captured, pages: Schema.Record(Schema.String, ReviewedPage) }, success: Receipt, error: CodingError
})
const Error = Schema.Union([CodingError, WikiError, AgentAction.AgentFailure])

const reviewOne = (evidence: Evidence, captured: typeof Captured.Type) => Node.bindPlanned(
  Select.call({ evidence, pool: captured.pool, reviewer: captured.reviewer }), selection => Node.bindPlanned(
    Node.branch(Node.succeed(selection), {
      if: value => value.review !== null,
      then: value => Node.succeed(value.review),
      else: () => ReviewPage.call({ evidence })
    }), review => validateOrRepairReview(evidence, review).pipe(Node.bindPlanned(review =>
      Bind.call({ evidence, review, reviewer: captured.reviewer, provenance: selection.provenance })))
  )
)
const ReviewCaptured = Flow.make("coding/ReviewCapturedWiki", {
  payload: Captured, success: Receipt, error: Error,
  body: captured => Node.all(Object.fromEntries(captured.pages.map((evidence, index) =>
    [`page-${index}`, reviewOne(evidence, captured)]
  ))).pipe(Node.bindPlanned(pages => Finish.call({ captured, pages })))
})

/** Ordinary registered check delegate, using the existing model action and receipts. */
export const wikiCheckDelegate = Flow.make("coding/WikiCheck", {
  payload: Executable.Invocation, success: Receipt, error: Error,
  // The child materializes the captured page array before expanding its graph.
  body: invocation => Capture.call(invocation).pipe(Node.bindPlanned(captured => ReviewCaptured.child(captured)))
})

const invalid = (message: string) => new CodingError({ code: "invalid_receipt", message })
const guarded = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.mapError(error =>
  error instanceof CodingError || error instanceof WikiError ? error : new CodingError({ code: "execution", message: String(error).slice(0, 8192) })))

/** Same indexed recent window as planning. A bounded miss safely reviews again. */
const previousCheck = (flow: string, policy: string) => Effect.gen(function*() {
  const catalog = yield* RunCatalogRead.RunCatalogRead, store = yield* RunStore.RunStore
  let bytes = 0
  for (const id of (yield* catalog.listRunIds({ limit: 256 })).toReversed()) {
    const row = yield* store.get(id).pipe(Effect.catch(error => error.code === "not_found_row" ? Effect.succeed(null) : Effect.fail(error)))
    if (row === null) continue
    const size = new TextEncoder().encode(row.stateJson).length
    bytes += size
    if (bytes > 1024 * 1024) break
    if (size > 256 * 1024 || row.status !== "completed") continue
    const state = Schema.decodeUnknownOption(Schema.fromJsonString(RunState))(row.stateJson)
    if (Option.isNone(state) || state.value.flowName !== flow) continue
    const result = Schema.decodeUnknownOption(Schema.toCodecJson(Flow.Result({ success: Receipt, error: Schema.Unknown })))(state.value.result)
    if (Option.isNone(result) || result.value._tag !== "Complete" || Exit.isFailure(result.value.exit)) continue
    const evidence = Schema.decodeUnknownOption(Schema.fromJsonString(CheckEvidence))(result.value.exit.value.evidence)
    if (Option.isSome(evidence) && evidence.value.policy === policy) {
      const child = yield* store.get(evidence.value.reviewRunId).pipe(Effect.catch(error => error.code === "not_found_row" ? Effect.succeed(null) : Effect.fail(error)))
      if (child?.status === "completed") return evidence.value.reviewRunId
    }
  }
  return null
})

/** The caller supplies its existing reviewer with evidence-only authority and
 * the shared Select/Bind handlers from planningWikiLayers (reuseLayers). */
export const wikiCheckLayers = (options: WikiCheckOptions) => {
  return Layer.mergeAll(Interpreter.layer(wikiCheckDelegate), Interpreter.layer(ReviewCaptured),
    Capture.toLayer(invocation => guarded(Effect.gen(function*() {
      const input = yield* Schema.decodeUnknownEffect(Input)(invocation.input)
      const catalog = yield* Executable.Catalog
      const entry = catalog.executables.find(value => value.descriptor.name === invocation.flow)
      if (invocation.flow !== input.check.flow || input.check.tier !== "slow" || entry?.delegate !== wikiCheckDelegate._tag ||
          Descriptor.executionDigest(entry.descriptor) !== input.check.flowDigest) return yield* invalid("Wiki check requires the current registered slow-check identity")
      const policy = wikiCheckPolicy(options)
      if (entry.descriptor.frontmatter["smithersCodingWikiPolicy"] !== policy) return yield* invalid("Wiki check descriptor is not bound to the host's actual catalog and reviewer policy")
      const prior = yield* previousCheck(invocation.flow, policy).pipe(Effect.flatMap(id => id === null
        ? planningWikiConfiguration(options, options.fs).pipe(Effect.flatMap(findPlanningWikiReview)) : Effect.succeed(id)))
      return yield* withImmutableSource(options, input.implementation.head, (_tree, root) => Effect.gen(function*() {
        const immutable = operations({ root, output: options.wikiOutput, fs: options.fs })
        const reused = reuseOperations({ root, output: options.wikiOutput, fs: options.fs, hostPolicy: options.hostPolicy })
        const pages = yield* Effect.forEach(options.pages, immutable.collect)
        const pool = prior === null ? { ...yield* reused.policy(options.reviewer), candidates: {} }
          : yield* reused.load({ priorRunId: prior, reviewer: options.reviewer })
        return { ...input, reviewer: options.reviewer, policy, pages, pool }
      }))
    }))),
    Finish.toLayer(({ captured, pages }) => Effect.gen(function*() {
      const instance = yield* FlowRuntime.FlowInstance
      const reviewed = Object.keys(pages).sort((a, b) => Number(a.slice(5)) - Number(b.slice(5))).map(key => pages[key]!)
      if (reviewed.length !== captured.pages.length || reviewed.some((page, index) =>
          page.evidence.inputDigest !== captured.pages[index]!.inputDigest || page.reviewer !== captured.reviewer || page.review === null)) {
        return yield* invalid("Wiki check must retain one assessed review for each captured page")
      }
      const findings = reviewed.flatMap(page => page.review!.sections.filter(section => section.verdict !== "supported").map(section => ({
        owner: captured.implementation.change, sourceCommitId: captured.implementation.head.commitId,
        message: `Wiki ${page.evidence.spec.id}/${section.id} (${page.evidence.spec.document}): ${section.explanation}`
      })))
      const evidence: typeof CheckEvidence.Type = { kind: "coding/wiki-check/v1", policy: captured.policy, reviewRunId: instance.executionId,
        pages: reviewed.map(page => ({ id: page.evidence.spec.id, inputDigest: page.evidence.inputDigest,
          status: page.review!.sections.every(section => section.verdict === "supported") ? "verified" : "needs-changes" })) }
      return { change: captured.implementation.change, checkId: captured.check.id, target: captured.check.target, tier: captured.check.tier,
        commitId: captured.implementation.head.commitId, treeId: captured.implementation.head.treeId,
        inputDigest: checkInputDigest(captured.implementation, captured.check), status: findings.length ? "failed" : "passed",
        findings, evidence: JSON.stringify(evidence) } satisfies Receipt
    }))
  ).pipe(Layer.provideMerge(RunCatalogRead.layer))
}
