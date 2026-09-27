/**
 * PACKAGE.ts agent target flavors and the workspace agent declarations:
 * `S.Agent.Lint`, `S.Agent.Diff`, `S.Agent.Pr`, `S.Agent.ClaudeCode`,
 * `S.Agent.Codex`, `S.Agent.Pool`, and the `S.Agents` reference surface.
 *
 * The target bodies are one sealed action call each: `Agent.Lint` plans an
 * {@link AgentLint} call, `Agent.Diff` plans an {@link AgentDiff} call, and
 * `Agent.Pr` plans an {@link AgentPr} call. The action payloads carry only
 * inert data — declared diffs, the prompt file path, payload input specs,
 * MCP declarations, write-set globs, and gate identities — so plan-time stays
 * pure. Execution is provided by the agent session layers in
 * `@smthrs/build-cli/AgentSession`.
 *
 * Agent references (`S.Agents.<name>`) are inert records validated against
 * the workspace `S.Agents({ ... })` declaration when the package index loads.
 *
 * @since 0.1.0
 */

import { Action } from "@smthrs/flow"
import * as Schema from "effect/Schema"
import { createHash } from "node:crypto"
import * as Attr from "./Attr.ts"
import * as Input from "./Input.ts"
import * as Reference from "./Reference.ts"
import * as Target from "./Target.ts"

/**
 * Maximum bytes of one agent prompt file.
 *
 * @category constants
 * @since 0.1.0
 */
export const maximumPromptBytes = 1024 * 1024

/**
 * Schema for a Claude Code agent declaration.
 *
 * @category schemas
 * @since 0.1.0
 */
export const ClaudeCodeAgent = Schema.TaggedStruct("AgentClaudeCode", {
  model: Schema.NonEmptyString
})

/**
 * A Claude Code agent declaration.
 *
 * @category models
 * @since 0.1.0
 */
export type ClaudeCodeAgent = typeof ClaudeCodeAgent.Type

/**
 * Schema for a Codex agent declaration.
 *
 * @category schemas
 * @since 0.1.0
 */
export const CodexAgent = Schema.TaggedStruct("AgentCodex", {
  model: Schema.NonEmptyString
})

/**
 * A Codex agent declaration.
 *
 * @category models
 * @since 0.1.0
 */
export type CodexAgent = typeof CodexAgent.Type

/**
 * Schema for an agent pool declaration naming sibling agents.
 *
 * @category schemas
 * @since 0.1.0
 */
export const PoolAgent = Schema.TaggedStruct("AgentPool", {
  agents: Schema.Array(Schema.NonEmptyString)
})

/**
 * An agent pool declaration.
 *
 * @category models
 * @since 0.1.0
 */
export type PoolAgent = typeof PoolAgent.Type

/**
 * Schema for one workspace agent declaration.
 *
 * @category schemas
 * @since 0.1.0
 */
export const AgentDeclaration = Schema.Union([ClaudeCodeAgent, CodexAgent, PoolAgent])

/**
 * One workspace agent declaration.
 *
 * @category models
 * @since 0.1.0
 */
export type AgentDeclaration = typeof AgentDeclaration.Type

/**
 * Checks whether a value is one workspace agent declaration.
 *
 * @category guards
 * @since 0.1.0
 */
export const isAgentDeclaration: (value: unknown) => value is AgentDeclaration = Schema.is(AgentDeclaration)

/**
 * Schema for the `agent` attr: a reference to a workspace-declared agent
 * (`S.Agents.luna`), or an agent declaration written where it is used
 * (`S.Agent.Codex("gpt-6-luna")`).
 *
 * Both spellings say the same thing about which agent runs. The reference
 * form names the workspace's reviewed set and is what a repository with an
 * `S.Agents({ ... })` declaration writes; the inline form is what a
 * repository without one writes, and it is not less explicit — the
 * declaration is right there in the lane.
 *
 * @category schemas
 * @since 0.1.0
 */
export const AgentSelector = Schema.Union([Reference.AgentRef, AgentDeclaration])

/**
 * The `agent` attr: a workspace agent reference, or an inline declaration.
 *
 * @category models
 * @since 0.1.0
 */
