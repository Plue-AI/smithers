import * as Effect from "effect/Effect"
import { execFileSync } from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as Input from "../src/Input.ts"
import * as LlmLint from "../src/LlmLint.ts"
import * as SecurityReview from "../src/SecurityReview.ts"
import * as Target from "../src/Target.ts"

let root: string

const write = async (relative: string, text: string): Promise<void> => {
  const path = Path.join(root, relative)
  await Fs.mkdir(Path.dirname(path), { recursive: true })
  await Fs.writeFile(path, text, "utf8")
}

beforeEach(async () => {
  root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "required-review-")))
  await write("src/a.ts", "export const a = 1\n")
  await write("src/b.ts", "export const b = 1\n")
  execFileSync("git", ["init", "-q", "--initial-branch=main"], { cwd: root })
  execFileSync("git", ["add", "."], { cwd: root })
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "base"], { cwd: root })
})

afterEach(async () => {
  await Fs.rm(root, { recursive: true, force: true })
})

/** A fake claude CLI that counts its calls, optionally sleeping before answering. */
const engine = async (answer: string, sleepMs = 0): Promise<{ executable: string; calls: () => Promise<number> }> => {
  const executable = Path.join(root, "engine.mjs")
  const record = Path.join(root, "calls.log")
  await Fs.writeFile(
    executable,
    "#!/usr/bin/env node\nimport { appendFileSync } from \"node:fs\"\n" +
      "for await (const _ of process.stdin) {}\n" +
      `appendFileSync(${JSON.stringify(record)}, "call\\n")\n` +
      `await new Promise((resolve) => setTimeout(resolve, ${sleepMs}))\n` +
      `const answer = ${JSON.stringify(answer)}\n` +
      "process.stdout.write(process.argv[2] === \"exec\"\n" +
      "  ? JSON.stringify({ type: \"item.completed\", item: { type: \"agent_message\", text: answer } }) + " +
      "\"\\n\" + JSON.stringify({ type: \"turn.completed\" }) + \"\\n\"\n" +
      "  : JSON.stringify({ type: \"result\", subtype: \"success\", is_error: false, result: answer }))\n",
    { mode: 0o755 }
  )
  return {
    executable,
    calls: async () => (await Fs.readFile(record, "utf8").catch(() => "")).split("\n").filter(Boolean).length
  }
}

const payload = (overrides: Partial<LlmLint.Payload> = {}): LlmLint.Payload => ({
  base: "HEAD",
  include: [Input.glob("src/**")],
  context: [],
  prompt: "Review",
  rubric: "Rubric",
  engine: "claude",
  model: "test",
  batchSize: 1,
  failOn: "error",
  ...overrides
})

const completed = JSON.stringify({
  status: "completed",
  coverage: [{ checkId: "general", status: "completed", evidence: "Inspected the file." }],
  missingContext: [],
  findings: []
})

describe("LlmLint.review required mode", () => {
  it("passes an optional empty selection but fails a required one before any model call", async () => {
    const cli = await engine("[]")
    const optional = await Effect.runPromise(
      LlmLint.review({ workspaceRoot: root, executable: cli.executable }, payload())
    )
    expect(optional).toEqual({ files: [], findings: [] })
    const failure = await Effect.runPromise(Effect.flip(
      LlmLint.review({ workspaceRoot: root, executable: cli.executable }, payload({ required: true }))
    ))
    expect(failure).toBeInstanceOf(LlmLint.LlmReviewError)
    expect(failure).toMatchObject({
      phase: "diff",
      message: expect.stringContaining("Required review selected no files")
    })
    expect(await cli.calls()).toBe(0)
  })

  it("fails a required review whose every selected file disappeared before reading", async () => {
    const cli = await engine("[]")
    await Fs.rm(Path.join(root, "src/a.ts"))
    const optional = await Effect.runPromise(
      LlmLint.review({ workspaceRoot: root, executable: cli.executable }, payload())
    )
    expect(optional.files).toEqual([])
    const failure = await Effect.runPromise(Effect.flip(
      LlmLint.review({ workspaceRoot: root, executable: cli.executable }, payload({ required: true }))
    ))
    expect(failure.message).toContain("Required review selected no files")
    expect(await cli.calls()).toBe(0)
  })

  it("reports a missing engine as a skippable host fact only when the review is optional", async () => {
    await write("src/a.ts", "export const a = 2\n")
    const missing = Path.join(root, "no-such-engine")
    const optional = await Effect.runPromise(Effect.flip(
      LlmLint.review({ workspaceRoot: root, executable: missing }, payload())
    ))
    expect(optional).toBeInstanceOf(LlmLint.ModelCliMissing)
    const required = await Effect.runPromise(Effect.flip(
      LlmLint.review({ workspaceRoot: root, executable: missing }, payload({ required: true }))
    ))
    expect(required).toBeInstanceOf(LlmLint.LlmReviewError)
    expect(required.message).toMatch(/^Required review cannot run: /)
  })

  it("passes a required review that reviewed its selection", async () => {
    await write("src/a.ts", "export const a = 2\n")
    const cli = await engine("[]")
    const report = await Effect.runPromise(
      LlmLint.review({ workspaceRoot: root, executable: cli.executable }, payload({ required: true }))
    )
    expect(report).toEqual({ files: ["src/a.ts"], findings: [] })
  })
})

