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

// The served TODO path is independent of the pending shared-entry/summary journey.
test("C-UI-04: served failure has one rail action and keyboard Retry uses the production seam", async ({ page }) => {
  await owner(page)
  await page.setViewportSize({ width: 1440, height: 1000 })
  const model = {
    n: 24, title: "Retry from the install", state: "failed",
    owner: { login: "canary-owner", name: "Ben", avatar_url: "https://example.test/avatar.png" },
    prompt_revisions: [], steps: [], steers: [], evidence: [], present: [], waits: [],
    merge: { state: "waiting", reason: "state", on_github: false },
    failure: { class: "checks", step: "Check", message: "Checks failed", retryable: true }
  }
  const requests: unknown[] = []
  await page.route("**/api/todos", route => route.fulfill({ json: [model] }))
  await page.route("**/api/todos/24", async route => {
    if (route.request().method() === "POST") {
      requests.push(route.request().postDataJSON())
      await route.fulfill({ status: 202, json: { state: "accepted" } })
    } else await route.fulfill({ json: model })
  })
  await page.goto("/")
  await say(page, "/todo T24")
  const line = page.getByRole("navigation", { name: "Timeline", exact: true }).locator('[data-entry="todo:24"]')
  await expect(line).toContainText("Retry from the install")
  await expect(line).toHaveAttribute("data-tone", "failed")
  await line.getByRole("button", { name: "Retry", exact: true }).press("Enter")
  await expect.poll(() => requests).toEqual([{ op: "retry" }])
  await expect(page.getByTestId("composer-input")).toBeEditable()
  await page.setViewportSize({ width: 900, height: 1000 })
  await expect(page.getByRole("navigation", { name: "Timeline", exact: true })).toBeHidden()
})

test("C-UI-04: the owner's served merge raises a terminal notice and Hide preserves its timeline entry", async ({ page }) => {
  await owner(page)
  await page.setViewportSize({ width: 1440, height: 1000 })
  let state = "in_review"
  const model = () => ({
    n: 24, title: "Merge notice from the install", state,
    owner: { login: "canary-owner", name: "Ben", avatar_url: "https://example.test/avatar.png" },
    prompt_revisions: [], steps: [], steers: [], evidence: [], present: [], waits: [],
    merge: { state: "waiting", reason: "state", on_github: false }
  })
  await page.route("**/api/todos", route => route.fulfill({ json: [model()] }))
  await page.route("**/api/todos/24", route => route.fulfill({ json: model() }))
  await page.goto("/")
  await say(page, "/todo T24")
  const line = page.getByRole("navigation", { name: "Timeline", exact: true }).locator('[data-entry="todo:24"]')
  await expect(line).toContainText("Merge notice from the install")
  state = "merged"
  const notice = page.locator('[data-notice="toast-todo.merged.24.no-run.0"]')
  await expect(notice).toBeVisible()
  await expect(notice).toHaveAttribute("data-tone", "done")
  await expect(notice).toContainText("Merged")
  await expect(notice.locator("[data-flow]")).toHaveCount(0)
  await notice.getByRole("button", { name: "Hide Merge notice from the install", exact: true }).press("Enter")
  await expect(notice).toHaveCount(0)
  await expect(line).toHaveAttribute("data-tone", "done")
  await expect(page.getByTestId("composer-input")).toBeEditable()
})
