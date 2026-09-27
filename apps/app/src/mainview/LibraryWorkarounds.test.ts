import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"

/*
 * A workaround dies with the library fix it was waiting for.
 *
 * `@smthrs/ui` now gives every affordance the host renders through it a
 * pass-through hook: `ChatComposer`'s `submitProps`/`stopProps`, `FileTree`'s
 * `nodeProps`, `KnowledgeGraph`'s `nodeProps`, `BacklinksPanel`'s `linkProps`
 * and `OutlineView`'s `headingProps`. It also releases Tab itself
 * (`escapeTabOrder`, default true) and renders GFM tables. The host kept its
 * workarounds past each of those landings — a ref callback reaching into a
 * component's rendered DOM, a capture handler above the editor, a second
 * table parser — so the transcript and the cards drifted apart on what a
 * table cell is. This fails if any of them comes back.
 *
 * It also holds the other half of the same rule: a flow name is never typed
 * by hand into the DOM. `flowProps`/`flowAction` take a `FlowName` from the
 * registry and own the attribute's spelling, so a `data-flow="…"` literal in
 * production source is a name the compiler never checked.
 */

const mainview = new URL(".", import.meta.url).pathname

const productionSources = async (): Promise<ReadonlyArray<{ readonly path: string; readonly source: string }>> => {
  const files: Array<{ readonly path: string; readonly source: string }> = []
  for await (const path of new Bun.Glob("**/*.{ts,tsx}").scan({ cwd: mainview, absolute: true })) {
    if (path.includes(".test.")) continue
    files.push({ path: path.slice(mainview.length), source: await readFile(path, "utf8") })
  }
  return files
}

/** One banned shape and the landed prop that replaces it. */
const RETIRED: ReadonlyArray<readonly [pattern: RegExp, replacement: string]> = [
  [/\.sui-chat-composer-(?:send|stop|input)/, "ChatComposer's submitProps/stopProps/textareaProps"],
  [/\bstampTestIds\b|\bcomposeRefs\b/, "ChatComposer's submitProps"],
  [/\bstampFlows\b|\bFlowStamp\b/, "the rendering component's own nodeProps/linkProps/headingProps"],
  [/\btabOutOf\b|\bfocusableOutside\b/, "MarkdownEditor's escapeTabOrder"],
  [/\bRichMarkdown\b/, "@smthrs/ui's Markdown"],
  [/data-flow(?:-args)?"?\s*[=:]\s*["'`][a-z]/, "flowProps(<FlowName>), which the registry type-checks"]
]

describe("landed library contracts have no host workaround left", () => {
  test("no source reaches into a component @smthrs/ui renders", async () => {
    const sources = await productionSources()
    expect(sources.length).toBeGreaterThan(0)
    for (const [pattern, replacement] of RETIRED) {
      const offenders = sources.filter(({ source }) => pattern.test(source)).map(({ path }) => `${path} (use ${replacement})`)
      expect(offenders).toEqual([])
    }
  })

  test("the composer's Send and Stop name their flows through the component's own props", async () => {
    const source = await readFile(new URL("./Composer.tsx", import.meta.url), "utf8")
    expect(source).toContain("submitProps={COMPOSER_SEND_PROPS}")
    expect(source).toContain("stopProps={COMPOSER_STOP_PROPS}")
    expect(source).toContain('flowProps("chat.send")')
    expect(source).toContain('flowProps("chat.stop")')
  })

  test("the Wiki pane names every flow through the rendering component's own hook", async () => {
    const surface = await readFile(new URL("./WorldSurface.tsx", import.meta.url), "utf8")
    /* The tree moved to the shared wiki navigation (#1922): its rows still name their flow through FileTree's own nodeProps. */
    const navigation = await readFile(new URL("./wiki/WikiNavigation.tsx", import.meta.url), "utf8")
    expect(navigation).toContain('nodeProps={() => flowProps("wiki.select")}')
    expect(navigation).toContain('flowProps("wiki.cloud.open") : flowProps("wiki.select")')
    expect(surface).toContain('linkProps={(path) => flowProps(')
    expect(surface).toContain("headingProps={(heading) => flowProps(\"wiki.heading\", String(heading.line))}")
    const graph = await readFile(new URL("./KnowledgeGraphSurface.tsx", import.meta.url), "utf8")
    expect(graph).toContain('nodeProps={(node) => flowProps("wiki.open", node.id)}')
  })

  test("the ref-callback stamp is gone from disk, not merely unused", async () => {
    expect(await Bun.file(new URL("./FlowStamp.ts", import.meta.url).pathname).exists()).toBe(false)
  })

  test("no production source queries an affordance by its flow name", async () => {
    const sources = await productionSources()
    const offenders = sources
      .filter(({ path, source }) => path !== "flows/FlowAction.ts" && /\[data-flow=/.test(source))
      .map(({ path }) => `${path} (use flowSelector(<FlowName>) or a ref)`)
    expect(offenders).toEqual([])
  })
})
