import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-UI-04.md.
// Integration and reference-host evidence remains required separately.
// Written before implementation: mvp.md §6.4, M-08, M-14; lands with T-APP-07
test("C-UI-04: Edge map and timeline: shared entries, per-viewer actions, live summaries, toasts", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md §6.4, M-08, M-14; lands with T-APP-07")
  // Required seed: shared Maya/Alice conversation with timed live events,
  // ASK, FAIL and PR entries; owner/propmter-specific notices and summaries.
  // Real summary-worker timing and transaction checks remain separate.
  await owner(page)
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto("/")
  await say(page, "/todo T9")
  const timeline = page.getByRole("navigation", { name: "Timeline", exact: true })
  await expect(timeline).toBeVisible()
  const question = timeline.getByRole("button", { name: /retry-webhooks/ })
  await expect(question).toContainText("Asks: backoff or timeout?")
  await question.press("Enter")
  await expect(page.locator(".smithers-card", { hasText: "T9" }).last()).toBeInViewport()
  await expect(page.getByRole("button", { name: "Answer", exact: true }).first()).toBeVisible()
  await page.getByRole("button", { name: "Hide", exact: true }).first().press("Enter")
  await expect(question).toBeVisible()
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(timeline).toBeHidden()
  await page.keyboard.press("End")
  await expect(page.getByRole("button", { name: "↑ 1 live above", exact: true })).toBeVisible()
  await page.reload()
  await expect(page.getByRole("button", { name: "Hide", exact: true })).toHaveCount(0)
})
