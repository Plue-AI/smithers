import { expect, test } from "./browserTest"
import { DRAFT_RECOVERY_STORAGE_KEY } from "../../src/mainview/state/DraftRecovery"

test("the split SQLite worker boots with OPFS and preserves a composer draft across reload", async ({ page }) => {
  const errors: string[] = []
  const wasm: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  page.context().on("request", (request) => {
    if (/\/wa-sqlite-[^/]+\.wasm$/.test(request.url())) wasm.push(request.url())
  })
  await page.goto("/")
  await expect(page.locator(".app-shell")).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem("smithers-mvp.persistenceBackend"))).toBe("opfs")
  expect(wasm.length).toBeGreaterThan(0)
  await page.keyboard.press("Control+k")
  await page.getByTestId("composer-input").fill("A durable cold-load draft")
  // The next command is serialized after the draft's persistence transaction.
  await page.keyboard.press("Escape")
  await expect(page.getByTestId("composer-input")).toBeHidden()
  const workspaceUrl = page.url()
  await page.reload()
  // A durable workspace address resumes its view. Chat stays closed until invoked.
  await expect(page).toHaveURL(workspaceUrl)
  await expect(page.getByRole("button", { name: "Chat", exact: true })).toBeVisible()
  await expect(page.getByTestId("composer-input")).toBeHidden()
  await page.keyboard.press("Control+k")
  await expect(page.getByTestId("composer-input")).toHaveValue("A durable cold-load draft")
  expect(await page.evaluate(() => localStorage.getItem("smithers-mvp.persistenceBackend"))).toBe("opfs")
  expect(errors).toEqual([])
})

test("an OPFS-backed multiline composer draft survives an immediate reload while the overlay stays closed on boot", async ({ page }) => {
  const draft = "first line\nsecond line"
  await page.goto("/")
  await expect(page.locator(".app-shell")).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem("smithers-mvp.persistenceBackend"))).toBe("opfs")

  await page.keyboard.press("ControlOrMeta+k")
  await page.getByTestId("composer-input").fill(draft)
  await page.reload()

  await expect(page.getByTestId("composer-input")).toBeHidden()
  await page.keyboard.press("ControlOrMeta+k")
  await expect(page.getByTestId("composer-input")).toHaveValue(draft)
  expect(await page.evaluate((key) => localStorage.getItem(key), DRAFT_RECOVERY_STORAGE_KEY)).toBeNull()
})
