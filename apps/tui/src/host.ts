import * as Log from "./log.ts"
/**
 * The agent host: one in-process Smithers cell harness bound to a directory.
 *
 * A turn is one `Agent.run` executed as one durable flow on an in-memory
 * engine. Every `AgentEvent` the run emits reaches `onEvent` as it happens,
 * so the UI renders cells while the model is still writing them.
 *
 * The agent has no tools. It writes JavaScript cells that call flows through
 * `ctx.call`; the standard filesystem and shell flows are the catalog here.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Agent from "@smthrs/agent/Agent"
import * as AgentSession from "@smthrs/agent/AgentSession"
import * as Budget from "@smthrs/agent/Budget"
import * as Memory from "@smthrs/agent/Memory"
import * as QuotaPolicy from "@smthrs/agent/QuotaPolicy"
import * as Seat from "@smthrs/agent/Seat"
import * as SeatResolver from "@smthrs/agent/SeatResolver"
import * as SeatRouter from "@smthrs/agent/SeatRouter"
import * as StandardFlows from "@smthrs/agent/StandardFlows"
import * as WorkspaceObservation from "@smthrs/agent/WorkspaceObservation"
import * as Capability from "@smthrs/capability/Capability"
import type * as Permission from "@smthrs/capability/Permission"
import * as NodeControl from "@smthrs/cli/NodeControl"
import { FlowEngine } from "@smthrs/engine"
import { Flow, FlowRuntime } from "@smthrs/flow"
import type * as AgentEvent from "@smthrs/harness/AgentEvent"
import * as CompletionClaim from "@smthrs/harness/CompletionClaim"
import type * as FlowBinding from "@smthrs/harness/FlowBinding"
import * as Sandbox from "@smthrs/harness/Sandbox"
import * as Steering from "@smthrs/harness/Steering"
import * as CapabilitySet from "@smthrs/kernel/CapabilitySet"
import * as GrantStore from "@smthrs/kernel/GrantStore"
import * as KernelHttpClient from "@smthrs/kernel/HttpClient"
import * as Rooted from "@smthrs/kernel/Rooted"
import * as Evaluator from "@smthrs/model/Evaluator"
import * as FailureCopy from "@smthrs/model/FailureCopy"
import * as ModelEvent from "@smthrs/model/ModelEvent"
import * as ModelRequest from "@smthrs/model/ModelRequest"
import * as RequestExecutor from "@smthrs/model/RequestExecutor"
import { Node } from "@smthrs/plan"
import * as Registry from "@smthrs/registry/Registry"
import * as NativeSearch from "@smthrs/std/NativeSearch"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, ManagedRuntime, Result, Schema, Scope, Stream } from "effect"
import * as ServiceContext from "effect/Context"
import type * as FileSystem from "effect/FileSystem"
import type * as Path from "effect/Path"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { realpathSync } from "node:fs"
import { basename, dirname, join, relative, resolve, sep } from "node:path"
import type * as Agents from "./agents.ts"
import * as Approvals from "./approvals.ts"
import * as Box from "./box.ts"
import * as Changes from "./changes.ts"
import * as Context from "./context.ts"
import { type Available, delegateModels, detectWithoutClaude, routing, workerFallbackSeats } from "./models.ts"
import * as Monitors from "./monitors.ts"
import * as Panels from "./panels.ts"
import * as Replay from "./replay.ts"
import * as Runtime from "./runtime.ts"
import * as Session from "./session.ts"
import * as Subprocess from "./subprocess.ts"
import * as Transcript from "./transcript.ts"

export type { Box } from "./box.ts"

/** How a turn ended. */
export type Outcome =
  /** `unchecked`: the run finished but no judge could check `answer`. */
  | { readonly _tag: "done"; readonly answer: string; readonly unchecked?: true }
  | { readonly _tag: "failed"; readonly message: string; readonly detail: string; readonly error?: unknown }
  | { readonly _tag: "cancelled" }

export interface TurnInput {
  readonly prompt: string
  readonly role?: "coordinator" | "worker"
  readonly runtime?: Runtime.Ports
  readonly workerSeat?: string
  readonly background?: string
  readonly onCaption?: (prose: string) => void
  readonly onPatch?: (receipt: Changes.Receipt) => void
  /** `Seat.auto` asks Jev for the seat when the run starts; see `Host.routes`. */
  readonly seat: string
  /** The route and system-prompt variant Jev routed an `auto` run to, before it resolves. */
  readonly onSeat?: (routed: SeatRouter.Route & { readonly variant: string | null }) => void
  /** The variant a retried or resumed run was routed to; the catalog must still offer it. */
  readonly variant?: string
  /** The backups and panel a retried or resumed run was routed to, with `seat`. */
  readonly route?: Omit<SeatRouter.Route, "seat">
  /** A panel run's own share of the worker's cap; such a run raises no cap alert. The host's own when absent. */
  readonly budget?: Budget.Service
  /** A panel's member answers from an earlier launch of this worker; those members are not run again. */
  readonly answered?: ReadonlyArray<readonly [seat: string, answer: string]>
  /** A panel member answered. */
  readonly onAnswered?: (seat: string, answer: string) => void
  /** A panel's members started (`true`) or ended (`false`); the merger runs after. */
  readonly onMembers?: (running: boolean) => void
  readonly fallbackSeats?: ReadonlyArray<string>
  /** A worker's remaining capacity parks; `QuotaPolicy.defaultMaxParks` when absent. Zero fails on the next refusal. */
  readonly maxParks?: number
  /** Who waits on an approval: `chat` (the default) or a worker tab id. */
  readonly source?: string
  readonly history: ReadonlyArray<Context.Entry>
  /** Where messages typed mid-turn wait for the next cell boundary. */
  readonly steering?: Steering.Source
  /** Reasoning effort; the agent's `effort`, then the provider's default, when absent. */
  readonly thinking?: ModelRequest.ReasoningEffort
  /** A custom agent's prompt, flows, envelope and effort, applied to a worker turn. */
  readonly agent?: Agents.Profile
  /** Caps the person raised for this worker's run; the host's own otherwise. */
  readonly caps?: Caps
  /** Async listeners can backpressure an unparked worker until a pool seat opens. */
  readonly onEvent: (event: AgentEvent.AgentEvent) => unknown
}

