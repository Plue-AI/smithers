import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// Written before implementation: mvp.md J1.8, §6.15, Appendix A /members; lands with T-ACC-02, T-APP-06, T-REL-02
test("A-MEMBERS: durable command scenario", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md J1.8, §6.15, Appendix A /members; lands with T-ACC-02, T-APP-06, T-REL-02")
  await owner(page)
  await page.goto("/")
  await say(page, "/members")
  const members = page.getByRole("region", { name: "Members", exact: true }).last()
  await members.getByLabel("GitHub username", { exact: true }).fill("canary-member")
  await members.getByRole("button", { name: "Add", exact: true }).press("Enter")
  await expect(members.getByText("@canary-member", { exact: true })).toBeVisible()
  await members.getByLabel("GitHub username", { exact: true }).fill("canary-no-access")
  await members.getByRole("button", { name: "Add", exact: true }).press("Enter")
  await expect(page.getByRole("link", { name: /needs access on GitHub/ }).last()).toBeVisible()
  await expect(members.getByText("@canary-no-access", { exact: true })).toHaveCount(0)
  await page.reload()
  await say(page, "/members")
  await expect(members.getByText("@canary-member", { exact: true })).toBeVisible()
  await expect(page.getByTestId("composer-input")).toBeEditable()
})

// Seeded projection; live qualification remains above.
test("A-MEMBERS: mounted command projection", async ({ page }) => {
  await owner(page)
  await page.goto("/")
  await say(page, "/members")
  const card = page.getByRole("region", { name: "Members", exact: true }).last()
  await expect(card.getByLabel("GitHub username", { exact: true })).toBeEditable()
  await expect(card.getByRole("button", { name: "Add", exact: true })).toBeVisible()
  await expect(page.getByTestId("composer-input")).toBeEditable()
})