describe("LlmLint.review aggregate budget", () => {
  it("stops at the model-call budget and reports what a budgeted review spent", async () => {
    await write("src/a.ts", "export const a = 2\n")
    await write("src/b.ts", "export const b = 2\n")
    const cli = await engine("[]")
    const failure = await Effect.runPromise(Effect.flip(
      LlmLint.review({ workspaceRoot: root, executable: cli.executable }, payload({ budget: { modelCalls: 1 } }))
    ))
    expect(failure).toMatchObject({ phase: "review", message: "Review budget exhausted: 1 model calls" })
    expect(await cli.calls()).toBe(1)
    const report = await Effect.runPromise(
      LlmLint.review({ workspaceRoot: root, executable: cli.executable }, payload({ budget: { modelCalls: 2 } }))
    )
    expect(report.files).toEqual(["src/a.ts", "src/b.ts"])
    expect(report.usage?.modelCalls).toBe(2)
    expect(report.usage?.promptTokens).toBeGreaterThan(0)
  })

  it("refuses a call that would exceed the prompt-token budget before sending it", async () => {
    await write("src/a.ts", "export const a = 2\n")
    const cli = await engine("[]")
    const failure = await Effect.runPromise(Effect.flip(
      LlmLint.review({ workspaceRoot: root, executable: cli.executable }, payload({ budget: { promptTokens: 10 } }))
    ))
    expect(failure.message).toBe("Review budget exhausted: 10 prompt tokens")
    expect(await cli.calls()).toBe(0)
  })

  it("bounds each call by the remaining wall-clock budget and fails once it is spent", async () => {
    await write("src/a.ts", "export const a = 2\n")
    await write("src/b.ts", "export const b = 2\n")
    const slow = await engine("[]", 5_000)
    const started = Date.now()
    const timedOut = await Effect.runPromise(Effect.flip(
      LlmLint.review({ workspaceRoot: root, executable: slow.executable }, payload({ budget: { wallMs: 1_500 } }))
    ))
    expect(timedOut.message).toMatch(/timed out after \d+ms/)
    expect(Date.now() - started).toBeLessThan(4_500)
    const spent = await Effect.runPromise(Effect.flip(
      LlmLint.review(
        { workspaceRoot: root, executable: (await engine("[]", 0)).executable },
        payload({ budget: { wallMs: 1 } })
      )
    ))
    expect(spent.message).toBe("Review budget exhausted: 1 ms")
  })

  it("never retries a security attempt the budget refused", async () => {
    await write("src/a.ts", "export const a = 2\n")
    const cli = await engine(completed)
    const failure = await Effect.runPromise(Effect.flip(LlmLint.review(
      { workspaceRoot: root, executable: cli.executable },
      payload({ securityChecks: ["general"], budget: { modelCalls: 2 } })
    )))
    expect(failure).toBeInstanceOf(LlmLint.LlmReviewError)
    const attempts = (failure as LlmLint.LlmReviewError).attempts ?? []
    expect(attempts.map(({ attempt, status }) => [attempt, status])).toEqual([[1, "completed"], [1, "completed"], [
      1,
      "failed"
    ]])
    expect(attempts.at(-1)?.message).toBe("Review budget exhausted: 2 model calls")
    expect(await cli.calls()).toBe(2)
  })
})

describe("required and budget declarations", () => {
  const attrs = () => ({
    changes: Input.gitDiff("HEAD"),
    include: [Input.glob("src/**")],
    deps: [],
    prompt: "Review",
    rubric: "Rubric",
    model: "test",
    batchSize: 1
  })

  it("validates budgets and leaves undeclared options out of the policy", () => {
    expect(() => LlmLint.Attrs.make({ ...attrs(), budget: { modelCalls: 0 } })).toThrow()
    expect(LlmLint.Attrs.make({ ...attrs(), required: true, budget: { wallMs: 60_000 } })).toMatchObject({
      required: true,
      budget: { wallMs: 60_000 }
    })
    const declared = SecurityReview.SecurityReview({
      cwd: "pkg",
      checks: [],
      required: true,
      budget: { modelCalls: 40, promptTokens: 2_000_000 }
    })
    for (const target of [declared.security, declared.securityAudit]) {
      expect(Target.metadata(target).attrs).toMatchObject({
        required: true,
        budget: { modelCalls: 40, promptTokens: 2_000_000 }
      })
    }
    const plain = Target.metadata(SecurityReview.SecurityReview({ cwd: "pkg", checks: [] }).security).attrs as object
    expect(Object.hasOwn(plain, "required")).toBe(false)
    expect(Object.hasOwn(plain, "budget")).toBe(false)
  })
})