/** A worker's run cap as a multiple of the host's, so it follows the operator's cap up or down. */
export interface Caps {
  readonly times?: number
}

/** `policy` with the run cap the person chose: `times` the host's own. */
export const raised = (policy: Budget.Policy, caps: Caps): Budget.Policy =>
  caps.times === undefined || policy.tokens === undefined
    ? policy
    : { ...policy, tokens: { ...policy.tokens, max: policy.tokens.max * caps.times } }

export interface Turn {
  readonly done: Promise<Outcome>
  readonly cancel: () => void
}

export interface Host {
  readonly cwd: string
  /** The host's run token cap; absent when it is off. */
  readonly runCap?: number
  /**
   * `ctx.call("memory", {task})` for a launch outside a cell: what a wrapped harness is told it knows.
   * Absent where the host has no memory flow.
   */
  readonly memory?: (
    task: string
  ) => Promise<{
    readonly text: string
    readonly kept: number
    readonly withheld: number
    /** Set when Jev did not judge the block: it holds the seeds and facts alone. */
    readonly unjudged?: Memory.Output["unjudged"]
  }>
  /** A one-line tab description, asked of `seat`: the seat the task already goes to. */
  readonly describe?: (input: { title: string; prompt: string; seat: string }) => Promise<string>
  /** Jev judges a monitor's change; Luna writes its update. Absent on test fakes. */
  readonly monitor?: {
    readonly judge: (input: Monitors.Judged) => Promise<boolean>
    readonly compose: (input: Monitors.Judged) => Promise<string>
  }
  readonly complete?: (input: { system: string; prompt: string; seat: string }) => Promise<string>
  /** Whether the host judges worker completions and binds `jev`. */
  readonly judged: boolean
  /** Whether a worker with no chosen model runs on `Seat.auto`; false on test fakes. */
  readonly routes?: boolean
  readonly run: (input: TurnInput) => Turn
  /** Absent on hosts that approve nothing, such as test fakes. */
  readonly approvals?: {
    readonly mode: Approvals.Mode
    readonly authorize: (requests: ReadonlyArray<Approvals.Request>, signal?: AbortSignal) => Promise<void>
    readonly pending: () => Promise<ReadonlyArray<Approvals.Pending>>
    /** Resolves with the store's error code when it refused the answer. */
    readonly reply: (
      request: Approvals.Pending,
      choice: Approvals.Choice
    ) => Promise<Permission.GrantStoreError["code"] | undefined>
  }
  readonly dispose: () => Promise<void>
}

/**
 * Bun's fetch is the transport. It honours `HTTPS_PROXY`/`NO_PROXY` itself;
 * the Undici client `smithers run` uses cannot run under Bun, which the
 * renderer requires.
 */
const executor = RequestExecutor.layer.pipe(
  Layer.provide(KernelHttpClient.layer),
  // Model seat HTTP only; tool calls are authorized by `Approvals.layer` below.
  // eslint-disable-next-line no-restricted-syntax -- model HTTP, see above
  Layer.provide(GrantStore.layerNoop),
  Layer.provide(FetchHttpClient.layer)
)

const registry = Registry.makeNoop()

/**
 * Edits are compensable actions, and the engine admits them only under a
 * snapshot boundary. This one records the boundary and restores nothing,
 * like `smithers suggest`: the working tree's own VCS is the undo here.
 */
const snapshots = Layer.succeed(FlowEngine.SnapshotBoundary)({
  snapshot: (options) => Effect.succeed({ boundary: "smithers-tui", key: options.key }),
  restore: () => Effect.void,
  diff: () => Effect.succeed(undefined)
})

const turnFlow = (index: number) =>
  Flow.make(`tui/turn-${index}`, {
    payload: {},
    success: Schema.Unknown,
    error: Schema.Unknown,
    // Inert: the registered handler below is the whole turn.
    body: () => Node.succeed(undefined)
  })

/** Resolve aliases even before a lazily-created session directory exists. */
const physicalPath = (path: string): string => {
  let ancestor = resolve(path)
  const missing: Array<string> = []
  for (;;) {
    try {
      return join(realpathSync(ancestor), ...missing.toReversed())
    } catch {
      const parent = dirname(ancestor)
      if (parent === ancestor) return resolve(path)
      missing.push(basename(ancestor))
      ancestor = parent
    }
  }
}

/** A panel member only answers its task: every runtime port refuses. */
const memberRefusal = "A panel member only answers its task; it cannot publish, delegate, wait, ask or answer"
const memberPorts: Runtime.Ports = {
  publish: () => {
    throw new Error(memberRefusal)
  },
  delegate: () => {
    throw new Error(memberRefusal)
  },
  wait: () => Promise.reject(new Error(memberRefusal)),
  ask: () => Promise.reject(new Error(memberRefusal)),
  answer: () => {
    throw new Error(memberRefusal)
  }
}

