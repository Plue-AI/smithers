import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-ACC-03.md.
// Written before implementation: mvp.md §3 Member, §6.15, M-05; lands with T-ACC-02
test("C-ACC-03: removal keeps TODO history and the Owner cannot be removed", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md §3 Member, §6.15, M-05; lands with T-ACC-02")
  // Seed Alice with T3 and five recorded activity entries, plus Maya as Owner.
  // Real socket/process termination and the five-second bound need integration receipts.
  await owner(page)
  await page.goto("/smithers-mvp-canary/node")
  await say(page, "/members")
  const alice = page.getByRole("listitem").filter({ hasText: "@alice" })
  const maya = page.getByRole("listitem").filter({ hasText: "@maya" })
  await expect(maya.getByText("Owner", { exact: true })).toBeVisible()
  await expect(maya.getByRole("button", { name: "Remove", exact: true })).toHaveCount(0)
  await expect(maya.getByRole("button", { name: /role/ })).toHaveCount(0)
  await alice.getByRole("button", { name: "Remove", exact: true }).press("Enter")
  await expect(page.getByText("@alice", { exact: true })).toHaveCount(0)
  await page.reload()
  await say(page, "/members")
  await expect(page.getByText("@alice", { exact: true })).toHaveCount(0)
  await expect(page.getByText("@maya", { exact: true }).last()).toBeVisible()
  await say(page, "/todo T3")
  await expect(page.getByText("Retry webhook delivery", { exact: true }).last()).toBeVisible()
  await expect(page.getByText("Alice answered", { exact: true }).last()).toBeVisible()
  await expect(page.getByText("Use the existing retry helper", { exact: true }).last()).toBeVisible()
  await say(page, "/branch retry-webhooks")
  await expect(page.getByText("Alice", { exact: true }).last()).toBeVisible()
  await expect(page.getByText("Use the existing retry helper", { exact: true }).last()).toBeVisible()
})
