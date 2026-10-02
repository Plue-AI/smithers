import { describe, expect, test } from "bun:test";
import type { ChangedFile } from "../src/walkthrough/changedFileSchema.ts";
import { normalizeStory } from "../src/walkthrough/normalizeStory.ts";

function file(path: string, insertions = 1): ChangedFile {
  return { path, status: "modified", insertions, deletions: 0, diff: "", reviewed: true, excludeReason: "" };
}

const files = [file("src/a.ts", 10), file("src/b.ts", 5), file("src/c.ts", 1)];

function diffPaths(story: ReturnType<typeof normalizeStory>): string[] {
  return story.chapters.flatMap((chapter) => chapter.blocks.filter((b) => b.kind === "diff").map((b) => b.path));
}

describe("normalizeStory", () => {
  test("keeps block order, drops unknown paths and dupes, appends missing files", () => {
    const story = normalizeStory(
      {
        headline: "Adds the thing",
        synopsis: "First the core, then the rest.",
        chapters: [
          {
            title: "The core",
            blocks: [
              { kind: "prose", text: "Start here: the heart of the change." },
              { kind: "diff", path: "src/b.ts", intro: "the heart" },
              { kind: "prose", text: "Having read the heart, now its consumer." },
              { kind: "diff", path: "src/invented.ts", intro: "does not exist" },
              { kind: "diagram", title: "Flow", mermaid: "graph TD; A-->B" },
            ],
          },
          {
            title: "Repeat",
            blocks: [
              { kind: "diff", path: "src/b.ts", intro: "duplicate" },
              { kind: "diff", path: "src/a.ts", intro: "support" },
            ],
          },
        ],
      },
      files,
    );

    expect(story.headline).toBe("Adds the thing");
    expect(story.chapters.map((chapter) => chapter.title)).toEqual(["The core", "Repeat", "Everything else"]);
    expect(story.chapters[0]!.blocks.map((block) => block.kind)).toEqual(["prose", "diff", "prose", "diagram"]);
    expect(story.chapters[0]!.blocks[1]!.path).toBe("src/b.ts");
    expect(story.chapters[1]!.blocks).toEqual([
      { kind: "diff", path: "src/a.ts", intro: "support", text: "", title: "", mermaid: "" },
    ]);
    expect(diffPaths(story).sort()).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
  });

  test("every changed file ends up in exactly one diff block", () => {
    const story = normalizeStory(
      { chapters: [{ title: "Partial", blocks: [{ kind: "diff", path: "src/c.ts" }] }] },
      files,
    );
    const paths = diffPaths(story);
    expect([...paths].sort()).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
    expect(new Set(paths).size).toBe(paths.length);
  });

  test("drops empty prose and sourceless diagrams; falls back when nothing survives", () => {
    for (const candidate of [
      null,
      "not a story",
      {
        chapters: [
          {
            title: "x",
            blocks: [
              { kind: "prose", text: "  " },
              { kind: "diagram", mermaid: "" },
            ],
          },
        ],
      },
      { chapters: [{ title: "x", blocks: [{ kind: "diff", path: "nope.ts" }] }] },
    ]) {
      const story = normalizeStory(candidate, files);
      expect(story.chapters.length).toBeGreaterThan(0);
      expect(diffPaths(story).sort()).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
    }
  });

  test("unknown block kinds degrade to prose; empty headline/synopsis fall back", () => {
    const story = normalizeStory(
      {
        headline: " ",
        synopsis: "",
        chapters: [
          {
            title: "Core",
            blocks: [
              { kind: "mystery", text: "keep this text" },
              { kind: "diff", path: "src/a.ts" },
            ],
          },
        ],
      },
      files,
    );
    expect(story.chapters[0]!.blocks[0]!).toMatchObject({ kind: "prose", text: "keep this text" });
    expect(story.headline).toBe("Change walkthrough: src");
    expect(story.synopsis.length).toBeGreaterThan(0);
  });
});
