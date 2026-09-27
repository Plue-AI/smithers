import { expect, test } from "./browserTest"
import { SCOPED_TEST_USER, signedOutVisitor } from "./identity"

/*
 * The whole sign-in door round trip on a repository page, with a loopback
 * OAuth fixture standing in for GitHub and the identity Worker. The fixture
 * answers the start route the way the Worker does (apps/server/src/index.test.ts
 * pins that contract): it signs the visitor in and redirects to `return_to`
 * with the `signed-in` marker. The app must land on the same repository page,
 * spend the marker, drop the door, and read the account back.
 */
test("the chrome sign-in door returns to the repository page signed in", async ({ page }) => {
  await signedOutVisitor(page)
  let signedIn = false
  const starts: string[] = []
  await page.route("**/api/auth/session", route => route.fulfill({ json: signedIn
    ? { status: "signed-in", ...SCOPED_TEST_USER, profile: { name: "Code Plane", completedAt: "2026-09-23T00:00:00.000Z" } }
    : { status: "signed-out" } }))
  await page.route("**/api/auth/github/start**", route => {
    const returnTo = new URL(route.request().url()).searchParams.get("return_to") ?? "/"
    starts.push(returnTo)
    signedIn = true
    return route.fulfill({ status: 302, headers: { location: `${returnTo}?signed-in=github` } })
  })

  await page.goto("/smithersai/smithers/")
  // Committed, not merely requested: the account door below must be the returned page's.
  const returned = page.waitForEvent("framenavigated", frame =>
    frame === page.mainFrame() && new URL(frame.url()).searchParams.get("signed-in") === "github")
  await page.getByTestId("chrome-sign-in").click()
  expect(new URL((await returned).url()).pathname).toBe("/smithersai/smithers/")
  expect(starts).toEqual(["/smithersai/smithers/"])

  await page.getByTestId("chrome-account").click()
  await expect(page.locator('.smithers-card[data-kind="account"]').last().getByTestId("account-login"))
    .toContainText(`@${SCOPED_TEST_USER.login}`)
  // Read once the returned page renders the account: a booting page shows no door either.
  await expect(page.getByTestId("chrome-sign-in")).toHaveCount(0)
  await expect.poll(() => new URL(page.url()).searchParams.has("signed-in")).toBe(false)
  expect(new URL(page.url()).pathname).toBe("/smithersai/smithers/")
})
