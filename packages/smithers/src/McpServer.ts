/**
 * Compatibility semantic MCP server. The canonical `smthrs --mcp` executable
 * uses the unified Incur command tree; this module retains its 0.x tool API.
 *
 * The protocol is newline-delimited JSON-RPC 2.0 over stdio, which is what
 * `@smthrs/mcp`'s own client speaks, so the round trip is testable in-process
 * without a second SDK.
 *
 * Two things about the tool surface are deliberate and load-bearing.
 *
 * The tool *names* are the 0.x names. An MCP client's tool allowlists, prompts,
 * and habits are written against names, and renaming them would break every
 * caller for no gain: the 0.x names are already the vocabulary.
 *
 * The ten tools rc.0 does not implement keep their names too, and answer
 * `{ ok: false, error: { code: "unsupported" } }`. Removing them would make an
 * agent's call fail as "unknown tool", which reads as a client bug; answering
 * with a reason tells the agent that time travel, checkpoints, and human
 * questions are features this release does not have (the release policy).
 *
 * Every result is the 0.x `{ ok, data?, error? }` envelope, serialized into the
 * text content block and repeated as `structuredContent`.
 * Approval-bearing tools are excluded by default. Host exposure alone grants
 * no authority: calls carry an agent principal checked by Control's policy.
 *
 * @since 1.0.0
 */
import { Control as ControlService, ControlError, ControlSchema } from "@smthrs/control"
import { asString } from "@smthrs/gateway/Diagnosis"
import * as Redaction from "@smthrs/journal/Redaction"
import { Cause, Context, Deferred, Effect, Queue, Schema, Stream } from "effect"
import * as Argv from "./cli/Argv.ts"
import * as CliError from "./CliError.ts"
import * as Forensics from "./Forensics.ts"
import * as BoundedEvents from "./internal/BoundedEvents.ts"
import * as NodeOutput from "./NodeOutput.ts"
import * as Unsupported from "./Unsupported.ts"

/**
 * The MCP protocol revision this server implements.
 *
 * @category constants
 * @since 1.0.0
 */
export const protocolVersion = "2025-06-18"

/**
 * Largest request or response frame accepted by the stdio server.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const maximumFrameBytes = 4 * 1024 * 1024

/**
 * Largest event count returned by one MCP history tool.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const maximumHistoryEvents = 10_000

/**
 * Largest encoded event history returned by one MCP tool.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const maximumHistoryBytes = 1024 * 1024

/**
 * Which tool families a session exposes.
 *
 * `semantic` is the named control surface below, `raw` mirrors the shipped CLI
 * verbs one tool per verb, and `both` is the union.
 *
 * @category models
 * @since 1.0.0
 */
export type Surface = "raw" | "semantic" | "both"

/**
 * The `{ ok, data?, error? }` envelope every tool answers with.
 *
 * @category models
 * @since 1.0.0
 */
export type Envelope =
  | { readonly ok: true; readonly data: unknown; readonly nextCursor?: string }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

/**
 * A successful envelope.
 *
 * @category constructors
 * @since 1.0.0
 */
export const succeeded = (data: unknown, nextCursor?: string): Envelope =>
  nextCursor === undefined ? { ok: true, data } : { ok: true, data, nextCursor }

/**
 * A failed envelope.
 *
 * @category constructors
 * @since 1.0.0
 */
export const failed = (code: string, message: string): Envelope => ({
  ok: false,
  error: { code, message: String(Redaction.redact(message)) }
})

/**
 * One tool this server exposes.
 *
 * @category models
 * @since 1.0.0
 */
export interface Tool {
  readonly name: string
  readonly description: string
  readonly readOnly: boolean
  readonly schema: Schema.Codec<unknown, unknown>
  readonly inputSchema: Record<string, unknown>
  readonly call: (args: Record<string, unknown>) => Effect.Effect<Envelope, never, ControlService.Control>
}

const inputSchemaOf = (schema: Schema.Codec<unknown, unknown>): Record<string, unknown> => {
  const document = Schema.toJsonSchemaDocument(schema, { onExcessProperty: "error" })
  const root = document.schema as Record<string, unknown>
  return Object.keys(document.definitions).length === 0
    ? root
    : { ...root, $defs: document.definitions }
}

const makeTool = (definition: Omit<Tool, "inputSchema">): Tool => ({
  ...definition,
  inputSchema: inputSchemaOf(definition.schema)
})

