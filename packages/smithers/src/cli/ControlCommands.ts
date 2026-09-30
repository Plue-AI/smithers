/**
 * Durable flow, run, and approval commands for the unified CLI.
 * @since 1.0.0
 */

import { approvalRevision } from "@smthrs/build-cli/Cli"
import { Control, ControlFacts, type ControlSchema } from "@smthrs/control"
import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as RunDevTools from "@smthrs/gateway/RunDevTools"
import * as RunTrace from "@smthrs/gateway/RunTrace"
import * as Redaction from "@smthrs/journal/Redaction"
import { BudgetOnExceeded } from "@smthrs/registry/Descriptor"
import { Clock, Effect, Schema } from "effect"
import { Cli, z } from "incur"
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import * as CliError from "../CliError.ts"
import { cancelAll, unexpectedRunList } from "../commands/CancelAll.ts"
import * as FlowCatalog from "../commands/FlowCatalog.ts"
import * as Globals from "../commands/Globals.ts"
import * as Forensics from "../Forensics.ts"
import { defaultApprovalScope } from "../internal/ApprovalScope.ts"
import * as BoundedEvents from "../internal/BoundedEvents.ts"
import * as Failure from "../internal/Failure.ts"
import * as FeaturedFlows from "../internal/FeaturedFlows.ts"
import * as RunListing from "../internal/RunListing.ts"
import * as NodeControl from "../NodeControl.ts"
import * as Project from "../Project.ts"
import * as Bridge from "./ControlBridge.ts"
import { prepareHistoryRun, reconcileHistory } from "./HistoryCommands.ts"
import * as Presentation from "./Presentation.ts"
import * as RunProgress from "./RunProgress.ts"
import * as TargetApprovals from "./TargetApprovals.ts"

/** Observe a durable row until it settles; a park is a settled wait, not a terminal run. */
const waitForRun = async (
  runId: string,
  timeout: number | undefined,
  connection: Bridge.ConnectionOptions,
  runtime: Bridge.Runtime
) => {
  if (!Bridge.hasRecords(connection, runtime)) {
    await Bridge.project(checks(connection, runtime), connection, runtime)
    throw unknownRun(runId)
  }
  return Bridge.query(
    Effect.gen(function*() {
      const control = yield* Control.Control
      const start = yield* Clock.currentTimeMillis
      while (true) {
        const page = yield* control.list({ _tag: "runs", filters: { runId } })
        const row = page._tag === "runs" ? page.items.find((item) => item.runId === runId) : undefined
        if (row === undefined) throw unknownRun(runId)
        if (
          row.status === "completed" || row.status === "failed" || row.status === "cancelled" ||
          row.status === "parked" || row.status === "waiting-approval"
        ) return row
        if (timeout !== undefined && (yield* Clock.currentTimeMillis) - start >= timeout) {
          return { ...row, status: "timeout" as const }
        }
        yield* Effect.sleep(
          timeout === undefined ? 200 : Math.min(200, Math.max(1, timeout - ((yield* Clock.currentTimeMillis) - start)))
        )
      }
    }),
    connection,
    runtime
  )
}

const waitCode = (status: string) =>
  status === "completed" ? 0 : status === "cancelled" ?
    130 :
    status === "parked" || status === "waiting-approval" || status === "timeout"
    ? 3
    : 1

export { cancelAll }

const options = Bridge.connectionOptions
const runArgs = z.object({ run: z.string().min(1).describe("Durable run ID") })
const flowArgs = z.object({ flow: z.string().min(1).describe("Discovered flow name") })
const statuses = ["accepted", "running", "parked", "waiting-approval", "cancelled", "completed", "failed"] as const

/** The filters `runs list` and `runs count` share. */
const runFilters = options.extend({
  flow: z.string().optional(),
  status: z.enum(statuses).optional(),
  since: z.string().optional().describe("Only runs created at or after this time (epoch ms or ISO 8601)"),
  until: z.string().optional().describe("Only runs created before this time (epoch ms or ISO 8601)"),
  sort: z.enum(RunListing.sorts).optional().describe("Order by creation time"),
  parent: z.string().optional().describe("Only runs branched from this run"),
  trigger: z.string().optional().describe("Only runs this trigger started")
})

