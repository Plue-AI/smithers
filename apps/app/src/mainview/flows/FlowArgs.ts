import { publicSecretInput } from "./SecretPayload"
import { fileArgs } from "@smthrs/rpc/FileRead"

/** The typed input of every flow a card raises with structured values. */
export interface FlowInput {
  readonly "runs": NonNullable<import("@smthrs/rpc/CardAction").CardCommandInput["runs"]>
  readonly "github": NonNullable<import("@smthrs/rpc/CardAction").CardCommandInput["github"]>
  readonly "background.retry": { readonly id: string }
  readonly "background.dismiss": { readonly id: string }
  readonly "approval.approve": { readonly cardId: string }
  readonly "approval.deny": { readonly cardId: string }
  readonly "flow": { readonly name: string }
  readonly "wiki.save": { readonly name?: string; readonly text?: string }
  readonly "todo.drop": { readonly n: number }
  readonly "branch.bring-in": { readonly branch: string; readonly id: string; readonly revision: string }
  readonly "branch.discard-foreign": { readonly branch: string; readonly id: string; readonly revision: string }
  readonly "file": { readonly path: string; readonly branch?: string; readonly line?: number; readonly revision?: string; readonly column?: number; readonly repo?: string; readonly ref?: string; readonly operation?: "repository" }

 readonly "model.assign": { readonly role: string; readonly model?: string }
  readonly "run.inspect": { readonly id?: string; readonly branch?: string; readonly answer?: string }
  readonly "debug-api": import("../state/seams/DebugApiSeam").DebugApiInput
  readonly "docs": { readonly page?: string; readonly mode?: "read" }
  readonly "box.open": { readonly bookmark?: string; readonly repo: string; readonly kind?: "container" | "vm"; readonly snapshot?: string; readonly recoveryOf?: string }
  readonly "flow.new": { readonly description: string; readonly repo: string }
  readonly "file.compare": { readonly path: string }
  readonly "file.restore-deleted": { readonly path: string }
  readonly "file.follow-rename": { readonly path: string }
  readonly "file.reapply": { readonly path: string }
  readonly "github.mirror.retry-ref": { readonly ref: string; readonly repo?: string }
  readonly "runs.trace.view": { readonly runId: string; readonly sourceCard?: string; readonly view: "turns" | "timeline" | "graph" | "steps" | "devtools"; readonly state?: { readonly selected?: string; readonly at?: number; readonly tab?: string } }
  readonly "runs.trace.filter": { readonly runId: string; readonly filter: string }
  readonly "runs.signal": { readonly runId: string; readonly name: string; readonly payload?: string }
  readonly "runs.graph.follow": { readonly runId: string; readonly follow: boolean }
  readonly "runs.graph.execution": { readonly runId: string; readonly executionId?: string }
  readonly "runs.continue": { readonly runId: string; readonly requestId: string }
  readonly "runs.coding.select": { readonly runId: string; readonly changeId: string }
  readonly "auth.email": { readonly email: string }
  readonly "wiki.cloud": { readonly repo: string; readonly page: number; readonly space?: "public" | "private" }
  readonly "wiki.cloud.open": { readonly slug: string; readonly repo: string; readonly space?: "public" | "private" }
  readonly "wiki.space": { readonly space: "public" | "private"; readonly repo?: string }
  readonly "wiki.view": { readonly view: "read" | "edit" }
  readonly "wiki.cloud.rename": { readonly slug?: string; readonly path: string; readonly repo?: string }
  readonly "wiki.cloud.delete": { readonly slug: string; readonly repo?: string }
  readonly "wiki.history": { readonly slug: string; readonly repo?: string; readonly page?: number; readonly space?: "public" | "private" }
  readonly "wiki.attach": { readonly path?: string; readonly repo?: string }
  readonly "wiki.card.select": { readonly cardId: string; readonly documentId: string }
  readonly "wiki.card.view": { readonly cardId: string; readonly view: string }
  readonly "prs.review": { readonly number: number; readonly verdict: "approve" | "request-changes" | "comment"; readonly repo: string }