const approvalTools = new Set(["run_flow", "resolve_approval"])
const actor = Context.Reference<Omit<ControlSchema.Principal, "stampedAt">>("/cli/McpApprovalActor", {
  defaultValue: () => ({ id: "mcp", kind: "agent" })
})

const emptyArguments = Schema.Record(Schema.String, Schema.Never)

const describedString = (description: string) => Schema.String.annotate({ description })

const runIdArguments = Schema.Struct({
  runId: describedString("The run to read.")
})

const runFlowArguments = Schema.Struct({
  flowId: describedString("The flow to run, as `smthrs flow list` names it."),
  input: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.Unknown).annotate({ description: "The flow's input." })
  )
})

// Control answers one page at a time; the list tools pass its cursor through
// so a caller can read past the first page instead of seeing it as the whole.
const pageArguments = {
  cursor: Schema.optionalKey(describedString("The nextCursor of the previous page.")),
  limit: Schema.optionalKey(ControlSchema.PageLimit.annotate({
    description: `Items per page, 1 to ${ControlSchema.maxPageSize}. Omitted means ${ControlSchema.defaultPageSize}.`
  }))
}

const pageOf = (args: Record<string, unknown>) => ({
  ...(asString(args["cursor"]) === undefined ? {} : { cursor: asString(args["cursor"])! }),
  ...(typeof args["limit"] === "number" ? { limit: args["limit"] } : {})
})

const listFlowsArguments = Schema.Struct(pageArguments)

const listRunsArguments = Schema.Struct({
  flowId: Schema.optionalKey(describedString("Only runs of this flow.")),
  status: Schema.optionalKey(ControlSchema.RunStatus.annotate({ description: "Only runs in this status." })),
  ...pageArguments
})

const watchRunArguments = Schema.Struct({
  runId: describedString("The run to watch."),
  afterSequence: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).annotate({
      description: "Only events after this sequence."
    })
  )
})

const pendingApprovalArguments = Schema.Struct({
  runId: Schema.optionalKey(describedString("Only this run.")),
  ...pageArguments
})

const resolveApprovalArguments = Schema.Struct({
  approval: Schema.Union([Schema.String, ControlSchema.ApprovalPayload]).annotate({
    description: "The serialized approval payload from list_pending_approvals."
  }),
  decision: Schema.Literals(["approve", "deny"]).annotate({ description: "What to do." }),
  scope: Schema.optionalKey(
    Schema.Literals(["once", "run", "remembered"]).annotate({
      description: "How long the grant lasts. Omitted means `once`."
    })
  )
})

const nodeDetailArguments = Schema.Struct({
  runId: describedString("The run to read."),
  nodeId: describedString("The node, as `smthrs runs output <run-id>` lists it.")
})

const requireRunId = (args: Record<string, unknown>): string | undefined =>
  asString(args["runId"]) ?? asString(args["run_id"])

/** Events of one run after the cursor, oldest first. */
const eventsOf = (runId: string, afterSequence = 0) =>
  Effect.gen(function*() {
    const control = yield* ControlService.Control
    return yield* BoundedEvents.collect(
      control.watch({ runId, afterSequence, follow: false }),
      { operation: "MCP event-history read", subject: `run ${JSON.stringify(runId)}` },
      {
        maxEvents: maximumHistoryEvents,
        maxBytes: maximumHistoryBytes,
        maxEventBytes: BoundedEvents.maximumEventBytes
      }
    )
  })

/** One run's summary, or undefined when the control plane has no such run. */
const summaryOf = (runId: string) =>
  Effect.gen(function*() {
    const control = yield* ControlService.Control
    const listed = yield* control.list({ _tag: "runs", filters: { runId } })
    return listed._tag === "runs" ? listed.items.find((item) => item.runId === runId) : undefined
  })

const missingRun = (runId: string): Envelope => failed("RUN_NOT_FOUND", `Run not found: ${runId}`)

const missingArgument = (name: string): Envelope => failed("INVALID_INPUT", `${name} is required and must be a string`)

const safeText = (value: string, maximum = 512): string =>
  [...String(Redaction.redact(value))].slice(0, maximum).join("")