export type AgentSelector = typeof AgentSelector.Type

/**
 * Maximum findings accepted from one agent response.
 *
 * @category constants
 * @since 0.1.0
 */
export const maximumFindings = 10_000

/**
 * Maximum UTF-16 code units of one finding message.
 *
 * @category constants
 * @since 0.1.0
 */
export const maximumFindingMessage = 16 * 1024

/**
 * Maximum UTF-16 code units of one workspace-relative path.
 *
 * @category constants
 * @since 0.1.0
 */
export const maximumPathLength = 16 * 1024

/**
 * Maximum UTF-16 code units of one candidate edit's contents.
 *
 * @category constants
 * @since 0.1.0
 */
export const maximumEditLength = 4 * 1024 * 1024

/**
 * Maximum candidate edits accepted from one agent response.
 *
 * @category constants
 * @since 0.1.0
 */
export const maximumEdits = 4_096

/**
 * Maximum bounded rounds one Agent.Diff or Agent.Pr loop may declare.
 *
 * @category constants
 * @since 0.1.0
 */
export const maximumRounds = 16

/**
 * Rounds an Agent.Pr declaration runs when it omits `maxRounds`.
 *
 * @category constants
 * @since 0.1.0
 */
export const defaultPrRounds = 3

/**
 * Maximum UTF-16 code units of one gate report detail.
 *
 * @category constants
 * @since 0.1.0
 */
export const maximumGateDetail = 64 * 1024

/**
 * Rounds one bounded candidate and gate loop runs: a whole number from 1 to
 * {@link maximumRounds}.
 *
 * Every declaration that projects to a {@link DiffPayload} shares it, so a
 * declaration a rule accepts always projects to a payload the action accepts.
 *
 * @category schemas
 * @since 0.1.0
 */
export const RoundCount = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(maximumRounds)
)

/**
 * Rounds one bounded candidate and gate loop runs.
 *
 * @category models
 * @since 0.1.0
 */
export type RoundCount = typeof RoundCount.Type

/**
 * Finding severity, ordered `info` below `warning` below `error`.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Severity = Schema.Literals(["info", "warning", "error"])

/**
 * Finding severity.
 *
 * @category models
 * @since 0.1.0
 */
export type Severity = typeof Severity.Type

/**
 * One agent finding against a file in the reviewed diff slice.
 *
 * `line` is 1-based; whole-file findings report line 1.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Finding = Schema.Struct({
  file: Schema.NonEmptyString.check(Schema.isMaxLength(maximumPathLength)),
  line: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  severity: Severity,
  message: Schema.NonEmptyString.check(Schema.isMaxLength(maximumFindingMessage))
})

/**
 * One agent finding against a file in the reviewed diff slice.
 *
 * @category models
 * @since 0.1.0
 */
export type Finding = typeof Finding.Type

/**
 * The execution mode of one Agent.Lint run: `check` reports findings and
 * `fix` also applies candidate edits confined to the `fixes` write-set.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Mode = Schema.Literals(["check", "fix"])

/**
 * The execution mode of one Agent.Lint run.
 *
 * @category models
 * @since 0.1.0
 */
export type Mode = typeof Mode.Type

/**
 * One candidate file edit an agent session proposes: the complete next
 * contents of a workspace-relative path, or null to delete it.
 *
 * @category schemas
 * @since 0.1.0
 */
export const CandidateEdit = Schema.Struct({
  path: Schema.NonEmptyString.check(Schema.isMaxLength(maximumPathLength)),
  contents: Schema.NullOr(Schema.String.check(Schema.isMaxLength(maximumEditLength)))
})

/**
 * One candidate file edit an agent session proposes.
 *
 * @category models
 * @since 0.1.0
 */
export type CandidateEdit = typeof CandidateEdit.Type

/**
 * The verdict of one gate run against a candidate tree.
 *
 * @category schemas
 * @since 0.1.0
 */
export const GateStatus = Schema.Literals(["green", "red"])

/**
 * The verdict of one gate run against a candidate tree.
 *
 * @category models
 * @since 0.1.0
 */
export type GateStatus = typeof GateStatus.Type