  readonly "box.egress": { readonly workspaceId: string; readonly cursor?: string }
  readonly "egress.allow": { readonly host: string; readonly repo: string }
  readonly "box.session.destroy": { readonly sessionId: string; readonly workspaceId: string }
  readonly "box.delete": { readonly workspaceId: string; readonly confirmName: string }
  readonly "change.checks": { readonly changeId: string; readonly seq: number }
  readonly "flow.run.stop-all": { readonly sourceCard: string; readonly repo: string }
  readonly "box.facet": { readonly workspaceId: string; readonly facet: string }
  readonly "secrets": NonNullable<import("@smthrs/rpc/CardAction").CardCommandInput["secrets"]>
  readonly "issues.close": { readonly number: number; readonly repo: string }
  readonly "issues.reopen": { readonly number: number; readonly repo: string }
  readonly "findings.please-fix": { readonly changeId: string; readonly findingId: number }
  readonly "findings.not-useful": { readonly changeId: string; readonly findingId: number }
  readonly "review.unrequest": { readonly changeId: string; readonly requestId: number }
  readonly "review.request": { readonly changeId: string; readonly reviewer: string }
  readonly "review.done": { readonly changeId: string; readonly threadId: number }
  readonly "review.ack": { readonly changeId: string; readonly threadId: number }
  readonly "review.reopen": { readonly changeId: string; readonly threadId: number }

  readonly "runs.graph.select": { readonly runId: string; readonly nodeId?: string }
  readonly "flow.plan.select": { readonly cardId: string; readonly nodeId?: string }
  readonly "runs.graph.tab": { readonly runId: string; readonly tab: "in" | "declaration" | "code" | "output" | "events" | "attempts" }
  readonly "flow.plan.tab": { readonly cardId: string; readonly tab: "in" | "declaration" | "code" | "output" | "events" | "attempts" }
  readonly "issues.list": { readonly filter?: "open" | "closed" | "all"; readonly repo?: string; readonly kind?: "all" | "conversation" | "issue"; readonly view?: string }
  /** A saved registration draft; JSON input must survive the retry door verbatim. */
  readonly "triggers.register": { readonly repo: string; readonly flow: string; readonly slug?: string; readonly schedule?: string; readonly input?: string; readonly tokens?: number; readonly minutes?: number }
  /** `<name> [owner/repo]` — a schedule's name holds no whitespace, so the repository trails it. */
  readonly "triggers.resume": { readonly slug: string; readonly repo?: string }
  readonly "triggers.run": { readonly slug: string; readonly repo?: string }
  /** Carried as JSON: `triggers.pause` declares `grammar: carried(...)`, which reads one object and refuses a positional line. */
  readonly "triggers.pause": { readonly slug: string; readonly repo?: string }
  /** Carried as JSON like `triggers.pause`: the Home OK button carries the order and the revision it saw (#3452). */
  readonly "order.ok": { readonly id: string; readonly revision: number }
  readonly "wiki.heading": { readonly line: string; readonly cardId?: string }
  readonly "billing.upgrade": { readonly plan: string }
  readonly "runs.list": { readonly repo?: string; readonly status?: string; readonly flow?: string; readonly lineage?: string; readonly sourceCard?: string }
  readonly "runs.open": { readonly runId: string; readonly repo?: string; readonly sourceCard?: string; readonly requestId?: string }
  readonly "runs.trace.select": { readonly runId: string; readonly nodeId: string; readonly seq?: number; readonly sourceCard?: string }
  readonly "tutorial.live.inspect": { readonly cardId: string; readonly eventId: string }
  readonly "files.open-diff": { readonly cardId: string; readonly path: string }
  readonly "issues.view": { readonly number: number; readonly repo?: string; readonly source?: "smithers-cloud" | "github" }
  readonly "prs.view": { readonly number: number; readonly repo?: string }
  readonly "prs.tab": { readonly cardId: string; readonly tab: "conversation" | "commits" | "checks" | "files" }
  readonly "issue.flows": { readonly number: number; readonly repo?: string }
  readonly "issue.repro": { readonly number: number; readonly repo?: string }
  readonly "issue.poc": { readonly number: number; readonly repo?: string }
  readonly "todo.from-issue": { readonly number: number; readonly repo?: string }
  readonly "review": { readonly number: number; readonly repo?: string }
  readonly "issue.add-flow": { readonly number: number; readonly repo?: string; readonly description?: string }
  /** Carried as JSON: a Markdown comment holds newlines, indentation and fences, and its repository need not be loaded. */
  readonly "issues.comment": { readonly number: number; readonly text: string; readonly repo?: string }

