import { testIo } from "../io.ts";
import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { nativeReviewPromptFromSnapshot } from "../../src/review/nativeReviewPromptFromSnapshot.ts";
import { loadReviewSnapshot as loadReviewSnapshotImpl } from "../../src/review/loadReviewSnapshot.ts";
import type { OpenCodeReviewInput } from "../../src/workflow/openCodeReviewInputSchema.ts";
import { previewFromSnapshot } from "../../src/review/previewFromSnapshot.ts";
import { normalizeOpenCodeReviewInput } from "../../src/workflow/normalizeOpenCodeReviewInput.ts";
import type { PreviewOutput } from "../../src/workflow/previewOutputSchema.ts";
import { tempRepos } from "../support/tempRepos.ts";

const { git, write, track, initRepo } = tempRepos();

// Fixture commits and snapshot reads spawn real git processes. Match the
// guarded-git budget in pullRequestScope.test.ts; 5s is flaky under gate load.
const GIT_TIMEOUT_MS = 30_000;

const previewSnapshot = async (input: OpenCodeReviewInput) => previewFromSnapshot(await loadReviewSnapshot(input));
const promptSnapshot = async (input: OpenCodeReviewInput, preview: PreviewOutput) => nativeReviewPromptFromSnapshot(await loadReviewSnapshot(input), preview);


