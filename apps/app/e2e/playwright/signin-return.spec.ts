import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { expect, test } from "./browserTest"
import { SCOPED_TEST_USER, identityRoute, signedOutVisitor } from "./identity"
import { APPLICATION_SIGN_IN_PATH } from "@smthrs/rpc/ApplicationAuth"

/*
 * The whole sign-in door round trip on a repository page, with a loopback
 * OAuth fixture standing in for GitHub and the identity Worker. The fixture
 * answers the start route the way the Worker does (apps/server/src/index.test.ts
 * pins that contract): it signs the visitor in and redirects to `return_to`
 * with the `signed-in` marker. The app must land on the same repository page,
 * spend the marker, drop the door, and read the account back.
 */
test("the chrome sign-in door returns to the repository page signed in", async ({ page, baseURL }) => {
  await signedOutVisitor(page)
  let signedIn = false
  const starts: string[] = []
  await page.route("**/api/user", route => identityRoute(signedIn ? SCOPED_TEST_USER.login : null)(route))
  // WebKit cannot fulfill an intercepted request with a synthetic 302.
  // Let the browser follow a real response, retaining the app's return origin.
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1")
    if (url.pathname !== APPLICATION_SIGN_IN_PATH) {
      response.writeHead(404).end()
      return
    }
    const returnTo = url.searchParams.get("return_to") ?? "/"
    starts.push(returnTo)
    signedIn = true
    const destination = new URL(returnTo, baseURL)
    destination.searchParams.set("signed-in", "github")
    response.writeHead(302, { location: destination.href, "cache-control": "no-store" }).end()
  })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve() })
    })
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    await page.route("**/api/auth/github**", route => {
      const url = new URL(route.request().url())
      return route.continue({ url: `${origin}${url.pathname}${url.search}` })
    })

    await page.goto("/smithersai/smithers/")
    // Committed, not merely requested: the account door below must be the returned page's.
    const returned = page.waitForEvent("framenavigated", frame =>
      frame === page.mainFrame() && new URL(frame.url()).searchParams.get("signed-in") === "github")
    await page.getByTestId("chrome-sign-in").click()
    const destination = new URL((await returned).url())
    expect(destination.origin).toBe(new URL(baseURL!).origin)
    expect(destination.pathname).toBe("/smithersai/smithers/")
    expect(starts).toEqual(["/smithersai/smithers/"])

    await page.getByTestId("chrome-account").click()
    await expect(page.locator('.smithers-card[data-kind="account"]').last().getByTestId("account-login"))
      .toContainText(`@${SCOPED_TEST_USER.login}`)
    // Read once the returned page renders the account: a booting page shows no door either.
    await expect(page.getByTestId("chrome-sign-in")).toHaveCount(0)
    await expect.poll(() => new URL(page.url()).searchParams.has("signed-in")).toBe(false)
    expect(new URL(page.url()).pathname).toBe("/smithersai/smithers/")
  } finally {
    if (server.listening) {
      const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      server.closeAllConnections()
      await closed
    }
  }
})
