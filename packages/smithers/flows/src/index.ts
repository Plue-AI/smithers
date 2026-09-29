/**
 * @since 0.1.0
 *
 * `@smthrs/flows` — the barrel package for the durable flow engine.
 *
 * Every engine package is re-exported here as a namespace, the way `effect`'s
 * own index does it, so one dependency gives you the whole engine surface
 * without collapsing each package's `make` / `makeNoop` / `layerNoop` trio into
 * a shared namespace: `Kernel.ChildProcessSpawner.layerNoop`,
 * `RunStore.RunStore.layer`.
 *
 * The `@smthrs/platform-*` packages are deliberately NOT re-exported, for the
 * same reason `effect`'s index does not re-export `@effect/platform-node`: a
 * platform bundle is chosen by the program that runs, not by the library it
 * depends on, and pulling all three in here would make one import resolve
 * `node:child_process`, ZenFS, and Bun at once. Import
 * `@smthrs/platform-node`, `@smthrs/platform-bun`, or
 * `@smthrs/platform-browser` directly.
 *
 * Depend on the individual `@smthrs/*` packages instead when you want a
 * narrower dependency footprint — this barrel is a convenience, not a new
 * seam. The only API of its own is {@link namespaces}, the runtime list of
 * the re-exported namespace names.
 *
 * The one exception is `@smthrs/flow`: the authoring model is re-exported
 * *flat*, so all sixteen of `Action`, `DurableClock`, `DurableDeferred`,
 * `DurableQueue`, `Fault`, `Flow`, `FlowRuntime`, `Graph`, `HumanTask`,
 * `Interpreter`, `Poll`, `RetryPolicy`, `Sleep`, `Stall`, `StepIdentity`, and
 * `WaitFor` sit at the top level beside the infrastructure namespaces. Writing a flow is the point of
 * the library; `Flows.Flow.Flow.make` would be noise. `Interpreter` is part of
 * that set because a host composition needs it: the registration layer
 * `NodeRuntime.layerHost` takes is built from `Interpreter.layer(flow)`.
 *
 * ```ts
 * import { Action, Engine, Flow, Journal } from "@smthrs/flows"
 * ```
 *
 * `@smthrs/time-travel` is the second: `TimeTravel` is a *service key*, not a
 * namespace, so `const timeTravel = yield* Flows.TimeTravel` is the entire
 * onboarding and `Flows.TimeTravel.layer` provides it. Effect's own index
 * makes exactly this trade for `./Function.ts` — one flat re-export where the
 * surface is what you reach for, namespaces everywhere else. The rest of that
 * package (`Frame`, `TimeTravelStore`, the two store layers,
 * `EffectBoundary`) is reached through `@smthrs/time-travel` directly; see
 * https://smithers.sh/docs/reference/api/time-travel.
 *
 * There is no plugin namespace and no hook catalog: extension in `flows` is
 * Effect dependency injection. You extend the engine by providing a `Layer`,
 * and you replace a behavior by providing a different implementation of the
 * service — or a different constructor option — at the seam that owns it.
 */

export * as Artifacts from "@smthrs/artifacts"
export * as Canonical from "@smthrs/canonical"
export * as Capability from "@smthrs/capability"
export * as Crypto from "@smthrs/crypto"
export * as Database from "@smthrs/database"
export * as Engine from "@smthrs/engine"
export * as EngineStore from "@smthrs/engine-store"
export * from "@smthrs/flow"
export * as Jj from "@smthrs/jj"
export * as Journal from "@smthrs/journal"
export * as Kernel from "@smthrs/kernel"
export * as Keys from "@smthrs/keys"
export * as Observability from "@smthrs/observability"
export * as Plan from "@smthrs/plan"
export * as PlanStore from "@smthrs/plan-store"
export * as RunStore from "@smthrs/run-store"
export * as Sandbox from "@smthrs/sandbox"
export * as StepCache from "@smthrs/step-cache"
export * as Sync from "@smthrs/sync"
export { TimeTravel } from "@smthrs/time-travel"

/**
 * The namespace names this barrel re-exports, sorted.
 *
 * It covers both re-export styles: the per-package namespaces and the flat
 * authoring names `@smthrs/flow` contributes.
 *
 * Pure re-exports carry no executable statements, so before this constant
 * the package's enforced 100% coverage gate evaluated an empty denominator
 * (`100% (0/0)`) and could never go red while the conformance suite
 * presented it as gated like every sibling (issue #169). This is the
 * barrel's one runtime value: it gives the gate a real denominator, and the
 * barrel test pins it against the derived `packages/*` universe so it can
 * never drift from the re-exports above.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export const namespaces = [
  "Action",
  "Artifacts",
  "Canonical",
  "Capability",
  "Crypto",
  "Database",
  "DurableClock",
  "DurableDeferred",
  "DurableQueue",
  "Engine",
  "EngineStore",
  "Fault",
  "Flow",
  "FlowRuntime",
  "Graph",
  "HumanTask",
  "Interpreter",
  "Jj",
  "Journal",
  "Kernel",
  "Keys",
  "Observability",
  "Plan",
  "PlanStore",
  "Poll",
  "RetryPolicy",
  "RunStore",
  "Sandbox",
  "Sleep",
  "Stall",
  "StepCache",
  "StepIdentity",
  "Sync",
  "TimeTravel",
  "WaitFor"
] as const
