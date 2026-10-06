import { expect, test } from "./browserTest"
import { owner, say } from "./spec/j1-fixtures"

// Browser/host-contract proof only. Machine head, pin, cleanup and zero GitHub
// writes still require C-J10-09 on the reference host's real microVM.
test("review acknowledges before launch and reconnects findings after reload", async ({ page }) => {
  await owner(page)
  await page.route("**/api/public/repos", route => route.fulfill({ json: { repos: [{ name: "smithers-mvp-canary/node" }] } }))
  let launches = 0, observations = 0, completed = false
  let release!: () => void
  const launch = new Promise<void>(resolve => { release = resolve })
  await page.route("**/api/reviews", async route => {
    launches++
    expect(route.request().postDataJSON()).toMatchObject({ number: 50 })
    expect(route.request().headers()["idempotency-key"]).toBeTruthy()
    await launch
    await route.fulfill({ status: 202, json: { operationId: "member-review-50", state: "accepted" } })
  })
  await page.route("**/api/reviews/member-review-50", route => {
    observations++
    return route.fulfill({ json: completed ? { state: "completed", change: {
      repo: "smithers-mvp-canary/node", changeId: "review-50", description: "Review", commitId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      currentSeq: null, revisionCount: null, revisions: [], authorName: null, timestamp: null, repos: [], diff: null,
      checks: null, findings: [{ analyzer: "review", severity: "fix", path: "src/cache.ts", line: 20, summary: "Off by one", raisedAtSeq: null }],
      reviews: null, threads: null, conflicts: null, stack: null, changeset: null
    } } : { state: "dispatching" } })
  })
  await page.goto("/smithers-mvp-canary/node")
  await say(page, "/review #50")
  await expect.poll(() => launches).toBe(1)
  await say(page, "/review #50")
  expect(launches).toBe(1)
  await expect(page.getByTestId("composer-input")).toBeEnabled()
  await expect(page.getByText("Off by one", { exact: true })).toHaveCount(0)
  release()
  await expect.poll(() => observations).toBeGreaterThan(0)
  await page.reload()
  completed = true
  await expect(page.getByText("Off by one", { exact: true })).toBeVisible()
  await expect(page.getByText("src/cache.ts:20", { exact: true })).toBeVisible()
  expect(launches).toBe(1)
  await expect(page.getByRole("region", { name: "Review", exact: true }).getByRole("button", { name: "Merge", exact: true })).toHaveCount(0)
})

test("outsider review refusal is visible and can be requested again", async ({ page }) => {
  await owner(page)
  await page.route("**/api/public/repos", route => route.fulfill({ json: { repos: [{ name: "smithers-mvp-canary/node" }] } }))
  let requests = 0
  await page.route("**/api/reviews", route => {
    requests++
    return route.fulfill({ status: 403, json: { class: "permission", code: "permission", message: "PR author is not a member" } })
  })
  await page.goto("/smithers-mvp-canary/node")
  await say(page, "/review #51")
  await expect.poll(() => requests).toBe(1)
  await expect(page.getByText(/PR author is not a member/).last()).toBeVisible({ timeout: 15000 })
  await say(page, "/review #51")
  await expect.poll(() => requests).toBe(2)
})
