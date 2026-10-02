import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { ReviewCommentSeverity } from "../src/workflow/reviewCommentSeveritySchema.ts";
import { buildVerifyFindingsPrompt } from "../src/workflow/verifyFindings.ts";

/**
 * `ReviewCommentSeverity` is the one list of severities. Every order, rank,
 * count, and prompt sentence derives from it, so adding or renaming a level is
 * one edit; a hand copy agrees with the schema until the day it does not.
 */

const appDir = fileURLToPath(new URL("../", import.meta.url));

/** Every source file this app ships. Tests may spell the levels out. */
function sourceFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (path.endsWith(".ts") || path.endsWith(".mjs")) found.push(path);
    }
  };
  for (const top of ["src"]) walk(join(appDir, top));
  return found;
}

describe("the severity list lives in the schema", () => {
  test("no source file retypes the levels as a list, a keyed record, or a union", () => {
    const copy = /"critical",\s*"major",\s*"minor",\s*"info"|critical:\s*\d+,\s*major:\s*\d+|"critical"\s*\|\s*"major"/g;
    const copies: Record<string, number> = {};
    for (const path of sourceFiles()) {
      const count = readFileSync(path, "utf8").match(copy)?.length ?? 0;
      if (count > 0) copies[relative(appDir, path)] = count;
    }
    expect(copies).toEqual({ "src/workflow/reviewCommentSeveritySchema.ts": 1 });
  });

  test("the verifier prompt offers exactly the levels the verdict schema accepts", () => {
    const prompt = buildVerifyFindingsPrompt({ findings: [], filesByPath: new Map() });
    const offered = /severity is one of (.+)\.$/m.exec(prompt)?.[1]!;
    expect(offered).toBe(ReviewCommentSeverity.literals.map((level) => `"${level}"`).join(", "));
  });
});
