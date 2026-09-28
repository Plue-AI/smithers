/**
 * `smthrs claude`: the Claude Code mirror's tick, node-wait, monitor, and
 * subscription verbs, as an Effect CLI command group.
 *
 * @since 1.0.0
 */

import { Control as ControlService, type ControlSchema } from "@smthrs/control"
import { Console, Effect, Option, Stream } from "effect"
import { type Argument, Command, Flag } from "effect/unstable/cli"
import * as ClaudeMirror from "../ClaudeMirror.ts"
import * as CliError from "../CliError.ts"
import * as Forensics from "../Forensics.ts"
import * as BoundedEvents from "../internal/BoundedEvents.ts"
import * as NodeOutput from "../NodeOutput.ts"
import { Output } from "../Output.ts"
import * as Project from "../Project.ts"
import * as Verb from "../Verb.ts"
import * as RunReads from "./RunReads.ts"
import * as Settlement from "./Settlement.ts"

/**
 * What the command group borrows from the root tree it is composed into.
 * @category models
 * @since 1.0.0
 */
export interface Options<E, R> {
  /** The shared pre-handler every verb runs first. */
  readonly guard: Effect.Effect<void, E, R>
  /** A required positional argument, with the tree's fallback prompt. */
  readonly required: (name: string) => Argument.Argument<string>
}

const claudeSession = Flag.String("session").pipe(
  Flag.optional,
  Flag.withDescription("Claude Code session id; falls back to CLAUDE_CODE_SESSION_ID")
)

const sessionId = (raw: Option.Option<string>): string =>
  Option.getOrElse(raw, () => process.env["CLAUDE_CODE_SESSION_ID"] ?? "unknown")

/** Forces JSON rendering: every mirror verb prints a machine document. */
const renderJson = (value: unknown) =>
  Effect.gen(function*() {
    const output = yield* Output
    const rendered = yield* output.render(value, "json")
    yield* Console.log(rendered.text)
  })

/**
 * The `claude` command group.
 * @category constructors
 * @since 1.0.0
 */
