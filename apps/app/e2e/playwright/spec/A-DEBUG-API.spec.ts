import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// Written before implementation: mvp.md M-36, §6.14, Appendix A /debug-api; lands with T-APP-21
test("A-DEBUG-API: durable command scenario", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md M-36, §6.14, Appendix A /debug-api; lands with T-APP-21")
  await owner(page)
  // Member permission fixture from C-UI-10: the install refuses secret writes.
  await page.route("**/api/user", route => route.fulfill({ json: { id: 2, username: "ben", is_admin: false } }))
  const writes: string[] = []
  page.on("request", request => {
    if (request.method() === "PUT" && new URL(request.url()).pathname === "/api/secrets") writes.push(request.url())
  })
  await page.goto("/")
  await say(page, "/debug-api")
  const card = page.locator(".smithers-card").last()
  await card.getByRole("option", { name: "GET /api/stack", exact: true }).press("Enter")
  await expect(card.getByText("200", { exact: true })).toHaveCount(0)
  await card.getByRole("button", { name: "Send", exact: true }).press("Enter")
  await expect(card.getByText("200", { exact: true })).toBeVisible()
  await expect(card).toContainText("T8")
  await card.getByRole("option", { name: "PUT /api/secrets", exact: true }).press("Enter")
  await card.getByLabel("Body", { exact: true }).fill('{"name":"TEST_KEY","value":"canary"}')
  await card.getByRole("button", { name: "Send", exact: true }).press("Enter")
  await expect(card.getByRole("button", { name: "Confirm", exact: true })).toBeVisible()
  expect(writes).toHaveLength(0)
  await card.getByRole("button", { name: "Confirm", exact: true }).press("Enter")
  await expect(card.getByText("403", { exact: true })).toBeVisible()
  await expect(card).toContainText("permission")
  expect(writes).toHaveLength(1)
  await expect(card.getByLabel("Token", { exact: true })).toHaveCount(0)
  await expect(page.getByTestId("composer-input")).toBeEditable()
})
