/** Incremental review over the existing journal and attempt store; no cache database. */
import * as AgentAction from "@smthrs/agent/AgentAction"
import { canonical } from "@smthrs/core/Digest"
import { Action, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import { Journal as JournalModules } from "@smthrs/flows"
import { Node } from "@smthrs/plan"
import * as AttemptStore from "@smthrs/run-store/AttemptStore"
import * as RunStore from "@smthrs/run-store/RunStore"
import { Effect, FileSystem, Layer, Option, Path, Schema } from "effect"
import { digest, operations } from "./operations.ts"
import { Evidence, Input, Receipt, Review, ReviewedPage, WikiError } from "./schema.ts"
import { Collect, ReviewPage, validateOrRepairReview } from "./workflow.ts"
const { EngineEvent, Journal, JournalEvent } = JournalModules

// These exact captured files define the model's task, output, evidence view and
// host envelope. Orchestration/receipt validation can change without changing
// that task; every reused receipt still passes today's deterministic assessment.
export const policySources = [
  "flows/wiki/flow.ts",
  "flows/wiki/workflow.ts",
  "flows/wiki/schema.ts",
  "flows/wiki/evidence.ts",
  "flows/wiki/runtime.ts",
  "flows/wiki/jev-citations.ts"
] as const
const PolicySource = Schema.Struct({ path: Schema.String, digest: Schema.String })
export const Provenance = Schema.Struct({
  originRunId: Schema.String,
  policyDigest: Schema.String,
  policySources: Schema.Array(PolicySource),
  reusedFrom: Schema.NullOr(AttemptStore.AttemptId)
})
export type Provenance = typeof Provenance.Type
const Candidate = Schema.Struct({
  inputDigest: Schema.String,
  contentDigest: Schema.String,
  sectionsDigest: Schema.String,
  review: Review,
  reviewer: Schema.String,
  attempt: AttemptStore.AttemptId,
  originRunId: Schema.String
})
export const Pool = Schema.Struct({
  policyDigest: Schema.String,
  policySources: Schema.Array(PolicySource),
  candidates: Schema.Record(Schema.String, Candidate)
})
export type Pool = typeof Pool.Type
const Selection = Schema.Struct({ review: Schema.NullOr(Review), provenance: Provenance, reason: Schema.String })
const BoundPage = Schema.Struct({ ...ReviewedPage.fields, provenance: Provenance })

/** The reviews a run may reuse: a prior terminal run in this engine, or a pool
 * a trusted host carried from an earlier run elsewhere. */
export const Load = Action.make("wiki/load-recorded-reviews", {
  payload: { priorRunId: Schema.optionalKey(Schema.String), pool: Schema.optionalKey(Pool), reviewer: Schema.String },
  success: Pool,
  error: WikiError
})
export const Select = Action.make("wiki/select-recorded-review", {
  payload: { evidence: Evidence, pool: Pool, reviewer: Schema.String },
  success: Selection,
  error: WikiError
})
export const Bind = Action.make("wiki/bind-review-provenance", {
  payload: { ...ReviewedPage.fields, provenance: Provenance },
  success: BoundPage,
  error: WikiError
})
export const Publish = Action.make("wiki/publish-recorded-reviews", {
  payload: { pages: Schema.Record(Schema.String, BoundPage) },
  success: Receipt,
  error: WikiError,
  nondeterministic: true
})
export const IncrementalWiki = Flow.make("smithers/IncrementalWiki", {
  // The reviews to reuse: a prior run in this engine, or a pool carried from elsewhere.
  payload: Schema.Struct({
    ...Input.fields,
    mode: Schema.Literal("verified"),
    priorRunId: Schema.optionalKey(Schema.String),
    pool: Schema.optionalKey(Pool)
  }),
  success: Receipt,
  error: Schema.Union([WikiError, AgentAction.AgentFailure]),
  body: (input) =>
    Node.bindPlanned(
      Load.call({
        reviewer: input.reviewer,
        ...(input.pool === undefined ? {} : { pool: input.pool }),
        ...(input.priorRunId === undefined ? {} : { priorRunId: input.priorRunId })
      }),
      (pool) =>
        Node.bindPlanned(
          Node.all(Object.fromEntries(input.pages.map((spec, index) => [`page-${index}`, Collect.call({ spec })]))),
          (evidence) =>
            Node.bindPlanned(
              Node.all(
                Object.fromEntries(
                  input.pages.map((
                    _,
                    index
                  ) => [
                    `page-${index}`,
                    Node.bindPlanned(
                      Select.call({ evidence: evidence[`page-${index}`]!, pool, reviewer: input.reviewer }),
                      (selection) =>
                        Node.branch(Node.succeed(selection), {
                          if: (selected) => selected.review !== null,
                          then: (selected) => Node.succeed(selected.review),
                          else: () => ReviewPage.call({ evidence: evidence[`page-${index}`]! })
                        }).pipe(
                          Node.bindPlanned((review) => validateOrRepairReview(evidence[`page-${index}`]!, review)),
                          Node.bindPlanned((review) =>
                            Bind.call({
                              evidence: evidence[`page-${index}`]!,
                              review,
                              reviewer: input.reviewer,
                              provenance: selection.provenance
                            })
                          )
                        )
                    )
                  ])
                )
              ),
              (pages) => Publish.call({ pages })
            )
        )
    )
})

const fail = (message: string) => new WikiError({ code: "review-failed", message })
const guarded = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.catch((error) =>
      Effect.fail(error instanceof WikiError ? error : fail(error instanceof Error ? error.message : String(error)))
    )
  )