/** Builds a host for `cwd`. The runtime is shared by every turn. */
export const make = (options: {
  readonly cwd: string
  /** The credentials environment; see `models.ts` `detect`. */
  readonly environment: Readonly<Record<string, string | undefined>>
  /** The startup seat scan, including Claude Code, when one was performed. */
  readonly available?: Available
  /** How consequential flow calls are approved; see `approvals.ts`. Default `ask`. */
  readonly approvals?: Approvals.Mode
  /** Test seam for the ordinary flow-call ceiling. */
  readonly callMs?: number
  /** Test seam for the frame backstop. */
  readonly totalMs?: number
  /** Test seam for the judge; the native Jev judge (Luna backup) when absent. */
  readonly judge?: Layer.Layer<Evaluator.Evaluator>
  /** Each turn's and worker's spend ceiling; see `budget.ts`. Unbounded when absent. */
  readonly budget?: Budget.Policy
  /** Durable spend for `budget.daily` and for recovering a run's spend; see `spend.ts`. */
  readonly ledger?: Budget.Ledger
  /** Test seam for the seat resolver; the native one when absent. */
  readonly seats?: Layer.Layer<SeatResolver.SeatResolver>
  /** Where a worker's filesystem and shell flows run; this machine when absent. */
  readonly box?: Box.Box
}): Host => {
  const approvalMode = options.approvals ?? "ask"
  const env = options.environment
  const available = options.available ?? detectWithoutClaude(env)
  const judge = options.judge ?? NodeControl.layerSeatEvaluator(env).pipe(Layer.provide(executor))
  const catalog = routing(available, env, true)
  // The operator's stance, validated where `smithers run` validates it.
  const stance = NodeControl.supervisorStance(env)
  const ledgerOptions = options.ledger === undefined ? {} : { ledger: options.ledger }
  // The local TUI runs without an approved envelope, so it is unbounded unless the operator sets a ceiling.
  const budget = options.budget === undefined
    // eslint-disable-next-line no-restricted-syntax -- no envelope, see above
    ? Budget.layerUnbounded()
    // `budget.ts` validated the policy; a refusal here is a defect.
    : Layer.orDie(Budget.layer(options.budget, ledgerOptions))
  const layer = Layer.mergeAll(
    Agent.layer.pipe(Layer.provide(Layer.mergeAll(QuotaPolicy.layerDefault(), budget))),
    Agent.layerDefaults,
    options.seats ?? NodeControl.layerSeatResolver(env).pipe(Layer.provide(executor)),
    judge,
    QuotaPolicy.layerDefault(),
    budget,
    FlowEngine.layerMemory,
    snapshots,
    // Measures the tree at both ends of every worker frame. Without it a sealed read
    // is keyed on no workspace digest and replays its first answer after an
    // edit: write "one", read, write "two", read returned "one" twice.
    NodeControl.layerObserver(options.cwd, {
      // Only our owned subtree and log, never every directory named "sessions"
      // or the configured root itself (which may be the project directory).
      excludePaths: [Session.directory(options.cwd), Log.path()].map((path) =>
        relative(physicalPath(options.cwd), physicalPath(path)).split(sep).join("/")
      )
    }),
    // Model HTTP keeps the noop store `executor` provides; this one only
    // answers `authorize` below.
    Approvals.layer(options.cwd, approvalMode),
    NodeCrypto.layer,
    // Relative flow paths and commands resolve against `cwd`, never the process's own.
    Rooted.layer(options.cwd).pipe(Layer.provideMerge(NodeServices.layer))
  )
  const runtime = ManagedRuntime.make(layer)
  let turns = 0
  const hostId = crypto.randomUUID().slice(0, 8)

  // What a wrapped harness is told: the same selection a worker opens with.
  const memory: NonNullable<Host["memory"]> = (task) =>
    runtime.runPromise(
      Effect.map(Memory.select({ task }, { root: options.cwd }), ({ output }) => ({
        text: output.context,
        kept: output.kept.length,
        withheld: output.omitted.length,
        ...(output.unjudged === undefined ? {} : { unjudged: output.unjudged })
      }))
    )

  const complete: NonNullable<Host["complete"]> = ({ system, prompt, seat: id }) =>
    runtime.runPromise(
      Effect.gen(function*() {
        const seat = yield* (yield* SeatResolver.SeatResolver).resolve(id)
        const events = Array.from(
          yield* Stream.runCollect(seat.model.stream(ModelRequest.ModelRequest.make({
            // The seat's own model id: the full `provider:model` seat is refused as a model name.
            modelId: seat.modelId,
            system: [ModelRequest.SystemPart.make({ text: system })],
            messages: [ModelRequest.Message.user([ModelRequest.TextPart.make({ text: prompt })])],
            tools: [],
            toolChoice: "none",
            // No token budget: the ChatGPT-subscription route refuses `maxTokens`
            // (`OpenAIResponses.chatgptFromRequest`) and no seat says which routes
            // honor one. The system prompt bounds the answer instead.
            params: ModelRequest.GenerationParams.make({})
          })))
        )
        if (ModelEvent.ModelEvent.settledMessage(events).message.stopReason !== "stop") {
          throw new Error("Answer incomplete")
        }
        return events.flatMap((event) => event.type === "text-delta" ? [event.text] : []).join("")
      })
    )

  const monitor: NonNullable<Host["monitor"]> = {
    judge: Monitors.jev((request) =>
      runtime.runPromise(Effect.gen(function*() {
        return yield* (yield* Evaluator.Evaluator).evaluate(request)
      }))
    ),
    compose: (input) =>
      complete({ system: Monitors.composeSystem, prompt: Monitors.composeText(input), seat: delegateModels.luna })
  }

  const describeTab: NonNullable<Host["describe"]> = ({ title, prompt, seat }) =>
    complete({
      system:
        "Summarize this background agent task in one short line (at most 80 characters). Reply with only the description.",
      prompt: `Title: ${title}\nTask: ${prompt}`,
      seat
    })

  /** One turn as an effect that ends with its outcome; interrupting it cancels the turn. */
  const outcomeOf = (input: TurnInput): Effect.Effect<Outcome> =>
    Effect.suspend(() => {
      const turn = run(input)
      // Interrupted, it cancels the turn and waits until the turn has ended.
      return Effect.promise(() => turn.done).pipe(Effect.onInterrupt(() =>
        Effect.promise(() => {
          turn.cancel()
          return turn.done
        })
      ))
    })

  /** One turn as an effect: its answer, its failure, or its cancellation. */
  const turnOf = (input: TurnInput): Effect.Effect<string, unknown> =>
    Effect.flatMap(outcomeOf(input), (outcome) =>
      outcome._tag === "done"
        ? Effect.succeed(outcome.answer)
        : outcome._tag === "cancelled"
        ? Effect.interrupt
        : Effect.fail(outcome.error ?? new Error(outcome.message)))

  /**
   * One panel member, run until it answers or fails. A quota park ends a
   * worker's run; the tab would relaunch it, but a member is not a tab, so the
   * panel waits out the park itself and runs the member again, at most
   * `maxParks` times. Nothing the member does reaches the tab.
   */
  const memberOf = (input: TurnInput): Effect.Effect<string, unknown> =>
    Effect.gen(function*() {
      const maxParks = input.maxParks ?? QuotaPolicy.defaultMaxParks
      for (let parks = 0;; parks++) {
        let wakeAt: number | undefined
        const outcome = yield* outcomeOf({
          ...input,
          maxParks: Math.max(0, maxParks - parks),
          onEvent: (event) => {
            if (event._tag === "model-parked") wakeAt = event.wakeAt
          }
        })
        if (outcome._tag === "done") return outcome.answer
        if (outcome._tag === "failed") return yield* Effect.fail(outcome.error ?? new Error(outcome.message))
        // Cancelled by anything but its own park, the member gave no answer.
        if (wakeAt === undefined || parks >= maxParks) return yield* Effect.fail(new Error("The panel member stopped"))
        yield* Effect.sleep(Math.max(0, wakeAt - Date.now()))
      }
    })

  /**
   * Runs a worker's panel: each member in parallel as its own worker, on its
   * seat and backups, then the merger, whose answer is the worker's.
   *
   * Members are pure answerers: their runtime ports refuse, and nothing they
   * do reaches the tab, their quota parks included, so a member waits out its
   * park while the tab keeps running and holds its one seat. Only the
   * merger's run is the tab's. Every run gets the routed variant, and each
   * gets its own share of the worker's token cap, so the panel spends at
   * most that cap. A member's answer is handed to `onAnswered`, and a member
   * already in `answered` is not run again. A member that fails is left out
   * and named to the merger; the panel fails only when no member answers.
   */
  const panelOf = (
    input: TurnInput,
    route: { readonly panel: NonNullable<SeatRouter.Route["panel"]>; readonly backups: ReadonlyArray<string> },
    variant: string | null
  ) =>
    Effect.gen(function*() {
      const policy = options.budget === undefined
        ? undefined
        : input.caps === undefined
        ? options.budget
        : raised(options.budget, input.caps)
      const share = policy?.tokens === undefined
        ? policy
        : {
          ...policy,
          tokens: { ...policy.tokens, max: Math.floor(policy.tokens.max / (route.panel.seats.length + 1)) }
        }
      const budget = share === undefined ? undefined : yield* Effect.orDie(Budget.make(share, ledgerOptions))
      const routed = { ...(variant === null ? {} : { variant }), ...(budget === undefined ? {} : { budget }) }
      const {
        onCaption: _caption,
        onPatch: _patch,
        onSeat: _seat,
        steering: _steering,
        variant: _variant,
        ...shared
      } = input
      const known = new Map(input.answered ?? [])
      input.onMembers?.(true)
      const results = yield* Effect.forEach(
        route.panel.seats,
        (member) =>
          known.has(member.seat)
            ? Effect.succeed(Result.succeed(known.get(member.seat)!))
            : memberOf({
              ...shared,
              ...routed,
              seat: member.seat,
              route: { backups: member.backups },
              runtime: memberPorts
            }).pipe(
              Effect.tap((answer) => Effect.sync(() => input.onAnswered?.(member.seat, answer))),
              Effect.result
            ),
        { concurrency: "unbounded" }
      ).pipe(Effect.ensuring(Effect.sync(() => input.onMembers?.(false))))
      const answered = route.panel.seats.flatMap((member, index) => {
        const result = results[index]!
        return Result.isSuccess(result) ? [[member.seat, result.success] as const] : []
      })
      const failed = route.panel.seats.filter((_, index) => Result.isFailure(results[index]!)).map(({ seat }) => seat)
      const first = results[0]!
      if (answered.length === 0 && Result.isFailure(first)) return yield* Effect.fail(first.failure)
      const { variant: _merged, ...merger } = input
      return yield* turnOf({
        ...merger,
        ...routed,
        seat: route.panel.merger,
        route: { backups: route.backups },
        prompt: SeatRouter.mergePrompt(input.prompt, answered, failed)
      })
    })

  const run = (input: TurnInput): Turn => {
    const index = ++turns
    // Unique per host: the ledger outlives the process, so `tui-1` of two launches must not share spend.
    const executionId = `tui-${hostId}-${index}`
    const callMs = options.callMs ?? Sandbox.defaultLimits.callMs
    const session = `tui-${process.pid}-${index}`
    const program = Effect.gen(function*() {
      // Each worker routes on its own; a retry or resume is handed the seat and variant it was routed to.
      const decision = input.seat !== Seat.auto
        ? undefined
        : catalog === undefined
        ? yield* new Seat.SeatUnrouted({ seat: Seat.auto, reason: "unconfigured", message: "No seat catalog" })
        : yield* SeatRouter.route({
          declared: Seat.auto,
          state: {
            task: input.prompt,
            flow: "tui/worker",
            description: input.agent?.system.split("\n", 1)[0] ?? "",
            capabilities: []
          }
        }).pipe(Effect.provideService(SeatRouter.Catalog, SeatRouter.Catalog.of(catalog)))
      const picked = decision === undefined ? input.variant ?? null : decision.variant
      const variant = SeatRouter.variantText(catalog?.variants ?? [], picked)
      if (variant === undefined) {
        return yield* new Seat.SeatUnrouted({
          seat: Seat.auto,
          reason: "unconfigured",
          message: `The seat catalog no longer offers the variant ${picked}`
        })
      }
      if (decision !== undefined) {
        input.onSeat?.({
          seat: decision.seat,
          backups: decision.backups,
          ...(decision.panel === undefined ? {} : { panel: decision.panel }),
          variant: decision.variant
        })
      }
      const route = decision ?? input.route
      const chosen = decision?.seat ?? input.seat
      const seat = chosen.startsWith("replay:")
        ? Replay.seat({
          file: chosen.slice("replay:".length),
          holdMs: Number(env.SMITHERS_TUI_REPLAY_HOLD_MS ?? 0),
          speed: Number(env.SMITHERS_TUI_REPLAY_SPEED ?? 1)
        })
        : yield* (yield* SeatResolver.SeatResolver).resolve(chosen)
      if (decision !== undefined) {
        for (const event of SeatRouter.events(decision, { scope: session, modelId: seat.modelId })) {
          yield* Effect.promise(() => Promise.resolve(input.onEvent(event)))
        }
      }
      // A worker routed to a panel runs each member as its own worker, then
      // the merger on their answers.
      if (input.role === "worker" && route?.panel !== undefined) {
        return yield* panelOf(input, { panel: route.panel, backups: route.backups }, picked)
      }
      // A routed worker fails over along its route's backups, unless the
      // operator set the fallback order.
      const fallbackSeats = input.role === "worker" && !chosen.startsWith("replay:")
        ? yield* Effect.forEach(
          input.fallbackSeats ?? workerFallbackSeats(chosen, available, env, route?.backups),
          (name) => Effect.flatMap(SeatResolver.SeatResolver, (resolver) => resolver.resolve(name))
        )
        : []
      const agent = yield* Agent.Agent
      const engine = yield* FlowRuntime.FlowRuntime
      const box = input.role === "coordinator" ? undefined : options.box
      const services = box === undefined
        ? yield* Effect.context<FileSystem.FileSystem | Path.Path | ChildProcessSpawner>()
        // The host id keeps two TUIs with the same pid, as in two containers, apart on one box.
        : yield* Layer.build(Box.layer(box, `${hostId}-${session}`))
      // The host judge is Jev with its Luna backup (`layerSeatEvaluator`).
      const memoryServices = ServiceContext.add(services, Evaluator.Evaluator, yield* Evaluator.Evaluator)
      const memoryOptions = { root: options.cwd }
      const grants = yield* GrantStore.GrantStore
      const flow = turnFlow(index)
      const settled = Deferred.makeUnsafe<string, unknown>()
      let answer = ""
      let reply = ""
      const maxFrames = input.role === "coordinator" ? 8 : 40
      // Only the coordinator: its completion demands are all disarmed, so a
      // budget ending never carries a bounced answer this would drop.
      const receipts = input.role === "coordinator"
        ? Runtime.ledger(maxFrames)
        : (event: AgentEvent.AgentEvent) => event
      const turn = turnOptions(
        // A coordinator's delegation without a model is routed at launch.
        catalog === undefined ? input : { ...input, workerSeat: Seat.auto },
        // A placed worker's paths are the box's; this tree's jj rule and files say nothing about it.
        box?.workdir ?? options.cwd,
        input.role === "coordinator"
          ? []
          : [
            ...workerSources(
              services,
              yield* Effect.context<Evaluator.Evaluator>(),
              options.cwd,
              input.onPatch ?? (() => {}),
              box !== undefined
            ),
            // A flows source named `memory` is pinned (`StandardFlows.coreSources`),
            // so the run-start relevance reading never withholds it. A placed
            // worker's tree is the box's, which memory does not read.
            ...(box === undefined ? [Memory.source(memoryServices, memoryOptions)] : [])
          ]
      )
      // A worker whose agent may call `memory` starts with what `memory({ task })`
      // selects. The coordinator never does: Jev would sit in front of the
      // chat's acknowledgment.
      const opened = turn.memory && box === undefined
        ? yield* Memory.opening(input.prompt, memoryOptions).pipe(
          Effect.provideContext(memoryServices),
          // Frame zero identifies the host's opening recall in the TUI session.
          // Record its failure before preserving the failed worker outcome.
          Effect.tapError((error) =>
            Effect.promise(() =>
              Promise.resolve(input.onEvent({
                _tag: "supervisor-memory-failed",
                eventType: "flows.harness.supervisor-memory-failed.v1",
                scope: session,
                frame: 0,
                operation: "recall",
                detail: error.code
              }))
            )
          )
        )
        : undefined
      const unjudged = opened?.unjudged
      if (unjudged !== undefined) {
        Log.write("host.memory", unjudged)
        yield* Effect.promise(() =>
          Promise.resolve(input.onEvent({
            ...unjudged,
            _tag: "decision-unjudged",
            eventType: "flows.harness.decision-unjudged.v1",
            scope: session,
            frame: 0
          }))
        )
      }
      const body = agent.run({
        session,
        seat,
        ...(input.role === "worker"
          ? {
            fallbackSeats,
            capacity: { park: true, ...(input.maxParks === undefined ? {} : { maxParks: input.maxParks }) }
          }
          : { capacity: { park: false } }),
        prompt: input.prompt,
        system: [...turn.system, ...(box === undefined ? [] : [Box.teaching(box)]), ...variant],
        // The coordinator is never judged, so it is shown every file whole.
        // A placed worker follows the box checkout's rules, never this tree's.
        instructions: box === undefined ? Context.instructions(options.cwd) : yield* Box.instructions(services, box),
        pinnedSources: turn.pinnedSources,
        ...(turn.reasoningEffort === undefined
          ? {}
          : { modelParams: ModelRequest.GenerationParams.make({ reasoningEffort: turn.reasoningEffort }) }),
        registry,
        ...(opened === undefined ? {} : { memory: opened.memory }),
        plugins: Runtime.plugins(input.runtime, callMs),
        flows: turn.flows.map((source) => boundedCalls(source, callMs)),
        capabilityEnvelope: turn.capabilityEnvelope,
        ...(approvalMode === "all"
          ? {}
          : { authorize: Approvals.authorize(grants, { cwd: options.cwd, source: input.source ?? "chat" }) }),
        // The same explicit cell budget `smithers run` uses; never unlimited.
        limits: {
          memoryBytes: 256 * 1024 * 1024,
          steps: 50_000_000,
          callMs: input.role === "worker" ? 2_147_000_000 : callMs,
          totalMs: options.totalMs ?? Sandbox.defaultLimits.totalMs,
          ...(input.role === "worker" ? { pauseTotalMsFor: Runtime.waiting } : {})
        },
        // Coordinators acknowledge immediately; worker completions stay judged.
        ...(input.role === "coordinator"
          ? { unmovedCap: 0, narrowingCap: 0, unresolvedCap: 0, claimCap: 0 }
          : {}),
        // Workers are armed by the host's judge. The coordinator never is:
        // Jev's latency would sit in front of the chat's acknowledgment.
        judged: input.role !== "coordinator",
        supervisor: { stance },
        maxFrames
      }).pipe(
        Stream.provideService(Steering.Source, input.steering ?? Steering.makeNoop()),
        // A cap the person raised for this worker replaces the host's own for its run.
        (stream) =>
          input.budget !== undefined
            ? Stream.provideService(stream, Budget.Budget, input.budget)
            : input.caps === undefined || options.budget === undefined
            ? stream
            : Stream.provideServiceEffect(
              stream,
              Budget.Budget,
              Effect.orDie(Budget.make(raised(options.budget, input.caps), ledgerOptions))
            ),
        Stream.runForEach((journaled) =>
          Effect.gen(function*() {
            const event = receipts(journaled)
            if (event._tag === "resolved") answer = text(event.message.content)
            if (event._tag === "model-requested" || event._tag === "model-retried") reply = ""
            if (event._tag === "model-delta" && event.delta.type === "text-delta") reply += event.delta.text
            yield* Effect.promise(() => Promise.resolve(input.onEvent(event)))
            if (event._tag === "cell-produced") input.onCaption?.(Transcript.split(reply).prose)
          })
        ),
        // The coordinator has no filesystem or shell flow, so nothing it runs
        // moves the tree. Measuring anyway walked the checkout twice a turn:
        // a one-line `ctx.done()` answer showed 8 s late in this repository.
        // A box's tree is not this one: measuring the local tree would call every placed edit a no-op.
        (effect) => (input.role === "coordinator" || box !== undefined ? unobserved(effect) : effect)
      )
      const scope = yield* Effect.scope
      yield* engine.register(flow, () =>
        Effect.onExit(body, (exit) =>
          Exit.isSuccess(exit)
            ? Deferred.succeed(settled, answer)
            : Deferred.failCause(settled, exit.cause))).pipe(Scope.provide(scope))
      yield* engine.execute(flow, { executionId, payload: {}, discard: true })
      return yield* Deferred.await(settled)
    }).pipe(Effect.scoped)

    const fiber = runtime.runFork(program)
    const done = new Promise<Outcome>((resolve) => {
      fiber.addObserver((exit) => {
        if (Exit.isSuccess(exit)) return resolve({ _tag: "done", answer: exit.value })
        if (Cause.hasInterruptsOnly(exit.cause)) return resolve({ _tag: "cancelled" })
        const detail = Cause.pretty(exit.cause)
        Log.write("host.turn", detail)
        // No judge could check the answer: the run is done, unchecked, never failed.
        const answer = uncheckedAnswer(Cause.squash(exit.cause))
        if (answer !== undefined) return resolve({ _tag: "done", answer, unchecked: true })
        const notice = capNotice(Cause.squash(exit.cause), `${input.role ?? "coordinator"} ${executionId}`)
        // A panel's runs are the tab's; only the tab names its cap.
        if (notice !== undefined && input.budget === undefined) Log.alert("host.cap", notice)
        resolve({ _tag: "failed", message: describe(exit.cause), detail, error: Cause.squash(exit.cause) })
      })
    })
    return { done, cancel: () => void runtime.runFork(Fiber.interrupt(fiber)) }
  }

  const approvals: NonNullable<Host["approvals"]> = {
    mode: approvalMode,
    authorize: (requests, signal) =>
      approvalMode === "all" ?
        Promise.resolve() :
        runtime.runPromise(Effect.flatMap(GrantStore.GrantStore, (grants) => Approvals.check(grants, requests)), {
          signal
        }),
    pending: () =>
      runtime.runPromise(Effect.gen(function*() {
        return Approvals.pending(yield* (yield* GrantStore.GrantStore).list)
      })),
    reply: (request, choice) =>
      runtime.runPromise(Effect.gen(function*() {
        return yield* Approvals.answer(yield* GrantStore.GrantStore, request, choice, options.cwd)
      }))
  }

  return {
    cwd: options.cwd,
    ...(options.budget?.tokens === undefined ? {} : { runCap: options.budget.tokens.max }),
    judged: true,
    routes: catalog !== undefined,
    memory,
    run,
    approvals,
    describe: describeTab,
    monitor,
    complete,
    dispose: () => runtime.dispose()
  }
}