/**
 * One gate's verdict against the exact candidate tree of one round.
 *
 * @category schemas
 * @since 0.1.0
 */
export const GateReportEntry = Schema.Struct({
  gate: Schema.NonEmptyString,
  status: GateStatus,
  detail: Schema.optional(Schema.String.check(Schema.isMaxLength(maximumGateDetail)))
})

/**
 * One gate's verdict against the exact candidate tree of one round.
 *
 * @category models
 * @since 0.1.0
 */
export type GateReportEntry = typeof GateReportEntry.Type

/**
 * An agent execution step failed: resolving the agent, reading the prompt or
 * diff slice, spawning or parsing a session, applying edits, running gates,
 * settling, or consulting the verdict cache.
 *
 * @category errors
 * @since 0.1.0
 */
export class AgentSessionError extends Schema.TaggedError<AgentSessionError>()(
  "smithers-build/AgentSessionError",
  {
    phase: Schema.Literals(["resolve", "diff", "read", "spawn", "parse", "apply", "gate", "settle", "cache"]),
    message: Schema.NonEmptyString
  }
) {}

/**
 * A required payload input is missing or invalid; raised before any session
 * spawn.
 *
 * @category errors
 * @since 0.1.0
 */
export class AgentNeedsInput extends Schema.TaggedError<AgentNeedsInput>()(
  "smithers-build/AgentNeedsInput",
  {
    field: Schema.NonEmptyString,
    expected: Schema.NonEmptyString,
    message: Schema.NonEmptyString
  }
) {}

/**
 * A declared MCP server did not answer the reachability precheck; raised
 * before any session spawn.
 *
 * @category errors
 * @since 0.1.0
 */
export class AgentMcpUnreachable extends Schema.TaggedError<AgentMcpUnreachable>()(
  "smithers-build/AgentMcpUnreachable",
  {
    name: Schema.NonEmptyString,
    url: Schema.NonEmptyString,
    message: Schema.NonEmptyString
  }
) {}

/**
 * An agent session proposed a write outside its declared write-set. The
 * candidate is rejected whole; no file changes.
 *
 * @category errors
 * @since 0.1.0
 */
export class AgentWriteEscape extends Schema.TaggedError<AgentWriteEscape>()(
  "smithers-build/AgentWriteEscape",
  {
    path: Schema.NonEmptyString,
    writeSet: Schema.Array(Schema.String),
    message: Schema.NonEmptyString
  }
) {}

/**
 * A check-mode Agent.Lint completed and the agent reported findings.
 *
 * @category errors
 * @since 0.1.0
 */
export class AgentFindingsError extends Schema.TaggedError<AgentFindingsError>()(
  "smithers-build/AgentFindingsError",
  {
    findings: Schema.Array(Finding).check(Schema.isMaxLength(maximumFindings)),
    message: Schema.NonEmptyString
  }
) {}

/**
 * The bounded candidate/gate loop exhausted `maxRounds` without a green gate
 * set. `diff` and `gateReport` preserve the final candidate as artifacts.
 *
 * @category errors
 * @since 0.1.0
 */
export class AgentRoundsExhausted extends Schema.TaggedError<AgentRoundsExhausted>()(
  "smithers-build/AgentRoundsExhausted",
  {
    rounds: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    diff: Schema.String,
    gateReport: Schema.Array(GateReportEntry),
    message: Schema.NonEmptyString
  }
) {}

/**
 * The Agent.Pr loop converged but the PR settle action is not bound. The
 * candidate and its gate report are preserved as artifacts. Opening the pull
 * request is the Github lane's interface; this build refuses rather than
 * faking the outward action.
 *
 * @category errors
 * @since 0.1.0
 */
export class AgentPrSettleRefused extends Schema.TaggedError<AgentPrSettleRefused>()(
  "smithers-build/AgentPrSettleRefused",
  {
    diff: Schema.String,
    gateReport: Schema.Array(GateReportEntry),
    message: Schema.NonEmptyString
  }
) {}

/**
 * Every failure one Agent.Lint execution can produce.
 *
 * @category schemas
 * @since 0.1.0
 */
export const LintError = Schema.Union([AgentSessionError, AgentWriteEscape, AgentFindingsError])