type ReuseOptions = Parameters<typeof operations>[0] & { readonly hostPolicy?: string | undefined }

export const reuseOperations = (options: ReuseOptions) => {
  const ops = operations(options)
  const policy = (reviewer: string) =>
    Effect.gen(function*() {
      // Configured coding hosts fingerprint the code they actually execute. The
      // target repository need not vendor this implementation to describe itself.
      if (options.hostPolicy !== undefined) {
        if (!options.hostPolicy.trim()) return yield* Effect.fail(fail("Host reviewer policy identity is empty"))
        return {
          policyDigest: yield* digest(canonical({ version: 2, reviewer, hostPolicy: options.hostPolicy })),
          policySources: []
        }
      }
      const fs = options.fs ?? (yield* FileSystem.FileSystem), path = yield* Path.Path
      const sources = yield* Effect.forEach(policySources, (file) =>
        Effect.gen(function*() {
          const text = yield* fs.readFileString(path.resolve(options.root, file))
          if (new TextEncoder().encode(text).length > 512_000) {
            return yield* Effect.fail(fail(`Review policy source is too large: ${file}`))
          }
          return { path: file, digest: yield* digest(text) }
        }))
      return { policyDigest: yield* digest(canonical({ version: 1, reviewer, sources })), policySources: sources }
    })
  const load = (
    { priorRunId, pool, reviewer }: { priorRunId?: string | undefined; pool?: Pool | undefined; reviewer: string }
  ) =>
    guarded(Effect.gen(function*() {
      const current = yield* policy(reviewer)
      if (pool !== undefined) {
        // Select still recaptures every page and revalidates each citation; a
        // pool reviewed under another policy or seat is simply not reused.
        const compatible = pool.policyDigest === current.policyDigest &&
          Object.values(pool.candidates).every((candidate) => candidate.reviewer === reviewer)
        return { ...current, candidates: compatible ? pool.candidates : {} }
      }
      if (priorRunId === undefined) {
        return yield* Effect.fail(fail("Reusing reviews needs a prior run or a carried pool"))
      }
      return yield* loadRun(priorRunId, reviewer, current)
    }))
  const loadRun = (priorRunId: string, reviewer: string, current: Omit<Pool, "candidates">) =>
    Effect.gen(function*() {
      const empty: Pool = { ...current, candidates: {} }
      const runStore = yield* RunStore.RunStore
      const run = yield* runStore.get(priorRunId)
      if (!RunStore.isTerminalRunStatus(run.status)) {
        return yield* Effect.fail(fail("Only a terminal run can supply recorded reviews"))
      }
      const journal = yield* Journal.Journal, store = yield* AttemptStore.AttemptStore
      const ids = new Map<string, AttemptStore.AttemptId>()
      let after: typeof JournalEvent.Seq.Type | undefined
      for (let count = 0; count < 4096;) {
        const page = yield* journal.entries({
          runId: JournalEvent.RunId.make(priorRunId),
          ...(after === undefined ? {} : { after }),
          limit: 512
        })
        count += page.entries.length
        for (const entry of page.entries) {
          if (entry.eventType === EngineEvent.attemptEventType) {
            const parsed = yield* Schema.decodeUnknownEffect(EngineEvent.AttemptPayload)(entry.payload)
            if (parsed.executionId !== priorRunId) {
              return yield* Effect.fail(fail("Recorded attempt belongs to another execution"))
            }
            if (parsed.lifecycle.state === "succeeded") {
              const { executionId: runId, stepKeyDigest, attempt } = parsed
              ids.set(`${stepKeyDigest}:${attempt}`, { runId, stepKeyDigest, attempt })
            }
          } else if (entry.eventType === "flows.engine.attempt-finished") {
            // The current engine emits these legacy lifecycle markers. Resolve
            // their committed result from the matching native attempt row; the
            // typed branch above also accepts the complete v2 event contract.
            const parsed = Schema.decodeUnknownOption(
              Schema.Struct({ ...AttemptStore.AttemptId.fields, state: Schema.String })
            )(entry.payload)
            if (Option.isSome(parsed) && parsed.value.state === "succeeded" && parsed.value.runId === priorRunId) {
              const { runId, stepKeyDigest, attempt } = parsed.value
              ids.set(`${stepKeyDigest}:${attempt}`, { runId, stepKeyDigest, attempt })
            }
          }
        }
        if (!page.hasMore) break
        after = page.entries.at(-1)?.seq
        if (after === undefined || count >= 4096) {
          return yield* Effect.fail(fail("Prior review journal exceeds the bounded lookup; select a smaller run"))
        }
      }
      const rows = yield* Effect.forEach([...ids.values()], (id) => store.get(id))
      const captured = new Map<string, string>()
      const candidates: Record<string, typeof Candidate.Type> = {}
      for (const row of rows) {
        if (Option.isNone(row) || row.value.state !== "succeeded") continue
        const old = Schema.decodeUnknownOption(ReviewedPage)(row.value.outcome)
        const collected = Schema.decodeUnknownOption(Evidence)(row.value.outcome)
        const evidence = Option.isSome(old)
          ? old.value.evidence
          : Option.isSome(collected)
          ? collected.value
          : undefined
        if (evidence) {
          for (const source of evidence.sources) {
            if (!current.policySources.some((policySource) => policySource.path === source.path)) continue
            if (
              (yield* digest(source.text)) !== source.digest ||
              (captured.has(source.path) && captured.get(source.path) !== source.digest)
            ) return empty
            captured.set(source.path, source.digest)
          }
        }
        if (
          Option.isNone(old) || old.value.reviewer !== reviewer || old.value.review === null ||
          !old.value.review.sections.every((section) => section.verdict === "supported")
        ) continue
        // The legacy assessor receipt is reusable only when its embedded evidence
        // is internally intact; the destination also recaptures and reassesses it.
        if (
          (yield* digest(old.value.evidence.markdown)) !== old.value.evidence.contentDigest ||
          (yield* digest(
              canonical({
                policy: 2,
                spec: old.value.evidence.spec,
                sources: old.value.evidence.sources.map(({ path, digest }) => ({ path, digest }))
              })
            )) !== old.value.evidence.inputDigest ||
          !(yield* Effect.forEach(old.value.evidence.sources, (source) =>
            digest(source.text).pipe(Effect.map((hash) => hash === source.digest)))).every(Boolean)
        ) {
          continue
        }
        const inherited = Schema.decodeUnknownOption(BoundPage)(row.value.outcome)
        if (Option.isSome(inherited) && inherited.value.provenance.policyDigest !== current.policyDigest) {
          continue
        }
        const id = old.value.evidence.spec.id
        if (candidates[id]) {
          return empty // Ambiguous successful receipts are never guessed between.
        }
        candidates[id] = {
          inputDigest: old.value.evidence.inputDigest,
          contentDigest: old.value.evidence.contentDigest,
          sectionsDigest: yield* digest(canonical(old.value.evidence.sections)),
          review: old.value.review,
          reviewer,
          attempt: { runId: priorRunId, stepKeyDigest: row.value.stepKeyDigest, attempt: row.value.attempt },
          originRunId: Option.isSome(inherited) ? inherited.value.provenance.originRunId : priorRunId
        }
      }
      if (
        current.policySources.some((source) =>
          captured.get(source.path) !== source.digest
        )
      ) return empty
      return { ...current, candidates }
    })
  const select = ({ evidence, pool, reviewer }: { evidence: Evidence; pool: Pool; reviewer: string }) =>
    guarded(Effect.gen(function*() {
      const instance = yield* FlowRuntime.FlowInstance
      const fresh = (reason: string): typeof Selection.Type => ({
        review: null,
        reason,
        provenance: {
          originRunId: instance.executionId,
          policyDigest: pool.policyDigest,
          policySources: pool.policySources,
          reusedFrom: null
        }
      })
      const candidate = pool.candidates[evidence.spec.id]
      if (!candidate) return fresh("no compatible recorded review")
      if (
        candidate.inputDigest !== evidence.inputDigest || candidate.contentDigest !== evidence.contentDigest ||
        candidate.reviewer !== reviewer
      ) return fresh("page source, prose or reviewer changed")
      if (candidate.sectionsDigest !== (yield* digest(canonical(evidence.sections)))) {
        return fresh("review section boundaries changed")
      }
      const assessment = yield* Effect.result(ops.assess({ evidence, review: candidate.review, reviewer }))
      if (assessment._tag === "Failure") return fresh("recorded citations fail current validation")
      return {
        review: candidate.review,
        reason: "exact recorded review reused",
        provenance: {
          originRunId: candidate.originRunId,
          policyDigest: pool.policyDigest,
          policySources: pool.policySources,
          reusedFrom: candidate.attempt
        }
      }
    }))
  return {
    policy,
    load,
    select,
    bind: (page: typeof BoundPage.Type) => ops.assess(page).pipe(Effect.as(page)),
    publish: ({ pages }: { pages: Record<string, typeof BoundPage.Type> }) => {
      const ordered = Object.keys(pages).sort((a, b) => Number(a.slice(5)) - Number(b.slice(5))).map((key) =>
        pages[key]!
      )
      return guarded(Effect.gen(function*() {
        // The policy is identical for every page reviewed through one seat.
        // Capture it once per reviewer inside this action; the writer below
        // still independently recaptures every declared source before output.
        const policies = new Map<string, string>()
        for (const page of ordered) {
          const reviewer = page.reviewer ?? ""
          if (!policies.has(reviewer)) policies.set(reviewer, (yield* policy(reviewer)).policyDigest)
          if (policies.get(reviewer) !== page.provenance.policyDigest) {
            return yield* Effect.fail(fail("Reviewer policy changed during review"))
          }
        }
        return yield* ops.write(
          ordered,
          "verified",
          Object.fromEntries(ordered.map((page) => [page.evidence.spec.id, page.provenance]))
        )
      }))
    }
  }
}
export const reuseLayers = (options: ReuseOptions) => {
  const ops = reuseOperations(options)
  return Layer.mergeAll(
    Load.toLayer(ops.load),
    Select.toLayer(ops.select),
    Bind.toLayer(ops.bind),
    Publish.toLayer(ops.publish),
    Interpreter.layer(IncrementalWiki)
  )
}
