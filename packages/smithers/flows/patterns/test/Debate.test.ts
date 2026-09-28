import { describe, it } from "@effect/vitest"
import { Flow, Graph } from "@smthrs/flow"
import * as Node from "@smthrs/plan/Node"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { expect } from "vitest"
import * as Debate from "../src/Debate.ts"
import { PatternError } from "../src/PatternError.ts"
import { callsTo } from "./Graphs.ts"

// One declaration per role, because a `@smthrs/flow` flow states the payload it
// takes and the three roles take different ones. Counting calls by tag is what
// the old `FlowCall` count meant.
const participant = (tag: string) =>
  Flow.make(tag, {
    payload: { input: Schema.Unknown, transcript: Schema.Unknown, proponent: Schema.Unknown },
    success: Schema.Unknown,
    error: Schema.Unknown,
    body: ({ input }) => Node.succeed(input)
  })

const proponent = participant("proponent")
const opponent = participant("opponent")
const judge = participant("judge")

describe("Debate", () => {
  it("declares bounded participant and judge calls", () => {
    const debate = Debate.make({ proponent, opponent, judge, rounds: 2 })

    expect(Flow.isFlow(debate)).toBe(true)
    expect(debate.body({ input: "topic" }).ast._tag).toBe("AndThen")
    const graph = Graph.build(debate, { input: "topic" })
    expect(callsTo(graph, "proponent")).toHaveLength(2)
    expect(callsTo(graph, "opponent")).toHaveLength(2)
    expect(callsTo(graph, "judge")).toHaveLength(1)
    // Core carried the declaration's digest on `flow.implementation`.
    // `@smthrs/flow` has no such field: a flow's body IS the declaration, and
    // the same fact, that it is digested from its captures rather than minted
    // per instance, is read off the body's function identity.
    expect(Node.functionIdentity(debate.body).algorithm).toBe("sha256-source-captures/v5")
  })

  it("rejects an unbounded round count", () => {
    expect(() => Debate.make({ proponent, opponent, judge, rounds: 0 })).toThrow(
      expect.objectContaining({
        code: "invalid_decorator",
        message: "Debate rounds must be a positive safe integer, received 0"
      })
    )
  })

  it.effect("runs participants with a real accumulated transcript", () =>
    Effect.gen(function*() {
      const seen: Array<unknown> = []
      const result = yield* Debate.run("topic", {
        rounds: 2,
        proponent: ({ input, round, transcript }) => {
          seen.push(["proponent", input, round, transcript.length])
          return Effect.succeed(`p${round}`)
        },
        opponent: ({ input, proponent, round, transcript }) => {
          seen.push(["opponent", input, proponent, round, transcript.length])
          return Effect.succeed(`o${round}`)
        },
        judge: ({ input, transcript }) => Effect.succeed({ input, transcript })
      })

      expect(seen).toEqual([
        ["proponent", "topic", 1, 0],
        ["opponent", "topic", "p1", 1, 0],
        ["proponent", "topic", 2, 1],
        ["opponent", "topic", "p2", 2, 1]
      ])
      expect(result).toEqual({
        input: "topic",
        transcript: [
          { proponent: "p1", opponent: "o1" },
          { proponent: "p2", opponent: "o2" }
        ]
      })
    }))

  it.effect("hands every callback a frozen transcript copy", () =>
    Effect.gen(function*() {
      const retained: Array<ReadonlyArray<Debate.RuntimeTurn<unknown, unknown>>> = []
      const tryForge = (transcript: ReadonlyArray<Debate.RuntimeTurn<unknown, unknown>>) => {
        retained.push(transcript)
        try {
          ;(transcript as Array<Debate.RuntimeTurn<unknown, unknown>>).push({
            proponent: "forged",
            opponent: "forged"
          })
        } catch {
          // A frozen transcript refuses the forged turn.
        }
      }
      const result = yield* Debate.run("topic", {
        rounds: 2,
        proponent: ({ round, transcript }) => {
          tryForge(transcript)
          return Effect.succeed(`p${round}`)
        },
        opponent: ({ round, transcript }) => {
          tryForge(transcript)
          return Effect.succeed(`o${round}`)
        },
        judge: ({ transcript }) => {
          tryForge(transcript)
          return Effect.succeed(transcript)
        }
      })

      expect(retained.every(Object.isFrozen)).toBe(true)
      expect(retained.map((transcript) => transcript.length)).toEqual([0, 0, 1, 1, 2])
      expect(result).toEqual([
        { proponent: "p1", opponent: "o1" },
        { proponent: "p2", opponent: "o2" }
      ])
    }))

  it.effect("freezes turn wrappers so a participant cannot rewrite history", () =>
    Effect.gen(function*() {
      let reassignment: unknown
      let deletion: unknown
      const result = yield* Debate.run("topic", {
        rounds: 2,
        proponent: ({ round, transcript }) => {
          if (round === 2) {
            const first = transcript[0] as { proponent?: string; opponent?: string }
            try {
              first.proponent = "forged"
            } catch (error) {
              reassignment = error
            }
            try {
              delete first.opponent
            } catch (error) {
              deletion = error
            }
          }
          return Effect.succeed(`p${round}`)
        },
        opponent: ({ round }) => Effect.succeed(`o${round}`),
        judge: ({ transcript }) => Effect.succeed(transcript)
      })

      expect(reassignment).toBeInstanceOf(TypeError)
      expect(deletion).toBeInstanceOf(TypeError)
      expect(result).toEqual([
        { proponent: "p1", opponent: "o1" },
        { proponent: "p2", opponent: "o2" }
      ])
    }))

  it.effect("rejects an invalid runtime round count", () =>
    Effect.gen(function*() {
      const failure = yield* Debate.run("topic", {
        rounds: 0,
        proponent: () => Effect.succeed("unused"),
        opponent: () => Effect.succeed("unused"),
        judge: () => Effect.succeed("unused")
      }).pipe(Effect.flip)

      expect(failure).toBeInstanceOf(PatternError)
      expect(failure.code).toBe("invalid_decorator")
      expect(failure.message).toBe("Debate rounds must be a positive safe integer, received 0")
    }))
})
