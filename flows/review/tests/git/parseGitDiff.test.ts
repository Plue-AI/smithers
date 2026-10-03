import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { rmSync } from "node:fs"
import { join } from "node:path"
import { effectivePath } from "../../src/git/effectivePath.ts"
import { loadDiffs as loadDiffsImpl } from "../../src/git/loadDiffs.ts"
import { parseGitDiff } from "../../src/git/parseGitDiff.ts"
import { loadReviewSnapshot as loadReviewSnapshotImpl } from "../../src/review/loadReviewSnapshot.ts"
import { previewFromSnapshot } from "../../src/review/previewFromSnapshot.ts"
import { changesFromDiffs } from "../../src/walkthrough/changesFromDiffs.ts"
import { normalizeOpenCodeReviewInput } from "../../src/workflow/normalizeOpenCodeReviewInput.ts"
import { testIo } from "../io.ts"
import { tempRepos } from "../support/tempRepos.ts"

const { git, write, initRepo } = tempRepos()

function numstat(dir: string) {
  return execFileSync("git", ["diff", "HEAD", "--numstat"], { cwd: dir, encoding: "utf8" })
    .trim()
    .split("\n")
    .map((line) => line.split("\t"))
    .map(([added, removed, path]) => ({ path: path!, insertions: Number(added), deletions: Number(removed) }))
}

async function prepare(dir: string) {
  const snapshot = await loadReviewSnapshot(normalizeOpenCodeReviewInput({ repo: dir }))
  const preview = previewFromSnapshot(snapshot)
  const changes = changesFromDiffs(snapshot.diffs, preview)
  return { snapshot, preview, changes }
}

describe("parseGitDiff hunk accounting", () => {
  test("counts added ++ and removed -- content lines the way git numstat does", async () => {
    const dir = initRepo()
    write(join(dir, "src/inc.ts"), "let counter = 0;\n")
    write(join(dir, "src/dec.ts"), "let counter = 0;\n--counter;\n--counter;\n")
    write(join(dir, "db/query.sql"), "-- header comment\nSELECT 1;\n")
    write(join(dir, "src/plain.ts"), "let counter = 0;\n")
    git(dir, ["add", "."])
    git(dir, ["commit", "-m", "init"])

    write(join(dir, "src/inc.ts"), "let counter = 0;\n++counter;\n+++counter;\n")
    write(join(dir, "src/dec.ts"), "let counter = 0;\n")
    write(join(dir, "db/query.sql"), "-- replaced comment\nSELECT 1;\n")
    write(join(dir, "src/plain.ts"), "let counter = 0;\ncounter += 1;\n")

    const { preview, changes } = await prepare(dir)
    const expected = numstat(dir)
    expect(expected).toHaveLength(4)
    for (const want of expected) {
      const entry = preview.entries.find((e) => e.path === want.path)!
      expect({ path: entry.path, insertions: entry.insertions, deletions: entry.deletions }).toEqual(want)
      const file = changes.files.find((f) => f.path === want.path)!
      expect(file.insertions).toBe(want.insertions)
      expect(file.deletions).toBe(want.deletions)
    }
    // File headers are still headers, not content.
    const inc = changes.files.find((f) => f.path === "src/inc.ts")!
    expect(inc.diff).toContain("--- a/src/inc.ts\n+++ b/src/inc.ts")
    expect(inc.diff).toContain("\n+++counter;\n++++counter;")
    expect(inc.status).toBe("modified")
  })

  test("a deleted file of -- lines keeps its removed content reviewable", async () => {
    const dir = initRepo()
    write(join(dir, "db/drop.sql"), "-- one\n-- two\n")
    git(dir, ["add", "."])
    git(dir, ["commit", "-m", "init"])
    rmSync(join(dir, "db/drop.sql"))

    const { preview } = await prepare(dir)
    const entry = preview.entries.find((e) => e.path === "db/drop.sql")!
    expect(entry).toMatchObject({ status: "deleted", insertions: 0, deletions: 2, willReview: true, excludeReason: "" })
  })

  test("801 added ++counter; lines carry the large-change signal like any 801 lines", async () => {
    const churn = async (line: string) => {
      const dir = initRepo()
      write(join(dir, "src/loop.ts"), "let counter = 0;\n")
      git(dir, ["add", "."])
      git(dir, ["commit", "-m", "init"])
      write(join(dir, "src/loop.ts"), `let counter = 0;\n${`${line}\n`.repeat(801)}`)
      return prepare(dir)
    }
    const prefixed = await churn("++counter;")
    const control = await churn("counter += 1;")
    expect(prefixed.changes.totalInsertions).toBe(801)
    expect(control.changes.totalInsertions).toBe(801)
  })

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
        "+Binary files a and b differ"
      ].join("\n")
    )
    expect(record).toMatchObject({
      oldPath: "f.txt",
      newPath: "f.txt",
      insertions: 2,
      deletions: 2,
      isNew: false,
      isDeleted: false,
      isBinary: false
    })
    expect(effectivePath(record!)).toBe("f.txt")
  })
})

