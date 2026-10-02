import { describe, expect, test } from "bun:test";
import { renderPierreFileDiff } from "../src/diffs/renderPierreFileDiff.ts";

const patch = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,2 +1,3 @@",
  " const keep = 1;",
  "-const removed = 2;",
  "+const added = 2;",
  "+const more = 3;",
].join("\n");

describe("renderPierreFileDiff", () => {
  test("renders highlighted, line-numbered diff HTML", async () => {
    const html = await renderPierreFileDiff({ diff: patch });
    expect(html).toContain("data-dehydrated");
    expect(html).toContain('data-line-type="change-addition"');
    expect(html).toContain('data-line-type="change-deletion"');
    expect(html).toContain("data-line-number-content");
  });

  test("defaults to the system theme with both light and dark tokens", async () => {
    const html = await renderPierreFileDiff({ diff: patch });
    expect(html).toContain("--diffs-token-light");
    expect(html).toContain("--diffs-token-dark");
    expect(html).toContain("--diffs-dark");
    expect(html).toContain("color-scheme");
  });

  test("unified is the default layout, split opts in", async () => {
    const unified = await renderPierreFileDiff({ diff: patch });
    expect(unified).toContain('data-diff-type="single"');
    expect(unified).toContain("data-unified");
    const split = await renderPierreFileDiff({ diff: patch, diffStyle: "split" });
    expect(split).toContain('data-diff-type="split"');
  });

  test("explicit light theme still renders light tokens", async () => {
    const html = await renderPierreFileDiff({ diff: patch, themeType: "light" });
    expect(html).toContain("--diffs-token-light");
  });

  test("annotations prerender named slots after their target lines", async () => {
    const html = await renderPierreFileDiff({
      diff: patch,
      annotations: [
        { side: "additions", lineNumber: 2 },
        { side: "deletions", lineNumber: 2 },
      ],
    });
    expect(html).toContain('<slot name="annotation-additions-2"></slot>');
    expect(html).toContain('<slot name="annotation-deletions-2"></slot>');
    expect(html).toContain("data-line-annotation");
    expect(html).toContain("data-annotation-content");
    // gutter gains a matching spacer per annotation so numbers stay aligned
    expect(html).toContain('data-gutter-buffer="annotation"');
    // the addition slot sits directly after the addition line's content row
    const addLine = html.indexOf('data-line="2" data-line-type="change-addition"');
    const addSlot = html.indexOf('<slot name="annotation-additions-2">');
    expect(addLine).toBeGreaterThan(-1);
    expect(addSlot).toBeGreaterThan(addLine);
  });

  test("annotations work in split view too", async () => {
    const html = await renderPierreFileDiff({
      diff: patch,
      diffStyle: "split",
      annotations: [{ side: "additions", lineNumber: 3 }],
    });
    expect(html).toContain('<slot name="annotation-additions-3"></slot>');
  });
});