const safeFailure = (failure: ControlError.ControlError | CliError.ResourceLimitError): Envelope => {
  if (failure instanceof CliError.ResourceLimitError) return failed("RESOURCE_LIMIT", failure.message)
  switch (failure._tag) {
    case "/control/RunNotFound":
      return failed("RUN_NOT_FOUND", `Run not found: ${safeText(failure.runId)}`)
    case "/control/PlanNotFound":
      return failed("PLAN_NOT_FOUND", `Plan ${safeText(failure.planId)} was not found`)
    case "/control/PlanDenied":
      return failed("PLAN_DENIED", `Plan ${safeText(failure.planId)} was denied`)
    case "/control/FlowNotFound":
      return failed("FLOW_NOT_FOUND", `Flow not found: ${safeText(failure.flowId)}`)
    case "/control/PlanDigestMismatch":
      return failed("PLAN_DIGEST_MISMATCH", "The submitted plan digest does not match its payload")
    case "/control/EnvelopeMismatch":
      return failed("ENVELOPE_MISMATCH", "The submitted plan effect envelope does not match its payload")
    case "/control/ClaimLost":
      return failed("CLAIM_LOST", `Ownership of run ${safeText(failure.runId)} changed`)
    case "/control/AlreadyResolved":
      return failed("ALREADY_RESOLVED", `Approval request ${safeText(failure.requestId)} was already resolved`)
    case "/control/InvalidInput":
      return failed("INVALID_INPUT", safeText(failure.issue, 1024))
    case "/control/Unauthorized":
      return failed("UNAUTHORIZED", "The control operation was not authorized")
    case "/control/Unavailable":
      return failed(
        "UNAVAILABLE",
        `Control feature ${safeText(failure.feature)} is unavailable (${safeText(failure.ticket)})`
      )
    case "/control/TransportError":
      return failed("TRANSPORT_ERROR", "The control transport failed")
    case "/control/PersistenceError":
      return failed("PERSISTENCE_ERROR", `Control persistence failed during ${safeText(failure.operation)}`)
    case "/control/LaunchFailed":
      return failed("LAUNCH_FAILED", `Run ${safeText(failure.runId)} could not be launched`)
    case "/control/NoMatchingWait":
      return failed(
        "NO_MATCHING_WAIT",
        `Run ${safeText(failure.runId)} has no wait named ${safeText(failure.waitName)}`
      )
    case "/notifications/NotificationError":
      return failed("NOTIFICATION_ERROR", "The notification queue could not complete the operation")
    case "/control/CredentialConflict":
      return failed("CREDENTIAL_CONFLICT", `Credential ${safeText(failure.id)} changed before this write committed`)
  }
}

/** Wraps typed control failures while preserving defects and interruption. */
const envelope = <A>(
  effect: Effect.Effect<A, unknown, ControlService.Control>,
  onSuccess: (value: A) => Envelope
): Effect.Effect<Envelope, never, ControlService.Control> =>
  effect.pipe(
    Effect.map(onSuccess),
    Effect.catch((failure) =>
      failure instanceof CliError.ResourceLimitError || Schema.is(ControlError.ControlErrorSchema)(failure)
        ? Effect.succeed(safeFailure(failure))
        : Effect.die(failure)
    )
  )

const decodeApproval = (value: unknown): ControlService.ApprovalInput | undefined => {
  try {
    return Schema.decodeUnknownSync(ControlSchema.ApprovalPayload)(
      typeof value === "string" ? JSON.parse(value) : value
    )
  } catch {
    return undefined
  }
}

/**
 * The eleven Control-backed tools using the current flow vocabulary.
 *
 * @category constants
 * @since 1.0.0
 */
