import { CaseExecutor, Suite } from "@smthrs/evals"
import { Effect } from "effect"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import * as Binding from "../agent/scorers/src/Binding.ts"
import * as Scorer from "../agent/scorers/src/Scorer.ts"
import * as Flow from "../flows/core/src/Flow.ts"
import * as CliError from "../src/CliError.ts"
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
  it("CLI runs three trials and reports pass@k", async () => {
    const root = await fixture()
    await mkdir(join(root, "evals"))
    const base = process.cwd()
    const effectPath = createRequire(import.meta.url).resolve("effect/Effect")
    await writeFile(
      join(root, "evals", "trials.eval.ts"),
      [
        `import * as Effect from "${effectPath}"`,
        `import * as Flow from "${base}/packages/smithers/flows/core/src/Flow.ts"`,
        `import * as Scorer from "${base}/packages/smithers/agent/scorers/src/Scorer.ts"`,
        `import * as Binding from "${base}/packages/smithers/agent/scorers/src/Binding.ts"`,
        `import * as CaseExecutor from "${base}/packages/smithers/agent/evals/src/CaseExecutor.ts"`,
        "const target = Flow.make({ name: 'trial-target' })",
        "const scorer = Scorer.make({ id: 'cli/trials', version: '1', name: 'trial', score: ({ output }) => Effect.succeed({ score: output }) })",
        "export const suite = { name: 'trials', concurrency: 1, cases: [{ name: 'one', input: 1 }], bindings: [Binding.make({ scorer, appliesTo: target })] }",
        "let calls = 0",
        "export const executor = CaseExecutor.make(() => Effect.sync(() => ({ output: ++calls % 3 === 0 ? 0 : 1, stepKey: 'step', latencyMs: 0, target })))"
      ].join("\n")
    )
    const run = await serve(root, ["run", "trials", "--trials", "3", "--k", "2"])
    expect(run.code, run.output).toBe(0)
    expect(run.output).toContain("pass@1")
    expect(run.output).toContain("pass@2")
    const saved = JSON.parse(await readFile(Evaluation.runPath(root, run.json.runId), "utf8"))
    expect(saved.cases[0].trials).toMatchObject({ n: 3, passes: 2, passAtK: 1 })
    expect(saved.observations).toHaveLength(3)
  })

  it("lists the repo\u0027s shipped fixed suites from its root", async () => {
    // The shipped suites live under the repository root's `evals/`; vitest
    // runs from `packages/smithers`, so the root is named from this file.
    const listed = await serve(fileURLToPath(new URL("../../..", import.meta.url)), ["list"])
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
    expect(invalid.code).toBe(2)
    expect(invalid.output).toContain("eval_run_failed")
    expect(invalid.json.message).toContain("is not a suite module under")
  })

  it("answers operator mistakes with exit 2 and the sentence that names the fix", async () => {
    const root = await fixture()
    await mkdir(join(root, "evals"))
    await writeFile(join(root, "evals", "same.eval.mjs"), "throw new Error(\"must not import\")")
    await writeFile(join(root, "evals", "same.eval.js"), "throw new Error(\"must not import\")")
    const ambiguous = await serve(root, ["run", "same"])
    expect(ambiguous.code, ambiguous.output).toBe(2)
    expect(ambiguous.json).toMatchObject({
      code: "eval_run_failed",
      message: "Ambiguous evaluation suite same; specify its file"
    })
    expect(ambiguous.output).not.toContain("must not import")
    const runId = await serve(root, ["run", "same.eval.mjs", "--run-id", "../escape"])
    expect(runId.code, runId.output).toBe(2)
    expect(runId.json.message).toBe("Run IDs must contain only letters, digits, '.', '_' or '-'")
    const baselineId = await serve(root, ["baseline", "bad id"])
    expect(baselineId.code, baselineId.output).toBe(2)
    expect(baselineId.json.code).toBe("eval_baseline_failed")
  })

  it("names a missing or unreadable saved run without leaking the file-system or parser text", async () => {
    const root = await fixture()
    const missing = await serve(root, ["compare", "absent"])
    expect(missing.code, missing.output).toBe(5)
    expect(missing.json).toMatchObject({
      code: "eval_compare_failed",
      message: `No saved evaluation run at ${Evaluation.runPath(root, "absent")}; run the suite first`
    })
    expect(missing.output).not.toMatch(/ENOENT|no such file/)
    await writeFile(join(root, "broken.json"), "{ not json")
    const broken = await serve(root, ["baseline", "broken.json"])
    expect(broken.code, broken.output).toBe(1)
    expect(broken.json).toMatchObject({
      code: "eval_baseline_failed",
      message: `${join(root, "broken.json")} is not a saved evaluation run`
    })
    expect(broken.output).not.toMatch(/Unexpected|JSON|position/)
    const good = await result(1)
    await writeFile(join(root, "wrong.json"), JSON.stringify({ ...good, version: 2 }))
    const wrong = await serve(root, ["compare", "wrong.json"])
    expect(wrong.code, wrong.output).toBe(5)
    expect(wrong.json.message).toBe(`${join(root, "wrong.json")} is not a saved evaluation run`)
    expect(wrong.output).not.toMatch(/invalid_literal|expected|Zod/i)
  })

  it("names a missing baseline and refuses an incomplete run as one", async () => {
    const root = await fixture()
    const good = await result(1)
    await Evaluation.writeJson(Evaluation.runPath(root, good.runId), JSON.stringify(good))
    const noBaseline = await serve(root, ["compare", good.runId])
    expect(noBaseline.code, noBaseline.output).toBe(5)
    expect(noBaseline.json.message).toBe(
      `No baseline at ${Evaluation.defaultBaselinePath(root, good.suite)}; write one with eval baseline`
    )
    expect(noBaseline.output).not.toMatch(/ENOENT|no such file/)
    await Evaluation.writeJson(Evaluation.runPath(root, "empty"), JSON.stringify({ ...good, observations: [] }))
    const incomplete = await serve(root, ["baseline", "empty"])
    expect(incomplete.code, incomplete.output).toBe(1)
    expect(incomplete.json).toMatchObject({
      code: "eval_baseline_failed",
      message: "Cannot commit an incomplete or inconclusive evaluation as a baseline"
    })
  })

  it("publishes artifacts without replacement or leftover temporary files", async () => {
    const root = await fixture()
    const file = join(root, "result.json")
    await Evaluation.writeJson(file, "{\"original\":true}")
    await expect(Evaluation.writeJson(file, "replacement")).rejects.toMatchObject({ code: "EEXIST" })
    expect(await readFile(file, "utf8")).toBe("{\"original\":true}")
    expect(await readdir(root)).toEqual(["result.json"])
    expect(() => Evaluation.runPath(root, "../escape")).toThrow(CliError.UsageError)
    expect(() => Evaluation.localRoot({ root, remote: "https://example.invalid" })).toThrow("--remote")
  })
})
