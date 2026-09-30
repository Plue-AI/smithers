import { performance } from "node:perf_hooks"
import { describe, expect, it } from "vitest"
import { toMarkdown, toText } from "../src/internal/Html.ts"

describe("Html", () => {
  it("drops non-content elements and comments before decoding entities", () => {
    const html = [
      "<HEAD><title>Hidden</title></HEAD>",
      "<script>danger()</script><style>.secret {}</style>",
      "<!-- hidden -->",
      "<p>Visible &amp; &#x1F600; &#39;quoted&#39;</p>"
    ].join("")
    expect(toText(html)).toBe("Visible & 😀 'quoted'")
  })

  it("preserves unknown and inherited-property entities in text and Markdown", () => {
    const html = "<p>ordinary &amp; &unknown; &constructor; &toString; &__proto__; &AMP;</p>"
    const expected = "ordinary & &unknown; &constructor; &toString; &__proto__; &"
    expect(toText(html)).toBe(expected)
    expect(toMarkdown(html)).toBe(expected)
  })

  it("renders headings, emphasis, links, and list items in Markdown", () => {
    const markdown = toMarkdown(
      "<h2>Guide</h2><p><a href=\"https://example.test\">Read &amp; learn</a> <strong>today</strong></p>" +
        "<ul><li>First</li><li><em>Second</em></li></ul>"
    )
    expect(markdown).toContain("## Guide")
    expect(markdown).toContain("[Read & learn](https://example.test) **today**")
    expect(markdown).toContain("- First")
    expect(markdown).toContain("- *Second*")
  })

  it("renders many unclosed skipped elements within a bounded time", { timeout: 45_000 }, () => {
    const html = `${"<script>".repeat(20_000)}${"x".repeat(2_000_000)}`
    const started = performance.now()
    const output = toText(html)
    const elapsed = performance.now() - started

    expect(typeof output).toBe("string")
    expect(elapsed).toBeLessThan(2_000)
  })
})