export const supportedTools: ReadonlyArray<Tool> = [
  makeTool({
    name: "list_flows",
    description: "List the flows discovered under this project.",
    readOnly: true,
    schema: listFlowsArguments,
    call: (args) =>
      envelope(
        Effect.flatMap(ControlService.Control, (control) => control.list({ _tag: "flows", ...pageOf(args) })),
        (listed) =>
          succeeded(
            listed._tag === "flows"
              ? listed.items.filter((item) => !Unsupported.isReservedFlow(item.flowId))
              : [],
            listed.nextCursor
          )
      )
  }),
  makeTool({
    name: "run_flow",
    description:
      "Operator-only: planning and launching a flow requires approval. MCP calls return UNAUTHORIZED; use smthrs flow start as an operator.",
    readOnly: false,
    schema: runFlowArguments,
    call: (args) => {
      const flowId = asString(args["flowId"])
      if (flowId === undefined) return Effect.succeed(missingArgument("flowId"))
      if (Unsupported.isReservedFlow(flowId)) {
        return Effect.succeed(
          failed("unsupported", Unsupported.reservedFlowError("flow start", flowId).message)
        )
      }
      const input = args["input"] ?? {}
      return envelope(
        Effect.gen(function*() {
          const control = yield* ControlService.Control
          const principal = { ...(yield* actor), stampedAt: 0 }
          const card = yield* control.plan({ flowId, input })
          yield* control.approve({ ...card.approval, scope: "run", principal })
          return yield* control.run({
            _tag: "Plan",
            planId: card.planId,
            digest: card.digest,
            envelope: card.envelope,
            idempotencyKey: card.approval.idempotencyKey,
            principal
          })
        }),
        (receipt) => succeeded(receipt)
      )
    }
  }),
  makeTool({
    name: "list_runs",
    description: "List durable runs, optionally filtered by flow or status.",
    readOnly: true,
    schema: listRunsArguments,
    call: (args) =>
      envelope(
        Effect.flatMap(ControlService.Control, (control) =>
          control.list({
            _tag: "runs",
            filters: {
              ...(asString(args["flowId"]) === undefined ? {} : { flowId: asString(args["flowId"])! }),
              ...(asString(args["status"]) === undefined
                ? {}
                : { status: asString(args["status"])! as ControlSchema.RunStatus })
            },
            ...pageOf(args)
          })),
        (listed) => succeeded(listed._tag === "runs" ? listed.items : [], listed.nextCursor)
      )
  }),
  makeTool({
    name: "get_run",
    description: "Read one run's summary.",
    readOnly: true,
    schema: runIdArguments,
    call: (args) => {
      const runId = requireRunId(args)
      if (runId === undefined) return Effect.succeed(missingArgument("runId"))
      return envelope(summaryOf(runId), (run) => run === undefined ? missingRun(runId) : succeeded(run))
    }
  }),
  makeTool({
    name: "watch_run",
    description: "Read the events of one run after a sequence. Returns immediately; poll to follow.",
    readOnly: true,
    schema: watchRunArguments,
    call: (args) => {
      const runId = requireRunId(args)
      if (runId === undefined) return Effect.succeed(missingArgument("runId"))
      const after = typeof args["afterSequence"] === "number" ? args["afterSequence"] : 0
      return envelope(
        Effect.all([eventsOf(runId, after), summaryOf(runId)]),
        ([events, run]) =>
          succeeded({
            runId,
            status: run?.status,
            events,
            sequence: events.at(-1)?.sequence ?? after
          })
      )
    }
  }),
  makeTool({
    name: "get_run_events",
    description: "Read every recorded event of one run.",
    readOnly: true,
    schema: runIdArguments,
    call: (args) => {
      const runId = requireRunId(args)
      if (runId === undefined) return Effect.succeed(missingArgument("runId"))
      return envelope(eventsOf(runId), (events) => succeeded(events))
    }
  }),
  makeTool({
    name: "explain_run",
    description: "Explain what happened in one run: status, cause, turns, calls, refusals, and cost.",
    readOnly: true,
    schema: runIdArguments,
    call: (args) => {
      const runId = requireRunId(args)
      if (runId === undefined) return Effect.succeed(missingArgument("runId"))
      return envelope(
        Effect.all([eventsOf(runId), summaryOf(runId)]),
        ([events, run]) => {
          const digest = Forensics.digest(events)
          return succeeded({ runId, status: run?.status, digest, card: Forensics.renderDiagnosis(run, digest) })
        }
      )
    }
  }),
  makeTool({
    name: "list_pending_approvals",
    description: "List runs parked on an approval, with the payload that releases each one.",
    readOnly: true,
    schema: pendingApprovalArguments,
    call: (args) =>
      envelope(
        Effect.gen(function*() {
          const control = yield* ControlService.Control
          const only = requireRunId(args)
          const listed = yield* control.list({
            _tag: "runs",
            filters: { status: "waiting-approval", ...(only === undefined ? {} : { runId: only }) },
            ...pageOf(args)
          })
          const runs = listed._tag === "runs" ? listed.items : []
          const approvals = yield* Effect.forEach(runs, (run) =>
            Effect.map(eventsOf(run.runId), (events) => {
              const digest = Forensics.digest(events)
              return {
                runId: run.runId,
                flowId: run.flowId,
                question: digest.parkedQuestion,
                approval: digest.parkedApproval
              }
            }))
          return { approvals, nextCursor: listed.nextCursor }
        }),
        ({ approvals, nextCursor }) => succeeded(approvals, nextCursor)
      )
  }),
  makeTool({
    name: "resolve_approval",
    description: "Operator-only: approve or deny a serialized approval payload. MCP calls return UNAUTHORIZED for all "
      + "scopes, including remembered; an operator must use smthrs approvals approve or smthrs approvals deny.",
    readOnly: false,
    schema: resolveApprovalArguments,
    call: (args) => {
      const payload = decodeApproval(args["approval"])
      if (payload === undefined) return Effect.succeed(missingArgument("approval"))
      const decision = asString(args["decision"])
      if (decision !== "approve" && decision !== "deny") {
        return Effect.succeed(failed("INVALID_INPUT", "decision must be \"approve\" or \"deny\""))
      }
      // A scope decides how long the capability grant outlives the ask, so a
      // value this server cannot read is refused exactly as `decision` is, and
      // silence means the narrowest grant. Coercing both to "run" handed an
      // MCP client the whole run's capabilities for an argument it never sent
      // and for a typo it would never see reported.
      const scope = args["scope"] === undefined ? "once" : asString(args["scope"])
      if (scope !== "once" && scope !== "run" && scope !== "remembered") {
        return Effect.succeed(failed("INVALID_INPUT", "scope must be \"once\", \"run\", or \"remembered\""))
      }
      return envelope(
        Effect.gen(function*() {
          const control = yield* ControlService.Control
          const principal = { ...(yield* actor), stampedAt: 0 }
          return yield* (decision === "approve"
            ? control.approve({ ...payload, scope, principal })
            : control.deny({ ...payload, principal }))
        }),
        (receipt) => succeeded(receipt)
      )
    }
  }),
  makeTool({
    name: "get_node_detail",
    description: "Read one node's recorded output from a run.",
    readOnly: true,
    schema: nodeDetailArguments,
    call: (args) => {
      const runId = requireRunId(args)
      if (runId === undefined) return Effect.succeed(missingArgument("runId"))
      const nodeId = asString(args["nodeId"])
      if (nodeId === undefined) return Effect.succeed(missingArgument("nodeId"))
      return envelope(eventsOf(runId), (events) => {
        const nodes = NodeOutput.project(events)
        const node = nodes.find((candidate) => candidate.nodeId === nodeId)
        return node === undefined
          ? failed("NODE_NOT_FOUND", NodeOutput.notFound(runId, nodeId, nodes))
          : succeeded(node)
      })
    }
  }),
  makeTool({
    name: "get_chat_transcript",
    description: "Read one run's turn-by-turn transcript.",
    readOnly: true,
    schema: runIdArguments,
    call: (args) => {
      const runId = requireRunId(args)
      if (runId === undefined) return Effect.succeed(missingArgument("runId"))
      return envelope(eventsOf(runId), (events) => succeeded({ runId, transcript: Forensics.renderTranscript(events) }))
    }
  })
]