describe("previewSnapshot + promptSnapshot (real git)", () => {
  test("workspace mode: tracked modification, untracked files, filters, checklists, big diff", async () => {
    const dir = initRepo();
    write(join(dir, "src/app.ts"), "export const v = 1;\n");
    write(join(dir, "src/keep.ts"), "export const keep = 1;\n");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-m", "init"]);

    // Tracked modification so `git diff HEAD` is non-empty.
    write(join(dir, "src/app.ts"), "export const v = 1;\nexport const w = 2;\n");
    // Delete a committed file → exercises the deleted-file diff parsing + prompt.
    rmSync(join(dir, "src/keep.ts"));
    // Untracked files across languages/kinds to exercise checklist selection.
    write(join(dir, "src/util.ts"), "export const util = () => 42;\n");
    write(join(dir, "src/tests/helper.ts"), "export const help = 1;\n"); // reviewable test-dir file → test checklist
    write(join(dir, "e2e/flow.ts"), "export const flow = 1;\n"); // e2e dir is a test path for every consumer
    write(join(dir, "src/app.test.ts"), "test('x', () => {});\n"); // test-file checklist + default exclude
    write(join(dir, "config.json"), '{"a":1}\n'); // json/yaml checklist
    write(join(dir, "notes.md"), "# notes\n"); // unsupported ext → excluded, default checklist path
    write(join(dir, "src/big.ts"), `export const big = "${"x".repeat(70_000)}";\n`); // trimDiff truncation at the reviewer limit
    // node_modules provider-excluded path.
    write(join(dir, "node_modules/dep.js"), "module.exports = 1;\n");

    const preview = await previewSnapshot({ ...normalizeOpenCodeReviewInput({}), repo: dir });
    expect(preview.totalFiles).toBeGreaterThan(0);
    expect(preview.reviewableCount).toBeGreaterThan(0);
    // notes.md is unsupported-ext excluded; node_modules is provider excluded.
    const paths = preview.entries.map((e) => e.path);
    expect(paths).toContain("src/app.ts");
    expect(preview.entries.find((e) => e.path === "node_modules/dep.js")?.excludeReason).toBe("provider_dir");
    const md = preview.entries.find((e) => e.path === "notes.md");
    expect(md?.willReview).toBe(false);
    expect(md?.excludeReason).toBe("unsupported_ext");
    const testFile = preview.entries.find((e) => e.path === "src/app.test.ts");
    expect(testFile?.willReview).toBe(false);

    const prompt = await promptSnapshot({ ...normalizeOpenCodeReviewInput({}), repo: dir }, preview);
    expect(prompt.shouldReview).toBe(true);
    expect(prompt.files.length).toBe(preview.reviewableCount);
    const appFile = prompt.files.find((f) => f.path === "src/app.ts");
    expect(appFile?.prompt).toContain("Review checklist:");
    // The seat gets a noop registry, so the prompt states the diff-only contract.
    expect(appFile?.prompt).toContain("You have no repository access and no tools");
    expect(appFile?.prompt).not.toContain("Your working directory is the repository");
    // "Other changed files" lists the sibling reviewable files.
    expect(appFile?.prompt).toContain("Other changed files:");
    const bigFile = prompt.files.find((f) => f.path === "src/big.ts");
    expect(bigFile?.prompt).toContain("[diff truncated for prompt size]");
    // The deleted file is reviewable and carries the deletion-focused prompt.
    const deleted = prompt.files.find((f) => f.path === "src/keep.ts");
    expect(deleted?.status).toBe("deleted");
    expect(deleted?.prompt).toContain("This file is DELETED");
    expect(deleted?.prompt).not.toContain("Grep the repository");
    // The test-dir file selects the test-quality checklist.
    const helper = prompt.files.find((f) => f.path === "src/tests/helper.ts");
    expect(helper?.prompt).toContain("Test quality:");
    const e2e = prompt.files.find((f) => f.path === "e2e/flow.ts");
    expect(e2e?.prompt).toContain("Test quality:");
  }, GIT_TIMEOUT_MS);

  test("promptSnapshot reports no reviewable files when a stale preview disagrees", async () => {
    const dir = initRepo();
    write(join(dir, "README.md"), "# docs only\n");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-m", "init"]);
    write(join(dir, "README.md"), "# docs only\nmore\n");
    // Hand-built preview claims a reviewable file, but the repo has only an
    // unsupported doc change → reviewableDiffs resolves to empty.
    const stalePreview: PreviewOutput = {
      entries: [
        { path: "README.md", status: "modified", insertions: 1, deletions: 0, willReview: true, excludeReason: "" },
      ],
      totalInsertions: 1,
      totalDeletions: 0,
      totalFiles: 1,
      reviewableCount: 1,
      excludedCount: 0,
    };
    const prompt = await promptSnapshot({ ...normalizeOpenCodeReviewInput({}), repo: dir }, stalePreview);
    expect(prompt.shouldReview).toBe(false);
    expect(prompt.message).toContain("No supported files changed");
  }, GIT_TIMEOUT_MS);

  test("workspace mode with only untracked changes falls through to the staged-diff branch", async () => {
    const dir = initRepo();
    write(join(dir, "src/app.ts"), "export const v = 1;\n");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-m", "init"]);
    // No tracked modification → `git diff HEAD` empty → staged-diff fallback.
    write(join(dir, "src/fresh.ts"), "export const fresh = 1;\n");
    const preview = await previewSnapshot({ ...normalizeOpenCodeReviewInput({}), repo: dir });
    expect(preview.entries.some((e) => e.path === "src/fresh.ts")).toBe(true);
  }, GIT_TIMEOUT_MS);

  test("range and commit modes read their diffs", async () => {
    const dir = initRepo();
    write(join(dir, "src/app.ts"), "export const v = 1;\n");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-m", "init"]);
    write(join(dir, "src/app.ts"), "export const v = 1;\nexport const w = 2;\n");
    write(join(dir, "src/added.ts"), "export const added = 1;\n");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-m", "second"]);

    const range = await previewSnapshot({
      ...normalizeOpenCodeReviewInput({}),
      repo: dir,
      from: "HEAD~1",
      to: "HEAD",
    });
    expect(range.totalFiles).toBeGreaterThan(0);
    const commit = await previewSnapshot({ ...normalizeOpenCodeReviewInput({}), repo: dir, commit: "HEAD" });
    expect(commit.totalFiles).toBeGreaterThan(0);
  }, GIT_TIMEOUT_MS);

  test("project rule.json include/exclude filters via --rule and repo config", async () => {
    const dir = initRepo();
    write(join(dir, "src/app.ts"), "export const v = 1;\n");
    write(join(dir, "src/skip.ts"), "export const skip = 1;\n");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-m", "init"]);
    write(join(dir, "src/app.ts"), "export const v = 1;\nexport const w = 2;\n");
    write(join(dir, "src/skip.ts"), "export const skip = 1;\nexport const q = 2;\n");
    // A --rule path that is a non-object JSON → readProjectRule returns null.
    const badRule = join(dir, "bad-rule.json");
    write(badRule, "[]");
    // The repo-level rule provides the real include/exclude.
    write(
      join(dir, ".opencodereview/rule.json"),
      JSON.stringify({ include: ["src/app.ts"], exclude: ["src/skip.ts"] }),
    );

    const preview = await previewSnapshot({ ...normalizeOpenCodeReviewInput({}), repo: dir, rule: badRule });
    const skip = preview.entries.find((e) => e.path === "src/skip.ts");
    expect(skip?.willReview).toBe(false);
    expect(skip?.excludeReason).toBe("user_exclude");
    const app = preview.entries.find((e) => e.path === "src/app.ts");
    expect(app?.willReview).toBe(true);
  }, GIT_TIMEOUT_MS);

  test("promptSnapshot short-circuits when runReview is false or nothing is reviewable", async () => {
    const dir = initRepo();
    write(join(dir, "README.md"), "# only docs\n");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-m", "init"]);
    write(join(dir, "README.md"), "# only docs\nmore\n");

    const preview = await previewSnapshot({ ...normalizeOpenCodeReviewInput({}), repo: dir });
    // runReview disabled → shouldReview false.
    const disabled = await promptSnapshot(
      { ...normalizeOpenCodeReviewInput({}), repo: dir, runReview: false },
      preview,
    );
    expect(disabled.shouldReview).toBe(false);
    expect(disabled.message).toContain("disabled");

    // Only an unsupported doc changed → reviewableCount 0.
    const nothing = await promptSnapshot({ ...normalizeOpenCodeReviewInput({}), repo: dir }, preview);
    expect(nothing.shouldReview).toBe(false);
    expect(nothing.message).toContain("No supported files changed");
  }, GIT_TIMEOUT_MS);
});

const loadReviewSnapshot = (...args: Parameters<typeof loadReviewSnapshotImpl>) => testIo(() => loadReviewSnapshotImpl(...args));
