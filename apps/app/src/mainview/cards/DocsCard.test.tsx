import { expect, test } from "bun:test"
import { act } from "react"
import type { DocsViewProps } from "@smthrs/rpc/DocsCard"
import { createRoot } from "./views/testDom"
import { DocsCard } from "./DocsCard"
import { loadDocs } from "../../docs/Docs"
import { diskPageFiles } from "../../docs/DiskPages"

for (const page of loadDocs(diskPageFiles()).pages) test(`Docs projects ${page.slug} verbatim and binds its open gesture`, async () => {
  let props!: DocsViewProps
  const sent: unknown[] = []
  const host = document.createElement("div"), root = createRoot(host)
  const card = { id: "docs", kind: "docs" as const, title: page.title, status: "active" as const, ordinal: 1, createdAt: 0,
    payload: { page: page.slug, markdown: page.markdown, summary: page.summary, anchor: "heading", not_found: "missing" } }
  await act(async () => root.render(<DocsCard card={card} available View={value => { props = value; return null }} dispatch={(tag, input) => { sent.push({ tag, input }) }} />))
  expect(props.model.page).toEqual(page)
  expect(props.model).toMatchObject({ anchor: "heading", not_found: "missing" })
  props.onAction(props.gestures.open!.tag, { page: "quickstart#open-the-command-list" })
  expect(sent).toEqual([{ tag: "docs", input: { page: "quickstart#open-the-command-list" } }])
  await act(async () => root.render(<DocsCard card={card} available={false} View={value => { props = value; return null }} dispatch={() => { throw Error("unavailable dispatch") }} />))
  expect(props.gestures).toEqual({})
  props.onAction("docs", { page: "flows" })
  await act(async () => root.unmount())
})
