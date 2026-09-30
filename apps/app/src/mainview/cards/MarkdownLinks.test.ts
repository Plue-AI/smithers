import { describe, expect, test } from "bun:test"
import { headingLine, resolveMarkdownLink } from "./MarkdownLinks"

describe("resolveMarkdownLink", () => {
  test("a relative link resolves from the document's own directory", () => {
    expect(resolveMarkdownLink("README.md", "LICENSE")).toEqual({ kind: "file", path: "LICENSE" })
    expect(resolveMarkdownLink("docs/guide/intro.md", "setup.md#install")).toEqual({ kind: "file", path: "docs/guide/setup.md", fragment: "install" })
    expect(resolveMarkdownLink("docs/guide/intro.md", "./../api/%20x.md?plain=1")).toEqual({ kind: "file", path: "docs/api/ x.md" })
    expect(resolveMarkdownLink("docs/guide/intro.md", "/LICENSE")).toEqual({ kind: "file", path: "LICENSE" })
  })

  test("a trailing slash or a dot names a directory", () => {
    expect(resolveMarkdownLink("docs/intro.md", "api/")).toEqual({ kind: "directory", path: "docs/api" })
    expect(resolveMarkdownLink("docs/intro.md", "..")).toEqual({ kind: "directory", path: "" })
    expect(resolveMarkdownLink("docs/intro.md", ".")).toEqual({ kind: "directory", path: "docs" })
  })

  test("a same-document link keeps its fragment", () => {
    expect(resolveMarkdownLink("README.md", "#getting-started")).toEqual({ kind: "fragment", fragment: "getting-started" })
    expect(resolveMarkdownLink("docs/README.md", "README.md#usage")).toEqual({ kind: "file", path: "docs/README.md", fragment: "usage" })
  })

  test("absolute web and mail links stay the browser's", () => {
    for (const href of ["https://example.com/x", "HTTP://example.com", "mailto:a@b.c", "//cdn.example.com/x"]) {
      expect(resolveMarkdownLink("README.md", href)).toEqual({ kind: "external" })
    }
  })

  test("other schemes, escapes above the root and malformed paths go nowhere", () => {
    for (const href of ["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "vbscript:x", "../LICENSE", "a/../../b", "%E0%A4%A", "a%00b", "a\\b", ""]) {
      expect(resolveMarkdownLink("README.md", href)).toEqual({ kind: "blocked" })
    }
  })
})

describe("headingLine", () => {
  const doc = ["# Title", "", "## Getting Started!", "```", "# not a heading", "```", "## Usage", "## Usage"].join("\n")
  test("finds a heading by its GitHub anchor, duplicates suffixed", () => {
    expect(headingLine(doc, "title")).toBe(1)
    expect(headingLine(doc, "getting-started")).toBe(3)
    expect(headingLine(doc, "usage")).toBe(7)
    expect(headingLine(doc, "usage-1")).toBe(8)
    expect(headingLine(doc, "not-a-heading")).toBeUndefined()
  })
})
