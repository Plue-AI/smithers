import { describe, expect, test } from "bun:test";
import * as diffs from "../src/diffs/index.ts";

describe("diffs barrel", () => {
  test("re-exports the public diff helpers", () => {
    expect(typeof diffs.extractDiffAssets).toBe("function");
    expect(typeof diffs.renderFallbackDiffHtml).toBe("function");
    expect(typeof diffs.renderPierreFileDiff).toBe("function");
  });
});
