import { expect, test } from "./browserTest"
import { SCOPED_TEST_USER, signedOutVisitor, skipSignup } from "./identity"

test("signing in rereads the repository homepage without reloading the app", async ({ page }) => {
  const repo = "smithersai/smithers"
  let signedIn = false, reads = 0
  await signedOutVisitor(page)
  await page.route("**/api/auth/session", route => route.fulfill({ json: signedIn ? SCOPED_TEST_USER : { status: "signed-out" } }))
  await page.route("**/api/public/repos", route => route.fulfill({ json: { repos: [
    { name: repo, title: "Smithers", url: `https://github.com/${repo}`, summary: "Smithers.", stats: null }
  ] } }))
  await page.route(url => url.pathname === `/api/repos/${repo}/home`, route => {
    reads += 1
    return route.fulfill(signedIn
      ? { json: { kind: "blocks", blocks: [{ type: "text", text: "Authenticated repository homepage" }] } }
      : { status: 404, json: { message: "Not found" } })
  })
  await page.goto(`/${repo}`)
  await expect(page.getByRole("button", { name: "Sign in with GitHub", exact: true }).first()).toBeVisible()
  await expect.poll(() => reads).toBeGreaterThan(0)
  await expect(page.getByText("Authenticated repository homepage", { exact: true })).toHaveCount(0)
  const initialReads = reads
  signedIn = true
  await page.evaluate(() => window.dispatchEvent(new Event("focus")))
  await expect.poll(() => reads).toBeGreaterThan(initialReads)
  await skipSignup(page)
  await expect(page.getByText("Authenticated repository homepage", { exact: true })).toBeVisible()
  await page.reload()
  await expect(page.getByText("Authenticated repository homepage", { exact: true })).toBeVisible()
})
