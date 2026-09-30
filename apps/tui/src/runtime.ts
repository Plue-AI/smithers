/** Agent-facing runtime UI and delegation use the harness's existing flow catalog. */
import * as SmithersPlugin from "@smthrs/agent/SmithersPlugin"
import * as StandardFlows from "@smthrs/agent/StandardFlows"
import { Flow } from "@smthrs/flow"
import * as AgentEvent from "@smthrs/harness/AgentEvent"
import * as FlowBinding from "@smthrs/harness/FlowBinding"
import * as Sandbox from "@smthrs/harness/Sandbox"
import * as ModelRequest from "@smthrs/model/ModelRequest"
import { Node } from "@smthrs/plan"
import { Effect, Schema } from "effect"
import * as Agents from "./agents.ts"
import * as Extension from "./extension.ts"
import type { DelegateModel } from "./models.ts"
import type * as Monitors from "./monitors.ts"
import * as Panels from "./panels.ts"
import type { Vendor } from "./wrapped.ts"

export interface Ports {
  /** Throws a one-line refusal (`Contributions.Refusal`) when the contribution cannot be shown. */
  readonly publish: (contribution: Extension.Contribution) => void
  readonly delegate?: (
    request: {
      id: string
      title: string
      prompt: string
      model?: DelegateModel
      pinned?: boolean
      agent?: string
      harness?: Vendor
    }
  ) => unknown
  readonly wait?: (ids: ReadonlyArray<string>, signal?: AbortSignal) => Promise<unknown>
  /** `ask` (`ctx.help`): resolves with the answer of the parent agent or the person. */
  readonly ask?: (
    input: typeof StandardFlows.AskInput.Type,
    signal?: AbortSignal
  ) => Promise<typeof StandardFlows.AskOutput.Type>
  /** Answers an ask this agent holds. */
  readonly answer?: (id: string, answer: string) => unknown
  readonly read?: (id: string) => unknown
  readonly list?: () => unknown
  readonly retry?: (id: string) => unknown
  /** The user's flow runs, served to cells by the Smithers plugin. */
  readonly flows?: SmithersPlugin.Ports
  readonly monitors?: Pick<Monitors.Monitors, "create" | "list" | "stop">
}
/** Calls that wait on another agent or the person, unbounded. */
export const waiting: ReadonlyArray<string> = ["agent.wait", StandardFlows.askFlow.name]
/** Keeps every ordinary flow call bounded; only waiting calls hold a worker cell open. */
export const boundedBinding = (binding: FlowBinding.Binding, callMs: number): FlowBinding.Binding =>
  waiting.includes(binding.descriptor.name) ? binding : {
    ...binding,
    run: (call) =>
      binding.run(call).pipe(Effect.timeoutOrElse({
        duration: callMs,
        orElse: () => Effect.succeed(Sandbox.callTimedOut(call.flowName, callMs))
      }))
  }
/** Smithers flows and the TUI's ordinary per-call ceiling. */
export const plugins = (ports?: Ports, callMs?: number) => [
  SmithersPlugin.make(ports?.flows),
  ...(callMs === undefined ? [] : [{
    name: "tui-call-ceiling",
    apply: "harness" as const,
    hooks: {
      cellFlows: (bindings: ReadonlyArray<FlowBinding.Binding>) =>
        Effect.succeed(bindings.map((binding) => boundedBinding(binding, callMs)))
    }
  }])
]
const short = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(160))
/**
 * A thrown error's public text. A tagged error (`_tag`, optional `code`) keeps
 * its tag, so the cell reads `JevFailed (unreachable): ...` and not prose alone.
 */
export const publicError = (error: Error): string => {
  const { _tag: tag, code } = error as { _tag?: unknown; code?: unknown }
  if (typeof tag !== "string") return error.message
  return `${tag}${typeof code === "string" ? ` (${code})` : ""}: ${error.message}`
}
/**
 * One runtime flow. `Flow.make` only names it: its empty payload is never
 * decoded. `input` is the call's schema (`FlowBinding.make` decodes `flow.input`),
 * and it may be any schema, as `ui.publish` takes a union.
 */
