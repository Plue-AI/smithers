import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { describe, expect, expectTypeOf, it } from "vitest"
import * as Binding from "../src/Binding.ts"
import * as Scorer from "../src/Scorer.ts"

const scorer = () =>
  Scorer.make({
    id: "packages/smithers/agent/scorers/test/Binding/score",
    version: "1",
    name: "score",
    score: () => Effect.succeed({ score: 1 })
  })

class RubricUnavailable extends Schema.TaggedError<RubricUnavailable>()(
  "packages/smithers/agent/scorers/test/Binding/RubricUnavailable",
  { reason: Schema.String }
) {}

class JudgeUnavailable extends Schema.TaggedError<JudgeUnavailable>()(
  "packages/smithers/agent/scorers/test/Binding/JudgeUnavailable",
  { model: Schema.String }
) {}

const rubricScorer = () =>
  Scorer.make<RubricUnavailable>({
    id: "packages/smithers/agent/scorers/test/Binding/rubric",
    version: "1",
    name: "rubric",
    score: () => Effect.fail(new RubricUnavailable({ reason: "rubric not published" }))
  })

const judgeScorer = () =>
  Scorer.make<JudgeUnavailable>({
    id: "packages/smithers/agent/scorers/test/Binding/judge",
    version: "1",
    name: "judge",
    score: () => Effect.fail(new JudgeUnavailable({ model: "none" }))
  })

describe("Binding", () => {
  it("does not modify the target declaration", () => {
    const target = { name: "target" } as const
    const binding = Binding.make({
      scorer: scorer(),
      appliesTo: target,
      groundTruth: "expected",
      context: { rubric: "exact" }
    })
    expect(binding.appliesTo).toBe(target)
    expect(binding.sampling).toBe("all")
    expect(binding.context).toEqual({ rubric: "exact" })
    expect(target.name).toBe("target")
  })

  it("keeps an explicit sampling policy", () => {
    const binding = Binding.make({
      scorer: scorer(),
      appliesTo: ({ name: "target" } as const),
      sampling: { ratio: 0.5, seed: "v1" }
    })
    expect(binding.sampling).toEqual({ ratio: 0.5, seed: "v1" })
  })

  it("retains context and ground truth by reference, as documented", () => {
    // Pinned, not endorsed: the copy is shallow and scoring runs later, so a
    // caller that mutates either object after binding changes what the scorer
    // sees. This test exists so that policy cannot change silently.
    const context = { rubric: "exact" }
    const groundTruth = { answer: 1 }
    const binding = Binding.make({
      scorer: scorer(),
      appliesTo: ({ name: "target" } as const),
      context,
      groundTruth
    })
    context.rubric = "loose"
    groundTruth.answer = 2
    expect(binding.context).toEqual({ rubric: "loose" })
    expect(binding.groundTruth).toEqual({ answer: 2 })
  })

  it("binds a scorer that declares a custom failure", async () => {
    // Compile-time: the binding erases the scorer failure to `unknown`, so a
    // `Scorer<E>` from `Scorer.make` crosses the boundary without a cast. The
    // field was `Scorer<never>`, which no custom failure could satisfy.
    expectTypeOf<Scorer.Scorer<RubricUnavailable>>().toExtend<Binding.Binding["scorer"]>()
    const declared = rubricScorer()
    const binding: Binding.Binding = Binding.make({
      scorer: declared,
      appliesTo: ({ name: "target" } as const)
    })
    expect(binding.scorer).toBe(declared)
    const failure = await Effect.runPromise(Effect.flip(binding.scorer.score({ input: "q", output: "a" })))
    expect(failure).toBeInstanceOf(RubricUnavailable)
  })

  it("collects bindings whose scorers fail in unrelated ways", () => {
    // Compile-time: one erased boundary is what lets a heterogeneous list of
    // bindings exist at all, which is how a suite holds them.
    const target = { name: "target" } as const
    const bindings: ReadonlyArray<Binding.Binding> = [
      Binding.make({ scorer: rubricScorer(), appliesTo: target }),
      Binding.make({ scorer: judgeScorer(), appliesTo: target })
    ]
    expect(bindings.map((binding) => binding.scorer.name)).toEqual(["rubric", "judge"])
  })
})