const guard = Presentation.guard
const runsList = { command: "runs list", description: "List the current durable run records" }
const afterDecision = Presentation.runs({
  otherwise: [{ command: "runs list", description: "Check the run after the decision" }]
})

const dataArgs = (data: string | undefined) => data === undefined ? [] : ["--data", data]

/** The notices and backend refusal every local verb applies before it reads. */
const checks = (connection: Bridge.ConnectionOptions, runtime: Bridge.Runtime) =>
  Globals.guard({ environment: runtime.environment ?? process.env })

/** The project's discovered flows, after the local checks. */
const discovered = (connection: Bridge.ConnectionOptions, runtime: Bridge.Runtime) =>
  Effect.andThen(checks(connection, runtime), FlowCatalog.discovered)

/**
 * The refusal an observing verb answers when the store is older than this
 * binary in a way it cannot read: a table or column it reads does not exist
 * yet. An older schema that still has everything the verb reads is read as
 * found; observing never migrates, so the sentence names the command that does.
 * Any other failure is returned unchanged.
 */
const olderStore = (
  verb: string,
  connection: Bridge.ConnectionOptions,
  runtime: Bridge.Runtime,
  cause: unknown
): unknown => {
  if (DurableWriter.codeOf(cause) !== "schema") return cause
  const store = dirname(NodeControl.databasePath(Bridge.configuration(connection, runtime).root ?? process.cwd()))
  return new CliError.Refused({
    fault: "user",
    code: "store_schema_older",
    message: `${verb} cannot read the store at ${store}: an older smthrs wrote it. Run smthrs serve to migrate it.`
  })
}

/** Runs one observing verb, refusing an unreadable older store with {@link olderStore}. */
const observing = async <A>(
  verb: string,
  connection: Bridge.ConnectionOptions,
  runtime: Bridge.Runtime,
  read: () => Promise<A>
): Promise<A> => {
  try {
    return await read()
  } catch (cause) {
    throw olderStore(verb, connection, runtime, cause)
  }
}

/** An observing verb's answer: `empty` when there are no records to read. */
const observe = async <A>(
  verb: string,
  connection: Bridge.ConnectionOptions,
  runtime: Bridge.Runtime,
  empty: A,
  read: () => Promise<A>
): Promise<A> =>
  Bridge.hasRecords(connection, runtime)
    ? observing(verb, connection, runtime, read)
    : Bridge.project(Effect.as(checks(connection, runtime), empty), connection, runtime)

const unknownRun = (runId: string) =>
  new CliError.Refused({ fault: "user", code: "run_not_found", message: `Unknown run ${runId}` })

/**
 * The flow catalog and explicit plan/start lifecycle.
 * @category constructors
 * @since 1.0.0
 */
