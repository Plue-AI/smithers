/**
 * Subagents, expressed as ordinary executable flows.
 *
 * There is no `ctx.spawn`, no `ctx.send`, and no `ctx.await`. A cell delegates
 * the way it does anything else: it finds a flow in `ctx.flows` and calls it.
 *
 * Two shapes cover the ground:
 *
 * - **Attached children** need nothing in this module. A dynamic flow (a
 *   `Flow.make` with a `model`) or a discovered markdown flow is already a
 *   subagent, and `ctx.call("review", { args })` already runs it inside its own
 *   durable boundary — `CellCalls` resolves the markdown body and hands it to
 *   the host's prompt runner, and `FlowEngineLike.call` keys the whole thing on
 *   the cell identity. That is the common case, and it needed no new API.
 * - **Detached children** — spawn now, collect later — need lifecycle
 *   operations, and those are ordinary flow *names*: `agent/spawn`,
 *   `agent/send`, `agent/await`. They are bound here through the same
 *   {@link FlowBinding} contract as a filesystem read, so they get the same
 *   `CellCallStarted` / `CellCallSettled` trail and the same replay identity.
 *
 * The lifecycle is behind a narrow injected {@link Children} port rather than
 * implemented here. Nothing in a browser-safe package can honestly claim to
 * persist a detached run, and pretending otherwise would produce a child that
 * silently restarts on resume; a host that has a durable run store supplies one,
 * and a host that does not gets {@link makeNoop}, whose refusal the cell can see
 * and route around.
 *
 * @since 0.1.0
 */

import * as Fault from "@smthrs/flow/Fault"
import * as FlowBinding from "@smthrs/harness/FlowBinding"
import type { HarnessError } from "@smthrs/harness/HarnessError"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

/**
 * Input for `agent/spawn`.
 *
 * @category schemas
 * @since 0.1.0
 */
export const SpawnInput = Schema.Struct({
  flow: Schema.String.annotate({ description: "The registered flow the child runs" }),
  input: Schema.optional(Schema.Json).annotate({ description: "The child's input" }),
  label: Schema.optional(Schema.String).annotate({
    description:
      "Identifies this child within the run; treat the returned child id as opaque; two concurrent children of one flow need two labels. Defaults to the flow name."
  })
})

/**
 * Output for `agent/spawn`.
 *
 * @category schemas
 * @since 0.1.0
 */
export const SpawnOutput = Schema.Struct({ child: Schema.String })

/**
 * Input for `agent/send`.
 *
 * @category schemas
 * @since 0.1.0
 */
export const SendInput = Schema.Struct({
  child: Schema.String,
  message: Schema.String
})

/**
 * Output for `agent/send`.
 *
 * @category schemas
 * @since 0.1.0
 */
export const SendOutput = Schema.Struct({ delivered: Schema.Boolean })

/**
 * Input for `agent/await`.
 *
 * @category schemas
 * @since 0.1.0
 */
export const AwaitInput = Schema.Struct({
  child: Schema.String,
  timeoutSeconds: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(3600))
  ).annotate({ description: "Seconds to wait before answering still_running; defaults to 600" })
})

/**
 * Output for `agent/await`.
 *
 * @category schemas
 * @since 0.1.0
 */
export const AwaitOutput = Schema.Struct({
  child: Schema.String,
  output: Schema.String
})

const lifecycle = { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "irreversible" } as const

/**
 * The `agent/spawn` declaration.
 *
 * @category flows
 * @since 0.1.0
 */
export const spawnFlow = {
  capabilities: [],
  name: "agent/spawn",
  description:
    "Start a child agent and return its id without waiting; its label is its identity, so concurrent children of one flow need distinct labels.",
  input: SpawnInput,
  output: SpawnOutput,
  effects: lifecycle
} as const

/**
 * The `agent/send` declaration.
 *
 * @category flows
 * @since 0.1.0
 */
