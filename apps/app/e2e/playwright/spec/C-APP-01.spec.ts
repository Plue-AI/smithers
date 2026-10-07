import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"
import { fixtures } from "../../../../../packages/rpc/test/fixtures/Todo"
import { SETUP_STEP_IDS } from "@smthrs/rpc/SetupCard"

test("C-APP-01: Take over preserves place, revisions and working attempt", async ({ page }) => {
  await owner(page)
  await page.route("**/api/install", route => route.fulfill({ json: {
    address: { listen: "mac", bind: "127.0.0.1", origins: ["http://localhost"] },
    steps: SETUP_STEP_IDS.map(id => ({ id, state: "done" })),
    this_mac: { memory_gb: 32, disk_free_gb: 200, capacity: 2 }, github: { owner: "canary-owner", signed_in: true, app_installed: true },
    models: ["fast", "coding", "jev"].map(role => ({ role, provider: "fixture", key: "saved" })), chatgpt: false, capacity: 2
  } }))
  const queued = structuredClone(fixtures.queued.model)
  const working = structuredClone(fixtures.working.model)
  queued.n = 3; working.n = 4
  for (const model of [queued, working]) { model.owner_removed = true; model.owner = { ...model.owner, login: "eve", name: "Eve" } }
  const calls: number[] = []
  await page.route("**/api/todos", route => route.fulfill({ json: [queued, working] }))
  for (const model of [queued, working]) await page.route(`**/api/todos/${model.n}`, async route => {
    if (route.request().method() === "POST") {
      expect(route.request().postDataJSON()).toEqual({ op: "takeover" })
      calls.push(model.n)
      model.owner = { ...model.owner, login: "canary-owner", name: "Will" }
      model.owner_removed = false
      await route.fulfill({ status: 202, json: { state: "accepted", n: model.n } })
    } else await route.fulfill({ json: model })
  })
  await page.goto("/smithers-mvp-canary/node")
  await say(page, "/settings")
  await expect(page.getByTestId("card-settings")).toBeVisible()
  for (const model of [queued, working]) {
    await say(page, `/todo T${model.n}`)
    const card = page.getByRole("article", { name: `TODO T${model.n}` }).last()
    await expect(card).toContainText("Removed")
    await card.getByRole("button", { name: "Take over", exact: true }).press("Enter")
    await expect(card).toContainText("Will")
    await expect(card.getByRole("button", { name: "Take over", exact: true })).toHaveCount(0)
    await expect(card).toContainText(model.state === "queued" ? "Queued" : "Working")
  }
  expect(calls).toEqual([3, 4])
  expect(working.run?.attempt).toBe(1)
})
