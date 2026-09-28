/**
 * `DriftDetector` on `@smthrs/flow`'s `Graph.build`.
 *
 * The declaration assertions are the same observable facts as before: capture
 * and compare are declared once each, and the alert arm is declared exactly
 * when an alert flow is supplied. Whether a run takes the alert is the
 * comparison's answer, which {@link DriftDetector.run} decides, so there is no
 * run-time decision in the declaration to branch on.
 */
import { describe, it } from "@effect/vitest"
import { Flow, Graph } from "@smthrs/flow"
import * as Node from "@smthrs/plan/Node"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { expect } from "vitest"
import * as DriftDetector from "../src/DriftDetector.ts"
import { callsTo, payloadOf } from "./Graphs.ts"

/** The capture member: it is handed `{ input, baseline }`. */
const capture = Flow.make("drift/capture", {
  payload: { input: Schema.Unknown, baseline: Schema.Unknown },
  success: Schema.Unknown,
  error: Schema.Unknown,
  capabilities: ["drift/capture"],
  body: ({ input }) => Node.succeed({ checksum: "b", from: input })
})

/** The compare member: it is handed `{ snapshot, baseline }`. */
const compare = Flow.make("drift/compare", {
  payload: { snapshot: Schema.Unknown, baseline: Schema.Unknown },
  success: Schema.Unknown,
  error: Schema.Unknown,
  capabilities: ["drift/compare"],
  body: ({ snapshot }) => Node.succeed({ drifted: true, snapshot })
})

/** The alert member: it is handed `{ comparison, snapshot, baseline }`. */
const alert = Flow.make("drift/alert", {
  payload: { comparison: Schema.Unknown, snapshot: Schema.Unknown, baseline: Schema.Unknown },
  success: Schema.Unknown,
  error: Schema.Unknown,
  capabilities: ["drift/alert"],
  body: ({ comparison }) => Node.succeed({ paged: comparison })
})

interface Snapshot {
  readonly checksum: string
}

