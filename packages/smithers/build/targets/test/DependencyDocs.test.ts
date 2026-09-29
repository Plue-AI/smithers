/**
 * `S.Docs.Package` / `S.Docs.Url` and the workspace `docs` record they are
 * declared under: every source is pinned, and a malformed one is refused
 * where the declaration is evaluated.
 */
import { describe, expect, it } from "vitest"
import * as DependencyDocs from "../src/DependencyDocs.ts"
import * as Input from "../src/Input.ts"
import * as RustToolchain from "../src/RustToolchain.ts"
import * as Smithers from "../src/Smithers.ts"
import * as WorkspaceDeclaration from "../src/WorkspaceDeclaration.ts"

const options = {
  repository: "git+https://example.invalid/workspace.git",
  cache: WorkspaceDeclaration.Cache({ directory: ".flows" }),
  toolchains: [RustToolchain.Toolchain({ workspace: Input.file("//Cargo.toml"), channel: "1.91" })]
}
const digest = "a".repeat(64)

describe("S.Docs.Package", () => {
  it("defaults to README.md, deduplicates files, and freezes the declaration", () => {
    const plain = Smithers.Docs.Package("effect")
    expect(plain).toEqual({ _tag: "DocsPackage", package: "effect", files: ["README.md"] })
    expect(Object.isFrozen(plain) && Object.isFrozen(plain.files)).toBe(true)
    expect(Smithers.Docs.Package("@effect/platform", { files: ["README.md", "docs/a.mdx", "README.md"] }).files)
      .toEqual(["README.md", "docs/a.mdx"])
  })

  it("accepts a legacy uppercase package name and dotted file names", () => {
    expect(Smithers.Docs.Package("JSONStream").package).toBe("JSONStream")
    expect(Smithers.Docs.Package("@Scope/Lib~x", { files: ["docs/..a.md", "a../b.md"] }).files)
      .toEqual(["docs/..a.md", "a../b.md"])
  })

  it.each([
    ["an empty name", () => DependencyDocs.Package("")],
    ["a name with a path", () => DependencyDocs.Package("../evil")],
    ["a scope without a name", () => DependencyDocs.Package("@scope/")],
    ["a name with a backslash", () => DependencyDocs.Package("a\\b")],
    ["no files", () => DependencyDocs.Package("effect", { files: [] })],
    ["a file outside the package", () => DependencyDocs.Package("effect", { files: ["../x.md"] })],
    ["a nested escape", () => DependencyDocs.Package("effect", { files: ["docs/../../x.md"] })],
    ["a backslash escape", () => DependencyDocs.Package("effect", { files: ["docs\\..\\..\\x.md"] })],
    ["an escape after a line feed", () => DependencyDocs.Package("effect", { files: ["a\n/../../../etc/x.md"] })],
    ["an escape after a carriage return", () => DependencyDocs.Package("effect", { files: ["a\r/../../../etc/x.md"] })],
    ["a NUL byte", () => DependencyDocs.Package("effect", { files: ["a\0.md"] })],
    ["a control character", () => DependencyDocs.Package("effect", { files: ["a\u001b.md"] })],
    ["an absolute file", () => DependencyDocs.Package("effect", { files: ["/etc/x.md"] })],
    ["a backslash-rooted file", () => DependencyDocs.Package("effect", { files: ["\\etc\\x.md"] })],
    ["a drive-rooted file", () => DependencyDocs.Package("effect", { files: ["C:x.md"] })],
    ["a non-string file", () => DependencyDocs.Package("effect", { files: [1 as never] })],
    ["a non-Markdown file", () => DependencyDocs.Package("effect", { files: ["index.js"] })]
  ])("refuses %s", (_, declare) => {
    expect(declare).toThrow(TypeError)
  })
})

describe("S.Docs.Url", () => {
  it("pins an https document by its sha256", () => {
    expect(Smithers.Docs.Url("https://example.com/guide.md", { sha256: digest })).toEqual({
      _tag: "DocsUrl",
      url: "https://example.com/guide.md",
      sha256: digest
    })
  })

  it.each([
    ["plain http", () => DependencyDocs.Url("http://example.com/a.md", { sha256: digest })],
    ["no digest", () => DependencyDocs.Url("https://example.com/a.md", {} as never)],
    ["an uppercase digest", () => DependencyDocs.Url("https://example.com/a.md", { sha256: "A".repeat(64) })],
    ["a short digest", () => DependencyDocs.Url("https://example.com/a.md", { sha256: "a".repeat(63) })]
  ])("refuses %s", (_, declare) => {
    expect(declare).toThrow(TypeError)
  })

  it("recognizes only its own declarations", () => {
    expect(DependencyDocs.isDeclaration(DependencyDocs.Url("https://e.com/a.md", { sha256: digest }))).toBe(true)
    expect(DependencyDocs.isDeclaration(DependencyDocs.Package("effect"))).toBe(true)
    expect(DependencyDocs.isDeclaration({ _tag: "Other" })).toBe(false)
    expect(DependencyDocs.isDeclaration(null)).toBe(false)
    // A look-alike carrying the tag, or a copy of a real declaration, skips the constructor's rules.
    expect(DependencyDocs.isDeclaration({ _tag: "DocsPackage", package: "../..", files: ["etc/passwd.md"] })).toBe(
      false
    )
    expect(DependencyDocs.isDeclaration({ _tag: "DocsUrl", url: "http://e.com/a.md" })).toBe(false)
    expect(DependencyDocs.isDeclaration({ ...DependencyDocs.Package("effect") })).toBe(false)
  })
})

describe("Workspace docs", () => {
  it("keeps the declared record and leaves it undefined when absent", () => {
    const docs = { effect: Smithers.Docs.Package("effect") }
    expect(WorkspaceDeclaration.Workspace("w", { ...options, docs }).docs).toEqual(docs)
    expect(WorkspaceDeclaration.Workspace("w", options).docs).toBeUndefined()
  })

  it.each([
    ["a non-object", "docs" as never],
    ["a non-portable name", { "bad name": Smithers.Docs.Package("effect") }],
    ["a value that is not S.Docs", { effect: { package: "effect" } } as never],
    ["a forged package declaration", {
      x: { _tag: "DocsPackage", package: "../..", files: ["etc/passwd.md"] }
    } as never],
    ["a forged URL declaration without a digest", { x: { _tag: "DocsUrl", url: "http://e.com/a.md" } } as never],
    ["names equal when lowercased", {
      Effect: Smithers.Docs.Package("effect"),
      effect: Smithers.Docs.Package("effect")
    }]
  ])("refuses %s", (_, docs) => {
    expect(() => WorkspaceDeclaration.Workspace("w", { ...options, docs })).toThrow(
      "Workspace docs must be a portable-name-to-S.Docs record"
    )
  })
})
