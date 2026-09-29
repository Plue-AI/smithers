/**
 * The values and action of `coding/wiki` (wiki/flow.ts): the stack service
 * refreshes the repository wiki on one retained stack commit and publishes the
 * verified pages this answers. Generation is the existing `coding/RefreshWiki`
 * (flows/wiki with prior-run reuse); this module only reads the verified
 * snapshot back through its owning checker.
 */
import { Action } from "@smthrs/flow"
import { Effect, FileSystem, Path, Schema } from "effect"
import { operations } from "../wiki/operations.ts"
import { Pool, reuseOperations } from "../wiki/reuse.ts"
import { type PageSpec, Receipt, WikiError } from "../wiki/schema.ts"
import { Refreshed } from "./planning-wiki.ts"
import { StackBase } from "./schema.ts"

export const WikiRefreshInput = Schema.Struct({
  base: StackBase,
  /** The last refresh's reviews, which this refresh reuses page by page when nothing a page reads changed. */
  prior: Schema.optionalKey(Schema.NullOr(Pool))
})

const Digest64 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))
export const PublishedWikiPage = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  kind: Schema.Literals(["current", "intent"]),
  /** Markdown for the cloud wiki: related pages by slug, exact source links bound by the publisher. */
  body: Schema.String.check(Schema.isMaxLength(256 * 1024)),
  inputDigest: Schema.String,
  contentDigest: Schema.String,
  reviewDigest: Schema.NullOr(Schema.String),
  sources: Schema.Array(Schema.Struct({ path: Schema.String, digest: Schema.String }))
})
export type PublishedWikiPage = typeof PublishedWikiPage.Type
export const WikiRefreshResult = Schema.Struct({
  /** The stack commit whose tree was reviewed. */
  commitId: StackBase.fields.commitId,
  wikiRunId: Schema.String,
  artifactDigest: Digest64,
  receipt: Receipt,
  /** Pages the reviewer read this refresh (cold) and pages whose earlier review was reused. */
  reviews: Schema.Struct({ cold: Schema.Int, reused: Schema.Int }),
  /** This refresh's reviews, for the next refresh to carry. */
  pool: Pool,
  pages: Schema.Array(PublishedWikiPage).check(Schema.isMinLength(1), Schema.isMaxLength(30))
})
export type WikiRefreshResult = typeof WikiRefreshResult.Type

/**
 * Imports the dependency documentation the workspace declares into
 * `.flows/wiki/deps`, pinned, before the pages refresh; `memory` reads it
 * there as dependency pages.
 */
export const ImportDocs = Action.make("coding/import-dependency-docs", {
  payload: {},
  success: Schema.Array(Schema.Struct({ name: Schema.String, files: Schema.Array(Schema.String), pin: Schema.String })),
  error: WikiError,
  nondeterministic: true
})

/** Reads the verified snapshot the refresh just installed, through its owning checker. */
export const ReadPublishedWiki = Action.make("coding/read-published-wiki", {
  payload: { base: StackBase, refreshed: Refreshed },
  success: WikiRefreshResult,
  error: WikiError,
  nondeterministic: true
})

const maximumResultBytes = 4 * 1024 * 1024
const fail = (message: string, code: WikiError["code"] = "review-failed") => new WikiError({ code, message })

const Snapshot = Schema.Struct({
  artifactDigest: Digest64,
  verification: Schema.Literal("verified"),
  pages: Schema.Array(Schema.Struct({
    id: Schema.String,
    title: Schema.String,
    kind: Schema.Literals(["current", "intent"]),
    body: Schema.String,
    inputDigest: Schema.String,
    contentDigest: Schema.String,
    sources: Schema.Array(Schema.Struct({ path: Schema.String, digest: Schema.String })),
    verification: Schema.Struct({
      reviewDigest: Schema.NullOr(Schema.String),
      provenance: Schema.optionalKey(Schema.Struct({ reusedFrom: Schema.Unknown }))
    })
  }))
})

