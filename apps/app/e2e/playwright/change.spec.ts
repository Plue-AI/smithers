import { fillComposer } from "./composer"
import type { Page } from "./browserTest"
import { expect,test } from "./browserTest"
import { installCloudFixture } from "./cloudFixture.ts"

/*
 * Lane change T1 (ADR 0003): against
 * a fake cloud upstream the app opens a landing request's change end to end —
 * the change card carries the DTO, the stat, the stack position, and the
 * checks; the History facet lists the recorded revision with its provenance
 * (plue#450); the diff card renders parent → current pinned at the change's
 * commit; a rev pin resolves against the recorded revisions; and a degraded
 * sign-in reads the change freely but is refused an agent dispatch with the
 * exact enable wording.
 *
 * The server is a double: the shared cloud fixture (cloudFixture.ts) answers
 * the bootstrap, the cloud session and the Smithers Cloud inventory; this
 * spec adds the change's own routes behind /api/cloud/*.
 */

const REPO = "smithersai/smithers"

/** plue's change GET at the deployed shape (ChangeDetailResponse @ 1f8b9e2a909b): one recorded revision, no reviews yet. */
const CHANGE = {
  change_id: "qupxosqw",
  commit_id: "a03f5f1111111111",
  description: "Add the split flow\n\nLong body.",
  author_name: "will",
  author_email: "will@example.com",
  timestamp: "2026-09-01T10:00:00Z",
  has_conflict: false,
  is_empty: false,
  parent_change_ids: ["mzxvbnmk"],
  parent_change_id: "mzxvbnmk",
  revisions: [
    { seq: 1, commit_id: "a03f5f1111111111", parent_commit_id: "p1", source: "push", operation_ids: [], created_at: "2026-09-01T10:00:00Z" }
  ],
  reviews: [],
  current_seq: 1,
  conflicts: [],
  stack: { landing_request_id: 900, position: 2, size: 2, turn: { party: "reviewer", actor_id: "9", since: "2026-09-01T10:01:00Z", reason: "opened" } },
  turn: { party: "reviewer", actor_id: "9", since: "2026-09-01T10:01:00Z", reason: "opened" },
  revision_seq: 1,
  owners: { touched_paths: [], required_approvers: [], suggested_reviewers: [], missing_approvals: [] },
  landed: null
}

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body)
})

/** Install the server double: signed in to a cloud that inventories smithersai/smithers. */
const serve = async (
  page: Page,
  options: { readonly degraded?: boolean } = {}
): Promise<void> => {
  await installCloudFixture(page, { ...options, capabilities: ["agent", "identity", "cloud", "cloud.pat"] })
  /* The change's own routes. */
  await page.route(`**/api/repos/${REPO}/changes/qupxosqw`, (route) => route.fulfill(json(CHANGE)))
  await page.route(`**/api/repos/${REPO}/changes/qupxosqw/conflicts`, (route) => route.fulfill(json([])))
  /* The bare diff and the pinned interdiff (`?from=parent&to=1`) answer the same one file; findings are empty, no walkthrough exists. */
  await page.route(new RegExp(`/api/repos/${REPO}/changes/qupxosqw/diff(\\?.*)?$`), (route) =>
    route.fulfill(json({
      change_id: "qupxosqw",
      file_diffs: [
        { path: "src/app.ts", change_type: "modified", patch: "@@ -1 +1 @@\n-old\n+new", is_binary: false, additions: 1, deletions: 1 }
      ]
    })))
  await page.route(`**/api/repos/${REPO}/changes/qupxosqw/findings`, (route) =>
    route.fulfill(json({ change_id: "qupxosqw", current_seq: 1, findings: [], analyzers: [] })))
  await page.route(new RegExp(`/api/repos/${REPO}/changes/qupxosqw/walkthrough(\\?.*)?$`), (route) =>
    route.fulfill(json({ message: "walkthrough not found" }, 404)))
  await page.route(new RegExp(`/api/repos/${REPO}/landings\\?`), (route) =>
    route.fulfill(json({
      items: [{
        number: 42,
        state: "open",
        change_ids: ["mzxvbnmk", "qupxosqw"],
        stack_size: 2,
        target_bookmark: "main",
        conflict_status: "none",
        turn: { party: "reviewer", actor_id: "9", since: "2026-09-01T10:01:00Z", reason: "opened" },
        auto_land: { enabled: false, set_by: null, set_at: null, waiting_on: [] },
        landable_prefix: 2,
        blocked_by: {}
      }]
    })))
  await page.route(new RegExp(`/api/repos/${REPO}/landings/42/reviews`), (route) => route.fulfill(json({ reviews: [] })))
  await page.route(new RegExp(`/api/repos/${REPO}/landings/42/comments`), (route) => route.fulfill(json({ comments: [] })))
  await page.route(new RegExp(`/api/repos/${REPO}/commits/a03f5f1111111111/statuses`), (route) =>
    route.fulfill(json({ statuses: [{ context: "build", status: "success", created_at: "2026-09-01T09:59:00Z" }] })))
  await page.route("**/api/orgs/smithersai/changesets", (route) => route.fulfill(json({ changesets: [] })))
}

