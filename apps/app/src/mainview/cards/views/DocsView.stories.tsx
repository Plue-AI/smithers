import type { DocsCard, DocsViewProps } from "@smthrs/rpc/DocsCard"
import { DocsView } from "./DocsView"
import type { StoryInteraction, ViewStory } from "./stories"

const toc = [{ slug: "quickstart", title: "Quickstart" }, { slug: "todos", title: "TODOs" }, { slug: "flows", title: "Flows" }]
const page = { slug: "quickstart", title: "Quickstart", summary: "Install Smithers on one Mac for one team", markdown: "## Put HTTPS in front\n\nSee [TODOs](todos.md)." }
const open = { tag: "docs" as const, label: "Open", args: { page: "quickstart" } }
const cases: { name: string; model: DocsCard; gestures: DocsViewProps["gestures"]; expect: string[] }[] = [
  { name: "The quickstart page", model: { toc, page }, gestures: { open }, expect: ["Quickstart", "TODOs", "Flows"] },
  { name: "Scrolled to a heading", model: { toc, page: { ...page, markdown: Array.from({ length: 24 }, (_, i) => `Setup ${i + 1}.\n\n`).join("") + page.markdown }, anchor: "put-https-in-front" }, gestures: { open }, expect: ["Put HTTPS in front"] },
  { name: "No navigation gesture", model: { toc, page }, gestures: {}, expect: ["Quickstart"] },
  { name: "Navigation unavailable", model: { toc, page }, gestures: { open: { ...open, disabled: { reason: "Unavailable" } } }, expect: ["Unavailable"] },
  { name: "Inert HTML", model: { toc, page: { ...page, markdown: '<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[Blocked](javascript:alert) [Control](java\tscript:alert) [Data](data:text/html,hello)\n\n[Titled](todos.md) [Heading](#put-https-in-front)\n\n## Put HTTPS in front\n\n```html\n<div>\n```' } }, gestures: { open: { ...open, args: { source: "docs-card" } } }, expect: ["<script>alert(1)</script>", "<div>", "Titled"] },
  { name: "A missing page shows the first page", model: { toc, page, not_found: "deploy-to-kubernetes" }, gestures: { open }, expect: ["deploy-to-kubernetes", "Quickstart"] },
  { name: "Repeated headings", model: { toc, page: { ...page, markdown: "## Install\n\nFirst.\n\n## Install\n\nSecond." }, anchor: "install-1" }, gestures: { open }, expect: ["First.", "Second."] },
  { name: "Unknown anchor", model: { toc, page, anchor: "unknown" }, gestures: { open }, expect: ["Put HTTPS in front"] },
]
export const stories: ViewStory[] = cases.map(({ name, model, gestures, expect }) => ({
  name, expect, actions: [], gestures,
  interactions: [...(gestures.open ? [{ selector: "nav a:first-child", gesture: "open", action: gestures.open.disabled ? null : { tag: "docs", args: { ...gestures.open.args, page: "quickstart" } } }] : []), ...(name === "Inert HTML" ? [{ selector: 'button[aria-label="Toggle line wrap"]', action: null }, { selector: 'button[aria-label="Copy code"]', action: null }] : [])] as StoryInteraction[],
  render: callbacks => <DocsView model={model} actions={[]} gestures={gestures} view={{ maximized: false }} {...callbacks} />,
}))