/**
 * Every failure one Agent.Lint execution can produce.
 *
 * @category models
 * @since 0.1.0
 */
export type LintError = typeof LintError.Type

/**
 * Every failure one Agent.Diff execution can produce.
 *
 * @category schemas
 * @since 0.1.0
 */
export const DiffError = Schema.Union([
  AgentNeedsInput,
  AgentMcpUnreachable,
  AgentWriteEscape,
  AgentRoundsExhausted,
  AgentSessionError
])

/**
 * Every failure one Agent.Diff execution can produce.
 *
 * @category models
 * @since 0.1.0
 */
export type DiffError = typeof DiffError.Type

/**
 * Every failure one Agent.Pr execution can produce.
 *
 * @category schemas
 * @since 0.1.0
 */
export const PrError = Schema.Union([
  AgentNeedsInput,
  AgentMcpUnreachable,
  AgentWriteEscape,
  AgentRoundsExhausted,
  AgentPrSettleRefused,
  AgentSessionError
])

/**
 * Every failure one Agent.Pr execution can produce.
 *
 * @category models
 * @since 0.1.0
 */
export type PrError = typeof PrError.Type

/**
 * Payload of one {@link AgentLint} call.
 *
 * `promptPath` is the declared prompt file path (`//`-prefixed paths resolve
 * from the workspace root, everything else from `packageDirectory`).
 * `diffs` are the `S.gitDiff` declarations found in the target's `data`; the
 * expanded slice is the review subject and an empty expansion settles green
 * with zero session spawns. `fixes` is the write-set candidate fixes are
 * confined to in `fix` mode.
 *
 * @category schemas
 * @since 0.1.0
 */
export const LintPayload = Schema.Struct({
  agent: Schema.optional(AgentSelector),
  promptPath: Schema.NonEmptyString.check(Schema.isMaxLength(maximumPathLength)),
  packageDirectory: Schema.optional(Schema.String.check(Schema.isMaxLength(maximumPathLength))),
  diffs: Schema.Array(Input.GitDiff),
  fixes: Schema.Array(Schema.NonEmptyString),
  mode: Mode
})

/**
 * Payload of one {@link AgentLint} call.
 *
 * @category models
 * @since 0.1.0
 */
export type LintPayload = typeof LintPayload.Type

/**
 * Result of one green Agent.Lint execution.
 *
 * `vacuous` is true when the expanded diff slice was empty and no agent
 * session was invoked; `note` then says so explicitly. `fixed` lists the
 * paths a `fix`-mode run rewrote.
 *
 * @category schemas
 * @since 0.1.0
 */
export const LintReport = Schema.Struct({
  vacuous: Schema.Boolean,
  note: Schema.optional(Schema.String),
  files: Schema.Array(Schema.String),
  findings: Schema.Array(Finding).check(Schema.isMaxLength(maximumFindings)),
  fixed: Schema.Array(Schema.String)
})

/**
 * Result of one green Agent.Lint execution.
 *
 * @category models
 * @since 0.1.0
 */
export type LintReport = typeof LintReport.Type

/**
 * Payload of one {@link AgentDiff} or {@link AgentPr} call.
 *
 * `payloadSpec` declares the invoker inputs; the values arrive at execution
 * time and are validated against this spec before any session spawn. `mcp`
 * lists the declared MCP servers prechecked for reachability before model
 * spend. `changes` is the write-set every candidate edit must stay inside.
 * `gateIdentities` are the structural identities of the declared gates, in
 * order; the gate runner resolves them back to executable targets.
 *
 * @category schemas
 * @since 0.1.0
 */
export const DiffPayload = Schema.Struct({
  agent: Schema.optional(AgentSelector),
  promptPath: Schema.NonEmptyString.check(Schema.isMaxLength(maximumPathLength)),
  packageDirectory: Schema.optional(Schema.String.check(Schema.isMaxLength(maximumPathLength))),
  payloadSpec: Schema.Record(Schema.String, Reference.InputSpec),
  mcp: Schema.Array(Reference.McpHttp),
  diffs: Schema.Array(Input.GitDiff),
  changes: Schema.Array(Schema.NonEmptyString),
  gateIdentities: Schema.Array(Schema.NonEmptyString),
  maxRounds: RoundCount
})

