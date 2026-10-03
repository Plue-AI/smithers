/**
 * Failure control: what runs, what unwinds, and what the plan shows first.
 *
 * `@smthrs/patterns` gives every container two halves. `make` builds the
 * conservative topology (every rung, member, and compensation that could be
 * reached) so a reader sees the failure paths before anything runs. `run` is
 * the Effect that performs the value-dependent branch.
 *
 * This example releases a build: bounded checks, a quarantined flake, an
 * escalating fixer, a saga that unwinds a half-finished deploy, and a lock the
 * finalizer always releases.
 */
import { Node } from "@smthrs/core"
import { Flow } from "@smthrs/flow"
import { Graph } from "@smthrs/flow"
import { Bounded, Escalation, PatternError, Quarantine, Saga, TryCatchFinally } from "@smthrs/patterns"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

/** The failure the deploy's third step raises. */
export class Rejected extends Schema.TaggedError<Rejected>()("examples/Rejected", {
  step: Schema.String
}) {}

/** A declared call that echoes its own name, so a built graph can name it. */
const call = (name: string) =>
  Flow.make(name, {
    payload: { input: Schema.Unknown },
    success: Schema.Unknown,
    body: Node.capture({ name }, () => Node.succeed({ from: name }))
  })

/** The deploy, declared. Nothing runs; this is the plan the operator reads. */
export const deployment = Saga.make({
  steps: [
    { id: "reserve", action: call("reserve"), compensation: call("release") },
    { id: "upload", action: call("upload"), compensation: call("delete") },
    { id: "activate", action: call("activate"), compensation: call("roll-back") }
  ],
  onFailure: "compensate"
})

/** Every call the declaration reaches, forward steps then compensations. */
export const declaredCalls: ReadonlyArray<string> = Graph.nodes(Graph.build(deployment, { release: "v1" }))
  .filter((node) => node.kind === "FlowCall" && node.id !== "root")
  .map((node) => (node.draft.material.body as { readonly flow: string }).flow)

/** What the release did, in the order it did it. */
export interface Summary {
  readonly checks: Readonly<Record<string, string>>
  readonly quarantined: ReadonlyArray<string>
  readonly fixedAt: number
  readonly deploy: ReadonlyArray<string>
  readonly outcome: string
  readonly lockHeld: boolean
}

/**
 * The failures this release can end in: a pattern's own declaration or runtime
 * failure, and the deploy's typed rejection.
 */
export type ReleaseError = PatternError.PatternError | Rejected

export const main = (): Effect.Effect<Summary, ReleaseError> =>
  Effect.gen(function*() {
    const trace: Array<string> = []
    let lockHeld = true
    const record = <A>(name: string, value: A): Effect.Effect<A> =>
      Effect.sync(() => {
        trace.push(name)
        return value
      })

    // Two checks at a time, the release blocker first.
    const check = (name: string) => Effect.sync(() => `${name}-clean`)
    const checks = yield* Bounded.run(
      { lint: check("lint"), types: check("types"), audit: check("audit") },
      { concurrency: 2, priorities: { audit: 9 } }
    )

    // A flaky check must not interrupt the two beside it.
    const settled = yield* Quarantine.run({
      unit: check("unit"),
      flake: Effect.fail(new Rejected({ step: "flake" })),
      e2e: check("e2e")
    }, { policy: "quarantine" })
    const quarantined = Object.keys(settled).filter((member) => Quarantine.isQuarantined(settled[member]))

    // Try the cheap fixer, then the thorough one. The ladder stops at the
    // first rung whose result does not report a failure.
    const fixed = yield* Escalation.run({ report: quarantined }, {
      rungs: [
        () => Effect.succeed({ ok: false, by: "formatter" }),
        () => Effect.succeed({ ok: true, by: "rewriter" })
      ]
    })

    // The deploy holds a lock, and the finalizer releases it on every path.
    const outcome = yield* TryCatchFinally.run({ release: "v1" }, {
      try: (input: { readonly release: string }) =>
        Saga.run(input, {
          steps: [
            {
              id: "reserve",
              action: () => record("reserve", "slot-7"),
              compensation: () => record("release", undefined)
            },
            {
              id: "upload",
              action: () => record("upload", "bundle-9"),
              compensation: () => record("delete", undefined)
            },
            {
              id: "activate",
              action: () =>
                Effect.flatMap(
                  record("activate", undefined),
                  () => Effect.fail(new Rejected({ step: "activate" }))
                ),
              compensation: () => record("roll-back", undefined)
            }
          ],
          onFailure: "compensate"
        }),
      finally: () =>
        Effect.sync(() => {
          lockHeld = false
        })
    })

    return {
      checks,
      quarantined,
      fixedAt: fixed.level,
      deploy: trace,
      outcome: outcome._tag === "Compensated" ? "compensated" : "released",
      lockHeld
    }
  })