/**
 * The retired tool names rc.0 answers with an `unsupported` envelope, and the
 * reason each gives.
 *
 * @category constants
 * @since 1.0.0
 */
export const unsupportedReasons: ReadonlyArray<readonly [name: string, reason: string]> = [
  ["list_workflows", "renamed to list_flows; use list_flows"],
  ["run_workflow", "renamed to run_flow; use run_flow with flowId"],
  ["revert_attempt", "time travel is a library API (@smthrs/time-travel) and is not composed into the CLI"],
  ["fork_run", "time travel is a library API (@smthrs/time-travel) and is not composed into the CLI"],
  ["replay_run", "time travel is a library API (@smthrs/time-travel) and is not composed into the CLI"],
  ["rewind_run", "time travel is a library API (@smthrs/time-travel) and is not composed into the CLI"],
  ["restore_checkpoint", "worktree lanes and snapshot restore are deferred"],
  ["list_snapshots", "worktree lanes and snapshot restore are deferred"],
  ["get_timeline", "time travel is a library API (@smthrs/time-travel) and is not composed into the CLI"],
  ["time_travel", "time travel is a library API (@smthrs/time-travel) and is not composed into the CLI"],
  ["list_artifacts", "the artifact projection is not part of this release"],
  ["ask_human", "there is no question or answer RPC; approvals park the run, so use list_pending_approvals"]
]

/**
 * The unsupported tools, as tools: named, described, and answering with the
 * `unsupported` envelope.
 *
 * @category constants
 * @since 1.0.0
 */
export const unsupportedTools: ReadonlyArray<Tool> = unsupportedReasons.map(([name, reason]) =>
  makeTool({
    name,
    description: `Not available in 1.0.0-rc.0: ${reason}.`,
    readOnly: true,
    schema: name === "run_workflow" ? runFlowArguments : emptyArguments,
    call: () =>
      Effect.succeed(
        failed(
          "unsupported",
          `${name} is not available in 1.0.0-rc.0: ${reason}. See https://smithers.sh/migration/1.0`
        )
      )
  })
)

