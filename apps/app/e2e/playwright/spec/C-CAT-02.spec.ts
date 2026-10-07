import { expect, test } from "../browserTest"
import { owner } from "./j1-fixtures"
import { installFixture } from "../../../src/mainview/state/seams/InstallFixtures.test-support"
import { fixtures as confirms } from "../../../../../packages/rpc/test/fixtures/Confirm"
import { claude_code } from "../../../../../packages/rpc/test/fixtures/_shared"
import type { MemberConfirmation } from "@smthrs/rpc/ConfirmCard"

// UI projection of C-CAT-02; its unit/CLI acceptance evidence remains separate.
// Written before implementation: mvp.md §6.1.2a, Appendix A, B.6; lands with T-CAT-01
test("C-CAT-02: External CLI confirmation waits for the person", async ({ page }) => {
  // TestCatalogMergeBrowserPostgres repeats this journey through StartWithOptions,
  // the source CLI, PostgreSQL and real Live; no browser routes are intercepted there.
  // This contract provider drives the mounted private live seam, without seeded cards.
  test.setTimeout(120_000)
  await owner(page)
  const id = "10000000-0000-4000-8000-000000000002"
  let row: MemberConfirmation = { id, command: "merge", state: "pending", revision: "generation-2:h2", expires_at: "2099-01-01T00:00:00Z",
    payload: { input: { reviewed_head_sha: "h2" }, card: { ...confirms.review_merge.model,
      asked_by: { ...claude_code, agent: "codex", name: "Codex" },
      review: { ...confirms.review_merge.model.review!, merge: { state: "ready", on_github: true } } } } }
  await page.route("**/api/bootstrap", route => route.fulfill({ json: {
    apiVersion: 1, host: "local", version: "test", buildSha: "test", capabilities: ["install", "identity"], authFlow: "credentials", sandbox: null
  } }))
  await page.route("**/api/install", route => route.fulfill({ json: installFixture() }))
  const roster = { members: [{ login: "canary-owner", name: "Ben", avatar_url: "https://github.com/canary-owner.png", color_index: 0, role: "owner", needs_access: false, suspended: false, actions: [] }], access_url: "https://github.com/acme/api/settings/access" }
  await page.route("**/api/members", route => route.fulfill({ json: roster }))
  let publish = () => {}, approvals = 0, denials = 0
  await page.routeWebSocket("**/api/live", socket => socket.onMessage(raw => {
    if (typeof raw !== "string") return
    const frame = JSON.parse(raw)
    if (frame.t !== "sub") return
    if (frame.topic === "confirmations:1") {
      let cursor = 0
      publish = () => socket.send(JSON.stringify({ t: "snap", id: frame.id, cursor: ++cursor, data: [row] }))
      publish()
    } else if (frame.topic === "members") socket.send(JSON.stringify({ t: "snap", id: frame.id, cursor: 1, data: roster }))
    else socket.send(JSON.stringify({ t: "err", id: frame.id, code: "unsupported" }))
  }))
  await page.route(`**/api/confirmations/${id}/approve`, route => { approvals++; return route.fulfill({ status: 202, json: { id, state: "pending" } }) })
  await page.route(`**/api/confirmations/${id}/deny`, async route => {
    denials++
    row = { ...row, state: "rejected", payload: { ...row.payload, card: { ...row.payload.card, receipt: confirms.cancelled.model.receipt } } }
    publish()
    await route.fulfill({ json: { id, state: "rejected" } })
  })
  await page.goto("/")
  const confirmation = page.locator('[data-kind="confirm"]')
  await expect(confirmation).toBeVisible({ timeout: 60_000 })
  await expect(confirmation).toContainText("Card model contracts")
  await expect(confirmation).toContainText("required-ci")
  await expect(confirmation.getByRole("button", { name: "Review & merge", exact: true })).toBeEnabled()
  expect(approvals).toBe(0)
  await page.reload()
  await expect(confirmation).toBeVisible()
  await expect(confirmation.getByRole("button", { name: "Review & merge", exact: true })).toBeEnabled()
  expect(approvals).toBe(0)
  await confirmation.getByRole("button", { name: "Cancel", exact: true }).press("Enter")
  await expect(confirmation).toContainText("Cancelled")
  expect(denials).toBe(1)
  expect(approvals).toBe(0)
  await expect(confirmation).not.toContainText("Merged")
})

// The CLI passes only this card selector; browser identity still owns the read.
for (const name of ["settings", "members", "secrets"] as const) {
  test(`C-CAT-02: ${name} CLI door opens the app card without a mutation`, async ({ page }) => {
    await owner(page)
    const mutations: string[] = []
    page.on("request", request => { if (["POST", "PATCH", "PUT", "DELETE"].includes(request.method())) mutations.push(new URL(request.url()).pathname) })
    await page.route("**/api/repos/*/*/secrets", route => route.fulfill({ json: [{ name: "NPM_TOKEN", main_only: true, hosts: ["registry.npmjs.org"], match_headers: ["authorization"], updated_at: "2026-10-01T00:00:00Z" }] }))
    await page.goto(`/?card=${name}`)
    await expect(page.getByRole("region", { name: name === "settings" ? "Settings" : name === "members" ? "Members" : /Secrets/ }).last()).toBeVisible({ timeout: 30_000 })
    await expect(page).not.toHaveURL(/card=/)
    expect(mutations.filter(path => path.includes("/secrets") || path.includes("/members") || path.includes("/settings"))).toEqual([])
  })
}
