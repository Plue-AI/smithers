import { describe, it } from "@effect/vitest"
import { Flow, Graph } from "@smthrs/flow"
import * as Node from "@smthrs/plan/Node"
import * as Planned from "@smthrs/plan/Planned"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Latch from "effect/Latch"
import * as Schema from "effect/Schema"
import { expect } from "vitest"
import { PatternError } from "../src/PatternError.ts"
import * as Sidecar from "../src/Sidecar.ts"
import { callsTo, payloadOf } from "./Graphs.ts"

const flowNamed = (capability: string) =>
  Flow.make(capability, {
    capabilities: [capability],
    payload: {
      input: Schema.Unknown,
      primary: Schema.optional(Schema.Unknown),
      shadow: Schema.optional(Schema.Unknown)
    },
    success: Schema.Unknown,
    error: Schema.Unknown,
    body: ({ input }) => Node.succeed(input)
  })

const prompt = { input: "prompt" }

const primary = flowNamed("sidecar/primary")
const shadow = flowNamed("sidecar/shadow")
const score = flowNamed("sidecar/score")

const invalidScores = [
  { primary: Number.NaN, shadow: 0, message: "Sidecar primary score must be a finite number, received NaN" },
  { primary: 0, shadow: Number.NaN, message: "Sidecar shadow score must be a finite number, received NaN" },
  {
    primary: Number.POSITIVE_INFINITY,
    shadow: 0,
    message: "Sidecar primary score must be a finite number, received Infinity"
  },
  {
    primary: 0,
    shadow: Number.POSITIVE_INFINITY,
    message: "Sidecar shadow score must be a finite number, received Infinity"
  },
  {
    primary: Number.NEGATIVE_INFINITY,
    shadow: 0,
    message: "Sidecar primary score must be a finite number, received -Infinity"
  },
  {
    primary: 0,
    shadow: Number.NEGATIVE_INFINITY,
    message: "Sidecar shadow score must be a finite number, received -Infinity"
  },
  {
    primary: 1e308,
    shadow: -1e308,
    message: "Sidecar score difference must be a finite number, received Infinity"
  }
] as const