/**
 * The raw surface: one tool per shipped CLI verb, describing how to reach it.
 *
 * The raw tools are a directory, not a second execution path. 0.x mirrored
 * every CLI command as an MCP tool by reflecting its argument parser, which
 * made the MCP surface a second, undocumented copy of the command line.
 * Naming the verbs and pointing at the semantic tool that performs each one
 * keeps exactly one execution path.
 *
 * @category constructors
 * @since 1.0.0
 */
export const rawTools = (
  verbs: ReadonlyArray<{ readonly name: string; readonly help: string }>
): ReadonlyArray<Tool> =>
  verbs.map((verb) =>
    makeTool({
      name: `cli_${verb.name.replaceAll("-", "_")}`,
      description: `${verb.help}. Run it as \`smthrs ${verb.name}\`.`,
      readOnly: true,
      schema: emptyArguments,
      call: () =>
        Effect.succeed(
          succeeded({
            command: `smthrs ${verb.name}`,
            description: verb.help,
            note: "Run this from a shell; the semantic tools perform the control-plane operations directly."
          })
        )
    })
  )

/**
 * How one session's tool list is scoped.
 *
 * @category models
 * @since 1.0.0
 */
export interface Options {
  /**
   * Host opt-in to expose tools that make approval decisions. This grants no
   * authority: the receiving Control runtime must independently delegate to
   * this session's authenticated principal and the requested approval scope.
   */
  readonly approvalTools?: boolean | undefined
  /** Host-authenticated session identity, never read from tool arguments. */
  readonly principal?: Omit<ControlSchema.Principal, "stampedAt"> | undefined
  readonly surface?: Surface | undefined
  readonly allowedTools?: ReadonlyArray<string> | undefined
  readonly readOnly?: boolean | undefined
  readonly verbs?: ReadonlyArray<{ readonly name: string; readonly help: string }> | undefined
}

/**
 * The tools one session exposes, after the surface, allowlist, and read-only
 * filters.
 *
 * @category constructors
 * @since 1.0.0
 */
export const tools = (options: Options = {}): ReadonlyArray<Tool> => {
  const surface = options.surface ?? "semantic"
  const semantic = surface === "raw" ? [] : [...supportedTools, ...unsupportedTools]
  const raw = surface === "semantic" ? [] : rawTools(options.verbs ?? [])
  const all = [...semantic, ...raw]
  const allowed = options.allowedTools === undefined ? undefined : new Set(options.allowedTools)
  const principal = options.principal === undefined
    ? { id: "mcp", kind: "agent" }
    : { id: options.principal.id, kind: options.principal.kind }
  return all.filter((tool) =>
    (allowed === undefined || allowed.has(tool.name)) && (options.readOnly !== true || tool.readOnly) &&
    (options.approvalTools === true || !approvalTools.has(tool.name))
  ).map((tool) => ({ ...tool, call: (args) => tool.call(args).pipe(Effect.provideService(actor, principal)) }))
}

/**
 * Whether this invocation is the MCP server rather than a command.
 *
 * @category predicates
 * @since 1.0.0
 */
export const requested = (args: ReadonlyArray<string> | Argv.Globals): boolean =>
  Argv.parse(args).options.get("--mcp") === true

/**
 * Reads the session's scope out of raw argv.
 *
 * The MCP server is selected by a flag rather than a subcommand, because that
 * is how every MCP client's configuration spells a launch command, so its own
 * flags are read from argv rather than parsed by the command tree.
 *
 * @category constructors
 * @since 1.0.0
 */
export const optionsFromArguments = (args: ReadonlyArray<string> | Argv.Globals): Options => {
  const parsed = Argv.parse(args)
  const surface = parsed.options.get("--surface")
  const allowed = parsed.options.get("--allowed-tools")
  return {
    surface: surface === "raw" || surface === "both" ? surface : "semantic",
    ...(typeof allowed !== "string"
      ? {}
      : { allowedTools: allowed.split(",").map((name) => name.trim()).filter((name) => name !== "") }),
    readOnly: parsed.options.get("--read-only") === true
  }
}

/** A JSON-RPC message as it arrives on stdin. */
interface Request {
  readonly id?: number | string | undefined
  readonly method?: string | undefined
  readonly params?: unknown
}

