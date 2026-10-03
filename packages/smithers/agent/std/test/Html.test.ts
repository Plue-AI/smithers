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

  it("looks past malformed closing-tag prefixes and accepts whitespace before the close", () => {
    const html = "<p>before</p><SCRIPT>hidden</scripted>still hidden</script \t>after"
    expect(toText(html)).toBe("before\nafter")
    expect(toMarkdown(html)).toBe("before\nafter")
  })

  it("drops an unclosed skipped element even when its closing marker ends at EOF", () => {
    for (const html of ["visible<script>hidden</script", "visible<style>hidden</style \t"]) {
      expect(toText(html)).toBe("visible")
      expect(toMarkdown(html)).toBe("visible")
    }
  })

  it("preserves invalid numeric entities and decodes Unicode boundary values", () => {
    const html = `<p>&#0; &#x10FFFF; &#xD800; &#xDFFF; &#1114112; &#${"9".repeat(400)};</p>`
    const expected = html.slice(3, -4).replace("&#0;", "\u0000").replace("&#x10FFFF;", "\u{10ffff}")
    expect(toText(html)).toBe(expected)
    expect(toMarkdown(html)).toBe(expected)
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