describe("Sidecar", () => {
  it("declares the primary and the shadow as one concurrent All", () => {
    const pattern = Sidecar.make({ primary, shadow })
    const graph = Graph.build(pattern, prompt)

    expect(Flow.isFlow(pattern)).toBe(true)
    expect(Graph.nodes(graph).filter((node) => node.kind === "All")).toHaveLength(1)
    expect(callsTo(graph, "sidecar/primary")).toHaveLength(1)
    expect(callsTo(graph, "sidecar/shadow")).toHaveLength(1)
    expect(callsTo(graph, "sidecar/score")).toHaveLength(0)
  })

  it("keeps the caller's name and description on the declared flow", () => {
    const pattern = Sidecar.make({ primary, shadow, name: "cheap-check", description: "Compare the two models." })

    expect(pattern._tag).toBe("cheap-check")
    expect(pattern.description).toBe("Compare the two models.")
    expect(Sidecar.make({ primary, shadow }).description).toBeUndefined()
  })

  it("puts the shadow behind a catch and leaves the primary bare", () => {
    const graph = Graph.build(Sidecar.make({ primary, shadow }), prompt)

    // One arm, on the shadow. A sidecar is not a fallback ladder: a failed
    // primary is a failed run, so the primary must not gain an arm of its own.
    expect(Graph.nodes(graph).filter((node) => node.kind === "Catch")).toHaveLength(1)
    // The marker the arm produces lives on the node's payload, and the error
    // inside it is the planned reference to the shadow it recovers.
    const recovery = Graph.nodes(graph).find((node) => node.id.endsWith("all.shadow.failure"))
    expect(recovery?.draft.material.body).toEqual({ _tag: "Succeed" })
    expect(recovery?.payload).toMatchObject({ quarantined: true })
    // The sidecar declares no ceiling of its own, so it inherits its caller's
    // authority and neither member's declaration falls outside the grant.
    expect(Graph.diagnostics(graph)).toEqual([])
  })

  it("hands the scorer the pair run hands it", () => {
    const graph = Graph.build(Sidecar.make({ primary, shadow, score }), prompt)

    // The scorer reads the shadow's VALUE, not its quarantine wrapper, so the
    // declared scorer payload names those two planned paths. Core recorded the
    // same two paths as `PlannedInput` entries in the node's key material;
    // `@smthrs/flow` keeps them as planned references on the payload.
    const scorer = callsTo(graph, "sidecar/score")[0]!
    const path = (value: unknown) => Planned.reference(value)?.path

    expect(path(payloadOf(scorer).primary)).toEqual(["primary"])
    expect(path(payloadOf(scorer).shadow)).toEqual(["shadow", "value"])
  })

  it("declares the scorer call when one is configured", () => {
    const graph = Graph.build(Sidecar.make({ primary, shadow, score }), prompt)

    expect(callsTo(graph, "sidecar/score")).toHaveLength(1)
    expect(Graph.nodes(graph).filter((node) => node.kind === "All")).toHaveLength(1)
  })

  it.effect("returns the primary value when the shadow fails", () =>
    Effect.gen(function*() {
      const result = yield* Sidecar.run("prompt", {
        primary: () => Effect.succeed("answer"),
        shadow: () => Effect.fail("shadow is broken")
      })

      expect(result.primary).toBe("answer")
      expect(result.shadow.quarantined).toBe(true)
      if (result.shadow.quarantined) {
        expect(Cause.hasFails(result.shadow.cause)).toBe(true)
      }
    }))

  it.effect("quarantines a shadow defect as well as a typed failure", () =>
    Effect.gen(function*() {
      const result = yield* Sidecar.run("prompt", {
        primary: () => Effect.succeed("answer"),
        shadow: () => Effect.die(new Error("shadow blew up"))
      })

      expect(result.primary).toBe("answer")
      expect(result.shadow.quarantined).toBe(true)
      if (result.shadow.quarantined) {
        expect(Cause.hasDies(result.shadow.cause)).toBe(true)
      }
    }))

  it.effect("quarantines a shadow callback that throws before it returns an effect", () =>
    Effect.gen(function*() {
      let primaryRan = false
      const result = yield* Sidecar.run("prompt", {
        primary: () =>
          Effect.sync(() => {
            primaryRan = true
            return "answer"
          }),
        shadow: (): Effect.Effect<never> => {
          throw new Error("shadow factory blew up")
        }
      })

      expect(primaryRan).toBe(true)
      expect(result.primary).toBe("answer")
      expect(result.shadow.quarantined).toBe(true)
      if (result.shadow.quarantined) {
        expect(Cause.hasDies(result.shadow.cause)).toBe(true)
      }
    }))

  it.effect("propagates a shadow interruption instead of quarantining it", () =>
    Effect.gen(function*() {
      const exit = yield* Effect.exit(
        Sidecar.run("prompt", {
          primary: () => Effect.succeed("answer"),
          shadow: () => Effect.interrupt
        })
      )

      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") expect(Cause.hasInterrupts(exit.cause)).toBe(true)
    }))

  it.effect("fails when the primary fails, because the shadow is not a fallback", () =>
    Effect.gen(function*() {
      const failure = yield* Sidecar.run("prompt", {
        primary: () => Effect.fail("primary is broken"),
        shadow: () => Effect.succeed("cheap answer")
      }).pipe(Effect.flip)

      expect(failure).toBe("primary is broken")
    }))

  // Real clock: the handshake below never settles under a sequential
  // implementation, and the timeout that turns that into a failure has to
  // elapse on its own.
  it.live("starts the primary and the shadow concurrently", () =>
    Effect.gen(function*() {
      const primaryStarted = yield* Latch.make(false)
      const shadowStarted = yield* Latch.make(false)
      // Each side waits for the other to have started, so no sequential order
      // completes this run.
      const result = yield* Sidecar.run("prompt", {
        primary: () => Effect.as(Effect.andThen(primaryStarted.open, shadowStarted.await), "answer"),
        shadow: () => Effect.as(Effect.andThen(shadowStarted.open, primaryStarted.await), "cheap answer")
      }).pipe(Effect.timeoutOrElse({
        duration: "2 seconds",
        orElse: () => Effect.die(new Error("the primary and the shadow did not overlap"))
      }))

      expect(result.primary).toBe("answer")
      expect(result.shadow).toEqual({ quarantined: false, value: "cheap answer" })
    }))

  it.effect("interleaves the primary and the shadow rather than sequencing them", () =>
    Effect.gen(function*() {
      const events: Array<string> = []
      const step = (name: string) =>
        Effect.sync(() => events.push(`start-${name}`)).pipe(
          Effect.andThen(Effect.yieldNow),
          Effect.andThen(Effect.sync(() => events.push(`end-${name}`))),
          Effect.as(name)
        )
      yield* Sidecar.run("prompt", { primary: () => step("primary"), shadow: () => step("shadow") })

      expect(events).toEqual(["start-primary", "start-shadow", "end-primary", "end-shadow"])
    }))

  it.effect("scores both outputs and reports the difference", () =>
    Effect.gen(function*() {
      const seen: Array<unknown> = []
      const result = yield* Sidecar.run("prompt", {
        primary: () => Effect.succeed("answer"),
        shadow: () => Effect.succeed("cheap answer"),
        score: (input) =>
          Effect.sync(() => {
            seen.push(input)
            return { primary: 0.8, shadow: 0.6 }
          })
      })

      expect(seen).toEqual([{ primary: "answer", shadow: "cheap answer" }])
      expect(result.delta).toEqual({ primary: 0.8, shadow: 0.6, difference: 0.2, cheaperWins: false })
    }))

  it.effect("does not score when the shadow is quarantined", () =>
    Effect.gen(function*() {
      let scored = 0
      const result = yield* Sidecar.run("prompt", {
        primary: () => Effect.succeed("answer"),
        shadow: () => Effect.fail("shadow is broken"),
        score: () => Effect.sync(() => (++scored, { primary: 1, shadow: 0 }))
      })

      expect(scored).toBe(0)
      expect(result.delta).toBeUndefined()
    }))

  it.effect("refuses non-finite runtime scores and an overflowing difference", () =>
    Effect.gen(function*() {
      for (const scores of invalidScores) {
        const failure = yield* Sidecar.run("prompt", {
          primary: () => Effect.succeed("answer"),
          shadow: () => Effect.succeed("cheap answer"),
          score: () => Effect.succeed(scores)
        }).pipe(Effect.flip)

        expect(failure).toBeInstanceOf(PatternError)
        expect((failure as PatternError).code).toBe("invalid_input")
        expect((failure as PatternError).message).toBe(scores.message)
      }
    }))

  it.effect("rounds ordinary runtime scores and preserves a rounded negative zero", () =>
    Effect.gen(function*() {
      const ordinary = yield* Sidecar.run("prompt", {
        primary: () => Effect.succeed("answer"),
        shadow: () => Effect.succeed("cheap answer"),
        score: () => Effect.succeed({ primary: 0.8, shadow: 0.5 })
      })
      const negativeZero = yield* Sidecar.run("prompt", {
        primary: () => Effect.succeed("answer"),
        shadow: () => Effect.succeed("cheap answer"),
        score: () => Effect.succeed({ primary: 0, shadow: Number.MIN_VALUE })
      })

      expect(ordinary.delta).toEqual({ primary: 0.8, shadow: 0.5, difference: 0.3, cheaperWins: false })
      expect(Object.is(negativeZero.delta?.difference, -0)).toBe(true)
      expect(negativeZero.delta?.cheaperWins).toBe(true)
    }))

  it("computes a delta that survives floating-point subtraction", () => {
    expect(Sidecar.delta(0.3, 0.1)).toEqual({ primary: 0.3, shadow: 0.1, difference: 0.2, cheaperWins: false })
    expect(Sidecar.delta(0.6, 0.9)).toEqual({
      primary: 0.6,
      shadow: 0.9,
      difference: -0.3,
      cheaperWins: true
    })
    expect(Sidecar.delta(0.5, 0.5).cheaperWins).toBe(true)
  })

  it("refuses non-finite direct scores and an overflowing difference", () => {
    for (const scores of invalidScores) {
      expect(() => Sidecar.delta(scores.primary, scores.shadow)).toThrow(
        expect.objectContaining({ code: "invalid_input", message: scores.message })
      )
    }
  })

  it("rounds an ordinary direct delta and preserves rounded negative zero", () => {
    expect(Sidecar.delta(0.8, 0.5)).toEqual({
      primary: 0.8,
      shadow: 0.5,
      difference: 0.3,
      cheaperWins: false
    })
    expect(Object.is(Sidecar.delta(0, Number.MIN_VALUE).difference, -0)).toBe(true)
  })
})
