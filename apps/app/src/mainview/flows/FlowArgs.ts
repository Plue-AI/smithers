import { fileArgs } from "./FileArgs"
/*
 * The button door's one serialisation: a flow's typed input as the single
 * slash line its grammar parses.
 *
 * Every card used to hand-serialise its own act — `${repoId} ${workspace}
 * ${label}`, `${changeId} ${from} ${to} ${file.path}`, `${snapshot.id}
 * ${workspaceId} --name ${snapshot.name}` — so each card carried a private
 * copy of one grammar from SlashPayload.ts, and a value holding a space was
 * parsed by whatever that copy happened to do. The encoders live here instead:
 * one per flow, beside the grammar they invert, with FlowArgs.test.ts holding
 * the two to each other. A card names its flow and hands over the values.
 *
 * Only the flows whose acts carry STRUCTURE are here. A flow whose whole
 * argument is one id stays `onRunCommand(name, id)`, and the slash door still
 * hands the line a human typed straight through.
 */

import type { SetupManualRequest } from "@smthrs/rpc/RepositorySetup"

/** The typed input of every flow a card raises with structured values. */
export interface FlowInput {
  readonly "agent.session.view": { readonly sessionId: string; readonly repo: string }
  readonly "agent.session.stop": { readonly sessionId: string; readonly repo: string }
  readonly "github.mirror.retry-ref": { readonly ref: string; readonly repo?: string }
  readonly "commits.read": { readonly ref: string; readonly repo: string }
  readonly "runs.trace.view": { readonly runId: string; readonly view: "turns" | "timeline" | "graph" | "steps" }
  readonly "runs.trace.filter": { readonly runId: string; readonly filter: string }
  readonly "runs.graph.follow": { readonly runId: string; readonly follow: boolean }
  readonly "runs.coding.select": { readonly runId: string; readonly changeId: string }
  readonly "signup.set": { readonly field: string; readonly value: string }
  readonly "wiki.cloud": { readonly repo: string; readonly page: number }
  readonly "wiki.cloud.open": { readonly slug: string; readonly repo: string }
  readonly "wiki.card.select": { readonly cardId: string; readonly documentId: string }
  readonly "wiki.card.view": { readonly cardId: string; readonly view: string }
  readonly "prs.land": { readonly number: number; readonly repo: string }
  readonly "prs.review": { readonly number: number; readonly verdict: "approve" | "request-changes" | "comment"; readonly repo: string }

  readonly "box.open": { readonly bookmark?: string; readonly repo: string; readonly kind: "container" | "vm" | "desktop" }
  readonly "box.egress": { readonly workspaceId: string; readonly cursor?: string }
  readonly "box.session.destroy": { readonly sessionId: string; readonly workspaceId: string }
  readonly "box.delete": { readonly workspaceId: string; readonly confirmName: string }

  readonly "change.split": { readonly changeId: string; readonly paths: ReadonlyArray<string> }
  readonly "change.checks": { readonly changeId: string; readonly seq: number }
  readonly "runs.seat": { readonly runId: string; readonly seat: string }
  readonly "runs.tools": { readonly runId: string; readonly toolNames: string }
  readonly "runs.thinking": { readonly runId: string; readonly thinking: string }
  readonly "flow.run.stop-all": { readonly sourceCard: string; readonly repo: string }
  readonly "commits.list": { readonly branch: string; readonly repo: string }
  readonly "box.facet": { readonly workspaceId: string; readonly facet: string }
  readonly "secrets.move": { readonly id: string; readonly direction: "up" | "down" }
  readonly "history.parallel": { readonly value: number; readonly repo: string }
  readonly "history.retry": { readonly id: string; readonly repo: string }
  readonly "issues.close": { readonly number: number; readonly repo: string }
  readonly "issues.fix": { readonly number: number; readonly repo: string }
  readonly "issues.verify": { readonly number: number; readonly repo: string }
  readonly "issues.comment.react": { readonly number: number; readonly repo?: string; readonly commentId: number; readonly name: string; readonly active: boolean }
  readonly "issues.comment.retry": { readonly cardId: string; readonly requestId: string }
  readonly "issues.set": { readonly number: number; readonly repo: string; readonly field: "owner" | "due" | "priority" | "parent"; readonly value: string }
  readonly "integrations.list": { readonly repo: string }
  readonly "issues.reopen": { readonly number: number; readonly repo: string }
  readonly "findings.please-fix": { readonly changeId: string; readonly findingId: number }
  readonly "findings.not-useful": { readonly changeId: string; readonly findingId: number }
  readonly "review.unrequest": { readonly changeId: string; readonly requestId: number }
  readonly "review.request": { readonly changeId: string; readonly reviewer: string }
  readonly "review.done": { readonly changeId: string; readonly threadId: number }
  readonly "review.ack": { readonly changeId: string; readonly threadId: number }
  readonly "review.reopen": { readonly changeId: string; readonly threadId: number }