/**
 * Payload of one {@link AgentDiff} or {@link AgentPr} call.
 *
 * @category models
 * @since 0.1.0
 */
export type DiffPayload = typeof DiffPayload.Type

/**
 * Result of one green Agent.Diff execution: the accepted candidate and the
 * gate report that admitted it.
 *
 * `vacuous` is true when the target declared `S.gitDiff` data and its
 * expansion was empty, so no session was invoked. `diff` is a rendered
 * listing of the candidate tree; `edits` is the exact accepted edit set.
 *
 * @category schemas
 * @since 0.1.0
 */
export const DiffResult = Schema.Struct({
  vacuous: Schema.Boolean,
  rounds: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  diff: Schema.String,
  edits: Schema.Array(CandidateEdit).check(Schema.isMaxLength(maximumEdits)),
  gateReport: Schema.Array(GateReportEntry)
})

/**
 * Result of one green Agent.Diff execution.
 *
 * @category models
 * @since 0.1.0
 */
export type DiffResult = typeof DiffResult.Type

/**
 * Result of one green Agent.Pr execution: the accepted candidate plus the
 * opened pull request reference.
 *
 * @category schemas
 * @since 0.1.0
 */
export const PrResult = Schema.Struct({
  vacuous: Schema.Boolean,
  rounds: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  diff: Schema.String,
  edits: Schema.Array(CandidateEdit).check(Schema.isMaxLength(maximumEdits)),
  gateReport: Schema.Array(GateReportEntry),
  pr: Schema.optional(Schema.String)
})

/**
 * Result of one green Agent.Pr execution.
 *
 * @category models
 * @since 0.1.0
 */
export type PrResult = typeof PrResult.Type

/**
 * The sealed action one Agent.Lint target plans.
 *
 * @category actions
 * @since 0.1.0
 */
export const AgentLint = Action.make("smithers-build/agent-lint", {
  payload: LintPayload,
  success: LintReport,
  error: LintError,
  tier: "sealed"
})

/**
 * The sealed action one Agent.Diff target plans.
 *
 * @category actions
 * @since 0.1.0
 */
export const AgentDiff = Action.make("smithers-build/agent-diff", {
  payload: DiffPayload,
  success: DiffResult,
  error: DiffError,
  tier: "sealed"
})

/**
 * The sealed action one Agent.Pr target plans.
 *
 * @category actions
 * @since 0.1.0
 */
export const AgentPr = Action.make("smithers-build/agent-pr", {
  payload: DiffPayload,
  success: PrResult,
  error: PrError,
  tier: "sealed"
})

const isGitDiff = Schema.is(Input.GitDiff)

/**
 * Collects every `S.gitDiff` declaration from a `data` attr, in declaration
 * order, descending nested arrays.
 *
 * @category accessors
 * @since 0.1.0
 */
export const collectGitDiffs = (data: (typeof Attr.Data)["Type"]): ReadonlyArray<Input.GitDiff> => {
  const found: Array<Input.GitDiff> = []
  const walk = (value: unknown): void => {
    if (isGitDiff(value)) {
      found.push(value)
      return
    }
    if (Array.isArray(value)) { for (const entry of value) walk(entry) }
  }
  walk(data)
  return found
}

/**
 * Canonically encodes one attr value for {@link targetIdentity}.
 *
 * Nested targets encode as their own recursive identity record, declared
 * inputs and references as their frozen data, and object keys sort so the
 * encoding is order-independent. Functions and symbols have no canonical
 * encoding and collapse to one marker; a cyclic value is a construction-time
 * impossibility for schema-validated attrs and fails loudly.
 */
