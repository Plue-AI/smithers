import { describe, expect, test } from "bun:test"
import type { ChangedFile } from "../src/walkthrough/changedFileSchema.ts"
import { fallbackStory } from "../src/walkthrough/fallbackStory.ts"

function file(path: string, insertions: number, deletions = 0): ChangedFile {
  return { path, status: "modified", insertions, deletions, diff: "", reviewed: true, excludeReason: "" }
}

describe("fallbackStory", () => {
  test("orders code areas by churn, then config, tests, docs", () => {
    const story = fallbackStory([
      file("packages/engine/src/engine.ts", 5),
      file("apps/web/src/app.ts", 200),
      file("apps/web/src/router.ts", 50),
      file("package.json", 2),
      file("apps/web/tests/app.test.ts", 40),
      file("docs/guide.md", 10)
    ])

    expect(story.chapters.map((chapter) => chapter.title)).toEqual([
      "The main change: apps/web",
      "Alongside: packages/engine",
      "Wiring and configuration",
      "The proof: tests",
      "The paper trail: docs"
    ])
    expect(story.chapters[0]!.blocks[0]!.kind).toBe("prose")
    expect(story.chapters[0]!.blocks.filter((block) => block.kind === "diff").map((block) => block.path)).toEqual([
      "apps/web/src/app.ts",
      "apps/web/src/router.ts"
    ])
    expect(story.headline).toBe("Change walkthrough: apps/web")
    expect(story.synopsis).toBe("5 areas changed; apps/web carries most of the churn.")
  })

  test("covers every file in exactly one diff block", () => {
    const files = [
      file("apps/web/src/a.ts", 1),
      file("packages/x/b.ts", 2),
      file("scripts/run.sh", 3),
      file("README.md", 4),
      file("e2e/flow.spec.ts", 5)
    ]
    const story = fallbackStory(files)
    const covered = story.chapters.flatMap((chapter) =>
      chapter.blocks.filter((block) => block.kind === "diff").map((block) => block.path)
    )
    expect([...covered].sort()).toEqual(files.map((entry) => entry.path).sort())
    expect(new Set(covered).size).toBe(covered.length)
  })

  test("handles an empty change set", () => {
    const story = fallbackStory([])
    expect(story.chapters).toEqual([])
    expect(story.headline).toBe("Change walkthrough")
    expect(story.synopsis).toBe("No changes detected.")
  })

  test("single-area change gets a one-area synopsis", () => {
    const story = fallbackStory([file("apps/web/src/a.ts", 3)])
    expect(story.headline).toBe("Change walkthrough: apps/web")
    expect(story.synopsis).toBe("All of the change lands in apps/web.")
  })
})
