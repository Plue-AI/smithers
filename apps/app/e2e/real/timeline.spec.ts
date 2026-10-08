import { readFileSync } from "node:fs"
import { test, expect, type Page } from "@playwright/test"
import { memberRequest } from "./support/seed-stack"

test("a committed live TODO reaches both members through the install seam", async ({ browser }) => {
  const host = JSON.parse(readFileSync(process.env.SMITHERS_TIMELINE_INSTALL!, "utf8")) as {
    origin: string; repository: string; members: Record<string, Array<{ name: string; value: string }>>; todos: { live: number }
  }
  const contexts = []
  try {
    for (const [who, width] of [["Maya", 1440], ["Alice", 900]] as const) {
      const context = await browser.newContext({ baseURL: host.origin, viewport: { width, height: 1000 } })
      contexts.push(context)
      await context.addCookies(host.members[who]!.map(cookie => ({ ...cookie, url: host.origin })))
      const page = await context.newPage()
      await page.goto(`/${host.repository}`)
      const timeline = page.getByRole("navigation", { name: "Timeline", exact: true })
      if (width === 900) {
        await expect(timeline).toBeHidden()
        await page.setViewportSize({ width: 1440, height: 1000 })
      }
      const line = timeline.locator(`[data-entry="todo:${host.todos.live}"]`)
      await expect(line).toHaveCount(1)
      await expect(line).toHaveAttribute("data-tone", "live")
      await line.getByRole("button").first().press("Enter")
      await expect(page.locator(`[data-message-id="todo:${host.todos.live}"]`)).toBeInViewport()
      await expect(page.getByTestId("composer-input")).toBeEditable()
      const history = await memberRequest(page, "GET", "/api/conversations/main")
      expect(history.status).toBe(200)
      expect(history.body.entries.find((entry: any) => entry.subject?.n === host.todos.live).subject).toMatchObject({ state: "working", tone: "live" })
      if (who === "Alice") {
        const hidden = await memberRequest(page, "PUT", "/api/conversations/main/view-state", { toasts_hidden: true }, "live-entry-hide")
        expect(hidden.status).toBe(200)
        await page.reload()
        await expect(line).toHaveCount(1)
        await expect(line).toHaveAttribute("data-tone", "live")
        expect((await memberRequest(page, "GET", "/api/conversations/main/view-state")).body.toasts_hidden).toBe(true)
        await line.getByRole("button").first().press("Enter")
        await expect(page.locator(`[data-message-id="todo:${host.todos.live}"]`)).toBeInViewport()
        await expect(page.getByTestId("composer-input")).toBeEditable()
        const maya = contexts[0]!.pages()[0]!
        expect((await memberRequest(maya, "GET", "/api/conversations/main/view-state")).body.toasts_hidden).not.toBe(true)
        await expect(maya.getByRole("navigation", { name: "Timeline", exact: true }).locator(`[data-entry="todo:${host.todos.live}"]`)).toHaveAttribute("data-tone", "live")
      }
    }
  } finally { for (const context of contexts) await context.close() }
})

// TestConversationTimelineInstallBrowser owns a real composed install,
// PostgreSQL and GitHub fake. No browser route or live frame is intercepted.
test("shared TODO entries reach both members' timeline and narrow edge", async ({ browser }) => {
  const host = JSON.parse(readFileSync(process.env.SMITHERS_TIMELINE_INSTALL!, "utf8")) as {
    origin: string; repository: string; members: Record<string, Array<{ name: string; value: string }>>;
    todos: { ready: number; ask: number; fail: number; live: number }
  }
  const member = async (who: string, width: number) => {
    const context = await browser.newContext({ baseURL: host.origin, viewport: { width, height: 1000 } })
    await context.addCookies(host.members[who]!.map(cookie => ({ ...cookie, url: host.origin })))
    const page = await context.newPage()
    await page.goto(`/${host.repository}`)
    await expect(page.getByTestId("composer-input")).toBeEditable()
    return { context, page }
  }
  const maya = await member("Maya", 1440), alice = await member("Alice", 900)
  try {
    const timeline = (page: Page) => page.getByRole("navigation", { name: "Timeline", exact: true })
    const line = (page: Page, n: number) => timeline(page).locator(`[data-entry="todo:${n}"]`)
    await expect(timeline(maya.page)).toBeVisible()
    for (const [n, tone] of [[host.todos.live, "live"], [host.todos.ask, "attention"], [host.todos.fail, "failed"], [host.todos.ready, "quiet"]] as const) {
      await expect(line(maya.page, n)).toHaveAttribute("data-tone", tone)
      await expect(line(maya.page, n)).toHaveCount(1)
    }
    await expect(line(maya.page, host.todos.ask).getByRole("button", { name: "Answer", exact: true })).toBeVisible()
    await expect(line(maya.page, host.todos.fail).getByRole("button", { name: "Retry", exact: true })).toBeVisible()
    await expect(line(maya.page, host.todos.ready).getByRole("button", { name: "Merge", exact: true })).toBeVisible()
    await expect(timeline(alice.page)).toBeHidden()
    await alice.page.setViewportSize({ width: 1440, height: 1000 })
    await expect(line(alice.page, host.todos.ask).getByRole("button", { name: "Answer", exact: true })).toBeVisible()
    await expect(line(alice.page, host.todos.ready).getByRole("button", { name: "Merge", exact: true })).toHaveCount(0)
    // Jump uses the shared card's real transcript address and leaves Chat usable.
    await line(maya.page, host.todos.ask).getByRole("button").first().press("Enter")
    await expect(maya.page.locator(`[data-message-id="todo:${host.todos.ask}"]`)).toBeInViewport()
    const history = await memberRequest(alice.page, "GET", "/api/conversations/main")
    expect(history.status).toBe(200)
    const subjects = history.body.entries.filter((entry: any) => entry.subject)
    expect(subjects.map((entry: any) => entry.subject.n)).toEqual([host.todos.ready, host.todos.ask, host.todos.fail, host.todos.live])
    // Hiding is a private production view-state write; entries survive reload.
    const hidden = await memberRequest(alice.page, "PUT", "/api/conversations/main/view-state", { toasts_hidden: true }, "timeline-hide")
    expect(hidden.status).toBe(200)
    await alice.page.reload()
    await expect(line(alice.page, host.todos.fail)).toHaveAttribute("data-tone", "failed")
    expect((await memberRequest(maya.page, "GET", "/api/conversations/main/view-state")).body.toasts_hidden).not.toBe(true)
    await alice.page.setViewportSize({ width: 900, height: 1000 })
    await expect(timeline(alice.page)).toBeHidden()
    // The live entry is below the older ASK card; the edge retains its address.
    await expect(alice.page.getByTestId("composer-input")).toBeEditable()
    await expect(maya.page.getByTestId("composer-input")).toBeEditable()
  } finally { await maya.context.close(); await alice.context.close() }
})
