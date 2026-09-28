/**
 * Durable flow, run, and approval commands for the unified CLI.
 * @since 1.0.0
 */

import { Control, type ControlSchema } from "@smthrs/control"
import * as Redaction from "@smthrs/journal/Redaction"
import { Effect } from "effect"
import { Cli, z } from "incur"
import { readFile } from "node:fs/promises"
import { cancelAll } from "../commands/CancelAll.ts"
import * as FlowCatalog from "../commands/FlowCatalog.ts"
import * as Globals from "../commands/Globals.ts"
import * as Forensics from "../Forensics.ts"
import { defaultApprovalScope } from "../internal/ApprovalScope.ts"
import * as BoundedEvents from "../internal/BoundedEvents.ts"
import * as FeaturedFlows from "../internal/FeaturedFlows.ts"
import * as Project from "../Project.ts"
import * as Bridge from "./ControlBridge.ts"
import { prepareHistoryRun, reconcileHistory } from "./HistoryCommands.ts"
import * as Presentation from "./Presentation.ts"
import * as RunProgress from "./RunProgress.ts"

export { cancelAll }

const options = Bridge.connectionOptions
const runArgs = z.object({ run: z.string().min(1).describe("Durable run ID") })
const flowArgs = z.object({ flow: z.string().min(1).describe("Discovered flow name") })
const statuses = ["accepted", "running", "parked", "waiting-approval", "cancelled", "completed", "failed"] as const

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

/** An observing verb's answer: `empty` when there are no records to read. */
const observe = async <A>(
  connection: Bridge.ConnectionOptions,
  runtime: Bridge.Runtime,
  empty: A,
  read: () => Promise<A>
): Promise<A> =>
  Bridge.hasRecords(connection, runtime)
    ? read()
    : Bridge.project(Effect.as(checks(connection, runtime), empty), connection, runtime)

const unknownRun = (runId: string) => new Error(`Unknown run ${runId}`)

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
          if (flow === undefined) throw new Error(`Unknown flow ${c.args.flow}`)
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
      options: options.extend({ data: z.string().optional(), detached: z.boolean().default(false) }),
      alias: { detached: "d" },
      run: (c) =>
        guard(c, () =>
          Bridge.invoke(
            ["up", c.args.flow, ...dataArgs(c.options.data), ...(c.options.detached ? ["--detached"] : [])],
            c.options,
            runtime
          ))
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
    .command("list", {
      description: "List durable runs filtered by flow or status",
      mcp: { annotations: { readOnlyHint: true } },
      options: options.extend({ flow: z.string().optional(), status: z.enum(statuses).optional() }),
      run: (c) =>
        guard(c, () =>
          observe<unknown>(c.options, runtime, { _tag: "runs", items: [] }, async () => {
            await reconcileHistory(c.options, runtime)
            return Bridge.invoke(
              [
                "ps",
                ...(c.options.flow ? ["--flow", c.options.flow] : []),
                ...(c.options.status ? ["--status", c.options.status] : [])
              ],
              c.options,
              runtime
            )
          }), { next: Presentation.runs({ otherwise: [runsList] }) })
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
          await reconcileHistory(c.options, runtime)
          return Bridge.query(
            Effect.gen(function*() {
              const control = yield* Control.Control
              const page = yield* control.list({ _tag: "runs", filters: { runId: c.args.run } })
              const run = page._tag === "runs" ? page.items.find((row) => row.runId === c.args.run) : undefined
              if (run === undefined) throw unknownRun(c.args.run)
              const events = yield* BoundedEvents.collect(control.watch({ runId: run.runId, follow: false }), {
                operation: "run diagnosis",
                subject: run.runId
              })
              return { ...run, diagnosis: Forensics.digest(events) }
            }),
            c.options,
            runtime
          )
        }, { next: Presentation.runs({ show: false }) })
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
        } catch (cause) {
          renderer?.close("failed")
          return c.error({
            code: "logs_failed",
            message: String(Redaction.redact(cause instanceof Error ? cause.message : String(cause)))
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
    .command("signal", {
      description: "Deliver a durable JSON signal",
      mcp: { annotations: { readOnlyHint: false } },
      args: runArgs.extend({ payload: z.string() }),
      options,
      run: (c) =>
        guard(c, () =>
          Bridge.invoke(["signal", c.args.run, c.args.payload], c.options, runtime))
    })
    .command("steer", {
      description: "Send an attributed operator message",
      mcp: { annotations: { readOnlyHint: false } },
      args: runArgs,
      options: options.extend({ message: z.string().min(1) }),
      run: (c) =>
        guard(c, () => Bridge.invoke(["steer", c.args.run, "--message", c.options.message], c.options, runtime))
    })

const payload = async (value: string): Promise<string> =>
  value.startsWith("@") ? readFile(value.slice(1), "utf8") : value

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
      if (page._tag !== "runs") throw new Error("Expected durable runs")
      runs.push(...page.items)
      cursor = page.nextCursor
    } while (cursor !== undefined)
    return yield* Effect.forEach(runs, (run) =>
      Effect.gen(function*() {
        const events = yield* BoundedEvents.collect(control.watch({ runId: run.runId, follow: false }), {
          operation: "pending approval",
          subject: run.runId
        })
        const digest = Forensics.digest(events)
        const waits = run.pendingWaits ?? []
        return {
          runId: run.runId,
          flowId: run.flowId,
          question: digest.parkedQuestion ?? declaredQuestion(run),
          approval: digest.parkedApproval,
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
      options: options.extend({ run: z.string().optional() }),
      run: (c) =>
        guard(
          c,
          () =>
            observe(c.options, runtime, [], () => Bridge.query(pendingApprovals(c.options.run), c.options, runtime)),
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
