import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { effectivePath } from "../../src/git/effectivePath.ts";
import { parseGitDiff } from "../../src/git/parseGitDiff.ts";
import { assessChangeImpact } from "../../src/quiz/assessChangeImpact.ts";
import { loadReviewSnapshot } from "../../src/review/loadReviewSnapshot.ts";
import { previewFromSnapshot } from "../../src/review/previewFromSnapshot.ts";
import { changesFromDiffs } from "../../src/walkthrough/changesFromDiffs.ts";
import { normalizeOpenCodeReviewInput } from "../../src/workflow/normalizeOpenCodeReviewInput.ts";
import { tempRepos } from "../support/tempRepos.ts";

const { git, write, initRepo } = tempRepos();

function numstat(dir: string) {
  return execFileSync("git", ["diff", "HEAD", "--numstat"], { cwd: dir, encoding: "utf8" })
    .trim()
    .split("\n")
    .map((line) => line.split("\t"))
    .map(([added, removed, path]) => ({ path, insertions: Number(added), deletions: Number(removed) }));
}

async function prepare(dir: string) {
  const snapshot = await loadReviewSnapshot(normalizeOpenCodeReviewInput({ repo: dir }));
  const preview = previewFromSnapshot(snapshot);
  const changes = changesFromDiffs(snapshot.diffs, preview);
  return { snapshot, preview, changes, impact: assessChangeImpact(changes.files, []) };
}

describe("parseGitDiff hunk accounting", () => {
  test("counts added ++ and removed -- content lines the way git numstat does", async () => {
    const dir = initRepo();
    write(join(dir, "src/inc.ts"), "let counter = 0;\n");
    write(join(dir, "src/dec.ts"), "let counter = 0;\n--counter;\n--counter;\n");
    write(join(dir, "db/query.sql"), "-- header comment\nSELECT 1;\n");
    write(join(dir, "src/plain.ts"), "let counter = 0;\n");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-m", "init"]);

    write(join(dir, "src/inc.ts"), "let counter = 0;\n++counter;\n+++counter;\n");
    write(join(dir, "src/dec.ts"), "let counter = 0;\n");
    write(join(dir, "db/query.sql"), "-- replaced comment\nSELECT 1;\n");
    write(join(dir, "src/plain.ts"), "let counter = 0;\ncounter += 1;\n");

    const { preview, changes } = await prepare(dir);
    const expected = numstat(dir);
    expect(expected).toHaveLength(4);
    for (const want of expected) {
      const entry = preview.entries.find((e) => e.path === want.path)!;
      expect({ path: entry.path, insertions: entry.insertions, deletions: entry.deletions }).toEqual(want);
      const file = changes.files.find((f) => f.path === want.path)!;
      expect(file.insertions).toBe(want.insertions);
      expect(file.deletions).toBe(want.deletions);
    }
    // File headers are still headers, not content.
    const inc = changes.files.find((f) => f.path === "src/inc.ts")!;
    expect(inc.diff).toContain("--- a/src/inc.ts\n+++ b/src/inc.ts");
    expect(inc.diff).toContain("\n+++counter;\n++++counter;");
    expect(inc.status).toBe("modified");
  });

  test("a deleted file of -- lines keeps its removed content reviewable", async () => {
    const dir = initRepo();
    write(join(dir, "db/drop.sql"), "-- one\n-- two\n");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-m", "init"]);
    rmSync(join(dir, "db/drop.sql"));

    const { preview } = await prepare(dir);
    const entry = preview.entries.find((e) => e.path === "db/drop.sql")!;
    expect(entry).toMatchObject({ status: "deleted", insertions: 0, deletions: 2, willReview: true, excludeReason: "" });
  });

  test("801 added ++counter; lines carry the large-change signal like any 801 lines", async () => {
    const churn = async (line: string) => {
      const dir = initRepo();
      write(join(dir, "src/loop.ts"), "let counter = 0;\n");
      git(dir, ["add", "."]);
      git(dir, ["commit", "-m", "init"]);
      write(join(dir, "src/loop.ts"), `let counter = 0;\n${`${line}\n`.repeat(801)}`);
      return prepare(dir);
    };
    const prefixed = await churn("++counter;");
    const control = await churn("counter += 1;");
    expect(prefixed.changes.totalInsertions).toBe(801);
    expect(control.changes.totalInsertions).toBe(801);
    expect(prefixed.impact).toEqual(control.impact);
    expect(prefixed.impact.reasons.map((r) => r.signal)).toContain("large change (801 lines across 1 files)");
  });

  test("header markers only mark a file before its first hunk", () => {
    const [record] = parseGitDiff(
      [
        "diff --git a/f.txt b/f.txt",
        "index 1..2 100644",
        "--- a/f.txt",
        "+++ b/f.txt",
        "@@ -1,2 +1,2 @@",
        "--- /dev/null",
        "-new file mode 100644",
        "+++ /dev/null",
        "+Binary files a and b differ",
      ].join("\n"),
    );
    expect(record).toMatchObject({
      oldPath: "f.txt",
      newPath: "f.txt",
      insertions: 2,
      deletions: 2,
      isNew: false,
      isDeleted: false,
      isBinary: false,
    });
    expect(effectivePath(record)).toBe("f.txt");
  });
});
