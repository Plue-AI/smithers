import { readFileSync } from "node:fs"
import { test } from "../support"
import { scenario } from "../coverage/types"
import { withReference, required, openTodo, todoCard, home, runSlash, expect, attachJson } from "../todo/reference"

// Prepared C-J10-05 continuation: real issue-derived T7 fixes its issue; T8
// references another issue without fixing it. All earlier items are merged.
// Preparation uses the app and real GitHub; no fixture endpoint or SQL writes.
test("C-J10-05 owner merge on GitHub updates Home and closes only the fixed issue", scenario("journey-merge-on-github", {
  capabilities: [], coverage: ["host:local", "host:production", "door:slash", "surface:todo", "surface:home", "dimension:keyboard", "dimension:github", "path:success", "evidence:github-merge-and-main-readback"]
}), async ({ browser }, info) => {
  test.setTimeout(1_800_000)
  expect(required("SMITHERS_JOURNEY_KEYBOARD")).toBe("1")
  expect(["light", "dark"]).toContain(required("SMITHERS_JOURNEY_THEME"))
  const auditPath = required("SMITHERS_JOURNEY_GITHUB_AUDIT_LOG")
  const audit = () => readFileSync(auditPath, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line))
  audit()
  await withReference(browser, info, async f => {
    const page = f.members.Ben.page
    const owner = await f.read("Will", "/api/user")
    const all = await f.read("Ben", "/api/todos")
    expect(all.filter((todo: any) => todo.n < 7).every((todo: any) => todo.state === "merged")).toBe(true)
    const first = await f.read("Ben", "/api/todos/7"), later = await f.read("Ben", "/api/todos/8")
    for (const todo of [first, later]) {
      expect(todo.state).toBe("in_review")
      expect(todo.pr.head).toMatch(/^[0-9a-f]{40}$/)
      expect(todo.issue.number).toBeGreaterThan(0)
    }
    expect(first.issue.fixes).toBe(true)
    expect(later.issue.fixes).toBe(false)
    expect(first.issue.number).not.toBe(later.issue.number)
    const merges = () => audit().filter(entry => entry.method === "PUT" && entry.path.startsWith(`/repos/${f.repo}/pulls/`) && entry.path.endsWith("/merge"))
    const beforeCalls = merges().length
    const receipts: unknown[] = []
    for (const number of [7, 8]) {
      let current: any
      await expect.poll(async () => { current = await f.read("Ben", `/api/todos/${number}`); return current.merge?.state },
        { timeout: 660_000 }).toBe("ready")
      const pullBefore = await f.github("Will", "GET", `/pulls/${current.pr.number}`) as any
      expect(pullBefore.base.ref).toBe("main")
      expect(pullBefore.draft).toBe(false)
      expect(pullBefore.head.sha).toBe(current.pr.head)
      expect(pullBefore.body ?? "").not.toMatch(new RegExp(`(?:fixes|closes|resolves)\\s+#${current.issue.number}\\b`, "i"))
      if (number === 8) {
        expect(current.pr.head).not.toBe(later.pr.head)
        const commit = await f.github("Ben", "GET", `/commits/${current.pr.head}`) as any
        expect(commit.parents.map((parent: any) => parent.sha)).toContain((receipts[0] as any).sha)
      }
      await openTodo(page, number)
      await runSlash(page, "/home")
      const started = Date.now()
      // This is the independent owner's GitHub credential, never the App's.
      const merged = await f.github("Will", "PUT", `/pulls/${current.pr.number}/merge`, { sha: current.pr.head, merge_method: "squash" }) as any
      expect(merged.merged).toBe(true)
      expect(merged.sha).toMatch(/^[0-9a-f]{40}$/)
      const samples: { at: number; state: string | null; apiState: string; main: string | null }[] = []
      await expect.poll(async () => {
        const todo = await f.read("Ben", `/api/todos/${number}`)
        const sha = await home(page).locator(".stack-main-row .stack-trunk span[title]").getAttribute("title")
        const shown = await todoCard(page, number).locator("header .state").getAttribute("data-state")
        samples.push({ at: Date.now(), state: shown, apiState: todo.state, main: sha })
        if (shown === "merged") expect(sha).toBe(merged.sha)
        return todo.state === "merged" && shown === "merged" && sha === merged.sha
      }, { timeout: 60_000, intervals: [500, 1000] }).toBe(true)
      await expect(todoCard(page, number)).toContainText("Merged")
      const pull = await f.github("Ben", "GET", `/pulls/${current.pr.number}`) as any
      expect(pull.merged_by.login).toBe(owner.username)
      expect(pull.merge_commit_sha).toBe(merged.sha)
      expect((await f.github("Ben", "GET", "/commits/main") as any).sha).toBe(merged.sha)
      const issueNumber = current.issue.number
      let issue: any, comments: any[] = []
      if (number === 7) await expect.poll(async () => {
        issue = await f.github("Ben", "GET", `/issues/${issueNumber}`)
        comments = await f.github("Ben", "GET", `/issues/${issueNumber}/comments`) as any[]
        return issue.state === "closed" && comments.some(comment => comment.body.includes(`/pull/${current.pr.number}`))
      }, { timeout: 60_000, intervals: [1000] }).toBe(true)
      else {
        issue = await f.github("Ben", "GET", `/issues/${issueNumber}`)
        expect(issue.state).toBe("open")
      }
      if (number === 7) {
        expect(issue.closed_by.type).toBe("Bot")
        expect(comments.find(comment => comment.body.includes(`/pull/${current.pr.number}`))?.user.type).toBe("Bot")
      }
      expect(merges().slice(beforeCalls)).toEqual([])
      expect(f.sql(`SELECT checks->'land' AS land FROM mythical_items WHERE issue_url = 'https://github.com/${f.repo}/issues/${issueNumber}'`)).toEqual([{ land: null }])
      receipts.push({ number, t0: new Date(started).toISOString(), sha: merged.sha, samples, pull, issue, comments })
    }
    await attachJson(info, "github-owner-merge", receipts)
  })
})

