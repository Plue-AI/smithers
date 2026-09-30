import { expect, it } from "bun:test"
import * as Panels from "../src/panels.ts"
import * as Smithers from "../src/smithers.ts"

const discovered = new Set(["review", "release"])
const factory: Smithers.Factory = {
  metrics: "3 landed of 4 · 0 reverts · 2h median",
  rows: [{ id: "issue:7", label: "#7 Fix the login", status: "running", details: [] }]
}

it("shows only factory content: its issues and numbers, never flows or runs", () => {
  const panel = Smithers.panel([], discovered, factory)
  expect(Panels.decode(panel)).toEqual(panel)
  expect(panel.id).toBe("smithers")
  expect(panel.summary).toBe(factory.metrics)
  expect(panel.rows.map((row) => row.id)).toEqual(["factory:todo", "issue:7"])
})

it("lists the homepage's apps after the issues, running the ones this directory discovers", () => {
  const apps = [
    { flow: "review", title: "Review a PR", picture: "review" },
    { flow: "issue.implement", title: "Fix an issue", picture: "issue" }
  ]
  const panel = Smithers.panel(apps, discovered, factory)
  expect(Panels.decode(panel)).toEqual(panel)
  expect(panel.rows.map((row) => row.id)).toEqual(["factory:todo", "issue:7", "app:review", "app:issue.implement"])
  expect(panel.rows[2]).toEqual({
    id: "app:review",
    label: "Review a PR",
    details: [{ kind: "text", text: "review" }],
    action: { label: "Review a PR", action: { kind: "flow", flow: "review" } }
  })
  // A flow the app home names but this directory does not discover is listed, and runs nowhere here.
  expect(panel.rows[3]).toEqual({
    id: "app:issue.implement",
    label: "Fix an issue",
    details: [{ kind: "text", text: "issue.implement" }]
  })
  // Unread numbers fall back to the app count.
  expect(Smithers.panel(apps, discovered).summary).toBe("2 apps")
})

it("says how to see the factory's issues when the person is not signed in to Cloud", () => {
  const panel = Smithers.panel([], discovered, "signed-out")
  expect(Panels.decode(panel)).toEqual(panel)
  expect(panel.rows).toEqual([{
    id: "factory:sign-in",
    label: "Sign in to see the factory: smthrs auth login",
    details: []
  }])
  expect(panel.summary).toBe("Factory")
})

it("keeps a read with no numbers valid", () => {
  const panel = Smithers.panel([], discovered, { metrics: "", rows: [] })
  expect(Panels.decode(panel)).toEqual(panel)
  expect(panel).toMatchObject({ summary: "Factory", rows: [{ id: "factory:todo" }] })
})

it("leads the factory's issues with the row that names how to file a TODO", () => {
  const panel = Smithers.panel([], discovered, {
    metrics: "1 landed",
    rows: [{ id: "issue:x", label: "#1 T", details: [] }]
  })
  expect(Panels.decode(panel)).toEqual(panel)
  expect(panel.rows.slice(0, 2)).toEqual([
    { id: "factory:todo", label: "File a TODO", details: [{ kind: "text", text: "/todo <title>" }] },
    { id: "issue:x", label: "#1 T", details: [] }
  ])
})
