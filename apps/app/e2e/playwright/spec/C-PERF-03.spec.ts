import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-PERF-03.md; not a qualification receipt.
// Needs two authenticated network members, a 400-line file and disk convergence; host timing remains in the perf harness.
// Written before implementation: mvp.md §6.8, §9; lands with T-COL-08, T-COL-08a, T-COL-08b, T-REL-01
test("C-PERF-03: Co-edited markers reach the other member in order", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md §6.8, §9; lands with T-COL-08, T-COL-08a, T-COL-08b, T-REL-01")
  await owner(page)
  await page.goto("/")
  const viewer = await page.context().newPage()
  try {
    await viewer.goto("/")
    await say(page, "/branch retry-webhooks")
    await say(viewer, "/branch retry-webhooks")
    await say(page, "/file src/target.ts")
    await say(viewer, "/file src/target.ts")
    const editor = page.getByRole("group", { name: "src/target.ts", exact: true }).last()
    const remote = viewer.getByRole("group", { name: "src/target.ts", exact: true }).last()
    for (let i = 0; i < 200; i++) {
      const marker = `m${String(i).padStart(5, "0")}`
      await editor.click()
      await page.keyboard.type(marker)
      await expect(remote).toContainText(marker)
      await page.keyboard.press("ArrowDown")
    }
    await expect(page.getByText("Saved to the machine", { exact: true }).last()).toBeVisible()
    await expect(remote).toHaveText(await editor.innerText())
  } finally {
    await viewer.close()
  }
})