describe("parseGitDiff file boundaries", () => {
  const load = (dir: string) => loadDiffs(dir, { ...normalizeOpenCodeReviewInput({}), repo: dir })
  const summary = (records: Awaited<ReturnType<typeof load>>) =>
    records
      .map((r) => ({ oldPath: r.oldPath, newPath: r.newPath, insertions: r.insertions, deletions: r.deletions }))
      .sort((a, b) => (a.newPath < b.newPath ? -1 : 1))
  const names = [
    "aaa-control.txt",
    "tab\tfile.txt",
    "new\nline.txt",
    "q\"uo\\te.txt",
    "x b/y.txt",
    "sp ace.txt",
    "café.txt"
  ]

  function repoWith(files: ReadonlyArray<string>) {
    const dir = initRepo()
    for (const name of files) write(join(dir, name), "before\n")
    git(dir, ["add", "."])
    git(dir, ["commit", "-m", "init"])
    for (const name of files) write(join(dir, name), "after\n")
    return dir
  }

  test("a quoted tracked name alone is its own record", async () => {
    for (const name of ["tab\tfile.txt", "new\nline.txt", "q\"uo\\te.txt"]) {
      const records = await load(repoWith([name]))
      expect(summary(records)).toEqual([{ oldPath: name, newPath: name, insertions: 1, deletions: 1 }])
      expect(records[0]!.diff).toContain("+after")
    }
  })

  test("every quoted, spaced or ambiguous name after an ordinary file keeps its own path, body and counts", async () => {
    const records = await load(repoWith(names))
    expect(summary(records)).toEqual(
      [...names]
        .sort((a, b) => (a < b ? -1 : 1))
        .map((name) => ({ oldPath: name, newPath: name, insertions: 1, deletions: 1 }))
    )
    for (const record of records) {
      expect(record.diff.match(/^diff --git /gm)).toHaveLength(1)
      expect(record.diff.match(/^\+after$/gm)).toHaveLength(1)
    }
  })

  test("a rename between a plain and a quoted name keeps both sides", async () => {
    const dir = initRepo()
    write(join(dir, "plain.txt"), "one\ntwo\nthree\nfour\n")
    git(dir, ["add", "."])
    git(dir, ["commit", "-m", "init"])
    git(dir, ["mv", "plain.txt", "moved\there.txt"])
    const records = await load(dir)
    expect(summary(records)).toEqual([{
      oldPath: "plain.txt",
      newPath: "moved\there.txt",
      insertions: 0,
      deletions: 0
    }])
  })

  test("octal escapes decode to UTF-8 and an unreadable header throws instead of joining the previous file", () => {
    const [record] = parseGitDiff(
      "diff --git \"a/caf\\303\\251.txt\" \"b/caf\\303\\251.txt\"\n--- \"a/caf\\303\\251.txt\""
    )
    expect(record!.newPath).toBe("café.txt")
    expect(() => parseGitDiff("diff --git a/ok.txt b/ok.txt\n@@ -1 +1 @@\n+x\ndiff --git c/odd d/odd\n+y")).toThrow(
      "Cannot read the file paths"
    )
    expect(() => parseGitDiff("diff --git \"a/unterminated b/x")).toThrow("Cannot read the file paths")
    expect(() => parseGitDiff("diff --git \"a/bad\\q\" \"b/bad\"")).toThrow("Cannot read the file paths")
  })
})

const loadDiffs = (...args: Parameters<typeof loadDiffsImpl>) => testIo(() => loadDiffsImpl(...args))

const loadReviewSnapshot = (...args: Parameters<typeof loadReviewSnapshotImpl>) =>
  testIo(() => loadReviewSnapshotImpl(...args))
