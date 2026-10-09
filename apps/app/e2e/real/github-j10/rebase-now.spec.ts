import { readFileSync } from "node:fs"
import { awaitBoot, expect, test } from "../support"
import { scenario } from "../coverage/types"
import { runSlash } from "../issues/local"

test("Branch Rebase now runs through the composed install", scenario("journey-rebase-now", {
  capabilities: [],
  coverage: ["host:local", "action:branch.rebase-now", "path:success", "surface:branch", "door:button", "door:slash", "evidence:service-admission-202"],
  description: "The real Branch card admits Rebase now and leaves Chat usable while the stack rewrites and updates the existing PR."
}), async ({ browser }) => {
  test.setTimeout(120_000)
  const host = JSON.parse(readFileSync(process.env.SMITHERS_JOURNEY_COMPOSED_HOST!, "utf8")) as {
    origin: string; repository: string; todo: number;
    cookies: { name: string; value: string }[]
  }
  expect(host.origin).toBe(process.env.SMITHERS_REAL_BASE_URL)
  const context = await browser.newContext({ baseURL: host.origin })
  try {
    await context.addCookies(host.cookies.map(cookie => ({ ...cookie, url: host.origin, httpOnly: cookie.name !== "__csrf" })))
    const page = await context.newPage()
    await page.goto(`${host.origin}/${host.repository}`)
    await awaitBoot(page)
    await runSlash(page, `/branch T${host.todo}`)
    const button = page.getByRole("button", { name: "Rebase now", exact: true }).last()
    await expect(button).toBeVisible()
    const response = page.waitForResponse(response => response.request().method() === "POST" &&
      new URL(response.url()).pathname.startsWith("/api/branches/"))
    await button.press("Enter")
    expect((await response).status()).toBe(202)
    await runSlash(page, "/stack")
    await expect(page.getByTestId("composer-input")).toBeEnabled()
  } finally {
    await context.close()
  }
})
