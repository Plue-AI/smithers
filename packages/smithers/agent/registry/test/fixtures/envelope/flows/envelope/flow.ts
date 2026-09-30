import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"

/** Writes a path the enclosing envelope does not cover. */
const Escaping = Flow.make("test/envelope/escaping", {
  payload: {},
  success: Schema.Number,
  effects: { reads: [], writes: ["etc/hosts"], mode: "hermetic", onConflict: "serialize" },
  body: () => Node.succeed(1)
})

/** Declares an expected mode inside a hermetic envelope. */
const Looser = Flow.make("test/envelope/looser", {
  payload: {},
  success: Schema.Number,
  effects: { reads: ["src/a.ts"], writes: [], mode: "expected", onConflict: "serialize" },
  body: () => Node.succeed(2)
})

/** Declares a tier the enclosing envelope does not permit. */
const Riskier = Flow.make("test/envelope/riskier", {
  payload: {},
  success: Schema.Number,
  effects: { reads: [], writes: [], mode: "hermetic", onConflict: "serialize", tier: "irreversible" },
  body: () => Node.succeed(3)
})

/** Requires a capability the caller does not hold. */
const Privileged = Flow.make("test/envelope/privileged", {
  payload: {},
  success: Schema.Number,
  capabilities: ["net"],
  body: () => Node.succeed(4)
})

/** Declares a write beneath a sealed flow, which grants none. */
const Widener = Flow.make("test/envelope/widener", {
  payload: {},
  success: Schema.Number,
  effects: { reads: [], writes: ["dist/x.js"], mode: "hermetic", onConflict: "serialize" },
  body: () => Node.succeed(5)
})

/** Grants nothing: empty lists, hermetic, sealed. */
const Sealed = Flow.make("test/envelope/sealed", {
  payload: {},
  success: Schema.Number,
  effects: { reads: [], writes: [], mode: "hermetic", onConflict: "serialize", tier: "sealed" },
  body: () => Widener.call({})
})

/**
 * A module flow whose body composes five callees that each over-claim in one
 * way, so the authority controls `Graph.build` enforces are visible on the
 * exact path `smithers up <flow>` drives: discovered from disk, loaded through
 * the registry's executable, and built into a graph.
 *
 * It is a fixture, so it is meant to be refused. Nothing runs it.
 */
export default Flow.make("test/envelope", {
  description: "Over-claims its effect envelope five ways, on purpose.",
  payload: {},
  success: Schema.Number,
  capabilities: ["fs:read:**"],
  effects: { reads: ["src/**"], writes: ["dist/**"], mode: "hermetic", onConflict: "serialize", tier: "compensable" },
  body: () =>
    Node.all({
      escaping: Escaping.call({}),
      looser: Looser.call({}),
      riskier: Riskier.call({}),
      privileged: Privileged.call({}),
      sealed: Sealed.call({})
    }).pipe(Node.map((results) => results.escaping + results.looser))
})
