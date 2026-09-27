import { expect } from "@playwright/test"
import { showcase } from "../showcase"

/* Fixtures follow e2e/playwright/change.spec.ts (plue's deployed DTO shapes). */
const REPO = "smithersai/smithers"
const API = `/api/repos/${REPO}`
const TURN = { party: "reviewer", actor_id: "9", since: "2026-09-01T10:01:00Z", reason: "opened" }

const CHANGE = {
  change_id: "qupxosqw",
  commit_id: "a03f5f1111111111",
  description: "Add the split flow\n\nSplit a change into reviewable parts.",
  author_name: "will",
  author_email: "will@example.com",
  timestamp: "2026-09-01T10:00:00Z",
  has_conflict: false,
  is_empty: false,
  parent_change_ids: ["mzxvbnmk"],
  parent_change_id: "mzxvbnmk",
  revisions: [
    { seq: 1, commit_id: "9b1c2d3333333333", parent_commit_id: "p1", source: "agent", operation_ids: [], created_at: "2026-09-01T09:40:00Z" },
    { seq: 2, commit_id: "a03f5f1111111111", parent_commit_id: "p1", source: "push", operation_ids: [], created_at: "2026-09-01T10:00:00Z" }
  ],
  reviews: [],
  current_seq: 2,
  conflicts: [],
  stack: { landing_request_id: 900, position: 1, size: 1, turn: TURN },
  turn: TURN,
  revision_seq: 2,
  owners: { touched_paths: [], required_approvers: [], suggested_reviewers: ["ana"], missing_approvals: [] },
  landed: null
}

const PATCH = [
  "@@ -1,6 +1,9 @@",
  " import { Flow } from \"@smthrs/flow\"",
  "+import { Schema } from \"effect\"",
  " ",
  " export default Flow.make(\"split\", {",
  "-  description: \"Split\",",
  "+  description: \"Split a change into reviewable parts\",",
  "+  payload: Schema.Struct({ change: Schema.String }),",
  "+  success: Schema.Array(Schema.String),",
  "   body: split",
  " })"
].join("\n")

const thread = (id: number, path: string, line: number, body: string, state: "open" | "done" | "resolved") => ({
  id, landing_request_id: 900, user_id: 9, user_login: "ana", path, line, side: "new", body,
  commit_id: "a03f5f1111111111", anchor_hash: `h${id}`, state, anchor_state: "current", done_at: state === "open" ? null : "2026-09-01T10:05:00Z",
  done_by: state === "open" ? null : 7, resolved_in_revision: state === "open" ? null : { commit_id: "a03f5f1111111111", seq: 2 },
  resolved_at: state === "resolved" ? "2026-09-01T10:06:00Z" : null, resolved_by: state === "resolved" ? 9 : null,
  created_at: "2026-09-01T10:02:00Z", updated_at: "2026-09-01T10:02:00Z"
})

