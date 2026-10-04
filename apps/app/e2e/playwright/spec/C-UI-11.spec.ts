import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of C-UI-11; acceptance now lives in T-APP-15.
// Reference-host and integration evidence remains required separately.
// Written before implementation: mvp.md §8 kept code intelligence and webpage reader; lands with T-APP-15
test("C-UI-11: File intelligence and webpage reading stay reachable by keyboard", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md §8 kept code intelligence and webpage reader; lands with T-APP-15")
  // Required seed: awake T1 branch, isolated TypeScript language server;
  // src/a.ts defines add at line 3; src/b.ts calls add(1, "2") at line 5.
  await owner(page)
  await page.goto("/")
  await say(page, "/branch T1")
  await say(page, "/files.read src/b.ts")
  const file = page.locator(".smithers-card").last()
  await expect(file).toContainText('add(1, "2")')
  await file.getByText("add", { exact: true }).last().focus()
  await page.keyboard.press("Control+Space")
  await expect(page.getByText("add(x: number, y: number): number", { exact: true })).toBeVisible({ timeout: 3000 })
  await page.keyboard.press("Escape")
  await page.keyboard.press("F12")
  await expect(page.locator(".smithers-card").last()).toContainText("src/a.ts")
  await say(page, "/files.read src/b.ts")
  await expect(page.locator(".smithers-card").last()).toContainText("Argument of type 'string' is not assignable to parameter of type 'number'")
  // Static same-origin fixture is served by the future seeded reader scenario.
  await say(page, "/browser.open http://127.0.0.1:47311/page.html")
  await expect(page.locator(".smithers-card").last()).toContainText("Reader canary")
  await expect(page.locator(".smithers-card").last()).toContainText("Reader canary body")
  await page.reload()
  await expect(page.locator(".smithers-card").last()).toContainText("Reader canary body")
})
