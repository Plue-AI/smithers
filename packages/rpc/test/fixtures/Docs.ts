import type { Action } from "../../src/CardAction.ts"
import type { DocsCard } from "../../src/DocsCard.ts"
import { type Story, story } from "./_story.ts"

const toc: DocsCard["toc"] = [
  { slug: "quickstart", title: "Quickstart" },
  { slug: "todos", title: "TODOs" },
  { slug: "flows", title: "Flows" }
]
const quickstart: DocsCard["page"] = {
  slug: "quickstart",
  title: "Quickstart",
  summary: "Install Smithers on one Mac for one team",
  markdown: "# Quickstart\n\n## Put HTTPS in front\n\nRun `smthrs serve` behind a TLS proxy. See [TODOs](todos.md).\n"
}
const open = (page: string): Action => ({ tag: "docs", label: "Open", args: { page } })
type DocsStory = Story<DocsCard, {}, "open">
export const fixtures = {
  page: story<DocsCard, {}, "open">("The quickstart page", { toc, page: quickstart }, {
    gestures: { open: open("quickstart") },
    expect: ["Quickstart", "Install Smithers on one Mac for one team", "TODOs", "Flows"]
  }),
  anchor: story<DocsCard, {}, "open">(
    "Scrolled to a heading",
    { toc, page: quickstart, anchor: "put-https-in-front" },
    {
      gestures: { open: open("quickstart#put-https-in-front") },
      expect: ["Put HTTPS in front"]
    }
  ),
  not_found: story<DocsCard, {}, "open">(
    "A missing page shows the first page",
    { toc, page: quickstart, not_found: "deploy-to-kubernetes" },
    { gestures: { open: open("quickstart") }, expect: ["deploy-to-kubernetes", "Quickstart"] }
  )
} satisfies Record<string, DocsStory>
