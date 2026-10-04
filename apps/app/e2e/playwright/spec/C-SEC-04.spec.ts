import { expect, test } from "../browserTest"
import { say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-SEC-04.md; not a qualification receipt.
// Requires fresh install setup tokens, simultaneous OAuth callbacks, restart rotation and GitHub access verification.
// Written before implementation: mvp.md J1.1, J1.2; lands with T-ACC-01, T-INS-06, T-INS-08
test("C-SEC-04: Setup sessions cannot work TODOs before verified claim", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md J1.1, J1.2; lands with T-ACC-01, T-INS-06, T-INS-08")
  // Fixture navigates to the one-time setup URL; it supplies a setup session,
  // not an owner double. Wrong/rotated tokens are tested on fresh installs.
  await page.goto("/")
  await expect(page.getByRole("region", { name: "Set up Smithers" })).toBeVisible()
  await say(page, "/todo.new")
  await expect(page.getByRole("button", { name: "Commit", exact: true })).toHaveCount(0)
  await say(page, "/members")
  await expect(page.getByLabel("GitHub username", { exact: true })).toHaveCount(0)
  await page.reload()
  await expect(page.getByRole("region", { name: "Set up Smithers" })).toBeVisible()
  // Concurrent claim fixture finishes GitHub callbacks in both lock orders;
  // the winning provisional owner can continue setup, never create work.
  await say(page, "/todo.new")
  await expect(page.getByRole("button", { name: "Commit", exact: true })).toHaveCount(0)
  await expect(page.getByRole("region", { name: "Set up Smithers" })).toBeVisible()
  // Fake GitHub now verifies the chosen repository and App installation.
  // The driver checks digest-only storage, losing-session revocation, forged
  // installation IDs and exact permission envelopes independently of the UI.
})