const bind = <I extends Schema.Top & Schema.ConstraintDecoder<unknown, never>>(
  name: string,
  description: string,
  input: I,
  handle: (input: I["Type"], signal?: AbortSignal) => unknown,
  /** Consequential capabilities the approval gate asks for; see `Approvals.requests`. */
  capabilities: ReadonlyArray<string> = [],
  interruptible = false
): FlowBinding.Binding => {
  const flow = Flow.make(name, {
    description,
    payload: Schema.Struct({}),
    success: Schema.Unknown,
    body: () => Node.succeed(undefined)
  })
  return FlowBinding.make({
    flow: {
      ...flow,
      name: flow._tag,
      input,
      output: flow.successSchema,
      capabilities,
      effects: { reads: [], writes: [], tier: "irreversible", mode: "expected", onConflict: "serialize" }
    },
    handler: (input) => {
      // A typed refusal keeps its code: `unknown_agent: No agent named x`.
      const caught = (cause: unknown) =>
        cause instanceof Agents.AgentError
          ? new Error(`${cause.code}: ${cause.message}`)
          : cause instanceof Error
          ? cause
          : new Error("Runtime request failed")
      // Optional fields arrive as `undefined`, which a cell result cannot carry.
      const clean = (value: unknown) => JSON.parse(JSON.stringify(value ?? null)) as unknown
      if (interruptible) {
        return Effect.tryPromise({ try: async (signal) => clean(await handle(input, signal)), catch: caught })
      }
      return Effect.flatMap(Effect.try({ try: () => handle(input), catch: caught }), (value) =>
        value instanceof Promise
          ? Effect.tryPromise({ try: async () => clean(await value), catch: caught })
          : Effect.try({ try: () => clean(value), catch: caught }))
    },
    publicError
  })
}
/** What `ui.publish` accepts: `Extension.Contribution` or a bare panel; `Extension.decode` then applies every limit. */
const publishInput = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("panel"),
    placement: Schema.optional(Schema.Literals(["tab", "card"])),
    panel: Panels.Panel
  }),
  Schema.Struct({ kind: Schema.Literal("status"), status: Extension.Status }),
  Schema.Struct({ kind: Schema.Literal("key"), key: Extension.Key }),
  Panels.Panel
])

