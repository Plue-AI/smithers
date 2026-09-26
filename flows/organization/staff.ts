/**
 * The steps of hiring, delegating to, and retiring specialists.
 *
 * A role asks for a hire in the `hire` field of its result
 * (`Hiring.HireSpec`); {@link StoreHire} turns that field into a profile under
 * `Hiring.propose`, which refuses anything the parent may not give (grants
 * wider than its own, personal accounts or owner contact, a depth, children,
 * persistent, or budget limit, an inactive parent or ancestor), activates it,
 * writes it to `<rosterDir>/Specialists/<id>.md` with compare-and-set, and
 * pins the roster with it so the next step can resolve it. {@link Retire}
 * retires a hire and everything it hired the same way. Delegation hands a
 * task to a principal the parent hired (directly or below), and the parent
 * reviews the output before it counts.
 *
 * Every principal is resolved against the host's registry; nothing a role
 * writes names a profile, a grant, or a path the host did not decide.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Action } from "@smthrs/flow"
import { Clock, Effect, Layer, Option, Result, Schema, Semaphore } from "effect"
import { join } from "node:path"
import * as Actions from "../../packages/smithers/agent/organization/src/Actions.ts"
import * as Authority from "../../packages/smithers/agent/organization/src/Authority.ts"
import * as Hiring from "../../packages/smithers/agent/organization/src/Hiring.ts"
import * as Confined from "../../packages/smithers/agent/organization/src/internal/confined.ts"
import * as Profile from "../../packages/smithers/agent/organization/src/Profile.ts"
import * as Roster from "../../packages/smithers/agent/organization/src/Roster.ts"
import { renderDocument } from "./actions.ts"
import { Answer, RequestKey, Stage } from "./schema.ts"

const line = (text: string, max = 1_900): string => {
  const flat = text.replaceAll(/\s+/g, " ").trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}
const paragraph = (text: string, max = 7_900): string => {
  const trimmed = text.trim()
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`
}
const lines = (texts: ReadonlyArray<string>) => texts.map((text) => line(text)).filter((text) => text !== "")
const taskId = (key: string, step: string) => `${key.slice(0, 100)}/${step}`

/**
 * Checks a result for the fields a host task asks for, whatever the
 * principal's charter declares: a `done` result carries every `required`
 * field and at least one piece of evidence. Host tasks (a hire decision, a
 * review, a meeting agenda) are not charter work, so undeclared fields are
 * allowed and charter fields are not required.
 */
export const ValidateFields = Action.make("organization/validate-fields", {
  implementationVersion: "validate-fields/v1",
  payload: {
    principal: Profile.PrincipalId,
    result: Profile.RoleResult,
    required: Schema.Array(Schema.String)
  },
  success: Actions.Validation
})

/** The violations {@link ValidateFields} finds. */
export const fieldViolations = (
  principal: string,
  result: Profile.RoleResult,
  required: ReadonlyArray<string>
): ReadonlyArray<Roster.Violation> =>
  result.status !== "done" ? [] : [
    ...required.filter((name) => !Object.hasOwn(result.fields, name)).map((name) => ({
      code: "missing-field" as const,
      principal,
      message: `missing field ${name}`
    })),
    ...(result.evidence.length === 0
      ? [{ code: "missing-evidence" as const, principal, message: "missing evidence" }]
      : [])
  ]

/** The parent's hiring task: what it needs, and the grants and limits it may hire within. */
export const HireTask = Action.make("organization/hire-task", {
  implementationVersion: "hire-task/v1",
  payload: {
    revision: Schema.NonEmptyString,
    parent: Profile.PrincipalId,
    key: RequestKey,
    need: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8_000))
  },
  success: Stage,
  error: Authority.DispatchRefused
})

/** What a hire came to. */
export const HireOutcome = Schema.Struct({
  hired: Schema.Boolean,
  /** The hire's principal id, or the parent's when nothing was hired. */
  principal: Profile.PrincipalId,
  /** The profile file, relative to the organization root; empty when nothing was hired. */
  path: Schema.String,
  reason: Schema.String,
  violations: Schema.Array(Roster.Violation)
})
export type HireOutcome = typeof HireOutcome.Type

