import { describe, expect, it } from "@effect/vitest"
import { quoteGitPatchPaths } from "../src/internal/gitPatchPaths.ts"
import { JjInternalFault } from "../src/internal/JjInternalFault.ts"

const paths = (...names: ReadonlyArray<string>): string => names.map((name) => JSON.stringify(name)).join("\n") + "\n"

describe("quoteGitPatchPaths", () => {
  it("accepts an empty diff without path metadata", () => {
    expect(quoteGitPatchPaths("", "")).toBe("")
  })

  it("quotes raw paths and leaves already quoted paths unchanged", () => {
    const metadata = paths("space name", "tab\tname")
    const expected =
      "diff --git \"a/space name\" \"b/tab\\tname\"\n--- \"a/space name\"\n+++ \"b/tab\\tname\"\n@@ -1 +1 @@\n-old\n+new\n"
    const raw = "diff --git a/space name b/tab\tname\n--- a/space name\n+++ b/tab\tname\n@@ -1 +1 @@\n-old\n+new\n"
    expect(quoteGitPatchPaths(raw, metadata)).toBe(expected)
    expect(quoteGitPatchPaths(expected, metadata)).toBe(expected)
  })

  it("uses Git octal escapes for control bytes", () => {
    const name = "control\u0001\u001f\u007fname"
    const raw = `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n`
    const quoted = "\"a/control\\001\\037\\177name\""
    expect(quoteGitPatchPaths(raw, paths(name, name))).toBe(
      `diff --git ${quoted} "b/control\\001\\037\\177name"\n--- ${quoted}\n+++ "b/control\\001\\037\\177name"\n`
    )
  })

  it("normalizes rename, copy, and mode-only headers", () => {
    const header =
      "diff --git a/old name b/new name\nold mode 100644\nnew mode 100755\nrename from old name\nrename to new name\n"
    expect(quoteGitPatchPaths(header, paths("old name", "new name"))).toBe(
      "diff --git \"a/old name\" \"b/new name\"\nold mode 100644\nnew mode 100755\nrename from \"old name\"\nrename to \"new name\"\n"
    )
    const copy = "diff --git a/source name b/copy name\ncopy from source name\ncopy to copy name\n"
    expect(quoteGitPatchPaths(copy, paths("source name", "copy name"))).toBe(
      "diff --git \"a/source name\" \"b/copy name\"\ncopy from \"source name\"\ncopy to \"copy name\"\n"
    )
    const mode = "diff --git a/mode name b/mode name\nold mode 100644\nnew mode 100755\n"
    expect(quoteGitPatchPaths(mode, paths("mode name", "mode name"))).toBe(
      "diff --git \"a/mode name\" \"b/mode name\"\nold mode 100644\nnew mode 100755\n"
    )
  })

  it("normalizes added, deleted, and binary headers", () => {
    const addition =
      "diff --git a/new name b/new name\nnew file mode 100644\nindex 0000000..123abcd\n--- /dev/null\n+++ b/new name\n"
    expect(quoteGitPatchPaths(addition, paths("new name", "new name"))).toBe(
      "diff --git \"a/new name\" \"b/new name\"\nnew file mode 100644\nindex 0000000..123abcd\n--- /dev/null\n+++ \"b/new name\"\n"
    )
    const deletion = "diff --git a/old name b/old name\ndeleted file mode 100644\n--- a/old name\n+++ /dev/null\n"
    expect(quoteGitPatchPaths(deletion, paths("old name", "old name"))).toBe(
      "diff --git \"a/old name\" \"b/old name\"\ndeleted file mode 100644\n--- \"a/old name\"\n+++ /dev/null\n"
    )
    const binary = "diff --git a/image name b/image name\nBinary files /dev/null and b/image name differ\n"
    expect(quoteGitPatchPaths(binary, paths("image name", "image name"))).toBe(
      "diff --git \"a/image name\" \"b/image name\"\nBinary files /dev/null and \"b/image name\" differ\n"
    )
    const removedBinary = "diff --git a/image name b/image name\nBinary files a/image name and /dev/null differ\n"
    expect(quoteGitPatchPaths(removedBinary, paths("image name", "image name"))).toBe(
      "diff --git \"a/image name\" \"b/image name\"\nBinary files \"a/image name\" and /dev/null differ\n"
    )
  })

  it("rejects malformed path metadata and mismatched headers with a tagged fault and its code", () => {
    const fault = (patch: string, metadata: string) => {
      try {
        quoteGitPatchPaths(patch, metadata)
      } catch (error) {
        return error
      }
      throw new Error("expected a throw")
    }
    const cases = [
      ["", "\"only one\"\n", "patch_path_metadata_incomplete", "Incomplete jj diff path metadata"],
      ["", "42\n42\n", "patch_path_metadata_invalid", "Invalid jj diff path metadata"],
      ["", paths("missing", "missing"), "patch_headers_disagree", "jj diff headers disagree"],
      [
        "diff --git a/other b/other\n",
        paths("expected", "expected"),
        "patch_headers_disagree",
        "jj diff headers disagree"
      ],
      [
        "diff --git a/one b/one\nextra\n",
        paths("one", "one", "two", "two"),
        "patch_headers_disagree",
        "jj diff headers disagree"
      ],
      ["diff --git a/one b/one\n", "", "patch_output_unexpected", "Unexpected jj diff output"]
    ] as const
    for (const [patch, metadata, code, message] of cases) {
      const error = fault(patch, metadata)
      expect(error).toBeInstanceOf(JjInternalFault)
      expect(error).toMatchObject({ _tag: "@smthrs/jj/JjInternalFault", code })
      expect((error as JjInternalFault).message).toContain(message)
    }
    // Metadata that is not JSON is the parser's own failure, not a fault of this module.
    expect(() => quoteGitPatchPaths("", "not json\n")).toThrow()
  })

  it("preserves hunk lines that resemble patch headers", () => {
    const hunk =
      "@@ -1,3 +1,3 @@\n-diff --git a/forged b/forged\n+--- a/forged\n++++ b/forged\n context\n\\ No newline at end of file\n"
    const patch = `diff --git a/one b/one\n--- a/one\n+++ b/one\n${hunk}diff --git a/two b/two\n--- a/two\n+++ b/two\n`
    expect(quoteGitPatchPaths(patch, paths("one", "one", "two", "two"))).toBe(patch)
  })
})