export const make = <E, R>({ guard, required }: Options<E, R>) => {
  const tick = Command.make("tick", {
    runId: required("run-id"),
    session: claudeSession,
    afterSeq: Flag.Int("after-seq").pipe(
      Flag.withDefault(0),
      Flag.withDescription("Only include events after this sequence number")
    )
  }, (config) =>
    Effect.gen(function*() {
      yield* guard
      const control = yield* ControlService.Control
      const projectRoot = yield* Project.ProjectRoot
      // Following a run is subscribing: every tick re-asserts the entry, so a
      // registry lost to a crash repairs itself on the next frame.
      yield* Effect.sync(() => ClaudeMirror.subscribe(projectRoot, config.runId, sessionId(config.session)))
      const collected = yield* RunReads.events(control, config.runId)
      const run = yield* RunReads.summary(control, config.runId)
      const digest = Forensics.digest(collected, config.runId)
      yield* renderJson(
        ClaudeMirror.frame(config.runId, run, collected, {
          afterSeq: config.afterSeq,
          parked: { question: digest.parkedQuestion, approval: digest.parkedApproval }
        })
      )
    })).pipe(Command.withDescription("Print one mirror frame for a run"))

  const nodeWait = Command.make("node-wait", {
    runId: required("run-id"),
    nodeId: required("node-id"),
    timeout: Flag.Int("timeout-ms").pipe(
      Flag.withDefault(30_000),
      Flag.withDescription("Maximum time in milliseconds to wait for the node to settle")
    )
  }, (config) =>
    Effect.gen(function*() {
      yield* guard
      const control = yield* ControlService.Control
      yield* RunReads.existing(control, config.runId)
      const deadline = Date.now() + config.timeout
      const history = BoundedEvents.empty<ControlSchema.ControlEvent>()
      let afterSequence: number | undefined
      for (;;) {
        const previousLength = history.values.length
        yield* BoundedEvents.collectInto(
          control.watch({
            runId: config.runId,
            follow: false,
            ...(afterSequence === undefined ? {} : { afterSequence })
          }),
          history,
          { operation: "node wait", subject: `run ${JSON.stringify(config.runId)}` }
        ).pipe(
          Effect.mapError((error) =>
            error instanceof CliError.ResourceLimitError
              ? error
              : Settlement.watchFailure(error, config.runId, "node wait")
          )
        )
        for (let index = previousLength; index < history.values.length; index++) {
          const event = history.values[index]!
          if (afterSequence === undefined || event.sequence > afterSequence) afterSequence = event.sequence
        }
        const node = NodeOutput.find(history.values, config.nodeId)
        if (node !== undefined && node.outcome !== "pending") return yield* renderJson({ ...node, timedOut: false })
        const run = yield* RunReads.summary(control, config.runId)
        if (run !== undefined && ClaudeMirror.isTerminal(run.status)) {
          return yield* renderJson({ nodeId: config.nodeId, outcome: "vanished", status: run.status, timedOut: false })
        }
        if (Date.now() >= deadline) {
          return yield* renderJson({ nodeId: config.nodeId, outcome: "pending", timedOut: true })
        }
        yield* Effect.sleep("250 millis")
      }
    })).pipe(Command.withDescription("Block until one node settles"))

  const monitor = Command.make("monitor", {
    session: claudeSession,
    allRuns: Flag.Boolean("all-runs").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Include all runs, beyond this session’s subscriptions")
    ),
    limit: Flag.Int("limit").pipe(
      Flag.withDefault(200),
      Flag.withDescription("Maximum number of runs in the monitor frame")
    )
  }, (config) =>
    Effect.gen(function*() {
      yield* guard
      if (!Number.isSafeInteger(config.limit) || config.limit <= 0) {
        return yield* Effect.fail(
          new CliError.UsageError({
            message: `--limit must be a positive integer; got ${JSON.stringify(String(config.limit))}`
          })
        )
      }
      const control = yield* ControlService.Control
      const projectRoot = yield* Project.ProjectRoot
      const followed = config.allRuns
        ? undefined
        : new Set(
          ClaudeMirror.readSubscriptions(projectRoot)
            .filter((entry) => entry.sessionId === sessionId(config.session))
            .map((entry) => entry.runId)
        )
      type Transition = NonNullable<ReturnType<typeof ClaudeMirror.transition>>
      const ring = yield* Stream.runFold(
        control.watch({ follow: false }),
        () => ({ values: [] as Array<Transition | undefined>, next: 0, count: 0 }),
        (state, event) => {
          const line = ClaudeMirror.transition(event)
          if (line === undefined || (followed !== undefined && !followed.has(line.runId))) return state
          state.values[state.next] = line
          state.next = (state.next + 1) % config.limit
          state.count = Math.min(config.limit, state.count + 1)
          return state
        }
      )
      for (let offset = 0; offset < ring.count; offset++) {
        const index = (ring.next - ring.count + offset + config.limit) % config.limit
        const line = ring.values[index]
        if (line !== undefined) yield* Console.log(JSON.stringify(line))
      }
    })).pipe(Command.withDescription("Print notable run transitions as NDJSON"))

  const subscribe = Command.make("subscribe", {
    runId: required("run-id"),
    session: claudeSession
  }, (config) =>
    Effect.gen(function*() {
      yield* guard
      const projectRoot = yield* Project.ProjectRoot
      const entries = yield* Effect.sync(() =>
        ClaudeMirror.subscribe(projectRoot, config.runId, sessionId(config.session))
      )
      yield* renderJson({ subscriptions: entries.length })
    })).pipe(Command.withDescription("Follow a run in this session's mirror"))

  const unsubscribe = Command.make("unsubscribe", {
    runId: required("run-id"),
    session: claudeSession
  }, (config) =>
    Effect.gen(function*() {
      yield* guard
      const projectRoot = yield* Project.ProjectRoot
      const entries = yield* Effect.sync(() =>
        ClaudeMirror.unsubscribe(projectRoot, config.runId, sessionId(config.session))
      )
      yield* renderJson({ subscriptions: entries.length })
    })).pipe(Command.withDescription("Stop following a run in this session's mirror"))

  return Command.make("claude").pipe(
    Command.withDescription(Verb.find("claude")!.help),
    Command.withSubcommands([tick, nodeWait, monitor, subscribe, unsubscribe])
  )
}