/**
 * Validates the parent's `hire` field and, when every rule holds, writes the
 * active profile and pins the roster with it. Keyed by the request, so a
 * replay after a crash finds the file it wrote and reports the same hire.
 */
export const StoreHire = Action.make("organization/store-hire", {
  implementationVersion: "store-hire/v1",
  payload: { key: RequestKey, attempt: Schema.Int, parent: Profile.PrincipalId, answer: Answer },
  success: HireOutcome,
  tier: "irreversible",
  idempotencyKey: (payload) => `organization/store-hire:${payload.key}#${payload.attempt}`
})

/** What a retirement came to: the principals retired, root first, and their files. */
export const RetireOutcome = Schema.Struct({
  retired: Schema.Array(Profile.PrincipalId),
  paths: Schema.Array(Schema.String),
  reason: Schema.String
})
export type RetireOutcome = typeof RetireOutcome.Type

/** Retires a hired principal and everything it hired. A core role is retired by editing its page, not here. */
export const Retire = Action.make("organization/retire", {
  implementationVersion: "retire/v1",
  payload: { key: RequestKey, principal: Profile.PrincipalId },
  success: RetireOutcome,
  tier: "irreversible",
  idempotencyKey: (payload) => `organization/retire:${payload.key}`
})

/** The delegated principal's task for one round, or why it may not be given. */
export const DelegateTask = Action.make("organization/delegate-task", {
  implementationVersion: "delegate-task/v1",
  payload: {
    revision: Schema.NonEmptyString,
    key: RequestKey,
    parent: Profile.PrincipalId,
    specialist: Profile.PrincipalId,
    objective: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8_000)),
    inputs: Schema.Array(Schema.String),
    acceptance: Schema.Array(Schema.String),
    round: Schema.Int,
    findings: Schema.Array(Schema.String)
  },
  success: Stage,
  error: Authority.DispatchRefused
})

/** The parent's review of its hire's output: `verdict` is `accept` or `revise`. */
export const ReviewTask = Action.make("organization/review-task", {
  implementationVersion: "review-task/v1",
  payload: {
    revision: Schema.NonEmptyString,
    key: RequestKey,
    parent: Profile.PrincipalId,
    objective: Schema.String,
    acceptance: Schema.Array(Schema.String),
    round: Schema.Int,
    work: Answer
  },
  success: Stage,
  error: Authority.DispatchRefused
})

/**
 * Writes a delegated output its parent accepted to the wiki:
 * `<generatedDir>/<key>/<specialist>.md`, the specialist's result and the
 * parent's review. The specialist writes it when it holds `wiki-write`; else
 * the reviewing parent publishes it when it does; else nothing is written and
 * `reason` says why.
 */
export const PublishWork = Action.make("organization/publish-work", {
  implementationVersion: "publish-work/v1",
  payload: {
    revision: Schema.NonEmptyString,
    key: RequestKey,
    parent: Profile.PrincipalId,
    work: Answer,
    review: Answer
  },
  success: Schema.Struct({ written: Schema.Boolean, path: Schema.String, reason: Schema.String }),
  error: Schema.Union([Authority.DispatchRefused, Actions.ReceiptFailed])
})

/** Whether the parent accepted its hire's output. */
export const Judge = Action.make("organization/judge-review", {
  implementationVersion: "judge-review/v1",
  payload: { work: Answer, review: Answer },
  success: Schema.Struct({ accepted: Schema.Boolean, findings: Schema.Array(Schema.String) })
})

/** How a hire, a delegation, or a retirement ended, as its receipt and its run record it. */
export const StaffReport = Schema.Struct({
  key: RequestKey,
  status: Schema.Literals(["hired", "accepted", "retired", "refused", "revise", "blocked"]),
  summary: Schema.String,
  principal: Schema.String,
  /** The wiki files it wrote: a profile, a document. */
  paths: Schema.Array(Schema.String),
  violations: Schema.optionalKey(Schema.Array(Roster.Violation)),
  /** The delegated task a hire handed its first work to. */
  delegated: Schema.optionalKey(Schema.String),
  receipt: Schema.optionalKey(Schema.String)
})
export type StaffReport = typeof StaffReport.Type