export const createFlowCli = (runtime: Bridge.Runtime = {}) =>
  Cli.create("flow", {
    description: "Discover, plan, and start durable flows"
  })
    .command("list", {
      description: "List project flows",
      mcp: { annotations: { readOnlyHint: true } },
      options,
      // A local catalog read comes from the discovery snapshot, so listing flows
      // never creates or migrates the project's control and execution databases.
      run: (c) =>
        guard(
          c,
          () =>
            Bridge.isRemote(c.options, runtime)
              ? Bridge.invoke(["ls"], c.options, runtime)
              : Bridge.local(
                Effect.gen(function*() {
                  return FlowCatalog.listing((yield* discovered(c.options, runtime)).items, yield* Project.ProjectRoot)
                }),
                c.options,
                runtime
              ),
          // A person reads one line per flow, featured rows starred, so the
          // recommended set is visible without a table, then the same Next
          // actions every listing offers. Agents and `--json` keep the flow
          // page document unchanged.
          {
            render: (page) =>
              FeaturedFlows.isFlowPage(page)
                ? { human: FeaturedFlows.human(page.items, FeaturedFlows.appsOf(page)) }
                : {},
            next: (page) => {
              const first = Array.isArray(page["items"])
                ? page["items"][0] as { flowId?: unknown } | undefined
                : undefined
              return [
                ...(typeof first?.flowId === "string" && first.flowId.length > 0
                  ? [{
                    command: `flow show ${Presentation.quote(first.flowId)}`,
                    description: "Inspect a discovered flow"
                  }]
                  : []),
                { command: "flow plan --help", description: "See how to preview a flow before starting it" }
              ]
            }
          }
        )
    })
    .command("show", {
      description: "Show a discovered flow's identity and description",
      mcp: { annotations: { readOnlyHint: true } },
      args: flowArgs,
      options,
      run: (c) =>
        guard(c, async () => {
          const { items } = Bridge.isRemote(c.options, runtime)
            ? await Bridge.query(Effect.flatMap(Control.Control, FlowCatalog.read), c.options, runtime)
            : await Bridge.local(discovered(c.options, runtime), c.options, runtime)
          const flow = items.find((entry) => entry.flowId === c.args.flow)
          if (flow === undefined) {
            throw new CliError.Refused({
              fault: "user",
              code: "flow_not_found",
              message: `Unknown flow ${c.args.flow}`
            })
          }
          return flow
        })
    })
    .command("plan", {
      description: "Compile a flow plan and its approval payload without executing it",
      mcp: { annotations: { readOnlyHint: false } },
      args: flowArgs.extend({ input: z.array(z.string()).default([]).describe("Input fields as key=value") }),
      options: options.extend({ data: z.string().optional().describe("JSON input object") }),
      run: (c) =>
        guard(c, () =>
          Bridge.invoke(["plan", c.args.flow, ...c.args.input, ...dataArgs(c.options.data)], c.options, runtime), {
          next: [
            {
              command: "approvals approve --help",
              description: "Approve the returned plan.approval payload or an @file"
            },
            { command: "flow execute --help", description: "Execute that same payload after approval" }
          ]
        })
    })
    .command("start", {
      description: "Plan, approve, and start one flow; optionally detach after durable admission",
      mcp: false,
      args: flowArgs,
      options: options.extend({
        data: z.string().optional(),
        detached: z.boolean().default(false),
        wait: z.boolean().default(false).describe("Wait for the run's status before exiting"),
        budgetTokens: z.number().int().positive().optional().describe("Token ceiling for this run"),
        budgetMs: z.number().int().positive().optional().describe("Wall-clock ceiling in milliseconds for this run"),
        budgetUsd: z.number().positive().optional().describe("Dollar ceiling for this run"),
        onExceeded: z.enum(BudgetOnExceeded.literals).optional().describe("What the run does at a ceiling"),
        deadline: z.string().optional().describe(
          "Wall-clock time the run may take from its first start, as a duration (30 minutes) or milliseconds"
        )
      }),
      alias: { detached: "d" },
      run: (c) =>
        guard(c, async () => {
          if (c.options.wait && c.options.detached) {
            throw new CliError.UsageError({ message: "--wait and --detached cannot be combined" })
          }
          if (!Bridge.isRemote(c.options, runtime)) {
            const root = Project.root(c.options.root, process.cwd())
            if (!existsSync(join(root, "flows")) && !existsSync(join(root, ".flows"))) {
              throw new CliError.Refused({ fault: "user", code: "no_flows", message: `No flows found in ${root}` })
            }
          }
          return Bridge.invoke(
            [
              "up",
              c.args.flow,
              ...dataArgs(c.options.data),
              ...(c.options.wait ? ["--wait"] : []),
              ...(c.options.detached ? ["--detached"] : []),
              ...(c.options.budgetTokens === undefined ? [] : ["--budget-tokens", String(c.options.budgetTokens)]),
              ...(c.options.budgetMs === undefined ? [] : ["--budget-ms", String(c.options.budgetMs)]),
              ...(c.options.budgetUsd === undefined ? [] : ["--budget-usd", String(c.options.budgetUsd)]),
              ...(c.options.onExceeded === undefined ? [] : ["--on-exceeded", c.options.onExceeded]),
              ...(c.options.deadline === undefined ? [] : ["--deadline", c.options.deadline])
            ],
            c.options,
            runtime
          )
        })
    })
    .command("execute", {
      description: "Execute a previously approved plan payload",
      mcp: { annotations: { readOnlyHint: false } },
      args: z.object({ approval: z.string().describe("Serialized payload or @file") }),
      options,
      run: (c) =>
        guard(c, async () =>
          Bridge.invoke(["run", await payload(c.args.approval)], c.options, runtime))
    })