const parse = (line: string): Request | undefined => {
  const trimmed = line.trim()
  if (trimmed === "") return undefined
  try {
    const value: unknown = JSON.parse(trimmed)
    if (typeof value !== "object" || value === null) return undefined
    if ((value as { readonly jsonrpc?: unknown }).jsonrpc !== "2.0") return undefined
    return value
  } catch {
    return undefined
  }
}

const toolResult = (result: Envelope): Record<string, unknown> => ({
  content: [{ type: "text", text: JSON.stringify(result) }],
  structuredContent: result,
  isError: !result.ok
})

const frameBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8")

const resourceLimitMessage = `MCP request or response exceeds the ${maximumFrameBytes}-byte frame limit`

const resourceLimit = (): Extract<Envelope, { readonly ok: false }> => ({
  ok: false,
  error: { code: "RESOURCE_LIMIT", message: resourceLimitMessage }
})

/**
 * Answers one request, or `undefined` for a notification that needs no reply.
 *
 * @category constructors
 * @since 1.0.0
 */
export const respond = (
  request: Request,
  session: ReadonlyArray<Tool>,
  version: string
): Effect.Effect<Record<string, unknown> | undefined, never, ControlService.Control> =>
  Effect.gen(function*() {
    if (request.id === undefined) return undefined
    const reply = (result: unknown) => ({ jsonrpc: "2.0", id: request.id, result })
    const boundedReply = (result: unknown): Record<string, unknown> => {
      const candidate = reply(result)
      return frameBytes(candidate) <= maximumFrameBytes ? candidate : reply(toolResult(resourceLimit()))
    }
    if (frameBytes(request) > maximumFrameBytes) return boundedReply(toolResult(resourceLimit()))
    switch (request.method) {
      case "initialize":
        return boundedReply({
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "smithers", version }
        })
      case "ping":
        return boundedReply({})
      case "tools/list":
        return boundedReply({
          tools: session.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            annotations: { readOnlyHint: tool.readOnly }
          }))
        })
      case "tools/call": {
        const params = typeof request.params === "object" && request.params !== null
          ? request.params as Record<string, unknown>
          : {}
        const name = asString(params["name"]) ?? ""
        const tool = session.find((candidate) => candidate.name === name)
        if (tool === undefined) {
          return boundedReply(toolResult(failed("unknown_tool", `No tool named ${name} is exposed by this session`)))
        }
        const rawArguments = params["arguments"] === undefined ? {} : params["arguments"]
        const decoded = yield* Schema.decodeUnknownEffect(tool.schema, { onExcessProperty: "error" })(
          rawArguments
        ).pipe(
          Effect.map((args) => ({ _tag: "Valid" as const, args })),
          Effect.catch((error) => Effect.succeed({ _tag: "Invalid" as const, error }))
        )
        if (decoded._tag === "Invalid") {
          return boundedReply(toolResult(failed("INVALID_INPUT", safeText(String(decoded.error), 1024))))
        }
        return boundedReply(toolResult(yield* tool.call(decoded.args as Record<string, unknown>)))
      }
      default: {
        const result = {
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32601, message: `Method not found: ${request.method ?? "?"}` }
        }
        return frameBytes(result) <= maximumFrameBytes ? result : boundedReply(toolResult(resourceLimit()))
      }
    }
  })

type InputFrame =
  | { readonly _tag: "Line"; readonly line: string }
  | { readonly _tag: "Oversized" }