/**
 * A worker's standard catalog: filesystem and shell, each capturing its
 * patches, then `jev` when the host has a judge. Without one `jev` is absent,
 * never a flow that refuses. `placed` services are another machine's: the
 * local tree does not move, so nothing is captured for undo.
 */
export const workerSources = (
  services: ServiceContext.Context<FileSystem.FileSystem | Path.Path | ChildProcessSpawner>,
  judge: ServiceContext.Context<Evaluator.Evaluator> | undefined,
  cwd: string,
  onPatch: (receipt: Changes.Receipt) => void,
  placed = false
): ReadonlyArray<FlowBinding.Source> => {
  const capture = (source: FlowBinding.Source) => placed ? source : Changes.capture(source, cwd, onPatch)
  return [
    // `rg` searches this repository in seconds; the in-process walk took
    // longer than grep's 120 s ceiling. It stays the fallback without rg.
    // Both search flows walk the tree one file operation at a time, which on
    // a box is one SSH connection each, so a placed worker runs `rg` in
    // `bash` instead: one command on the box.
    placed
      ? without(StandardFlows.filesystem(services), ["grep", "glob"])
      : capture(StandardFlows.filesystem(
        services,
        Subprocess.which("rg", process.env) === null ? undefined : NativeSearch.make(services)
      )),
    capture(StandardFlows.shell(services)),
    ...(judge === undefined ? [] : [StandardFlows.jev(judge)])
  ]
}

