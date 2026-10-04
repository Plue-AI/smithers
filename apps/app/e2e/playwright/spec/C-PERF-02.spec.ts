import { expect, test } from "../browserTest"
import { owner } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-PERF-02.md; not a qualification receipt.
// Written before implementation: mvp.md §9, §6.4; lands with T-COL-02, T-REL-01
test("C-PERF-02: Stack moves reach a second viewer in order", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md §9, §6.4; lands with T-COL-02, T-REL-01")
  await owner(page)
  await page.goto("/")
  // Future seeded live install fixture: two subscribers and three load tabs.
  // UI order is observable here; gap-free stream cursors and 200-sample
  // delivery latency require the reference-host performance harness.
  const viewers = await Promise.all([page.context().newPage(), page.context().newPage(), page.context().newPage()])
  try {
    for (const viewer of viewers) await viewer.goto("/")
    for (let mutation = 0; mutation < 200; mutation++) {
      const direction = mutation % 2 === 0 ? "up" : "down"
      await page.getByRole("button", { name: "Order Log every webhook retry attempt", exact: true }).last().press("Enter")
      await page.getByRole("menuitem", { name: direction === "up" ? "Move up" : "Move down", exact: true }).press("Enter")
      for (const viewer of viewers) {
        const rows = viewer.getByRole("button", { name: /^(Log every webhook retry attempt|Fix the flaky checkout test)$/ })
        await expect(rows).toHaveText(direction === "up"
          ? ["Log every webhook retry attempt", "Fix the flaky checkout test"]
          : ["Fix the flaky checkout test", "Log every webhook retry attempt"])
      }
    }
  } finally {
    for (const viewer of viewers) await viewer.close()
  }
})
