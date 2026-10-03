import type { RuntimeConfig } from "@smthrs/build-cli/Cli"
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import { makeCli } from "../src/Cli.ts"
import { createEvalCli } from "../src/evaluation/EvalCli.ts"

const roots: Array<string> = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const fixture = async (phase: string) => {
  const root = await mkdtemp(join(tmpdir(), "smithers-eval-cancellation-"))
  roots.push(root)
  await mkdir(join(root, "evals"))
  const file = join(root, "evals", "blocked.eval.mjs")
  await writeFile(
    file,
    `
import { Effect } from ${JSON.stringify(import.meta.resolve("effect"))}
import { Suite, CaseExecutor } from ${JSON.stringify(new URL("../agent/evals/src/index.ts", import.meta.url).href)}
import * as Flow from ${JSON.stringify(new URL("../flows/core/src/Flow.ts", import.meta.url).href)}
import * as Scorer from ${JSON.stringify(new URL("../agent/scorers/src/Scorer.ts", import.meta.url).href)}
import * as Binding from ${JSON.stringify(new URL("../agent/scorers/src/Binding.ts", import.meta.url).href)}
let start
let finish
export const started = new Promise((resolve) => { start = resolve })
export const finalized = new Promise((resolve) => { finish = resolve })
export let release = () => {}
const hold = (value) => Effect.callback((resume) => {
  release = () => resume(Effect.succeed(value))
  start()
}).pipe(Effect.ensuring(Effect.sync(() => finish())))
const target = ({ name: "cancellation-target" })
const scorer = Scorer.make({ id: "cancel", version: "1", name: "cancel",
  score: () => ${phase === "scorer" ? "hold({ score: 1 })" : "Effect.succeed({ score: 1 })"}
})
const declaration = { name: "blocked", concurrency: 1, cases: [{ name: "first", input: 1 }],
  bindings: [Binding.make({ scorer, appliesTo: target })] }
export const suite = ${phase === "suite" ? "hold(declaration)" : "declaration"}
export const executor = CaseExecutor.make(() => ${phase === "executor" ? "hold" : "Effect.succeed"}({
  output: 1, stepKey: "step", latencyMs: 0, target
}))
`
  )
  const controls = await import(pathToFileURL(file).href) as {
    started: Promise<void>
    finalized: Promise<void>
    release: () => void
  }
  return { root, controls }
}

const serve = async (root: string, runtime: RuntimeConfig, unified = false) => {
  const result = { code: 0, output: "" }
  const cli = unified ? makeCli(runtime) : createEvalCli(runtime)
  await cli.serve([
    ...(unified ? ["eval"] : []),
    "run",
    "blocked",
    "--root",
    root,
    "--run-id",
    "cancelled",
    "--output",
    "copy.json",
    "--json"
  ], {
    stdout: (text) => {
      result.output += text
    },
    exit: (code) => {
      result.code = code
    }
  })
  return result
}

describe("evaluation invocation cancellation", () => {
  it.each(["suite", "executor", "scorer"])("interrupts blocked %s work and runs its finalizer", async (phase) => {
    const { root, controls } = await fixture(phase)
    const controller = new AbortController()
    const invocation = serve(root, { signal: controller.signal, environment: {} }, phase === "executor")
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await controls.started
      controller.abort()
      const finalized = await Promise.race([
        controls.finalized.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), 1_000)
        })
      ])
      expect(finalized).toBe(true)
      const result = await invocation
      expect(result.code, result.output).toBe(5)
      expect(result.output).toContain("eval_run_failed")
      expect(await readdir(root)).toEqual(["evals"])
    } finally {
      clearTimeout(timer)
      controls.release()
      await invocation
    }
  })
})
