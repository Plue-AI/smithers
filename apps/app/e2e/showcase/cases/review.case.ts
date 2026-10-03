import { expect } from "@playwright/test"
import { showcase } from "../showcase"

/* plue's landing ("PR") shapes, as state/seams/LandingsSeam.ts reads them. */
const REPO = "smithersai/smithers"
const API = `/api/repos/${REPO}`
const MAIN = "kxyzqrpv", BASE = "mzxvbnmk", TIP = "qupxosqw"

const change = (id: string, commit: string, description: string, parents: ReadonlyArray<string>) => ({
  change_id: id, commit_id: commit, description, author_name: "will", author_email: "will@example.com",
  timestamp: "2026-09-24T10:00:00Z", parent_change_ids: parents
})
const CHANGES = [
  change(TIP, "a03f5f1111111111", "feat(flows): the split flow", [BASE]),
  change(BASE, "7c1d2e2222222222", "refactor(flows): extract the stack walk", [MAIN]),
  change(MAIN, "c0ffee1234567890", "main", [])
]
const PATCH = "@@ -1,3 +1,5 @@\n import { Flow } from \"@smthrs/flow\"\n+import { Schema } from \"effect\"\n \n-export default Flow.make(\"split\", { body })\n+export default Flow.make(\"split\", {\n+  payload: Schema.Struct({ change: Schema.String }), body })"

export default showcase({
  id: "review",
  order: 112,
  title: "Pull requests",
  summary: "Read a PR, approve and land it.",
  flows: [ "prs.tab", "prs.review", "prs.land", "prs.list", "prs.view"],
  run: async ({ page, app, backend }) => {
    let state = "open"
    const opened = true
    const reviews: Array<unknown> = []
    const writes: Array<string> = []
    await backend.cloud()
    await backend.json(`${API}/bookmarks`, {
      items: [
        { name: "main", target_change_id: MAIN, target_commit_id: "c0ffee1234567890", is_tracking_remote: false },
        { name: "split-flow", target_change_id: TIP, target_commit_id: "a03f5f1111111111", is_tracking_remote: false }
      ],
      next_cursor: ""
    })
    await backend.json(`${API}/changes`, { items: CHANGES, next_cursor: "" })
    await backend.json(`${API}/changes/${TIP}`, CHANGES[0])
    const detail = () => ({
      number: 12, title: "The split flow", state, body: "Splits a change into reviewable parts.\n\n- extract the stack walk\n- declare `split`",
      author: { login: "will" }, change_ids: [BASE, TIP], target_bookmark: "main", created_at: "2026-09-24T10:05:00Z", updated_at: "2026-09-24T10:05:00Z"
    })
    const OLDER = { number: 9, title: "Keep review history", state: "merged", author: { login: "reviewer" }, updated_at: "2026-09-21T10:00:00Z",
      body: "A merged review.", change_ids: ["abandoned1"], target_bookmark: "main", created_at: "2026-09-21T10:00:00Z" }
    await backend.route(url => url.pathname === `${API}/landings`, route => {
      if (route.request().method() === "POST") {
        writes.push("create")
        return route.fulfill({ status: 201, json: detail() })
      }
      return route.fulfill({ json: opened ? [detail(), OLDER] : [OLDER] })
    })
    await backend.json(`${API}/landings/12`, detail)
    await backend.json(`${API}/landings/9`, OLDER)
    await backend.route(url => url.pathname === `${API}/landings/12/reviews` || url.pathname === `${API}/landings/9/reviews`, route => {
      if (route.request().method() === "POST") {
        reviews.push({ ...route.request().postDataJSON(), reviewer_login: "codeplanesmithers" })
        return route.fulfill({ status: 201, json: {} })
      }
      return route.fulfill({ json: route.request().url().includes("/12/") ? reviews : [] })
    })
    await backend.route(url => url.pathname === `${API}/landings/12/land`, route => {
      writes.push("land")
      state = "queued"
      return route.fulfill({ status: 202, json: detail() })
    })
    await backend.json(`${API}/landings/12/changes`, CHANGES.slice(0, 2))
    await backend.json(`${API}/landings/12/diff`, { landing_number: 12, changes: [
      { change_id: BASE, file_diffs: [{ path: "flows/split/walk.ts", change_type: "added", additions: 18, deletions: 0, patch: "@@ -0,0 +1 @@\n+export const walk = () => []" }] },
      { change_id: TIP, file_diffs: [{ path: "flows/split/flow.ts", change_type: "modified", additions: 3, deletions: 1, patch: PATCH }] }
    ] })
    await backend.json(`${API}/landings/9/changes`, [])
    await backend.json(`${API}/landings/9/diff`, { landing_number: 9, changes: [] })
    await backend.json(`${API}/commits/${TIP}/statuses`, [
      { context: "typecheck", status: "success", created_at: "2026-09-24T10:07:00Z" },
      { context: "unit tests", status: "success", created_at: "2026-09-24T10:08:00Z" },
      { context: "browser e2e", status: "success", created_at: "2026-09-24T10:11:00Z" }
    ])

    await app.open("/")
    await app.slash(`/prs.view 12 ${REPO}`)
    const card = page.locator('[data-kind="pr"]').last()
    await expect(card).toContainText("The split flow", { timeout: 15_000 })
    await expect(card).toContainText("browser e2e")
    expect(writes).toEqual([])
    await app.closeComposer()
    await app.show(card)
    await app.beat(1500)

    await app.click(card.getByRole("tab", { name: /Files changed/ }))
    await expect(card).toContainText("flows/split/flow.ts")
    await app.beat(2000)
    await app.click(card.getByRole("tab", { name: /Conversation/ }))

    await app.click(card.getByRole("button", { name: "Approve", exact: true }))
    await expect(card).toContainText("approved", { timeout: 15_000 })
    await app.beat(1200)
    await app.click(card.getByRole("button", { name: /Land \(queue merge\)/ }))
    await expect.poll(() => writes).toEqual(["land"])
    await expect(card).toContainText(/queued/i, { timeout: 15_000 })
    await app.beat(1500)

    await app.slash(`/prs.list ${REPO}`)
    const list = page.locator('[data-kind="pr-list"]').last()
    await expect(list).toContainText("Keep review history")
    await app.closeComposer()
    await app.show(list)
    await app.beat(900)
    await app.click(list.getByText("Keep review history").first())
    await expect(page.locator('[data-kind="pr"]', { hasText: "Keep review history" })).toBeVisible({ timeout: 15_000 })
    await app.show(page.locator('[data-kind="pr"]', { hasText: "Keep review history" }))
  }
})
