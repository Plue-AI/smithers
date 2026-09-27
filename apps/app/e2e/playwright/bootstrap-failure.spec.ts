import { expect, test } from "./browserTest"

for (const [kind, fulfill] of [
  ["unreachable", async (route: import("@playwright/test").Route) => route.abort("failed")],
  ["missing", async (route: import("@playwright/test").Route) => route.fulfill({ status: 404, body: "404" })],
  ["server", async (route: import("@playwright/test").Route) => route.fulfill({ status: 503, body: "bad gateway" })],
  ["invalid", async (route: import("@playwright/test").Route) => route.fulfill({ status: 200, contentType: "application/json", body: "{}" })]
] as const) {
  test(`real web app recovers from ${kind} bootstrap`, async ({ page }) => {
    await page.route("**/api/bootstrap", fulfill)
    await page.goto("/")
    await expect(page.getByRole("heading", { name: "Backend unavailable" })).toBeVisible()
    await expect(page.locator("main")).toContainText("Not your fault.")
    await expect(page.locator("main")).not.toContainText("404")
    await expect(page.locator("main").getByRole("button")).toHaveText(["Retry"])
    await page.unroute("**/api/bootstrap", fulfill)
    await page.getByRole("button", { name: "Retry" }).click()
    await expect(page.getByRole("heading", { name: "Backend unavailable" })).toHaveCount(0)
  })
}
