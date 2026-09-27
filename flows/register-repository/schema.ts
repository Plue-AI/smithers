/** Typed results of `register-repository`. The app's registration card decodes these same schemas. */
import { Schema } from "effect"

/** Canonical GitHub `owner/repo`, lowercase. */
export const Repo = Schema.String.check(Schema.isPattern(/^[a-z0-9](?:[a-z0-9-]{0,38})\/[a-z0-9._-]{1,100}$/))
export type Repo = typeof Repo.Type

export const Input = Schema.Struct({ link: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500)) })
export type Input = typeof Input.Type

/** A step whose evidence could not be read. The card hides it; the reason stays in the journal. */
export const Unavailable = Schema.TaggedStruct("unavailable", { step: Schema.String, reason: Schema.String })
export type Unavailable = typeof Unavailable.Type

/** A question the workflow answered itself. `by: "smithers"` is a Jev choice; `"detected"` is exact evidence. */
export const Choice = Schema.Struct({
  options: Schema.Array(Schema.String),
  chosen: Schema.String,
  by: Schema.Literals(["smithers", "detected"]),
  evidence: Schema.Array(Schema.String)
})
export type Choice = typeof Choice.Type

const Hex = Schema.String.check(Schema.isPattern(/^#[0-9a-f]{6}$/))
export const Theme = Schema.TaggedStruct("theme", {
  name: Schema.String,
  colors: Schema.Array(Hex),
  logo: Schema.NullOr(Schema.String)
})
export type Theme = typeof Theme.Type

export const Clone = Schema.TaggedStruct("clone", {
  repo: Repo,
  commit: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/)),
  files: Schema.Int,
  lines: Schema.Int
})
export type Clone = typeof Clone.Type

export const License = Schema.TaggedStruct("license", { spdx: Schema.String, choice: Choice })
export type License = typeof License.Type

export const CheckCommand = Schema.Struct({
  kind: Schema.Literals(["test", "lint", "build", "typecheck", "format"]),
  argv: Schema.Array(Schema.String),
  source: Schema.String
})
export type CheckCommand = typeof CheckCommand.Type
export const Checks = Schema.TaggedStruct("checks", {
  choice: Choice,
  commands: Schema.Array(CheckCommand),
  workflows: Schema.Array(Schema.String)
})
export type Checks = typeof Checks.Type

export const CommandRun = Schema.Struct({
  kind: CheckCommand.fields.kind,
  command: Schema.String,
  status: Schema.Literals(["passed", "failed", "timeout", "error"]),
  ms: Schema.Int
})
export type CommandRun = typeof CommandRun.Type
export const PillarId = Schema.Literals(["verify", "ci", "types", "instructions", "setup", "docs", "safety"])
export type PillarId = typeof PillarId.Type
export const Fix = Schema.Struct({ pillar: PillarId, title: Schema.String, points: Schema.Int })
export type Fix = typeof Fix.Type
export const Readiness = Schema.TaggedStruct("readiness", {
  score: Schema.Int,
  level: Schema.Int,
  pillars: Schema.Array(Schema.Struct({ id: PillarId, score: Schema.Int, max: Schema.Int })),
  fixes: Schema.Array(Fix),
  runs: Schema.Array(CommandRun)
})
export type Readiness = typeof Readiness.Type

export const SignalId = Schema.Literals(["duplicates", "churn", "lexicon", "stubs", "dead-code"])
export type SignalId = typeof SignalId.Type
export const Location = Schema.Struct({ path: Schema.String, line: Schema.Int })
export const Cause = Schema.Struct({ signal: SignalId, count: Schema.Int, location: Schema.NullOr(Location) })
export type Cause = typeof Cause.Type
/** Cleanup opportunities. Only the deterministic signals are scored until the calibration corpus exists. */
export const Cleanup = Schema.TaggedStruct("cleanup", {
  status: Schema.Literals(["scored", "insufficient"]),
  coverage: Schema.Number,
  score: Schema.Int,
  low: Schema.Int,
  high: Schema.Int,
  causes: Schema.Array(Cause),
  method: Schema.Literal("deterministic-v0")
})
export type Cleanup = typeof Cleanup.Type

