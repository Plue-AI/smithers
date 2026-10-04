import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-SEC-02.md; not a qualification receipt.
// Requires a canary repository, host process sampler, bundled-runtime faults and production guest authorization.
// Written before implementation: mvp.md §9 Isolation, §6.12 Change the factory, M-29, M-30; lands with T-FLW-01, T-INS-02, T-INS-08, T-FLW-11, T-STK-12, T-MCH-14
test("C-SEC-02: Repository flow runs stay in the branch machine", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md §9 Isolation, §6.12 Change the factory, M-29, M-30; lands with T-FLW-01, T-INS-02, T-INS-08, T-FLW-11, T-STK-12, T-MCH-14")
  await owner(page)
  await page.goto("/")
  // The live fixture supplies the import beacon and independently samples host
  // processes/files/sockets. No repository canary may execute on the host.
  await say(page, "/todo.new")
  await page.getByLabel("Title", { exact: true }).fill("Add a README line")
  await page.getByLabel("Prompt", { exact: true }).fill("Add one README line")
  await page.getByRole("button", { name: "Commit", exact: true }).press("Enter")
  await expect(page.getByText("In review", { exact: true }).last()).toBeVisible()
  // canary is a reference fixture's repository flow, not a product flow id.
  await say(page, "/flow.run canary {}")
  await expect(page.getByText("Done", { exact: true }).last()).toBeVisible()
  await say(page, "/flow merge")
  await expect(page.getByText(/reserved_name/).last()).toBeVisible()
  await expect(page.getByRole("button", { name: "Run", exact: true })).toHaveCount(0)
  // Reference-host harness kills this TODO's guest here. No host fallback is
  // permitted; launcher failures and reviewer canaries have separate receipts.
  await page.reload()
  await expect(page.getByText("Interrupted", { exact: true }).last()).toBeVisible()
  await expect(page.getByRole("button", { name: "Retry", exact: true }).last()).toBeVisible()
})