const canonicalize = (value: unknown, seen: Set<object>): unknown => {
  if (Target.isTarget(value)) {
    const metadata = Target.metadata(value)
    // `implementationDigest` is deliberately absent. It digests function
    // identity, which carries per-process entropy for any callback not built
    // with `Node.capture`, so including it would re-key every gate on every
    // process start and the verdict cache could never hit across runs.
    return {
      $attrs: canonicalize(metadata.attrs, seen),
      $schemas: metadata.schemaIdentity,
      $target: metadata.target
    }
  }
  if (
    typeof value === "function" ||
    typeof value === "symbol" ||
    typeof value === "bigint" ||
    value === undefined
  ) return "$unencodable"
  if (typeof value !== "object" || value === null) return value
  if (seen.has(value)) throw new Error("agent gate identity cannot encode a cyclic attr value")
  seen.add(value)
  try {
    if (Array.isArray(value)) return value.map((entry) => canonicalize(entry, seen))
    const output: Record<string, unknown> = {}
    for (const key of Object.getOwnPropertyNames(value).sort()) {
      output[key] = canonicalize((value as Record<string, unknown>)[key], seen)
    }
    return output
  } finally {
    seen.delete(value)
  }
}

/**
 * The structural identity of one target: its definition name plus a digest of
 * its canonically encoded attrs and schema contracts.
 *
 * Agent gate identities are key material for the agent verdict cache, so two
 * instances of the same definition with different attrs must not collide, and
 * one instance must produce the same identity in every process. Nothing
 * process-local enters the digest for that second reason.
 * This is a plan-time stand-in for the planner's full target key, which also
 * digests expanded file inputs; the integration point swaps it for the
 * planner key without changing the payload shape.
 *
 * @category accessors
 * @since 0.1.0
 */
export const targetIdentity = (target: Target.AnyTarget): string => {
  const metadata = Target.metadata(target)
  const encoded = JSON.stringify(canonicalize(target, new Set())) ?? "$unencodable"
  return `${metadata.target}#${createHash("sha256").update(encoded).digest("hex")}`
}

/**
 * Attrs for {@link Lint}.
 *
 * @category schemas
 * @since 0.1.0
 */
export const LintAttrs = Schema.Struct({
  agent: Schema.optional(AgentSelector),
  prompt: Input.File,
  data: Attr.Data,
  fixes: Schema.optional(Schema.Array(Schema.NonEmptyString))
})

/**
 * Projects decoded Agent.Lint attrs into the {@link AgentLint} payload.
 *
 * The mode is `check`; the `--fix` invocation reaches execution as a payload
 * override wired by the CLI, not as a second declaration.
 *
 * @category accessors
 * @since 0.1.0
 */
export const lintPayload = (
  attrs: (typeof LintAttrs)["Type"],
  context: Target.ImplementationContext
): LintPayload => ({
  ...(attrs.agent === undefined ? {} : { agent: attrs.agent }),
  promptPath: attrs.prompt.path,
  ...(context.packageDirectory === undefined ? {} : { packageDirectory: context.packageDirectory }),
  diffs: collectGitDiffs(attrs.data),
  fixes: [...(attrs.fixes ?? [])],
  mode: "check"
})

const lintDefinition = Target.make("Agent.Lint", {
  attrs: LintAttrs,
  kinds: ["lint"],
  success: LintReport,
  error: LintError,
  cache: false,
  implementation: (attrs, context) => AgentLint.call(lintPayload(attrs, context))
})

/**
 * An agent-judged lint over the declared data; an empty expanded diff is
 * vacuously green with zero agent spawns.
 *
 * @category targets
 * @since 0.1.0
 */
export const Lint = lintDefinition

/**
 * Attrs for {@link Diff}.
 *
 * @category schemas
 * @since 0.1.0
 */
export const DiffAttrs = Schema.Struct({
  agent: Schema.optional(AgentSelector),
  prompt: Input.File,
  payload: Schema.optional(Schema.Record(Schema.String, Reference.InputSpec)),
  mcp: Schema.optional(Schema.Array(Reference.McpHttp)),
  data: Attr.Data,
  changes: Schema.Array(Schema.NonEmptyString),
  gates: Attr.Gates,
  secrets: Schema.optional(Attr.Secrets),
  sandbox: Schema.optional(Attr.Sandbox),
  approval: Schema.optional(Attr.Approval),
  maxRounds: RoundCount
})

/**
 * Projects decoded Agent.Diff attrs into the {@link AgentDiff} payload.
 *
 * @category accessors
 * @since 0.1.0
 */