/**
 * Canonical commands for existing durable run records.
 * @category constructors
 * @since 1.0.0
 */
export const createRunsCli = (runtime: Bridge.Runtime = {}) =>
  Cli.create("runs", {
    description: "Inspect and control durable execution records"
  })
    .command("wait", {
      description: "Wait for a durable run to settle",
      mcp: false,
      args: runArgs,
      options: options.extend({
        timeout: z.number().int().nonnegative().optional().describe("Maximum wait in milliseconds")
      }),
      run: async (c) => {
        try {
          const row = await waitForRun(c.args.run, c.options.timeout, c.options, runtime)
          const code = waitCode(row.status)
          if (code !== 0) {
            return c.error({ code: row.status, message: `Run ${row.runId}: ${row.status}`, exitCode: code })
          }
          return Presentation.finish(c, row)
        } catch (cause) {
          return Presentation.fail(c, cause)
        }
      }
    })
    .command("list", {
      description: "List durable runs",
      mcp: { annotations: { readOnlyHint: true } },
      options: runFilters.extend({
        limit: z.number().int().min(1).max(500).optional().describe("Runs per page (default 100)"),
        cursor: z.string().optional().describe("Continue from the nextCursor a previous page printed")
      }),
      run: (c) =>
        guard(c, () =>
          observe<unknown>("runs list", c.options, runtime, { _tag: "runs", items: [] }, async () => {
            await reconcileHistory(c.options, runtime)
            return Bridge.read(
              Effect.gen(function*() {
                const listing = yield* RunListing.request(c.options, {
                  limit: c.options.limit,
                  cursor: c.options.cursor
                })
                const listed = yield* (yield* Control.Control).list(listing)
                return yield* RunListing.label(listed, yield* Clock.currentTimeMillis)
              }),
              c.options,
              runtime
            )
          }), { next: Presentation.runs({ otherwise: [runsList] }) })
    })
    .command("count", {
      description: "Count durable runs",
      mcp: { annotations: { readOnlyHint: true } },
      options: runFilters,
      run: (c) =>
        guard(c, () =>
          observe("runs count", c.options, runtime, { count: 0 }, async () => {
            await reconcileHistory(c.options, runtime)
            return Bridge.read(
              Effect.map(Effect.flatMap(RunListing.request(c.options), RunListing.count), (count) => ({ count })),
              c.options,
              runtime
            )
          }), { next: [runsList] })
    })
    .command("show", {
      description: "Show a run's current status and diagnosis",
      mcp: { annotations: { readOnlyHint: true } },
      args: runArgs,
      options,
      run: (c) =>
        guard(c, async () => {
          if (!Bridge.hasRecords(c.options, runtime)) {
            await Bridge.project(checks(c.options, runtime), c.options, runtime)
            throw unknownRun(c.args.run)
          }
          return observing("runs show", c.options, runtime, async () => {
            await reconcileHistory(c.options, runtime)
            return Bridge.read(
              Effect.gen(function*() {
                const control = yield* Control.Control
                const page = yield* control.list({ _tag: "runs", filters: { runId: c.args.run } })
                const run = page._tag === "runs" ? page.items.find((row) => row.runId === c.args.run) : undefined
                if (run === undefined) throw unknownRun(c.args.run)
                const events = yield* BoundedEvents.collect(control.watch({ runId: run.runId, follow: false }), {
                  operation: "run diagnosis",
                  subject: run.runId
                })
                return { ...run, diagnosis: Forensics.digest(events, run.runId) }
              }),
              c.options,
              runtime
            )
          })
        }, { next: Presentation.runs({ show: false }) })
    })
    .command("devtools", {
      description: "Inspect a run's node tree: state, timings, inputs, outputs and journal frames",
      mcp: { annotations: { readOnlyHint: true } },
      args: runArgs.extend({ node: z.string().optional().describe("A trace node id; the run itself when omitted") }),
      options: options.extend({
        frames: z.number().int().min(0).optional().describe(
          "Newest journal frames kept on the inspection; 100 by default"
        )
      }),
      run: (c) => {
        let human = ""
        return guard(c, async () => {
          if (!Bridge.hasRecords(c.options, runtime)) {
            await Bridge.project(checks(c.options, runtime), c.options, runtime)
            throw unknownRun(c.args.run)
          }
          return observing("runs devtools", c.options, runtime, async () => {
            await reconcileHistory(c.options, runtime)
            return Bridge.read(
              Effect.gen(function*() {
                const control = yield* Control.Control
                const page = yield* control.list({ _tag: "runs", filters: { runId: c.args.run } })
                const run = page._tag === "runs" ? page.items.find((row) => row.runId === c.args.run) : undefined
                if (run === undefined) throw unknownRun(c.args.run)
                const events = yield* BoundedEvents.collect(control.watch({ runId: run.runId, follow: false }), {
                  operation: "run devtools",
                  subject: run.runId
                })
                // The same fold the app's run card and the terminal read: one projection, three doors.
                const model = RunTrace.traceFromJournal(
                  { runId: run.runId, flowId: run.flowId, status: run.status },
                  events
                )
                const node = c.args.node
                if (node !== undefined && !model.rows.some((row) => row.id === node)) {
                  throw new CliError.Refused({
                    fault: "user",
                    code: "node_not_found",
                    message: `Run ${run.runId} has no trace node ${node}`
                  })
                }
                const bound = { frames: c.options.frames }
                human = RunDevTools.lines(model, node, { ...bound, width: runtime.stdout?.columns }).join("\n")
                return { ...RunDevTools.devTools(model), inspection: RunDevTools.inspect(model, node, bound) }
              }),
              c.options,
              runtime
            )
          })
        }, { next: Presentation.runs({ show: false }), render: () => ({ human }) })
      }
    })
    .command("logs", {
      description: "Read run events or follow new events as they commit",
      mcp: { annotations: { readOnlyHint: true } },
      args: runArgs,
      options: options.extend({
        follow: z.boolean().default(false),
        after: z.number().int().nonnegative().optional(),
        limit: z.number().int().min(1).max(10000).optional().describe(
          "Maximum events; agent history pulls default to 100"
        )
      }),
      async *run(c) {
        const policy = Presentation.current()?.policy ?? Presentation.policy(c, runtime)
        const limit = c.options.limit ??
          (policy.audience === "agent" && !c.options.follow ? 100 : Number.POSITIVE_INFINITY)
        const renderer = policy.structured ? undefined : RunProgress.make(c.args.run, {
          policy: { ...policy, progress: policy.progress === "silent" ? "plain" : policy.progress },
          output: Presentation.current()?.stdout ?? process.stdout
        })
        let count = 0
        let after = c.options.after
        try {
          if (!Bridge.hasRecords(c.options, runtime)) {
            await Bridge.project(checks(c.options, runtime), c.options, runtime)
            return
          }
          for await (
            const event of Bridge.events(c.args.run, c.options.follow, c.options, runtime, c.options.after)
          ) {
            after = event.sequence
            count++
            if (renderer === undefined) yield event
            else renderer.event(event)
            if (count >= limit) break
          }
          if (renderer === undefined && after !== undefined && count >= limit) {
            return c.ok({ events: count, after }, {
              cta: {
                commands: Presentation.nextActions({}, c, [{
                  command: `runs logs ${Presentation.quote(c.args.run)} --after ${after} --format jsonl`,
                  description: "Continue from the last returned event"
                }])
              }
            })
          }
        } catch (failure) {
          renderer?.close("failed")
          const cause = olderStore("runs logs", c.options, runtime, failure)
          return c.error({
            code: cause instanceof CliError.Refused ? cause.code : "logs_failed",
            message: String(Redaction.redactDiagnostic(Failure.operatorSentence(cause)))
          })
        } finally {
          renderer?.close("ended")
        }
      }
    })
    .command("output", {
      description: "Read recorded outputs for one node or all nodes",
      mcp: { annotations: { readOnlyHint: true } },
      args: runArgs.extend({ node: z.string().optional() }),
      options,
      run: (c) =>
        guard(c, () => Bridge.invoke(["output", c.args.run, ...(c.args.node ? [c.args.node] : [])], c.options, runtime))
    })
    .command("cancel", {
      description: "Cancel one durable run",
      mcp: { annotations: { readOnlyHint: false } },
      args: runArgs,
      options,
      run: (c) => guard(c, () => Bridge.invoke(["cancel", c.args.run], c.options, runtime))
    })
    .command("cancel-all", {
      description: "Cancel every nonterminal run in this project",
      mcp: { annotations: { readOnlyHint: false } },
      options,
      destructive: true,
      run: (c) =>
        guard(c, async () => {
          await reconcileHistory(c.options, runtime)
          return Bridge.query(cancelAll(), c.options, runtime)
        })
    })
    .command("resume", {
      description: "Resume a parked durable run",
      mcp: { annotations: { readOnlyHint: false } },
      args: runArgs,
      options: options.extend({
        allowCodeDrift: z.boolean().default(false).describe(
          "Resume even though the run's flow changed since it started"
        )
      }),
      run: (c) => {
        const { allowCodeDrift, ...connection } = c.options
        return guard(c, async () =>
          Bridge.invoke(["resume", c.args.run, ...(allowCodeDrift ? ["--allow-code-drift"] : [])], connection, {
            ...runtime,
            ...await prepareHistoryRun(c.args.run, connection, runtime)
          }))
      }
    })
    .command("continue", {
      description: "Continue a run a budget or time limit parked, under the allowance it recorded",
      mcp: false,
      args: runArgs,
      options,
      run: (c) =>
        guard(c, () =>
          decideIncident(c.args.run, "continue", c.options, runtime), { next: afterDecision })
    })
    .command("stop", {
      description: "Stop a run a budget or time limit parked",
      mcp: false,
      args: runArgs,
      options,
      run: (c) => guard(c, () => decideIncident(c.args.run, "stop", c.options, runtime), { next: afterDecision })
    })
    .command("signal", {
      description: "Deliver a durable JSON signal",
      mcp: { annotations: { readOnlyHint: false } },
      args: runArgs.extend({ payload: z.string() }),
      options,
      run: (c) => guard(c, () => Bridge.invoke(["signal", c.args.run, c.args.payload], c.options, runtime))
    })
    .command("steer", {
      description: "Send an attributed operator message",
      mcp: { annotations: { readOnlyHint: false } },
      args: runArgs,
      options: options.extend({ message: z.string().min(1) }),
      run: (c) =>
        guard(c, () => Bridge.invoke(["steer", c.args.run, "--message", c.options.message], c.options, runtime))
    })

