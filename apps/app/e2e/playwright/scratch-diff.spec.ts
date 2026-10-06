import { expect, test } from "./browserTest"
import { fillComposer } from "./composer"
import { installCloudFixture } from "./cloudFixture"

test("install scratch Diff shows only edits after its fork revision and survives reload", async ({ page }) => {
  await installCloudFixture(page, { capabilities: ["identity", "install"] })
  const branch = "scratch/ben/try-retry", revision = "2222222222222222222222222222222222222222"
  let reads = 0
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  await page.route("**/api/branches/*/diff", async route => {
    reads++
    expect(new URL(route.request().url()).pathname).toBe(`/api/branches/${encodeURIComponent(branch)}/diff`)
    await held
    await route.fulfill({ json: { files: [{ path: "src/retry.ts", branch, against: { kind: "fork", rev: revision }, change: "added",
      hunks: [{ old_start: 0, new_start: 1, lines: [{ op: "+", text: "export const backoff = 2" }] }] }] } })
  })
  await page.goto("/")
  await fillComposer(page, `/diff ${branch}`)
  await page.getByTestId("composer-send").click()
  const card = page.getByTestId(`card-diff-branch-${branch}`)
  await expect(card).toBeVisible()
  await expect(page.getByTestId("composer-input")).toBeEnabled()
  await fillComposer(page, `/diff ${branch}`)
  await page.getByTestId("composer-send").click()
  const liveNotice = page.locator('[data-tone="live"]').filter({ hasText: `Diff · ${branch}` })
  await expect(liveNotice).toBeVisible()
  await expect.poll(() => reads).toBe(1)
  release()
  await expect(card.getByText("src/retry.ts", { exact: true })).toBeVisible()
  await expect(card.locator('[data-against="fork"]')).toHaveText(revision)
  await expect(card.getByText("export const backoff = 2", { exact: true })).toBeVisible()
  await expect(liveNotice).toHaveCount(0)
  await page.reload()
  await expect(page.getByTestId(`card-diff-branch-${branch}`).getByText("export const backoff = 2", { exact: true })).toBeVisible()
  expect(reads).toBe(1)
})
