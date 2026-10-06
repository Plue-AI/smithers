import { expect, test } from "../browserTest"
import { owner } from "./j1-fixtures"

// UI projection of C-CAT-02; its unit/CLI acceptance evidence remains separate.
// Written before implementation: mvp.md §6.1.2a, Appendix A, B.6; lands with T-CAT-01
test("C-CAT-02: External CLI confirmation waits for the person", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md §6.1.2a, Appendix A, B.6; lands with T-CAT-01")
  // Required seed: real CLI delegated request already ingested into main,
  // plus its waiting confirmation. This is the UI half; CLI argv/schema and
  // refusal exit codes require the ticket's CLI integration suite.
  await owner(page)
  await page.goto("/")
  await expect(page.getByText("Codex for Ben", { exact: true }).last()).toBeVisible()
  await expect(page.getByText("Waiting for Ben to confirm", { exact: true })).toBeVisible()
  await expect(page.getByText("Merged T8", { exact: true })).toHaveCount(0)
  await page.reload()
  await expect(page.getByText("Waiting for Ben to confirm", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Review & merge", exact: true }).last().press("Enter")
  const confirmation = page.locator(".smithers-card").last()
  await expect(confirmation).toContainText("Upgrade Stripe to v15")
  await expect(confirmation).toContainText("Required checks")
  await confirmation.getByRole("button", { name: "Cancel", exact: true }).press("Enter")
  await expect(page.getByText("Merged T8", { exact: true })).toHaveCount(0)
})

// The CLI passes only this card selector; browser identity still owns the read.
for (const name of ["settings", "members", "secrets"] as const) {
  test(`C-CAT-02: ${name} CLI door opens the app card without a mutation`, async ({ page }) => {
    await owner(page)
    const mutations: string[] = []
    page.on("request", request => { if (["POST", "PATCH", "PUT", "DELETE"].includes(request.method())) mutations.push(new URL(request.url()).pathname) })
    await page.route("**/api/repos/*/*/secrets", route => route.fulfill({ json: [{ name: "NPM_TOKEN", main_only: true, hosts: ["registry.npmjs.org"], match_headers: ["authorization"], updated_at: "2026-10-01T00:00:00Z" }] }))
    await page.goto(`/?card=${name}`)
    await expect(page.getByRole("region", { name: name === "settings" ? "Settings" : name === "members" ? "Members" : /Secrets/ }).last()).toBeVisible()
    await expect(page).not.toHaveURL(/card=/)
    expect(mutations.filter(path => path.includes("/secrets") || path.includes("/members") || path.includes("/settings"))).toEqual([])
  })
}
