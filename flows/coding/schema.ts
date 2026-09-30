/** Coding policy is ordinary flow input; the engine remains its durable store. */
import * as Digest from "@smthrs/core/Digest"
import * as Fault from "@smthrs/flow/Fault"
import * as Stall from "@smthrs/flow/Stall"
import { Schema } from "effect"

const Text = Schema.NonEmptyString
const Id = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,199}$/))
export const Revision = Schema.Struct({
  changeId: Text,
  commitId: Text,
  treeId: Text,
  operationId: Text,
  parentCommitIds: Schema.Array(Text)
})
export type Revision = typeof Revision.Type

/** A project Change groups native JJ changes. Planned atoms have no second ID. */
export const AtomicPlan = Schema.Struct({
  changeId: Schema.NullOr(Text),
  message: Text,
  intent: Text,
  reads: Schema.Array(Text),
  writes: Schema.Array(Text)
})
export const Check = Schema.Struct({
  id: Id,
  target: Text,
  flow: Text,
  flowDigest: Text,
  tier: Schema.Literals(["fast", "slow", "delivery"]),
  required: Schema.Boolean
})
export type Check = typeof Check.Type
export const Change = Schema.Struct({
  id: Id,
  title: Text,
  intent: Text,
  implementation: Text,
  implementationDigest: Text,
  atoms: Schema.Array(AtomicPlan).check(Schema.isMinLength(1)),
  checks: Schema.Array(Check)
})
export type Change = typeof Change.Type
export const Plan = Schema.Struct({
  prompt: Text,
  memoryRevision: Text,
  base: Revision,
  // New prepared plans retain the complete source head. An amendment's base
  // can be older than the source the planner inspected. Legacy manual plans
  // remain readable; composed requests require this observed source fact.
  observedHead: Schema.optionalKey(Revision),
  changes: Schema.Array(Change).check(Schema.isMinLength(1))
})
export type Plan = typeof Plan.Type
/**
 * The repository wiki the stack service published, handed to a stack request
 * so its lane plans with it instead of reviewing the pages again. Planning
 * keeps only the pages whose inputs still hash to the lane's source.
 */
export const SuppliedWiki = Schema.Struct({
  sourceRevision: Text.check(Schema.isMaxLength(256)),
  pages: Schema.Array(Schema.Struct({
    id: Text.check(Schema.isMaxLength(128)),
    title: Text.check(Schema.isMaxLength(512)),
    kind: Schema.Literals(["current", "intent"]),
    body: Text.check(Schema.isMaxLength(64 * 1024)),
    inputDigest: Text.check(Schema.isMaxLength(128))
  })).check(Schema.isMaxLength(30))
})
export type SuppliedWiki = typeof SuppliedWiki.Type
export const PlanningInput = Schema.Struct({
  prompt: Text.check(Schema.isMaxLength(32_768)),
  // Feedback is not evidence that a disposable POC was actually executed.
  // The second pass preserves both the bounded user feedback and retained POC
  // feedback (32,768 characters each), separated by two newlines.
  feedback: Schema.String.check(Schema.isMaxLength(65_538)),
  // Present (the pages, or null when none is published) only on a stack
  // request: the host then never generates the wiki for this request.
  wiki: Schema.optionalKey(Schema.NullOr(SuppliedWiki))
})
/** The exact commit a request starts from, retained into this workspace's
 * source ref: the mythical stack tip, or the caller's pushed ref. */
