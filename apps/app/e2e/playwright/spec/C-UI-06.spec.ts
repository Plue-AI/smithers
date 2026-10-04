import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of C-UI-06; acceptance now lives in T-APP-16.
// Reference-host and integration evidence remains required separately.
// Written before implementation: mvp.md §6.4, M-08; lands with T-APP-16
test("C-UI-06: Shared branch entries keep personal views", async ({ page, browser }) => {
  test.fixme(true, "Written before implementation: mvp.md §6.4, M-08; lands with T-APP-16")
  // Required seed: Ben and Alice in separate authenticated contexts on one branch;
  // shared ordered entries and independent persisted view-state collections.
  await owner(page)
  const alice = await browser.newContext()
  const peer = await alice.newPage()
  await owner(peer)
  await peer.route("**/api/user", route => route.fulfill({ json: { id: 2, username: "alice", is_admin: false } }))
  await page.goto("/")
  await peer.goto("/")
  await say(page, "/branch retry-webhooks")
  await say(peer, "/branch retry-webhooks")
  await say(page, "List the changed tests")
  await expect(peer.getByText("List the changed tests", { exact: true })).toBeVisible()
  await expect(peer.getByText("Smithers for Ben", { exact: true }).last()).toBeVisible()
  await say(page, "/todo T9")
  await expect(peer.getByText("T9", { exact: true }).last()).toBeVisible()
  await page.getByRole("button", { name: "Maximize card", exact: true }).last().press("Enter")
  await expect(page.getByRole("button", { name: "Restore", exact: true })).toBeVisible()
  await expect(peer.getByRole("button", { name: "Restore", exact: true })).toHaveCount(0)
  await peer.reload()
  await expect(peer.getByText("List the changed tests", { exact: true })).toBeVisible()
  await expect(peer.getByRole("button", { name: "Restore", exact: true })).toHaveCount(0)
  await page.reload()
  await expect(page.getByRole("button", { name: "Restore", exact: true })).toBeVisible()
  await alice.close()
})
