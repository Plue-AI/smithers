/**
 * Teaches an agent Smithers itself, as one ordinary cell plugin.
 *
 * The plugin contributes through the two cell hooks that already exist:
 *
 * - `cellModelRequest` appends one short {@link brief} to every model request,
 *   so the agent knows what Smithers is before it has read a file.
 * - `cellFlows` adds `smithers.guide`, the structured {@link knowledge}, and,
 *   when the host passes {@link Ports}, `smithers.flows`, `smithers.run`, and
 *   `smithers.inspect` over the host's own flow-run control path.
 *
 * A cell reaches all of them the way it reaches every capability:
 * `ctx.call("smithers.guide", { topic: "cli" })`. There is no `ctx.smithers`
 * global and no second flow model; the host's run path keeps its own
 * persistence, deduplication, approval, and active-run limit.
 *
 * @since 1.0.0-rc.1
 */

import * as Flow from "@smthrs/core/Flow"
import * as FlowBinding from "@smthrs/harness/FlowBinding"
import * as ModelRequest from "@smthrs/model/ModelRequest"
import type { FlowsHooks, FlowsPlugin } from "@smthrs/plugin"
import { make as makePlugin } from "@smthrs/plugin"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

/**
 * The plugin's name in the kernel and in the composition identity.
 *
 * @category constants
 * @since 1.0.0-rc.1
 */
export const name = "smithers"

/**
 * One fact about a package, a command, or an authoring rule.
 *
 * @category models
 * @since 1.0.0-rc.1
 */
export interface Fact {
  readonly name: string
  readonly about: string
}

/**
 * What an agent needs to know to use and extend Smithers.
 *
 * Every `cli` entry is a verb of the `smthrs` binary; the TUI tests check each
 * one against `smthrs --llms`.
 *
 * @category constants
 * @since 1.0.0-rc.1
 */
