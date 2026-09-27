/*
 * The workspace the flow-graph stack serves, named once.
 *
 * The gateway half declares it and the Chromium spec addresses it, and the two
 * must not drift: a spec that named a different workspace would ask the relay
 * for flows it does not hold and read the refusal as an empty list.
 */

/** The one workspace `scripts/flow-graph-e2e-gateway.mts` answers for. */
export const GRAPH_REPO = "codeplanesmithers/smithers-demo"

/** The one flow that workspace declares (`packages/smithers/test/BridgedEngineRun.ts`). */
export const GRAPH_FLOW = "gateway/GraphFixture"

/**
 * The flow the authoring run writes, named the way discovery names one: after
 * the directory its entry file sits in, `flows/authoring-demo/flow.ts`.
 *
 * Nothing on the box holds it until a run writes that file, which is what the
 * listing before and after the run says
 * (`packages/smithers/test/FlowAuthoringRun.test.ts` says the same thing to
 * the control plane, where the refusal is typed).
 */
export const AUTHORED_FLOW = "authoring-demo"

/**
 * The two node addresses the authored file's own graph carries.
 *
 * They are the file's body walked through the registry's executable, which is
 * one call deep inside the wrapper, so `all.read` sits under `root.flow.flow`.
 * Written down rather than derived, for the reason the fixture ids are:
 * `packages/smithers/test/FlowAuthoringRun.test.ts` drives the same plan on
 * the same stack.
 */
export const AUTHORING_READ = "root.flow.flow.all.read"
export const AUTHORING_VALIDATE = "root.flow.flow.all.validate"

/**
 * The eleven nodes that flow's plan keys, in the order the control plane
 * reports them.
 *
 * Written down rather than derived, because a spec that computed the ids from
 * the same builder the app reads them through would pass whatever that builder
 * produced. `packages/smithers/test/FlowGraphRun.test.ts` proves these are the
 * ids the engine also schedules and settles.
 */
export const GRAPH_NODE_IDS: ReadonlyArray<string> = [
  "root.flow.andThen",
  "root.flow.then.map.all.steady",
  "root.flow.then.map.all.retried",
  "root.flow.then.map.all.recovered.protected",
  "root.flow.then.map.all.recovered.failure",
  "root.flow.then.map.all.recovered",
  "root.flow.then.map.all.cached",
  "root.flow.then.map",
  "root.flow.then",
  "root.flow",
  "root"
]

/** The action each dispatching node carries, as the drawn node titles it. */
export const GRAPH_NODE_ACTIONS: Readonly<Record<string, string>> = {
  "root.flow.andThen": "gateway/graph/Gate",
  "root.flow.then.map.all.steady": "gateway/graph/Steady",
  "root.flow.then.map.all.retried": "gateway/graph/Flaky",
  "root.flow.then.map.all.recovered.protected": "gateway/graph/Doomed",
  "root.flow.then.map.all.cached": "gateway/graph/Cacheable",
  "root": GRAPH_FLOW
}

/** The gate the fan-out leaves. */
export const GRAPH_GATE = "root.flow.andThen"

/**
 * The node the gate's FIRST drawn edge leads to.
 *
 * The workspace reports the builder's own labelled edges and the card draws
 * them in that order, so the arrows walk them in that order too. The gate's
 * first one is its `value` edge into the flow body it returns into, not one
 * of the four `continuation` arms it fans out to; a host that reported no
 * graph would fall back to `dependsOn`, where the arms come first. Written
 * down rather than derived, for the reason the ids are.
 */
export const GRAPH_GATE_FIRST_EDGE = "root.flow"

/**
 * The question that gate asks, as `packages/smithers/test/BridgedEngineRun.ts`
 * writes it. Written down rather than imported, for the reason the ids are.
 */
export const GRAPH_GATE_QUESTION = "Merge the fan-out?"

/**
 * The one node of this graph that fails.
 *
 * `gateway/graph/Doomed` fails with a typed error its sibling catch arm
 * recovers from, so the run completes with one node settled `failed` and the
 * other ten `built` (`FlowGraphStatus.test.ts` folds the same pair off the
 * recorded journal).
 */
export const GRAPH_FAILING_NODE = "root.flow.then.map.all.recovered.protected"

/** The node that joins the fan-out's arms back into one result. */
export const GRAPH_MERGE = "root.flow.then.map"

/**
 * The file the fixture flow and its actions are declared in, repo-relative.
 *
 * The engine records a declaration site on every node it drives and the
 * writer makes it relative to the root the host declares
 * (`BridgedEngineRun.repositoryRoot`), so this is the path a node's Code tab
 * shows and the path the contents route is asked for. Written down here for
 * the reason the ids are: a spec that derived it from the same module the
 * recorder reads would pass whatever that module said.
 */
export const GRAPH_FLOW_SOURCE = "packages/smithers/test/BridgedEngineRun.ts"

/**
 * The schedule the stack's registrations route lists for the repository, the
 * way Smithers Cloud lists a `flow:<slug>` registration.
 *
 * Nothing polls it, so it is armed and stays armed.
 */
export const GRAPH_SCHEDULE = { id: "graph-fixture-nightly", slug: "graph-fixture-nightly", cron: "0 3 * * *", words: "Every day at 03:00 UTC" } as const

/**
 * The one box the stack lists for the repository. Every flow call names a
 * box, so the app reads this row before it lists, plans or runs anything.
 */
export const GRAPH_BOX = "6f1d8e2a-4b3c-4d5e-8f60-7a8b9c0d1e2f"

/** The fan-out's steady arm: one step that always succeeds. */
export const GRAPH_STEADY = "root.flow.then.map.all.steady"

/**
 * The arm that retries.
 *
 * Its action fails its first attempt through a counter the whole STACK
 * shares, so only the FIRST run of a host dispatches it twice
 * (`packages/smithers/test/FlowGraphRun.test.ts` says so in as many words). A
 * reader of "attempt 2" is reading a host's first run.
 */
export const GRAPH_RETRIED = "root.flow.then.map.all.retried"

/** The arm whose action is cache-eligible by the engine's own rule. */
export const GRAPH_CACHED = "root.flow.then.map.all.cached"

/** The arm that catches its protected node's typed failure. */
export const GRAPH_RECOVERED = "root.flow.then.map.all.recovered"

/** The four arms between them: a steady step, a retry, a recovery and a cacheable step. */
export const GRAPH_FAN_OUT: ReadonlyArray<string> = [
  GRAPH_STEADY,
  GRAPH_RETRIED,
  GRAPH_RECOVERED,
  GRAPH_CACHED
]
