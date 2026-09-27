import { afterAll, describe, expect, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import type { WikiIndexRow } from "../state/AppState"
import { readWikiHref, readWikiSourceHref, resolveWikiLink, UNRESOLVED_HREF, WikiPageView, wikiLinkHref, wikiPageSegments } from "./WikiPageView"
import { payloadFor } from "../flows/SlashPayload"
import { WorldCardBody } from "../cards/ConversationCards"
import type { Card, WorldDocument } from "../state/AppState"

GlobalRegistrator.register()
afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, 20))
  await GlobalRegistrator.unregister()
})

/*
 * The reading view (#1922): wikilinks render as links to the page the
 * backend's index resolved them to, aliases as their labels, headings
 * carried along; image embeds render inline from the scoped content route;
 * a target the space has no page for is marked and opens nothing. Links in
 * code stay text, as the index also excludes them.
 */

const page = (id: number, slug: string, path: string, extra: Partial<WikiIndexRow["pages"][number]> = {}): WikiIndexRow["pages"][number] =>
  ({ id, slug, title: slug, path, revision: 1, updatedAt: "2026-09-26T00:00:00Z", tags: [], aliases: [], headings: [], links: [], backlinks: [], ...extra })

const index: WikiIndexRow = {
  id: "org/repo#public", repo: "org/repo", space: "public", loadedAt: 1, folders: ["Guides", "assets"], tags: [],
  pages: [
    page(1, "home", "Home.md", { title: "Home", links: [
      { target: "Guides/Start", heading: "Install", alias: "start", embed: false, pageId: 2 },
      { target: "assets/logo.png", embed: true, pageId: 3 },
      { target: "Nowhere", embed: false },
      { target: "Guides/Start", embed: true, pageId: 2 },
      { target: "notes.pdf", embed: true, pageId: 4 }
    ] }),
    page(2, "start", "Guides/Start.md", { title: "Start" }),
    page(3, "logo", "assets/logo.png", { attachment: { digest: "c".repeat(64), mediaType: "image/png", size: 3 } }),
    page(4, "notes", "notes.pdf", { attachment: { digest: "d".repeat(64), mediaType: "application/pdf", size: 9 } })
  ]
}
const links = index.pages[0]!.links
const body = "# Home\n\nSee [[Guides/Start#Install|start]] and ![[assets/logo.png]].\n\nAlso [[Nowhere]], ![[Guides/Start]] and ![[notes.pdf]].\n\n`[[Guides/Start]]` stays code.\n\n[[#Install]] scrolls here.\n"