/** Keeps ordinary calls bounded while a worker can wait for children across resets. */
const boundedCalls = (source: FlowBinding.Source, callMs: number): FlowBinding.Source => ({
  ...source,
  bindings: () =>
    source.bindings().pipe(Effect.map((bindings) => bindings.map((binding) => Runtime.boundedBinding(binding, callMs))))
})

/**
 * The parts of a turn its input decides: the system prompt, the flows, the
 * sources a judged run never withholds, the capability envelope and the
 * reasoning effort. `standard` is the worker's filesystem and shell catalog;
 * an agent's declared `flows` narrow it, and its declared capabilities narrow
 * the envelope. The runtime's delegation, panel and monitor flows are the
 * product's own, so they are pinned; filesystem, shell, jev and memory are pinned as
 * `StandardFlows.coreSources`. `memory` says whether a worker opens with
 * memory: only when its agent keeps the `memory` flow and its envelope holds
 * the grant the flow requires (`Memory.reads`).
 */
export const turnOptions = (
  input: TurnInput,
  cwd: string,
  standard: ReadonlyArray<FlowBinding.Source>
): {
  readonly system: ReadonlyArray<string>
  readonly flows: ReadonlyArray<FlowBinding.Source>
  readonly pinnedSources: ReadonlyArray<string>
  readonly capabilityEnvelope: ReadonlyArray<Capability.CapabilityPattern>
  readonly memory: boolean
  readonly reasoningEffort?: ModelRequest.ReasoningEffort
} => {
  const agent = input.role === "coordinator" ? undefined : input.agent
  const allowed = agent === undefined || agent.flows.length === 0 ? undefined : new Set(agent.flows)
  const reasoningEffort = input.thinking ?? agent?.thinking ??
    (input.role === "coordinator" &&
        (input.seat.startsWith("cerebras:") || input.seat === delegateModels.sol) ?
      "low" :
      undefined)
  const asker = input.runtime?.ask
  const runtime = input.runtime === undefined ? [] : [
    Runtime.source(input.runtime),
    ...(asker === undefined ? [] : [
      StandardFlows.approval({
        ask: (question) =>
          Effect.tryPromise({
            try: (signal) => asker(question, signal),
            catch: (cause) => new StandardFlows.ApprovalUnavailable({ message: String(cause) })
          })
      })
    ])
  ]
  const capabilityEnvelope = agent === undefined || agent.envelope.length === 0
    ? [new Capability.CapabilityPattern({ action: "*", resource: "*" })]
    : AgentSession.patterns(agent.envelope)
  return {
    system: [
      ...Context.system(cwd, input.history),
      ...(input.runtime === undefined ? [] : [Panels.teaching]),
      ...(input.role === "coordinator"
        ? [
          Runtime.coordinatorTeaching + (input.workerSeat ?? input.seat),
          `Background tabs: ${input.background ?? "[]"}`
        ]
        : [
          "Start each cell with a one-line purpose. Split independent work with agent.delegate, then agent.wait({ids}), and aggregate the answers. Children delegate to depth 3; depth 4 is refused. When you cannot decide alone, ask({question, options}) goes to your parent, then the person; answer a child's ask with agent.answer({id, answer}). End with one sentence and essential evidence. Never claim unobserved tests passed."
        ]),
      ...(agent === undefined ? [] : [agent.system])
    ],
    flows: [
      ...(allowed === undefined ? standard : standard.map((source) => only(source, allowed))),
      ...runtime
    ],
    pinnedSources: runtime.map((source) => source.name),
    capabilityEnvelope,
    memory: input.role !== "coordinator" && (allowed === undefined || allowed.has(Memory.name)) &&
      CapabilitySet.allows(CapabilitySet.fromPatterns(capabilityEnvelope), Memory.reads),
    ...(reasoningEffort === undefined ? {} : { reasoningEffort })
  }
}

