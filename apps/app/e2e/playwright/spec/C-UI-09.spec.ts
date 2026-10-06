import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// Bundled production pages and real app flows; the model is deterministic.
test("C-UI-09: Bundled docs open pages and anchors through every door", async ({ page }) => {
  await owner(page)
  await page.route("**/api/agent/**", route => route.continue())
  await page.goto("/")
  const outside: string[] = []
  const origin = new URL(page.url()).origin
  page.on("request", request => { if (new URL(request.url()).origin !== origin) outside.push(request.url()) })
  await say(page, "/docs")
  const quickstart = page.getByRole("article", { name: "Docs", exact: true }).filter({ has: page.getByRole("heading", { name: "Quickstart", exact: true }) })
  await expect(quickstart.getByRole("navigation", { name: "Docs pages" }).getByRole("link")).toHaveText(["Quickstart", "Flows reference"])
  await expect(page.getByTestId("composer-input")).toBeEditable()
  await quickstart.getByRole("link", { name: "Flows reference", exact: true }).last().press("Enter")
  const reference = page.getByRole("article", { name: "Docs", exact: true }).filter({ has: page.getByRole("heading", { name: "Flows reference", exact: true }) })
  await expect(reference.locator("#find-a-command")).toBeVisible()
  await reference.getByRole("link", { name: "Quickstart", exact: true }).last().press("Enter")
  await expect(quickstart.locator("#open-the-command-list")).toBeInViewport()
  await quickstart.getByRole("link", { name: "Flows reference", exact: true }).first().press("Enter")
  await expect(reference.getByRole("heading", { name: "Find a command", exact: true })).toBeVisible()
  await reference.getByRole("navigation", { name: "Docs pages" }).getByRole("link", { name: "Quickstart", exact: true }).press("Enter")
  await expect(quickstart).toBeVisible()
  await say(page, "/docs quickstart#put-https-in-front")
  await expect(quickstart.locator("#put-https-in-front")).toBeInViewport()
  await say(page, "How do I put HTTPS in front?")
  await expect(page.getByText(/^docs.read quickstart:/).last()).toContainText("tailscale serve http://localhost:4000", { timeout: 30_000 })
  await say(page, "/docs no-such-page")
  await expect(quickstart).toContainText("Page not found: no-such-page")
  await expect(page.locator(".mvp-docs-missing")).toHaveCount(1)
  await page.reload()
  await expect(quickstart).toContainText("Page not found: no-such-page")
  await expect(page.getByTestId("composer-input")).toBeEditable()
  expect(outside).toEqual([])
})
