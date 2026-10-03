import { describe, expect, test } from "bun:test"
import { dedupeFindings } from "../../src/review/dedupeFindings.ts"
import { finalizeNativeReview } from "../../src/review/finalizeNativeReview.ts"
import type { NativeReviewPrompt } from "../../src/workflow/nativeReviewPromptSchema.ts"
import { normalizeOpenCodeReviewInput } from "../../src/workflow/normalizeOpenCodeReviewInput.ts"
import type { PreviewOutput } from "../../src/workflow/previewOutputSchema.ts"
import type { ReviewComment } from "../../src/workflow/reviewCommentSchema.ts"

const path = "code.ts"
const prepared: NativeReviewPrompt = {
  shouldReview: true,
  repoDir: "/repo",
  mode: "workspace",
  ref: "workspace",
  reviewableFiles: 1,
  excludedFiles: 0,
  files: [
    {
      id: "f",
      path,
      status: "modified",
      insertions: 1,
      deletions: 1,
      diff: "@@ -1 +1 @@\n-const a = 1 / b;\n+const a = 1 / 0;",
      prompt: ""
    }
  ],
  message: "prepared",
  warnings: []
}
const preview: PreviewOutput = {
  entries: [{ path, status: "modified", insertions: 1, deletions: 1, willReview: true, excludeReason: "" }],
  totalInsertions: 1,
  totalDeletions: 1,
  totalFiles: 1,
  reviewableCount: 1,
  excludedCount: 0
}
const finding = (content: string, startLine = 1, endLine = startLine) => ({
  path,
  content,
  suggestionCode: "",
  existingCode: "",
  startLine,
  endLine,
  thinking: "",
  severity: "major" as const,
  category: "correctness" as const,
  confidence: "confirmed" as const
})

function finalize(comments: Array<ReturnType<typeof finding>>) {
  const out = finalizeNativeReview(normalizeOpenCodeReviewInput({}), prepared, preview, [
    { file: prepared.files[0]!, output: { status: "success", message: "", summary: null, warnings: [], comments } }
  ])
  return {
    contents: out.comments.map((c) => c.content),
    duplicateWarned: out.warnings.some((w) => w.type === "duplicate_comment")
  }
}

describe("dedupeFindings across scripts", () => {
  test("distinct findings in CJK, other scripts and mixed text all survive finalization", () => {
    for (
      const [a, b] of [
        ["除零错误导致崩溃", "凭据泄露给所有用户"],
        ["Деление на ноль", "Утечка учётных данных"],
        ["ゼロ除算でクラッシュ", "認証情報が漏洩する"],
        ["null の参照 in handler", "SQL 注入 in handler"],
        ["💥💥", "🔑🔑"]
      ]
    ) {
      expect(finalize([finding(a!), finding(b!)])).toEqual({ contents: [a!, b!], duplicateWarned: false })
    }
  })

  test("exact and near-identical non-ASCII repeats still deduplicate", () => {
    expect(finalize([finding("除零错误导致崩溃"), finding("除零错误导致崩溃。")])).toEqual({
      contents: ["除零错误导致崩溃"],
      duplicateWarned: true
    })
    const long = "Функция делит на ноль, когда список пуст"
    expect(finalize([finding(long), finding(long.replace("пуст", "пустой"))]).duplicateWarned).toBe(true)
    expect(finalize([finding("💥💥"), finding(" 💥💥 ")]).duplicateWarned).toBe(true)
  })

  test("English controls, anchored overlap and unanchored findings", () => {
    expect(finalize([finding("Division by zero crashes"), finding("Credentials leak to all users")]).contents)
      .toHaveLength(2)
    // Overlapping ranges dedupe only identical text; disjoint ranges never do.
    expect(finalize([finding("凭据泄露给所有用户", 1, 1), finding("凭据泄露给所有用户", 1, 1)]).contents).toHaveLength(
      1
    )
    const unanchored = (content: string): ReviewComment => ({ ...finding(content, 0, 0) })
    expect(dedupeFindings([unanchored("除零错误导致崩溃"), unanchored("凭据泄露给所有用户")])).toMatchObject({
      dropped: 0
    })
    expect(dedupeFindings([unanchored("除零错误导致崩溃"), unanchored("除零错误导致崩溃")])).toMatchObject({
      dropped: 1
    })
    expect(dedupeFindings([finding("凭据泄露", 1, 1), finding("凭据泄露", 5, 5)])).toMatchObject({ dropped: 0 })
  })
})