describe("DriftDetector", () => {
  it("declares capture, compare, and the alert arm", () => {
    const detector = DriftDetector.make({ capture, compare, alert, baseline: { checksum: "a" } })
    const graph = Graph.build(detector, { input: { target: "config" } })

    expect(Flow.isFlow(detector)).toBe(true)
    expect(callsTo(graph, "drift/capture")).toHaveLength(1)
    expect(callsTo(graph, "drift/compare")).toHaveLength(1)
    expect(callsTo(graph, "drift/alert")).toHaveLength(1)
  })

  it("declares no alert call when the detector only reports", () => {
    const detector = DriftDetector.make({ capture, compare, baseline: { checksum: "a" } })
    const graph = Graph.build(detector, { input: { target: "config" } })

    expect(callsTo(graph, "drift/alert")).toHaveLength(0)
    expect(callsTo(graph, "drift/compare")).toHaveLength(1)
  })

  it("hands the declared baseline to every stage it calls", () => {
    const baseline = { checksum: "a" }
    const graph = Graph.build(
      DriftDetector.make({ capture, compare, alert, baseline }),
      { input: { target: "config" } }
    )

    // The baseline is a declared literal, so it reaches each call's payload as
    // a value rather than as a reference to an earlier node.
    expect(payloadOf(callsTo(graph, "drift/capture")[0]!).baseline).toEqual(baseline)
    expect(payloadOf(callsTo(graph, "drift/compare")[0]!).baseline).toEqual(baseline)
    expect(payloadOf(callsTo(graph, "drift/alert")[0]!).baseline).toEqual(baseline)
  })

  it("keeps the caller's name and description on the declared flow", () => {
    const named = DriftDetector.make({
      name: "config-drift",
      description: "Watch the config against its baseline.",
      capture,
      compare,
      baseline: { checksum: "a" }
    })

    expect(named._tag).toBe("config-drift")
    expect(named.description).toBe("Watch the config against its baseline.")
    const derived = DriftDetector.make({ capture, compare, baseline: { checksum: "a" } })
    expect(derived._tag).toBe("driftDetector(alerts=false)")
    expect(derived.description).toBeUndefined()
  })

  it.effect("alerts once with the comparison when the snapshot drifted", () =>
    Effect.gen(function*() {
      const alerted: Array<unknown> = []
      const result = yield* DriftDetector.run({ target: "config" }, {
        baseline: { checksum: "a" } as Snapshot,
        capture: () => Effect.succeed({ checksum: "b" }),
        compare: ({ baseline, snapshot }) =>
          Effect.succeed({ drifted: snapshot.checksum !== baseline.checksum, from: baseline.checksum }),
        alert: (input) => Effect.sync(() => (alerted.push(input.comparison), "paged"))
      })

      expect(result.drifted).toBe(true)
      expect(result.snapshot).toEqual({ checksum: "b" })
      expect(result.alert).toBe("paged")
      expect(alerted).toEqual([{ drifted: true, from: "a" }])
    }))

  it.effect("skips the alert when nothing drifted", () =>
    Effect.gen(function*() {
      let alerts = 0
      const result = yield* DriftDetector.run({ target: "config" }, {
        baseline: { checksum: "a" } as Snapshot,
        capture: () => Effect.succeed({ checksum: "a" }),
        compare: ({ baseline, snapshot }) => Effect.succeed({ drifted: snapshot.checksum !== baseline.checksum }),
        alert: () => Effect.sync(() => (++alerts, "paged"))
      })

      expect(result.drifted).toBe(false)
      expect(result.alert).toBeUndefined()
      expect(alerts).toBe(0)
    }))

  it.effect("hands the baseline to capture and compare", () =>
    Effect.gen(function*() {
      const seen: Array<unknown> = []
      yield* DriftDetector.run({ target: "config" }, {
        baseline: { checksum: "a" } as Snapshot,
        capture: (input) => Effect.sync(() => (seen.push(input.baseline), { checksum: "a" })),
        compare: (input) => Effect.sync(() => (seen.push(input.baseline), { drifted: false }))
      })

      expect(seen).toEqual([{ checksum: "a" }, { checksum: "a" }])
    }))

  it.effect("lets a custom alertIf override the default reader", () =>
    Effect.gen(function*() {
      let alerts = 0
      const result = yield* DriftDetector.run({ target: "config" }, {
        baseline: 100,
        capture: () => Effect.succeed(140),
        compare: ({ baseline, snapshot }) => Effect.succeed({ delta: snapshot - baseline }),
        alertIf: (comparison) => comparison.delta > 25,
        alert: () => Effect.sync(() => (++alerts, "paged"))
      })

      expect(result.drifted).toBe(true)
      expect(alerts).toBe(1)
    }))

  it.effect("reports drift without alerting when no alert is configured", () =>
    Effect.gen(function*() {
      const result = yield* DriftDetector.run({ target: "config" }, {
        baseline: { checksum: "a" } as Snapshot,
        capture: () => Effect.succeed({ checksum: "b" }),
        compare: ({ baseline, snapshot }) => Effect.succeed({ drifted: snapshot.checksum !== baseline.checksum }),
        alertIf: undefined
      })

      expect(result.drifted).toBe(true)
      expect(result.alert).toBeUndefined()
      expect(result.comparison).toEqual({ drifted: true })
    }))

  it("reads the drift signals a comparison may carry", () => {
    expect(DriftDetector.drifted(true)).toBe(true)
    expect(DriftDetector.drifted({ drifted: true })).toBe(true)
    expect(DriftDetector.drifted({ drifted: false })).toBe(false)
    expect(DriftDetector.drifted(Object.create({ drifted: true }))).toBe(false)
    expect(DriftDetector.drifted("changed")).toBe(false)
  })
})
