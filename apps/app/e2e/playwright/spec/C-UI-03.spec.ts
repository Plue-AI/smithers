import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-UI-03.md.
// Integration and reference-host evidence remains required separately.
// Written before implementation: mvp.md §6.4 Browser notifications; lands with T-APP-18
test("C-UI-03: Browser notifications on secure origins", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md §6.4 Browser notifications; lands with T-APP-18")
  // Required seed: Ben's first Needs you; later question, review and failure
  // events controlled independently of navigation, plus a plain-HTTP origin.
  // Observe the browser boundary without asking the CI operator for consent.
  await page.addInitScript(() => {
    const notifications: Array<{ title: string; click: () => void }> = []
    let requests = 0
    class RecordedNotification {
      static permission = "default"
      static async requestPermission() { requests++; this.permission = "granted"; return "granted" }
      onclick: (() => void) | null = null
      constructor(readonly title: string) {
        notifications.push({ title, click: () => this.onclick?.() })
      }
      close() {}
      static observations() { return { requests, titles: notifications.map(each => each.title) } }
      static openReview() { notifications.find(each => /In review/.test(each.title))?.click() }
    }
    Object.defineProperty(window, "Notification", { value: RecordedNotification })
  })
  await owner(page)
  await page.goto("/")
  await say(page, "/todo T9")
  const allow = page.getByRole("button", { name: "Allow notifications", exact: true })
  await expect(allow).toBeVisible()
  const observations = () => page.evaluate(() => (Notification as unknown as {
    observations(): { requests: number; titles: string[] }
  }).observations())
  expect(await observations()).toEqual({ requests: 0, titles: [] })
  await allow.press("Enter")
  expect((await observations()).requests).toBe(1)
  await expect(allow).toHaveCount(0)
  // The seed emits the next question, review and failure only while hidden.
  const otherTab = await page.context().newPage()
  await otherTab.goto("about:blank")
  await otherTab.bringToFront()
  await expect.poll(async () => (await observations()).titles).toEqual([
    "Needs you", "In review", "Failed"
  ])
  await page.evaluate(() => (Notification as unknown as { openReview(): void }).openReview())
  await page.bringToFront()
  await expect(page.locator(".smithers-card").last()).toContainText("T9")
  // Required second origin: the configured plain-HTTP LAN address.
  await page.goto("http://smithers-canary.local:4000/")
  await say(page, "/settings")
  await expect(page.getByRole("link", { name: /Notifications need HTTPS/ })).toBeVisible()
  await expect(allow).toHaveCount(0)
  // Insecure-origin fixture events must produce toasts, without browser calls.
  expect(await observations()).toEqual({ requests: 0, titles: [] })
})
