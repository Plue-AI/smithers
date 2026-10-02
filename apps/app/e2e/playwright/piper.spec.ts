import { fillComposer } from "./composer"
import { expect, test } from "./browserTest"
import type { Page } from "./browserTest"
import { installCloudFixture } from "./cloudFixture.ts"

/*
 * Lane piper T1 (ADR 0001): repositories
 * share one address space, and /files.read README.md renders the card whose
 * header carries the global address and the position the read was taken at.
 * Local checkouts no longer join it: ac9e0cccfd retired the local repository
 * list, so the read is the Cloud contents route at the head the inventory
 * last saw.
 *
 * The server is a double: the shared cloud fixture (cloudFixture.ts) answers
 * the bootstrap, the identity and the repository inventory with its
 * bookmarks; this spec adds the contents read.
 */

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body)
})

/** Install the server double: signed in to a cloud that inventories smithersai/smithers. */
const serve = async (page: Page): Promise<void> => {
  await installCloudFixture(page)
  await page.route((url) => url.pathname === "/api/repos/smithersai/smithers/contents/README.md", (route) =>
    route.fulfill(json({ type: "file", name: "README.md", path: "README.md", size: 11, encoding: "utf-8", content: "# Smithers\n" })))
}

test.beforeEach(async ({ page }) => {
  // A persisted store from an earlier test must not carry state across tests.
  await page.addInitScript(() => {
    try {
      window.localStorage.clear()
    } catch {
      // Storage the browser refuses is the empty store already.
    }
  })
})

test("T1: /files.read's card header shows the global address and readAt", async ({ page }) => {
  await serve(page)
  await page.goto("/")

  // /files.read renders the file card; its header carries the global address
  // and the change id the read was taken at.
  await fillComposer(page, "/files.read README.md")
  await page.getByTestId("composer-send").click()
  const card = page.getByTestId("card-file-smithersai/smithers-README.md")
  await expect(card).toBeVisible({ timeout: 15_000 })
  await expect(card.locator(".world-card-path")).toContainText("/smithersai/smithers/README.md")
  await expect(card.locator(".world-card-path")).toContainText("kxyzqrpv")
  // Markdown renders through the read-only editor: the heading text, not the raw fence.
  await expect(card).toContainText("Smithers")
})
