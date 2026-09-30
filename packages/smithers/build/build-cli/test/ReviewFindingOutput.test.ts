import * as Input from "@smthrs/targets/Input"
import * as LlmLint from "@smthrs/targets/LlmLint"
import * as Effect from "effect/Effect"
import { execFileSync } from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { renderReviewFindings } from "../src/internal/PackageRunner.ts"
import { restrictError, restrictFindings } from "../src/TrustedReview.ts"

let root: string

beforeEach(async () => {
  root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "review-output-")))
})

afterEach(async () => {
  await Fs.rm(root, { recursive: true, force: true })
})

const security = {
  checkId: "general",
  impact: "high" as const,
  verification: "suspected" as const,
  releaseRecommendation: "block" as const,
  attackerPreconditions: "Sends a request.",
  evidence: "The handler forwards the path.",
  nextConfirmationStep: "Request ../ with a synthetic file."
}

describe("review finding output", () => {
  it("prints lint findings in full and security findings only as restricted fingerprints", () => {
    const text = renderReviewFindings({
      findings: [
        { file: "src/a.ts", line: 3, severity: "warning", message: "stale doc" },
        { file: "src/b.ts", line: 7, severity: "error", message: "path traversal in upload", security },
        { file: "src/c.ts", line: 1, severity: "error", message: "unstored secret detail", security }
      ],
      fingerprints: ["0".repeat(64), "f".repeat(64)]
    })
    expect(text).toBe(
      "\n  src/a.ts:3 warning: stale doc" +
        `\n  error [general] high impact: restricted finding ${"f".repeat(64)}` +
        "\n  error [general] high impact: restricted finding (not stored)"
    )
    const many = renderReviewFindings({
      findings: Array.from({ length: 201 }, (_, line) => ({ file: "x.ts", line, severity: "info", message: "m" }))
    })
    expect(many.endsWith("\n  (+1 more)")).toBe(true)
  })

  it("replaces stored findings with disclosable summaries", async () => {
    execFileSync("git", ["init", "-q", "--initial-branch=main"], { cwd: root })
    await Fs.mkdir(NodePath.join(root, "src"))
    await Fs.writeFile(NodePath.join(root, "src/a.ts"), "export const a = upload(path)\n")
    execFileSync("git", ["add", "."], { cwd: root })
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "base"], { cwd: root })
    const executable = NodePath.join(root, "engine.mjs")
    const finding = { file: "src/a.ts", line: 1, severity: "warning", message: "path traversal in upload" }
    await Fs.writeFile(
      executable,
      "#!/usr/bin/env node\nfor await (const _ of process.stdin) {}\n" +
        `process.stdout.write(JSON.stringify({ result: ${JSON.stringify(JSON.stringify([finding]))} }))\n`,
      { mode: 0o755 }
    )
    const store = NodePath.join(root, "store")
    const report = await Effect.runPromise(LlmLint.review({
      workspaceRoot: root,
      executable,
      store: { directory: store, owner: "//:security" }
    }, {
      base: "HEAD",
      include: [Input.glob("src/**")],
      context: [],
      prompt: "Review",
      rubric: "Rubric",
      engine: "claude",
      model: "test",
      batchSize: 1,
      failOn: "error",
      scope: "all"
    }))
    const restricted = await restrictFindings(store, report)
    expect(restricted).toEqual({
      files: ["src/a.ts"],
      run: report.run,
      manifest: report.manifest,
      findings: [{
        fingerprint: report.fingerprints![0],
        reference: `restricted-finding:${report.fingerprints![0]}`,
        state: "open",
        severity: "warning",
        owner: "//:security"
      }]
    })
    expect(JSON.stringify(restricted)).not.toContain("traversal")
    expect(await restrictFindings(store, { findings: [] })).toEqual({ findings: [] })
  })

  it("drops attempt envelopes and quoted model output from disclosable receipts", async () => {
    const attempt = {
      batch: 0,
      pass: 1,
      purpose: "review" as const,
      engine: "claude" as const,
      model: "m",
      attempt: 1,
      status: "failed" as const,
      message: "the model response is not a findings array: private exploit detail",
      completion: {
        status: "completed" as const,
        coverage: [],
        missingContext: [],
        findings: [{ file: "a.ts", line: 1, severity: "error" as const, message: "private exploit detail" }]
      }
    }
    const store = NodePath.join(root, "empty-store")
    const findings = await restrictFindings(store, { findings: [], attempts: [attempt] })
    expect(findings).toEqual({
      findings: [],
      attempts: [{ batch: 0, pass: 1, purpose: "review", engine: "claude", model: "m", attempt: 1, status: "failed" }]
    })
    const parse = restrictError(
      new LlmLint.LlmReviewError({ phase: "parse", message: attempt.message, attempts: [attempt] })
    )
    expect(JSON.stringify(parse)).not.toContain("private exploit detail")
    expect(parse).toMatchObject({ phase: "parse", attempts: [{ status: "failed" }] })
    const review = restrictError(
      new LlmLint.LlmReviewError({ phase: "review", message: "Review requires ANTHROPIC_API_KEY" })
    )
    expect(review).toEqual({
      _tag: "smithers-build/LlmReviewError",
      phase: "review",
      message: "Review requires ANTHROPIC_API_KEY"
    })
    const missing = new LlmLint.ModelCliMissing({ engine: "claude", executable: "claude", message: "missing" })
    expect(restrictError(missing)).toBe(missing)
  })
})
