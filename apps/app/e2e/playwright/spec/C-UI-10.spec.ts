import { expect, test } from "../browserTest"
import { say } from "./j1-fixtures"
import { installCloudFixture } from "../cloudFixture"

// Browser projection receipt. PostgreSQL role effects are checked separately
// by debug-api/local-own-read.ts on the reference install.
test("C-UI-10: API playground requires confirmation and preserves member rights", async ({ page }) => {
  test.setTimeout(300_000)
  await installCloudFixture(page, { capabilities: ["identity", "debug.api"] })
  await page.route("**/api/user", route => route.fulfill({ json: { id: 2, username: "ben", is_admin: false } }))
  let reads = 0
  await page.route("**/api/todos", route => { reads++; return route.fulfill({ json: { items: [{ n: 8, title: "T8" }] } }) })
  const mutations: string[] = [], keys: string[] = []
  await page.route("**/api/repos/smithersai/smithers/secrets", route => {
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
  const beforeSelection = reads
  await card.getByRole("button", { name: /^GET \/api\/todos(?: |$)/ }).click()
  await expect(card.getByRole("region", { name: "Exchange" })).toHaveCount(0)
  expect(reads).toBe(beforeSelection)
  await card.getByRole("button", { name: "Send", exact: true }).click()
  await expect(card.getByText(/200 ·/)).toBeVisible({ timeout: 60_000 })
  await expect(card).toContainText("T8")
  expect(reads).toBe(beforeSelection + 1)
  await card.getByRole("button", { name: /^POST \/api\/repos\/\{owner\}\/\{repo\}\/secrets POST/ }).click()
  await card.getByLabel("owner", { exact: true }).fill("smithersai")
  await card.getByLabel("repo", { exact: true }).fill("smithers")
  await card.getByLabel("JSON", { exact: true }).fill('{"name":"TEST_KEY","value":"canary"}')
  await card.getByRole("button", { name: "Send", exact: true }).click()
  expect(mutations).toHaveLength(0)
  await card.getByRole("button", { name: /^Confirm POST/ }).click()
  await expect(card.getByText(/403 ·/)).toBeVisible({ timeout: 60_000 })
  expect(mutations).toHaveLength(1)
  expect(keys[0]).not.toBe("")
  await expect(card.getByLabel("Token", { exact: true })).toHaveCount(0)
  await expect(page.getByTestId("composer-input")).toBeEnabled()
  await say(page, "/debug-api get_api_todos")
  await expect(card.getByRole("button", { name: /^GET \/api\/todos(?: |$)/ })).toHaveAttribute("aria-pressed", "true")
  expect(mutations).toHaveLength(1)
})
