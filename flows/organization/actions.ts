/**
 * The host's implementations of the organization flows' own steps.
 *
 * They read only the host's configuration and the trusted roster registry;
 * every principal a role names in its result is resolved against the pinned
 * snapshot here, so a role can hand work only to an active principal that
 * holds the grants the work needs.
 */
import { createHash } from "node:crypto"
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join, relative, resolve, sep } from "node:path"
import { Clock, Effect, Layer } from "effect"
import { fromIntegrationError } from "../../packages/smithers/agent/integrations/src/core/ActionFailure.ts"
import { IntegrationError } from "../../packages/smithers/agent/integrations/src/core/IntegrationError.ts"
import { ReceiptFailed, runDirectory } from "../../packages/smithers/agent/organization/src/Actions.ts"
import * as Authority from "../../packages/smithers/agent/organization/src/Authority.ts"
import type * as Gates from "../../packages/smithers/agent/organization/src/Gates.ts"
import type * as Profile from "../../packages/smithers/agent/organization/src/Profile.ts"
import type * as Prompt from "../../packages/smithers/agent/organization/src/Prompt.ts"
import * as Workspace from "../../packages/smithers/agent/organization/src/Workspace.ts"
import {
  Admit,
  AgainTask,
  type Answer,
  Assign,
  type Assignment,
  BuildTask,
  CheckTask,
  CorrectTask,
  Decide,
  DeliveryFailed,
  Describe,
  IntakeRefused,
  LeadTask,
  RenderReply,
  type Request,
  RouteTask,
  Settle,
  type Stage,
  StatusFailed,
  DisposeWorkspaces,
  type HostAsk,
  ReadAsk,
  WriteDocument,
  WriteStatus,
  Headline,
  HostRoute,
  PublishChange,
  type Report
} from "./schema.ts"
import * as GitHub from "./github.ts"

/** What the host decided at startup that every admission uses. */
export interface Options {
  /** Organization root: the directory holding `Org/`. */
  readonly root: string
  /** The assistant principal the organization page names. */
  readonly assistant: string
  /** Repository names to trusted host paths. */
  readonly repositories: Readonly<Record<string, string>>
  /** The loaded gate policy. */
  readonly gates: Gates.GatePolicy
  /** The checks every change runs in a fresh machine. */
  readonly checks: ReadonlyArray<Workspace.Check>
  /** Slack user ids admitted as the owner. */
  readonly owners: ReadonlyArray<string>
  readonly maxRounds: number
  /** The generated directory receipts go under, and the status page. */
  readonly generatedDir: string
  readonly statusFile: string
  /** Repositories whose landed branches become pull requests: the remote pushed to and the GitHub repository. */
  readonly pulls?: Readonly<Record<string, { readonly remote: string; readonly github: string }>> | undefined
  /** The environment the GitHub client reads its token and API base from. */
  readonly environment?: Readonly<Record<string, string | undefined>> | undefined
}

/** A report as the one line its thread ends with: the outcome, the pull request or branch, and the receipt. */
export const headline = (report: Report, receipt: string): string => {
  const short = (text: string, max: number) => line(text, max)
  const outcome = (() => {
    if (report.status === "landed") {
      if (report.pull !== undefined) return `Landed: ${report.pull.url}`
      return report.applied === undefined ? "Landed" : `Landed on ${report.applied.branch} ${report.applied.commit.slice(0, 12)}`
    }
    if (report.status === "answered") return `Answered: ${report.document ?? short(report.summary, 160)}`
    const label = report.status === "changes-requested" ? "Changes requested" : `${report.status[0]!.toUpperCase()}${report.status.slice(1)}`
    return `${label}: ${short(report.summary, 160)}`
  })()
  return `${outcome} · ${receipt}`
}

/** A pull request's body: the issue it fixes, the checks, and the receipt. */
export const pullBody = (payload: {
  readonly key: string
  readonly issue?: { readonly number: number } | undefined
  readonly checks: ReadonlyArray<{ readonly name: string; readonly exitCode: number | null; readonly timedOut: boolean }>
}, generatedDir: string): string =>
  [
    ...(payload.issue === undefined ? [] : [`Fixes #${payload.issue.number}`, ""]),
    ...(payload.checks.length === 0
      ? ["Checks: none configured"]
      : payload.checks.map((check) => `- ${check.exitCode === 0 ? "pass" : check.timedOut ? "timed out" : `exit ${check.exitCode ?? "none"}`}: ${check.name}`)),
    "",
    `Receipt: ${join(generatedDir, runDirectory(payload.key), "deliver.json")}`
  ].join("\n")

