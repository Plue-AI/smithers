/** Offline command-recommendation fixture exposed to the fixed-suite CLI. */
import { CaseExecutor, Suite } from "@smthrs/evals"
import { Effect } from "effect"
import { readFileSync } from "node:fs"
import * as Binding from "../../packages/smithers/agent/scorers/src/Binding.ts"
import * as Scorer from "../../packages/smithers/agent/scorers/src/Scorer.ts"
import * as Flow from "../../packages/smithers/flows/core/src/Flow.ts"
import { parseLog, scoreLog } from "./score.ts"

const target = Flow.make({ name: "evals/recommend/fixture" })
const scorer = Scorer.make({
  id: "evals/recommend/hit-rate",
  version: "1",
  name: "recommend/hit-rate",
  score: ({ output }) => Effect.succeed({
    score: scoreLog(output as ReturnType<typeof parseLog>).hitRate ?? 0
  })
})

export const suite = Suite.make({
  name: "recommend",
  concurrency: 1,
  cases: [{ name: "sample", input: "fixtures/sample.jsonl" }],
  bindings: [Binding.make({ scorer, appliesTo: target })]
})

export const executor: CaseExecutor.Service = CaseExecutor.make(() =>
  Effect.sync(() => ({
    output: parseLog(readFileSync(new URL("./fixtures/sample.jsonl", import.meta.url), "utf8")),
    stepKey: "recommend/sample",
    latencyMs: 0,
    target
  }))
)

export default { suite, executor }
