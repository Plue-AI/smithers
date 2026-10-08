import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"
import { fixture, id, open, privateRow, roster } from "./confirmation-fixtures"

// UI projection of .specs/engineering/checks/C-J10-09.md.
// Explicit HTTP fixtures exercise the real review seam and agent tool door.
// Machine and GitHub write proofs run in TestJ10MemberReviewRehearsal;
// Mac microVM qualification remains a reference-host check.
// This scenario does not replace the check's backend, timing or reference-host receipts.
// Written before implementation: mvp.md §6.3, §14, Appendix A /review; lands with T-FLW-13, T-MCH-06, T-REL-02
test("C-J10-09: review shows teammate findings and confirms delegated review", async ({ page }) => {
  await owner(page)
  await page.route("**/api/public/repos", route => route.fulfill({ json: { repos: [{ name: "smithers-mvp-canary/node" }] } }))
  let launches = 0, refusals = 0
  await page.route("**/api/reviews", route => {
    const input = route.request().postDataJSON()
    expect(input.repo).toBe("smithers-mvp-canary/node")
    expect(route.request().headers()["idempotency-key"]).toBeTruthy()
    if (input.number === 51) {
      refusals++
      return route.fulfill({ status: 403, json: { class: "permission", code: "permission", message: "PR author is not a member" } })
    }
    expect(input.number).toBe(50)
    launches++
    return route.fulfill({ status: 202, json: { operationId: `member-review-${launches}`, state: "accepted" } })
  })
  await page.route("**/api/reviews/member-review-*", route => route.fulfill({ json: { state: "completed", change: {
    repo: "smithers-mvp-canary/node", changeId: "review-50", description: "Review", commitId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    currentSeq: null, revisionCount: null, revisions: [], authorName: null, timestamp: null, repos: [], diff: null,
    checks: null, findings: [{ analyzer: "review", severity: "fix", path: "src/cache.ts", line: 20, summary: "Off by one", raisedAtSeq: null }],
    reviews: null, threads: null, conflicts: null, stack: null, changeset: null,
    pullRequest: { number: 50, url: "https://github.com/smithers-mvp-canary/node/pull/50" }
  } } }))
  await page.goto('/smithers-mvp-canary/node')
  await say(page, '/review #50')
  await expect(page.getByText('Review', { exact: true }).last()).toBeVisible()
  await expect(page.getByText('fix', { exact: true }).last()).toBeVisible()
  await expect(page.getByText('src/cache.ts:20', { exact: true }).last()).toBeVisible()
  await expect(page.getByRole('link').filter({ hasText: /50/ }).last()).toBeVisible()
  expect(launches).toBe(1)
  await say(page, 'review PR 50')
  await expect(page.getByRole('button', { name: 'Confirm: review the pull request', exact: true }).last()).toBeVisible()
  await expect(page.getByText(/Smithers wants to review the pull request/).last()).toBeVisible()
  expect(launches).toBe(1)
  await page.getByRole('button', { name: 'Confirm: review the pull request', exact: true }).last().press('Enter')
  await expect.poll(() => launches).toBe(2)
  await expect(page.getByText('Review', { exact: true }).last()).toBeVisible()
  await say(page, '/review #51')
  await expect(page.getByText(/PR author is not a member/).last()).toBeVisible()
  expect(refusals).toBe(1)
  expect(launches).toBe(2)
  await expect(page.getByRole('region', { name: 'Review', exact: true }).last().getByRole('button', { name: 'Merge', exact: true })).toHaveCount(0)
})

// Served install confirmation projection: only an approved backend receipt
// may reconnect the review observer. The browser never relaunches that review.
test("C-J10-09: installed Confirm observes the admitted review only after approval", async ({ page }) => {
  let row = privateRow(), observations = 0, presses = 0, launches = 0
  row = { ...row, command: "review", payload: { input: { number: 50, repo: "smithers-mvp-canary/node", conversation: "main" },
    card: { ...row.payload.card, action: { tag: "review", verb: "Run review" }, text: "/review #50", subject: { kind: "branch", ref: "main", revision: row.revision } } } }
  const publish = await fixture(page, topic => topic === "confirmations:1" ? [row] : topic === "members" ? roster("member") : undefined)
  await page.route("**/api/auth/session", route => route.fulfill({ json: { id: 1, username: "canary-owner", is_admin: false } }))
  await page.route("**/api/public/repos", route => route.fulfill({ json: { repos: [{ name: "smithers-mvp-canary/node" }] } }))
  await page.route("**/api/reviews", route => { launches++; return route.fulfill({ status: 500, json: { message: "Duplicate launch" } }) })
  await page.route("**/api/reviews/confirmed-review", route => {
    observations++
    return route.fulfill({ json: { state: "completed", change: {
      repo: "smithers-mvp-canary/node", changeId: "review-50", description: "Review", commitId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      currentSeq: null, revisionCount: null, revisions: [], authorName: null, timestamp: null, repos: [], diff: null, checks: null,
      findings: [{ analyzer: "review", severity: "fix", path: "src/cache.ts", line: 20, summary: "Off by one", raisedAtSeq: null }],
      reviews: null, threads: null, conflicts: null, stack: null, changeset: null,
      pullRequest: { number: 50, url: "https://github.com/smithers-mvp-canary/node/pull/50" }
    } } })
  })
  await page.route(`**/api/confirmations/${id}/approve`, async route => {
    presses++
    expect(route.request().postDataJSON()).toEqual({ subject: row.payload.card.subject, revision: row.revision })
    await route.fulfill({ status: 202, json: { id, state: "pending" } })
  })
  const confirm = await open(page)
  expect(observations).toBe(0)
  await confirm.getByRole("button", { name: "Run review", exact: true }).press("Enter")
  await expect.poll(() => presses).toBe(1)
  expect(observations).toBe(0)
  row = { ...row, state: "approved", payload: { ...row.payload, effect: { review: "confirmed-review", request: `confirmation:${id}` } } }
  publish("confirmations:1")
  await expect(page.getByText("Off by one", { exact: true })).toBeVisible()
  expect(observations).toBeGreaterThan(0)
  expect(launches).toBe(0)
  await expect(page.getByRole("link", { name: "#50", exact: true })).toHaveAttribute("href", "https://github.com/smithers-mvp-canary/node/pull/50")
})
