import { standaloneThemeCss } from "@smthrs/ui-styleguide"
import { describe, expect, test } from "bun:test"
import type { ChangedFile } from "../src/walkthrough/changedFileSchema.ts"
import { renderWalkthroughHtml } from "../src/walkthrough/renderWalkthroughHtml.ts"

type RenderWalkthroughInput = Parameters<typeof renderWalkthroughHtml>[0]

function patchFor(path: string, removed: string, added: string[]): string {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,2 +1,${1 + added.length} @@`,
    " const keep = 1;",
    `-${removed}`,
    ...added.map((line) => `+${line}`)
  ].join("\n")
}

const files: ChangedFile[] = [
  {
    path: "src/a.ts",
    status: "modified",
    insertions: 2,
    deletions: 1,
    diff: patchFor("src/a.ts", "const removed = 2;", ["const added = 2;", "const more = 3;"]),
    reviewed: true,
    excludeReason: ""
  },
  {
    path: "src/b.ts",
    status: "modified",
    insertions: 1,
    deletions: 1,
    diff: patchFor("src/b.ts", "const old = 1;", ["const fresh = 1;"]),
    reviewed: true,
    excludeReason: ""
  },
  {
    path: "assets/logo.png",
    status: "binary",
    insertions: 0,
    deletions: 0,
    diff: "",
    reviewed: false,
    excludeReason: "binary"
  }
]

function block(partial: Record<string, string>) {
  return { kind: "prose", text: "", path: "", intro: "", title: "", mermaid: "", ...partial }
}

const story = {
  headline: "Replaces removed with added <script>",
  synopsis: "A tiny arc.",
  chapters: [
    {
      title: "The change & its core",
      blocks: [
        block({ kind: "prose", text: "Read me first: we swap `removed` for **added**." }),
        block({
          kind: "diff",
          path: "src/a.ts",
          intro: "Swaps removed for added & adds more; check the constant values."
        }),
        block({ kind: "prose", text: "Having read that, the supporting tweak follows." }),
        block({ kind: "diff", path: "src/b.ts" }),
        block({ kind: "diagram", title: "The flow", mermaid: "graph TD; A-->B" })
      ]
    },
    { title: "Assets", blocks: [block({ kind: "diff", path: "assets/logo.png", intro: "binary asset" })] }
  ]
}

const comments: RenderWalkthroughInput["comments"] = [
  {
    path: "src/a.ts",
    content: "Possible bug: <b>unescaped</b> & dangerous",
    suggestionCode: "const added = safe();",
    existingCode: "const added = 2;",
    startLine: 2,
    endLine: 2,
    thinking: "",
    severity: "major",
    category: "correctness",
    confidence: "plausible"
  }
]

function render() {
  return renderWalkthroughHtml({
    title: "",
    story,
    files,
    comments,
    repoDir: "/tmp/repo",
    mode: "workspace",
    ref: "workspace",
    generatedAt: "2026-06-10T00:00:00.000Z"
  })
}

describe("renderWalkthroughHtml", () => {
  test("embeds the shared standalone theme tokens", async () => {
    const html = await render()
    expect(html).toContain(standaloneThemeCss())
  })

  test("forces Pierre diffs to follow the root data-theme override", async () => {
    const html = await render()
    const pierreTheme = html.indexOf("data-theme-css=\"\"")
    const bridge = html.lastIndexOf(":root[data-theme=\"dark\"] .pierre-diff { color-scheme: dark; }")

    expect(pierreTheme).toBeGreaterThan(-1)
    expect(html.indexOf("color-scheme: light;", pierreTheme)).toBeGreaterThan(pierreTheme)
    expect(bridge).toBeGreaterThan(pierreTheme)
    expect(html).toContain(
      "@media (prefers-color-scheme: dark) { :root:not([data-theme=\"light\"]) .pierre-diff { color-scheme: dark; } }"
    )
  })

  test("keeps standalone code rules from outranking Pierre's layered cascade", async () => {
    const html = await render()
    const standaloneCss = standaloneThemeCss()
    const standaloneIndex = html.indexOf(standaloneCss)
    const pierreBaseIndex = html.indexOf("@layer base", standaloneIndex + standaloneCss.length)
    expect(standaloneIndex).toBeGreaterThan(-1)
    expect(pierreBaseIndex).toBeGreaterThan(standaloneIndex)

    const codeRules = [...standaloneCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(([, selector]) =>
      /(?:^|[\s,])(?:pre|code)(?=[:\s,{])/.test(selector!)
    )
    expect(codeRules.length).toBe(3)
    for (const [, selector] of codeRules) expect(selector).toContain(":not(:where(.pierre-diff *))")
  })

  test("lets the resolved root theme control Pierre's color scheme", async () => {
    const html = await render()
    const pierreSystemScheme = html.indexOf("color-scheme: light dark;")
    const inheritedScheme = html.indexOf(".pierre-diff { color-scheme: inherit; }")

    expect(pierreSystemScheme).toBeGreaterThan(-1)
    expect(inheritedScheme).toBeGreaterThan(pierreSystemScheme)
    expect(html).toContain(":root[data-theme=\"dark\"] { color-scheme:dark;")
  })

  test("escapes all dynamic chrome content", async () => {
    const html = await render()
    expect(html).toContain("Replaces removed with added &lt;script&gt;")
    expect(html).toContain("Possible bug: &lt;b&gt;unescaped&lt;/b&gt; &amp; dangerous")
    expect(html).not.toContain("<b>unescaped</b>")
  })

  test("interleaves prose, diffs, and diagrams in story order", async () => {
    const html = await render()
    expect(html).toContain("The change &amp; its core")
    const prose1 = html.indexOf("Read me first: we swap <code>removed</code> for <strong>added</strong>.")
    const diffA = html.indexOf("id=\"file-1\"")
    const prose2 = html.indexOf("Having read that, the supporting tweak follows.")
    const diffB = html.indexOf("id=\"file-2\"")
    expect(prose1).toBeGreaterThan(-1)
    expect(prose1).toBeLessThan(diffA)
    expect(diffA).toBeLessThan(prose2)
    expect(prose2).toBeLessThan(diffB)
    expect(html).toContain("Swaps removed for added &amp; adds more; check the constant values.")
    expect(html).toContain("const added = safe();")
    expect(html).toContain("Review findings<span class=\"count-pill\">1</span>")
  })

  test("renders the diagram and inlines the mermaid runtime only when present", async () => {
    const html = await render()
    expect(html).toContain("<pre class=\"mermaid\">graph TD; A--&gt;B</pre>")
    expect(html).toContain("The flow")
    expect(html).toContain("mermaid.initialize")
    expect(html).toMatch(/<script type="text\/plain" id="mermaid-runtime-gz">[A-Za-z0-9+/=]+<\/script>/)

    const plain = await renderWalkthroughHtml({
      title: "Nothing",
      story: {
        headline: "",
        synopsis: "x",
        chapters: [
          { title: "c", blocks: [{ kind: "diff", path: "src/a.ts", intro: "", text: "", title: "", mermaid: "" }] }
        ]
      },
      files,
      comments: [],
      repoDir: "/tmp/repo",
      mode: "workspace",
      ref: "workspace",
      generatedAt: "2026-06-10T00:00:00.000Z"
    })
    expect(plain).not.toContain("mermaid.initialize")
    expect(plain).not.toContain("id=\"mermaid-runtime-gz\"")
  })

  test("embeds Pierre diffs with shared assets hoisted once and shows the overview chart", async () => {
    const html = await render()
    expect(html.startsWith("<!doctype html>")).toBe(true)
    expect(html).toContain("</html>")
    expect(html).toContain("data-line-type=\"change-addition\"")
    expect(html).toContain("--diffs-token-light")
    expect(html).toContain("class=\"overview-chart\"")
    // Shared Pierre assets are hoisted once: no duplicate <style> blocks
    // even though two files were Pierre-rendered.
    const styleBlocks = html.match(/<style[\s\S]*?<\/style>/g) ?? []
    expect(styleBlocks.length).toBeGreaterThanOrEqual(2)
    expect(new Set(styleBlocks).size).toBe(styleBlocks.length)
  })

  test("binary files fall back to the plain note", async () => {
    const html = await render()
    expect(html).toContain("No textual diff (binary or empty change).")
  })

  test("orphan findings render as full cards so index links resolve", async () => {
    const orphan = { ...comments[0]!, path: "ghost/not-changed.ts" }
    const html = await renderWalkthroughHtml({
      title: "",
      story,
      files,
      comments: [...comments, orphan],
      repoDir: "/tmp/repo",
      mode: "workspace",
      ref: "workspace",
      generatedAt: "2026-06-10T00:00:00.000Z"
    })
    expect(html).toContain("Findings without a matching file")
    // The orphan's index link target exists as a rendered card.
    expect(html).toContain("href=\"#finding-2\"")
    expect(html).toContain("id=\"finding-2\"")
    expect(html).toContain("ghost/not-changed.ts")
  })

  test("handles an empty change set", async () => {
    const html = await renderWalkthroughHtml({
      title: "Nothing",
      story: { headline: "", synopsis: "No changes detected.", chapters: [] },
      files: [],
      comments: [],
      repoDir: "/tmp/repo",
      mode: "workspace",
      ref: "workspace",
      generatedAt: "2026-06-10T00:00:00.000Z"
    })
    expect(html).toContain("No changes detected")
  })
})

// Extra outcome data is deliberately passed through a variable so these tests
// exercise the old renderer's lossy projection before the option exists.
for (const status of ["failed", "completed_with_warnings", "skipped"] as const) {
  test(`renders ${status} distinctly from a clean zero-findings review`, async () => {
    const base = {
      title: "",
      story,
      files,
      comments: [],
      repoDir: "/tmp/repo",
      mode: "workspace",
      ref: "workspace",
      generatedAt: "2026-06-10T00:00:00.000Z"
    }
    const clean = await renderWalkthroughHtml(base)
    const options = {
      ...base,
      outcome: {
        status,
        files: [{ path: "src/a.ts", status: "not_reviewed" as const, reason: "review failed" }],
        warnings: [{ file: "src/a.ts", type: "subtask_error", message: "seat failed <script>" }]
      }
    }
    const html = await renderWalkthroughHtml(options)
    expect(html).not.toBe(clean)
    expect(html).toContain(
      status === "failed"
        ? "Review failed"
        : status === "skipped"
        ? "Review skipped"
        : "Review incomplete or completed with warnings"
    )
    expect(html).toContain("not reviewed")
    expect(html).toContain("seat failed &lt;script&gt;")
    expect(html).not.toContain("findings <strong>0</strong>")
  })
}
