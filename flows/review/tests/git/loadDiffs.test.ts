import { testIo } from "../io.ts";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { effectivePath } from "../../src/git/effectivePath.ts";
import { loadDiffs as loadDiffsImpl } from "../../src/git/loadDiffs.ts";
import { reviewOwnPaths } from "../../src/review/reviewOwnPaths.ts";
import { normalizeOpenCodeReviewInput } from "../../src/workflow/normalizeOpenCodeReviewInput.ts";
import { tempRepos } from "../support/tempRepos.ts";

const { git, write, track, initRepo } = tempRepos();

describe("loadDiffs", () => {
  test("workspace mode renders untracked symlinks as their target, never the linked file", async () => {
    const dir = initRepo();
    write(join(dir, "src/app.ts"), "export const v = 1;\n");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-m", "init"]);

    // A readable file outside the repository, reachable only through a link.
    const outside = mkdtempSync(join(tmpdir(), "ocr-outside-"));
    track(outside);
    const secretPath = join(outside, "credentials.txt");
    writeFileSync(secretPath, "DUMMY_SECRET_OUTSIDE_REPO\n");
    symlinkSync(secretPath, join(dir, "src/leak.ts"));
    symlinkSync(join(outside, "absent.txt"), join(dir, "src/broken.ts"));
    symlinkSync(outside, join(dir, "src/linkdir.ts"));
    write(join(dir, "src/plain.ts"), "export const plain = 1;\n");

    const diffs = await loadDiffs(dir, { ...normalizeOpenCodeReviewInput({}), repo: dir });
    const whole = diffs.map((d) => d.diff).join("\n");
    expect(whole).not.toContain("DUMMY_SECRET_OUTSIDE_REPO");

    const leak = diffs.find((d) => effectivePath(d) === "src/leak.ts");
    expect(leak?.diff).toContain("new file mode 120000");
    expect(leak?.diff).toContain(`+${secretPath}`);
    // A dangling link still renders; it must not throw or read anything.
    const broken = diffs.find((d) => effectivePath(d) === "src/broken.ts");
    expect(broken?.diff).toContain("new file mode 120000");
    expect(broken?.diff).toContain(`+${join(outside, "absent.txt")}`);
    // A link to a directory is not walked into.
    const linkDir = diffs.find((d) => effectivePath(d) === "src/linkdir.ts");
    expect(linkDir?.diff).toContain("new file mode 120000");
    // Ordinary untracked files still contribute their contents.
    const plain = diffs.find((d) => effectivePath(d) === "src/plain.ts");
    expect(plain?.diff).toContain("+export const plain = 1;");
    expect(plain?.diff).not.toContain("new file mode 120000");
  });
  test("workspace mode leaves out the review's own state dir and the output paths it is handed", async () => {
    const dir = initRepo();
    write(join(dir, "src/app.ts"), "export const v = 1;\n");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-m", "init"]);
    // No .gitignore: everything below is untracked.
    write(join(dir, "src/app.ts"), "export const v = 2;\n");
    write(join(dir, ".smithers-review/review.db"), "db");
    write(join(dir, ".smithers-review/walkthrough.html"), "<html></html>");
    write(join(dir, ".smithers-review/.smithers-review-artifacts/a.html"), "<html></html>");
    write(join(dir, "docs/walk.html"), "<html></html>");
    write(join(dir, "docs/.smithers-review-artifacts/b.html"), "<html></html>");
    write(join(dir, "state/r.db"), "db");
    write(join(dir, "state/r.db-wal"), "wal");
    // Neighbours of the excluded paths stay in the review.
    write(join(dir, ".smithers-reviewer/keep.ts"), "export const keep = 1;\n");
    write(join(dir, "docs/walk.html.ts"), "export const keep = 2;\n");
    write(join(dir, "state/r.dbx.ts"), "export const keep = 3;\n");

    const paths = async (own: ReadonlyArray<string>) =>
      (await loadDiffs(dir, { ...normalizeOpenCodeReviewInput({}), repo: dir }, own)).map(effectivePath).sort();
    const always = ["src/app.ts", ".smithers-reviewer/keep.ts", "docs/walk.html.ts", "state/r.dbx.ts"];

    expect(await paths([])).toEqual(
      [...always, "docs/.smithers-review-artifacts/b.html", "docs/walk.html", "state/r.db", "state/r.db-wal"].sort(),
    );
    expect(await paths(reviewOwnPaths(dir, { out: "docs/walk.html", db: join(dir, "state/r.db") }))).toEqual(
      always.sort(),
    );
  });
  test("workspace mode keeps every untracked name exactly, spaces, delimiters and quotes included", async () => {
    const dir = initRepo();
    write(join(dir, "base.txt"), "base\n");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-m", "init"]);
    const names = [
      "plain.txt",
      " leading.txt ",
      "trailing.txt  ",
      "   ",
      "dir/ spaced/inner .txt",
      "new\nline.txt",
      "tab\tfile.txt",
      'q"uo\\te.txt',
      "bell\u0007.txt",
      "x b/y.txt",
      "café 🎉.txt",
    ];
    for (const name of names) write(join(dir, name), `after ${JSON.stringify(name)}\n`);

    const diffs = await loadDiffs(dir, { ...normalizeOpenCodeReviewInput({}), repo: dir });
    expect(diffs.map(effectivePath).sort()).toEqual([...names].sort());
    for (const name of names) {
      const record = diffs.find((d) => effectivePath(d) === name)!;
      expect(record).toMatchObject({ isNew: true, isDeleted: false, insertions: 1, deletions: 0 });
      expect(record.diff).toContain(`+after ${JSON.stringify(name)}`);
    }
  });
});

const loadDiffs = (...args: Parameters<typeof loadDiffsImpl>) => testIo(() => loadDiffsImpl(...args));