  readonly "app.experimental": { readonly on: boolean }
  readonly "experimental.set": { readonly cardId: string; readonly key: string; readonly value: string }
  readonly "runs.graph.select": { readonly runId: string; readonly nodeId?: string }
  readonly "flow.plan.select": { readonly cardId: string; readonly nodeId?: string }
  readonly "runs.graph.tab": { readonly runId: string; readonly tab: "declaration" | "code" | "output" | "events" | "attempts" }
  readonly "flow.plan.tab": { readonly cardId: string; readonly tab: "declaration" | "code" | "output" | "events" | "attempts" }
  readonly "issues.list": { readonly filter?: "open" | "closed" | "all"; readonly repo?: string; readonly kind?: "all" | "conversation" | "issue" }
  readonly "setup.configure": { readonly cardId: string; readonly field: string; readonly value: unknown }
  readonly "setup.view": { readonly cardId: string; readonly view: "flows" | "prompts" | "checks" | "evals" | "test" | "work"; readonly step?: string }
  readonly "setup.work": { readonly cardId: string; readonly stepId: string; readonly field?: "prompt" | "source" | "number"; readonly value?: unknown }
  readonly "setup.run": { readonly cardId: string; readonly operation: "inspect" | "evaluate" | "trial" | "apply" | "pause" | "run"; readonly manual?: SetupManualRequest }
  /** A saved registration draft; JSON input must survive the retry door verbatim. */
  readonly "triggers.register": { readonly repo: string; readonly flow: string; readonly slug: string; readonly schedule: string; readonly input: string; readonly tokens?: number; readonly minutes?: number }
  /** `<name> [owner/repo]` — a schedule's name holds no whitespace, so the repository trails it. */
  readonly "triggers.resume": { readonly slug: string; readonly repo?: string }
  readonly "triggers.run": { readonly slug: string; readonly repo?: string }
  /** Carried as JSON: `triggers.pause` declares `grammar: carried(...)`, which reads one object and refuses a positional line. */
  readonly "triggers.pause": { readonly slug: string; readonly repo?: string }
  readonly "wiki.heading": { readonly line: string; readonly cardId?: string }
  readonly "box.desktop.open": { readonly bookmark?: string; readonly repo: string }
  readonly "billing.upgrade": { readonly plan: string }
  readonly "runs.list": { readonly repo?: string; readonly status?: string; readonly flow?: string; readonly lineage?: string; readonly sourceCard?: string }
  readonly "runs.attention": { readonly repo?: string; readonly sourceCard?: string }
  readonly "runs.open": { readonly runId: string; readonly repo?: string; readonly sourceCard?: string; readonly requestId?: string }
  readonly "runs.trace.select": { readonly runId: string; readonly nodeId: string; readonly seq?: number; readonly sourceCard?: string }
  readonly "approvals.open": { readonly runId: string; readonly sourceCard?: string }
  readonly "tutorial.live.inspect": { readonly cardId: string; readonly eventId: string }
  readonly "files.open-diff": { readonly cardId: string; readonly path: string }
  readonly "issues.view": { readonly number: number; readonly repo?: string; readonly source?: "smithers-cloud" | "github" }
  readonly "prs.view": { readonly number: number; readonly repo?: string }
  readonly "prs.tab": { readonly cardId: string; readonly tab: "conversation" | "commits" | "checks" | "files" }
  readonly "issue.flows": { readonly number: number; readonly repo?: string }
  readonly "issue.repro": { readonly number: number; readonly repo?: string }
  readonly "issue.poc": { readonly number: number; readonly repo?: string }
  readonly "issue.implement": { readonly number: number; readonly repo?: string }
  readonly "prs.triage": { readonly number: number; readonly repo?: string }
  readonly "issue.add-flow": { readonly number: number; readonly repo?: string; readonly description?: string }
  /** Carried as JSON: a Markdown comment holds newlines, indentation and fences, and its repository need not be loaded. */
  readonly "issues.comment": { readonly number: number; readonly text: string; readonly repo?: string }

