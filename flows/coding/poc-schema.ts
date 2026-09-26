/** Private value contracts shared by the recipe and journal projections. */
import { Schema } from "effect"
import { Plan, Revision } from "./schema.ts"

const Text = Schema.NonEmptyString.check(Schema.isMaxLength(16_384))
const Content = Schema.String.check(Schema.isMaxLength(65_536))
const FilePath = Schema.NonEmptyString.check(Schema.isMaxLength(4096))
export const PocInput = Schema.Struct({ plan: Plan, source: Revision })
export const PocSource = Schema.Struct({
  revision: Revision,
  files: Schema.Array(Schema.Struct({ path: FilePath, content: Schema.NullOr(Content) })).check(Schema.isMaxLength(48)),
  writable: Schema.Array(FilePath).check(Schema.isMaxLength(48)),
  digest: Schema.NonEmptyString
})
export type PocSource = typeof PocSource.Type
export const PocDraft = Schema.Struct({
  explanation: Text,
  files: Schema.Array(Schema.Struct({ path: FilePath, content: Schema.NullOr(Content) }))
    .check(Schema.isMinLength(1), Schema.isMaxLength(48))
})
export type PocDraft = typeof PocDraft.Type
export const PocChanges = Schema.Struct({
  sourceDigest: Schema.NonEmptyString,
  transactionBase: Schema.NonEmptyString,
  files: Schema.Array(
    Schema.Struct({
      path: FilePath,
      before: Schema.NullOr(Content),
      after: Schema.NullOr(Content),
      beforeDigest: Schema.NullOr(Schema.String),
      afterDigest: Schema.NullOr(Schema.String)
    })
  ).check(Schema.isMaxLength(48)),
  preview: Schema.Struct({
    mediaType: Schema.Literal("text/html"),
    content: Schema.String.check(Schema.isMaxLength(4_194_304))
  })
})
export const PocReview = Schema.Struct({
  findings: Schema.Array(Text).check(Schema.isMinLength(1), Schema.isMaxLength(12)),
  nextPlan: Text
})
export const PocResult = Schema.Struct({
  status: Schema.Literal("drafted-unvalidated"),
  source: Revision,
  changes: PocChanges,
  findings: PocReview.fields.findings,
  feedback: Schema.String.check(Schema.isMaxLength(32_768))
})
export type PocResult = typeof PocResult.Type
