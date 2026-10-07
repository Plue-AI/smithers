import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { viewerAdmitted, type CatalogItem } from "../flows/registry"
import { CommandsContainer } from "./CommandsContainer"

const rows: ReadonlyArray<CatalogItem> = [
  { name: "todo.amend", summary: "Change a TODO", args: "Tn", group: "todo", visibility: "core", actors: ["person"], minimumRole: "member", agent: "confirm" },
  { name: "members", summary: "Manage people", group: "chat", visibility: "core", actors: ["person"], minimumRole: "maintainer", agent: "never" },
  { name: "release-notes", summary: "Write release notes", args: "[JSON object]", group: "flow", visibility: "core", actors: ["person"], minimumRole: "member", agent: "run" },
  { name: "monitor", summary: "Watch runs", group: "runs", visibility: "advanced", actors: ["person"], minimumRole: "member", agent: "run" },
  { name: "debug.secret", summary: "Hidden", group: "debug", visibility: "hidden", actors: ["person"], minimumRole: "member", agent: "run" },
  { name: "todo.preapprove", summary: "Approve", group: "todo", visibility: "in-card", actors: ["person"], minimumRole: "member", agent: "never" },
  { name: "unknown", summary: "No authority" }
]
const mount = (catalog: ReadonlyArray<CatalogItem> | undefined) => renderToStaticMarkup(<CommandsContainer catalog={catalog}
  dispatch={() => { throw new Error("listing must not dispatch") }} view={{ maximized: false }} onView={() => {}} />)

test("Commands mounts the real View with literal admitted rows and inert repository metadata", () => {
  const html = mount(viewerAdmitted({ viewerRole: "maintainer" } as Parameters<typeof viewerAdmitted>[0], rows))
  expect(html).toContain("/todo.amend Tn")
  expect(html).toContain("Change a TODO")
  expect(html).toContain("Asks first")
  expect(html).toContain("/members")
  expect(html).toContain("Only you")
  expect(html).toContain("/release-notes [JSON object]")
  expect(html).toContain('<details class="commands-advanced"><summary>Advanced</summary>')
  expect(html).not.toContain("<button")
  expect(html).not.toContain("debug.secret")
  expect(html).not.toContain("todo.preapprove")
  expect(html).not.toContain("No authority")
  expect((html.match(/command-policy/g) ?? []).length).toBe(2)
})
test("Commands omits unauthorized groups and refuses an unavailable projection", () => {
  const html = mount(viewerAdmitted({ viewerRole: "member" } as Parameters<typeof viewerAdmitted>[0], rows))
  expect(html).not.toContain("/members")
  expect(html).not.toContain("<h3>Chat</h3>")
  expect(mount(undefined)).toBe("")
  expect(mount([])).not.toContain("<h3>")
})
test("Commands does not derive policy from an incomplete provider row", () => {
  expect(mount([{ name: "unsafe", summary: "Unsafe", visibility: "core", group: "chat" }])).not.toContain("unsafe")
})