/** `source` without the flows `names` lists. */
const without = (source: FlowBinding.Source, names: ReadonlyArray<string>): FlowBinding.Source => ({
  name: source.name,
  bindings: () =>
    Effect.map(source.bindings(), (bindings) => bindings.filter((binding) => !names.includes(binding.descriptor.name)))
})

/** `source` with only the flows `allowed` names. */
const only = (source: FlowBinding.Source, allowed: ReadonlySet<string>): FlowBinding.Source => ({
  name: source.name,
  bindings: () =>
    Effect.map(source.bindings(), (bindings) => bindings.filter((binding) => allowed.has(binding.descriptor.name)))
})

/**
 * Runs `effect` without the workspace observer.
 *
 * On the effect, not the stream: `Stream.updateContext` does not reach the
 * effect `Agent.run` resolves its services in. The cast is sound because the
 * run reads the observer with `serviceOption`, so it is never a requirement.
 */
const unobserved = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.updateContext(
    effect,
    (context: ServiceContext.Context<R>) =>
      ServiceContext.omit(WorkspaceObservation.Observer)(context) as ServiceContext.Context<R>
  )

const text = (content: ReadonlyArray<{ readonly type: string; readonly text?: string }>): string =>
  content.flatMap((part) => (part.type === "text" && part.text !== undefined ? [part.text] : [])).join("")