test.beforeEach(async ({ page }) => {
  // A persisted store from an earlier test must not carry state across tests.
  await page.addInitScript(() => {
    try {
      window.localStorage.clear()
    } catch {
      // Storage the browser refuses is the empty store already.
    }
  })
})

test("T1: /change.view renders a landing request's change end to end", async ({ page }) => {
  await serve(page)
  await page.goto("/")

  await fillComposer(page, "/change.view qupxosqw")
  await page.getByTestId("composer-send").click()

  const card = page.getByTestId("card-change-smithersai/smithers-qupxosqw")
  await expect(card).toBeVisible({ timeout: 15_000 })
  await expect(card).toHaveAttribute("aria-label", "qupxosqw · Add the split flow")
  await expect(card).toContainText("Add the split flow")
  await expect(card).toContainText("smithersai/smithers +1 −1")
  await expect(card).toContainText("Landing #42 · position 2 of 2 · open → main · 2 of 2 landable")
  await expect(card).toContainText("rev 1 of 1")
  await expect(card).toContainText("turn: reviewer")

  // The diff facet (the default) lists the file; the checks facet renders the newest answer per context.
  await expect(card).toContainText("src/app.ts")
  await page.getByTestId("composer-input").press("Escape")
  await expect(page.getByTestId("composer-input")).toBeHidden()
  await card.getByRole("tab", { name: "Checks" }).click()
  await expect(card).toContainText("build")
  await expect(card).toContainText("success")

  // The History facet: the recorded revision with its provenance (plue#450), nothing invented beside it.
  await card.getByRole("tab", { name: "History" }).click()
  await expect(card).toContainText("rev 1")
  await expect(card).toContainText("a03f5f11 · push")
  await expect(card).not.toContainText("plue#450")
})

test("T1: /change.diff renders the parent → current pair pinned at the change's commit", async ({ page }) => {
  await serve(page)
  await page.goto("/")

  await fillComposer(page, "/change.diff qupxosqw")
  await page.getByTestId("composer-send").click()

  const card = page.getByTestId("card-diff-smithersai/smithers-qupxosqw")
  await expect(card).toBeVisible({ timeout: 15_000 })
  await expect(card).toContainText("smithersai/smithers · qupxosqw · parent → current")
  await expect(card).toContainText("pinned at rev 1 · a03f5f1")
  await expect(card.locator('span[title="a03f5f1111111111"]')).toHaveText("a03f5f1")
  await expect(card).toContainText("src/app.ts")
  // Code-intel L5: the hunk renders through the pierre view (its lines live in a shadow root, which toContainText pierces), not a bare <pre>.
  const view = card.locator('[data-slot="pierre-diff-view"]')
  await expect(view).toBeVisible({ timeout: 15_000 })
  await expect(view).toContainText("old")
  await expect(view).toContainText("new")
})

test("T1: a rev-pinned view pins the Diff facet parent → rev N; a rev the change lacks refuses by name", async ({ page }) => {
  await serve(page)
  await page.goto("/")

  await fillComposer(page, "/change.view qupxosqw 1")
  await page.getByTestId("composer-send").click()
  const card = page.getByTestId("card-change-smithersai/smithers-qupxosqw")
  await expect(card).toBeVisible({ timeout: 15_000 })
  await expect(card.getByLabel("Diff to")).toHaveValue("1")

  await fillComposer(page, "/change.view qupxosqw 2")
  await page.getByTestId("composer-send").click()
  const toast = page.locator('.mvp-notify .mvp-notice[data-tone="failed"]')
  await expect(toast).toContainText("qupxosqw has no rev 2 — its revisions are 1 → 1.", { timeout: 15_000 })
})

test("T1: a degraded sign-in reads a change freely but can't dispatch an agent", async ({ page }) => {
  await serve(page, { degraded: true })
  await page.goto("/")

  await fillComposer(page, "/change.view qupxosqw")
  await page.getByTestId("composer-send").click()
  const card = page.getByTestId("card-change-smithersai/smithers-qupxosqw")
  await expect(card).toBeVisible({ timeout: 15_000 })
  await expect(card).toContainText("qupxosqw")

  await fillComposer(page, "/change.resolve qupxosqw src/app.ts")
  await page.getByTestId("composer-send").click()
  const toast = page.locator('.mvp-notify .mvp-notice[data-tone="failed"]')
  await expect(toast).toContainText("sign in again to enable", { timeout: 15_000 })
})