/**
 * Snapshot pages link each other and their archived sources by relative
 * path; a cloud page links pages by slug. The mythical publisher binds source
 * links to the folded main commit, whose tree the refresh reviewed.
 */
export const cloudWikiBody = (body: string, titles: ReadonlyMap<string, string>): string =>
  body
    .replace(/\[([^\]\n]*)\]\(\.\/([A-Za-z0-9._-]+)\.md\)/g, (whole, label: string, id: string) =>
      titles.has(id) ? `[[generated-${id}|${label || titles.get(id)}]]` : whole)

/** How many snapshot pages the reviewer read this refresh and how many reused an earlier review. */
export const reviewCounts = (
  pages: ReadonlyArray<{ readonly verification: { readonly provenance?: { readonly reusedFrom: unknown } } }>
) => {
  const reused = pages.filter((page) => page.verification.provenance?.reusedFrom != null).length
  return { cold: pages.length - reused, reused }
}

export const readPublishedWiki = (
  options: {
    readonly repositoryPath: string
    readonly wikiOutput: string
    readonly pages: ReadonlyArray<PageSpec>
    readonly reviewer: string
    readonly hostPolicy?: string | undefined
    readonly fs?: FileSystem.FileSystem | undefined
  },
  base: StackBase,
  refreshed: typeof Refreshed.Type
) =>
  Effect.gen(function*() {
    const fs = options.fs ?? (yield* FileSystem.FileSystem), path = yield* Path.Path
    if (refreshed.receipt.verification !== "verified") return yield* fail("The wiki refresh did not verify every page")
    // The owning checker proves the pointer, archive and every page are intact
    // and still fresh against this working copy before anything is answered.
    yield* operations({ root: options.repositoryPath, output: options.wikiOutput, fs: options.fs }).check(
      options.pages,
      true
    )
    const text = yield* fs.readFileString(path.join(yield* fs.realPath(options.wikiOutput), "current.json"))
    const snapshot = yield* Effect.try({
      try: () => JSON.parse(text) as unknown,
      catch: () => fail("Invalid wiki pointer", "output-conflict")
    }).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Snapshot)),
      Effect.mapError((error) =>
        error instanceof WikiError ? error : fail("The wiki pointer is not a verified snapshot", "output-conflict")
      )
    )
    const titles = new Map(snapshot.pages.map((page) => [page.id, page.title]))
    // The same extraction the next run in this engine would use, carried out.
    const pool = yield* reuseOperations({
      root: options.repositoryPath,
      output: options.wikiOutput,
      fs: options.fs,
      hostPolicy: options.hostPolicy
    })
      .load({ priorRunId: refreshed.wikiRunId, reviewer: options.reviewer })
    const result: WikiRefreshResult = {
      commitId: base.commitId,
      wikiRunId: refreshed.wikiRunId,
      artifactDigest: snapshot.artifactDigest,
      receipt: refreshed.receipt,
      reviews: reviewCounts(snapshot.pages),
      pool,
      pages: snapshot.pages.map((page) => ({
        id: page.id,
        title: page.title,
        kind: page.kind,
        body: cloudWikiBody(page.body, titles),
        inputDigest: page.inputDigest,
        contentDigest: page.contentDigest,
        reviewDigest: page.verification.reviewDigest,
        sources: page.sources.map(({ path, digest }) => ({ path, digest }))
      }))
    }
    if (new TextEncoder().encode(JSON.stringify(result)).length > maximumResultBytes) {
      return yield* fail("The published wiki and its reviews exceed 4 MiB; narrow the page catalog", "invalid-input")
    }
    return yield* Schema.decodeUnknownEffect(WikiRefreshResult)(result).pipe(
      Effect.mapError(() => fail("The published wiki violates its contract", "output-conflict"))
    )
  }).pipe(Effect.mapError((error) =>
    error instanceof WikiError ? error : fail(error instanceof Error ? error.message : String(error), "io")
  ))
