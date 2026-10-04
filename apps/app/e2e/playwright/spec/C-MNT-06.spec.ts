import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-MNT-06.md; not a qualification receipt.
// Written before implementation: mvp.md §14, M-05, M-26, M-29; lands with T-MNT-01, T-MNT-02, T-MNT-03, T-MNT-04, T-MNT-05
test("C-MNT-06: Outsider text never grants execution or exposes canaries", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md §14, M-05, M-26, M-29; lands with T-MNT-01, T-MNT-02, T-MNT-03, T-MNT-04, T-MNT-05")
  await owner(page)
  await page.goto("/")
  // Future Stage-M fixture: malicious outsider issue and PR; harmless canaries,
  // denied sudo/cross-user reads, immutable admitted snapshot, later author edit.
  await say(page, "/issue 42")
  await expect(page.getByText("$(cat /host/canary)", { exact: true }).last()).toBeVisible()
  await expect(page.getByText("HOST_CANARY_VALUE", { exact: true })).toHaveCount(0)
  await expect(page.getByText("TEAMMATE_CANARY_VALUE", { exact: true })).toHaveCount(0)
  await say(page, "/stack")
  await expect(page.getByText("Outsider probe", { exact: true })).toHaveCount(0)
  await say(page, "/issue 42")
  await page.getByRole("button", { name: "Triage", exact: true }).last().press("Enter")
  await page.getByRole("button", { name: "Approve", exact: true }).last().press("Enter")
  await expect(page.getByText("Permission denied", { exact: true }).last()).toBeVisible()
  await page.reload()
  await expect(page.getByText("HOST_CANARY_VALUE", { exact: true })).toHaveCount(0)
  await expect(page.getByText("TEAMMATE_CANARY_VALUE", { exact: true })).toHaveCount(0)
  await expect(page.getByText("Posted", { exact: true })).toHaveCount(0)
  await say(page, "/pr 73")
  await expect(page.getByRole("button", { name: "Merge", exact: true }).last()).not.toBeVisible()
  // Host audit, forged actors, guest privilege denial, exfiltration listener
  // and passive-input counter deltas require real confinement receipts.
})