export const diffPayload = (
  attrs: (typeof DiffAttrs)["Type"],
  context: Target.ImplementationContext
): DiffPayload => ({
  ...(attrs.agent === undefined ? {} : { agent: attrs.agent }),
  promptPath: attrs.prompt.path,
  ...(context.packageDirectory === undefined ? {} : { packageDirectory: context.packageDirectory }),
  payloadSpec: attrs.payload ?? {},
  mcp: [...(attrs.mcp ?? [])],
  diffs: collectGitDiffs(attrs.data),
  changes: [...attrs.changes],
  gateIdentities: attrs.gates.map((gate) => targetIdentity(gate)),
  maxRounds: attrs.maxRounds
})

const diffDefinition = Target.make("Agent.Diff", {
  attrs: DiffAttrs,
  kinds: ["run"],
  success: DiffResult,
  error: DiffError,
  cache: false,
  implementation: (attrs, context) => AgentDiff.call(diffPayload(attrs, context))
})

/**
 * An agent producing a bounded, gate-checked candidate diff inside the
 * declared write-set.
 *
 * @category targets
 * @since 0.1.0
 */
export const Diff = diffDefinition

/**
 * Attrs for {@link Pr}.
 *
 * @category schemas
 * @since 0.1.0
 */
export const PrAttrs = Schema.Struct({
  agent: Schema.optional(AgentSelector),
  prompt: Input.File,
  payload: Schema.optional(Schema.Record(Schema.String, Reference.InputSpec)),
  mcp: Schema.optional(Schema.Array(Reference.McpHttp)),
  data: Attr.Data,
  changes: Schema.Array(Schema.NonEmptyString),
  gates: Attr.Gates,
  secrets: Schema.optional(Attr.Secrets),
  sandbox: Schema.optional(Attr.Sandbox),
  approval: Schema.optional(Attr.Approval),
  maxRounds: Schema.optional(RoundCount)
})

/**
 * Projects decoded Agent.Pr attrs into the {@link AgentPr} payload.
 *
 * Payload inputs and MCP servers use the same contract as Agent.Diff;
 * `maxRounds` defaults to {@link defaultPrRounds}.
 *
 * @category accessors
 * @since 0.1.0
 */
export const prPayload = (
  attrs: (typeof PrAttrs)["Type"],
  context: Target.ImplementationContext
): DiffPayload => ({
  ...(attrs.agent === undefined ? {} : { agent: attrs.agent }),
  promptPath: attrs.prompt.path,
  ...(context.packageDirectory === undefined ? {} : { packageDirectory: context.packageDirectory }),
  payloadSpec: attrs.payload ?? {},
  mcp: [...(attrs.mcp ?? [])],
  diffs: collectGitDiffs(attrs.data),
  changes: [...attrs.changes],
  gateIdentities: attrs.gates.map((gate) => targetIdentity(gate)),
  maxRounds: attrs.maxRounds ?? defaultPrRounds
})

const prDefinition = Target.make("Agent.Pr", {
  attrs: PrAttrs,
  kinds: ["run"],
  success: PrResult,
  error: PrError,
  cache: false,
  implementation: (attrs, context) => AgentPr.call(prPayload(attrs, context))
})

/**
 * An agent whose accepted candidate becomes a pull request; outward, so it
 * runs only when named explicitly.
 *
 * @category targets
 * @since 0.1.0
 */
export const Pr = prDefinition

/**
 * The model name one agent declaration names.
 *
 * The model is the whole declaration, so a bare string is the same
 * declaration written shorter: `S.Agent.Codex("gpt-6-luna")` and
 * `S.Agent.Codex({ model: "gpt-6-luna" })` construct the same value. Both spellings
 * appear in design-partner declarations, and neither is more correct than the
 * other.
 */
const modelOf = (options: string | { readonly model: string }, what: string): string => {
  const model = typeof options === "string" ? options : options?.model
  if (typeof model !== "string" || model.trim() === "") {
    throw new TypeError(`${what} requires a model name`)
  }
  return model
}

/**
 * Declares a Claude Code agent, by model name or as `{ model }`.
 *
 * @category constructors
 * @since 0.1.0
 */