const isIncident = Schema.is(ControlFacts.GuardIncident)

/**
 * The latest request a budget or time guard parked the run on, decided or not.
 *
 * A run that parks again after a Continue holds a newer request, so the
 * latest is the one an operator answers. The request's `incident` carries the
 * facts the guard froze when it tripped.
 *
 * @category constructors
 * @since 1.0.0
 */
export const guardIncident = (runId: string) =>
  Effect.gen(function*() {
    const control = yield* Control.Control
    const events = yield* BoundedEvents.collect(control.watch({ runId, follow: false }), {
      operation: "guard incident",
      subject: runId
    })
    const rows = ControlFacts.fold(events).approvals.flatMap((row) => {
      const incident = (row.request as { readonly incident?: unknown } | null)?.incident
      return row.runId === runId && isIncident(incident) ? [{ ...row, incident }] : []
    })
    return rows.at(-1)
  })

/**
 * Continue or Stop one guard incident from its recorded request.
 *
 * An undecided request is approved (Continue, under the allowance the request
 * recorded) or denied (Stop), and the decision drives the run in this call. A
 * request already decided the same way is not decided twice: the run resumes
 * from the recorded decision, which is how a decision whose driver died with
 * its process still settles the run. A request decided the other way is
 * refused.
 */
const decideIncident = async (
  runId: string,
  decision: "continue" | "stop",
  connection: Bridge.ConnectionOptions,
  runtime: Bridge.Runtime
): Promise<unknown> => {
  if (!Bridge.hasRecords(connection, runtime)) {
    await Bridge.project(checks(connection, runtime), connection, runtime)
    throw unknownRun(runId)
  }
  const row = await Bridge.read(guardIncident(runId), connection, runtime)
  if (row === undefined) {
    throw new CliError.Refused({
      fault: "user",
      code: "no_guard_incident",
      message: `Run ${runId} is not parked on a budget or time limit.`
    })
  }
  const wanted = decision === "continue" ? "approved" : "denied"
  if (row.status === "pending") {
    const approval = JSON.stringify(row.payload)
    return Bridge.invoke(
      decision === "continue" ? ["approve", approval, "--scope", row.payload.scope] : ["deny", approval],
      connection,
      runtime
    )
  }
  if (row.status !== wanted) {
    throw new CliError.Refused({
      fault: "user",
      code: "guard_incident_decided",
      message: `Run ${runId} was already ${row.status === "approved" ? "continued" : "stopped"} on ${row.requestId}.`
    })
  }
  return Bridge.invoke(["resume", runId], connection, {
    ...runtime,
    ...await prepareHistoryRun(runId, connection, runtime)
  })
}

