import type { RuntimeConfig } from "@smthrs/build-cli/Cli"
import { Cli, Mcp } from "incur"
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createEvalCli } from "../src/evaluation/EvalCli.ts"
import * as Evaluation from "../src/evaluation/Evaluation.ts"

const roots: Array<string> = []
const timestamp = "2026-09-04T00:00:00.000Z"
afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "smthrs-evaluation-behavior-"))
  roots.push(root)
  return root
}

const serve = async (root: string, args: ReadonlyArray<string>, runtime: RuntimeConfig = {}) => {
  let output = ""
  let code = 0
  await createEvalCli(runtime).serve([...args, "--root", root, "--json"], {
    stdout: (text) => {
      output += text
    },
    exit: (value) => {
      code = value
    }
  })
  return { code, output, json: JSON.parse(output) }
}

const writeModule = async (root: string, name: string, source: string) => {
  const file = join(root, "evals", name)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, source)
  return file
}

// Real modules exercise import, validation, executor and scorer composition.
// Absolute dependency URLs keep temp projects independent of NODE_PATH and do
// not require installing packages into each disposable project.
const writeSuite = async (root: string, options: {
  file?: string
  shape?: "value" | "promise" | "effect"
  defaultExport?: boolean
  score?: number
  failure?: "executor" | "scorer" | "no-bindings"
} = {}) => {
  const suite = options.shape === "effect" ?
    "Suite.make(declaration)"
    : options.shape === "promise"
    ? "Promise.resolve(declaration)"
    : "declaration"
  return writeModule(
    root,
    options.file ?? "exact.eval.mjs",
    `
import { Effect } from ${JSON.stringify(import.meta.resolve("effect"))}
import { Suite, CaseExecutor } from ${JSON.stringify(new URL("../agent/evals/src/index.ts", import.meta.url).href)}
import * as Flow from ${JSON.stringify(new URL("../flows/core/src/Flow.ts", import.meta.url).href)}
import * as Scorer from ${JSON.stringify(new URL("../agent/scorers/src/Scorer.ts", import.meta.url).href)}
import * as Binding from ${JSON.stringify(new URL("../agent/scorers/src/Binding.ts", import.meta.url).href)}
const target = ({ name: "evaluation-behavior-target" })
const scorer = Scorer.make({
  id: "evaluation-behavior/exact", version: "1", name: "exact",
  score: ({ output }) => ${
      options.failure === "scorer"
        ? "Effect.fail(new Error(\"judge unavailable\"))"
        : "Effect.succeed({ score: output, reason: \"complete result\" })"
    }
})
const declaration = {
  name: "nested/exact", concurrency: 1,
  cases: [{ name: "first", input: ${JSON.stringify(options.score ?? 1)} }],
  bindings: ${options.failure === "no-bindings" ? "[]" : "[Binding.make({ scorer, appliesTo: target })]"}
}
const suite = ${suite}
const executor = CaseExecutor.make((entry) => ${
      options.failure === "executor"
        ? "Effect.fail(new Error(\"executor unavailable\"))"
        : "Effect.succeed({ output: entry.input, stepKey: \"implementation-1\", latencyMs: 0, target })"
    })
${options.defaultExport === true ? "export default { suite, executor }" : "export { suite, executor }"}
`
  )
}

const persist = async (root: string, run: Evaluation.RunArtifact, name = run.runId) => {
  const file = Evaluation.runPath(root, name)
  await Evaluation.writeJson(file, `${JSON.stringify(run)}\n`)
  return file
}

const successful = async (root: string): Promise<Evaluation.RunArtifact> => {
  await writeSuite(root)
  const loaded = await Evaluation.load(root, "exact")
  return Evaluation.execute(loaded.suite, loaded.executor, { runId: "successful", at: timestamp })
}

