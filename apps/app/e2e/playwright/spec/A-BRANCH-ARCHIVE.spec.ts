import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"
import { fillComposer } from "../composer"
import { installFixture } from "../../../src/mainview/state/seams/InstallFixtures.test-support"

// Browser contract evidence for the archive flow. Production PostgreSQL/HTTP
// composition is covered by TestCleanupComposedInstallRetainsWithoutCaptureBroker;
// this fixture does not qualify capture, runtime removal or C-MCH-05.
test("Scratch archive acknowledges while HTTP is pending and persists its completion", async ({ page }) => {
  await owner(page)
  await page.route("**/api/bootstrap", route => route.fulfill({ json: {
    apiVersion: 1, host: "local", version: "test", buildSha: "test", capabilities: ["install", "identity"], authFlow: "credentials", sandbox: null
  } }))
  await page.route("**/api/install", route => route.fulfill({ json: installFixture() }))
  let posts = 0
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  await page.route("**/api/branches/scratch-id/archive", async route => {
    posts++
    expect(route.request().headers()["idempotency-key"]).toBeTruthy()
    await pending
    await route.fulfill({ json: { name: "scratch/member/cleanup", state: "closed" } })
  })
  await page.goto("/")
  await say(page, "/branch.archive scratch-id")
  await expect.poll(() => posts).toBe(1)
  await say(page, "/branch.archive scratch-id")
  await fillComposer(page, "Chat remains usable")
  await expect(page.getByTestId("composer-input")).toHaveValue("Chat remains usable")
  expect(posts).toBe(1)
  await expect(page.getByText("Archiving branch", { exact: true }).last()).toBeVisible()
  release()
  await expect(page.getByText("Archived", { exact: true }).last()).toBeVisible()
  await page.reload()
  await say(page, "/branch.archive scratch-id")
  await fillComposer(page, "Still usable after reload")
  await expect(page.getByTestId("composer-input")).toHaveValue("Still usable after reload")
  expect(posts).toBe(1)
})