const payload = async (value: string): Promise<string> => {
  if (!value.startsWith("@")) return value
  const path = value.slice(1)
  try {
    return await readFile(path, "utf8")
  } catch (cause) {
    const missing = (cause as { readonly code?: unknown } | null)?.code === "ENOENT"
    throw new CliError.Refused({
      fault: "user",
      code: "payload_unreadable",
      message: missing ? `The payload file ${path} does not exist.` : `The payload file ${path} cannot be read.`
    })
  }
}

/**
 * What a human wait asks, read off the run summary rather than the journal.
 *
 * A `HumanTask` journals nothing: it parks its own execution and declares the
 * question on the parked row, which the control plane rolls onto the root run
 * as `pendingWaits`. A digest of the root's events therefore has no parked
 * question at all for one — `smthrs approvals list` printed a run and no
 * question beside it (run-3, `coding-clarification`).
 */
const declaredQuestion = (run: ControlSchema.RunSummary): string | undefined => {
  for (const wait of run.pendingWaits ?? []) {
    const request = wait.request
    const prompt = typeof request === "object" && request !== null && !Array.isArray(request)
      ? (request as Record<string, unknown>)["prompt"]
      : undefined
    if (typeof prompt === "string") return prompt
    if (wait.name !== undefined) return `Answer needed — ${wait.name}`
  }
  return undefined
}