export const StackBase = Schema.Struct({
  commitId: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/)),
  ref: Schema.String.check(Schema.isPattern(/^refs\/smithers\/workspaces\/[0-9a-f-]{36}\/sources\/[0-9a-f]{40}$/))
})
export type StackBase = typeof StackBase.Type
export const RequestInput = Schema.Struct({
  prompt: PlanningInput.fields.prompt,
  // An explicit review of the predicted changes before any implementation.
  planApproval: Schema.optionalKey(Schema.Union([
    Schema.Literals(["always", "never"]),
    Schema.String.check(Schema.isPattern(/^timeout:[1-9][0-9]*s$/))
  ])),
  feedback: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(32_768))),
  maxRounds: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(8))),
  // Start on the mythical stack: import this tip and plan on a fresh working
  // change on it (stack.ts). Absent, the request plans on the workspace as is.
  base: Schema.optionalKey(StackBase),
  // The stack's published wiki (null: none yet); see SuppliedWiki.
  wiki: Schema.optionalKey(Schema.NullOr(SuppliedWiki))
})
export const Finding = Schema.Struct({
  owner: Id,
  message: Text,
  sourceCommitId: Text
})
export type Finding = typeof Finding.Type
export const Implementation = Schema.Struct({
  change: Id,
  parent: Revision,
  atoms: Schema.Array(Revision).check(Schema.isMinLength(1)),
  head: Revision,
  reads: Schema.Array(Text),
  writes: Schema.Array(Text)
})
export type Implementation = typeof Implementation.Type
export const Receipt = Schema.Struct({
  checkId: Id,
  target: Text,
  tier: Schema.Literals(["fast", "slow", "delivery"]),
  change: Id,
  commitId: Text,
  treeId: Text,
  inputDigest: Text,
  status: Schema.Literals(["passed", "failed", "superseded"]),
  // Older durable receipts omit this and retain their real-red semantics.
  fault: Schema.optionalKey(Schema.Literals(["infra", "factory"])),
  // When the check's process started and finished, in epoch milliseconds;
  // older durable receipts and checks without a process omit them.
  startedAt: Schema.optionalKey(Schema.Int),
  finishedAt: Schema.optionalKey(Schema.Int),
  evidence: Schema.String,
  findings: Schema.Array(Finding)
})
export type Receipt = typeof Receipt.Type
export const ValidatedChange = Schema.Struct({
  implementation: Implementation,
  receipts: Schema.Array(Receipt)
})
export type ValidatedChange = typeof ValidatedChange.Type
export const Result = Schema.Struct({
  status: Schema.Literals(["validated", "changes-requested"]),
  changes: Schema.Array(ValidatedChange),
  findings: Schema.Array(Finding)
})
export type Result = typeof Result.Type
/** Domain outcome is distinct from the enclosing engine execution finishing. */
export const CorrectionResult = Schema.Struct({
  status: Schema.Literals(["validated", "changes-requested", "blocked"]),
  rounds: Schema.Int,
  result: Schema.NullOr(Result),
  blocked: Schema.NullOr(Schema.Struct({ executionId: Schema.String, message: Schema.String })),
  // Present when the stall breaker ended the correction (Stall in @smthrs/flow).
  stalled: Schema.optionalKey(Stall.Stalled)
})
/** The leaves Jev routes a TODO to (`factory/Todo`). */
export const Route = Schema.Literals(["implement", "bug", "feature", "close"])
export type Route = typeof Route.Type
/** A TODO request also answers the route Jev gave it, on its result and on its failure. */
export const RequestResult = Schema.Struct({ plan: Plan, outcome: CorrectionResult, route: Schema.optionalKey(Route) })
export class CodingError extends Schema.TaggedError<CodingError>()("coding/Error", {
  code: Schema.Literals([
    "invalid_plan",
    "invalid_request",
    "fast_gate",
    "check_infra",
    "stale_revision",
    "invalid_receipt",
    "unavailable",
    "execution",
    "source_missing",
    "source_changed",
    "source_refused",
    "source_unavailable",
    "declined",
    "stalled",
    "evicted"
  ]),
  message: Text,
  route: Schema.optionalKey(Route)
}) {}
Fault.register(
  "coding/Error",
  {
    declined: "user",
    invalid_request: "user",
    source_missing: "user",
    source_changed: "user",
    source_refused: "user",
    // The plan, its checks, or its correction rounds did not converge: a replan's.
    invalid_plan: "factory",
    fast_gate: "factory",
    stale_revision: "factory",
    stalled: "factory",
    // A local lander evicted the candidate: it conflicts with main, its checks
    // failed on the rebased tree, or main moved under it. The plan's to redo.
    evicted: "factory",
    // Catch-alls: an exporter exit, a decode failure, a deadline, an execution
    // that died under the plan. None is the plan's, so none spends a replan.
    invalid_receipt: "infra",
    check_infra: "infra",
    execution: "infra",
    unavailable: "dependency",
    source_unavailable: "dependency"
  } satisfies Fault.Rows<CodingError["code"]>
)

/** A check that could not measure the revision must never become repair feedback. */
export const receiptOutage = (receipt: Receipt): CodingError | undefined =>
  receipt.status !== "passed" && receipt.fault === "infra"
    ? new CodingError({ code: "check_infra", message: `${receipt.target}: check infrastructure unavailable` })
    : undefined

/** Validate invariants before any implementation or check is scheduled. */
export const validatePlan = (plan: Plan): void => {
  const groups = new Set<string>(), nativeChanges = new Set<string>()
  for (const change of plan.changes) {
    if (groups.has(change.id)) throw new CodingError({ code: "invalid_plan", message: `Duplicate Change ${change.id}` })
    groups.add(change.id)
    const checks = new Set<string>()
    for (const check of change.checks) {
      if (checks.has(check.id)) {
        throw new CodingError({ code: "invalid_plan", message: `Duplicate check ${check.id} in ${change.id}` })
      }
      checks.add(check.id)
    }
    if (
      !change.checks.some((check) => check.required && check.tier === "fast") ||
      !change.checks.some((check) => check.required && check.tier === "slow")
    ) {
      throw new CodingError({
        code: "invalid_plan",
        message: `${change.id} needs a required fast check and a required slow check`
      })
    }
    for (const atom of change.atoms) {
      if (atom.changeId === null) continue
      if (nativeChanges.has(atom.changeId)) {
        throw new CodingError({ code: "invalid_plan", message: `JJ change ${atom.changeId} has more than one owner` })
      }
      nativeChanges.add(atom.changeId)
    }
  }
}

export const receiptMatches = (implementation: Implementation, check: Check, receipt: Receipt): boolean =>
  receipt.change === implementation.change && receipt.checkId === check.id && receipt.target === check.target &&
  receipt.tier === check.tier && receipt.commitId === implementation.head.commitId &&
  receipt.treeId === implementation.head.treeId && receipt.inputDigest === checkInputDigest(implementation, check)

/** The existing canonical digest binds a receipt to the exact delegated inputs. */
export const checkInputDigest = (implementation: Implementation, check: Check): string =>
  `sha256:${Digest.digest(Digest.canonical({ version: 1, implementation, check }))}`

export const sameRevision = (left: Revision, right: Revision): boolean =>
  left.changeId === right.changeId && left.commitId === right.commitId && left.treeId === right.treeId &&
  left.operationId === right.operationId && left.parentCommitIds.length === right.parentCommitIds.length &&
  left.parentCommitIds.every((parent, index) => parent === right.parentCommitIds[index])
