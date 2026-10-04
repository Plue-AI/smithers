import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of C-UI-09; acceptance now lives in T-APP-20.
// Reference-host and integration evidence remains required separately.
// Written before implementation: mvp.md M-35, Appendix A /docs; lands with T-APP-20
test("C-UI-09: Bundled docs open pages and anchors through every door", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md M-35, Appendix A /docs; lands with T-APP-20")
  // Required seed: bundled quickstart/reference pages and a docs-reading agent.
  await owner(page)
  await page.goto("/")
  await say(page, "/docs")
  const card = page.locator(".smithers-card").last()
  await expect(card).toContainText("Quickstart")
  await expect(card.getByRole("link", { name: "Flows", exact: true })).toBeVisible()
  await card.getByRole("link", { name: "Flows", exact: true }).press("Enter")
  await expect(page.locator(".smithers-card").last()).toContainText("Flows")
  await say(page, "/docs quickstart#put-https-in-front")
  await expect(page.getByRole("heading", { name: "Put HTTPS in front", exact: true })).toBeInViewport()
  await say(page, "How do I put HTTPS in front?")
  await page.getByRole("link", { name: "Quickstart", exact: true }).last().press("Enter")
  await expect(page.getByRole("heading", { name: "Put HTTPS in front", exact: true }).last()).toBeVisible()
  await say(page, "/docs no-such-page")
  await expect(page.locator(".smithers-card").last()).toContainText("Quickstart")
  await expect(page.locator(".smithers-card").last()).toContainText("Not found")
  await page.reload()
  await expect(page.locator(".smithers-card").last()).toContainText("Quickstart")
})