/**
 * Pending in-run approvals, including pages beyond the first.
 *
 * A run whose whole TREE is waiting on a person is one of these: the control
 * plane rolls a nested `HumanTask` park up to `waiting-approval`, so the
 * filter finds the root, and `waits` names the open questions beneath it.
 *
 * @category constructors
 * @since 1.0.0
 */
export const pendingApprovals = (runId?: string) =>
  Effect.gen(function*() {
    const control = yield* Control.Control
    const runs: Array<ControlSchema.RunSummary> = []
    let cursor: string | undefined
    do {
      const page = yield* control.list({
        _tag: "runs",
        filters: { status: "waiting-approval", ...(runId ? { runId } : {}) },
        ...(cursor ? { cursor } : {})
      })
      if (page._tag !== "runs") return yield* Effect.fail(unexpectedRunList())
      runs.push(...page.items)
      cursor = page.nextCursor
    } while (cursor !== undefined)
    return yield* Effect.forEach(runs, (run) =>
      Effect.gen(function*() {
        const events = yield* BoundedEvents.collect(control.watch({ runId: run.runId, follow: false }), {
          operation: "pending approval",
          subject: run.runId
        })
        const digest = Forensics.digest(events, run.runId)
        const waits = run.pendingWaits ?? []
        return {
          runId: run.runId,
          flowId: run.flowId,
          question: digest.parkedQuestion ?? declaredQuestion(run),
          approval: digest.parkedApproval,
          ...(digest.parkedIncident === undefined ? {} : { incident: digest.parkedIncident }),
          // The open human waits in this run's tree, each naming the execution
          // holding it and the wait point a signal addresses.
          ...(waits.length === 0 ? {} : {
            waits: waits.map((wait) => ({
              runId: wait.runId,
              ...(wait.flowId === undefined ? {} : { flowId: wait.flowId }),
              ...(wait.name === undefined ? {} : { name: wait.name }),
              ...(wait.attempt === undefined ? {} : { attempt: wait.attempt }),
              ...(wait.request === undefined ? {} : { request: wait.request })
            }))
          })
        }
      }))
  })