const inputFrames = (input: NodeJS.ReadableStream): Stream.Stream<InputFrame> =>
  Stream.suspend(() => {
    let chunks: Array<Buffer> = []
    let bytes = 0
    let oversized = false

    const append = (chunk: Buffer): void => {
      if (chunk.length === 0 || oversized) return
      if (bytes + chunk.length > maximumFrameBytes) {
        chunks = []
        bytes = 0
        oversized = true
        return
      }
      chunks.push(chunk)
      bytes += chunk.length
    }

    const finish = (): InputFrame => {
      const frame: InputFrame = oversized
        ? { _tag: "Oversized" }
        : { _tag: "Line", line: Buffer.concat(chunks, bytes).toString("utf8") }
      chunks = []
      bytes = 0
      oversized = false
      return frame
    }

    const incoming = Stream.callback<Buffer, unknown>((queue) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const onData = (value: unknown): void => {
            // Keep at most one input chunk pending while the current chunk's
            // frames are consumed. Pausing alone cannot bound frames if one
            // chunk contains thousands of lines, so parsing below is lazy too.
            input.pause()
            const chunk = Buffer.isBuffer(value)
              ? value
              : value instanceof Uint8Array
              ? Buffer.from(value)
              : Buffer.from(String(value), "utf8")
            Queue.offerUnsafe(queue, chunk)
          }
          const onClose = (): void => {
            Queue.endUnsafe(queue)
          }
          const onError = (error: unknown): void => {
            Queue.failCauseUnsafe(queue, Cause.fail(error))
          }
          input.on("data", onData)
          input.on("end", onClose)
          input.on("close", onClose)
          input.on("error", onError)
          input.resume()
          return { onData, onClose, onError }
        }),
        ({ onClose, onData, onError }) =>
          Effect.sync(() => {
            input.pause()
            input.removeListener("data", onData)
            input.removeListener("end", onClose)
            input.removeListener("close", onClose)
            input.removeListener("error", onError)
          })
      ), { bufferSize: 1 })

    const frames = incoming.pipe(Stream.flatMap((chunk) =>
      Stream.fromIterable(
        (function*() {
          let start = 0
          for (let index = 0; index < chunk.length; index++) {
            if (chunk[index] !== 0x0a) continue
            append(chunk.subarray(start, index))
            yield finish()
            start = index + 1
          }
          append(chunk.subarray(start))
          input.resume()
        })(),
        { chunkSize: 1 }
      )
    ))
    return Stream.concat(frames, Stream.suspend(() => bytes > 0 || oversized ? Stream.make(finish()) : Stream.empty))
      .pipe(Stream.orDie)
  })

/** One completed write at a time, with transport listeners owned by the session. */
const outputWriter = (output: NodeJS.WritableStream) =>
  Effect.gen(function*() {
    const failed = yield* Deferred.make<never>()
    const onError = (error: unknown): void => {
      Deferred.doneUnsafe(failed, Effect.die(error))
    }
    const onClose = (): void => {
      onError(new Error("MCP output closed before the session completed"))
    }
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        output.on("error", onError)
        output.on("close", onClose)
        if (!output.writable) onClose()
      }),
      () =>
        Effect.sync(() => {
          output.removeListener("error", onError)
          output.removeListener("close", onClose)
        })
    )
    const write = (frame: string) =>
      Effect.callback<void>((resume) => {
        let completed = false
        let drained = false
        let returned = false
        const finish = (): void => {
          if (returned && completed && drained) {
            output.removeListener("drain", onDrain)
            resume(Effect.void)
          }
        }
        const onDrain = (): void => {
          drained = true
          finish()
        }
        output.on("drain", onDrain)
        try {
          const accepted = output.write(frame, (error?: Error | null) => {
            if (error != null) {
              // Node emits 'error' after invoking this callback. Leave the
              // session listener attached until that emission has been observed.
              setImmediate(() => onError(error))
              return
            }
            completed = true
            finish()
          })
          drained ||= accepted
          returned = true
          finish()
        } catch (error) {
          onError(error)
        }
        return Effect.sync(() => output.removeListener("drain", onDrain))
      })
    return { write, failed: Deferred.await(failed) }
  })

/**
 * Serves the MCP session over stdio until input closes and all replies complete.
 *
 * @category constructors
 * @since 1.0.0
 */
export const serve = (
  options: Options & {
    readonly version: string
    readonly input?: NodeJS.ReadableStream | undefined
    readonly output?: NodeJS.WritableStream | undefined
  }
): Effect.Effect<void, never, ControlService.Control> =>
  Effect.gen(function*() {
    const session = tools(options)
    const input = options.input ?? process.stdin
    const writer = yield* outputWriter(options.output ?? process.stdout)
    // One line in, one reply out, strictly in order: two `tools/call` handlers
    // writing concurrently would interleave frames and corrupt the protocol,
    // and an MCP client correlates replies by id rather than by arrival, so
    // serializing costs nothing an agent can observe.
    yield* Stream.runForEach(
      inputFrames(input),
      (frame) =>
        Effect.gen(function*() {
          if (frame._tag === "Oversized") {
            yield* writer.write(`${
              JSON.stringify({
                jsonrpc: "2.0",
                id: null,
                error: { code: -32001, message: resourceLimit().error?.message }
              })
            }\n`)
            return
          }
          const request = parse(frame.line)
          if (request === undefined) return
          const reply = yield* respond(request, session, options.version)
          if (reply !== undefined) yield* writer.write(`${JSON.stringify(reply)}\n`)
        })
    ).pipe(Effect.raceFirst(writer.failed))
  }).pipe(Effect.scoped)
