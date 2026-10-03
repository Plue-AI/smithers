import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { resolveReviewTarget as resolveReviewTargetImpl } from "../../src/review/resolveReviewTarget.ts"
import { reviewFileTaskId } from "../../src/review/reviewFileTaskId.ts"
import { reviewMode } from "../../src/review/reviewMode.ts"
import { validateReviewInput } from "../../src/review/validateReviewInput.ts"
import { normalizeOpenCodeReviewInput } from "../../src/workflow/normalizeOpenCodeReviewInput.ts"
import { testIo } from "../io.ts"
import { tempRepos } from "../support/tempRepos.ts"

const { git, write, track, initRepo } = tempRepos()

describe("review input", () => {
  test("normalizeOpenCodeReviewInput strips nulls and accepts non-records", () => {
    expect(normalizeOpenCodeReviewInput({ repo: "x", from: null }).repo).toBe("x")
    // non-record input falls back to defaults
    expect(normalizeOpenCodeReviewInput(42).repo).toBe(".")
    expect(normalizeOpenCodeReviewInput(null).concurrency).toBe(8)
  })

  test("reviewMode picks commit, range, or workspace", () => {
    expect(reviewMode({ ...normalizeOpenCodeReviewInput({}), commit: "abc" })).toBe("commit")
    expect(reviewMode({ ...normalizeOpenCodeReviewInput({}), from: "a", to: "b" })).toBe("range")
    expect(reviewMode(normalizeOpenCodeReviewInput({}))).toBe("workspace")
  })

  test("validateReviewInput rejects conflicting or half-specified ranges", () => {
    expect(() => validateReviewInput({ ...normalizeOpenCodeReviewInput({}), from: "a", to: "b", commit: "c" })).toThrow(
      "Only one review mode"
    )
    expect(() => validateReviewInput({ ...normalizeOpenCodeReviewInput({}), from: "a" })).toThrow("--to is required")
    expect(() => validateReviewInput({ ...normalizeOpenCodeReviewInput({}), to: "b" })).toThrow("--from is required")
    // valid inputs do not throw
    expect(() => validateReviewInput(normalizeOpenCodeReviewInput({}))).not.toThrow()
    expect(() => validateReviewInput({ ...normalizeOpenCodeReviewInput({}), from: "a", to: "b" })).not.toThrow()
  })

  test("reviewFileTaskId slugifies the path and falls back to 'file'", () => {
    expect(reviewFileTaskId("src/Foo Bar.ts", 0)).toBe("review-file-1-src-foo-bar-ts")
    expect(reviewFileTaskId("!!!", 3)).toBe("review-file-4-file")
  })
})

describe("resolveReviewTarget", () => {
  test("throws when the directory is not a git repo (spawn error handler)", async () => {
    // A non-existent cwd makes the git spawn emit an 'error' event → exitCode 127
    // → git() throws, exercising runCommand's error branch.
    await expect(
      resolveReviewTarget({ ...normalizeOpenCodeReviewInput({}), repo: "/nonexistent/ocr/path/xyz" })
    ).rejects.toThrow()
  })

  test("resolves workspace/range/commit refs in a real repo", async () => {
    const dir = initRepo()
    write(join(dir, "src/app.ts"), "export const v = 1;\n")
    git(dir, ["add", "."])
    git(dir, ["commit", "-m", "init"])
    const workspace = await resolveReviewTarget({ ...normalizeOpenCodeReviewInput({}), repo: dir })
    expect(workspace.mode).toBe("workspace")
    expect(workspace.ref).toBe("workspace")
    const commit = await resolveReviewTarget({ ...normalizeOpenCodeReviewInput({}), repo: dir, commit: "HEAD" })
    expect(commit.mode).toBe("commit")
    expect(commit.ref).toBe("HEAD")
    const range = await resolveReviewTarget({
      ...normalizeOpenCodeReviewInput({}),
      repo: dir,
      from: "HEAD",
      to: "HEAD"
    })
    expect(range.mode).toBe("range")
    expect(range.ref).toBe("HEAD..HEAD")
  })
})

const resolveReviewTarget = (...args: Parameters<typeof resolveReviewTargetImpl>) =>
  testIo(() => resolveReviewTargetImpl(...args))
