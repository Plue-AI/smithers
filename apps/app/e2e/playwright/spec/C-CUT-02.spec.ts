import history from "../../../src/mainview/state/testdata/cut-history-mixed.json"
import { expect, test } from "../browserTest"
import { installCloudFixture } from "../cloudFixture"
import { say } from "./j1-fixtures"

// Browser proof uses the shipped Earlier loader and real browser persistence.
// The authenticated PostgreSQL journal qualification is separate from this fake transport.
test("C-CUT-02: Historical titles survive verified replay and stay out of prompt admissions", async ({ page }) => {
  await installCloudFixture(page, { capabilities: ["install", "identity", "agent"] })
  let login = "ben"
  await page.route(url => url.pathname === "/api/user" || url.pathname === "/api/auth/session", route => route.fulfill({ json: { id: login === "ben" ? 1 : 2, username: login, is_admin: false } }))
  await page.route("**/api/branches?*", route => route.fulfill({ json: [] }))
  await page.route("**/api/agent/conversations", route => route.fulfill({ json: login === "ben" ? history.index : { status: "ok", conversations: [], next: null } }))
  await page.route("**/api/agent/conversations/replay", route => {
    expect(route.request().method()).toBe("POST")
    expect(route.request().postDataJSON()).toEqual({ runId: "legacy-turn", legId: "legacy-leg" })
    return route.fulfill({ json: history.replay })
  })
  const admissions: unknown[] = []
  await page.route("**/api/conversations/*/prompt", route => {
    admissions.push(route.request().postDataJSON())
    return route.fulfill({ status: 503, json: { error: { code: "unavailable", message: "Captured" } } })
  })
  await page.goto("/")
  await say(page, "/branches")
  await page.locator('[data-node="earlier"]').press("Enter")
  const earlier = page.getByRole("region", { name: "Earlier", exact: true })
  await earlier.getByRole("button", { name: "Old prompt", exact: true }).press("Enter")
  const entries = earlier.locator(".archive-entries")
  await expect(entries).toContainText("Old prompt")
  await expect(entries).toContainText("Old answer")
  for (const kind of ["admin-health", "agent", "connect", "grant-confirm", "notifications", "registration", "repository-setup"]) await expect(entries.getByText(`Saved ${kind}`, { exact: true })).toBeVisible()
  await expect(entries.getByText("<script>archiveCanary()</script>", { exact: true })).toBeVisible()
  await expect(entries.getByText("Saved File", { exact: true })).toBeVisible()
  await expect(entries.getByText("Saved Run", { exact: true })).toBeVisible()
  await expect(entries).not.toContainText("retained-file-body-canary")
  await expect(entries).not.toContainText("private-payload-canary")
  await expect(entries).not.toContainText("private-body-canary")
  await expect(entries.locator("button,input,textarea,script")).toHaveCount(0)
  expect(admissions).toHaveLength(0)
  await expect(page.locator("[data-branch-navigation]")).toHaveAttribute("aria-busy", "false")
  await page.reload()
  await expect(entries.getByText("Saved admin-health", { exact: true })).toBeVisible()
  await page.locator('[data-node="earlier"]').press("Escape")
  await say(page, "Current question")
  await expect.poll(() => admissions.length, { timeout: 20_000 }).toBe(1)
  expect(JSON.stringify(admissions)).not.toContain("private-payload-canary")
  expect(JSON.stringify(admissions)).not.toContain("private-body-canary")
  expect(JSON.stringify(admissions)).not.toContain("Saved admin-health")
  expect(JSON.stringify(admissions)).not.toContain("retained-file-body-canary")
  login = "alice"
  await page.reload()
  await say(page, "/branches")
  await page.locator('[data-node="earlier"]').press("Enter")
  await expect(earlier.locator("[data-archive]")).toHaveCount(0)
  await expect(earlier).not.toContainText("Saved admin-health")
})
