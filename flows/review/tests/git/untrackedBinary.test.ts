import { describe, expect, test } from "bun:test"
import { chmodSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { loadReviewSnapshot as loadReviewSnapshotImpl } from "../../src/review/loadReviewSnapshot.ts"
import { nativeReviewPromptFromSnapshot } from "../../src/review/nativeReviewPromptFromSnapshot.ts"
import { previewFromSnapshot } from "../../src/review/previewFromSnapshot.ts"
import { changesFromDiffs } from "../../src/walkthrough/changesFromDiffs.ts"
import { normalizeOpenCodeReviewInput } from "../../src/workflow/normalizeOpenCodeReviewInput.ts"
import { testIo } from "../io.ts"
import { tempRepos } from "../support/tempRepos.ts"

const { git, write, initRepo } = tempRepos()
const BINARY = Buffer.from([0x4d, 0x5a, 0x00, 0x01, 0x02, 0x03])

describe("untracked binaries", () => {
  test("are excluded from preview, prompts and coverage exactly like tracked ones", async () => {
    const dir = initRepo()
    writeFileSync(join(dir, "trackedprogram"), Buffer.from("MZ"))
    git(dir, ["add", "."])
    git(dir, ["commit", "-m", "init"])
    writeFileSync(join(dir, "trackedprogram"), BINARY)
    writeFileSync(join(dir, "newprogram"), BINARY)
    chmodSync(join(dir, "newprogram"), 0o755)
    // A NUL past git's 8000-byte sniff window is still text to git.
    writeFileSync(join(dir, "late-nul.ts"), Buffer.concat([Buffer.from(`${"x".repeat(8000)}\n`), Buffer.from([0]!)]))
    write(join(dir, "newscript"), "#!/bin/sh\necho hi\n")

    const snapshot = await loadReviewSnapshot(normalizeOpenCodeReviewInput({ repo: dir }))
    const preview = previewFromSnapshot(snapshot)
    const entry = (path: string) => preview.entries.find((e) => e.path === path)
    for (const path of ["trackedprogram", "newprogram"]) {
      expect(entry(path)).toMatchObject({ status: "binary", willReview: false, excludeReason: "binary" })
    }
    expect(entry("newscript")).toMatchObject({ status: "added", willReview: true, excludeReason: "" })
    expect(entry("late-nul.ts")).toMatchObject({ status: "added", willReview: true })
    const newprogram = snapshot.diffs.find((d) => d.newPath === "newprogram")!
    expect(newprogram.diff).toBe(
      "diff --git a/newprogram b/newprogram\nnew file mode 100755\nBinary files /dev/null and b/newprogram differ"
    )
    expect(newprogram).toMatchObject({ isNew: true, isBinary: true, insertions: 0, deletions: 0 })

    const prompt = nativeReviewPromptFromSnapshot(snapshot, preview)
    expect(prompt.files.map((file) => file.path).sort()).toEqual(["late-nul.ts", "newscript"])
    for (const file of prompt.files) expect(file.prompt).not.toContain("MZ\u0000")

    const changes = changesFromDiffs(snapshot.diffs, preview)
    for (const path of ["trackedprogram", "newprogram"]) {
      expect(changes.files.find((f) => f.path === path)).toMatchObject({
        status: "binary",
        diff: "",
        reviewed: false,
        excludeReason: "binary"
      })
    }
    expect(changes.files.find((f) => f.path === "newscript")).toMatchObject({ status: "added", reviewed: true })
  })
})

const loadReviewSnapshot = (...args: Parameters<typeof loadReviewSnapshotImpl>) =>
  testIo(() => loadReviewSnapshotImpl(...args))
