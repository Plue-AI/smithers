import { testIo } from "./io.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { normalizeOpenCodeReviewInput } from "../src/workflow/normalizeOpenCodeReviewInput.ts";
import { loadReviewSnapshot as loadReviewSnapshotImpl } from "../src/review/loadReviewSnapshot.ts";
import { previewFromSnapshot } from "../src/review/previewFromSnapshot.ts";
import { changesFromDiffs } from "../src/walkthrough/changesFromDiffs.ts";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function run(command: string, args: string[], cwd: string) {
  execFileSync(command, args, { cwd, stdio: "pipe" });
}

function write(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function tempRepo() {
  const dir = mkdtempSync(join(tmpdir(), "review-changes-"));
  tempDirs.push(dir);
  run("git", ["init"], dir);
  run("git", ["config", "user.email", "test@example.com"], dir);
  run("git", ["config", "user.name", "Test User"], dir);
  write(join(dir, "src/app.ts"), "export const value = 1;\n");
  run("git", ["add", "."], dir);
  run("git", ["commit", "-m", "initial"], dir);
  return dir;
}

describe("snapshot changes", () => {
  test("includes review-excluded files with full diffs and review flags", async () => {
    const repo = tempRepo();
    write(join(repo, "src/app.ts"), "export const value = 1;\nexport const next = 2;\n");
    write(join(repo, "src/app.test.ts"), "test('x', () => {});\n");
    write(join(repo, "notes.md"), "# Notes\n");

    const input = normalizeOpenCodeReviewInput({ repo });
    const snapshot = await loadReviewSnapshot(input);
    const preview = previewFromSnapshot(snapshot);
    const changes = changesFromDiffs(snapshot.diffs, preview);

    const byPath = new Map(changes.files.map((file) => [file.path, file]));
    expect(changes.totalFiles).toBe(3);

    const app = byPath.get("src/app.ts")!;
    expect(app.reviewed).toBe(true);
    expect(app.status).toBe("modified");
    expect(app.diff).toContain("+export const next = 2;");

    const testFile = byPath.get("src/app.test.ts")!;
    expect(testFile.reviewed).toBe(false);
    expect(testFile.excludeReason).toBe("default_path");
    expect(testFile.status).toBe("added");
    expect(testFile.diff).toContain("+test('x', () => {});");

    const notes = byPath.get("notes.md")!;
    expect(notes.reviewed).toBe(false);
    expect(notes.excludeReason).toBe("unsupported_ext");

    expect(changes.totalInsertions).toBe(app.insertions + testFile.insertions + notes.insertions);
  });
});

const loadReviewSnapshot = (...args: Parameters<typeof loadReviewSnapshotImpl>) => testIo(() => loadReviewSnapshotImpl(...args));
