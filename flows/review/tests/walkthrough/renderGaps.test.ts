import { describe, expect, spyOn, test } from "bun:test"
import { buildNarratePrompt } from "../../src/walkthrough/buildNarratePrompt.ts"
import type { ChangedFile } from "../../src/walkthrough/changedFileSchema.ts"
import { renderProse } from "../../src/walkthrough/renderProse.ts"
import { renderWalkthroughHtml } from "../../src/walkthrough/renderWalkthroughHtml.ts"

type WalkthroughInput = Parameters<typeof renderWalkthroughHtml>[0]

function file(overrides: Partial<ChangedFile>): ChangedFile {
  return {
    path: "src/x.ts",
    status: "modified",
    insertions: 1,
    deletions: 0,
    diff: "",
    reviewed: true,
    excludeReason: "",
    ...overrides
  }
}

function block(partial: Record<string, string>) {
  return { kind: "prose", text: "", path: "", intro: "", title: "", mermaid: "", ...partial }
}

describe("renderProse ordered lists", () => {
  test("renders 1. / 2. ordered lists as <ol>", () => {
    const html = renderProse(["1. first", "2. second", "3) third"].join("\n"))
    expect(html).toBe("<ol><li>first</li><li>second</li><li>third</li></ol>")
  })
})

describe("buildNarratePrompt excerpt omission", () => {
  test("omits files whose diff is empty and notes the omission", () => {
    const files: ChangedFile[] = [
      file({ path: "src/big.ts", insertions: 10, deletions: 2, diff: "diff --git a/src/big.ts b/src/big.ts\n+added" }),
      file({ path: "assets/logo.png", status: "binary", insertions: 0, deletions: 0, diff: "" })
    ]
    const prompt = buildNarratePrompt({
      files,
      comments: [],
      background: "Ship the feature",
      mode: "workspace",
      ref: "workspace"
    })
    expect(prompt).toContain("1 file(s) omitted for size")
    // The requirement background is fenced as untrusted content.
    expect(prompt).toContain("Requirement background: Ship the feature")
  })
})

describe("renderWalkthroughHtml edge branches", () => {
  test("handles unknown severities, renames, oversize + unparseable diffs", async () => {
    // Scoped to the one test that reads it, and restored either way: bun runs
    // every suite in one process, so a spy left installed silences
    // console.error for every file loaded after this one.
    const errorSpy = spyOn(console, "error").mockImplementation(() => undefined)
    try {
      const renamedDiff = [
        "diff --git a/src/old.ts b/src/new.ts",
        "similarity index 100%",
        "rename from src/old.ts",
        "rename to src/new.ts"
      ].join("\n")
      const files: ChangedFile[] = [
        file({ path: "src/new.ts", status: "renamed", insertions: 0, deletions: 0, diff: renamedDiff }),
        // A renamed file whose diff lacks explicit rename lines → renamePaths returns null.
        file({
          path: "src/moved.ts",
          status: "renamed",
          insertions: 1,
          deletions: 1,
          diff: "diff --git a/src/moved.ts b/src/moved.ts\n+x\n-y"
        }),
        // Oversize churn → the highlighted renderer is skipped for the plain fallback.
        file({
          path: "src/huge.ts",
          status: "modified",
          insertions: 6000,
          deletions: 0,
          diff: "diff --git a/src/huge.ts b/src/huge.ts\n+big"
        }),
        // A non-patch diff makes the Pierre renderer throw → plain fallback + logged.
        file({ path: "src/garbage.ts", status: "modified", insertions: 1, deletions: 0, diff: "garbage not a diff" })
      ]
      const comments: WalkthroughInput["comments"] = [
        {
          path: "src/garbage.ts",
          content: "odd severity",
          suggestionCode: "",
          existingCode: "",
          startLine: 0,
          endLine: 0,
          thinking: "",
          severity: "nit" as never, // not in the severity order → falls back to "minor"
          category: "other",
          confidence: "plausible"
        }
      ]
      const story = {
        headline: "Edge cases",
        synopsis: "Covers renames, oversize, and unparseable diffs.",
        chapters: [
          {
            title: "All the files",
            blocks: [
              block({ kind: "diff", path: "src/new.ts", intro: "the rename" }),
              block({ kind: "diff", path: "src/moved.ts", intro: "moved without rename markers" }),
              block({ kind: "diff", path: "src/huge.ts", intro: "the oversize one" }),
              block({ kind: "diff", path: "src/garbage.ts", intro: "the unparseable one" })
            ]
          }
        ]
      }
      const html = await renderWalkthroughHtml({
        title: "",
        story,
        files,
        comments,
        repoDir: "/tmp/repo",
        mode: "workspace",
        ref: "workspace",
        generatedAt: "2026-06-10T00:00:00.000Z"
      })
      expect(html).toContain("src/old.ts")
      expect(html).toContain("rename-arrow")
      expect(html).toContain("large diff") // oversize plain badge
      expect(html).toContain("renderer failed") // pierre-error plain badge
      // The unknown severity was normalized to a minor finding.
      expect(html).toContain("sev-minor")
      // The Pierre failure was logged rather than swallowed.
      expect(
        errorSpy.mock.calls.some((args) => args.some((value) => String(value).includes("pierre diff renderer failed")))
      ).toBe(true)
    } finally {
      errorSpy.mockRestore()
    }
  })

  test("truncates the sidebar file list past ten diff links per chapter", async () => {
    const files: ChangedFile[] = Array.from(
      { length: 12 },
      (_, i) => file({ path: `src/dir/f${i}.ts`, insertions: 1, deletions: 0, diff: "" })
    )
    const story = {
      headline: "Many files",
      synopsis: "Twelve files in one chapter.",
      chapters: [
        {
          title: "Big chapter",
          blocks: files.map((f) => block({ kind: "diff", path: f.path, intro: "" }))
        }
      ]
    }
    const html = await renderWalkthroughHtml({
      title: "Many",
      story,
      files,
      comments: [],
      repoDir: "/tmp/repo",
      mode: "workspace",
      ref: "workspace",
      generatedAt: "2026-06-10T00:00:00.000Z"
    })
    // 12 diff links → capped at 10 with a "+2 more" overflow link.
    expect(html).toContain("+2 more")
  })
})

describe("suite hygiene", () => {
  test("console.error is left unmocked for every file bun loads after this one", () => {
    // bun runs the whole suite in one process, so a spy installed at
    // registration and never restored silences diagnostics in later files
    // (metering misses, subprocess and renderer errors) and makes what a
    // suite observes depend on file order.
    expect((console.error as unknown as { mock?: unknown }).mock).toBeUndefined()
  })
})