export const source = (ports: Ports): FlowBinding.Source =>
  FlowBinding.source("tui/runtime", [
    bind(
      "ui.publish",
      "Create or update custom terminal UI; returns immediately. A bare panel is a tab; {kind:\"panel\",placement:\"card\",panel} is a live chat card; {kind:\"status\",status} is a footer item; {kind:\"key\",key} is a key. Same id replaces it without stealing focus. Use one sentence and concise rows with expandable code, tables, text or diffs.",
      publishInput,
      (input) => {
        const contribution = Extension.decode(input)
        ports.publish(contribution)
        const id = contribution.kind === "panel"
          ? contribution.panel.id
          : contribution.kind === "status"
          ? contribution.status.id
          : contribution.key.id
        return { id, status: "published" }
      }
    ),
    ...(ports.monitors === undefined ? [] : [
      bind(
        "monitor.create",
        "Watch a source and tell the user only when something notable happens; returns immediately. Jev judges each change against watch; Luna writes the one-line update. source is {kind:\"tab\",id} (a worker tab), {kind:\"run\",id} (a smithers.run id) or {kind:\"shell\",command}. trigger is {kind:\"events\"} (default for tab and run) or {kind:\"interval\",seconds} (10 to 86400; required for shell, default 60). Reuse id to deduplicate or restart a stopped or failed monitor.",
        Schema.Struct({
          id: short,
          title: short,
          watch: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2000)),
          source: Schema.Union([
            Schema.Struct({ kind: Schema.Literal("tab"), id: short }),
            Schema.Struct({ kind: Schema.Literal("run"), id: short }),
            Schema.Struct({
              kind: Schema.Literal("shell"),
              command: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2000))
            })
          ]),
          trigger: Schema.optional(Schema.Union([
            Schema.Struct({ kind: Schema.Literal("events") }),
            Schema.Struct({ kind: Schema.Literal("interval"), seconds: Schema.Number })
          ]))
        }),
        (input) => ports.monitors!.create(input),
        // A shell source runs its command every tick: the gate asks, per call.
        ["proc:spawn:*"]
      ),
      bind(
        "monitor.list",
        "List monitors: id, title, status, update count and any failure.",
        Schema.Struct({}),
        () => ports.monitors!.list()
      ),
      bind(
        "monitor.stop",
        "Stop a monitor.",
        Schema.Struct({ id: short }),
        (input) => ports.monitors!.stop(input.id)
      )
    ]),
    ...(ports.delegate === undefined ? [] : [
      bind(
        "agent.delegate",
        "Request background work in a separate agent tab and return immediately. Six run at once by default; more queue FIFO. Reuse id to deduplicate. agent names one of the Agents in your context to run with its own prompt, model and flows. harness runs it on Claude Code or Codex with their own tools, only when the person names one. Workers may wait with agent.wait; the coordinator must not wait. When the person names a model, pass model and pinned: true so it runs there even with no credit. Otherwise omit pinned.",
        Schema.Struct({
          id: short,
          title: short,
          prompt: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(32_000)),
          model: Schema.optional(short),
          pinned: Schema.optional(Schema.Boolean),
          agent: Schema.optional(short),
          harness: Schema.optional(Schema.Literals(["claude", "codex"]))
        }),
        (input) => ports.delegate!(input)
      ),
      bind(
        "tab.read",
        "Read a background agent's status, summary and recent cells. Does not wait. Do not poll in a loop; return to the user while it runs.",
        Schema.Struct({ id: short }),
        (input) => ports.read!(input.id)
      ),
      ...(ports.retry === undefined ? [] : [
        bind(
          "tab.retry",
          "Run a failed or stopped background tab or flow run again, with its original task and model, when the user asks for it. Returns its new status at once; requested or queued is not started.",
          Schema.Struct({ id: short }),
          (input) => ports.retry!(input.id)
        )
      ]),
      bind(
        "tab.list",
        "List the background agent tabs and their actual status. Does not wait. Do not poll; the UI shows progress.",
        Schema.Struct({}),
        () => ports.list!()
      ),
      ...(ports.answer === undefined ? [] : [bind(
        "agent.answer",
        "Answer a child's ask, delivered to you as a message or in agent.wait's result, by its id.",
        Schema.Struct({ id: short, answer: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8_000)) }),
        (input) => ports.answer!(input.id, input.answer)
      )]),
      ...(ports.wait === undefined ? [] : [bind(
        "agent.wait",
        "Wait for child tabs to settle. Pass child request ids; returns each id, status, answer or message. A child's ask returns it early with ask {id, question, options}: answer it with agent.answer, then wait again. Waiting releases this worker's pool slot.",
        Schema.Struct({ ids: Schema.Array(short).check(Schema.isMinLength(1)) }),
        (input, signal) => ports.wait!(input.ids, signal),
        [],
        true
      )])
    ])
  ])
