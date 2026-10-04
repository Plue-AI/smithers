import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-J1-05.md.
// Real host, GitHub, installation and timing receipts remain in the reference-host check.
// Seed requirements: canary Node/Go repositories, owner, held image build,
// mirrored src/mail/expiry.ts, and the access outcomes named below.
// Written before implementation: mvp.md J1; lands with T-APP-06
test("C-J1-05: Members default from GitHub access and refuse an inaccessible username", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md J1; lands with T-APP-06")
  await owner(page)
  await page.goto("/smithers-mvp-canary/node")
  await say(page, "/members")
  const username = page.getByLabel("GitHub username", { exact: true })
  for (const login of ["canary-maintainer", "canary-member"]) {
    await username.fill(login)
    await page.keyboard.press("Tab")
    await page.keyboard.press("Enter")
    await expect(page.getByText(`@${login}`, { exact: true })).toBeVisible()
  }
  await expect(page.getByText("Maintainer", { exact: true }).first()).toBeVisible()
  await expect(page.getByText("Member", { exact: true }).first()).toBeVisible()
  await username.fill("canary-no-access")
  await page.getByRole("button", { name: "Add", exact: true }).press("Enter")
  await expect(page.getByRole("link", { name: /needs access on GitHub/ })).toHaveAttribute("href", /github.com.*settings\/access/)
  await expect(page.getByText("@canary-no-access", { exact: true })).toHaveCount(0)
  await expect(page.getByText(/invitation|organization/i)).toHaveCount(0)
  await page.reload()
  await say(page, "/members")
  await expect(page.getByText("@canary-member", { exact: true })).toBeVisible()
})
