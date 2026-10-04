import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-ACC-01.md.
// Written before implementation: mvp.md §6.15 Roles, §2 rule 6, Appendix B.5; lands with T-ACC-02, T-ACC-03, T-ACC-04, T-APP-04, T-INS-08, T-TRM-02, T-CUT-03, T-STK-06
test("C-ACC-01: a Member can read people and secret names but cannot merge or administer", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md §6.15 Roles, §2 rule 6, Appendix B.5; lands with T-ACC-02, T-ACC-03, T-ACC-04, T-APP-04, T-INS-08, T-TRM-02, T-CUT-03, T-STK-06")
  // Seed Alice as Member, T1 ready to merge and TEST_TOKEN as a stored secret.
  // This UI projection cannot prove the 58-cell server credential matrix.
  await owner(page)
  await page.route("**/api/user", route => route.fulfill({ json: { id: 3, username: "alice", is_admin: false } }))
  await page.goto("/smithers-mvp-canary/node")
  await say(page, "/members")
  await expect(page.getByText("@alice", { exact: true }).last()).toBeVisible()
  await expect(page.getByRole("button", { name: "Add", exact: true })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Remove", exact: true })).toHaveCount(0)
  await say(page, "/secrets")
  await expect(page.getByText("TEST_TOKEN", { exact: true }).last()).toBeVisible()
  await expect(page.getByLabel("Value", { exact: true })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Replace", exact: true })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Delete", exact: true })).toHaveCount(0)
  await say(page, "/todo T1")
  await expect(page.getByText("Ready · a maintainer merges", { exact: true }).last()).toBeVisible()
  await expect(page.getByRole("button", { name: "Merge", exact: true })).toHaveCount(0)
  await say(page, "/merge T1")
  await expect(page.getByText("Merged", { exact: true })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Review & merge", exact: true })).toHaveCount(0)
  await say(page, "/todo.new")
  await expect(page.getByLabel("Title", { exact: true }).last()).toBeVisible()
  await expect(page.getByRole("button", { name: "Commit", exact: true }).last()).toBeVisible()
})
