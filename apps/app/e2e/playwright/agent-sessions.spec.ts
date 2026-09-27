import { expect, test } from "./browserTest"
import { installCloudFixture } from "./cloudFixture"
import { fillComposer } from "./composer"
import { AGENT_SESSION_WIRE } from "../../src/mainview/state/seams/fixtures/AgentSessionWire"

const REPO = "smithersai/smithers"
const BASE = `/api/repos/${REPO}/agent/sessions`
const ACTIVE = "0c3d0c6e-2f6a-4b6e-9c2a-1c0a2b0e5f6a"
const DONE = "7a1e9b52-4c0d-4e8f-b1a2-93c5d6e7f801"

test("cloud session list survives reload and opens and stops rows by keyboard", async ({ page }) => {
  await installCloudFixture(page)
  let stopAttempts = 0
  await page.route(url => url.pathname.startsWith(BASE), route => {
    const request = route.request()
    const path = new URL(request.url()).pathname.slice(BASE.length)
    if (request.method() === "DELETE") {
      expect(path).toBe(`/${ACTIVE}`)
      stopAttempts += 1
      return stopAttempts === 1
        ? route.fulfill({ status: 503, json: { message: "Try stopping again" } })
        : route.fulfill({ status: 204, body: "" })
    }
    if (path === "") return route.fulfill({ json: [
      AGENT_SESSION_WIRE.session({ id: ACTIVE, title: "Fix retries", status: "active" }),
      AGENT_SESSION_WIRE.session({ id: DONE, title: "Review complete", status: "completed", message_count: 0 })
    ] })
    if (path.endsWith("/messages")) return route.fulfill({ json: [] })
    return route.fulfill({ json: AGENT_SESSION_WIRE.session({ id: DONE, title: "Review complete", status: "completed", message_count: 0 }) })
  })
  await page.goto("/")
  await fillComposer(page, `/agent.session.list ${REPO}`)
  await page.getByTestId("composer-send").click()
  await page.keyboard.press("Escape")
  const list = page.getByTestId(`card-agent-sessions-${REPO}`)
  await expect(list).toContainText("Fix retries")
  await expect(list).not.toHaveAttribute("data-maximized", "true")
  await page.reload()
  await expect(list).toContainText("Review complete")
  const done = list.locator(`[data-session="${DONE}"]`)
  await expect(done.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0)
  await done.getByRole("button", { name: "Open", exact: true }).focus()
  await page.keyboard.press("Enter")
  // In chat the session is its subagent card; Enter opens its own tab, which leads back with ctrl+y.
  const detail = page.getByTestId(`subagent-agent-session-${DONE}`)
  await expect(detail).toContainText("Review complete")
  await expect(detail.locator(".subagent-clock")).toContainText("Done")
  await expect(page.getByTestId(`card-agent-session-${DONE}`)).toHaveCount(0)
  await detail.focus()
  await page.keyboard.press("Enter")
  await expect(page.getByTestId("subagent-crumb").filter({ visible: true })).toContainText("Subagent · Review complete")
  await expect(page.getByTestId(`card-agent-session-${DONE}`).getByTestId("agent-session-header")).toContainText("completed")
  await page.keyboard.press("Control+y")
  await expect(detail).toBeVisible()
  const active = list.locator(`[data-session="${ACTIVE}"]`)
  const stop = active.getByRole("button", { name: "Stop", exact: true })
  await expect(stop).toHaveAttribute("data-flow-args", `${ACTIVE} ${REPO}`)
  await stop.focus()
  await page.keyboard.press("Enter")
  await expect(page.locator(".toast-stack")).toContainText("Try stopping again")
  await expect(active).toBeVisible()
  await stop.focus()
  await page.keyboard.press("Enter")
  await expect(active).toHaveCount(0)
  expect(stopAttempts).toBe(2)
  await page.reload()
  await expect(list).toBeVisible()
  await expect(active).toHaveCount(0)
})
