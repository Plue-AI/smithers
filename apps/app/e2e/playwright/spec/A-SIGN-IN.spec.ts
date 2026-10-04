import { expect, test } from "../browserTest"
import { signedOutVisitor } from "../identity"
import { APPLICATION_SIGN_IN_PATH } from "@smthrs/rpc/ApplicationAuth"
import { say } from "./j1-fixtures"

// Written before implementation: mvp.md J1.8, §6.15, Appendix A /sign-in; lands with T-ACC-02, T-REL-02
test("A-SIGN-IN: admitted member returns from GitHub", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md J1.8, §6.15, Appendix A /sign-in; lands with T-ACC-02, T-REL-02")
  // Reference-host GitHub profile for the admitted member is required.
  await page.goto("/")
  await say(page, "/sign-in")
  await expect(page.getByText("Welcome to Smithers", { exact: true })).toHaveCount(0)
  await say(page, "/members")
  const members = page.getByRole("region", { name: "Members", exact: true }).last()
  await expect(members).toContainText("Member")
  await expect(members.getByRole("button", { name: "Add", exact: true })).toHaveCount(0)
  await page.reload()
  await expect(page.getByText("Welcome to Smithers", { exact: true })).toHaveCount(0)
})

test("A-SIGN-IN: slash command hands off to GitHub", async ({ page }) => {
  await signedOutVisitor(page)
  await page.route("**/api/auth/github**", route => route.fulfill({ body: "Sign-in handoff" }))
  await page.goto("/")
  await expect(page.getByRole("button", { name: "Continue with GitHub", exact: true })).toBeVisible()
  await page.keyboard.press("Control+k")
  await say(page, "/sign-in")
  await page.waitForURL(url => url.pathname === APPLICATION_SIGN_IN_PATH)
  await expect(page.getByText("Sign-in handoff", { exact: true })).toBeVisible()
})