  /** Source-qualified launch uses the existing plan/approval/run path. */
  readonly "flow.run": {
    readonly name: string
    readonly repo?: string
    readonly sourceCard?: string
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
  readonly "runs.steer": { readonly runId: string; readonly body: string }
  /** `<seat> <name|default>` — neither a seat nor a model name holds whitespace. */
  readonly "model.assign": { readonly seat: string; readonly recordId: string }
  /** The composer's edits (controller/modelCall.ts) ride as JSON: a prompt holds newlines and quotes. */
  readonly "model.prompt": { readonly id: string; readonly system?: string; readonly prompt?: string; readonly maxTokens?: number; readonly temperature?: string }
  readonly "model.state": { readonly id: string; readonly key?: string; readonly kind?: string; readonly value?: string; readonly was?: string; readonly remove?: boolean }
  readonly "model.question": { readonly id: string; readonly question?: string; readonly type?: string; readonly instructions?: string; readonly criteria?: unknown; readonly was?: string; readonly remove?: boolean }
  readonly "model.option": { readonly id: string; readonly question: string; readonly option?: string; readonly about?: string; readonly was?: string; readonly remove?: boolean }

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
  "commits.read": payload => line(token(payload, "ref"), token(payload, "repo")),
  "runs.trace.view": payload => line(token(payload, "runId"), token(payload, "view")),
  "runs.trace.filter": payload => line(token(payload, "runId"), token(payload, "filter")),
  "runs.graph.follow": payload => line(token(payload, "runId"), payload.follow ? "on" : "off"),
  "runs.coding.select": payload => line(token(payload, "runId"), token(payload, "changeId")),
  "signup.set": payload => `${payload.field} ${payload.value}`,
  "wiki.cloud": payload => line(token(payload, "repo"), token(payload, "page")),
  "wiki.cloud.open": payload => line(token(payload, "slug"), token(payload, "repo")),
  "wiki.card.select": payload => fileArgs(String(payload.cardId), String(payload.documentId)),
  "wiki.card.view": payload => line(token(payload, "cardId"), token(payload, "view")),
  "prs.land": payload => line(token(payload, "number"), token(payload, "repo")),
  "prs.review": payload => JSON.stringify(payload),
  "github.mirror.retry-ref": payload => JSON.stringify(payload),

  "box.open": payload => JSON.stringify(payload),
  "box.egress": payload => line(token(payload, "workspaceId"), token(payload, "cursor")),
  "box.session.destroy": payload => line(token(payload, "sessionId"), token(payload, "workspaceId")),
  "box.delete": payload => line(token(payload, "workspaceId"), token(payload, "confirmName")),

  "change.split": payload => fileArgs(String(payload.changeId), ...(payload.paths as ReadonlyArray<string>)),
  "change.checks": payload => line(token(payload, "changeId"), token(payload, "seq")),
  "agent.session.view": payload => line(token(payload, "sessionId"), token(payload, "repo")),
  "agent.session.stop": payload => line(token(payload, "sessionId"), token(payload, "repo")),
  "runs.seat": payload => line(token(payload, "runId"), token(payload, "seat")),
  "runs.tools": payload => line(token(payload, "runId"), token(payload, "toolNames")),
  "runs.thinking": payload => line(token(payload, "runId"), token(payload, "thinking")),
  "flow.run.stop-all": payload => line(keyed(payload, "sourceCard"), token(payload, "repo")),
  "history.parallel": payload => line(token(payload, "value"), token(payload, "repo")),
  "history.retry": payload => line(token(payload, "id"), token(payload, "repo")),
  "commits.list": payload => line(token(payload, "branch"), token(payload, "repo")),
  "box.facet": payload => line(token(payload, "workspaceId"), token(payload, "facet")),
  "secrets.move": payload => line(token(payload, "id"), token(payload, "direction")),
  "issues.close": payload => line(token(payload, "number"), token(payload, "repo")),
  "issues.fix": payload => line(token(payload, "number"), token(payload, "repo")),
  "issues.verify": payload => line(token(payload, "number"), token(payload, "repo")),
  "issues.comment.react": payload => JSON.stringify(payload),
  "issues.comment.retry": payload => JSON.stringify(payload),
  "issues.set": payload => JSON.stringify(payload),
  "integrations.list": payload => line(token(payload, "repo")),
  "issues.reopen": payload => line(token(payload, "number"), token(payload, "repo")),
  "findings.please-fix": payload => line(token(payload, "changeId"), token(payload, "findingId")),
  "findings.not-useful": payload => line(token(payload, "changeId"), token(payload, "findingId")),
  "review.unrequest": payload => line(token(payload, "changeId"), token(payload, "requestId")),
  "review.request": payload => line(token(payload, "changeId"), token(payload, "reviewer")),
  "review.done": payload => line(token(payload, "changeId"), token(payload, "threadId")),
  "review.ack": payload => line(token(payload, "changeId"), token(payload, "threadId")),
  "review.reopen": payload => line(token(payload, "changeId"), token(payload, "threadId")),

  "app.experimental": payload => payload.on ? "on" : "off",
  "experimental.set": payload => JSON.stringify(payload),
  "runs.graph.select": payload => graphLine(payload, "runId", "nodeId"),
  "flow.plan.select": payload => graphLine(payload, "cardId", "nodeId"),
  "runs.graph.tab": payload => graphLine(payload, "runId", "tab"),
  "flow.plan.tab": payload => graphLine(payload, "cardId", "tab"),
  "issues.list": (payload) => line(token(payload, "filter") ?? "open", payload.kind === undefined || payload.kind === "all" ? undefined : `--kind ${payload.kind}`, token(payload, "repo")),
  "setup.configure": payload => JSON.stringify(payload),
  "setup.view": payload => JSON.stringify(payload),
  "setup.run": payload => JSON.stringify(payload),
  "setup.work": payload => JSON.stringify(payload),
  "billing.upgrade": (payload) => line(token(payload, "plan")),
  "runs.list": (payload) => JSON.stringify(payload),
  "runs.attention": (payload) => line(keyed(payload, "sourceCard"), token(payload, "repo")),
  "runs.open": (payload) => line(keyed(payload, "sourceCard"), keyed(payload, "requestId"), token(payload, "runId"), token(payload, "repo")),
  "runs.trace.select": (payload) => line(keyed(payload, "sourceCard"), token(payload, "runId"), token(payload, "nodeId"), token(payload, "seq")),
  "approvals.open": (payload) => line(keyed(payload, "sourceCard"), token(payload, "runId")),
  "tutorial.live.inspect": (payload) => line(token(payload, "cardId"), token(payload, "eventId")),
  "files.open-diff": (payload) => JSON.stringify(payload),
  "issues.view": (payload) => line(token(payload, "number"), token(payload, "repo"), payload.source ? `--source ${payload.source}` : undefined),
  "prs.view": (payload) => line(token(payload, "number"), token(payload, "repo")),
  "prs.tab": (payload) => line(token(payload, "cardId"), token(payload, "tab")),
  "issue.flows": (payload) => line(token(payload, "number"), token(payload, "repo")),
  "issue.repro": (payload) => line(token(payload, "number"), token(payload, "repo")),
  "issue.poc": (payload) => line(token(payload, "number"), token(payload, "repo")),
  "issue.implement": (payload) => line(token(payload, "number"), token(payload, "repo")),
  "prs.triage": (payload) => line(token(payload, "number"), token(payload, "repo")),
  "issue.add-flow": (payload) => JSON.stringify(payload),
  "issues.comment": (payload) => JSON.stringify(payload),
  "flow.run": (payload) => line(keyed(payload, "sourceCard"), token(payload, "name"), token(payload, "repo"),
    payload.input === undefined ? undefined : JSON.stringify(payload.input)),
  "flow.plan": (payload) => line(keyed(payload, "sourceCard"), keyed(payload, "against"), token(payload, "name"), token(payload, "repo"),
    payload.input === undefined ? undefined : JSON.stringify(payload.input)),
  "change.diff": (payload) => line(token(payload, "changeId"), token(payload, "from"), token(payload, "to"), token(payload, "path")),
  "change.pins": (payload) => line(token(payload, "changeId"), token(payload, "from"), token(payload, "to")),
  "change.facet": (payload) => line(token(payload, "changeId"), token(payload, "facet")),
  "change.resolve": (payload) => line(token(payload, "changeId"), token(payload, "path")),
  "form.set": (payload) => line(token(payload, "cardId"), token(payload, "field"), token(payload, "value")),
  "runs.steer": (payload) => line(token(payload, "runId"), token(payload, "body")),
  "model.assign": (payload) => line(token(payload, "seat"), token(payload, "recordId")),
  "model.prompt": (payload) => JSON.stringify(payload),
  "model.state": (payload) => JSON.stringify(payload),
  "model.question": (payload) => JSON.stringify(payload),
  "model.option": (payload) => JSON.stringify(payload),
  "triggers.register": payload => JSON.stringify({ ...payload,
    ...(payload.tokens === undefined ? {} : { tokens: String(payload.tokens) }),
    ...(payload.minutes === undefined ? {} : { minutes: String(payload.minutes) }) }),
  "triggers.resume": (payload) => line(token(payload, "slug"), token(payload, "repo")),
  "triggers.run": (payload) => line(token(payload, "slug"), token(payload, "repo")),
  "triggers.pause": (payload) => JSON.stringify(payload),
  "wiki.heading": (payload) => line(token(payload, "line"), token(payload, "cardId")),
  "box.desktop.open": (payload) => JSON.stringify(payload),

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

export const graphSelectArgs = (doors: { readonly select: "runs.graph.select" | "flow.plan.select"; readonly target: string }, nodeId?: string): string =>
  doors.select === "runs.graph.select"
    ? flowArgs(doors.select, { runId: doors.target, ...(nodeId === undefined ? {} : { nodeId }) })
    : flowArgs(doors.select, { cardId: doors.target, ...(nodeId === undefined ? {} : { nodeId }) })

export const graphTabArgs = (doors: { readonly tab: "runs.graph.tab" | "flow.plan.tab"; readonly target: string }, tab: FlowInput["flow.plan.tab"]["tab"]): string =>
  doors.tab === "runs.graph.tab"
    ? flowArgs(doors.tab, { runId: doors.target, tab })
    : flowArgs(doors.tab, { cardId: doors.target, tab })
