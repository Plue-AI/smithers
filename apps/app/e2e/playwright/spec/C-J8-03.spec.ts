import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"
import { installFixture } from "../../../src/mainview/state/seams/InstallFixtures.test-support"

// Browser proof of the Settings → production dispatcher → install seam door.
// Real PostgreSQL/folder reconciliation is covered by the composed-router Go test;
// reference-host timing and screenshots remain C-J8-03 release evidence.
test("C-J8-03: owner changes the folder and sees sync status and refusals", async ({ page }) => {
  await owner(page)
  let model = { ...installFixture(), wiki_sync: { obsidian: { path: "/Users/owner/Vault", last_sync_at: "2026-10-04T12:00:00Z", error: "" } } }
  const writes: unknown[] = []
  await page.route("**/api/install", async route => {
    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON()
      writes.push(body)
      if (body["wiki_sync.obsidian"].path === "/state") {
        await route.fulfill({ status: 400, json: { code: "folder_refused", class: "user", message: "Obsidian folder refused" } }); return
      }
      model = { ...model, wiki_sync: { obsidian: { ...model.wiki_sync.obsidian, path: body["wiki_sync.obsidian"].path } } }
    }
    await route.fulfill({ json: model })
  })
  await page.goto("/")
  await say(page, "/settings")
  const card = page.getByTestId("card-settings")
  const folder = card.getByLabel("Obsidian folder", { exact: true })
  await expect(folder).toHaveValue("/Users/owner/Vault")
  await expect(card).toContainText("2026-10-04T12:00:00Z")
  await folder.fill("/Users/owner/Notes")
  await folder.locator("xpath=ancestor::form").getByRole("button", { name: "Change", exact: true }).press("Enter")
  await expect.poll(() => writes).toEqual([{ "wiki_sync.obsidian": { path: "/Users/owner/Notes" } }])
  await expect(folder).toHaveValue("/Users/owner/Notes")
  await folder.fill("/state")
  await folder.locator("xpath=ancestor::form").getByRole("button", { name: "Change", exact: true }).press("Enter")
  await expect(card.getByRole("alert")).toHaveText("Sync failed")
  await expect(card.locator("details").filter({ hasText: "Obsidian folder refused" })).toHaveCount(1)
  await expect(page.getByTestId("composer-input")).toBeEditable()
})

test("C-J8-03: a refused install provider exposes no folder control", async ({ page }) => {
  await owner(page)
  await page.goto("/")
  await expect(page.getByTestId("composer-input")).toBeEditable()
  await page.route("**/api/install", route => route.fulfill({ status: 403, json: { code: "permission", class: "permission", message: "Only the owner can do this" } }))
  await say(page, "/settings")
  await expect(page.getByTestId("card-settings")).toHaveCount(0)
  await expect(page.getByLabel("Obsidian folder", { exact: true })).toHaveCount(0)
  await expect(page.getByTestId("composer-input")).toBeEditable()
})
