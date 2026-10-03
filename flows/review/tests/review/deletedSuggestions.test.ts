import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { join } from "node:path"
import { buildPullRequestReview } from "../../src/github/buildPullRequestReview.ts"
import type { PullRequestFile } from "../../src/github/listPullRequestFiles.ts"
import { parsePatchCommentableLines } from "../../src/github/parsePatchCommentableLines.ts"
import { finalizeNativeReview } from "../../src/review/finalizeNativeReview.ts"
import { loadReviewSnapshot as loadReviewSnapshotImpl } from "../../src/review/loadReviewSnapshot.ts"
import { nativeReviewPromptFromSnapshot } from "../../src/review/nativeReviewPromptFromSnapshot.ts"
import { previewFromSnapshot } from "../../src/review/previewFromSnapshot.ts"
import { normalizeOpenCodeReviewInput } from "../../src/workflow/normalizeOpenCodeReviewInput.ts"
import type { ReviewComment } from "../../src/workflow/reviewCommentSchema.ts"
import { testIo } from "../io.ts"
import { tempRepos } from "../support/tempRepos.ts"

const { git, write, initRepo } = tempRepos()
const path = "src/example.ts"
const timeout = 30_000

function commit(dir: string, message: string) {
  git(dir, ["add", "-A"])
  git(dir, ["commit", "-m", message])
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim()
}

const finding: ReviewComment = {
  path,
  content: "The removed guard leaves this operation unsafe.",
  existingCode: "guard();",
  suggestionCode: "guard();",
  startLine: 0,
  endLine: 0,
  thinking: "",
  severity: "major",
  category: "correctness",
  confidence: "confirmed"
}

async function review(before: string, after: string, overrides: Partial<ReviewComment> = {}) {
  const dir = initRepo()
  write(join(dir, path), before)
  const base = commit(dir, "base")
  write(join(dir, path), after)
  const headSha = commit(dir, "change")

  const snapshot = await loadReviewSnapshot(normalizeOpenCodeReviewInput({ repo: dir, from: base, to: headSha }))
  const preview = previewFromSnapshot(snapshot)
  const prompt = nativeReviewPromptFromSnapshot(snapshot, preview)
  expect(prompt.shouldReview).toBe(true)
  expect(prompt.files).toHaveLength(1)
  const file = prompt.files[0]!
  expect(file.path).toBe(path)

  const outcome = finalizeNativeReview(snapshot.input, prompt, preview, [{
    file,
    output: {
      status: "success",
      message: "",
      summary: null,
      warnings: [],
      comments: [{ ...finding, ...overrides }]
    }
  }])
  const prFiles = new Map<string, PullRequestFile>([[path, {
    filename: path,
    additions: file.insertions,
    deletions: file.deletions,
    commentableLines: parsePatchCommentableLines(file.diff)
  }]])
  const payload = buildPullRequestReview({
    story: { headline: "Guard change", synopsis: "", chapters: [] },
    findings: [...outcome.comments],
    prFiles,
    headSha,
    reviewStatus: outcome.status,
    warnings: [...outcome.warnings]
  })
  return { outcome, payload, prFiles }
}

function expectUnanchored(result: Awaited<ReturnType<typeof review>>) {
  expect(result.outcome.comments).toHaveLength(1)
  expect(result.outcome.comments[0]!).toMatchObject({
    path,
    content: finding.content,
    existingCode: finding.existingCode,
    suggestionCode: finding.suggestionCode,
    startLine: 0,
    endLine: 0
  })
  expect(result.payload.comments).toEqual([])
  expect(result.payload.body).toContain(finding.content)
  expect(result.payload.body).toContain("1 finding without an inline anchor")
  expect(result.payload.body).not.toContain("```suggestion")
}

describe("deleted-side suggestions through the public review pipeline", () => {
  test("a deleted line next to surviving context stays in the review body", async () => {
    const result = await review("before();\nguard();\nafter();\n", "before();\nafter();\n")
    expect(result.prFiles.get(path)?.commentableLines.has(2)).toBe(true)
    expectUnanchored(result)
  }, timeout)

  test("a replacement hunk does not turn a deleted line into a suggestion on its replacement", async () => {
    const result = await review("before();\nguard();\nafter();\n", "before();\nunsafe();\nafter();\n")
    expect(result.prFiles.get(path)?.commentableLines.has(2)).toBe(true)
    expectUnanchored(result)
  }, timeout)

  test("a supplied valid new-side line cannot override deleted existingCode", async () => {
    const result = await review("before();\nguard();\nafter();\n", "before();\nunsafe();\nafter();\n", {
      startLine: 2,
      endLine: 2
    })
    expectUnanchored(result)
  }, timeout)

  test("an actual new-side match still emits an applicable suggestion", async () => {
    const result = await review("before();\nguard();\nafter();\n", "before();\nunsafe();\nafter();\n", {
      existingCode: "unsafe();",
      suggestionCode: "safe();",
      content: "The new call needs a guard."
    })
    expect(result.outcome.comments).toHaveLength(1)
    expect(result.outcome.comments[0]!).toMatchObject({ startLine: 2, endLine: 2 })
    expect(result.payload.comments).toHaveLength(1)
    expect(result.payload.comments[0]!).toMatchObject({ path, line: 2, side: "RIGHT" })
    expect(result.payload.comments[0]!?.body).toContain("```suggestion\nsafe();\n```")
  }, timeout)
})

const loadReviewSnapshot = (...args: Parameters<typeof loadReviewSnapshotImpl>) =>
  testIo(() => loadReviewSnapshotImpl(...args))