  /** Source-qualified launch uses the existing plan/approval/run path. */
  readonly "flow.run": {
    readonly name: string
    readonly repo?: string
    readonly sourceCard?: string
    readonly workspaceId?: string
    readonly input?: Readonly<Record<string, unknown>>
  }
  /** The same address as a launch, stopping at the plan. */
  readonly "flow.plan": {
    readonly name: string
    readonly repo?: string
    readonly sourceCard?: string
    readonly against?: string
    readonly input?: Readonly<Record<string, unknown>>
  }
  /** `<changeId> [from] [to] [path]` — the path is the rest of the line, so it may hold a space. */
  readonly "change.diff": {
    readonly changeId: string
    readonly from?: string
    readonly to?: string
    readonly path?: string
  }
  /** `<changeId> <from> <to>` — a revision pin never holds whitespace. */
  readonly "change.pins": { readonly changeId: string; readonly from: string; readonly to: string }
  readonly "change.facet": { readonly changeId: string; readonly facet: string }
  /** `<changeId> <path>` — the path is the rest of the line. */
  readonly "change.resolve": { readonly changeId: string; readonly path: string }
  /** `<cardId> <field> [value]` — a blank value clears the field (THE FORM LAW). */
  readonly "form.set": { readonly cardId: string; readonly field: string; readonly value: string }
  /** `<runId> <body>` — the body is the rest of the line. */

}

/** A flow whose input the card seam hands over as values rather than as a line. */
export type FlowWithInput = keyof FlowInput

type Payload = Readonly<Record<string, unknown>>

/** A value as one token; absent when it is missing or blank, which is what every optional tail means. */
const token = (payload: Payload, key: string): string | undefined => {
  const value = payload[key]
  if (value === undefined || value === null) return undefined
  const text = String(value).trim()
  return text === "" ? undefined : text
}

/**
 * `key=value` for a facet the caller named, including an EMPTY one: the
 * targets table clears a filter by giving it blank, which is not the same act
 * as leaving it alone.
 */
const keyed = (payload: Payload, key: string): string | undefined => {
  const value = payload[key]
  return value === undefined || value === null ? undefined : `${key}=${String(value).trim()}`
}

/** The present parts as one line. */
const line = (...parts: ReadonlyArray<string | undefined>): string =>
  parts.filter((part): part is string => part !== undefined && part !== "").join(" ")

