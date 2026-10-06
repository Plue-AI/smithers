import { expect, test } from "../browserTest"
import { say } from "./j1-fixtures"
import { installCloudFixture } from "../cloudFixture"
import { installFixture } from "../../../src/mainview/state/seams/InstallFixtures.test-support"
import { fixtures } from "../../../../../packages/rpc/test/fixtures/Todo"
import type { TodoCard } from "@smthrs/rpc/TodoCard"

// Browser receipt through the production HTTP seam, dispatcher and card views.
// Request accounting/cadences are proved by the composed backend tests; this
// fixture does not qualify real GitHub freshness or the native reference host.
test("C-GH-08: ten pending PRs retain automatic sync while Chat remains usable", async ({ page }) => {
  await installCloudFixture(page, { capabilities: ["identity", "install"] })
  await page.route("**/api/user", route => route.fulfill({ json: { id: 1, username: "canary-owner", is_admin: false } }))
  await page.route("**/api/install", route => route.fulfill({ json: installFixture() }))
  await page.route("**/api/members", route => route.fulfill({ json: {
    members: [{ login: "canary-owner", name: "Will", avatar_url: "https://example.com/owner.png", color_index: 0,
      role: "owner", needs_access: false, suspended: false, actions: [] }],
    access_url: "https://github.com/smithers-mvp-canary/node/settings/access"
  } }))
  const models: TodoCard[] = Array.from({ length: 10 }, (_, index) => ({
    ...structuredClone(fixtures.in_review.model), n: index + 1, place: index + 1, title: `Polling TODO ${index + 1}`
  }))
  const reads = new Map<number, number>()
  const writes: string[] = []
  let hold = false, held = false
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  await page.route("**/api/todos", route => route.fulfill({ json: models }))
  await page.route(url => /^\/api\/todos\/\d+$/.test(url.pathname), async route => {
    const request = route.request(), n = Number(new URL(request.url()).pathname.split("/")[3])
    if (request.method() !== "GET") writes.push(request.method())
    reads.set(n, (reads.get(n) ?? 0) + 1)
    if (hold && n === 1) { held = true; await pending }
    await route.fulfill({ json: models[n - 1] })
  })
  await page.route("**/api/github/sync", route => {
    if (route.request().method() !== "GET") writes.push("sync")
    return route.fulfill({ json: { state: "fresh", last_success_at: new Date().toISOString() } })
  })
  try {
    await page.goto("/")
    const card = (n: number) => page.getByRole("article", { name: `TODO T${n}`, exact: true }).last()
    for (let n = 1; n <= 10; n++) {
      await say(page, `/todo T${n}`)
      await expect(card(n)).toContainText(`Polling TODO ${n}`)
      await expect(card(n).locator("header .state")).toHaveText("In review")
      expect(reads.get(n)).toBeGreaterThan(0)
    }
    hold = true
    await expect.poll(() => held).toBe(true)
    await say(page, "/help")
    await expect(page.locator(".smithers-card").last()).toContainText("Commands")
    await expect(page.getByTestId("composer-input")).toBeEditable()
    models[0]!.title = "Updated by automatic polling"
    hold = false; release()
    await expect(card(1)).toContainText("Updated by automatic polling")
    await expect(card(1).locator("header .state")).toHaveText("In review")
    expect(writes).toEqual([])
  } finally { release() }
})
