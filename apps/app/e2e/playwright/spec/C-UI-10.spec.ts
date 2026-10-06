import { expect, test } from "../browserTest"
import { say } from "./j1-fixtures"
import { installCloudFixture } from "../cloudFixture"
import operations from "../../../src/debugApi/install-operations.fixture.json"

// Browser projection receipt. PostgreSQL role effects are checked separately
// by debug-api/local-own-read.ts on the reference install.
test("C-UI-10: API playground requires confirmation and preserves member rights", async ({ page }) => {
  test.setTimeout(300_000)
  await installCloudFixture(page, { capabilities: ["identity", "debug.api"] })
  await page.route("**/api/user", route => route.fulfill({ json: { id: 2, username: "ben", is_admin: false } }))
  let reads = 0
  await page.route("**/api/todos", route => { reads++; return route.fulfill({ json: { items: [{ n: 8, title: "T8" }] } }) })
  const mutations: string[] = [], keys: string[] = []
  await page.route("**/api/secrets", route => {
    mutations.push(route.request().url())
    keys.push(route.request().headers()["idempotency-key"] ?? "")
    return route.fulfill({ status: 403, json: { class: "permission", code: "forbidden", message: "Forbidden" } })
  })
  await page.goto("/")
  await say(page, "/help")
  const help = page.getByRole("article", { name: "Commands", exact: true })
  await expect(help.getByRole("button", { name: "/debug-api", exact: true, includeHidden: true })).toBeHidden()
  await help.getByText("Advanced", { exact: true }).click()
  await help.getByRole("button", { name: /debug-api/ }).click()
  const card = page.getByRole("article", { name: "Debug API", exact: true })
  await expect(card).toBeVisible({ timeout: 60_000 })
  const shownOperations = await card.getByRole("navigation", { name: "Operations" }).locator("button code").allTextContents()
  expect(shownOperations.sort()).toEqual(operations.map(operation => `${operation.method} ${operation.path}`).sort())
  const beforeSelection = reads
  await card.getByRole("button", { name: /^GET \/api\/todos(?: |$)/ }).click()
  await expect(card.getByRole("region", { name: "Exchange" })).toHaveCount(0)
  expect(reads).toBe(beforeSelection)
  await card.getByRole("button", { name: "Send", exact: true }).click()
  await expect(card.getByText(/200 ·/)).toBeVisible({ timeout: 60_000 })
  await expect(card).toContainText("T8")
  expect(reads).toBe(beforeSelection + 1)
  await card.getByRole("button", { name: /^PUT \/api\/secrets PUT/ }).click()
  expect(await card.locator("input:not([type=hidden]), textarea").evaluateAll(elements => elements.map(element => {
    const id = element.id
    return Array.from(document.querySelectorAll("label")).find(label => label.htmlFor === id)?.textContent?.trim()
  }))).toEqual(["JSON"])
  await card.getByLabel("JSON", { exact: true }).fill('{"name":"TEST_KEY","value":"canary"}')
  await card.getByRole("button", { name: "Send", exact: true }).click()
  expect(mutations).toHaveLength(0)
  await card.getByRole("button", { name: /^Confirm PUT/ }).click()
  await expect(card.getByText(/403 ·/)).toBeVisible({ timeout: 60_000 })
  expect(mutations).toHaveLength(1)
  expect(keys[0]).not.toBe("")
  await expect(card.getByLabel("Token", { exact: true })).toHaveCount(0)
  await expect(page.getByTestId("composer-input")).toBeEnabled()
  await say(page, "/debug-api get_api_todos")
  await expect(card.getByRole("button", { name: /^GET \/api\/todos(?: |$)/ })).toHaveAttribute("aria-pressed", "true")
  expect(mutations).toHaveLength(1)
})
