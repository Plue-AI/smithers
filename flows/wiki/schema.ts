/** Repository recipe contracts. These are snapshot artifacts, not a storage API. */
import { Schema } from "effect"

export const Source = Schema.Struct({ path: Schema.String, digest: Schema.String, text: Schema.String })
export const PageSpec = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  purpose: Schema.String,
  kind: Schema.Literals(["current", "intent"]),
  document: Schema.String,
  inputs: Schema.Array(Schema.String),
  related: Schema.Array(Schema.String),
  excerpts: Schema.optional(
    Schema.Record(Schema.String, Schema.Array(Schema.Struct({ start: Schema.Int, end: Schema.Int })))
  )
})
export type PageSpec = typeof PageSpec.Type
export const Section = Schema.Struct({ id: Schema.String, markdown: Schema.String })
export const Evidence = Schema.Struct({
  spec: PageSpec,
  inputDigest: Schema.String,
  contentDigest: Schema.String,
  markdown: Schema.String,
  sections: Schema.Array(Section),
  sources: Schema.Array(Source)
})
export type Evidence = typeof Evidence.Type
export const Review = Schema.Struct({
  sections: Schema.Array(Schema.Struct({
    id: Schema.String,
    verdict: Schema.Literals(["supported", "unsupported", "uncertain"]),
    explanation: Schema.String,
    citations: Schema.Array(
      Schema.Struct({
        path: Schema.String,
        line: Schema.Int,
        quote: Schema.NonEmptyString.check(Schema.isPattern(/^[^\r\n]+$/))
      })
    )
  }))
})
export type Review = typeof Review.Type
export const ReviewedPage = Schema.Struct({
  evidence: Evidence,
  review: Schema.NullOr(Review),
  reviewer: Schema.NullOr(Schema.String)
})
export type ReviewedPage = typeof ReviewedPage.Type
export const Input = Schema.Struct({
  pages: Schema.Array(PageSpec).check(Schema.isMinLength(1), Schema.isMaxLength(30)),
  mode: Schema.Literals(["preview", "verified"]),
  reviewer: Schema.String
})
export type Input = typeof Input.Type
export const Receipt = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  sourceRevision: Schema.String,
  inputDigest: Schema.String,
  output: Schema.String,
  pages: Schema.Int,
  verification: Schema.Literals(["unreviewed", "verified", "needs-changes"])
})
export type Receipt = typeof Receipt.Type
export class WikiError extends Schema.TaggedError<WikiError>()("WikiError", {
  code: Schema.Literals([
    "invalid-input",
    "stale-source",
    "review-failed",
    "output-conflict",
    "citation-check-unavailable",
    "io"
  ]),
  message: Schema.String
}) {}
