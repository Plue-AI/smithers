import { describe, expect, test } from "bun:test";
import { parsePatchCommentableLines } from "../../src/github/parsePatchCommentableLines.ts";

describe("parsePatchCommentableLines", () => {
  test("multi-hunk patch yields only added and context new-side line numbers", () => {
    const patch = [
      "@@ -1,3 +1,4 @@",
      " context one",
      "+added two",
      " context three",
      "-removed old",
      "+added four",
      "@@ -10,2 +11,3 @@",
      " context eleven",
      "+added twelve",
      " context thirteen",
    ].join("\n");
    expect(parsePatchCommentableLines(patch)).toEqual(new Set([1, 2, 3, 4, 11, 12, 13]));
  });

  test("a deleted-only hunk contributes no commentable lines", () => {
    const patch = [
      "@@ -5,3 +4,0 @@",
      "-gone one",
      "-gone two",
      "-gone three",
      "@@ -20,1 +17,2 @@",
      " kept",
      "+new line",
    ].join("\n");
    expect(parsePatchCommentableLines(patch)).toEqual(new Set([17, 18]));
  });

  test("empty string yields an empty set", () => {
    expect(parsePatchCommentableLines("")).toEqual(new Set());
    expect(parsePatchCommentableLines("   \n ")).toEqual(new Set());
  });

  test('the "\\ No newline at end of file" marker does not consume a line number', () => {
    const patch = ["@@ -1,2 +1,2 @@", " context", "-old last", "+new last", "\\ No newline at end of file"].join("\n");
    expect(parsePatchCommentableLines(patch)).toEqual(new Set([1, 2]));
  });

  test("CRLF patches produce the same line numbers with no off-by-one", () => {
    const lf = ["@@ -1,3 +1,3 @@", " a", "+b", " c"].join("\n");
    const crlf = ["@@ -1,3 +1,3 @@", " a", "+b", " c"].join("\r\n");
    expect(parsePatchCommentableLines(crlf)).toEqual(parsePatchCommentableLines(lf));
    expect(parsePatchCommentableLines(crlf)).toEqual(new Set([1, 2, 3]));
  });

  test("binary or hunk-less patches yield an empty set", () => {
    expect(parsePatchCommentableLines("Binary files a/logo.png and b/logo.png differ")).toEqual(new Set());
    expect(parsePatchCommentableLines("+not inside any hunk\n context")).toEqual(new Set());
  });
});