export const ClaudeCode = (options: string | { readonly model: string }): ClaudeCodeAgent =>
  Object.freeze(ClaudeCodeAgent.make({ model: modelOf(options, "Agent.ClaudeCode") }))

/**
 * Declares a Codex agent, by model name or as `{ model }`.
 *
 * @category constructors
 * @since 0.1.0
 */
export const Codex = (options: string | { readonly model: string }): CodexAgent =>
  Object.freeze(CodexAgent.make({ model: modelOf(options, "Agent.Codex") }))

/**
 * Declares a pool over sibling agent names.
 *
 * @category constructors
 * @since 0.1.0
 */
export const Pool = (agents: ReadonlyArray<string>): PoolAgent => {
  if (!Array.isArray(agents) || agents.length === 0) {
    throw new TypeError("Agent.Pool requires a non-empty array of agent names")
  }
  return Object.freeze(PoolAgent.make({ agents: [...agents] }))
}

/**
 * Runtime marker for the workspace agents declaration.
 *
 * @category type ids
 * @since 0.1.0
 */
export const AgentsTypeId: unique symbol = Symbol.for("smithers-build/Agents") as never

/**
 * The workspace agents declaration: a validated name-to-agent record.
 *
 * @category models
 * @since 0.1.0
 */
export interface AgentsDeclaration {
  readonly [AgentsTypeId]: typeof AgentsTypeId
  readonly agents: Readonly<Record<string, AgentDeclaration>>
}

/**
 * Checks whether a value is the workspace agents declaration.
 *
 * @category guards
 * @since 0.1.0
 */
export const isAgentsDeclaration = (value: unknown): value is AgentsDeclaration => {
  if (typeof value !== "object" || value === null) return false
  const descriptor = Object.getOwnPropertyDescriptor(value, AgentsTypeId)
  return descriptor !== undefined && "value" in descriptor && descriptor.value === AgentsTypeId
}

const agentName = /^[A-Za-z_][A-Za-z0-9_-]*$/

const makeAgents = (agents: Readonly<Record<string, AgentDeclaration>>): AgentsDeclaration => {
  if (typeof agents !== "object" || agents === null) {
    throw new TypeError("Agents requires a name-to-agent record")
  }
  const validated: Record<string, AgentDeclaration> = {}
  const names = Object.getOwnPropertyNames(agents)
  for (const name of names) {
    if (!agentName.test(name)) throw new Error(`Agents name is not a legal reference name: ${JSON.stringify(name)}`)
    const declaration = agents[name]
    if (!isAgentDeclaration(declaration)) {
      throw new TypeError(`Agents entry ${JSON.stringify(name)} is not an agent declaration`)
    }
    validated[name] = declaration
  }
  for (const name of names) {
    const declaration = validated[name]!
    if (declaration._tag !== "AgentPool") continue
    for (const member of declaration.agents) {
      if (!Object.prototype.hasOwnProperty.call(validated, member)) {
        throw new Error(`Agent.Pool member ${JSON.stringify(member)} is not a declared agent name`)
      }
    }
  }
  const value = Object.create(null) as { agents: Readonly<Record<string, AgentDeclaration>> }
  Object.defineProperty(value, AgentsTypeId, {
    configurable: false,
    enumerable: false,
    value: AgentsTypeId,
    writable: false
  })
  value.agents = Object.freeze(validated)
  return Object.freeze(value) as unknown as AgentsDeclaration
}

/**
 * The `S.Agents` surface: callable as the workspace declaration constructor
 * (`S.Agents({ default: ..., luna: ... })` in `.smithers/agents.ts`) and a
 * property-access reference surface (`S.Agents.luna` in a PACKAGE.ts).
 *
 * Property access mints a fresh inert {@link Reference.AgentRef}; the name
 * is validated against the workspace declaration at index time, so an
 * unknown agent name is a graph-load error, never a silent miss.
 *
 * @category constructors
 * @since 0.1.0
 */
export const Agents: typeof makeAgents & Record<string, Reference.AgentRef> = Reference.callableReferences(
  makeAgents,
  (name) => Object.freeze({ _tag: "AgentRef", name }) as Reference.AgentRef
)
