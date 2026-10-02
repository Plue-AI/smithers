import { describe, expect, test } from "bun:test";
import { buildNarratePrompt } from "../src/walkthrough/buildNarratePrompt.ts";
import { escapeHtml } from "../src/walkthrough/escapeHtml.ts";

function file(path: string, insertions: number, deletions: number, diff = "x") {
  return { path, status: "modified", insertions, deletions, diff, reviewed: false, excludeReason: "" };
}
import { classifyChangeRole } from "../src/walkthrough/classifyChangeRole.ts";
import { describeChange } from "../src/walkthrough/describeChange.ts";
import { renderFallbackDiffHtml } from "../src/diffs/renderFallbackDiffHtml.ts";

describe("escapeHtml", () => {
  test("escapes the five HTML-sensitive characters", () => {
    expect(escapeHtml("&")).toBe("&amp;");
    expect(escapeHtml("<")).toBe("&lt;");
    expect(escapeHtml(">")).toBe("&gt;");
    expect(escapeHtml('"')).toBe("&quot;");
    expect(escapeHtml("'")).toBe("&#39;");
  });

  test("escapes ampersands before other entities (no double-escaping)", () => {
    expect(escapeHtml('<a href="x">&\'</a>')).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;");
  });

  test("leaves plain text and empty strings untouched", () => {
    expect(escapeHtml("")).toBe("");
    expect(escapeHtml("plain text 123")).toBe("plain text 123");
  });
});

describe("classifyChangeRole", () => {
  test("classifies docs by directory and extension", () => {
    expect(classifyChangeRole("docs/guide.mdx")).toBe("docs");
    expect(classifyChangeRole("packages/x/README.md")).toBe("docs");
    expect(classifyChangeRole("notes.rst")).toBe("docs");
  });

  test("classifies tests by directory and filename", () => {
    expect(classifyChangeRole("packages/x/tests/foo.ts")).toBe("tests");
    expect(classifyChangeRole("src/__tests__/foo.ts")).toBe("tests");
    expect(classifyChangeRole("src/foo.test.ts")).toBe("tests");
    expect(classifyChangeRole("e2e/case01.spec.ts")).toBe("tests");
  });

  test("classifies config by name, extension, dotfiles, and .github", () => {
    expect(classifyChangeRole("package.json")).toBe("config");
    expect(classifyChangeRole("pnpm-lock.yaml")).toBe("config");
    expect(classifyChangeRole("tsconfig.base.json")).toBe("config");
    expect(classifyChangeRole(".github/workflows/ci.yml")).toBe("config");
    expect(classifyChangeRole(".gitignore")).toBe("config");
    expect(classifyChangeRole("vitest.config.ts")).toBe("config");
    expect(classifyChangeRole("settings.toml")).toBe("config");
  });

  test("falls back to code for source files", () => {
    expect(classifyChangeRole("packages/x/src/index.ts")).toBe("code");
    expect(classifyChangeRole("apps/cli/src/main.js")).toBe("code");
  });

  test("docs/tests take precedence over the code default", () => {
    // A .ts file inside a tests/ dir is tests, not code.
    expect(classifyChangeRole("tests/helpers/build.ts")).toBe("tests");
    // A markdown file anywhere is docs.
    expect(classifyChangeRole("packages/x/src/NOTES.md")).toBe("docs");
  });
});

describe("describeChange", () => {
  test("renders status with signed insertion/deletion counts", () => {
    expect(
      describeChange({
        path: "a.ts",
        status: "added",
        insertions: 12,
        deletions: 0,
        diff: "",
        reviewed: false,
        excludeReason: "",
      }),
    ).toBe("added (+12 −0)");
    expect(
      describeChange({
        path: "b.ts",
        status: "modified",
        insertions: 3,
        deletions: 7,
        diff: "",
        reviewed: false,
        excludeReason: "",
      }),
    ).toBe("modified (+3 −7)");
  });
});

describe("renderFallbackDiffHtml", () => {
  test("shows a note for an empty / whitespace diff", () => {
    expect(renderFallbackDiffHtml("")).toContain("No textual diff");
    expect(renderFallbackDiffHtml("   \n  ")).toContain("No textual diff");
  });

  test("renders hunk/add/del/ctx rows and skips git metadata + preamble", () => {
    const diff = [
      "diff --git a/x b/x",
      "index abc..def 100644",
      "--- a/x",
      "+++ b/x",
      "@@ -1,2 +1,2 @@",
      " unchanged",
      "-removed",
      "+added",
    ].join("\n");
    const html = renderFallbackDiffHtml(diff);
    expect(html).toContain('class="hunk"');
    expect(html).toContain('class="ctx"');
    expect(html).toContain('class="del"');
    expect(html).toContain('class="add"');
    expect(html).toContain("unchanged");
    expect(html).toContain("removed");
    expect(html).toContain("added");
    // git metadata lines are skipped, not rendered as code rows.
    expect(html).not.toContain("diff --git");
    expect(html).not.toContain("index abc");
  });

  test("HTML-escapes diff content", () => {
    const html = renderFallbackDiffHtml("@@ -1 +1 @@\n+<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>alert");
  });
});

describe("buildNarratePrompt", () => {
  test("includes target, background, inventory, findings, and churn-ordered excerpts", () => {
    const prompt = buildNarratePrompt({
      files: [file("small.ts", 1, 0, "small-diff"), file("big.ts", 50, 10, "big-diff")],
      comments: [{ path: "big.ts", startLine: 3, endLine: 3, content: "watch this\nsecond line" }] as never,
      background: "the why",
      mode: "pr",
      ref: "abc123",
    });
    expect(prompt).toContain("Review target: pr abc123");
    expect(prompt).toContain("the why");
    expect(prompt).toContain("Changed file inventory (2 file(s)):");
    expect(prompt).toContain("small.ts");
    expect(prompt).toContain("big.ts");
    expect(prompt).toContain("Review findings (1, tagged [severity/category]):");
    // The full finding content (all lines) is passed to the narrator.
    expect(prompt).toContain("watch this");
    expect(prompt).toContain("second line");
    // Excerpts are largest-churn first: big.ts excerpt precedes small.ts.
    expect(prompt.indexOf("big-diff")).toBeLessThan(prompt.indexOf("small-diff"));
  });

  test("truncates an oversized excerpt with the shared trimDiff marker", () => {
    // One file gets the 30,000-character cap from perFileExcerptLimit.
    const prompt = buildNarratePrompt({
      files: [file("huge.ts", 1, 0, "x".repeat(30_001))],
      comments: [] as never,
      background: "",
      mode: "diff",
      ref: "HEAD",
    });
    expect(prompt).toContain(`${"x".repeat(30_000)}\n[diff truncated for prompt size]`);
    expect(prompt).not.toContain("x".repeat(30_001));
  });

  test("notes when there are no findings", () => {
    const prompt = buildNarratePrompt({
      files: [file("a.ts", 1, 1)],
      comments: [] as never,
      background: "",
      mode: "diff",
      ref: "HEAD",
    });
    expect(prompt).toContain("Review findings: none.");
    expect(prompt).toContain("Requirement background: none provided");
  });
});
