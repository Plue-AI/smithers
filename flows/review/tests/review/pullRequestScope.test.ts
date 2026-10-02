import { testIo } from "../io.ts";
import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import * as Schema from "effect/Schema";
import { finalizeNativeReview } from "../../src/review/finalizeNativeReview.ts";
import { loadReviewSnapshot as loadReviewSnapshotImpl } from "../../src/review/loadReviewSnapshot.ts";
import { nativeReviewPromptFromSnapshot } from "../../src/review/nativeReviewPromptFromSnapshot.ts";
import { previewFromSnapshot } from "../../src/review/previewFromSnapshot.ts";
import { changesFromDiffs } from "../../src/walkthrough/changesFromDiffs.ts";
import { NativeReviewAgentOutput } from "../../src/workflow/nativeReviewAgentOutputSchema.ts";
import { normalizeOpenCodeReviewInput } from "../../src/workflow/normalizeOpenCodeReviewInput.ts";
import { tempRepos } from "../support/tempRepos.ts";

const { git, write, initRepo } = tempRepos();

const head = (dir: string) => execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();

function commit(dir: string, message: string) {
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-m", message]);
  return head(dir);
}

/** A base commit, then a PR commit that tries to hide its own changes. */
function hidingPullRequest(baseRule?: string) {
  const dir = initRepo();
  write(join(dir, "src/app.ts"), "export const v = 1;\n");
  if (baseRule !== undefined) write(join(dir, ".opencodereview/rule.json"), baseRule);
  const base = commit(dir, "base");
  write(join(dir, "src/app.ts"), "export const v = 2;\n");
  write(join(dir, "src/evil.ts"), "export const evil = 1;\n");
  write(join(dir, ".gitignore"), "*.ts\n");
  write(join(dir, ".opencodereview/rule.json"), JSON.stringify({ exclude: ["src/**"] }));
  git(dir, ["add", "--force", "src/evil.ts"]);
  const pr = commit(dir, "pr");
  return { dir, base, pr };
}

// Each test makes several real commits; a guarded git is slow to spawn.
const GIT_TIMEOUT_MS = 30_000;

const input = (fields: Record<string, unknown>) => ({ ...normalizeOpenCodeReviewInput({}), ...fields });

function reviewed(preview: ReturnType<typeof previewFromSnapshot>) {
  return preview.entries.filter((entry) => entry.willReview).map((entry) => entry.path).sort();
}

describe("the PR under review cannot choose its own review scope", () => {
  test("range mode ignores the PR's .gitignore and rule.json", async () => {
    const { dir, base, pr } = hidingPullRequest();
    const snapshot = await loadReviewSnapshot(input({ repo: dir, from: base, to: pr }));
    expect(reviewed(previewFromSnapshot(snapshot))).toEqual([".gitignore", ".opencodereview/rule.json", "src/app.ts", "src/evil.ts"]);
  }, GIT_TIMEOUT_MS);

  test("commit mode ignores the commit's .gitignore and rule.json", async () => {
    const { dir, pr } = hidingPullRequest();
    const snapshot = await loadReviewSnapshot(input({ repo: dir, commit: pr }));
    expect(reviewed(previewFromSnapshot(snapshot))).toEqual([".gitignore", ".opencodereview/rule.json", "src/app.ts", "src/evil.ts"]);
  }, GIT_TIMEOUT_MS);

  test("range mode applies the base revision's rule even when the PR rewrites it", async () => {
    const { dir, base, pr } = hidingPullRequest(JSON.stringify({ exclude: ["src/app.ts"] }));
    const preview = previewFromSnapshot(await loadReviewSnapshot(input({ repo: dir, from: base, to: pr })));
    expect(preview.entries.find((entry) => entry.path === "src/app.ts")?.excludeReason).toBe("user_exclude");
    expect(reviewed(preview)).toEqual([".gitignore", ".opencodereview/rule.json", "src/evil.ts"]);
  }, GIT_TIMEOUT_MS);

  test("workspace mode reviews a tracked file that .gitignore matches", async () => {
    const dir = initRepo();
    write(join(dir, "src/gen.ts"), "export const gen = 1;\n");
    commit(dir, "base");
    write(join(dir, ".gitignore"), "gen.ts\n");
    write(join(dir, "src/gen.ts"), "export const gen = 2;\n");
    // Untracked files the .gitignore matches stay out, as git itself decides.
    write(join(dir, "src/ignored/gen.ts"), "export const other = 1;\n");
    const preview = previewFromSnapshot(await loadReviewSnapshot(input({ repo: dir })));
    expect(preview.entries.map((entry) => entry.path).sort()).toEqual([".gitignore", "src/gen.ts"]);
    expect(reviewed(preview)).toEqual([".gitignore", "src/gen.ts"]);
  }, GIT_TIMEOUT_MS);
});

