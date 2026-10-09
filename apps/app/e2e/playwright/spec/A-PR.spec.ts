import { withGitHubInstall } from "./github-install-fixture"
import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// Written before implementation: mvp.md Appendix A, J2.5, §6.10; lands with T-STK-01, T-GH-03
test("A-PR: opens PR evidence and its TODO", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md Appendix A, J2.5, §6.10; lands with T-STK-01, T-GH-03")
  await owner(page)
  await page.goto("/")
  await say(page, "/pr #88")
  const card = page.locator(".smithers-card").last()
  await expect(card).toContainText("pnpm test")
  await expect(card).toContainText("pnpm lint")
  await expect(card).toContainText("No blocking issues")
  await card.getByRole("button", { name: "Diff", exact: true }).press("Enter")
  await expect(page.getByRole("region", { name: "package.json changes", exact: true }).last()).toBeVisible()
  await page.reload()
  await say(page, "/pr #88")
  await expect(page.locator(".smithers-card").last()).toContainText("GitHub")
})

// Seeded UI projection; live provider qualification remains above.
test("A-PR: mounted controls", async ({ page }) => {
  await owner(page)
  await page.goto("/")
  await say(page, "/pr #88")
  const card = page.locator(".smithers-card").last()
  await expect(card).toContainText("smithers/upgrade-stripe")
  await expect(card).toContainText("main")
  await card.getByRole("button", { name: "T8 ↗", exact: true }).press("Enter")
  await expect(page.locator(".todo-view").last()).toContainText("Upgrade the Stripe SDK to v17")
  await expect(page.getByTestId("composer-input")).toBeEditable()
})

// Accepted publication trees are fixture inputs; every browser read uses the composed install.
test("A-PR: canonical PR list and detail read the installed GitHub source", { tag: "@install" }, async ({ page }) => {
  test.setTimeout(300_000)
  await withGitHubInstall(page, "TestTODOGitHubOrderAndShapeComposedInstall", "SMITHERS_GH03_ORDER_REHEARSAL", async fixture => {
    const host = await fixture.phase("shape")
    await fixture.open(host)
    await say(page, '/pr {"operation":"list","repo":"rehearsal-owner/app"}')
    const listing = page.getByTestId("card-prs-rehearsal-owner/app")
    await expect(listing).toContainText("Second")
    const row = listing.getByRole("button").filter({ hasText: "Second" }).first()
    await expect(row).toHaveAttribute("data-flow", "pr")
    const args = JSON.parse(await row.getAttribute("data-flow-args") ?? "{}")
    const detailRead = page.waitForResponse(r => new URL(r.url()).pathname.endsWith(`/pulls/${args.number}`) && r.request().method() === "GET")
    await row.click()
    expect((await detailRead).status()).toBe(200)
    const detail = page.getByRole("region", { name: `#${args.number} Second · rehearsal-owner/app`, exact: true })
    await expect(detail).toContainText("Second")
    await expect(detail).toContainText("Requested by @rehearsal-owner")
    await expect(detail.getByRole("link", { name: "GitHub", exact: true })).toHaveAttribute("href", `https://github.com/rehearsal-owner/app/pull/${args.number}`)
    await expect(detail.getByRole("button", { name: "Approve", exact: true })).toHaveCount(0)
    await expect(detail).not.toContainText("No reviews yet")
    await expect(page.getByTestId("composer-input")).toBeEditable()
    await page.reload()
    await expect(detail).toContainText("Second")
    await expect(detail).toContainText("Requested by @rehearsal-owner")
    await fixture.acknowledge("shape")
  }, "shape")
})