export default showcase({
  id: "change",
  order: 110,
  title: "Change",
  summary: "Triage findings, settle review comments, ask a reviewer, land, read the diff.",
  flows: ["change.view", "change.facet", "findings.please-fix", "findings.not-useful", "review.done", "review.ack", "review.request", "review.unrequest", "change.land", "change.diff"],
  run: async ({ page, app, backend }) => {
    let landing = "open"
    const lands: Array<unknown> = []
    const acts: Array<string> = []
    let threadState: "open" | "done" | "resolved" = "open"
    let notUseful = false
    const requests: Array<{ id: number; reviewer: { id: number; login: string }; requested_by: { id: number; login: string }; state: string; created_at: string }> = []
    await backend.cloud({ capabilities: ["agent", "identity", "cloud", "cloud.pat"] })
    await backend.json(`${API}/changes/qupxosqw`, CHANGE)
    await backend.json(`${API}/changes/qupxosqw/conflicts`, [])
    await backend.json(`${API}/changes/qupxosqw/diff`, {
      change_id: "qupxosqw",
      file_diffs: [
        { path: "flows/split/flow.ts", change_type: "modified", patch: PATCH, is_binary: false, additions: 4, deletions: 1 },
        { path: "flows/split/README.md", change_type: "added", patch: "@@ -0,0 +1 @@\n+# split", is_binary: false, additions: 1, deletions: 0 }
      ]
    })
    await backend.json(`${API}/changes/qupxosqw/findings`, () => ({
      change_id: "qupxosqw", current_seq: 2,
      findings: [
        { id: 11, seq: 2, commit_id: "a03f5f1111111111", analyzer: "smithers-review", source: "agent", path: "flows/split/flow.ts", line: 6, side: "new", severity: "warning", text: "the payload accepts an empty change id", state: "current", created_at: "2026-09-01T10:06:00Z" },
        { id: 12, seq: 2, commit_id: "a03f5f1111111111", analyzer: "lint", source: "analyzer", path: "flows/split/README.md", line: 1, side: "new", severity: "info", text: "heading is lowercase", state: "current", created_at: "2026-09-01T10:06:00Z",
          ...(notUseful ? { feedback: { useful: false, by_user_id: 7 }, feedback_counts: { useful: 0, not_useful: 1 } } : {}) }
      ],
      analyzers: [{ name: "smithers-review", state: "finished", seq: 2, started_at: "2026-09-01T10:05:00Z", finished_at: "2026-09-01T10:06:00Z" }]
    }))
    await backend.route(url => url.pathname === `${API}/changes/qupxosqw/findings/11/dispatch`, route => {
      acts.push("please-fix")
      return route.fulfill({ status: 202, json: { id: "as-7", status: "running" } })
    })
    await backend.route(url => url.pathname === `${API}/changes/qupxosqw/findings/12/feedback`, route => {
      acts.push("not-useful")
      notUseful = true
      return route.fulfill({ json: { useful: false, by_user_id: 7 } })
    })
    await backend.json(`${API}/changes/qupxosqw/walkthrough`, { message: "walkthrough not found" }, 404)
    await backend.json(`${API}/landings`, () => ({
      items: [{
        number: 42, state: landing, change_ids: ["qupxosqw"], stack_size: 1, target_bookmark: "main",
        conflict_status: "none", turn: TURN, auto_land: { enabled: false, set_by: null, set_at: null, waiting_on: [] },
        landable_prefix: 1, blocked_by: {}, review_requests: requests
      }]
    }))
    await backend.json(`${API}/landings/42/reviews`, { reviews: [] })
    await backend.json(`${API}/landings/42/comments`, () => ({ comments: [thread(3, "flows/split/flow.ts", 6, "reject an empty change id", threadState)] }))
    await backend.route(url => /\/landings\/42\/threads\/3\/(done|ack)$/.test(url.pathname), route => {
      const verb = route.request().url().endsWith("/ack") ? "ack" : "done"
      acts.push(verb)
      threadState = verb === "ack" ? "resolved" : "done"
      return route.fulfill({ json: thread(3, "flows/split/flow.ts", 6, "reject an empty change id", threadState) })
    })
    await backend.route(url => url.pathname.startsWith(`${API}/landings/42/review-requests`), route => {
      if (route.request().method() === "POST") {
        acts.push("request")
        requests.push({ id: 5, reviewer: { id: 9, login: "ana" }, requested_by: { id: 7, login: "codeplanesmithers" }, state: "requested", created_at: "2026-09-01T10:08:00Z" })
        return route.fulfill({ status: 201, json: requests[0] })
      }
      acts.push("unrequest")
      requests.splice(0)
      return route.fulfill({ status: 204, body: "" })
    })
    await backend.route(url => url.pathname === `${API}/landings/42/land`, route => {
      lands.push(route.request().postDataJSON())
      landing = "queued"
      return route.fulfill({ status: 202, json: { number: 42, state: "queued" } })
    })
    await backend.json(`${API}/commits/a03f5f1111111111/statuses`, {
      statuses: [
        { context: "typecheck", status: "success", created_at: "2026-09-01T10:02:00Z" },
        { context: "unit tests", status: "success", created_at: "2026-09-01T10:03:00Z" },
        { context: "browser e2e", status: "success", created_at: "2026-09-01T10:06:00Z" }
      ]
    })
    await backend.json("/api/orgs/smithersai/changesets", { changesets: [] })

    await app.open("/")
    await app.slash("/change.view qupxosqw")
    const card = page.getByTestId(`card-change-${REPO}-qupxosqw`)
    await expect(card).toContainText("Add the split flow", { timeout: 15_000 })
    await expect(card).toContainText("1 comment open")
    await app.closeComposer()
    await app.show(card)
    await app.beat(1200)

    await app.click(card.getByRole("tab", { name: "Findings" }))
    await expect(card).toContainText("the payload accepts an empty change id")
    await app.click(card.getByRole("button", { name: "Dispatch the agent on finding 11" }))
    await expect.poll(() => acts).toContain("please-fix")
    await app.click(card.getByRole("button", { name: "Mark finding 12 not useful" }))
    await expect(card).toContainText("not useful")
    await app.beat(900)

    await app.click(card.getByRole("tab", { name: "Review" }))
    await app.click(card.getByRole("button", { name: "Mark comment 3 done" }))
    await app.click(card.getByRole("button", { name: "Acknowledge comment 3" }))
    await expect(card).toContainText("resolved")
    await app.click(card.getByRole("button", { name: "Request review from ana" }))
    await app.click(card.getByRole("button", { name: "Dismiss review request 5" }))
    await expect(card).toContainText("Nobody has been asked")
    await app.beat(900)

    await app.click(card.getByRole("button", { name: "Land the change" }))
    await expect.poll(() => lands).toEqual([{ commit_id: "a03f5f1111111111" }])
    await expect(card).toContainText("queued → main", { timeout: 15_000 })
    expect(acts).toEqual(["please-fix", "not-useful", "done", "ack", "request", "unrequest"])
    await app.beat(1200)

    await app.click(card.getByRole("button", { name: "Open the full diff card" }))
    const diff = page.getByTestId(`card-diff-${REPO}-qupxosqw`)
    await expect(diff.locator('[data-slot="pierre-diff-view"]').first()).toContainText("reviewable parts", { timeout: 15_000 })
    await app.show(diff)
    await app.beat(1800)
  }
})