describe("provider directories", () => {
  test("stay in the preview and walkthrough with a reason, and a rule include brings them back", async () => {
    const dir = initRepo();
    write(join(dir, "src/app.ts"), "export const v = 1;\n");
    const base = commit(dir, "base");
    write(join(dir, "vendor/lib/lib.go"), "package lib\n");
    write(join(dir, "pkgs/core/index.ts"), "export const core = 1;\n");
    const pr = commit(dir, "pr");

    const snapshot = await loadReviewSnapshot(input({ repo: dir, from: base, to: pr }));
    const preview = previewFromSnapshot(snapshot);
    for (const path of ["vendor/lib/lib.go", "pkgs/core/index.ts"]) {
      expect(preview.entries.find((entry) => entry.path === path)).toMatchObject({ willReview: false, excludeReason: "provider_dir" });
    }
    expect(changesFromDiffs(snapshot.diffs, preview).files.map((file) => file.path).sort()).toEqual([
      "pkgs/core/index.ts",
      "vendor/lib/lib.go",
    ]);

    const rule = join(dir, "..", `${dir.split("/").pop()}-rule.json`);
    write(rule, JSON.stringify({ include: ["pkgs/**"] }));
    try {
      const included = previewFromSnapshot(await loadReviewSnapshot(input({ repo: dir, from: base, to: pr, rule })));
      expect(reviewed(included)).toEqual(["pkgs/core/index.ts"]);
    } finally {
      rmSync(rule, { force: true });
    }
  }, GIT_TIMEOUT_MS);
});

describe("a malformed rule.json", () => {
  test("is a typed warning carried to the review output, not a crash", async () => {
    const { dir, base, pr } = hidingPullRequest("{ not json");
    const snapshot = await loadReviewSnapshot(input({ repo: dir, from: base, to: pr }));
    expect(snapshot.filter).toBeNull();
    const preview = previewFromSnapshot(snapshot);
    const prompt = nativeReviewPromptFromSnapshot(snapshot, preview);
    const expected = { type: "rule_invalid", file: ".opencodereview/rule.json" };
    expect(prompt.warnings).toEqual([expect.objectContaining(expected)]);

    const outcome = finalizeNativeReview(
      snapshot.input,
      prompt,
      preview,
      prompt.files.map((file) => ({ file, output: Schema.decodeUnknownSync(NativeReviewAgentOutput)({ status: "success" }) })),
    );
    expect(outcome.status).toBe("completed_with_warnings");
    expect(outcome.warnings).toContainEqual(expect.objectContaining(expected));

    const skipped = finalizeNativeReview({ ...snapshot.input, runReview: false }, { ...prompt, shouldReview: false }, preview, []);
    expect(skipped.warnings).toContainEqual(expect.objectContaining(expected));
  }, GIT_TIMEOUT_MS);

  test("in the working tree falls through to the next rule instead of crashing preparation", async () => {
    const dir = initRepo();
    write(join(dir, "src/app.ts"), "export const v = 1;\n");
    commit(dir, "base");
    write(join(dir, "src/app.ts"), "export const v = 2;\n");
    write(join(dir, ".opencodereview/rule.json"), "{");
    const rule = join(dir, "..", `${dir.split("/").pop()}-rule.json`);
    write(rule, "[]");
    try {
      const snapshot = await loadReviewSnapshot(input({ repo: dir, rule }));
      expect(snapshot.warnings.map((warning) => [warning.type, warning.file])).toEqual([
        ["rule_invalid", rule],
        ["rule_invalid", ".opencodereview/rule.json"],
      ]);
      expect(reviewed(previewFromSnapshot(snapshot))).toContain("src/app.ts");
    } finally {
      rmSync(rule, { force: true });
    }
  }, GIT_TIMEOUT_MS);
});

const loadReviewSnapshot = (...args: Parameters<typeof loadReviewSnapshotImpl>) => testIo(() => loadReviewSnapshotImpl(...args));
