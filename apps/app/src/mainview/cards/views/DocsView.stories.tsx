import { fixtures } from "@smthrs/rpc/fixtures/Docs"
import { DocsView } from "./DocsView"
import { fixtureStories, type StoryInteraction } from "./stories"
const interactions = Object.fromEntries(Object.values(fixtures).map(fixture => [fixture.name, [
  ...(fixture.gestures.open ? [{ selector: "nav a:first-child", gesture: "open", action: fixture.gestures.open.disabled ? null : { tag: "docs", args: fixture === fixtures.hostile ? { source: "docs-card", page: "quickstart" } : { page: "quickstart" } } }] : []),
  { selector: "textarea", action: null },
] as StoryInteraction[]]))
export const stories = fixtureStories(fixtures, (fixture, callbacks) => <DocsView {...fixture} {...callbacks} />, interactions)