/** The branch every landed change goes to, under `organization/`. */
export const branchFor = (key: string): string => {
  const slug = key.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-").replaceAll(/^-+|-+$/g, "").slice(0, 48)
  return `organization/${slug === "" ? "request" : slug}-${createHash("sha256").update(key).digest("hex").slice(0, 8)}`
}

export const line = (text: string, max = 1_900): string => {
  const flat = text.replaceAll(/\s+/g, " ").trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}
export const paragraph = (text: string, max = 7_900): string => {
  const trimmed = text.trim()
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`
}
export const lines = (texts: ReadonlyArray<string>) => texts.map((text) => line(text)).filter((text) => text !== "")
export const taskId = (key: string, step: string) => `${key.slice(0, 100)}/${step}`

const requestContext = (request: Request, at: number): Prompt.ContextEntry => ({
  source: { provider: request.source, id: request.key },
  provenance: { retrievedAtMs: at },
  text: request.text
})
const conversationOf = (request: Request) =>
  request.conversation === undefined ? {} : {
    conversation: {
      provider: "slack",
      container: request.conversation.channel,
      thread: request.conversation.thread
    }
  }

const stop = (principal: string, outcome: Stage["outcome"], reason: string, task: Profile.TaskContract): Stage => ({
  proceed: false,
  outcome,
  reason: reason.trim() === "" ? outcome : reason,
  principal,
  task,
  context: []
})

/** The roster lines a routing or contract task lists as candidates. */
const candidates = (
  snapshot: Authority.Snapshot,
  admit: (profile: Profile.Profile) => boolean
): ReadonlyArray<string> =>
  [...snapshot.roster.profiles.values()]
    .filter((profile) => profile.status === "active" && admit(profile))
    .map((profile) => `${profile.id} (${profile.name}): ${profile.charter.objective}`)

const holdsRepository = (profile: Profile.Profile, repository: string) =>
  profile.grants.tools.includes("workspace") && profile.grants.repositories.includes(repository)

const describeResult = (answer: Answer): string =>
  answer.valid
    ? answer.result.summary
    : `${answer.result.summary} (${answer.principal} broke its charter: ${answer.violations.join("; ")})`

/** A child run's key under its delivery's: `<key>.<suffix>`, within a request key's length. */
export const childKey = (key: string, suffix: string) => `${key.slice(0, 127 - suffix.length)}.${suffix}`

/** Whether `principal` was hired by `parent`, directly or below one of its hires. */
const hiredUnder = (snapshot: Authority.Snapshot, principal: string, parent: string) => {
  let current = snapshot.roster.profiles.get(principal)
  for (let depth = 0; current?.hiredBy !== undefined && depth <= snapshot.roster.profiles.size; depth++) {
    if (current.hiredBy === parent) return true
    current = snapshot.roster.profiles.get(current.hiredBy)
  }
  return false
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** What a valid `done` answer's host fields ask for (`schema.ts`, {@link HostAsk}). */
export const readAsk = (key: string, answer: Answer): HostAsk => {
  const none: HostAsk = { kind: "none", reason: "", hire: null, meeting: null }
  if (!answer.valid || answer.result.status !== "done") return none
  const { hire, meeting } = answer.result.fields
  const invalid = (reason: string): HostAsk => ({ ...none, kind: "invalid", reason: `${answer.principal}: ${reason}` })
  if (hire !== undefined && hire !== null) {
    if (!isRecord(hire) || typeof hire.need !== "string" || hire.need.trim() === "") {
      return invalid("fields.hire needs a need, the work the hire is for")
    }
    const task = typeof hire.task === "string" && hire.task.trim() !== "" ? paragraph(hire.task) : undefined
    const acceptance = Array.isArray(hire.acceptance) ? lines(hire.acceptance.filter((item) => typeof item === "string")) : []
    return {
      ...none,
      kind: "hire",
      hire: {
        key: childKey(key, "hire"),
        parent: answer.principal,
        need: paragraph(hire.need),
        ...(task === undefined ? {} : { task, ...(acceptance.length === 0 ? {} : { acceptance }) })
      }
    }
  }
  if (meeting !== undefined && meeting !== null) {
    const minutes = isRecord(meeting) ? Number(meeting.minutes) : Number.NaN
    if (!isRecord(meeting) || typeof meeting.purpose !== "string" || meeting.purpose.trim() === "") {
      return invalid("fields.meeting needs a purpose")
    }
    if (!Number.isInteger(minutes) || minutes < 5 || minutes > 240) {
      return invalid("fields.meeting needs minutes, a whole number from 5 to 240")
    }
    return {
      ...none,
      kind: "meeting",
      meeting: { key: childKey(key, "meeting"), requestedBy: answer.principal, purpose: line(meeting.purpose), minutes }
    }
  }
  return none
}

/** The host fields a principal may use, as task acceptance lines. */
const askLines = (profile: Profile.Profile): ReadonlyArray<string> => [
  ...(profile.grants.tools.includes("delegate") && (profile.grants.hiring?.maxChildren ?? 0) > 0
    ? ["To hire a specialist for this instead, return done with no handoffs and `fields.hire`: `{ need, task, acceptance }` (the work the hire is for, its first task, and that task's criteria)."]
    : []),
  "To ask for time with the owner instead, return done with no handoffs and `fields.meeting`: `{ purpose, minutes }`."
]

/** A role's answer as a wiki page: the summary, each output field, and the evidence it cites. */
export const renderDocument = (answer: Answer): string => {
  const value = (field: unknown): string =>
    typeof field === "string"
      ? field.trim()
      : Array.isArray(field) && field.every((item) => typeof item === "string")
      ? field.map((item) => `- ${item}`).join("\n")
      : `\`\`\`json\n${JSON.stringify(field, null, 2)}\n\`\`\``
  const { result } = answer
  return [
    `# ${line(result.summary, 200)}`,
    "",
    `${answer.principal} · ${result.status}`,
    ...Object.entries(result.fields).flatMap(([name, field]) => ["", `## ${name}`, "", value(field)]),
    ...(result.evidence.length === 0
      ? []
      : ["", "## Evidence", "", ...result.evidence.map((item) => `- ${item.kind} \`${item.ref}\`${item.detail === "" ? "" : `: ${line(item.detail, 400)}`}`)]),
    ...(result.handoffs.length === 0 ? [] : ["", "## Handoffs", "", ...result.handoffs.map((item) => `- ${item.to}: ${line(item.objective, 400)}`)]),
    ...(result.escalations.length === 0 ? [] : ["", "## Escalations", "", ...result.escalations.map((item) => `- ${item.to}: ${line(item.reason, 400)}`)]),
    ""
  ].join("\n")
}

