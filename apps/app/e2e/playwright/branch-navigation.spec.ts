import historyFixture from "../../src/mainview/state/testdata/earlier-history.json"
import { expect, test } from "./browserTest"
import { owner, say } from "./spec/j1-fixtures"

test("/branches mounts the served tree inline and preserves its view on reload", async ({ page }) => {
  await owner(page)
  await page.route("**/api/branches?*", route => route.fulfill({ json: [
    { name: "retry", kind: "scratch", state: "awake", machine: { id: "b1" }, forked_from: { ref: "main" } },
    { name: "nested", kind: "scratch", state: "asleep", machine: { id: "b2" }, forked_from: { ref: "retry" } }
  ] }))
  await page.routeWebSocket("**/api/live", socket => socket.onMessage(raw => {
    if (typeof raw !== "string") return
    const frame = JSON.parse(raw)
    if (frame.t !== "sub" || frame.topic !== "branch:b1") return
    socket.send(JSON.stringify({ t: "snap", id: frame.id, cursor: 1, data: { presence: [{ actor: { kind: "person", login: "ben", name: "Ben", avatar_url: "https://github.com/ben.png", color_index: 0 } }] } }))
  }))
  await page.goto("/")
  await say(page, "/branches")
  const tree = page.getByRole("navigation", { name: "Branches", exact: true })
  await expect(tree).toBeVisible()
  await expect(tree.getByRole("button", { name: "Open retry", exact: true })).toBeVisible()
  await expect(tree.locator('[data-node="retry"]').getByRole("img", { name: "Ben", exact: true })).toBeVisible()
  await expect(tree.locator('[data-node="nested"]').locator("..")).toHaveAttribute("data-depth", "2")
  await expect(page.locator('.smithers-card[data-kind="branches"]')).toHaveCount(0)
  await tree.locator('[data-node="earlier"]').press("Enter")
  await expect(page.getByRole("region", { name: "Earlier", exact: true })).toContainText("Read-only")
  await expect(page.locator("[data-branch-navigation]")).toHaveAttribute("aria-busy", "false")
  await page.reload()
  await expect(tree).toBeVisible()
  await expect(page.getByRole("region", { name: "Earlier", exact: true })).toBeVisible()
})


test("Earlier opens verified journal output without starting or resuming a turn", async ({ page }) => {
  await owner(page)
  let available = false
  let turns = 0
  page.on("request", request => { if (/\/api\/(agent|chat)\/turn$/.test(new URL(request.url()).pathname)) turns++ })
  await page.route("**/api/branches?*", route => route.fulfill({ json: [] }))
  await page.route("**/api/agent/conversations", route => route.fulfill({ json: available ? historyFixture.index : { status: "ok", conversations: [], next: null } }))
  await page.route("**/api/agent/conversations/replay", route => route.fulfill({ json: historyFixture.replay }))
  await page.goto("/")
  await expect(page.getByRole("button", { name: "Chat", exact: true })).toBeVisible()
  available = true
  await say(page, "/branches")
  const earlier = page.getByRole("region", { name: "Earlier", exact: true })
  await page.locator('[data-node="earlier"]').press("Enter")
  await earlier.getByRole("button", { name: "Legacy journal question", exact: true }).press("Enter")
  await expect(earlier).toContainText("Archived journal greeting")
  await expect(earlier.locator(".archive-entries button")).toHaveCount(0)
  await expect(page.locator("[data-branch-navigation]")).toHaveAttribute("aria-busy", "false")
  await page.reload()
  await expect(earlier).toContainText("Archived journal greeting")
  expect(turns).toBe(0)
})
