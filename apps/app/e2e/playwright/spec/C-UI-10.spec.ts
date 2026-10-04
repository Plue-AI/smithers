import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of C-UI-10; acceptance now lives in T-APP-21.
// Reference-host and integration evidence remains required separately.
// Written before implementation: mvp.md M-36, §6.14, Appendix A /debug-api; lands with T-APP-21
test("C-UI-10: API playground requires confirmation and preserves member rights", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md M-36, §6.14, Appendix A /debug-api; lands with T-APP-21")
  // Required seed: Member Ben, documented install operations, real permission
  // envelopes and a recording mutation endpoint; no token entry or Plue routes.
  await owner(page)
  await page.route("**/api/user", route => route.fulfill({ json: { id: 2, username: "ben", is_admin: false } }))
  const mutations: string[] = []
  page.on("request", request => {
    if (request.method() === "PUT" && new URL(request.url()).pathname === "/api/secrets") mutations.push(request.url())
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
  await expect(card).toContainText("PUT /api/secrets")
  await expect(card.getByText("403", { exact: true })).toHaveCount(0)
  expect(mutations).toHaveLength(0)
  await card.getByRole("button", { name: "Confirm", exact: true }).press("Enter")
  await expect(card.getByText("403", { exact: true })).toBeVisible()
  await expect(card).toContainText("permission")
  expect(mutations).toHaveLength(1)
  await expect(card.getByLabel("Token", { exact: true })).toHaveCount(0)
  await expect(card).not.toContainText("canary-secret-value")
  await expect(page.getByTestId("composer-input")).toBeEnabled()
})