const negativeVerdict = /^(?:request-changes|changes-requested|reject(?:ed)?|fail(?:ed)?|blocked|inconclusive)$/i

/** The last `max` characters of `text`, marked when cut. */
const tail = (text: string, max: number) => text.length <= max ? text : `…${text.slice(text.length - max + 1)}`

export const fence = (text: string, max: number) => text.length <= max ? text : `${text.slice(0, max)}\n… (${text.length - max} more characters not shown)`

export const atomicWrite = async (root: string, path: string, content: string) => {
  const target = resolve(root, path)
  if (!target.startsWith(resolve(root) + sep)) throw new Error(`${path} is outside the organization root`)
  await mkdir(dirname(target), { recursive: true })
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temporary, content, { mode: 0o644 })
  await rename(temporary, target)
  return relative(root, target)
}

/** The delivery receipts under the generated directory, newest first. */
export const readReceipts = async (root: string, generatedDir: string) => {
  const directory = resolve(root, generatedDir)
  const entries = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return []
    throw error
  })
  const receipts: Array<{ readonly key: string; readonly status: string; readonly summary: string; readonly at: number; readonly branch?: string; readonly commit?: string }> = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const text = await readFile(join(directory, entry.name, "deliver.json"), "utf8").catch(() => undefined)
    if (text === undefined) continue
    try {
      const parsed = JSON.parse(text) as {
        readonly admission?: { readonly at?: number }
        readonly report?: { readonly key?: string; readonly status?: string; readonly summary?: string; readonly applied?: { readonly branch?: string; readonly commit?: string } }
      }
      const report = parsed.report ?? {}
      receipts.push({
        key: report.key ?? entry.name,
        status: report.status ?? "unknown",
        summary: report.summary ?? "",
        at: parsed.admission?.at ?? 0,
        ...(report.applied?.branch === undefined ? {} : { branch: report.applied.branch }),
        ...(report.applied?.commit === undefined ? {} : { commit: report.applied.commit })
      })
    } catch {
      continue
    }
  }
  return receipts.sort((left, right) => right.at - left.at || (left.key < right.key ? -1 : 1))
}

