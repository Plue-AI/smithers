import * as FileSet from "@smthrs/plan/FileSet"
import * as Plan from "@smthrs/plan/Plan"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { describe, expect, it, vi } from "vitest"

import { compile, draft } from "../src/test/PlanFixtures.ts"
import { withCrypto } from "./Crypto.ts"

const glob: FileSet.Glob = { _tag: "Glob", include: ["src/**/*.ts"], exclude: ["src/**/skip.ts"] }
const tree: FileSet.TreeArtifact = { _tag: "TreeArtifact", path: "dist" }

describe("FileSet", () => {
  it("validates workspace-relative patterns", () => {
    expect(Schema.is(FileSet.Pattern)("src/**/*.ts")).toBe(true)
    expect(Schema.is(FileSet.Pattern)("/absolute/**")).toBe(false)
    expect(Schema.is(FileSet.Pattern)("src/../secret")).toBe(false)
  })

  it("constructs and expands named groups deterministically", () => {
    const group = FileSet.makeFilegroup("sources", ["a.ts", glob, tree])
    expect(FileSet.expand(["first", group])).toEqual(["first", "a.ts", glob, tree])
    expect(FileSet.expandReads(["first", { _tag: "Filegroup", name: "reads", entries: ["a.ts", glob] }]))
      .toEqual(["first", "a.ts", glob])
    expect(Schema.is(FileSet.Filegroup)(group)).toBe(true)
    expect(Schema.is(FileSet.ReadFilegroup)({ _tag: "Filegroup", name: "r", entries: [tree] })).toBe(false)
  })

  it("recognizes declarations without shape-sniffing strings", () => {
    expect(FileSet.isGlob(glob)).toBe(true)
    expect(FileSet.isGlob(tree)).toBe(false)
    expect(FileSet.isGlob(null)).toBe(false)
    expect(FileSet.isTreeArtifact(tree)).toBe(true)
    expect(FileSet.isTreeArtifact(glob)).toBe(false)
    expect(FileSet.isTreeArtifact("dist")).toBe(false)
  })

  it("implements segment-local star, recursive doublestar, and exclusions", () => {
    expect(FileSet.matchesPattern("src/*.ts", "src/a.ts")).toBe(true)
    expect(FileSet.matchesPattern("src/*.ts", "src/deep/a.ts")).toBe(false)
    expect(FileSet.matchesPattern("src/**/a.ts", "src/a.ts")).toBe(true)
    expect(FileSet.matchesPattern("src/**/a.ts", "src/deep/more/a.ts")).toBe(true)
    expect(FileSet.matchesPattern("src/**", "src/deep/a.ts")).toBe(true)
    expect(FileSet.matchesPattern("src\\*.ts", "src/a.ts")).toBe(true)
    expect(FileSet.matchesPattern("a+[x].ts", "a+[x].ts")).toBe(true)
    expect(FileSet.matchesGlob(glob, "src/a.ts")).toBe(true)
    expect(FileSet.matchesGlob(glob, "src/deep/skip.ts")).toBe(false)
    expect(FileSet.matchesGlob({ _tag: "Glob", include: ["*.ts"] }, "a.ts")).toBe(true)
  })

  it.each(
    [
      ["*ababac*", "ababababac", true],
      ["*aaaaab*", "aaaaac", false],
      ["ab*bc", "abc", false],
      ["a*b", "ac", false],
      ["a*b", "xb", false],
      ["*ab*ab*", "ab", false],
      ["*ab*ab*", "abab", true],
      ["a***b", "ab", true],
      ["***", "a/b", false],
      ["**/a/**/b", "x/a/no/a/y/b", true],
      ["**/a/**/b", "x/a/no/a/y/c", false],
      ["**/a", "/a", false],
      ["src/**", "src/", true],
      ["src/**", "src", false],
      ["**/**/a", "a", true],
      ["**/**", "", true],
      ["a", "a\u2028", false],
      ["a", "a\u2029", false],
      ["a*", "a\u2028", true]
    ] as const
  )("matches %j against %j as %j", (pattern, path, expected) => {
    expect(FileSet.matchesPattern(pattern, path)).toBe(expected)
  })

  it.each(["\u2028", "\u2029"])(
    "compiles and verifies overlapping Unicode writers containing %j",
    async (separator) => {
      const path = `src/a${separator}b.ts`
      const plan = await Effect.runPromise(withCrypto(compile([
        {
          ...draft("glob"),
          effects: { reads: [], writes: [{ _tag: "Glob", include: ["src/**"] }], boundaryMode: "hard" }
        },
        draft("exact", { writes: [path] })
      ])))
      expect(plan.nodes[1]!.dependsOn).toEqual(["glob"])
      expect(plan.nodes.every((node) => node.conflicts.length === 1)).toBe(true)
      expect(await Effect.runPromise(withCrypto(Plan.verify(JSON.parse(JSON.stringify(plan)))))).toEqual(plan)
    }
  )

  it("compiles and verifies an admitted adversarial glob and exact reader", async () => {
    const plan = await Effect.runPromise(withCrypto(compile([
      {
        ...draft("glob"),
        effects: { reads: [], writes: [{ _tag: "Glob", include: ["*a".repeat(24) + "b"] }], boundaryMode: "hard" }
      },
      draft("reader", { reads: ["a".repeat(47) + "c"] })
    ])))
    expect(plan.nodes[1]!.dependsOn).toEqual([])
    expect(await Effect.runPromise(withCrypto(Plan.verify(JSON.parse(JSON.stringify(plan)))))).toEqual(plan)
  })

  it("reuses compilation for canonical pattern aliases", () => {
    const pattern = "memoized-caf\u00e9/*.ts"
    const split = vi.spyOn(String.prototype, "split")
    try {
      expect(FileSet.matchesPattern(pattern, "memoized-caf\u00e9/a.ts")).toBe(true)
      expect(FileSet.matchesPattern(pattern.normalize("NFD").replace("/", "\\"), "memoized-caf\u00e9/b.ts"))
        .toBe(true)
      expect(FileSet.matchesPattern(pattern, "memoized-caf\u00e9/c.js")).toBe(false)
      const patternSplits = split.mock.contexts.filter((value, index) =>
        String(value) === pattern && String(split.mock.calls[index]![0]) === "/"
      )
      expect(patternSplits).toHaveLength(1)
    } finally {
      split.mockRestore()
    }
  })

  it("compares exact paths in canonical separator form", () => {
    // `workspaceRelative` accepts a backslash as a separator, so the two
    // spellings below name one workspace path and must overlap.
    expect(FileSet.canonical("dist\\same.js")).toBe("dist/same.js")
    expect(FileSet.overlaps("dist\\same.js", "dist/same.js")).toBe(true)
    expect(FileSet.overlaps("dist/same.js", "dist\\same.js")).toBe(true)
    expect(FileSet.overlaps("dist\\other.js", "dist/same.js")).toBe(false)
    expect(FileSet.overlaps({ _tag: "TreeArtifact", path: "dist\\nested" }, "dist/nested/a.js")).toBe(true)
    expect(FileSet.overlaps("dist\\same.js", { _tag: "Glob", include: ["dist/*.js"] })).toBe(true)
    expect(FileSet.overlaps({ _tag: "Glob", include: ["dist/*.js"] }, "dist\\same.js")).toBe(true)
    expect(FileSet.overlaps(
      { _tag: "TreeArtifact", path: "dist" },
      { _tag: "TreeArtifact", path: "dist\\nested" }
    )).toBe(true)
  })

  it("compares canonically equivalent Unicode spellings as one path", () => {
    const nfc = "caf\u00e9.txt"
    const nfd = nfc.normalize("NFD")
    const glob: FileSet.Glob = { _tag: "Glob", include: ["caf\u00e9.*"] }

    expect(FileSet.canonical(nfd)).toBe(nfc)
    expect(FileSet.overlaps(nfc, nfd)).toBe(true)
    expect(FileSet.overlaps(nfd, nfc)).toBe(true)
    expect(FileSet.overlaps(glob, nfd)).toBe(true)
    expect(FileSet.overlaps(nfd, glob)).toBe(true)
  })

  it("overlaps paths that differ only in letter case", () => {
    // A case-insensitive filesystem (default macOS APFS, Windows NTFS) opens
    // `src/A.ts` and `src/a.ts` as one file, so two writers must serialize.
    expect(FileSet.overlaps("src/A.ts", "src/a.ts")).toBe(true)
    expect(FileSet.overlaps("SRC\\a.ts", "src/A.ts")).toBe(true)
    expect(FileSet.overlaps("src/*.TS", "SRC/*.ts")).toBe(true)
    expect(FileSet.overlaps({ _tag: "TreeArtifact", path: "Dist" }, "dist/a.js")).toBe(true)
    expect(FileSet.overlaps("DIST/a.js", { _tag: "TreeArtifact", path: "dist" })).toBe(true)
    expect(FileSet.overlaps({ _tag: "TreeArtifact", path: "dist" }, { _tag: "TreeArtifact", path: "DIST/x" }))
      .toBe(true)
    expect(FileSet.overlaps("src/A.ts", { _tag: "Glob", include: ["src/*.ts"] })).toBe(true)
    expect(FileSet.overlaps("SRC/Deep/A.TS", glob)).toBe(true)
    // An exclusion folds too, so a case variant of an excluded path stays out.
    expect(FileSet.overlaps("src/deep/SKIP.ts", glob)).toBe(false)
    expect(FileSet.overlaps(glob, "Src/deep/skip.TS")).toBe(false)
    expect(FileSet.overlaps("\u03a3.txt", "\u03c2.txt")).toBe(true)
    expect(FileSet.overlaps("src/a.ts", "src/b.ts")).toBe(false)
    expect(FileSet.overlaps("src/a.ts", "lib/a.ts")).toBe(false)
  })

  it("uses the conservative overlap matrix", () => {
    const all: FileSet.Glob = { _tag: "Glob", include: ["**/*.ts"] }
    expect(FileSet.overlaps("a", "a")).toBe(true)
    expect(FileSet.overlaps("a", "b")).toBe(false)
    expect(FileSet.overlaps("src/a.ts", glob)).toBe(true)
    expect(FileSet.overlaps(glob, "src/a.ts")).toBe(true)
    expect(FileSet.overlaps(glob, all)).toBe(true)
    expect(FileSet.overlaps(tree, "dist/a.js")).toBe(true)
    expect(FileSet.overlaps("dist/a.js", tree)).toBe(true)
    expect(FileSet.overlaps(tree, { _tag: "TreeArtifact", path: "dist/nested" })).toBe(true)
    expect(FileSet.overlaps(tree, { _tag: "TreeArtifact", path: "other" })).toBe(false)
    expect(FileSet.overlaps(tree, glob)).toBe(true)
    expect(FileSet.overlaps(glob, tree)).toBe(true)
  })

  it("reads a plain string holding * as a literal path, as the execution boundary does", () => {
    // The sandbox, capture, removal, and replay all compare a string entry
    // literally (#2440), so static overlap must not widen it to a pattern.
    expect(FileSet.overlaps("src/*.ts", "src/a.ts")).toBe(false)
    expect(FileSet.overlaps("src/a.ts", "src/*.ts")).toBe(false)
    expect(FileSet.overlaps("**", "src/a.ts")).toBe(false)
    expect(FileSet.overlaps("src/*.ts", "lib/*.js")).toBe(false)
    expect(FileSet.overlaps({ _tag: "TreeArtifact", path: "src" }, "*")).toBe(false)
    expect(FileSet.overlaps("*", { _tag: "TreeArtifact", path: "src" })).toBe(false)
    // A file literally named with `*` is still one path in folded form.
    expect(FileSet.overlaps("src/*.ts", "SRC\\*.TS")).toBe(true)
    expect(FileSet.overlaps({ _tag: "TreeArtifact", path: "src" }, "src/*.ts")).toBe(true)
    // A Glob still matches such a literal path as text.
    expect(FileSet.overlaps("src/*.ts", { _tag: "Glob", include: ["src/*.ts"] })).toBe(true)
    expect(FileSet.overlaps({ _tag: "Glob", include: ["out/*.js"] }, "out/*.js")).toBe(true)
    expect(FileSet.overlaps("out/*.js", glob)).toBe(false)
  })
})

