import { describe, expect, test } from "bun:test"
import { renderFallbackDiffHtml } from "../src/diffs/renderFallbackDiffHtml.ts"

function rowsOf(html: string): string[] {
  return html.match(/<tr[^>]*>.*?<\/tr>/g) ?? []
}

describe("renderFallbackDiffHtml", () => {
  test("deleted '-- ' content lines are rendered, not dropped as file headers", () => {
    const diff = [
      "diff --git a/query.sql b/query.sql",
      "--- a/query.sql",
      "+++ b/query.sql",
      "@@ -1,4 +1,3 @@",
      " SELECT 1;",
      "--- drop this comment",
      "-SELECT 2;",
      " SELECT 3;"
    ].join("\n")
    const html = renderFallbackDiffHtml(diff)
    expect(html).toContain("-- drop this comment")
    const rows = rowsOf(html)
    // hunk + 4 content rows, nothing silently dropped
    expect(rows).toHaveLength(5)
    expect(rows[1]!).toContain("class=\"ctx\" data-old=\"1\" data-new=\"1\"")
    expect(rows[2]!).toContain("class=\"del\" data-old=\"2\"")
    expect(rows[3]!).toContain("class=\"del\" data-old=\"3\"")
    expect(rows[4]!).toContain("class=\"ctx\" data-old=\"4\" data-new=\"2\"")
  })

  test("added '++ ' content lines are rendered with continuous numbering", () => {
    const diff = [
      "diff --git a/inc.cpp b/inc.cpp",
      "--- a/inc.cpp",
      "+++ b/inc.cpp",
      "@@ -1,2 +1,3 @@",
      " int i = 0;",
      "+++ this looks like a header;",
      " i;"
    ].join("\n")
    const html = renderFallbackDiffHtml(diff)
    expect(html).toContain("++ this looks like a header;")
    const rows = rowsOf(html)
    expect(rows).toHaveLength(4)
    expect(rows[2]!).toContain("class=\"add\" data-new=\"2\"")
    expect(rows[3]!).toContain("class=\"ctx\" data-old=\"2\" data-new=\"3\"")
  })

  test("multi-file patch resets state at each diff --git", () => {
    const diff = [
      "diff --git a/one.txt b/one.txt",
      "index 1111111..2222222 100644",
      "--- a/one.txt",
      "+++ b/one.txt",
      "@@ -1 +1 @@",
      "-first old",
      "+first new",
      "diff --git a/two.txt b/two.txt",
      "index 3333333..4444444 100644",
      "--- a/two.txt",
      "+++ b/two.txt",
      "@@ -10 +10 @@",
      "-second old",
      "+second new"
    ].join("\n")
    const html = renderFallbackDiffHtml(diff)
    const rows = rowsOf(html)
    expect(rows).toHaveLength(6)
    expect(rows[1]!).toContain("data-old=\"1\"")
    expect(rows[2]!).toContain("data-new=\"1\"")
    expect(rows[4]!).toContain("data-old=\"10\"")
    expect(rows[5]!).toContain("data-new=\"10\"")
    // second file's header lines must not leak in as content
    expect(html).not.toContain("b/two.txt</td>")
  })

  test("rename-only patch emits a note row, not an empty table", () => {
    const diff = [
      "diff --git a/old-name.ts b/new-name.ts",
      "similarity index 100%",
      "rename from old-name.ts",
      "rename to new-name.ts"
    ].join("\n")
    const html = renderFallbackDiffHtml(diff)
    expect(html).toContain("<table")
    expect(html).toContain("Renamed old-name.ts to new-name.ts.")
    expect(rowsOf(html)).toHaveLength(1)
  })

  test("mode-only patch emits a note row", () => {
    const diff = ["diff --git a/run.sh b/run.sh", "old mode 100644", "new mode 100755"].join("\n")
    const html = renderFallbackDiffHtml(diff)
    expect(html).toContain("Mode changed 100644 to 100755.")
    expect(rowsOf(html)).toHaveLength(1)
  })

  test("binary patch emits a note row", () => {
    const diff = [
      "diff --git a/logo.png b/logo.png",
      "index 1111111..2222222 100644",
      "Binary files a/logo.png and b/logo.png differ"
    ].join("\n")
    const html = renderFallbackDiffHtml(diff)
    expect(html).toContain("Binary files differ.")
    expect(rowsOf(html)).toHaveLength(1)
  })

  test("rename note follows an earlier file's hunks in a multi-file patch", () => {
    const diff = [
      "diff --git a/one.txt b/one.txt",
      "--- a/one.txt",
      "+++ b/one.txt",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "diff --git a/x.ts b/y.ts",
      "rename from x.ts",
      "rename to y.ts"
    ].join("\n")
    const html = renderFallbackDiffHtml(diff)
    expect(rowsOf(html)).toHaveLength(4)
    expect(html).toContain("Renamed x.ts to y.ts.")
  })

  test("CRLF line endings render without stray carriage returns", () => {
    const diff = [
      "diff --git a/win.txt b/win.txt",
      "--- a/win.txt",
      "+++ b/win.txt",
      "@@ -1,2 +1,2 @@",
      " keep",
      "-old windows line",
      "+new windows line"
    ].join("\r\n")
    const html = renderFallbackDiffHtml(diff)
    expect(html).not.toContain("\r")
    const rows = rowsOf(html)
    expect(rows).toHaveLength(4)
    expect(rows[2]!).toContain(">old windows line</td>")
    expect(rows[3]!).toContain(">new windows line</td>")
  })

  test("unicode content is preserved and HTML is escaped", () => {
    const diff = [
      "diff --git a/i18n.ts b/i18n.ts",
      "--- a/i18n.ts",
      "+++ b/i18n.ts",
      "@@ -1 +1 @@",
      "-const label = \"日本語 🚀\";",
      "+const label = \"<b>naïve & 中文</b>\";"
    ].join("\n")
    const html = renderFallbackDiffHtml(diff)
    expect(html).toContain("日本語 🚀")
    expect(html).toContain("&lt;b&gt;naïve &amp; 中文&lt;/b&gt;")
    expect(html).not.toContain("<b>naïve")
  })

  test("\\ No newline at end of file markers are skipped", () => {
    const diff = [
      "diff --git a/f b/f",
      "--- a/f",
      "+++ b/f",
      "@@ -1 +1 @@",
      "-old",
      "\\ No newline at end of file",
      "+new",
      "\\ No newline at end of file"
    ].join("\n")
    const html = renderFallbackDiffHtml(diff)
    expect(html).not.toContain("No newline")
    expect(rowsOf(html)).toHaveLength(3)
  })

  test("exactly 1500 rendered lines is not truncated", () => {
    const contextLines = Array.from({ length: 1499 }, (_, i) => ` line ${i + 1}`)
    const diff = [
      "diff --git a/big.txt b/big.txt",
      "--- a/big.txt",
      "+++ b/big.txt",
      "@@ -1,1499 +1,1499 @@",
      ...contextLines
    ].join("\n")
    const html = renderFallbackDiffHtml(diff)
    expect(html).not.toContain("diff truncated")
    expect(rowsOf(html)).toHaveLength(1500)
  })

  test("one line over the limit appends a truncation note", () => {
    const contextLines = Array.from({ length: 1500 }, (_, i) => ` line ${i + 1}`)
    const diff = [
      "diff --git a/big.txt b/big.txt",
      "--- a/big.txt",
      "+++ b/big.txt",
      "@@ -1,1500 +1,1500 @@",
      ...contextLines
    ].join("\n")
    const html = renderFallbackDiffHtml(diff)
    expect(html).toContain("diff truncated (1 more line(s))")
    // 1500 rendered rows + 1 truncation note
    expect(rowsOf(html)).toHaveLength(1501)
  })

  test("empty and whitespace-only input yields the no-diff note", () => {
    expect(renderFallbackDiffHtml("")).toContain("No textual diff")
    expect(renderFallbackDiffHtml("  \n\t\n")).toContain("No textual diff")
  })

  test("unrecognizable non-diff text yields a note instead of an empty table", () => {
    const html = renderFallbackDiffHtml("hello world\nthis is not a diff")
    expect(html).toContain("No renderable diff content.")
    expect(html).not.toContain("<table")
  })

  test("rows carry data-old/data-new anchors per side", () => {
    const diff = ["diff --git a/f b/f", "--- a/f", "+++ b/f", "@@ -5,3 +7,3 @@", " ctx", "-gone", "+here"].join("\n")
    const html = renderFallbackDiffHtml(diff)
    const rows = rowsOf(html)
    expect(rows[1]!).toContain("data-old=\"5\"")
    expect(rows[1]!).toContain("data-new=\"7\"")
    expect(rows[2]!).toContain("data-old=\"6\"")
    expect(rows[2]!).not.toContain("data-new=")
    expect(rows[3]!).toContain("data-new=\"8\"")
    expect(rows[3]!).not.toContain("data-old=")
  })
})
