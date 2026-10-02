import { describe, expect, test } from "bun:test";
import { renderProse } from "../src/walkthrough/renderProse.ts";

describe("renderProse", () => {
  test("renders paragraphs, inline code, bold, headings, lists, quotes", () => {
    const html = renderProse(
      [
        "### The plan",
        "",
        "First we call `makeWidget()` and it is **important**.",
        "",
        "- one",
        "- two",
        "",
        "> a warning",
      ].join("\n"),
    );
    expect(html).toContain("<h5>The plan</h5>");
    expect(html).toContain("<p>First we call <code>makeWidget()</code> and it is <strong>important</strong>.</p>");
    expect(html).toContain("<ul><li>one</li><li>two</li></ul>");
    expect(html).toContain("<blockquote>a warning</blockquote>");
  });

  test("renders fenced code and escapes everything first", () => {
    const html = renderProse(["```", "const a = `<b>` < 1;", "```", "", "<script>alert(1)</script>"].join("\n"));
    expect(html).toContain('<pre class="prose-code"><code>const a = `&lt;b&gt;` &lt; 1;</code></pre>');
    expect(html).toContain("<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>");
    expect(html).not.toContain("<script>alert");
  });

  test("closes an unterminated fence", () => {
    const html = renderProse("```\ndangling");
    expect(html).toContain("<code>dangling</code>");
  });
});