/** A staffing run that ended without its outcome; the receipt says why. */
export class StaffFailed extends Schema.TaggedError<StaffFailed>()("organization/StaffFailed", {
  status: Schema.String,
  message: Schema.String
}) {}

/** Ends a staffing run after its receipt: hired, accepted, or retired succeeds; anything else fails with {@link StaffFailed}. */
export const SettleStaff = Action.make("organization/settle-staff", {
  implementationVersion: "settle-staff/v1",
  payload: { report: StaffReport, receipt: Schema.String },
  success: StaffReport,
  error: StaffFailed
})

/** What the host decided at startup that staffing uses. */
export interface Options {
  /** Organization root: the directory holding `Org/`. */
  readonly root: string
  /** The roster directory under the root: hires go to its `Specialists/`. */
  readonly rosterDir: string
  /** Whether every active core role must hold a weekly meeting (the roster's validation policy). */
  readonly weeklyMeeting: boolean
  /** Seats a hire may hold besides its hirer's own. */
  readonly hireSeats?: ReadonlyArray<string> | undefined
  /** The generated directory accepted outputs are written under. */
  readonly generatedDir: string
}

/** The snapshot with `stored` profiles replacing or joining its roster, validated. */
export const amend = (
  snapshot: Authority.Snapshot,
  stored: ReadonlyArray<Hiring.Stored>,
  weeklyMeeting: boolean,
  hireSeats?: ReadonlyArray<string>
): Result.Result<Authority.Snapshot, Authority.AuthorityError> => {
  const profiles = new Map(snapshot.roster.profiles)
  const sources = new Map(snapshot.roster.sources.map((source) => [source.path, source.digest]))
  for (const entry of stored) {
    profiles.set(entry.profile.id, entry.profile)
    sources.set(`Specialists/${entry.profile.id}.md`, entry.digest)
  }
  return Authority.makeSnapshot({
    roster: Roster.make(profiles.values(), [...sources].map(([path, digest]) => ({ path, digest }))),
    common: snapshot.common,
    skills: snapshot.skills,
    weeklyMeeting,
    hireSeats
  })
}

const specFields = [
  "`slug`: one lowercase word for the hire, such as `competitor-research`; its id becomes `<your id>.<slug>`.",
  "`name`, `objective`, `responsibilities` (a list of lines).",
  "Optional: `kind` (`specialist`, persistent, the default; or `helper`, for this task only), `outputs` (a list of `{name, description}` output fields; default one `report`), `tools`, `knowledge`, `repositories`, `connections`, `skills`, `retrieval` (`{ allow, deny }` web domains for the `retrieval` tool; left out, the hire takes your scope), `budget` (`tokensPerTask`, `tasksPerDay`, `concurrency`), `boundaries`.",
  "Leave `budget` out for the default (100000 tokens per task, 5 tasks a day, one at a time, never more than yours); one task of a few model calls spends 30000 to 100000 tokens, and a task that runs out stops blocked.",
  "Every grant and skill must be one you hold yourself, the budget no larger than yours, and the seat yours; ask for the narrowest the work needs. A hire never holds personal accounts or contacts the owner."
]

const describeGrants = (profile: Profile.Profile): ReadonlyArray<string> => [
  `Your tools: ${profile.grants.tools.join(", ") || "none"}.`,
  `Your knowledge: ${profile.grants.knowledge.join(", ") || "none"}.`,
  `Your repositories: ${profile.grants.repositories.join(", ") || "none"}.`,
  ...(profile.grants.tools.includes("retrieval")
    ? [
      `Your web scope: ${
        profile.grants.retrieval?.allow === undefined
          ? "any public domain"
          : profile.grants.retrieval.allow.join(", ") || "no domain"
      }${
        profile.grants.retrieval?.deny === undefined ? "" : `, except ${profile.grants.retrieval.deny.join(", ")}`
      }; a hire's may only be narrower.`
    ]
    : []),
  `Your skills: ${profile.skills.join(", ") || "none"}.`,
  `Your hiring limits: ${
    profile.grants.hiring === undefined
      ? "you may not hire"
      : `depth ${profile.grants.hiring.maxDepth}, ${profile.grants.hiring.maxChildren} hires, ${profile.grants.hiring.maxPersistent} persistent`
  }; your budget: ${profile.budget.tokensPerTask} tokens per task, ${profile.budget.tasksPerDay} tasks a day.`
]

