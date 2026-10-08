import { expect, test } from "../browserTest"
import { say } from "./j1-fixtures"
import { installCloudFixture } from "../cloudFixture"

// The real app docs dispatcher, bundled loader and Docs renderer behind the
// branch HTTP/live seams. The agent case (the app agent answers "how do I"
// from `docs` read mode) runs on the composed install with the packaged model
// host: packages/backend/internal/compose/docs_agent_integration_test.go.
// macOS WebKit remains a separate receipt.
test("C-UI-09: Bundled docs open pages and anchors through every door", async ({ page }) => {
  await installCloudFixture(page, { capabilities: ["identity", "install"] })
  await page.route(url => url.pathname === "/api/user" || url.pathname === "/api/auth/session", route => route.fulfill({ json: { id: 1, username: "canary-owner", is_admin: false } }))
  const entries: unknown[] = []
  let cursor = 0
  const retired: string[] = []
  page.on("request", request => { if (new URL(request.url()).pathname.startsWith("/api/agent/")) retired.push(request.url()) })
  await page.route("**/api/conversations/main/view-state", route => route.fulfill({ json: {} }))
  await page.route("**/api/conversations/main", route => route.fulfill({ json: { id: "main", entries } }))
  await page.routeWebSocket("**/api/live", socket => socket.onMessage(raw => {
    const frame = JSON.parse(String(raw))
    if (frame.t !== "sub") return
    if (frame.topic !== "conversation:main") {
      socket.send(JSON.stringify({ t: "err", id: frame.id, code: "unsupported" }))
      return
    }
    socket.send(JSON.stringify({ t: "snap", id: frame.id, cursor: ++cursor, data: { id: "main", entries } }))
  }))
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
  await expect(quickstart.locator("#first-todo-to-merged")).toBeInViewport()
  await quickstart.getByRole("link", { name: "Flows reference", exact: true }).first().press("Enter")
  await expect(reference.getByRole("heading", { name: "Find a command", exact: true })).toBeVisible()
  await reference.getByRole("navigation", { name: "Docs pages" }).getByRole("link", { name: "Quickstart", exact: true }).press("Enter")
  await expect(quickstart).toBeVisible()
  await say(page, "/docs quickstart#put-https-in-front")
  await expect(quickstart.locator("#put-https-in-front")).toBeInViewport()
  await say(page, "/docs no-such-page")
  await expect(quickstart).toContainText("Page not found: no-such-page")
  await expect(page.locator(".mvp-docs-missing")).toHaveCount(1)
  await page.reload()
  await expect(quickstart).toContainText("Page not found: no-such-page")
  await expect(page.getByTestId("composer-input")).toBeEditable()
  expect(retired).toEqual([])
  expect(outside).toEqual([])
})
