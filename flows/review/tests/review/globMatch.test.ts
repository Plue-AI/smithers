import { describe, expect, test } from "bun:test";
import { globMatch } from "../../src/review/globMatch.ts";

describe("globMatch", () => {
  test("globMatch expands braces and honors ** / * segments", () => {
    expect(globMatch("**/*.test.{ts,tsx}", "src/deep/x.test.ts")).toBe(true);
    expect(globMatch("**/*.test.{ts,tsx}", "src/x.test.tsx")).toBe(true);
    expect(globMatch("src/*.ts", "src/a.ts")).toBe(true);
    expect(globMatch("src/*.ts", "src/deep/a.ts")).toBe(false);
    expect(globMatch("a/**", "a/b/c")).toBe(true);
    // unbalanced brace is treated literally
    expect(globMatch("a{b", "a{b")).toBe(true);
  });
});
