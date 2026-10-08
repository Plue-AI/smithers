import { readFileSync } from "node:fs"
import { test } from "../support"
import { scenario } from "../coverage/types"
import { withReference, required, openTodo, todoCard, home, runSlash, expect, attachJson } from "../todo/reference"
import { todoCard as card, waitTodo as until, withJ10Install, type GitHubIssue, type J10Install } from "./install"

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

// The whole C-J10-05 journey, on the reference host or on the composed
// install with the GitHub fake (TestJ10MergeOnGitHubBrowser): issues become
// T7 and T8, both run the packaged TODO flow, so their PRs come from the
// packaged stack.candidate and stack.propose dispatch. Merging stays a
// person's act on GitHub: Smithers records no checks.Land and makes no merge
// call. Expectations are literals or independent reads of GitHub.

const T7 = { title: "Add retry helper", file: "retry-helper.md", text: "Add a retry helper for webhook deliveries." }
const T8 = { title: "Retry webhooks", file: "retry-webhooks.md", text: "Retry failed webhook deliveries." }
const CLOSING = /\b(close[sd]?|fix(e[sd])?|resolve[sd]?):?\s+(#|https:\/\/github\.com\/\S+\/issues\/)\d+/i

/** The owner's Make TODO on a GitHub issue, appended, as the issue card's button sends it. */
const fromIssue = async (f: J10Install, issue: number, fixes: boolean, todo: typeof T7): Promise<number> => {
  const thread = await f.read("Owner", `/api/issues/${issue}`)
  const filed = await f.api("Owner", "POST", "/api/todos", {
    title: todo.title, prompt: f.prompt(todo.file, todo.text), acceptance: [], place: { mode: "append" },
    issue, issue_digest: thread.issue_digest, fixes
  }, `c-j10-05-issue-${issue}`)
  expect(filed.status, JSON.stringify(filed.body)).toBe(202)
  return filed.body.n
}
/** Runs one dependent step; its failure is reported and the journey goes on. */
const soft = async (name: string, step: () => Promise<void>): Promise<void> => {
  try { await step() } catch (error) { expect.soft(String(error), name).toBe("") }
}
const landedMain = async (f: J10Install): Promise<string> => (await f.read("Owner", `/api/repos/${f.repo}/mythical`)).landedMain
const appLand = (f: J10Install, n: number): boolean => f.sql(`SELECT checks ? 'land' AS land FROM mythical_items WHERE number = ${n}`)[0].land

const journey = scenario("journey-github-merge-on-github", {
  capabilities: [],
  coverage: ["host:local", "host:production", "action:todo", "path:success", "door:user-only", "surface:todo", "dimension:github", "dimension:merge", "evidence:github-write-log"],
  description: "C-J10-05: merges on GitHub turn TODOs Merged, close only the fixed issue with a link, and Smithers makes no merge call."
})

test("C-J10-05 merge on GitHub turns the TODO Merged", journey, async ({ browser }, info) => {
  test.setTimeout(2_400_000)
  await withJ10Install(browser, info, async f => {
    const owner = f.members.Owner
    // Setup: issue #I becomes T7 (fixes it), issue #J becomes T8 (refers only); both in review.
    const issueI = await f.github.openIssue("Ben", "Add retry helper", "Webhook deliveries need one retry helper.")
    const issueJ = await f.github.openIssue("Ben", "Retry webhooks", "Failed webhook deliveries should retry.")
    const t7 = await fromIssue(f, issueI, true, T7)
    const t8 = await fromIssue(f, issueJ, false, T8)
    const seven = await until(f, t7, "in_review")
    await until(f, t8, "in_review")
    const pull7 = await f.github.pull(seven.pr.number)
    expect(pull7.draft).toBe(false)
    // GitHub must never close #I itself at merge time.
    expect(pull7.body).not.toMatch(CLOSING)
    expect((await f.github.issue(issueI)).state).toBe("open")
    const mainBefore = await f.github.main()

    // Step 1: the owner squash-merges T7's PR on GitHub, watching Home.
    await runSlash(owner.page, "/home")
    const mainRow = owner.page.locator(".smithers-card.home").last().locator(".stack-main-row .stack-trunk span[title]")
    const t0 = Date.now()
    const merge7 = await f.github.merge(pull7.number, pull7.head.sha)
    // Step 2: T7 turns Merged within 60 s, never before Home's main row shows the merge commit.
    let mergedAt = 0, shownAtMerge: string | null = null
    await expect.poll(async () => {
      const shown = await mainRow.getAttribute("title").catch(() => null)
      const now = await card(f, t7)
      if (now.state === "merged") [mergedAt, shownAtMerge] = [Date.now(), shown]
      return now.state
    }, { timeout: 60_000, intervals: [250] }).toBe("merged")
    expect.soft(shownAtMerge, `T${t7} turned Merged while Home's main row showed ${shownAtMerge}, not GitHub's merge ${merge7}`).toBe(merge7)
    await soft("the stack folds GitHub's merge into the install's main", async () => {
      await expect.poll(async () => f.github.contains(merge7, await landedMain(f)), { timeout: 60_000 }).toBe(true)
    })
    await runSlash(owner.page, `/todo T${t7}`)
    const card7 = owner.page.getByRole("article", { name: `TODO T${t7}`, exact: true }).last()
    await expect.soft(card7).toContainText("Merged")
    await expect.soft(card7.getByRole("button", { name: "Merge", exact: true })).toHaveCount(0)
    await info.attach("home-t7-merged.png", { body: await owner.page.screenshot(), contentType: "image/png" })

    // Step 3: the App closes #I as completed with a comment that links the change, within 60 s.
    await soft("step 3: the App closes #I with a link within 60 s", async () => {
      let closedI!: GitHubIssue
      try {
        await expect.poll(async () => {
          closedI = await f.github.issue(issueI)
          return closedI.state === "closed" && closedI.comments.some(comment => comment.viaApp && comment.body.includes(merge7.slice(0, 7)))
        }, { timeout: Math.max(1_000, mergedAt + 60_000 - Date.now()), intervals: [250] }).toBe(true)
      } finally {
        await attachJson(info, "issue-I.json", { ...closedI, seconds_after_merged: (Date.now() - mergedAt) / 1000 })
      }
      expect.soft(closedI.stateReason).toBe("completed")
    })

    // Steps 4-5: T8 follows the new main under the same PR, no longer names
    // T7, and Merge is enabled; merged on GitHub, #J (only referred to) stays
    // open. A failed step is reported and the invariants below still run.
    let pull8 = await f.github.pull((await card(f, t8)).pr.number)
    await soft("step 4: T8 follows the new main", async () => {
      const eight = await until(f, t8, "in_review", async now => {
        pull8 = await f.github.pull(now.pr.number)
        const head = await f.github.commit(pull8.head.sha)
        return now.merge.state === "ready" && !pull8.draft && pull8.head.sha === now.pr.head && head.parents.length === 1 && head.parents[0] === merge7
      }, 480_000)
      expect.soft(pull8.body).not.toContain(`[T${t7}]`)
      expect.soft(pull8.body).not.toContain(pull7.html_url)
      expect.soft(pull8.body).not.toMatch(CLOSING)
      expect.soft(await f.github.main()).toBe(merge7)
      expect.soft(merge7).not.toBe(mainBefore)
      await soft("step 5: T8 merged on GitHub", async () => {
        const merge8 = await f.github.merge(pull8.number, eight.pr.head)
        expect.soft((await f.github.pull(pull8.number)).merged).toBe(true)
        await until(f, t8, "merged", () => true, 60_000)
        await expect.poll(async () => f.github.contains(merge8, await landedMain(f)), { timeout: 60_000 }).toBe(true)
      })
    })
    await owner.page.waitForTimeout(5_000)
    const openJ = await f.github.issue(issueJ)
    await attachJson(info, "issue-J.json", openJ)
    expect.soft(openJ.state, "#J is only referred to and stays open").toBe("open")

    // No checks.Land and no App merge call for either; people merged on GitHub.
    const pr7 = await f.github.pull(pull7.number), pr8 = await f.github.pull(pull8.number)
    await attachJson(info, "pr-7.json", pr7)
    await attachJson(info, "pr-8.json", pr8)
    await attachJson(info, "timing.json", { t0, mergedAt, merged: merge7, closedWithin: "60 s" })
    expect.soft(pr7.merged).toBe(true)
    for (const [n, pull] of [[t7, pr7], [t8, pr8]] as const) {
      expect.soft(appLand(f, n)).toBe(false)
      expect.soft(await f.github.appMerges(pull.number)).toBe(0)
      if (f.kind === "reference") expect.soft(pull.merged_by?.login).toBe(owner.login)
    }
    // An in-order merge opens no out-of-order attention.
    expect.soft(f.sql("SELECT attention FROM mythical_stacks WHERE state = 'active'").flatMap((row: { attention: unknown[] | null }) => row.attention ?? [])).toEqual([])
  })
})
