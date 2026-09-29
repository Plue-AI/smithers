import { CaseExecutor, Suite } from "@smthrs/evals"
import { Effect } from "effect"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import * as Binding from "../agent/scorers/src/Binding.ts"
import * as Scorer from "../agent/scorers/src/Scorer.ts"
import * as Flow from "../flows/core/src/Flow.ts"
import { createEvalCli } from "../src/evaluation/EvalCli.ts"
import * as Evaluation from "../src/evaluation/Evaluation.ts"

const roots: Array<string> = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "smthrs-eval-cli-"))
  roots.push(root)
  return root
}
const serve = async (root: string, args: Array<string>) => {
  let output = ""
  let code = 0
  await createEvalCli().serve([...args, "--root", root, "--json"], {
    stdout: (value) => {
      output += value
    },
    exit: (value) => {
      code = value
    }
  })
  return { code, output, json: JSON.parse(output) }
}

const result = async (score: number): Promise<Evaluation.RunArtifact> => {
  const target = Flow.make({ name: "eval-cli-target" })
  const scorer = Scorer.make({
    id: "cli/evaluation/exact",
    version: "1",
    name: "exact",
    score: () => Effect.succeed({ score })
  })
  const suite = await Effect.runPromise(Suite.make({
    name: "cli-exact",
    concurrency: 1,
    cases: [{ name: "first", input: 42, expected: 42 }],
    bindings: [Binding.make({ scorer, appliesTo: target })]
  }))
  return Evaluation.execute(
    suite,
    CaseExecutor.make((entry) =>
      Effect.succeed({ output: entry.input, stepKey: `step-${score}`, latencyMs: 0, target })
    ),
    {
      runId: `run-${score}`,
      at: "2026-09-04T00:00:00.000Z"
    }
  )
}

describe("evaluation CLI", () => {
  it("lists the repo\u0027s shipped fixed suites from its root", async () => {
    const listed = await serve(process.cwd(), ["list"])
    expect(listed.code, listed.output).toBe(0)
    expect(listed.json.suites.map((entry: { name: string }) => entry.name)).toEqual([
      "agent/agent",
      "recommend/recommend",
      "review-seeded-bugs/review-seeded-bugs"
    ])
  })

  it("discovers suite metadata without importing modules", async () => {
    const root = await fixture()
    await mkdir(join(root, "evals", "nested"), { recursive: true })
    await writeFile(join(root, "evals", "nested", "unsafe.eval.ts"), "throw new Error(\"must not import\")")
    const listed = await serve(root, ["list"])
    expect(listed.code, listed.output).toBe(0)
    expect(listed.output).toContain("nested/unsafe")
    expect(await readdir(root)).toEqual(["evals"])
  })

  it("executes real scorers, roundtrips artifacts, baselines and detects regressions", async () => {
    const root = await fixture()
    const good = await result(1)
    expect(good.observations[0]).toMatchObject({ kind: "score", score: 1 })
    await Evaluation.writeJson(Evaluation.runPath(root, good.runId), JSON.stringify(good))
    const baseline = await serve(root, ["baseline", good.runId])
    expect(baseline.code, baseline.output).toBe(0)
    const equal = await serve(root, ["compare", good.runId])
    expect(equal.code, equal.output).toBe(0)
    const bad = await result(0)
    await Evaluation.writeJson(Evaluation.runPath(root, bad.runId), JSON.stringify(bad))
    const regression = await serve(root, ["compare", bad.runId, "--output", "comparison.json"])
    expect(regression.code, regression.output).toBe(1)
    expect(regression.output).toContain("eval_regression")
    expect(JSON.parse(await readFile(join(root, "comparison.json"), "utf8")).report.regressions).toHaveLength(1)
    const refusal = await serve(root, ["baseline", bad.runId])
    expect(refusal.code).toBe(1)
    expect((await serve(root, ["compare", good.runId])).code).toBe(0)
  })

  it("does not turn missing observations or failed cases into a passing baseline", async () => {
    const root = await fixture()
    const inconclusive = { ...await result(1), observations: [] }
    await Evaluation.writeJson(Evaluation.runPath(root, "inconclusive"), JSON.stringify(inconclusive))
    expect((await serve(root, ["baseline", "inconclusive"])).code).toBe(1)
    const invalid = await serve(root, ["run", "missing.eval.ts"])
    expect(invalid.code).toBe(5)
    expect(invalid.output).toContain("eval_run_failed")
  })

  it("publishes artifacts without replacement or leftover temporary files", async () => {
    const root = await fixture()
    const file = join(root, "result.json")
    await Evaluation.writeJson(file, "{\"original\":true}")
    await expect(Evaluation.writeJson(file, "replacement")).rejects.toMatchObject({ code: "EEXIST" })
    expect(await readFile(file, "utf8")).toBe("{\"original\":true}")
    expect(await readdir(root)).toEqual(["result.json"])
    expect(() => Evaluation.runPath(root, "../escape")).toThrow("Run IDs")
    expect(() => Evaluation.localRoot({ root, remote: "https://example.invalid" })).toThrow("--remote")
  })
})
