import { expect, test } from "../browserTest"
import { say } from "./j1-fixtures"
import { identityRoute, signedOutVisitor } from "../identity"
import { AUTH_LOGOUT_PATH } from "@smthrs/rpc/AgentApiRoutes"

// Written before implementation: mvp.md §6.15, Appendix A /sign-out; lands with T-ACC-02, T-REL-02
test("A-SIGN-OUT: server session remains retired after reload", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md §6.15, Appendix A /sign-out; lands with T-ACC-02, T-REL-02")
  // Reference-host authenticated member session; no identity double.
  await page.goto("/")
  await say(page, "/sign-out")
  await expect(page.getByRole("button", { name: "Continue with GitHub", exact: true }).last()).toBeVisible()
  await page.reload()
  await expect(page.getByRole("button", { name: "Continue with GitHub", exact: true }).last()).toBeVisible()
  await expect(page.getByRole("button", { name: "Sign out", exact: true })).toHaveCount(0)
})

test("A-SIGN-OUT: confirmed logout returns to sign-in", async ({ page }) => {
  await signedOutVisitor(page)
  await page.route("**/api/user", identityRoute())
  await page.route(url => url.pathname === AUTH_LOGOUT_PATH, async route => {
    await page.route("**/api/user", identityRoute(null))
    await route.fulfill({ status: 204 })
  })
  await page.goto("/")
  const logout = page.waitForResponse(response => new URL(response.url()).pathname === AUTH_LOGOUT_PATH)
  await say(page, "/sign-out")
  expect((await logout).status()).toBe(204)
  await page.reload()
  await expect(page.getByRole("button", { name: "Continue with GitHub", exact: true }).last()).toBeVisible()
})
