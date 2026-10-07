import { describe, expect, test } from "vitest"
import { CardSchema } from "../src/Cards.ts"
import { docsCard, type DocsPage, parseDocsArgs, readDocsPage, unknownDocsPage } from "../src/DocsPages.ts"

// Literal pages in table-of-contents order.
const PAGES: ReadonlyArray<DocsPage> = [
  {
    slug: "quickstart",
    title: "Quickstart",
    summary: "Install and run.",
    markdown: "# Quickstart\n\n## Put HTTPS in front\n"
  },
  { slug: "flows", title: "Flows reference", summary: "Every flow.", markdown: "# Flows reference\n" }
]
const TOC = [{ slug: "quickstart", title: "Quickstart" }, { slug: "flows", title: "Flows reference" }]
const USAGE = "docs takes a page, or {\"mode\":\"read\",\"page\":\"<page>\"} to read one."

describe("parseDocsArgs", () => {
  test("plain text names the page to embed; JSON carries the declared payload only", () => {
    expect(parseDocsArgs(undefined)).toEqual({ payload: {} })
    expect(parseDocsArgs("  ")).toEqual({ payload: {} })
    expect(parseDocsArgs(" quickstart#put-https-in-front ")).toEqual({
      payload: { page: "quickstart#put-https-in-front" }
    })
    expect(parseDocsArgs("{\"mode\":\"read\",\"page\":\"flows\"}")).toEqual({
      payload: { mode: "read", page: "flows" }
    })
    expect(parseDocsArgs("{}")).toEqual({ payload: {} })
    for (
      const refused of ["{\"mode\":\"write\"}", "{\"page\":1}", "{\"page\":\"a\",\"extra\":true}", "{\"mode\":", "{]"]
    ) {
      expect(parseDocsArgs(refused)).toEqual({ error: USAGE })
    }
  })
})

describe("readDocsPage", () => {
  test("a page reads as its title, summary and Markdown verbatim", () => {
    expect(readDocsPage(PAGES, " flows ")).toEqual({
      value: JSON.stringify({ title: "Flows reference", summary: "Every flow.", markdown: "# Flows reference\n" })
    })
  })

  test("no page and an unknown page are refusals naming every page", () => {
    expect(readDocsPage(PAGES, "")).toEqual({ error: "Name a docs page to read. Pages: quickstart, flows." })
    expect(readDocsPage(PAGES, "nowhere")).toEqual({ error: unknownDocsPage(PAGES, "nowhere") })
    expect(unknownDocsPage(PAGES, "nowhere")).toBe("There is no docs page named nowhere. Pages: quickstart, flows.")
  })
})

describe("docsCard", () => {
  test("embeds the named page with its anchor and the table of contents, as a valid card", () => {
    const { card, value } = docsCard(PAGES, "flows#find", 4, 10)
    expect(card).toEqual({
      id: "docs-flows",
      kind: "docs",
      title: "Flows reference",
      status: "active",
      createdAt: 10,
      ordinal: 4,
      payload: { page: "flows", markdown: "# Flows reference\n", summary: "Every flow.", toc: TOC, anchor: "find" }
    })
    expect(CardSchema.parse(card)).toEqual(card)
    expect(value).toBe("Embedded the Flows reference docs page.")
  })

  test("no page opens the first; a bare anchor stays on it; an unknown page falls back without its anchor", () => {
    expect(docsCard(PAGES, undefined, 0, 1).card.payload).toEqual({
      page: "quickstart",
      markdown: PAGES[0]!.markdown,
      summary: "Install and run.",
      toc: TOC
    })
    expect(docsCard(PAGES, "#put-https-in-front", 0, 1).card.payload).toMatchObject({
      page: "quickstart",
      anchor: "put-https-in-front"
    })
    const missing = docsCard(PAGES, "nowhere#heading", 0, 1)
    expect(missing.card.payload).toEqual({
      page: "quickstart",
      markdown: PAGES[0]!.markdown,
      summary: "Install and run.",
      toc: TOC,
      not_found: "nowhere"
    })
    expect(missing.value).toBe("Embedded the Quickstart docs page.")
  })

  test("docs with no pages cannot embed one", () => {
    expect(() => docsCard([], undefined, 0, 1)).toThrow("The docs have no pages.")
  })
})