export const Week = Schema.Struct({ start: Schema.String, people: Schema.Int, agents: Schema.Int })
export const Commits = Schema.TaggedStruct("commits", {
  weeks: Schema.Array(Week),
  total: Schema.Int,
  bursts: Schema.Int
})
export type Commits = typeof Commits.Type

/** Evidence floor of agent-written work over twelve months. Never a per-file or per-person claim. */
export const AgentShare = Schema.TaggedStruct("agent-share", {
  commits: Schema.Int,
  traced: Schema.Int,
  markers: Schema.Array(Schema.String)
})
export type AgentShare = typeof AgentShare.Type

export const Contributors = Schema.TaggedStruct("contributors", {
  total: Schema.Int,
  /** Commit counts, largest first, unnamed. */
  shares: Schema.Array(Schema.Int),
  /** The fewest people who together wrote at least half the commits, and their share. */
  core: Schema.Int,
  coreShare: Schema.Number
})
export type Contributors = typeof Contributors.Type

export const Intake = Schema.TaggedStruct("intake", {
  choice: Choice,
  pulls: Schema.Int,
  external: Schema.Int,
  merged: Schema.Int,
  firstReviewHours: Schema.NullOr(Schema.Number),
  contributing: Schema.Boolean,
  cla: Schema.Boolean
})
export type Intake = typeof Intake.Type

const PullRef = Schema.Struct({ pr: Schema.Int, title: Schema.String })
export const Workflows = Schema.TaggedStruct("workflows", {
  lintRules: Schema.Array(PullRef),
  chores: Schema.Array(PullRef),
  scanned: Schema.Int
})
export type Workflows = typeof Workflows.Type

export const CiEstimate = Schema.TaggedStruct("ci", {
  pr: Schema.Int,
  baselineMinutes: Schema.Number,
  estimateMinutes: Schema.Number,
  affected: Schema.Int,
  packages: Schema.Int
})
export type CiEstimate = typeof CiEstimate.Type

/** Anything else found cheaply: source lines by language, largest first. */
export const Languages = Schema.TaggedStruct("languages", {
  languages: Schema.Array(Schema.Struct({ name: Schema.String, lines: Schema.Int }))
})
export type Languages = typeof Languages.Type

/** The admin's answer to the review wait. */
export const Review = Schema.Struct({
  decision: Schema.Literals(["approve", "decline"]),
  note: Schema.String.check(Schema.isMaxLength(2000))
})
export type Review = typeof Review.Type

export const or = <S extends Schema.Top>(schema: S) => Schema.Union([schema, Unavailable])

export const Report = Schema.Struct({
  repo: Repo,
  theme: or(Theme),
  clone: Clone,
  license: or(License),
  checks: or(Checks),
  readiness: or(Readiness),
  cleanup: or(Cleanup),
  agentShare: or(AgentShare),
  commits: or(Commits),
  contributors: or(Contributors),
  intake: or(Intake),
  workflows: or(Workflows),
  ci: or(CiEstimate),
  languages: Languages
})
export type Report = typeof Report.Type

export const SetupReceipt = Schema.Struct({ repo: Repo, commit: Clone.fields.commit, runs: Schema.Array(CommandRun) })
export type SetupReceipt = typeof SetupReceipt.Type

export const Outcome = Schema.Struct({ report: Report, review: Review, setup: Schema.NullOr(SetupReceipt) })
export type Outcome = typeof Outcome.Type

export class RegisterError extends Schema.TaggedError<RegisterError>()("register-repository/Error", {
  code: Schema.Literals(["invalid_link", "unavailable", "wrong_repository"]),
  message: Schema.String
}) {}