export const coordinatorTeaching =
  `You are the fast conversational coordinator. For accepted background requests, end the turn with ctx.done(""); the host delivers the run's progress and final answer in its Chat card. Do not narrate flow names, ids, JSON, or the absence of code changes. When one of the user's flows (smithers.flows) does the task, request it with smithers.run instead of a worker. Keep chat instant: request research, planning, implementation and tests with agent.delegate, then resolve this turn immediately. Every turn ends with ctx.done("") in the cell that makes the request; console.log does not end it. Never wait, retry, or re-check tab.list for a worker within a turn: each cell spends one of a few frames, the UI shows progress, and the host delivers completions directly to Chat. If a request fails, end the turn saying it was not made and why. Workers have an inspectable run and their real completion also arrives in your context. Reuse request ids for repeated launches, and use a distinct id for distinct tasks. Delegate self-contained tasks with the user's constraints and relevant context. For questions, information the user needs before deciding, and very quick requests, use the fast model (cerebras, only when Delegate models lists it) when delegating; Use models from Delegate models; when the person names one from No credit this session, pass model and pinned: true. Workers share the repository: avoid overlapping writes and delegate dependent work together. You have no filesystem or shell flows in this role; use a worker. Read tab.read when its evidence is needed. Prefer a custom UI over a long reply. To hear later only when something notable happens in a tab, a flow run or a command's output, use monitor.create. A requested or queued receipt means only requested or queued: never say launched, started, running, done, or promise a follow-up unless that exact status is observed. This applies to panel details as well as replies. A running task is never completed. When one of the Agents in your context fits the task, delegate with agent.delegate and its agent name; otherwise omit agent. Default worker seat, never an agent or model value: `

/** Requests the coordinator makes; a failed one is work the user asked for that nobody took. */
export const requestFlows: Readonly<Record<string, string>> = {
  "agent.delegate": "Not delegated",
  "smithers.run": "Not run"
}

/** A failed call's reason in the flow's own words, without the harness's prefix. */
export const failureReason = (message: string | undefined): string =>
  (message ?? "failed").replace(/^Flow \S+ failed: /, "")

const record = (value: unknown): Readonly<Record<string, unknown>> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}

/**
 * Rewrites a coordinator turn's budget-exhausted answer into what happened.
 *
 * The harness ends a run whose frames ran out with a generic sentence about
 * its last transition. The coordinator's frames are few, and a turn that
 * spends them re-trying a refused delegation left the user reading "a request
 * to continue" while the work was never handed to anyone. The ledger reads the
 * turn's own journaled calls, so the answer names each request whose last
 * attempt failed, and each one a worker took.
 *
 * A turn that completed, which the cell says with a `complete` transition,
 * keeps its own answer only when no request's last attempt failed. A small
 * seat writes `ctx.done("Delegated …")` in the cell that makes the request,
 * before the result exists, and says it again after the harness hands the
 * claim back with the failure. The receipts decide what was requested; the
 * model's sentence does not.
 */
export const ledger = (maxFrames: number): (event: AgentEvent.AgentEvent) => AgentEvent.AgentEvent => {
  const started = new Map<string, { readonly verdict: string; readonly id: string; readonly title: string }>()
  const failed = new Map<string, string>()
  const requested = new Map<string, string>()
  let completed = false
  const key = (identity: { readonly frame: number; readonly cell: string; readonly ordinal: number }) =>
    `${identity.frame}:${identity.cell}:${identity.ordinal}`
  return (event) => {
    switch (event._tag) {
      case "cell-call-started": {
        const verdict = requestFlows[event.call.flowName]
        if (verdict === undefined) return event
        const input = record(event.call.input)
        const id = String(input.id ?? "")
        const title = String(input.title ?? input.flow ?? id)
        started.set(key(event.call.identity), { verdict, id, title })
        return event
      }
      case "cell-call-settled": {
        const request = started.get(key(event.identity))
        if (request === undefined) return event
        const label = `${request.verdict}::${request.id}`
        if (event.result.outcome === "success") {
          failed.delete(label)
          requested.set(request.id, request.title)
        } else {
          failed.set(label, `${request.verdict}: ${request.title} (${failureReason(event.result.message)})`)
        }
        return event
      }
      case "transition-applied":
        completed = event.transition._tag === "complete"
        return event
      case "resolved": {
        if (completed && failed.size === 0) return event
        const lines = [
          ...(completed ? [] : [`Stopped after ${maxFrames} frames.`]),
          ...failed.values(),
          ...[...requested.values()].map((title) => `Requested: ${title}`)
        ]
        return new AgentEvent.Resolved({
          eventType: event.eventType,
          message: ModelRequest.Message.assistant(lines.join("\n"), { stopReason: "stop" })
        })
      }
      default:
        return event
    }
  }
}