describe("wiki page view", () => {
  test("source navigation accepts only this repository's immutable content and a valid line", () => {
    const prefix = "/api/repos/org/repo/contents/", ref = "a".repeat(40)
    expect(readWikiSourceHref(`${prefix}src/a.ts?ref=${ref}`, "org/repo")).toEqual({ path: "src/a.ts", repo: "org/repo", ref })
    for (const href of [
      `${prefix}src/a.ts?ref=main#L1`, `${prefix}src/a.ts?ref=${ref}#L0`,
      `${prefix}%2e%2e/secret?ref=${ref}`, `${prefix}src/%ZZ?ref=${ref}`,
      `${prefix}src/a.ts?ref=${ref}#L999999999999999999999`,
      `/api/repos/other/repo/contents/src/a.ts?ref=${ref}#L1`
    ]) expect(readWikiSourceHref(href, "org/repo")).toBeUndefined()
  })
  test("an embedded Wiki card displays the same explained page and citation doors", () => {
    const ref = "a".repeat(40)
    const note = {
      id: "wiki:org/repo:7", title: "Answer", path: "generated-answer.md",
      body: `# Answer\n\nThe answer is 42.\n\n[src/answer.ts:2](/api/repos/org/repo/contents/src/answer.ts?ref=${ref}#L2)`,
      sources: [], cloud: { repo: "org/repo", slug: "generated-answer", pageId: 7, phase: "live", pending: [], error: null }
    } as unknown as WorldDocument
    const card = { id: "wiki-open", kind: "world", payload: { view: "read", documents: [{ id: note.id, path: note.path, title: note.title, confidence: 1 }] } } as Extract<Card, { kind: "world" }>
    const calls: unknown[] = []
    const host = document.createElement("div"), root = createRoot(host)
    try {
      flushSync(() => root.render(<WorldCardBody card={card} worldDocuments={[note]} onChangeWorldDocument={() => {}}
        onRunCommand={(name, args) => { calls.push({ name, ...payloadFor(name, args) }) }} />))
      expect(host.querySelector('[data-testid="wiki-page"]')?.textContent).toContain("The answer is 42.")
      host.querySelector<HTMLAnchorElement>('.wiki-page a')!.click()
      expect(calls).toEqual([{ name: "files.read", payload: { path: "src/answer.ts", repo: "org/repo", ref, line: 2 } }])
      const edit = [...host.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === "Edit")!
      edit.click()
      expect(calls[1]).toEqual({ name: "wiki.card.view", payload: { cardId: card.id, view: "document" } })
    } finally { flushSync(() => root.unmount()) }
  })
  test("a generated citation opens the existing embedded file flow at its reviewed revision and line", () => {
    const ref = "a".repeat(40)
    const calls: unknown[] = []
    const host = document.createElement("div")
    const root = createRoot(host)
    try {
      flushSync(() => root.render(<WikiPageView
        body={`---\nsmithers_generated: true\n---\n\n# Answer\n\nThe answer is 42.\n\n[src/answer.ts:2](/api/repos/org/repo/contents/src/answer.ts?ref=${ref}#L2)`}
        links={[]} index={undefined} repo="org/repo" space="public" onOpen={() => {}}
        onRunCommand={(name, args) => { calls.push({ name, ...payloadFor(name, args) }) }} />))
      expect(host.textContent).toContain("The answer is 42.")
      expect(host.textContent).not.toContain("smithers_generated")
      host.querySelector<HTMLAnchorElement>("a")!.click()
      expect(calls).toEqual([{ name: "files.read", payload: { path: "src/answer.ts", repo: "org/repo", ref, line: 2 } }])
    } finally { flushSync(() => root.unmount()) }
  })
  test("resolves each occurrence through the index's links, never by its own rules", () => {
    expect(resolveWikiLink(links, index, { target: "Guides/Start", heading: "Install", alias: "start", embed: false })?.id).toBe(2)
    expect(resolveWikiLink(links, index, { target: "assets/logo.png", heading: "", alias: "", embed: true })?.id).toBe(3)
    expect(resolveWikiLink(links, index, { target: "Nowhere", heading: "", alias: "", embed: false })).toBeUndefined()
    // A target the index does not list at all (a link typed since the index was read) is unresolved too.
    expect(resolveWikiLink(links, index, { target: "Guides/Start", heading: "", alias: "", embed: false })?.id).toBe(2)
    expect(resolveWikiLink(links, index, { target: "Fresh", heading: "", alias: "", embed: false })).toBeUndefined()
  })

  test("rewrites links to the page's href with the alias as label and the heading carried, splits image embeds out, marks unresolved targets, leaves code alone", () => {
    const segments = wikiPageSegments(body, links, index)
    expect(segments.map((segment) => segment.kind)).toEqual(["markdown", "image", "markdown"])
    const first = segments[0]!.kind === "markdown" ? segments[0]!.text : ""
    expect(first).toContain(`[start](${wikiLinkHref("Guides/Start.md", "Install")})`)
    expect(first).not.toContain("[[")
    const image = segments[1]!
    expect(image.kind === "image" ? [image.page.path, image.alt] : []).toEqual(["assets/logo.png", "assets/logo.png"])
    const rest = segments[2]!.kind === "markdown" ? segments[2]!.text : ""
    expect(rest).toContain(`[Nowhere](${UNRESOLVED_HREF}Nowhere)`)
    // A page embed is a link to the page; a non-image attachment embed is a link to its bytes' page. The label is the target as written.
    expect(rest).toContain(`[Guides/Start](${wikiLinkHref("Guides/Start.md")})`)
    expect(rest).toContain(`[notes.pdf](${wikiLinkHref("notes.pdf")})`)
    expect(rest).toContain("`[[Guides/Start]]` stays code.")
    expect(rest).toContain(`[#Install](${wikiLinkHref("", "Install")})`)
  })

  test("a rendered href names its page and heading, or its unresolved target, and an ordinary link names nothing", () => {
    expect(readWikiHref(wikiLinkHref("Guides/Start.md", "Install"))).toEqual({ path: "Guides/Start.md", heading: "Install" })
    expect(readWikiHref(wikiLinkHref("Guides/Start.md"))).toEqual({ path: "Guides/Start.md" })
    expect(readWikiHref(`${UNRESOLVED_HREF}Nowhere`)).toEqual({ unresolved: "Nowhere" })
    expect(readWikiHref("https://example.com")).toBeUndefined()
  })

  test("renders links, the inline image from the scoped content route, and the unresolved mark", () => {
    const markup = renderToStaticMarkup(<WikiPageView body={body} links={links} index={index} repo="org/repo" space="public" onOpen={() => {}} />)
    expect(markup).toContain(`href="${wikiLinkHref("Guides/Start.md", "Install")}"`)
    expect(markup).toContain(">start</a>")
    expect(markup).toContain('<img src="/api/repos/org/repo/wiki/history/3/1/content?visibility=public" alt="assets/logo.png"')
    expect(markup).toContain(`href="${UNRESOLVED_HREF}Nowhere"`)
    expect(markup).toContain('data-testid="wiki-embed"')
    expect(markup).not.toContain("[[Guides/Start#Install")
    expect(markup).toContain("<code")
  })
})