/** Every staffing step, over the trusted registry and the host's options. */
export const layer = (options: Options) =>
  Layer.unwrap(Effect.gen(function*() {
    const lock = yield* Semaphore.make(1)
    const store = Hiring.layerFileSystem({ dir: join(options.root, options.rosterDir) }).pipe(
      Layer.provide(NodeServices.layer)
    )
    const rosterPath = (id: string) => `${options.rosterDir.replace(/\/+$/, "")}/Specialists/${id}.md`
    /** Writes `profiles` in order and pins the roster with them; all under the lock. */
    const commit = (profiles: ReadonlyArray<Profile.Profile>, create: boolean) =>
      Effect.gen(function*() {
        const roster = yield* Hiring.RosterStore
        const registry = yield* Authority.RosterRegistry
        const stored: Array<Hiring.Stored> = []
        for (const profile of profiles) {
          const existing = yield* roster.read(profile.id)
          if (create && Option.isSome(existing)) {
            // A replay: the file this key wrote is already there.
            stored.push(existing.value)
            continue
          }
          stored.push(yield* roster.write(profile, Option.isSome(existing) ? existing.value.digest : undefined))
        }
        const amended = amend(yield* registry.current, stored, options.weeklyMeeting, options.hireSeats)
        if (Result.isFailure(amended)) {
          return yield* Effect.fail(amended.failure.violations.map((violation) => violation.message).join("; "))
        }
        yield* registry.pin(amended.success)
        return stored
      })
    return Layer.mergeAll(
      ValidateFields.toLayer(({ principal, required, result }) =>
        Effect.sync(() => {
          const violations = fieldViolations(principal, result, required)
          return { valid: violations.length === 0, violations }
        }), { implementationVersion: "validate-fields/v1" }),
      HireTask.toLayer(({ key, need, parent, revision }) =>
        Effect.gen(function*() {
          const registry = yield* Authority.RosterRegistry
          const { profile } = yield* registry.resolve(revision, parent)
          const at = yield* Clock.currentTimeMillis
          return {
            proceed: true,
            outcome: "blocked" as const,
            reason: "",
            principal: parent,
            task: {
              id: taskId(key, "hire"),
              objective: paragraph(
                `Decide the one specialist to hire for this need, and describe the hire: ${need}`
              ),
              inputs: lines(["The need, in the context below.", ...describeGrants(profile)]),
              acceptance: lines([
                "Return done with the field `hire`: an object with these keys, or null when no hire is needed.",
                ...specFields,
                "Cite what the hire is for as evidence."
              ]),
              evidence: ["Why this hire, and why these grants are the narrowest the work needs."],
              requestedBy: "owner" as const
            },
            context: [{
              source: { provider: "organization", id: `need/${key}` },
              provenance: { retrievedAtMs: at },
              text: need
            }]
          }
        }), { implementationVersion: "hire-task/v1" }),
      StoreHire.toLayer(({ answer, key, parent }) =>
        lock.withPermits(1)(Effect.gen(function*() {
          const registry = yield* Authority.RosterRegistry
          const current = yield* registry.current
          const refused = (reason: string, violations: ReadonlyArray<Roster.Violation> = []): HireOutcome => ({
            hired: false,
            principal: parent,
            path: "",
            reason,
            violations
          })
          const hirer = current.roster.profiles.get(parent)
          if (hirer === undefined) return refused(`${parent} is not on the roster`)
          if (!answer.valid) return refused(`${parent}'s answer broke its task: ${answer.violations.join("; ")}`)
          if (answer.result.status !== "done") return refused(`${parent}: ${answer.result.summary}`)
          const spec = answer.result.fields["hire"]
          if (spec === null || spec === undefined) {
            return refused(`${parent} decided no hire is needed: ${answer.result.summary}`)
          }
          const at = new Date(yield* Clock.currentTimeMillis).toISOString().replace(/\.\d{3}Z$/, "Z")
          const request = Hiring.fromSpec(hirer, spec, at, key)
          if (Result.isFailure(request)) return refused("the hire request is malformed", request.failure)
          const proposed = Hiring.propose(request.success, current.roster, {
            weeklyMeeting: options.weeklyMeeting,
            skills: [...current.skills.skills.keys()],
            hireSeats: options.hireSeats
          })
          if (Result.isFailure(proposed)) {
            return refused(
              `the hire breaks ${proposed.failure.length} rule(s): ${
                proposed.failure.map((found) => found.message).join("; ")
              }`,
              proposed.failure
            )
          }
          const active = yield* Effect.fromResult(Hiring.transition(proposed.success, "activate", at)).pipe(
            Effect.mapError((error) => error.message)
          )
          const committed = yield* Effect.result(commit([active], true))
          if (Result.isFailure(committed)) {
            const failure = committed.failure
            return refused(`the hire could not be stored: ${typeof failure === "string" ? failure : failure.message}`)
          }
          return {
            hired: true,
            principal: active.id,
            path: rosterPath(active.id),
            reason: `${parent} hired ${active.id}`,
            violations: []
          }
        })).pipe(
          Effect.catch((message) =>
            Effect.succeed({ hired: false, principal: parent, path: "", reason: String(message), violations: [] })
          )
        ), { implementationVersion: "store-hire/v1" }),
      Retire.toLayer(({ principal }) =>
        lock.withPermits(1)(Effect.gen(function*() {
          const registry = yield* Authority.RosterRegistry
          const current = yield* registry.current
          const refused = (reason: string): RetireOutcome => ({ retired: [], paths: [], reason })
          const profile = current.roster.profiles.get(principal)
          if (profile === undefined) return refused(`${principal} is not on the roster`)
          if (profile.kind === "core") return refused(`${principal} is a core role; retire it by editing its page`)
          if (profile.status === "retired") return refused(`${principal} is already retired`)
          const at = new Date(yield* Clock.currentTimeMillis).toISOString().replace(/\.\d{3}Z$/, "Z")
          const retired = yield* Effect.fromResult(Hiring.retireWithHires(current.roster, principal, at)).pipe(
            Effect.mapError((error) => error.message)
          )
          const committed = yield* Effect.result(commit(retired, false))
          if (Result.isFailure(committed)) {
            const failure = committed.failure
            return refused(
              `the retirement could not be stored: ${typeof failure === "string" ? failure : failure.message}`
            )
          }
          return {
            retired: retired.map((each) => each.id),
            paths: retired.map((each) => rosterPath(each.id)),
            reason: `retired ${retired.map((each) => each.id).join(", ")}`
          }
        })).pipe(Effect.catch((message) => Effect.succeed({ retired: [], paths: [], reason: String(message) }))), {
        implementationVersion: "retire/v1"
      }),
      DelegateTask.toLayer((payload) =>
        Effect.gen(function*() {
          const registry = yield* Authority.RosterRegistry
          const snapshot = yield* registry.get(payload.revision)
          const at = yield* Clock.currentTimeMillis
          const stop = (reason: string) => ({
            proceed: false,
            outcome: "blocked" as const,
            reason,
            principal: payload.parent,
            task: {
              id: taskId(payload.key, `work-${payload.round}`),
              objective: "No task.",
              inputs: [],
              acceptance: [],
              evidence: [],
              requestedBy: payload.parent
            },
            context: []
          })
          // Both must be active now; a paused or retired one is refused outright.
          yield* registry.resolve(payload.revision, payload.parent)
          const { profile } = yield* registry.resolve(payload.revision, payload.specialist)
          const chain = Roster.hireChain(snapshot.roster.profiles, profile.id).map((link) => link.id)
          if (profile.id === payload.parent || !chain.includes(payload.parent)) {
            return stop(`${payload.parent} did not hire ${payload.specialist}`)
          }
          return {
            proceed: true,
            outcome: "blocked" as const,
            reason: "",
            principal: profile.id,
            task: {
              id: taskId(payload.key, `work-${payload.round}`),
              objective: paragraph(payload.objective),
              inputs: lines([
                ...payload.inputs,
                ...(payload.findings.length === 0
                  ? []
                  : [
                    `Round ${payload.round}: ${payload.parent} asked for changes; its findings are in the context below.`
                  ])
              ]),
              acceptance: lines([
                ...payload.acceptance,
                "Put the whole output in the output fields your charter declares and return done with the sources you used as evidence.",
                `You write no file yourself: once ${payload.parent} accepts your output, the host writes it to the wiki.`
              ]),
              evidence: ["The source and date of every claim."],
              requestedBy: payload.parent
            },
            context: payload.findings.length === 0 ? [] : [{
              source: { provider: "organization", id: `review/${payload.round - 1}` },
              provenance: { retrievedAtMs: at },
              text: payload.findings.join("\n")
            }]
          }
        }), { implementationVersion: "delegate-task/v1" }),
      ReviewTask.toLayer((payload) =>
        Effect.gen(function*() {
          const registry = yield* Authority.RosterRegistry
          yield* registry.resolve(payload.revision, payload.parent)
          const at = yield* Clock.currentTimeMillis
          return {
            proceed: true,
            outcome: "blocked" as const,
            reason: "",
            principal: payload.parent,
            task: {
              id: taskId(payload.key, `review-${payload.round}`),
              objective: paragraph(
                `Review ${payload.work.principal}'s output for the task you delegated before it counts: ${payload.objective}`
              ),
              inputs: lines([`${payload.work.principal}'s result, in the context below.`]),
              acceptance: lines([
                ...payload.acceptance.map((criterion) => `Criterion: ${criterion}`),
                "Verify what you can against your own sources; label what stays unverified.",
                "Return done with the field `verdict`: `accept` when the output meets every criterion, otherwise `revise`, with what must change as the summary."
              ]),
              evidence: ["What you verified, and against what."],
              requestedBy: "owner" as const
            },
            context: [{
              source: { provider: "organization", id: `work/${payload.round}` },
              provenance: { retrievedAtMs: at },
              text: JSON.stringify(payload.work.result, null, 2).slice(0, 24_000)
            }]
          }
        }), { implementationVersion: "review-task/v1" }),
      SettleStaff.toLayer(({ receipt, report }) => {
        const settled = { ...report, receipt }
        return settled.status === "hired" || settled.status === "accepted" || settled.status === "retired"
          ? Effect.succeed(settled)
          : Effect.fail(new StaffFailed({ status: settled.status, message: `${settled.status}: ${settled.summary}` }))
      }, { implementationVersion: "settle-staff/v1" }),
      PublishWork.toLayer(({ key, parent, review, revision, work }) =>
        Effect.gen(function*() {
          const registry = yield* Authority.RosterRegistry
          const snapshot = yield* registry.get(revision)
          const holds = (id: string) => snapshot.roster.profiles.get(id)?.grants.tools.includes("wiki-write") === true
          const writer = holds(work.principal) ? work.principal : holds(parent) ? parent : undefined
          if (writer === undefined) {
            return { written: false, path: "", reason: `neither ${work.principal} nor ${parent} holds wiki-write` }
          }
          const relative = `${options.generatedDir.replace(/\/+$/, "")}/${
            Actions.runDirectory(key)
          }/${work.principal}.md`
          const content = `${
            renderDocument(work).trimEnd()
          }\n\n## Review\n\nAccepted by ${parent}: ${review.result.summary.trim()}\n`
          yield* Confined.writeText({ root: options.root, relative, content }).pipe(
            Effect.mapError((refusal) => new Actions.ReceiptFailed({ message: `${relative} ${refusal.message}` })),
            Effect.provide(NodeServices.layer)
          )
          return { written: true, path: relative, reason: writer === parent ? `published by ${parent}` : "" }
        }), { implementationVersion: "publish-work/v1" }),
      Judge.toLayer(({ review, work }) =>
        Effect.sync(() => {
          const findings: Array<string> = []
          if (!work.valid || work.result.status !== "done") {
            findings.push(`${work.principal} did not finish: ${work.result.summary}`)
          }
          const verdict = review.result.fields["verdict"]
          const accepted = review.valid && review.result.status === "done" && typeof verdict === "string" &&
            verdict.trim().toLowerCase() === "accept"
          if (!accepted) findings.push(`${review.principal}: ${review.result.summary}`)
          return { accepted: findings.length === 0, findings: lines(findings) }
        }), { implementationVersion: "judge-review/v1" })
    ).pipe(Layer.provide(store))
  }))