export const knowledge = {
  packages: [
    { name: "@smthrs/flow", about: "Flow authoring model: Flow.make, Action, durable waits, retry, the runtime port." },
    {
      name: "@smthrs/plan",
      about: "Node combinators for flow bodies: Node.succeed, Node.all, Node.bindPlanned, Node.map."
    },
    {
      name: "@smthrs/core",
      about: "Schema-first flow signatures over @smthrs/flow; Flow.make({ name, input, output, effects })."
    },
    {
      name: "@smthrs/agent",
      about: "Production agent loop (Agent), AgentSession, AgentAction for typed agent steps, CellPlugin."
    },
    {
      name: "@smthrs/harness",
      about: "Cell controller and QuickJS sandbox; FlowBinding pairs a declaration with its handler."
    },
    { name: "@smthrs/plugin", about: "Typed plugin kernel: Plugin, hooks, ordering, config waterfall." },
    { name: "@smthrs/registry", about: "Flow descriptor discovery and progressive disclosure." },
    { name: "@smthrs/std", about: "Standard flows: read, write, edit, grep, glob, bash, fetch, test." },
    { name: "@smthrs/model", about: "Provider-neutral model requests, seats, streaming events, Evaluator (Jev)." },
    { name: "@smthrs/engine", about: "Runtime that executes flows, plus HTTP and RPC transports." },
    { name: "@smthrs/control", about: "Durable control plane: launch, watch, cancel, and RPC projections of runs." },
    { name: "@smthrs/mcp", about: "Projects a remote MCP server's tools as ordinary flow bindings." },
    { name: "@smthrs/build", about: "PACKAGE.ts target graphs; @smthrs/build-cli executes them with caching." },
    { name: "@smthrs/cli", about: "The `smthrs` binary (also `smithers`); run it with `npx smthrs <verb>`." }
  ],
  cli: [
    { name: "smthrs flow list", about: "List project flows." },
    { name: "smthrs flow show <flow>", about: "Show a flow's identity and description." },
    { name: "smthrs flow plan <flow>", about: "Compile a plan and its approval payload without executing." },
    {
      name: "smthrs flow start <flow>",
      about: "Plan, approve, and start a flow; --data '<json>' input, --detached to return once admitted."
    },
    { name: "smthrs runs list", about: "List durable runs by flow or status." },
    { name: "smthrs runs show <run>", about: "A run's status and diagnosis." },
    { name: "smthrs runs logs <run>", about: "Read or follow a run's events." },
    { name: "smthrs runs output <run>", about: "Recorded outputs for one node or all nodes." },
    { name: "smthrs runs cancel <run>", about: "Cancel one durable run." },
    { name: "smthrs runs resume <run>", about: "Resume a parked run." },
    { name: "smthrs approvals", about: "Find and resolve pending approval requests." },
    { name: "smthrs generate flow <name>", about: "Scaffold a Markdown flow without replacing an existing one." },
    { name: "smthrs test <pattern>", about: "Run PACKAGE.ts test targets, e.g. //packages/smithers/agent:test." },
    { name: "smthrs docs <pattern>", about: "Docs parity targets, e.g. smthrs docs //packages/smithers/agent:docs." },
    { name: "smthrs doctor", about: "Check project discovery, providers, tools, and durable state." },
    { name: "smthrs tui", about: "Open the terminal coding agent." }
  ],
  authoring: [
    {
      name: "File flow",
      about:
        "flows/<name>/flow.ts default-exports Flow.make(\"<name>\", { description, capabilities, effects, payload, success, error?, body }) from @smthrs/flow. The tag is required and matches the path."
    },
    {
      name: "Body",
      about:
        "body returns a Node from @smthrs/plan: Node.succeed(value), Action.call(...), Node.all({...}), Node.bindPlanned(node, next). Never a second graph model."
    },
    {
      name: "Effects",
      about:
        "effects: { reads, writes, mode: \"expected\", onConflict: \"serialize\", tier: \"sealed\" | \"irreversible\" }. capabilities are literals such as fs:read:** or proc:spawn:*."
    },
    {
      name: "Markdown flow",
      about: "flows/<name>/flow.mdx: frontmatter declares description and capabilities; the prompt is the body."
    },
    { name: "Agent step", about: "AgentAction.make from @smthrs/agent runs a typed model step inside a flow." },
    { name: "Run", about: "npx smthrs flow start <name> --data '{...}' --detached, then smthrs runs show <run>." },
    {
      name: "VCS",
      about:
        "The repository is jj-colocated: use jj (jj st, jj diff, jj describe, jj new), never git commands that write."
    },
    {
      name: "Checks",
      about: "pnpm --filter <package> test and typecheck; after docs edits pnpm docs:sync then pnpm docs:check."
    }
  ]
} as const satisfies Record<string, ReadonlyArray<Fact>>

/**
 * The topics `smithers.guide` answers.
 *
 * @category models
 * @since 1.0.0-rc.1
 */
export const Topic = Schema.Literals(["packages", "cli", "authoring", "all"])

/**
 * The decoded form of {@link Topic}.
 *
 * @category models
 * @since 1.0.0-rc.1
 */
export type Topic = typeof Topic.Type

/**
 * The always-present system teaching. Short on purpose: details come from
 * `smithers.guide`.
 *
 * @category constants
 * @since 1.0.0-rc.1
 */
export const brief = [
  "You work with Smithers: durable flows for long-running coding agents. Flows are TypeScript (flows/<name>/flow.ts, Flow.make from @smthrs/flow) or Markdown (flow.mdx).",
  `Key packages: ${knowledge.packages.map((fact) => fact.name).join(", ")}.`,
  "The CLI is `npx smthrs <verb>`: flow list|show|plan|start, runs list|show|logs|output|cancel|resume, generate flow, test, docs, tui.",
  "Use jj, not git, to inspect or commit. For package facts, CLI flags, and the authoring recipe call ctx.call(\"smithers.guide\", { topic }) with packages, cli, authoring, or all."
].join("\n")

/**
 * Host operations behind the run flows. Each returns JSON-shaped data or a
 * promise of it; a thrown error reaches the cell as the call's failure text.
 *
 * @category models
 * @since 1.0.0-rc.1
 */
export interface Ports {
  /** Discovered project flows a model may start. */
  readonly list: () => unknown
  /** Requests a background run and returns its receipt without waiting. */
  readonly run: (request: {
    readonly id: string
    readonly flow: string
    readonly input?: { readonly [key: string]: Schema.Json } | undefined
  }) => unknown
  /** Reads one run's status, recent steps, and result. Does not wait. */
  readonly inspect: (id: string) => unknown
}