export const sendFlow = {
  capabilities: [],
  name: "agent/send",
  description: "Send a steering message to a running child agent.",
  input: SendInput,
  output: SendOutput,
  effects: lifecycle
} as const

/**
 * The `agent/await` declaration.
 *
 * @category flows
 * @since 0.1.0
 */
export const awaitFlow = {
  capabilities: [],
  name: "agent/await",
  description:
    "Wait for a child agent to finish and return its output. A child still running after timeoutSeconds fails with still_running; await it again to keep waiting.",
  input: AwaitInput,
  output: AwaitOutput,
  effects: lifecycle
} as const

/**
 * A child lifecycle refusal the agent can see and route around.
 *
 * Separate from `HarnessError` on purpose: an unsupported operation or a child
 * that failed is data the cell may catch, while a `HarnessError` is a park or an
 * abort the cell must never swallow. A host that needs to park a lifecycle
 * operation fails with the latter, or gates it in `Agent.Options.authorize`.
 *
 * @category errors
 * @since 0.1.0
 */
export class ChildError extends Schema.TaggedError<ChildError>()(
  "@smthrs/agent/ChildFlows/ChildError",
  {
    code: Schema.Literals(["unsupported", "not_found", "failed", "still_running"]),
    message: Schema.String,
    /** How long a `still_running` await waited, in milliseconds. */
    limitMillis: Schema.optional(Schema.Number)
  }
) {}
Fault.register(
  "@smthrs/agent/ChildFlows/ChildError",
  {
    unsupported: "bug",
    not_found: "factory",
    failed: "factory",
    still_running: "wait"
  } satisfies Fault.Rows<ChildError["code"]>
)

/**
 * The narrow child-run port a host supplies.
 *
 * @category services
 * @since 0.1.0
 */
export interface Children {
  readonly spawn: (
    input: typeof SpawnInput.Type
  ) => Effect.Effect<typeof SpawnOutput.Type, HarnessError | ChildError>
  readonly send: (
    input: typeof SendInput.Type
  ) => Effect.Effect<typeof SendOutput.Type, HarnessError | ChildError>
  readonly await: (
    input: typeof AwaitInput.Type
  ) => Effect.Effect<typeof AwaitOutput.Type, HarnessError | ChildError>
}

/**
 * Context service for the child-run port.
 *
 * @category services
 * @since 0.1.0
 */
export const Children: Context.Service<Children, Children> = Context.Service(
  "@smthrs/agent/ChildFlows/Children"
)

const unavailable = (operation: string): ChildError =>
  new ChildError({
    code: "unsupported",
    message: `This host runs no detached children, so ${operation} is unavailable.`
  })

/**
 * Constructs a child port that refuses every operation.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeNoop = (overrides: Partial<Children> = {}): Children =>
  Children.of({
    spawn: () => Effect.fail(unavailable("agent/spawn")),
    send: () => Effect.fail(unavailable("agent/send")),
    await: () => Effect.fail(unavailable("agent/await")),
    ...overrides
  })

/**
 * The name of the {@link source} that binds the lifecycle flows.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const sourceName = "agent/children"

/**
 * Detached child lifecycle, as three ordinary flows.
 *
 * @category constructors
 * @since 0.1.0
 */
export const source = (children: Children): FlowBinding.Source =>
  FlowBinding.source(sourceName, [
    FlowBinding.make({ flow: spawnFlow, handler: children.spawn, publicError: (error) => error.message }),
    FlowBinding.make({ flow: sendFlow, handler: children.send, publicError: (error) => error.message }),
    FlowBinding.make({
      flow: awaitFlow,
      handler: children.await,
      publicError: (error) => error.message,
      // An await that gave up on a child still running is a timeout.
      timedOut: (error) =>
        error._tag === "@smthrs/agent/ChildFlows/ChildError" && error.code === "still_running"
          ? { limitMillis: error.limitMillis }
          : undefined
    })
  ])