describe("evaluation suite discovery and execution", () => {
  it("lists sorted supported files without importing hidden, dependency or linked modules", async () => {
    const root = await fixture()
    expect(await Evaluation.list(root)).toEqual([])
    const unsafe = "throw new Error(\"discovery imported code\")"
    for (
      const file of [
        "z.eval.js",
        "a.eval.ts",
        "nested/m.eval.mts",
        "nested/n.eval.mjs",
        ".hidden.eval.ts",
        "node_modules/dependency.eval.js",
        "notes.txt"
      ]
    ) {
      await writeModule(root, file, unsafe)
    }
    await symlink(join(root, "evals", "a.eval.ts"), join(root, "evals", "linked.eval.ts"))
    const response = await serve(root, ["list"])
    expect(response.code, response.output).toBe(0)
    expect(response.json.suites).toEqual([
      { name: "a", file: join(root, "evals", "a.eval.ts") },
      { name: "nested/m", file: join(root, "evals", "nested", "m.eval.mts") },
      { name: "nested/n", file: join(root, "evals", "nested", "n.eval.mjs") },
      { name: "z", file: join(root, "evals", "z.eval.js") }
    ])
    expect(await readdir(root)).toEqual(["evals"])
  })

  it("reports discovery filesystem and remote-selection errors without creating durable state", async () => {
    const root = await fixture()
    await writeFile(join(root, "evals"), "not a directory")
    const unreadable = await serve(root, ["list"])
    expect(unreadable.code).toBe(1)
    expect(unreadable.output).toContain("eval_list_failed")
    expect(unreadable.json.message).toBe(`Cannot read ${join(root, "evals")} as a directory`)
    expect(unreadable.output).not.toContain("ENOTDIR")
    vi.stubEnv("SMITHERS_REMOTE", "https://control.invalid")
    const remote = await serve(root, ["list"])
    expect(remote.code).toBe(1)
    expect(remote.output).toContain("--remote is not supported")
    expect(await readdir(root)).toEqual(["evals"])
  })

  it("uses the supplied environment and rejects an explicitly empty remote option", async () => {
    const root = await fixture()
    vi.stubEnv("SMITHERS_REMOTE", "https://ambient.invalid")
    const local = await serve(root, ["list"], { environment: { SMITHERS_REMOTE: "" } })
    expect(local.code, local.output).toBe(0)
    vi.stubEnv("SMITHERS_REMOTE", "")
    const remote = await serve(root, ["list"], { environment: { SMITHERS_REMOTE: "https://supplied.invalid" } })
    expect(remote.code).toBe(1)
    expect(remote.output).toContain("--remote is not supported")
    const explicit = await serve(root, ["list", "--remote="], { environment: {} })
    expect(explicit.code).toBe(1)
    expect(explicit.output).toContain("--remote is not supported")
  })

  it("rejects missing project roots before discovery", async () => {
    const root = await fixture()
    const response = await serve(join(root, "missing"), ["list"])
    // A missing root is a UsageError, which every guarded command exits 2 for.
    expect(response.code).toBe(2)
    expect(response.output).toContain("eval_list_failed")
    expect(response.output).toContain("is not an accessible directory")
    expect(await readdir(root)).toEqual([])
  })

  it.each(["value", "promise", "effect"] as const)(
    "loads and executes a %s suite by its discovered name",
    async (shape) => {
      const root = await fixture()
      const file = await writeSuite(root, { shape, defaultExport: shape !== "value" })
      const loaded = await Evaluation.load(root, "exact")
      expect(loaded.file).toBe(file)
      const run = await Evaluation.execute(loaded.suite, loaded.executor, { runId: shape, at: timestamp })
      expect(run).toMatchObject({ version: 1, runId: shape, suite: "nested/exact", cases: [{ case: "first" }] })
      expect(run.observations).toEqual([{
        case: "first",
        scorer: expect.any(String),
        scorerName: "exact",
        stepKey: "implementation-1",
        at: timestamp,
        kind: "score",
        score: 1,
        reason: "complete result"
      }])
      expect(run.cases[0]!.observations).toEqual(run.observations)
      expect(run.cases[0]).not.toHaveProperty("execution")
    }
  )

  it("rejects ambiguous short selectors before importing and accepts an explicit module file", async () => {
    const root = await fixture()
    const selected = await writeSuite(root, { file: "same.eval.mjs" })
    await writeModule(root, "same.eval.js", "throw new Error(\"wrong module imported\")")
    await expect(Evaluation.load(root, "same")).rejects.toThrow("Ambiguous evaluation suite same")
    expect((await Evaluation.load(root, relative(root, selected))).file).toBe(selected)
    expect((await Evaluation.load(root, selected)).suite.name).toBe("nested/exact")
  })

  // Loading imports a module, so selection is an execution primitive: it must
  // reach only the project's own suite modules, and it must refuse before the
  // import rather than after validating the exports of code that already ran.
  it("refuses selectors outside evals/ before importing them", async () => {
    const root = await fixture()
    await writeSuite(root)
    const escape = "globalThis.__evaluationEscape = true\nexport const invalid = true\n"
    await writeFile(join(root, "outside.eval.mjs"), escape)
    await writeModule(root, "notes.txt", escape)
    for (
      const selector of [
        "outside.eval.mjs",
        join(root, "outside.eval.mjs"),
        "evals/../outside.eval.mjs",
        "evals/notes.txt",
        "../outside.eval.mjs"
      ]
    ) {
      await expect(Evaluation.load(root, selector)).rejects.toThrow(/evals/)
    }
    expect((globalThis as Record<string, unknown>).__evaluationEscape).toBeUndefined()
    expect((await Evaluation.load(root, "evals/exact.eval.mjs")).suite.name).toBe("nested/exact")
  })

  // MCP clients reach every leaf command that is not marked `mcp: false`, so an
  // executing command is an approval bypass unless the operator invokes it.
  it("keeps the executing run command out of the MCP tool surface", () => {
    const commands = Cli.toCommands.get(createEvalCli() as never)
    const tools = Mcp.collectTools(commands!, ["eval"]).map((tool) => tool.name)
    expect(tools).toContain("eval_list")
    expect(tools).toContain("eval_compare")
    expect(tools).not.toContain("eval_run")
  })

  it.each([
    ["missing-suite", "export const executor = { run() {} }"],
    ["missing-executor", "export default { suite: {} }"],
    ["bad-executor", "export default { suite: {}, executor: { run: 2 } }"]
  ])("gives an actionable module export error for %s", async (name, source) => {
    const root = await fixture()
    await writeModule(root, `${name}.eval.mjs`, source)
    const result = await serve(root, ["run", name])
    expect(result.code).toBe(5)
    expect(result.output).toContain("eval_run_failed")
    expect(result.output).toContain("must export { suite, executor }")
    expect(await readdir(root)).toEqual(["evals"])
  })

  it("persists deterministic complete output and an exact additional copy", async () => {
    const root = await fixture()
    await writeSuite(root)
    const result = await serve(root, [
      "run",
      "exact",
      "--run-id",
      "fixed",
      "--at",
      timestamp,
      "--output",
      "reports/run.json"
    ])
    expect(result.code, result.output).toBe(0)
    expect(result.json).toMatchObject({ runId: "fixed", suite: "nested/exact" })
    const stored = await Evaluation.readRun(root, "fixed")
    expect(result.json.observations).toEqual(stored.observations)
    expect(result.json.cases).toEqual(stored.cases)
    expect(stored.observations[0]!.at).toBe(timestamp)
    expect(await readFile(join(root, "reports", "run.json"), "utf8"))
      .toBe(await readFile(Evaluation.runPath(root, "fixed"), "utf8"))
    expect((await stat(Evaluation.runPath(root, "fixed"))).mode & 0o777).toBe(0o600)
    expect(await readdir(join(root, ".flows", "evals", "runs"))).toEqual(["fixed.json"])
  })

  it("generates run identity and timestamp and permits output to equal its canonical artifact", async () => {
    const root = await fixture()
    await writeSuite(root)
    const generated = await serve(root, ["run", "exact"])
    expect(generated.code, generated.output).toBe(0)
    expect(generated.json.runId).toMatch(/^[0-9a-f-]{36}$/)
    expect(Number.isFinite(Date.parse(generated.json.observations[0].at))).toBe(true)
    expect(await Evaluation.readRun(root, generated.json.runId)).toMatchObject({ runId: generated.json.runId })
    const explicit = await serve(root, ["run", "exact", "--run-id", "same", "--output", ".flows/evals/runs/same.json"])
    expect(explicit.code, explicit.output).toBe(0)
    expect(await Evaluation.readRun(root, "same")).toMatchObject({ runId: "same" })
  })

  it.each(["executor", "scorer", "no-bindings"] as const)(
    "persists %s failures as inconclusive rather than passing",
    async (failure) => {
      const root = await fixture()
      await writeSuite(root, { failure })
      const response = await serve(root, ["run", "exact", "--run-id", failure, "--at", timestamp])
      expect(response.code, response.output).toBe(5)
      expect(response.output).toContain("eval_inconclusive")
      const run = await Evaluation.readRun(root, failure)
      expect(run.runId).toBe(failure)
      if (failure === "executor") {
        expect(run.cases[0]!.error).toMatchObject({
          code: "executor",
          message: expect.stringContaining("executor unavailable")
        })
        const rehydrated = Evaluation.runOf(run)
        expect(rehydrated.cases[0]!.error).toMatchObject({
          code: "executor",
          message: expect.stringContaining("executor unavailable")
        })
        expect(Evaluation.artifactOf(rehydrated).cases[0]!.error?.message).toContain("executor unavailable")
      } else if (failure === "scorer") {
        expect(run.observations).toEqual([
          expect.objectContaining({ kind: "inconclusive", reason: expect.stringContaining("judge unavailable") })
        ])
      } else expect(run.observations).toEqual([])
      const refused = await serve(root, ["baseline", failure])
      expect(refused.code).toBe(1)
      expect(refused.output).toContain("Cannot commit an incomplete or inconclusive evaluation")
    }
  )

  it("refuses artifact replacement and retains both the original and a new run after copy failure", async () => {
    const root = await fixture()
    await writeSuite(root)
    const output = join(root, "existing.json")
    await writeFile(output, "original\n")
    const copied = await serve(root, ["run", "exact", "--run-id", "new", "--output", "existing.json"])
    expect(copied.code).toBe(5)
    expect(copied.output).toContain("eval_run_failed")
    expect(await readFile(output, "utf8")).toBe("original\n")
    const originalRun = await readFile(Evaluation.runPath(root, "new"), "utf8")
    expect(Evaluation.RunArtifact.parse(JSON.parse(originalRun)).runId).toBe("new")
    const repeated = await serve(root, ["run", "exact", "--run-id", "new"])
    expect(repeated.code).toBe(5)
    expect(await readFile(Evaluation.runPath(root, "new"), "utf8")).toBe(originalRun)
    expect((await readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([])
    expect(await readdir(join(root, ".flows", "evals", "runs"))).toEqual(["new.json"])
  })

  it("redacts non-Error import failures before reporting them", async () => {
    const root = await fixture()
    await writeModule(root, "unsafe.eval.mjs", "throw \"api_key=private-eval-fixture\"")
    const response = await serve(root, ["run", "unsafe"])
    expect(response.code).toBe(5)
    expect(response.output).toContain("eval_run_failed")
    expect(response.output).not.toContain("private-eval-fixture")
    expect(response.json.message).toBe(
      `Could not import ${join(root, "evals", "unsafe.eval.mjs")}; run it directly to see why`
    )
  })
})

describe("evaluation artifact selection and verdicts", () => {
  it("reads run identities, JSON names, relative paths and absolute paths with the same validation", async () => {
    const root = await fixture()
    const run = await successful(root)
    const file = await persist(root, run)
    await writeFile(join(root, "saved.json"), JSON.stringify(run))
    for (const selector of [run.runId, "saved.json", relative(root, file), file]) {
      expect(await Evaluation.readRun(root, selector)).toEqual(run)
    }
    await writeFile(
      join(root, "broken.json"),
      JSON.stringify({ ...run, observations: [{ ...run.observations[0], score: 1.1 }] })
    )
    await expect(Evaluation.readRun(root, "broken.json")).rejects.toThrow()
    await writeFile(join(root, "invalid.json"), "{")
    await expect(Evaluation.readRun(root, "invalid.json")).rejects.toMatchObject({
      _tag: "/cli/Refused",
      fault: "user",
      code: "eval_run_invalid"
    })
    expect(Evaluation.defaultBaselinePath(root, "../nested/exact")).toBe(
      join(root, "evals", "..%2Fnested%2Fexact.baseline.json")
    )
  })

  it("requires force for baseline replacement and preserves complete canonical output", async () => {
    const root = await fixture()
    const run = await successful(root)
    await persist(root, run)
    const args = ["baseline", run.runId, "--output", "committed/baseline.json"]
    const first = await serve(root, args)
    expect(first.code, first.output).toBe(0)
    const file = join(root, "committed", "baseline.json")
    const original = await readFile(file, "utf8")
    expect(original).toBe(await Evaluation.baseline(run))
    expect((await serve(root, args)).code).toBe(1)
    expect(await readFile(file, "utf8")).toBe(original)
    await writeFile(file, "obsolete baseline")
    expect((await serve(root, [...args, "--force"])).code).toBe(0)
    expect(await readFile(file, "utf8")).toBe(original)
    expect(await readdir(dirname(file))).toEqual(["baseline.json"])
  })

  it("uses explicit baseline and score thresholds and saves the full passing report", async () => {
    const root = await fixture()
    const run = await successful(root)
    await persist(root, run)
    await Evaluation.writeJson(join(root, "committed.json"), await Evaluation.baseline(run))
    const response = await serve(root, [
      "compare",
      run.runId,
      "--baseline",
      "committed.json",
      "--mean",
      "1",
      "--min",
      "1",
      "--output",
      "report.json"
    ])
    expect(response.code, response.output).toBe(0)
    const saved = JSON.parse(await readFile(join(root, "report.json"), "utf8"))
    expect(saved).toMatchObject({
      exitCode: 0,
      verdict: { _tag: "Passed" },
      report: { regressions: [], missing: [], nondeterminism: [] }
    })
    expect(saved.report).toEqual(response.json.report)
    expect(saved.report.run.observations).toEqual(run.observations)
  })

  it("fails explicit score thresholds even when an unchanged run matches its baseline", async () => {
    const root = await fixture()
    await writeSuite(root, { score: 0.4 })
    const loaded = await Evaluation.load(root, "exact")
    const run = await Evaluation.execute(loaded.suite, loaded.executor, { runId: "low", at: timestamp })
    await persist(root, run)
    expect((await serve(root, ["baseline", "low"])).code).toBe(0)
    expect((await serve(root, ["compare", "low"])).code).toBe(0)
    const failed = await serve(root, ["compare", "low", "--mean", "0.5", "--min", "0.5", "--output", "threshold.json"])
    expect(failed.code).toBe(1)
    expect(failed.output).toContain("eval_regression")
    const report = JSON.parse(await readFile(join(root, "threshold.json"), "utf8"))
    expect(report.report.regressions).toEqual([])
    expect(report.verdict).toMatchObject({
      _tag: "Failed",
      reasons: expect.arrayContaining([expect.stringContaining("0.5")])
    })
  })

  it("reports missing observations and changed scores at unchanged identity without a passing verdict", async () => {
    const root = await fixture()
    const run = await successful(root)
    await persist(root, run)
    await serve(root, ["baseline", run.runId])
    await persist(root, { ...run, runId: "missing", observations: [], cases: [{ case: "first", observations: [] }] })
    const missing = await serve(root, ["compare", "missing", "--output", "missing.json"])
    expect(missing.code).toBe(5)
    expect(missing.output).toContain("eval_inconclusive")
    expect(JSON.parse(await readFile(join(root, "missing.json"), "utf8")).report.missing).toHaveLength(1)
    const observations = run.observations.map((entry) => ({ ...entry, kind: "score" as const, score: 0 }))
    await persist(root, { ...run, runId: "nondeterministic", observations, cases: [{ case: "first", observations }] })
    const changed = await serve(root, ["compare", "nondeterministic", "--output", "changed.json"])
    expect(changed.code).toBe(1)
    expect(changed.output).toContain("nondeterminism=1")
    expect(JSON.parse(await readFile(join(root, "changed.json"), "utf8")).report.nondeterminism).toHaveLength(1)
  })

  it("reports missing, malformed and incompatible baselines as comparison failures", async () => {
    const root = await fixture()
    const run = await successful(root)
    await persist(root, run)
    const missing = await serve(root, ["compare", run.runId])
    expect(missing.code).toBe(5)
    expect(missing.output).toContain("eval_compare_failed")
    for (const source of ["{", JSON.stringify({ version: 7, suite: run.suite, records: [] })]) {
      await writeFile(join(root, "invalid.json"), source)
      const invalid = await serve(root, ["compare", run.runId, "--baseline", "invalid.json"])
      expect(invalid.code).toBe(5)
      expect(invalid.output).toContain("eval_compare_failed")
    }
    const baseline = JSON.parse(await Evaluation.baseline(run))
    baseline.suite = "another-suite"
    await writeFile(join(root, "wrong-suite.json"), JSON.stringify(baseline))
    const wrong = await serve(root, ["compare", run.runId, "--baseline", "wrong-suite.json"])
    expect(wrong.code).toBe(5)
    expect(wrong.output).toContain("eval_compare_failed")
  })
})