describe("FileSet.workspaceRelative", () => {
  it("admits ordinary relative paths and patterns", () => {
    for (const path of ["a.txt", "src/deep/b.ts", "src/**/*.ts", ".env", "a*b/c", "caf\u00e9.txt", "a\u0080b"]) {
      expect(FileSet.workspaceRelative(path)).toBe(true)
    }
  })

  it("refuses C0 controls and DEL", () => {
    for (const path of ["a\u0000b", "a\u001fb", "a\u007fb"]) {
      expect(FileSet.workspaceRelative(path)).toBe(false)
    }
  })

  it("refuses absolute, upward, and aliasing spellings", () => {
    // Aliasing forms matter as much as escapes: `./a.txt` and `a.txt` name
    // one file with two spellings, which defeats exact-string overlap.
    for (
      const path of [
        "/abs",
        "../up",
        "a/../b",
        "./a.txt",
        "a//b",
        "a/",
        "C:/win",
        "C:foo",
        "c:foo/bar",
        "Z:",
        "C:\\win"
      ]
    ) {
      expect(FileSet.workspaceRelative(path)).toBe(false)
    }
  })

  it("is the Pattern schema's own filter", () => {
    expect(Schema.decodeUnknownResult(FileSet.Pattern)("./aliased.txt")._tag).toBe("Failure")
    expect(Schema.decodeUnknownResult(FileSet.Entry)("../escape")._tag).toBe("Failure")
    expect(Schema.decodeUnknownResult(FileSet.ReadEntry)("/absolute")._tag).toBe("Failure")
    for (const path of ["a\u0000b", "a\u001fb", "a\u007fb"]) {
      expect(Schema.decodeUnknownResult(FileSet.Pattern)(path)._tag).toBe("Failure")
    }
    expect(Schema.decodeUnknownResult(FileSet.Entry)("src/ok.ts")._tag).toBe("Success")
  })
})
