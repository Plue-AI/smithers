import * as Fault from "@smthrs/flow/Fault"
import { Effect, Schema } from "effect"

export class ReleaseError extends Schema.TaggedError<ReleaseError>()("ReleaseError", {
  step: Schema.String,
  message: Schema.String
}) {}
// A release step that refused: the release is not in the state the step needs.
Fault.register("ReleaseError", "user")

/** Semver without a v prefix or build metadata; every operator message for a version lives here. */
export const Version = Schema.NonEmptyString.check(
  Schema.isPattern(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/, {
    message: "version must be a semver without a v prefix or build metadata"
  }),
  Schema.makeFilter<string>(
    (value) => value.split("-").slice(1).join("-").split(".").every((part) => !/^0\d+$/.test(part)),
    { message: "Numeric prerelease identifiers cannot have leading zeros" }
  )
)

export const Channels = Schema.Struct({
  changelog: Schema.Boolean,
  blog: Schema.Boolean,
  thread: Schema.Boolean,
  media: Schema.Boolean
})

export const Recording = Schema.Struct({
  url: Schema.NonEmptyString,
  readySelector: Schema.NonEmptyString,
  steps: Schema.Array(Schema.Struct({
    kind: Schema.Literals(["click", "fill", "wait-text"]),
    selector: Schema.NonEmptyString,
    value: Schema.String
  })).check(Schema.isMaxLength(24))
})
export const RecordingAsset = Schema.Struct({ path: Schema.String, digest: Schema.String })

/** Normalized at the entry point; the persisted payload contains every default. */
export const ContentInput = Schema.Struct({
  version: Version,
  from: Schema.NonEmptyString,
  dryRun: Schema.Boolean,
  publish: Schema.Boolean,
  postX: Schema.Boolean,
  autoCommit: Schema.Boolean,
  recording: Schema.NullOr(Recording),
  channels: Channels,
  title: Schema.String,
  notes: Schema.String,
  minScore: Schema.Finite.check(
    Schema.isBetween({ minimum: 0, maximum: 1 }, { message: "minScore must be between 0 and 1" })
  ),
  maxRevisions: Schema.Int.check(
    Schema.isBetween({ minimum: 0, maximum: 3 }, { message: "maxRevisions must be an integer from 0 to 3" })
  ),
  maxTweets: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: 12 }, { message: "maxTweets must be an integer from 1 to 12" })
  ),
  maxTweetChars: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: 280 }, { message: "maxTweetChars must be an integer from 1 to 280" })
  )
})
export type ContentInput = typeof ContentInput.Type

export const ReleaseInput = Schema.Struct({
  version: Version,
  from: Schema.NonEmptyString,
  phase: Schema.Literals(["prepare", "publish"]),
  dryRun: Schema.Boolean,
  contentArtifact: Schema.String,
  requireContentApproval: Schema.Boolean,
  provenance: Schema.Boolean
})
export type ReleaseInput = typeof ReleaseInput.Type

const storedRun = <const Kind extends string, Input extends Schema.Top>(kind: Kind, input: Input) =>
  Schema.Struct({
    schemaVersion: Schema.optionalKey(Schema.Literal(1)).pipe(
      Schema.withDecodingDefaultKey(Effect.succeed(1 as const))
    ),
    kind: Schema.Literal(kind),
    id: Schema.String,
    input,
    model: Schema.String,
    maxTokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
  })
/**
 * The run record persisted at .flows/releases/runs/<id>/run.json. Records written
 * before schemaVersion existed decode as version 1.
 */
export const StoredRun = Schema.Union([storedRun("release", ReleaseInput), storedRun("release-content", ContentInput)])
export type StoredRun = typeof StoredRun.Type

/** One release.yml gate the local path declared it cannot run; reported, never counted as passed. */
export const GateException = Schema.Struct({ name: Schema.String, command: Schema.String, reason: Schema.String })
/**
 * The checks step's receipt: every inventory gate that passed, by release.yml
 * step name and in order, and every declared exception that did not run. The
 * pack step writes it beside the release manifest as gate-evidence.json and
 * the approval prompt repeats the exceptions.
 */
export const GateEvidence = Schema.Struct({ ran: Schema.Array(Schema.String), exceptions: Schema.Array(GateException) })
export type GateEvidence = typeof GateEvidence.Type

export const Evidence = Schema.Struct({
  version: Schema.String,
  currentVersion: Schema.String,
  sourceSha: Schema.String,
  from: Schema.String,
  date: Schema.String,
  commits: Schema.String,
  changes: Schema.String,
  documents: Schema.String,
  recordings: Schema.Array(RecordingAsset),
  sources: Schema.Array(Schema.String),
  // Absent until the checks step runs; pack refuses evidence without it.
  gates: Schema.optionalKey(GateEvidence)
})
export type Evidence = typeof Evidence.Type

export const Analysis = Schema.Struct({
  title: Schema.String,
  summary: Schema.String,
  highlights: Schema.Array(Schema.String),
  risks: Schema.Array(Schema.String),
  migration: Schema.Array(Schema.String),
  claims: Schema.Array(Schema.Struct({
    id: Schema.String,
    text: Schema.String,
    sources: Schema.Array(Schema.String)
  }))
})
export type Analysis = typeof Analysis.Type

/**
 * What the writer seat produces once the narrative is settled. The narrative
 * itself is not in here: Jev picks it and the caller writes it, so the seat
 * has no field to overwrite it with.
 */
export const Outline = Schema.Struct({
  angle: Schema.String,
  outline: Schema.Array(Schema.String)
})
export const Brief = Schema.Struct({
  template: Schema.String,
  ...Outline.fields
})
export const Copy = Schema.Struct({ text: Schema.String, claimIds: Schema.Array(Schema.String) })
export const Thread = Schema.Struct({ tweets: Schema.Array(Copy) })
export const Draft = Schema.Struct({ changelog: Copy, blog: Copy, thread: Thread })
export type Draft = typeof Draft.Type

export const Review = Schema.Struct({
  passed: Schema.Boolean,
  score: Schema.Number,
  feedback: Schema.Array(Schema.String)
})
export type Review = typeof Review.Type

export const Artifact = Schema.Struct({
  directory: Schema.String,
  digest: Schema.String,
  version: Schema.String,
  sourceSha: Schema.String,
  files: Schema.Array(Schema.Struct({ path: Schema.String, digest: Schema.String })),
  approvalPrompt: Schema.String
})
export type Artifact = typeof Artifact.Type

export const ContentResult = Schema.Struct({
  status: Schema.Literals(["preview", "approved", "declined", "published"]),
  artifact: Artifact,
  files: Schema.Array(Schema.String),
  tweetIds: Schema.Array(Schema.String)
})
export type ContentResult = typeof ContentResult.Type

export const DocumentationAudit = Schema.Struct({
  passed: Schema.Boolean,
  missing: Schema.Array(Schema.String),
  explanation: Schema.String
})

export const Candidate = Schema.Struct({
  directory: Schema.String,
  digest: Schema.String,
  sourceSha: Schema.String,
  version: Schema.String,
  packageCount: Schema.Number,
  approvalPrompt: Schema.String
})
export type Candidate = typeof Candidate.Type

export const ReleaseResult = Schema.Struct({
  status: Schema.Literals(["preview", "prepared", "declined", "published"]),
  version: Schema.String,
  artifact: Schema.String,
  published: Schema.Array(Schema.String)
})
export type ReleaseResult = typeof ReleaseResult.Type
