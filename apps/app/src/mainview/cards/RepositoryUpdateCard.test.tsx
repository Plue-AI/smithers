import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { CardView, type CardViewProps } from "../ChatCards"
import type { Card } from "../state/AppState"

GlobalRegistrator.register()
afterAll(() => GlobalRegistrator.unregister())

const noop = () => {}
const handlers: Omit<CardViewProps, "card"> = {
  maximized: false, onDecideApproval: noop, onGrantConfirm: noop, onGrantCancel: noop,
  onMaximize: noop, onMinimize: noop, onOpenInTab: noop,
  onConnectGitHub: noop, onRunWorkflow: noop, onStopRun: noop,
  onRetryRun: noop, onChooseWorkflowRepo: noop, worldDocuments: [], onChangeWorldDocument: noop,
  onRunCommand: noop
}
const card: Extract<Card, { kind: "repo-update" }> = {
  id: "activity", title: "Repository update · hello-server", kind: "repo-update", status: "active", ordinal: 1, createdAt: 1,
  payload: {
    repo: "practice:smithersai/hello-server", scope: "practice:0", checkedAt: 1789320000000,
    summary: "3 issue updates, 1 PR update since my last check.", openIssues: 1, openPrs: 0, problems: [],
    items: [
      { id: "open", version: "1", kind: "issue", number: 3, title: "Fix hello", state: "open", tags: ["issue", "open", "bug"], read: false },
      { id: "closed", version: "1", kind: "issue", number: 2, title: "Finished issue", state: "closed", tags: ["issue", "closed"], read: true },
      { id: "merged", version: "1", kind: "pr", number: 4, title: "Shipped change", state: "merged", tags: ["pr", "merged"], read: false }
    ]
  }
}
const render = (value = card) => {
  const host = document.createElement("div")
  host.innerHTML = renderToStaticMarkup(<CardView card={value} {...handlers} />)
  return host
}

for (const [label, items, problems] of [
  ["complete empty read", [], []],
  ["partial empty read", [], ["Could not load repository activity (401)."]],
  ["partial populated read", card.payload.items, ["Could not load notifications (503)."]]
] as const) test(`${label} shows only supported activity claims`, () => {
  const host = render({ ...card, payload: { ...card.payload, items: [...items], problems: [...problems] } })
  expect(host.querySelector(".ghc-empty") !== null).toBe(items.length === 0 && problems.length === 0)
  expect(host.querySelector('[role="status"]') !== null).toBe(problems.length > 0)
  expect(host.querySelectorAll(".repo-update-item")).toHaveLength(items.length)
  expect(host.querySelector('button[data-flow="repo.overview"]')?.textContent).toContain("Refresh")
})

test("activity header is just a short title and expand, including restored cards", () => {
  const host = render()
  const header = host.querySelector("header")!
  expect(header.textContent).toBe("Activity")
  expect(header.querySelector('[aria-label="Maximize card"]')).not.toBeNull()
  expect(header.querySelector(".smithers-card-meta")).toBeNull()
  expect(header.querySelector(".sui-badge")).toBeNull()
  expect(host.textContent?.match(/hello-server/g)).toHaveLength(1)
  const details = host.querySelector("details")!
  expect(details.open).toBe(false)
  expect(details.querySelector("summary")?.getAttribute("aria-label")).toBe("Activity details")
  expect(details.querySelectorAll("time")).toHaveLength(1)
  expect(host.querySelectorAll("time")).toHaveLength(1)
})

test("unread belongs to individual rows; open, closed and merged have distinct accessible shapes", () => {
  const host = render()
  expect(host.textContent).not.toMatch(/\d+ unread|All read/)
  const rows = [...host.querySelectorAll(".repo-update-item")]
  expect(rows[0]?.getAttribute("data-read")).toBe("false")
  expect(rows[0]?.querySelector(".repo-update-unread")?.textContent).toBe("Unread")
  expect(rows[1]?.getAttribute("data-read")).toBe("true")
  expect(rows[1]?.querySelector(".repo-update-unread")).toBeNull()
  const glyphs = rows.map(row => row.querySelector(".ghc-state-icon svg")!)
  expect(glyphs.map(glyph => glyph.getAttribute("aria-label"))).toEqual(["Open", "Closed", "Merged"])
  expect(new Set(glyphs.map(glyph => glyph.innerHTML)).size).toBe(3)
  expect(rows.map(row => row.querySelector(".ghc-row-meta")?.textContent)).toEqual(["#3 · Issue", "#2 · Issue", "#4 · Pull request"])
  expect(rows[0]?.querySelector('button[data-flow="issues.view"]')).not.toBeNull()
  expect(rows[2]?.querySelector('button[data-flow="prs.view"]')).not.toBeNull()
})
