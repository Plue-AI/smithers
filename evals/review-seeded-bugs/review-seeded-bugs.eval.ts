/** Offline seeded-review fixture suite for the fixed-suite CLI. */
import { CaseExecutor, Suite } from "@smthrs/evals"
import { Effect } from "effect"
import { layerMemory } from "./host.ts"
import * as Binding from "../../packages/smithers/agent/scorers/src/Binding.ts"
import * as Scorer from "../../packages/smithers/agent/scorers/src/Scorer.ts"
import * as Flow from "../../packages/smithers/flows/core/src/Flow.ts"
import { answerReview } from "./deterministicReviewer.ts"
import { loadCorpus } from "./labels.ts"
import { runFixture } from "./run.ts"
import { scoreCorpus, type ReviewFinding } from "./score.ts"
import { scriptedSeats } from "./scriptedSeats.ts"

const target = Flow.make({ name: "evals/review-seeded-bugs/fixture" })
const labels = loadCorpus()
const scorer = Scorer.make({
  id: "evals/review-seeded-bugs/f1",
  version: "1",
  name: "review-seeded-bugs/f1",
  score: ({ output, groundTruth }) => Effect.sync(() =>
    ({ score: scoreCorpus([groundTruth as (typeof labels)[number]], {
      [(groundTruth as (typeof labels)[number]).fixture]: output as ReviewFinding[]
    }).f1 })
  )
})

export const suite = Suite.make({
  name: "review-seeded-bugs",
  concurrency: 1,
  cases: labels.map((label) => ({
    name: label.fixture,
    input: label.fixture,
    expected: label
  })),
  bindings: [Binding.make({ scorer, appliesTo: target })]
})

export const executor: CaseExecutor.Service = CaseExecutor.make((entry) =>
  Effect.promise(async () => {
    const label = labels.find((item) => item.fixture === entry.input)
    if (label === undefined) throw new Error(`Unknown fixture: ${entry.input}`)
    const result = await runFixture(label, layerMemory(scriptedSeats(answerReview), {}))
    return {
      output: result.findings,
      stepKey: `review-seeded-bugs/${label.fixture}`,
      latencyMs: 0,
      target
    }
  })
)

export default { suite, executor }