/** Keep the human shorthand where lossless; JSON carries arbitrary engine IDs. */
const graphLine = (payload: Payload, target: string, value: string): string => {
  const parts = [payload[target], payload[value]].filter((part): part is string => typeof part === "string")
  return parts.some(part => /\s|["{}]/.test(part) || part.length === 0)
    ? JSON.stringify(payload) : parts.join(" ")
}

/**
 * One encoder per flow, in the shape its grammar reads. A tail that may hold
 * whitespace (a path, a label, a message, a template name) is always LAST, or
 * behind the `--name` flag, because that is where the grammar takes the rest
 * of the line.
 */
const ENCODERS: { readonly [N in FlowWithInput]: (payload: Payload) => string } = {
  "background.retry": payload => token(payload, "id")!,
  "background.dismiss": payload => token(payload, "id")!,
  "approval.approve": payload => token(payload, "cardId")!,
  "approval.deny": payload => token(payload, "cardId")!,
  "flow": payload => JSON.stringify(payload),
  "branch.bring-in": payload => JSON.stringify(payload),
  "branch.discard-foreign": payload => JSON.stringify(payload),
  "todo.drop": payload => JSON.stringify(payload),
  "wiki.save": payload => JSON.stringify(payload),
  "file": (payload) => payload.branch !== undefined || payload.revision !== undefined || payload.operation !== undefined ? JSON.stringify(payload) : fileArgs(
    [payload.path, payload.line, payload.column].filter((value) => value !== undefined).join(":"),
    payload.repo as string | undefined,
    ...(payload.ref === undefined ? [] : ["--ref", String(payload.ref)])
  ),
  "model.assign": payload => JSON.stringify(payload),
  "flow.new": payload => JSON.stringify(payload),
  "runs.trace.view": payload => payload.state !== undefined || payload.sourceCard !== undefined ? JSON.stringify(payload) : line(token(payload, "runId"), token(payload, "view")),
  "runs.trace.filter": payload => line(token(payload, "runId"), token(payload, "filter")),
  "runs.signal": payload => line(token(payload, "runId"), token(payload, "name"), typeof payload.payload === "string" ? payload.payload : undefined),
  "runs.graph.follow": payload => line(token(payload, "runId"), payload.follow ? "on" : "off"),
  "runs.graph.execution": payload => line(token(payload, "runId"), token(payload, "executionId")),
  "runs.continue": payload => line(token(payload, "runId"), token(payload, "requestId")),
  "runs.coding.select": payload => line(token(payload, "runId"), token(payload, "changeId")),
  "auth.email": payload => line(token(payload, "email")),
  "wiki.cloud": payload => line(token(payload, "repo"), token(payload, "page"), payload.space === undefined ? undefined : `--space ${String(payload.space)}`),
  "wiki.cloud.open": payload => line(token(payload, "slug"), token(payload, "repo"), payload.space === undefined ? undefined : `--space ${String(payload.space)}`),
  "wiki.space": payload => line(token(payload, "space"), token(payload, "repo")),
  "wiki.view": payload => line(token(payload, "view")),
  "wiki.cloud.rename": payload => line(token(payload, "slug"), token(payload, "path"), token(payload, "repo")),
  "wiki.cloud.delete": payload => line(token(payload, "slug"), token(payload, "repo")),
  "wiki.history": payload => line(token(payload, "slug"), token(payload, "page"), token(payload, "repo"), payload.space === undefined ? undefined : `--space ${String(payload.space)}`),
  "wiki.attach": payload => line(token(payload, "path"), token(payload, "repo")),
  "wiki.card.select": payload => fileArgs(String(payload.cardId), String(payload.documentId)),
  "wiki.card.view": payload => line(token(payload, "cardId"), token(payload, "view")),
  "prs.review": payload => JSON.stringify(payload),
  "github.mirror.retry-ref": payload => JSON.stringify(payload),

  "box.open": payload => JSON.stringify(payload),
  "box.egress": payload => line(token(payload, "workspaceId"), token(payload, "cursor")),
  "egress.allow": payload => line(token(payload, "host"), token(payload, "repo")),
  "box.session.destroy": payload => line(token(payload, "sessionId"), token(payload, "workspaceId")),
  "box.delete": payload => line(token(payload, "workspaceId"), token(payload, "confirmName")),
  "change.checks": payload => line(token(payload, "changeId"), token(payload, "seq")),
  "flow.run.stop-all": payload => line(keyed(payload, "sourceCard"), token(payload, "repo")),
  "box.facet": payload => line(token(payload, "workspaceId"), token(payload, "facet")),
  "runs": payload => JSON.stringify(payload),
  "github": payload => JSON.stringify(payload),
  "secrets": payload => JSON.stringify(publicSecretInput(payload)),
  "issues.close": payload => line(token(payload, "number"), token(payload, "repo")),
  "issues.reopen": payload => line(token(payload, "number"), token(payload, "repo")),
  "findings.please-fix": payload => line(token(payload, "changeId"), token(payload, "findingId")),
  "findings.not-useful": payload => line(token(payload, "changeId"), token(payload, "findingId")),
  "review.unrequest": payload => line(token(payload, "changeId"), token(payload, "requestId")),
  "review.request": payload => line(token(payload, "changeId"), token(payload, "reviewer")),
  "review.done": payload => line(token(payload, "changeId"), token(payload, "threadId")),
  "review.ack": payload => line(token(payload, "changeId"), token(payload, "threadId")),
  "review.reopen": payload => line(token(payload, "changeId"), token(payload, "threadId")),

  "runs.graph.select": payload => graphLine(payload, "runId", "nodeId"),
  "flow.plan.select": payload => graphLine(payload, "cardId", "nodeId"),
  "runs.graph.tab": payload => graphLine(payload, "runId", "tab"),
  "flow.plan.tab": payload => graphLine(payload, "cardId", "tab"),
  "issues.list": (payload) => line(token(payload, "filter") ?? "open", payload.kind === undefined || payload.kind === "all" ? undefined : `--kind ${payload.kind}`, token(payload, "view") === undefined ? undefined : `--view ${token(payload, "view")}`, token(payload, "repo")),
  "billing.upgrade": (payload) => line(token(payload, "plan")),
  "runs.list": (payload) => JSON.stringify(payload),
  "runs.open": (payload) => line(keyed(payload, "sourceCard"), keyed(payload, "requestId"), token(payload, "runId"), token(payload, "repo")),
  "runs.trace.select": (payload) => line(keyed(payload, "sourceCard"), token(payload, "runId"), token(payload, "nodeId"), token(payload, "seq")),
  "tutorial.live.inspect": (payload) => line(token(payload, "cardId"), token(payload, "eventId")),
  "files.open-diff": (payload) => JSON.stringify(payload),
  "debug-api": payload => JSON.stringify(payload),
  "docs": payload => payload.mode === "read" ? JSON.stringify(payload) : token(payload, "page") ?? "",
  "run.inspect": payload => JSON.stringify(payload),
  "file.compare": payload => JSON.stringify(payload),
  "file.restore-deleted": payload => JSON.stringify(payload),
  "file.follow-rename": payload => JSON.stringify(payload),
  "file.reapply": payload => JSON.stringify(payload),
  "issues.view": (payload) => line(token(payload, "number"), token(payload, "repo"), payload.source ? `--source ${payload.source}` : undefined),
  "prs.view": (payload) => line(token(payload, "number"), token(payload, "repo")),
  "prs.tab": (payload) => line(token(payload, "cardId"), token(payload, "tab")),
  "issue.flows": (payload) => line(token(payload, "number"), token(payload, "repo")),
  "issue.repro": (payload) => line(token(payload, "number"), token(payload, "repo")),
  "issue.poc": (payload) => line(token(payload, "number"), token(payload, "repo")),
  "todo.from-issue": (payload) => line(token(payload, "number"), token(payload, "repo")),
  "review": (payload) => line(token(payload, "number"), token(payload, "repo")),
  "issue.add-flow": (payload) => JSON.stringify(payload),
  "issues.comment": (payload) => JSON.stringify(payload),
  "flow.run": (payload) => payload.workspaceId !== undefined ? JSON.stringify(payload) : line(keyed(payload, "sourceCard"), token(payload, "name"), token(payload, "repo"),
    payload.input === undefined ? undefined : JSON.stringify(payload.input)),
  "flow.plan": (payload) => line(keyed(payload, "sourceCard"), keyed(payload, "against"), token(payload, "name"), token(payload, "repo"),
    payload.input === undefined ? undefined : JSON.stringify(payload.input)),
  "change.diff": (payload) => line(token(payload, "changeId"), token(payload, "from"), token(payload, "to"), token(payload, "path")),
  "change.pins": (payload) => line(token(payload, "changeId"), token(payload, "from"), token(payload, "to")),
  "change.facet": (payload) => line(token(payload, "changeId"), token(payload, "facet")),
  "change.resolve": (payload) => line(token(payload, "changeId"), token(payload, "path")),
  "form.set": (payload) => line(token(payload, "cardId"), token(payload, "field"), token(payload, "value")),
  "triggers.register": payload => JSON.stringify({ ...payload,
    ...(payload.tokens === undefined ? {} : { tokens: String(payload.tokens) }),
    ...(payload.minutes === undefined ? {} : { minutes: String(payload.minutes) }) }),
  "triggers.resume": (payload) => line(token(payload, "slug"), token(payload, "repo")),
  "triggers.run": (payload) => line(token(payload, "slug"), token(payload, "repo")),
  "triggers.pause": (payload) => JSON.stringify(payload),
  "order.ok": (payload) => JSON.stringify(payload),
  "wiki.heading": (payload) => line(token(payload, "line"), token(payload, "cardId")),

}

/**
 * One flow's typed input as the slash line its grammar parses.
 *
 * `payloadFor(name, flowArgs(name, input))` gives the input back — FlowArgs.test.ts
 * pins that for every flow here, including the values that hold a space.
 *
 * @category conversions
 */
export const flowArgs = <N extends FlowWithInput>(name: N, input: FlowInput[N]): string =>
  ENCODERS[name]({ ...input } as Payload)

/** True when `name` has a canonical line encoder here, so `flowArgs(name, …)` is defined. */
export const hasFlowArgs = (name: string): name is FlowWithInput => Object.hasOwn(ENCODERS, name)

export const graphSelectArgs = (doors: { readonly select: "runs.graph.select" | "flow.plan.select"; readonly target: string }, nodeId?: string): string =>
  doors.select === "runs.graph.select"
    ? flowArgs(doors.select, { runId: doors.target, ...(nodeId === undefined ? {} : { nodeId }) })
    : flowArgs(doors.select, { cardId: doors.target, ...(nodeId === undefined ? {} : { nodeId }) })

export const graphTabArgs = (doors: { readonly tab: "runs.graph.tab" | "flow.plan.tab"; readonly target: string }, tab: FlowInput["flow.plan.tab"]["tab"]): string =>
  doors.tab === "runs.graph.tab"
    ? flowArgs(doors.tab, { runId: doors.target, tab })
    : flowArgs(doors.tab, { cardId: doors.target, tab })