/** The loud line for a tripped cap: which cap, which run, and the spend. */
export const capNotice = (error: unknown, run: string): string | undefined => {
  let current: unknown = error
  for (let depth = 0; depth < 16 && typeof current === "object" && current !== null; depth++) {
    const record = current as { readonly _tag?: unknown; readonly cause?: unknown; readonly budget?: unknown }
    const hit = record._tag === "flows/agent/Skipped" ? record.budget : current
    if ((hit as { readonly _tag?: unknown } | undefined)?._tag === "flows/agent/BudgetExceeded") {
      const { scope, used, max } = hit as Budget.BudgetExceeded
      const spent = `${Math.round(used).toLocaleString("en-US")} of ${max.toLocaleString("en-US")}`
      return scope === "daily"
        ? `Daily token cap reached: ${spent} tokens used today, stopped at ${run}. Something may be looping. Raise --budget-daily-tokens to resume.`
        : scope === "tokens"
        ? `Run token cap reached: ${spent} tokens used by ${run}. Something may be looping. Raise --budget-tokens to resume.`
        : undefined
    }
    current = record.cause
  }
  return undefined
}

/**
 * The answer of a run whose completion no judge could check: the harness fails
 * it closed as `completion_unjudged`, quoting the answer. Undefined for any
 * other failure.
 */
export const uncheckedAnswer = (error: unknown): string | undefined => {
  const seen = new Set<unknown>()
  for (let current = error; typeof current === "object" && current !== null && !seen.has(current);) {
    seen.add(current)
    const record = current as { readonly _tag?: unknown; readonly code?: unknown; readonly message?: unknown }
    if (
      record._tag === "/harness/HarnessError" && record.code === "completion_unjudged" &&
      typeof record.message === "string"
    ) {
      return CompletionClaim.refusedIn(record.message)
    }
    current = (current as { readonly cause?: unknown }).cause
  }
  return undefined
}

/** Budget refusals use shared UI copy; other failures keep the innermost message. */
const describe = (cause: Cause.Cause<unknown>): string => {
  let error: unknown = Cause.squash(cause)
  let message = Cause.pretty(cause)
  while (typeof error === "object" && error !== null) {
    if (Schema.is(Budget.BudgetExceeded)(error) || Schema.is(Budget.Skipped)(error)) {
      return FailureCopy.describe(error).headline
    }
    if ("message" in error && typeof error.message === "string" && error.message !== "") message = error.message
    error = "cause" in error ? error.cause : undefined
  }
  return message
}
