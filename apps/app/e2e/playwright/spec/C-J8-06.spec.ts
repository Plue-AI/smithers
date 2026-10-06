import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"
import { installCloudFixture } from "../cloudFixture"
import { installFixture } from "../../../src/mainview/state/seams/InstallFixtures.test-support"

// UI projection of .specs/engineering/checks/C-J8-06.md.
// Written before implementation: mvp.md §6.11 Generated pages, §6.12, §6.4, M-11; lands with T-FLW-02, T-APP-01, T-REL-02
test("C-J8-06: generated wiki refresh retries and dismissal persist for everyone", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md §6.11 Generated pages, §6.12, §6.4, M-11; lands with T-FLW-02, T-APP-01, T-REL-02")
// Seed T1–T3 with healthCheck, readyCheck and web patches. Test-world T2/T3
// refreshes fail once; Retry succeeds. Both members share the same world.
// GitHub timing, flow pinning and dismissed_by need reference-host receipts.
  await owner(page)
  await page.goto('/smithers-mvp-canary/node')
  const ben = await page.context().browser()!.newContext()
  const other = await ben.newPage()
  try {
    await owner(other)
    await other.route('**/api/user', route => route.fulfill({ json: { id: 2, username: 'ben', is_admin: false } }))
    await other.goto('/smithers-mvp-canary/node')
    await say(page, '/wiki.page api')
    await expect(page.getByText('r1', { exact: true }).last()).toBeVisible()
    for (const ref of ['T1', 'T2', 'T3']) {
      await say(other, `/todo ${ref}`)
      await other.getByRole('button', { name: 'Merge', exact: true }).last().press('Enter')
      await other.getByRole('button', { name: 'Merge', exact: true }).last().press('Enter')
      await say(page, '/stack')
      await say(other, '/stack')
      if (ref === 'T1') {
        await expect(page.getByText(/Wiki refresh/).last()).toBeVisible()
        await expect(other.getByText(/Wiki refresh/).last()).toBeVisible()
        await say(page, '/wiki.page api')
        await expect(page.getByText(/healthCheck/).last()).toBeVisible()
        await expect(page.getByText('r2', { exact: true }).last()).toBeVisible()
        await page.getByRole('button', { name: /History/ }).last().press('Enter')
        await expect(page.getByText('Smithers', { exact: true }).last()).toBeVisible()
      } else {
        for (const browserPage of [page, other]) {
          await expect(browserPage.getByRole('button', { name: 'Retry', exact: true }).last()).toBeVisible()
          await expect(browserPage.getByRole('button', { name: 'Dismiss', exact: true }).last()).toBeVisible()
        }
        if (ref === 'T2') {
          await other.getByRole('button', { name: 'Retry', exact: true }).last().press('Enter')
          await say(page, '/wiki.page api')
          await expect(page.getByText(/readyCheck/).last()).toBeVisible()
          await expect(page.getByText('r3', { exact: true }).last()).toBeVisible()
        } else {
          await page.getByRole('button', { name: 'Dismiss', exact: true }).last().press('Enter')
          for (const browserPage of [page, other]) {
            await browserPage.reload()
            await say(browserPage, '/stack')
            await expect(browserPage.getByRole('button', { name: 'Dismiss', exact: true })).toHaveCount(0)
          }
          await say(page, '/monitor')
          await expect(page.getByText(/Wiki refresh/).last()).toBeVisible()
        }
      }
    }
  } finally { await ben.close() }
})

// Component evidence through the mounted install live seam. Shared run controls
// and generated page publication remain the reference-host scenario above.
test("C-J8-06: Home follows the install wiki refresh through failure and completion", async ({ page }) => {
  await installCloudFixture(page, { capabilities: ["identity", "install"] })
  await page.route("**/api/user", route => route.fulfill({ json: { id: 1, username: "maya", is_admin: false } }))
  await page.route("**/api/install", route => route.fulfill({ json: installFixture() }))
  await page.route("**/api/todos", route => route.fulfill({ json: [] }))
  await page.route("**/api/conversations/main", route => route.fulfill({ json: { id: "main", entries: [] } }))
  await page.route("**/api/conversations/main/view-state", route => route.fulfill({ json: {} }))
  let runs: unknown[] = [{ id: "wiki-run-1", title: "Refresh wiki", state: "running", actions: [] }]
  const publishers: Array<() => void> = []
  const home = () => ({ repository: "owner/repo", main: { sha: "a".repeat(40), title: "main", last_success_at: "2026-10-06T00:00:00Z", health: "fresh" },
    attention: [], items: [], counts: { queued: 0, starting: 0, working: 0, needs_you: 0, paused: 0, failed: 0, in_review: 0, merged: 0, dropped: 0 },
    merged_since_last_look: [], machines: { in_use: 0, capacity: 2, slots: [] }, background_runs: runs })
  await page.routeWebSocket("**/api/live", socket => socket.onMessage(raw => {
    const frame = JSON.parse(String(raw))
    if (frame.t !== "sub") return
    if (frame.topic !== "home") { socket.send(JSON.stringify({ t: "err", id: frame.id, code: "unsupported" })); return }
    let cursor = 0
    const publish = () => socket.send(JSON.stringify({ t: "snap", id: frame.id, cursor: ++cursor, data: home() }))
    publishers.push(publish); publish()
  }))
  await page.goto("/")
  await say(page, "/stack")
  const card = page.getByRole("region", { name: "owner/repo", exact: true }).last()
  await expect(card).toContainText("Refresh wiki")
  await expect(card).not.toContainText("Learning")
  await expect(page.getByTestId("composer-input")).toBeEditable()
  runs = [{ id: "wiki-run-1", title: "Refresh wiki", state: "failed", detail: "Page review failed", actions: [] }]
  publishers.forEach(publish => publish())
  await expect(card).toContainText("Page review failed")
  await page.reload()
  await say(page, "/stack")
  await expect(card).toContainText("Page review failed")
  runs = []
  publishers.forEach(publish => publish())
  await expect(card).not.toContainText("Refresh wiki")
  await expect(page.getByTestId("composer-input")).toBeEditable()
})
