import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-MCH-04.md; not a qualification receipt.
// Written before implementation: mvp.md §6.7, M-06; lands with T-MCH-01
test("C-MCH-04: Owner capacity persists below the detected maximum", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md §6.7, M-06; lands with T-MCH-01")
  await owner(page)
  await page.goto("/")
  // Seed detected 32 GiB / 10 performance cores / 400 GiB free: maximum 3.
  // 24/8/200 => 2 and 64/12/1024 => 6 are separate host-detector fixtures.
  // Zero-capacity memory, disk and core fixes need a real install-settings seam.
  await say(page, "/settings")
  const machines = page.getByRole("spinbutton", { name: "Machines", exact: true }).last()
  await expect(machines).toHaveValue("3")
  await page.getByRole("button", { name: "Fewer machines", exact: true }).last().press("Enter")
  await expect(machines).toHaveValue("2")
  await page.reload()
  await expect(machines).toHaveValue("2")
  await page.getByRole("button", { name: "More machines", exact: true }).last().press("Enter")
  await expect(machines).toHaveValue("3")
  await expect(page.getByRole("button", { name: "More machines", exact: true }).last()).toBeDisabled()
})