/**
 * Pending decisions and approval payload submission.
 * @category constructors
 * @since 1.0.0
 */
export const createApprovalsCli = (runtime: Bridge.Runtime = {}) =>
  Cli.create("approvals", { description: "Find and resolve pending approval requests" })
    .command("list", {
      description: "List pending in-run approvals with their exact authorization payloads",
      mcp: { annotations: { readOnlyHint: true } },
      options: options.extend({
        run: z.string().optional(),
        targets: z.boolean().optional().describe("List pending build target revisions instead")
      }),
      run: (c) =>
        guard(
          c,
          (): Promise<ReadonlyArray<unknown>> =>
            c.options.targets === true
              ? observe(
                "approvals list",
                c.options,
                runtime,
                [],
                () => Bridge.read(TargetApprovals.pending, c.options, runtime)
              )
              : observe(
                "approvals list",
                c.options,
                runtime,
                [],
                () => Bridge.read(pendingApprovals(c.options.run), c.options, runtime)
              ),
          { next: afterDecision }
        )
    })
    .command("approve", {
      description: "Approve the exact serialized payload or @file",
      mcp: false,
      args: z.object({ approval: z.string() }),
      options: options.extend({ scope: z.enum(["once", "run", "remembered"]).default(defaultApprovalScope) }),
      run: (c) =>
        guard(
          c,
          async () =>
            Bridge.invoke(["approve", await payload(c.args.approval), "--scope", c.options.scope], c.options, runtime),
          { next: afterDecision }
        )
    })
    .command("deny", {
      description: "Deny the exact serialized payload or @file",
      mcp: false,
      args: z.object({ approval: z.string() }),
      options,
      run: (c) =>
        guard(c, async () => Bridge.invoke(["deny", await payload(c.args.approval)], c.options, runtime), {
          next: afterDecision
        })
    })
    .command("grant", {
      description: "Approve the current revision of a build target that declares approval: \"required\"",
      mcp: false,
      args: z.object({ target: z.string() }),
      options: options.pick({ root: true, quiet: true, remote: true }).extend({
        input: z.array(z.string()).optional().describe("Payload input the target runs with, as name=value; repeatable"),
        revision: z.string().optional().describe("The pending revision to approve, from approvals list --targets")
      }),
      run: (c) =>
        guard(c, async () => {
          // A remote control plane, or a named revision, grants a revision its
          // build left pending; otherwise the workspace names the current one.
          if (Bridge.isRemote(c.options, runtime) || c.options.revision !== undefined) {
            return Bridge.query(TargetApprovals.grantPending(c.args.target, c.options.revision), c.options, runtime)
          }
          const request = await approvalRevision(c.args.target, {
            workspace: c.options.root ?? process.cwd(),
            input: c.options.input
          }, runtime)
          return Bridge.query(TargetApprovals.grant(request), { ...c.options, root: request.root }, runtime)
        })
    })
