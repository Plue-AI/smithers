import { expect, test } from "../browserTest"
import { say } from "./j1-fixtures"
import { installCloudFixture } from "../cloudFixture"
import { execFileSync } from "node:child_process"
import { resolve } from "node:path"

// Real app docs dispatcher/loader and branch HTTP/live seams with a contract
// fixture. Composed-install model execution and macOS remain separate receipts.
test("C-UI-09: Bundled docs open pages and anchors through every door", async ({ page }) => {
  await installCloudFixture(page, { capabilities: ["identity", "install"] })
  await page.route("**/api/user", route => route.fulfill({ json: { id: 1, username: "canary-owner", is_admin: false } }))
  let entries: unknown[] = []
  let publish: (() => void) | undefined
  let cursor = 0
  const admissions: string[] = []
  const retired: string[] = []
  page.on("request", request => { if (new URL(request.url()).pathname.startsWith("/api/agent/")) retired.push(request.url()) })
  await page.route("**/api/conversations/main/view-state", route => route.fulfill({ json: {} }))
  await page.route("**/api/conversations/main", route => route.fulfill({ json: { id: "main", entries } }))
  await page.route("**/api/conversations/main/prompt", async route => {
    const body = route.request().postDataJSON()
    expect(body.prompt).toBe("How do I put HTTPS in front?")
    expect(body.idempotencyKey).toEqual(expect.any(String))
    const read = execFileSync("bun", [resolve("e2e/support/DocsReadFixture.ts")], { encoding: "utf8", timeout: 10_000 })
    expect(JSON.parse(read).markdown).toContain("## Put HTTPS in front")
    admissions.push(body.idempotencyKey)
    const runId = "docs-host-run"
    entries = [{ id: body.idempotencyKey, author: 1, authorLogin: "canary-owner", runId,
      prompt: body.prompt, state: "completed", frames: [
        { runId, type: "delta", kind: "text", text: `docs.read quickstart: ${read}` },
        { runId, type: "done", reason: "stop" }
      ] }]
    await route.fulfill({ status: 202, json: { turnId: body.idempotencyKey, terminal: false } })
    publish?.()
  })
  await page.routeWebSocket("**/api/live", socket => socket.onMessage(raw => {
    const frame = JSON.parse(String(raw))
    if (frame.t !== "sub") return
    if (frame.topic !== "conversation:main") {
      socket.send(JSON.stringify({ t: "err", id: frame.id, code: "unsupported" }))
      return
    }
    publish = () => socket.send(JSON.stringify({ t: "snap", id: frame.id, cursor: ++cursor, data: { id: "main", entries } }))
    publish()
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
  await say(page, "How do I put HTTPS in front?")
  await expect(page.getByText(/^docs.read quickstart:/).last()).toContainText("tailscale serve --bg --https=443 http://127.0.0.1:4000", { timeout: 30_000 })
  await say(page, "/docs no-such-page")
  await expect(quickstart).toContainText("Page not found: no-such-page")
  await expect(page.locator(".mvp-docs-missing")).toHaveCount(1)
  await page.reload()
  await expect(quickstart).toContainText("Page not found: no-such-page")
  await expect(page.getByTestId("composer-input")).toBeEditable()
  expect(admissions).toHaveLength(1)
  expect(retired).toEqual([])
  await expect(page.getByText(/^docs.read quickstart:/).last()).toContainText("tailscale serve --bg --https=443 http://127.0.0.1:4000")
  expect(outside).toEqual([])
})