const short = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(160))

const sealed = { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "sealed" } as const
/** Run state moves between calls, so nothing but the guide may replay a sealed answer. */
const live = { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "irreversible" } as const

class PortError extends Schema.TaggedError<PortError>()("@smthrs/agent/SmithersPlugin/PortError", {
  message: Schema.String
}) {}

/** The host's value as plain JSON; `undefined` fields drop and a missing value is null. */
const json = (value: unknown): Schema.Json => JSON.parse(JSON.stringify(value) ?? "null") as Schema.Json

/** Host port failures are the host's own model-facing refusals. */
const publicError = (error: PortError): string => error.message

const port = <A>(call: () => A) =>
  Effect.tryPromise({
    try: async () => json(await call()),
    catch: (cause) => new PortError({ message: cause instanceof Error ? cause.message : String(cause) })
  })

/**
 * The `smithers.guide` flow: bounded, structured facts by topic.
 *
 * @category constructors
 * @since 1.0.0-rc.1
 */
export const guide: FlowBinding.Binding = FlowBinding.make({
  flow: Flow.make({
    name: "smithers.guide",
    description:
      "Smithers facts: key @smthrs packages, smthrs CLI verbs, and the flow authoring recipe. topic is packages, cli, authoring, or all.",
    input: Schema.Struct({ topic: Schema.optional(Topic) }),
    output: Schema.Json,
    effects: sealed
  }),
  handler: ({ topic }) =>
    Effect.succeed(json(topic === undefined || topic === "all" ? knowledge : { [topic]: knowledge[topic] }))
})

const bindings = (ports: Ports): ReadonlyArray<FlowBinding.Binding> => [
  FlowBinding.make({
    flow: Flow.make({
      name: "smithers.flows",
      description: "List the project's Smithers flows a model may start: name and description.",
      input: Schema.Struct({}),
      output: Schema.Json,
      effects: live
    }),
    handler: () => port(ports.list),
    publicError
  }),
  FlowBinding.make({
    flow: Flow.make({
      name: "smithers.run",
      description:
        "Request a Smithers flow run in a background tab and return immediately. Reuse id to deduplicate. Requested is not completed. Read with smithers.inspect.",
      input: Schema.Struct({
        id: short,
        flow: short,
        input: Schema.optional(Schema.Record(Schema.String, Schema.Json))
      }),
      output: Schema.Json,
      effects: live
    }),
    handler: (request) => port(() => ports.run(request)),
    publicError
  }),
  FlowBinding.make({
    flow: Flow.make({
      name: "smithers.inspect",
      description: "Read a Smithers flow run's status, recent steps, and result. Does not wait; do not poll in a loop.",
      input: Schema.Struct({ id: short }),
      output: Schema.Json,
      effects: live
    }),
    handler: ({ id }) => port(() => ports.inspect(id)),
    publicError
  })
]

/**
 * The executable flows the plugin contributes for `ports`.
 *
 * @category constructors
 * @since 1.0.0-rc.1
 */
export const flows = (ports?: Ports | undefined): ReadonlyArray<FlowBinding.Binding> =>
  ports === undefined ? [guide] : [guide, ...bindings(ports)]

/**
 * The Smithers plugin. Pass it in `Agent.Options.plugins`.
 *
 * Without `ports` it teaches and serves `smithers.guide` only. A contributed
 * name that is already in the catalog fails catalog assembly; nothing is
 * shadowed.
 *
 * @category constructors
 * @since 1.0.0-rc.1
 */
export const make = (ports?: Ports | undefined): FlowsPlugin<FlowsHooks> => {
  const contributed = flows(ports)
  return makePlugin<FlowsHooks>({
    name,
    apply: "harness",
    hooks: {
      cellFlows: (existing) => Effect.succeed([...existing, ...contributed]),
      cellModelRequest: (request) =>
        Effect.succeed(
          request.system.some((part) => part.text === brief)
            ? request
            : ModelRequest.ModelRequest.make({
              ...request,
              system: [...request.system, ModelRequest.SystemPart.make({ text: brief })]
            })
        )
    }
  })
}
