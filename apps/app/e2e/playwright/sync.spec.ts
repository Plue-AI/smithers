import { expect, test } from "./browserTest"
import type { Page } from "./browserTest"
import { installCloudFixture } from "./cloudFixture"
import { installFixture } from "../../src/mainview/state/seams/InstallFixtures.test-support"
import { fillComposer } from "./composer"

const serve = async (page: Page): Promise<void> => {
  await installCloudFixture(page, { capabilities: ["identity", "install"] })
  await page.route(url => url.pathname === "/api/user" || url.pathname === "/api/auth/session", route => route.fulfill({ json: { id: 1, username: "canary-owner", is_admin: false } }))
  await page.route("**/api/members", route => route.fulfill({ json: { members: [{ login: "canary-owner", name: "Will", avatar_url: "https://example.test/owner.png", color_index: 0, role: "owner", needs_access: false, suspended: false, actions: [] }], access_url: "https://github.com/smithersai/smithers/settings/access" } }))
  await page.route("**/api/conversations/main/view-state", route => route.fulfill({ json: { toasts_hidden: false, global_toasts_hidden: false } }))
  await page.route("**/api/install", route => route.fulfill({ json: installFixture() }))
  await page.route("**/api/todos", route => route.fulfill({ json: [] }))
  await page.route("**/api/conversations/main", route => route.fulfill({ json: { id: "main", entries: [] } }))
}

const runSlash = async (page: Page, command: string): Promise<void> => {
  await fillComposer(page, command)
  await page.getByTestId("composer-input").press("Enter")
}

test("the install refuses the retired Cloud import door without starting a job", async ({ page }) => {
  await serve(page)
  const imports: string[] = []
  await page.route("**/api/github/import**", route => {
    imports.push(route.request().url())
    return route.fulfill({ status: 503, json: {} })
  })
  await page.goto("/")
  await runSlash(page, "/repos.import smithersai/smithers")
  await runSlash(page, "/help")
  const help = page.getByRole("article", { name: "Commands", exact: true })
  await expect(help).toBeVisible()
  await expect(help).not.toContainText("/repos.import")
  await expect(page.locator(".home").first()).toContainText("smithersai/smithers")

  await expect(page.getByTestId("card-repo-import-smithersai/smithers")).toHaveCount(0)
  expect(imports).toEqual([])
})

test("CAP-004: unresolved GitHub sync launch leaves Chat usable and progress lasts through execution", async ({ page }) => {
  await serve(page)
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  let accepted = false, posts = 0, finished = false
  await page.route("**/api/github/sync", async route => {
    if (route.request().method() === "POST") {
      posts++
      expect(route.request().headers()["idempotency-key"]).toBeTruthy()
      await pending
      await route.fulfill({ status: 202, json: { state: "accepted" } })
      accepted = true
    } else await route.fulfill({ json: { state: finished ? "fresh" : "stale", last_success_at: finished ? "2026-10-08T12:00:00Z" : null } })
  })
  try {
    await page.goto("/")
    const sync = page.locator(".home .sync").first()
    await expect(sync).toHaveAttribute("data-health", "stale")
    await page.getByRole("button", { name: "Retry", exact: true }).first().press("Enter")
    await expect.poll(() => posts).toBe(1)
    await page.getByRole("button", { name: "Retry", exact: true }).first().press("Enter")
    await fillComposer(page, "Chat remains usable while this launches")
    await expect(page.getByTestId("composer-input")).toHaveValue("Chat remains usable while this launches")
    const progress = page.getByText("Syncing GitHub", { exact: true })
    await expect(progress).toBeVisible()
    expect(accepted).toBe(false)
    expect(posts).toBe(1)
    release()
    await expect.poll(() => accepted).toBe(true)
    await expect(progress).toBeVisible()
    await expect(sync).toHaveAttribute("data-health", "stale")
    finished = true
    await expect(sync).toHaveAttribute("data-health", "fresh", { timeout: 20_000 })
    await expect(progress).toHaveCount(0)
    expect(posts).toBe(1)
    await expect(page.getByTestId("composer-input")).toHaveValue("Chat remains usable while this launches")
  } finally { release() }
})
