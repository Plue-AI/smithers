import { fixtures } from "@smthrs/rpc/fixtures/Docs"
import { DocsView } from "./DocsView"
import { fixtureStories } from "./stories"
export const stories = fixtureStories(fixtures, (fixture, callbacks) => <DocsView {...fixture} {...callbacks} />, {
  "The quickstart page": [{ selector: 'nav button:nth-child(2)', action: { tag: "docs", args: { page: "todos" } } }],
})
