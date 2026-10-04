import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// Written before implementation: mvp.md J10.6, §6.3, Appendix A /github; lands with T-GH-07
test("A-GITHUB: durable command scenario", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md J10.6, §6.3, Appendix A /github; lands with T-GH-07")
  await owner(page)
  await page.goto("/")
  // Live seed: GitHub blocked past 120 s, LAN and chat remain available.
  await say(page, "/github")
  await expect(page.getByText(/synced .* ago/).last()).toBeVisible()
  await page.getByRole("button", { name: "Retry", exact: true }).last().press("Enter")
  // Retry while blocked preserves the stale cause; fixture recovery follows.
  await expect(page.getByText(/GitHub.*unreachable|network/i).last()).toBeVisible()
  await page.reload()
  await say(page, "/github")
  await expect(page.getByRole("button", { name: "Retry", exact: true }).last()).toBeVisible()
  await expect(page.getByTestId("composer-input")).toBeEditable()
})

// Seeded sync projection; live stale/refused states remain above.
test("A-GITHUB: seeded retry updates Home sync health", async ({ page }) => {
  await owner(page)
  await page.goto("/")
  await say(page, "/github")
  await expect(page.getByText(/synced [0-9]+ s ago/).first()).toBeVisible()
  await expect(page.getByTestId("composer-input")).toBeEditable()
})