/** Every organization step the flows call, over the trusted registry and the host's options. */
export const layer = (options: Options) =>
  Layer.mergeAll(
    Admit.toLayer(({ request }) =>
      Effect.gen(function*() {
        if (request.source === "slack" && (request.user === undefined || !options.owners.includes(request.user))) {
          return yield* new IntakeRefused({ reason: "not-owner", message: "only the organization's owner may make requests" })
        }
        const names = Object.keys(options.repositories)
        const repository = request.repository ?? (names.length === 1 ? names[0] : undefined)
        if (repository === undefined) {
          return yield* new IntakeRefused({ reason: "no-repository", message: `name one of the configured repositories: ${names.join(", ")}` })
        }
        if (!Object.hasOwn(options.repositories, repository)) {
          return yield* new IntakeRefused({ reason: "unknown-repository", message: `repository ${repository} is not configured on this host` })
        }
        if (request.source === "slack" && (request.role !== undefined || request.issue !== undefined)) {
          return yield* new IntakeRefused({ reason: "host-only", message: "only the host names a request's role or issue" })
        }
        const pull = options.pulls?.[repository]
        return {
          ...(pull === undefined ? {} : { pull }),
          assistant: options.assistant,
          repository,
          commit: "HEAD",
          branch: branchFor(request.key),
          checks: options.checks,
          gates: options.gates,
          maxRounds: options.maxRounds,
          at: yield* Clock.currentTimeMillis
        }
      }), { implementationVersion: "admit/v1" }),
    RouteTask.toLayer(({ assistant, request, revision }) =>
      Effect.gen(function*() {
        const registry = yield* Authority.RosterRegistry
        const { profile, snapshot } = yield* registry.resolve(revision, assistant)
        const at = yield* Clock.currentTimeMillis
        return {
          proceed: true,
          outcome: "blocked" as const,
          reason: "",
          principal: assistant,
          task: {
            id: taskId(request.key, "route"),
            objective:
              "Route the owner's request in the context below to the one role accountable for delivering it, or answer it yourself when it needs no work.",
            inputs: lines([
              "The owner's request, in the context below.",
              ...candidates(snapshot, (profile) => profile.id !== assistant).map((entry) => `Role ${entry}`)
            ]),
            acceptance: lines([
              "Return done.",
              "When the request needs work, include exactly one handoff: `to` is the accountable role's id from the inputs, `objective` restates the request, and `inputs` lists what the role needs.",
              "When it needs no work, include no handoff and put the answer in the summary.",
              ...askLines(profile),
              "Fill every output field your charter declares."
            ]),
            evidence: ["The request text and the routing reason."],
            requestedBy: "owner" as const,
            ...conversationOf(request)
          },
          context: [requestContext(request, at)]
        }
      }), { implementationVersion: "route-task/v2" }),
    LeadTask.toLayer(({ repository, request, revision, routed }) =>
      Effect.gen(function*() {
        const registry = yield* Authority.RosterRegistry
        const snapshot = yield* registry.get(revision)
        const at = yield* Clock.currentTimeMillis
        const placeholder: Profile.TaskContract = {
          id: taskId(request.key, "contract"),
          objective: "No contract.",
          inputs: [],
          acceptance: [],
          evidence: [],
          requestedBy: routed.principal
        }
        if (!routed.valid) return stop(routed.principal, "blocked", describeResult(routed), placeholder)
        if (routed.result.status !== "done") return stop(routed.principal, "blocked", routed.result.summary, placeholder)
        const handoff = routed.result.handoffs[0]
        if (handoff === undefined) return stop(routed.principal, "answered", routed.result.summary, placeholder)
        if (handoff.to === routed.principal) {
          return stop(routed.principal, "blocked", `${routed.principal} handed the request to itself`, placeholder)
        }
        // An inactive or unknown lead is a refusal, not a quiet stop.
        const lead = (yield* registry.resolve(revision, handoff.to)).profile
        return {
          proceed: true,
          outcome: "blocked" as const,
          reason: "",
          principal: handoff.to,
          task: {
            id: taskId(request.key, "contract"),
            objective: paragraph(handoff.objective),
            inputs: lines([
              ...handoff.inputs,
              `Repository: ${repository}.`,
              ...candidates(snapshot, (profile) => holdsRepository(profile, repository)).map((entry) =>
                `Can build or check in ${repository}: ${entry}`
              )
            ]),
            acceptance: lines([
              `When the request changes ${repository}, return done with exactly two handoffs.`,
              `The first hands the change to the role that builds it: \`objective\` is the one change to make in ${repository}, and \`inputs\` are its acceptance criteria, one per entry.`,
              "The second hands the finished change to a different role that independently checks it against those criteria.",
              ...(lead.grants.tools.includes("wiki-write")
                ? [
                  "When the request's output is a document or a reply rather than a repository change (a brief, a triage, a draft, a review), do the work yourself from the request, its context and what you can read, and return done with no handoffs. The host writes your summary and output fields to the organization wiki as the document; you need no tool to write or post it."
                ]
                : []),
              ...askLines(lead),
              "Fill every output field your charter declares."
            ]),
            evidence: ["The request and the checks the acceptance relies on."],
            requestedBy: routed.principal,
            ...conversationOf(request)
          },
          context: [requestContext(request, at)]
        }
      }), { implementationVersion: "lead-task/v5" }),
    Assign.toLayer(({ contract, key, repository, revision }) =>
      Effect.gen(function*() {
        const registry = yield* Authority.RosterRegistry
        const blocked = (reason: string): Assignment => ({
          proceed: false,
          reason,
          lead: contract.principal,
          builder: contract.principal,
          checker: contract.principal,
          objective: "",
          acceptance: [],
          message: "No change",
          checkerWorkspace: false,
          delegate: null
        })
        if (!contract.valid) return blocked(describeResult(contract))
        if (contract.result.status !== "done") return blocked(contract.result.summary)
        const [build, check] = contract.result.handoffs
        // A handoff to a specialist the lead hired is a delegation: the hire
        // works under its own grants and the lead reviews it.
        if (build !== undefined) {
          const snapshot = yield* registry.get(revision)
          if (hiredUnder(snapshot, build.to, contract.principal)) {
            const specialist = (yield* registry.resolve(revision, build.to)).profile
            return {
              proceed: true,
              reason: "",
              lead: contract.principal,
              builder: specialist.id,
              checker: contract.principal,
              objective: line(build.objective, 7_900),
              acceptance: lines(build.inputs),
              message: line(build.objective, 72),
              checkerWorkspace: false,
              delegate: {
                key: childKey(key, "delegate"),
                parent: contract.principal,
                specialist: specialist.id,
                objective: paragraph(build.objective),
                inputs: [],
                acceptance: lines(build.inputs)
              }
            }
          }
        }
        if (build === undefined || check === undefined) {
          return blocked(`${contract.principal}'s contract names no builder and checker`)
        }
        if (build.to === check.to) return blocked("the builder cannot check its own change")
        // Resolving refuses an unknown, paused, or retired principal outright.
        const builder = (yield* registry.resolve(revision, build.to)).profile
        const checker = (yield* registry.resolve(revision, check.to)).profile
        if (!holdsRepository(builder, repository)) {
          return blocked(`${builder.id} holds no workspace for ${repository}`)
        }
        const objective = line(build.objective, 7_900)
        return {
          proceed: true,
          reason: "",
          lead: contract.principal,
          builder: builder.id,
          checker: checker.id,
          objective,
          acceptance: lines(build.inputs),
          message: line(objective, 72),
          checkerWorkspace: holdsRepository(checker, repository),
          delegate: null
        }
      }), { implementationVersion: "assign/v4" }),
    BuildTask.toLayer(({ assignment, findings, request, round, workdir }) =>
      Clock.currentTimeMillis.pipe(Effect.map((at): Stage => ({
        proceed: true,
        outcome: "blocked",
        reason: "",
        principal: assignment.builder,
        task: {
          id: taskId(request.key, `build-${round}`),
          objective: paragraph(assignment.objective),
          inputs: lines([
            `The repository checkout is ${workdir} in your workspace machine.`,
            ...(findings.length === 0 ? [] : [`Round ${round}: the checker asked for changes; its findings are in the context below.`])
          ]),
          acceptance: lines([
            ...assignment.acceptance,
            "Change only what these criteria require, inside the workspace.",
            "Read the output of every command you run before you answer: answer in a later reply than the commands, never in the same one.",
            "Return done with every output field your charter declares and the commands you ran as evidence."
          ]),
          evidence: ["Command output from the workspace."],
          requestedBy: assignment.lead,
          ...conversationOf(request)
        },
        context: [
          requestContext(request, at),
          ...(findings.length === 0 ? [] : [{
            source: { provider: "organization", id: `findings/${round - 1}` },
            provenance: { retrievedAtMs: at },
            text: findings.join("\n")
          }])
        ]
      }))), { implementationVersion: "build-task/v2" }),
    CheckTask.toLayer(({ assignment, build, checks, diff, request, round, workdir }) =>
      Clock.currentTimeMillis.pipe(Effect.map((at): Stage => ({
        proceed: true,
        outcome: "blocked",
        reason: "",
        principal: assignment.checker,
        task: {
          id: taskId(request.key, `check-${round}`),
          objective: paragraph(`Decide whether this change meets its acceptance criteria: ${assignment.objective}`),
          inputs: lines([
            "The diff, the check receipts from a fresh machine, and the builder's summary, in the context below.",
            `${diff.files.length} file(s) changed, +${diff.added} -${diff.deleted} against commit ${diff.commit}; configured checks ${checks.passed ? "passed" : "did not pass"}.`,
            ...(assignment.checkerWorkspace
              ? [`The change is applied in the repository checkout at ${workdir} in a workspace machine of your own, removed after your turn: reproduce the criteria there.`]
              : [])
          ]),
          acceptance: lines([
            ...assignment.acceptance.map((criterion) => `Criterion: ${criterion}`),
            "Read the output of every command you run before you answer: answer in a later reply than the commands, never in the same one.",
            "Return done only when every criterion is met and every configured check passed; otherwise return blocked with the unmet criteria as the summary.",
            `Name a commit only as ${diff.commit.slice(0, 12)}; the machine's own commits exist nowhere else.`,
            "Fill every output field your charter declares."
          ]),
          evidence: ["Check receipts and diff references."],
          requestedBy: assignment.lead,
          ...conversationOf(request)
        },
        workspace: assignment.checkerWorkspace,
        context: [
          {
            source: { provider: "organization", id: `diff/${round}` },
            provenance: { retrievedAtMs: at },
            text: fence(diff.patch, 24_000)
          },
          {
            source: { provider: "organization", id: `checks/${round}` },
            provenance: { retrievedAtMs: at },
            text: fence(
              checks.receipts.map((receipt) =>
                `${receipt.name}: ${receipt.argv.join(" ")} → exit ${receipt.exitCode ?? "none"}${receipt.timedOut ? " (timed out)" : ""}\n${receipt.stdout.text}${receipt.stderr.text}`
              ).join("\n\n") || "No checks are configured.",
              12_000
            )
          },
          {
            source: { provider: "organization", id: `build/${round}` },
            provenance: { retrievedAtMs: at },
            text: fence(`${build.principal}: ${describeResult(build)}`, 4_000)
          }
        ]
      }))), { implementationVersion: "check-task/v6" }),
    CorrectTask.toLayer(({ result, stage, validation }) =>
      Clock.currentTimeMillis.pipe(Effect.map((at): Stage => ({
        ...stage,
        context: [
          ...stage.context,
          {
            source: { provider: "organization", id: `correction/${stage.task.id}` },
            provenance: { retrievedAtMs: at },
            text: [
              "Your previous answer to this task broke your charter:",
              ...validation.violations.map((violation) => `- ${violation.message}`),
              "Answer the task again with a result that keeps your charter. Your previous result:",
              fence(JSON.stringify(result, null, 2), 8_000)
            ].join("\n")
          }
        ]
      }))), { implementationVersion: "correct-task/v1" }),
    AgainTask.toLayer(({ reason, stage }) =>
      Clock.currentTimeMillis.pipe(Effect.map((at): Stage => ({
        ...stage,
        task: { ...stage.task, id: `${stage.task.id}/again` },
        context: [
          ...stage.context,
          { source: { provider: "organization", id: `again/${stage.task.id}` }, provenance: { retrievedAtMs: at }, text: reason }
        ]
      }))), { implementationVersion: "again-task/v1" }),
    ReadAsk.toLayer(({ answer, key }) => Effect.sync(() => readAsk(key, answer)), { implementationVersion: "read-ask/v1" }),
    HostRoute.toLayer(({ assistant, request, revision }) =>
      Effect.gen(function*() {
        const registry = yield* Authority.RosterRegistry
        // An unknown, paused, or retired role is refused, as a route to it would be.
        const role = (yield* registry.resolve(revision, request.role ?? assistant)).profile
        return {
          principal: assistant,
          result: {
            status: "done" as const,
            summary: `Handed to ${role.id} by the host.`,
            fields: {},
            evidence: [{ kind: "record" as const, ref: request.key, detail: `${request.source} request` }],
            handoffs: [{ to: role.id, objective: paragraph(request.text), inputs: [] }],
            escalations: [],
            decisions: []
          },
          valid: true,
          violations: []
        }
      }), { implementationVersion: "host-route/v1" }),
    Headline.toLayer(({ receipt, report }) => Effect.sync(() => headline(report, receipt)), { implementationVersion: "headline/v1" }),
    PublishChange.toLayer((payload) =>
      Effect.gen(function*() {
        const path = options.repositories[payload.repository]
        if (path === undefined) {
          return yield* Effect.fail(new IntegrationError("invalid-config", `repository ${payload.repository} is not configured on this host`, {}))
        }
        const pushed = GitHub.push(path, payload.remote, payload.applied.branch, payload.applied.commit)
        if ("error" in pushed) {
          return yield* Effect.fail(new IntegrationError("delivery-failed", pushed.error, { retryable: false }))
        }
        const github = GitHub.client(options.environment ?? {})
        const info = yield* GitHub.repository(github, payload.github)
        const opened = yield* GitHub.pullOnce(github, payload.github, {
          head: payload.applied.branch,
          base: info.default_branch,
          title: line(payload.title, 250),
          body: pullBody(payload, options.generatedDir)
        })
        yield* GitHub.addLabels(github, payload.github, opened.number, ["organization", GitHub.claimLabel(payload.lead)])
        return { number: opened.number, url: opened.url }
      }).pipe(Effect.mapError(fromIntegrationError)), { implementationVersion: "publish-change/v1" }),
    DisposeWorkspaces.toLayer(({ workspaces }) =>
      Effect.flatMap(Workspace.Workspace, (service) =>
        Effect.forEach(
          workspaces.filter((workspace): workspace is Workspace.Prepared => workspace !== null),
          (workspace) => service.dispose(workspace),
          { discard: true }
        )), { implementationVersion: "dispose-workspaces/v1" }),
    WriteDocument.toLayer(({ answer, key, revision }) =>
      Effect.gen(function*() {
        const registry = yield* Authority.RosterRegistry
        const snapshot = yield* registry.get(revision)
        const profile = snapshot.roster.profiles.get(answer.principal)
        if (profile === undefined || !profile.grants.tools.includes("wiki-write")) {
          return { written: false, path: "", reason: `${answer.principal} holds no wiki-write` }
        }
        const path = yield* Effect.tryPromise({
          try: () =>
            atomicWrite(
              options.root,
              join(options.generatedDir, runDirectory(key), `${answer.principal}.md`),
              renderDocument(answer)
            ),
          catch: (cause) => new ReceiptFailed({ message: cause instanceof Error ? cause.message : String(cause) })
        })
        return { written: true, path, reason: "" }
      }), { implementationVersion: "write-document/v1" }),
    Decide.toLayer(({ build, check, checks, diff }) =>
      Effect.sync(() => {
        const findings: Array<string> = []
        if (!build.valid || build.result.status !== "done") findings.push(`The builder did not finish: ${describeResult(build)}`)
        if (diff.files.length === 0) findings.push("The workspace holds no change.")
        for (const receipt of checks.receipts) {
          if (receipt.exitCode !== 0) {
            findings.push(`Check ${receipt.name} ${receipt.timedOut ? "timed out" : `exited ${receipt.exitCode}`}: ${line(receipt.stderr.text || receipt.stdout.text, 400)}`)
          }
        }
        const verdicts = Object.values(check.result.fields).filter((value): value is string => typeof value === "string")
        const refused = verdicts.some((value) => negativeVerdict.test(value.trim()))
        if (!check.valid || check.result.status !== "done" || refused) findings.push(`${check.principal}: ${describeResult(check)}`)
        return {
          approved: findings.length === 0 && checks.passed,
          findings: lines(findings),
          checks: checks.receipts.map((receipt) => ({
            name: receipt.name,
            exitCode: receipt.exitCode,
            timedOut: receipt.timedOut,
            durationMs: receipt.durationMs,
            tail: tail(`${receipt.stdout.text}${receipt.stderr.text}`, 1_500)
          }))
        }
      }), { implementationVersion: "decide/v3" }),
    RenderReply.toLayer(({ speaker, text }) =>
      Effect.gen(function*() {
        const registry = yield* Authority.RosterRegistry
        const snapshot = yield* registry.current
        const profile = snapshot.roster.profiles.get(speaker)
        const trimmed = text.trim()
        return {
          text: trimmed === "" ? "Done." : trimmed.length <= 3_000 ? trimmed : `${trimmed.slice(0, 2_999)}…`,
          persona: { username: (profile?.name ?? (speaker === "" ? "Organization" : speaker)).slice(0, 80) }
        }
      }), { implementationVersion: "render-reply/v1" }),
    Describe.toLayer(({ failure }) =>
      Effect.sync(() => {
        const tag = failure._tag.split("/").at(-1) ?? failure._tag
        const detail = "reason" in failure ? failure.reason : "code" in failure ? String(failure.code) : undefined
        return { code: detail === undefined ? tag : `${tag}(${detail})`, message: line(failure.message, 1_000) }
      }), { implementationVersion: "describe-failure/v1" }),
    Settle.toLayer(({ receipt, report }) => {
      const settled = { ...report, receipt }
      return settled.status === "landed" || settled.status === "answered"
        ? Effect.succeed(settled)
        : Effect.fail(new DeliveryFailed({ status: settled.status, message: `${settled.status}: ${settled.summary}` }))
    }, { implementationVersion: "settle/v1" }),
    WriteStatus.toLayer(() =>
      Effect.tryPromise({
        try: async () => {
          const receipts = await readReceipts(options.root, options.generatedDir)
          const rows = receipts.slice(0, 50).map((receipt) =>
            `| ${receipt.at === 0 ? "" : new Date(receipt.at).toISOString()} | ${receipt.key} | ${receipt.status} | ${
              receipt.branch === undefined ? "" : `${receipt.branch} ${receipt.commit?.slice(0, 12) ?? ""}`
            } | ${line(receipt.summary, 200).replaceAll("|", "\\|")} |`
          )
          const content = [
            "# Status",
            "",
            `${receipts.length} deliveries.`,
            "",
            "| Admitted | Request | Status | Branch | Summary |",
            "| --- | --- | --- | --- | --- |",
            ...rows,
            ""
          ].join("\n")
          const path = await atomicWrite(options.root, options.statusFile, content)
          return { path, deliveries: receipts.length }
        },
        catch: (cause) => new StatusFailed({ message: cause instanceof Error ? cause.message : String(cause) })
      }), { implementationVersion: "write-status/v1" })
  )
