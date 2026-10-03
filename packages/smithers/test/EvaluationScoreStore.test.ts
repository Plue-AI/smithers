import { NodeCrypto, NodeServices } from "@effect/platform-node"
import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import * as NodeRuntime from "@smthrs/flows/NodeRuntime"
import * as ScoreStore from "@smthrs/scorers/ScoreStore"
import * as SqlScoreStore from "@smthrs/scorers/SqlScoreStore"
import { Effect, Layer } from "effect"
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createEvalCli } from "../src/evaluation/EvalCli.ts"
import * as Evaluation from "../src/evaluation/Evaluation.ts"

const roots: Array<string> = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const first = "2026-09-04T00:00:00.000Z"
const second = "2026-09-05T00:00:00.000Z"
const stepKey = "implementation-1"

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "smthrs-evaluation-scores-"))
  roots.push(root)
  return root
}

const engineDatabase = (root: string) => join(root, ".flows", "engine.db")

/** Creates the project's real engine store, exactly as a run host does. */
const withEngineStore = async (root: string) => {
  await Effect.runPromise(Effect.void.pipe(
    Effect.provide(NodeRuntime.storage(engineDatabase(root), root)),
    Effect.provide(NodeServices.layer),
    Effect.provide(NodeCrypto.layer)
  ))
}

const writeSuite = async (root: string, failure?: "scorer") => {
  const file = join(root, "evals", "exact.eval.mjs")
  await mkdir(dirname(file), { recursive: true })
  await writeFile(
    file,
    `
import { Effect } from ${JSON.stringify(import.meta.resolve("effect"))}
import { Suite, CaseExecutor } from ${JSON.stringify(new URL("../agent/evals/src/index.ts", import.meta.url).href)}
import * as Flow from ${JSON.stringify(new URL("../flows/core/src/Flow.ts", import.meta.url).href)}
import * as Scorer from ${JSON.stringify(new URL("../agent/scorers/src/Scorer.ts", import.meta.url).href)}
import * as Binding from ${JSON.stringify(new URL("../agent/scorers/src/Binding.ts", import.meta.url).href)}
const target = ({ name: "evaluation-score-store-target" })
const scorer = Scorer.make({
  id: "evaluation-score-store/exact", version: "1", name: "exact",
  score: ({ output }) => ${
      failure === "scorer"
        ? "Effect.fail(new Error(\"judge unavailable\"))"
        : "Effect.succeed({ score: output, reason: \"complete result\" })"
    }
})
export const suite = {
  name: "stored/exact", concurrency: 1,
  cases: [{ name: "first", input: 0.75 }],
  bindings: [Binding.make({ scorer, appliesTo: target })]
}
export const executor = CaseExecutor.make((entry) =>
  Effect.succeed({ output: entry.input, stepKey: ${JSON.stringify(stepKey)}, latencyMs: 0, target }))
`
  )
}

const serve = async (root: string, args: ReadonlyArray<string>) => {
  let output = ""
  let code = 0
  await createEvalCli().serve([...args, "--root", root, "--json"], {
    stdout: (text) => {
      output += text
    },
    exit: (value) => {
      code = value
    }
  })
  return { code, output }
}

/** Reads observations back through the public ScoreStore service. */
const stored = (root: string) =>
  Effect.runPromise(
    Effect.flatMap(Effect.service(ScoreStore.ScoreStore), (store) => store.observations(stepKey)).pipe(
      Effect.provide(
        SqlScoreStore.layer.pipe(
          Layer.provide(
            DurableWriter.layer().pipe(Layer.provideMerge(NodeDatabase.layer({ filename: engineDatabase(root) })))
          )
        )
      )
    )
  )

describe("evaluation scoring over the project's engine store", () => {
  it("records every run's observations in the engine store and reads earlier runs back", async () => {
    const root = await fixture()
    await withEngineStore(root)
    await writeSuite(root)

    const one = await serve(root, ["run", "exact", "--run-id", "one", "--at", first])
    expect(one.code, one.output).toBe(0)
    const afterOne = await stored(root)
    expect(afterOne).toHaveLength(1)

    const two = await serve(root, ["run", "exact", "--run-id", "two", "--at", second])
    expect(two.code, two.output).toBe(0)
    const artifact = await Evaluation.readRun(root, "two")
    const observations = await stored(root)
    expect(observations).toEqual([
      {
        kind: "score",
        targetStepKey: stepKey,
        scorerKey: artifact.observations[0]!.scorer,
        score: 0.75,
        reason: "complete result",
        at: Date.parse(first)
      },
      {
        kind: "score",
        targetStepKey: stepKey,
        scorerKey: artifact.observations[0]!.scorer,
        score: 0.75,
        reason: "complete result",
        at: Date.parse(second)
      }
    ])
    // The engine still opens its store after the score migrations ran in it.
    await withEngineStore(root)
  })

  it("records a repeated run identity once and still returns its observations", async () => {
    const root = await fixture()
    await withEngineStore(root)
    await writeSuite(root)
    const loaded = await Evaluation.load(root, "exact")
    const options = { root, runId: "repeat", at: first }
    const before = await Evaluation.execute(loaded.suite, loaded.executor, options)
    const after = await Evaluation.execute(loaded.suite, loaded.executor, options)
    expect(after).toEqual(before)
    expect(after.observations).toHaveLength(1)
    expect(await stored(root)).toHaveLength(1)
  })

  it("records a failing scorer as an inconclusive observation", async () => {
    const root = await fixture()
    await withEngineStore(root)
    await writeSuite(root, "scorer")
    const result = await serve(root, ["run", "exact", "--run-id", "failed", "--at", first])
    expect(result.code).toBe(5)
    expect(result.output).toContain("eval_inconclusive")
    const observations = await stored(root)
    expect(observations).toHaveLength(1)
    expect(observations[0]).toMatchObject({ kind: "inconclusive", targetStepKey: stepKey, at: Date.parse(first) })
    expect(observations[0]!.reason).toContain("judge unavailable")
  })

  it("scores in process without an engine store and creates none", async () => {
    const root = await fixture()
    await writeSuite(root)
    const result = await serve(root, ["run", "exact", "--run-id", "inline", "--at", first])
    expect(result.code, result.output).toBe(0)
    expect((await Evaluation.readRun(root, "inline")).observations).toMatchObject([
      { kind: "score", score: 0.75, stepKey, at: first }
    ])
    expect(await readdir(join(root, ".flows"))).toEqual(["evals"])
    const loaded = await Evaluation.load(root, "exact")
    const direct = await Evaluation.execute(loaded.suite, loaded.executor, { runId: "inline", at: first })
    expect(direct.observations).toEqual((await Evaluation.readRun(root, "inline")).observations)
    expect(await readdir(join(root, ".flows"))).toEqual(["evals"])
  })

  it("fails the run without an artifact when the engine store cannot be opened", async () => {
    const root = await fixture()
    await mkdir(join(root, ".flows"), { recursive: true })
    await writeFile(engineDatabase(root), "not a database")
    await writeSuite(root)
    const result = await serve(root, ["run", "exact", "--run-id", "broken", "--at", first])
    expect(result.code).toBe(5)
    expect(result.output).toContain("eval_run_failed")
    expect(await readdir(join(root, ".flows"))).toEqual(["engine.db"])
  })

  it("exposes the scoring composition from the public evaluation entry", async () => {
    const exported = await import("@smthrs/cli/evaluation/Evaluation")
    expect(exported.scoring).toBe(Evaluation.scoring)
  })
})
