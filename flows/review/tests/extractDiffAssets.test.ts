import { describe, expect, test } from "bun:test";
import { extractDiffAssets } from "../src/diffs/extractDiffAssets.ts";
import { renderPierreFileDiff } from "../src/diffs/renderPierreFileDiff.ts";

function makePatch(name: string, oldLine: string, newLine: string): string {
  return [
    `diff --git a/${name} b/${name}`,
    `--- a/${name}`,
    `+++ b/${name}`,
    "@@ -1 +1 @@",
    `-${oldLine}`,
    `+${newLine}`,
  ].join("\n");
}

describe("extractDiffAssets", () => {
  test("rescopes :host to .pierre-diff in every style asset", async () => {
    const html = await renderPierreFileDiff({ diff: makePatch("a.ts", "const a = 1;", "const a = 2;") });
    expect(html).toContain(":host");
    const assets = extractDiffAssets(html);
    expect(assets.styles.length).toBeGreaterThanOrEqual(2);
    for (const style of assets.styles) {
      expect(style).not.toContain(":host");
      expect(style.startsWith("<style")).toBe(true);
      expect(style.endsWith("</style>")).toBe(true);
    }
    expect(assets.styles.join("")).toContain(".pierre-diff");
  });

  test("drops the sprite when the body has no <use> reference", async () => {
    const html = await renderPierreFileDiff({ diff: makePatch("a.ts", "const a = 1;", "const a = 2;") });
    expect(html.startsWith("<svg")).toBe(true);
    const assets = extractDiffAssets(html);
    expect(assets.body).not.toContain("<use");
    expect(assets.sprite).toBe("");
  });

  test("keeps the sprite when the body references it", () => {
    const input =
      '<svg id="sprite"><symbol id="icon"/></svg><style>:host { color: red }</style><div><use href="#icon"></use></div>';
    const assets = extractDiffAssets(input);
    expect(assets.sprite).toBe('<svg id="sprite"><symbol id="icon"/></svg>');
    expect(assets.styles).toEqual(["<style>.pierre-diff { color: red }</style>"]);
    expect(assets.body).toBe('<div><use href="#icon"></use></div>');
  });

  test("style assets are byte-identical across diffs so pages can dedupe", async () => {
    const a = extractDiffAssets(
      await renderPierreFileDiff({ diff: makePatch("a.ts", "const a = 1;", "const a = 2;") }),
    );
    const b = extractDiffAssets(await renderPierreFileDiff({ diff: makePatch("b.py", "x = 1", "x = 2") }));
    expect(a.styles).toEqual(b.styles);
  });

  test("never rewrites the body, even when the diffed code is :host CSS", async () => {
    const html = await renderPierreFileDiff({
      diff: makePatch("theme.css", ":host { color: red; }", ":host { color: blue; }"),
    });
    const assets = extractDiffAssets(html);
    // body is returned byte-for-byte from the source HTML
    expect(html.endsWith(assets.body)).toBe(true);
    expect(assets.body).not.toContain("pierre-diff");
    for (const style of assets.styles) expect(style).not.toContain(":host");
  });

  test("literal :host text in the body is not touched", () => {
    const input = "<style>:host { color: red }</style><div><code>:host { display: none }</code></div>";
    const assets = extractDiffAssets(input);
    expect(assets.styles).toEqual(["<style>.pierre-diff { color: red }</style>"]);
    expect(assets.body).toBe("<div><code>:host { display: none }</code></div>");
  });

  test("input without styles passes through as body", () => {
    const assets = extractDiffAssets("<div>plain</div>");
    expect(assets).toEqual({ sprite: "", styles: [], body: "<div>plain</div>" });
  });

  test("reassembling scoped assets reproduces the source modulo the :host rescope", async () => {
    const html = await renderPierreFileDiff({ diff: makePatch("a.ts", "const a = 1;", "const a = 2;") });
    const assets = extractDiffAssets(html);
    const firstStyle = html.indexOf("<style");
    const originalSprite = html.slice(0, firstStyle);
    const reassembled = originalSprite + assets.styles.join("").replaceAll(".pierre-diff", ":host") + assets.body;
    expect(reassembled).toBe(html);
  });
});
