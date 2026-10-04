import { expect, test } from "../browserTest"
import { signedOutVisitor } from "../identity"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-ACC-04.md.
// Written before implementation: mvp.md J1.8, §6.2 Team sign-in, §6.15, M-05; lands with T-ACC-01, T-ACC-02
test("C-ACC-04: roster admission defaults roles and explains missing GitHub access", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md J1.8, §6.2 Team sign-in, §6.15, M-05; lands with T-ACC-01, T-ACC-02")
  // Seed GitHub ben=maintain, alice=write, carol=read. This projection covers
  // roster admission; OAuth, one-use setup and cookie refusal need integration.
  await owner(page)
  await page.goto("/smithers-mvp-canary/node")
  await say(page, "/members")
  for (const [login, name, role] of [["ben", "Ben", "Maintainer"], ["alice", "Alice", "Member"]]) {
    await page.getByLabel("GitHub username", { exact: true }).fill(login)
    await page.getByRole("button", { name: "Add", exact: true }).last().press("Enter")
    await expect(page.getByText(`@${login}`, { exact: true }).last()).toBeVisible()
    await expect(page.getByRole("button", { name: `${name}'s role: ${role}`, exact: true }).last()).toBeVisible()
  }
  await page.getByLabel("GitHub username", { exact: true }).fill("carol")
  await page.getByRole("button", { name: "Add", exact: true }).last().press("Enter")
  await expect(page.getByRole("link", { name: /needs access on GitHub/ }).last()).toHaveAttribute("href", /github.com.*settings\/access/)
  await expect(page.getByText("@carol", { exact: true })).toHaveCount(0)
  await page.reload()
  await say(page, "/members")
  await expect(page.getByText("@carol", { exact: true })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Ben's role: Maintainer", exact: true }).last()).toBeVisible()
  await expect(page.getByRole("button", { name: "Alice's role: Member", exact: true }).last()).toBeVisible()
})

// Written before implementation: mvp.md J1.8, §6.2 Team sign-in, §6.15, M-05; lands with T-ACC-01, T-ACC-02
test("C-ACC-04: sign-in explains refusal off the roster", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md J1.8, §6.2 Team sign-in, §6.15, M-05; lands with T-ACC-01, T-ACC-02")
  // Seed a claimed install and the loopback GitHub OAuth fixture as dave:
  // write permission, absent roster entry. The callback returns to this page.
  // Bind this seed to the real admission fixture when the install sign-in lands.
  await signedOutVisitor(page)
  await page.goto("/smithers-mvp-canary/node")
  await page.getByRole("button", { name: "Sign in with GitHub", exact: true }).press("Enter")
  await expect(page.getByText("not a member", { exact: true }).last()).toBeVisible()
  await expect(page.getByLabel("GitHub username", { exact: true })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Commit", exact: true })).toHaveCount(0)
  await page.reload()
  await expect(page.getByRole("button", { name: "Sign in with GitHub", exact: true })).toBeVisible()
})

// Written before implementation: mvp.md J1.8, §6.2 Team sign-in, §6.15, M-05; lands with T-ACC-01, T-ACC-02
test("C-ACC-04: sign-in links to GitHub when a roster member loses write access", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md J1.8, §6.2 Team sign-in, §6.15, M-05; lands with T-ACC-01, T-ACC-02")
  // Seed the OAuth fixture as carol: on the roster, GitHub permission read.
  await signedOutVisitor(page)
  await page.goto("/smithers-mvp-canary/node")
  await page.getByRole("button", { name: "Sign in with GitHub", exact: true }).press("Enter")
  await expect(page.getByRole("link", { name: /needs access on GitHub/ }).last()).toHaveAttribute("href", /github.com.*settings\/access/)
  await expect(page.getByRole("button", { name: "Commit", exact: true })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Merge", exact: true })).toHaveCount(0)
})
