import { test } from "../support"
import { scenario } from "../coverage/types"
import { attachJson, expect, runSlash } from "../todo/reference"
import { waitTodo, withJ10Install, type J10Actor, type J10Install } from "./install"

// C-J10-01: a TODO's PR on smithers/<slug>, based on main, with its prompt,
// evidence, included items and requester. Every TODO runs the packaged TODO
// flow, so its PR comes from the packaged stack.candidate and stack.propose
// dispatch. Expectations are literals or independent reads of GitHub, never
// derived from the product's code or a spec file.

const T1 = { title: "Add retry helper", file: "retry-helper.md", text: "Add a retry helper for webhook deliveries.", branch: "smithers/add-retry-helper" }
const T2 = { title: "Retry webhooks", file: "retry-webhooks.md", text: "Retry failed webhook deliveries.", branch: "smithers/retry-webhooks", acceptance: "retries 3 times with backoff" }
const AMEND = "Also log each retry of a failed webhook delivery."
// GitHub's closing keyword before an issue reference; a TODO's body never carries one.
const CLOSING = /\b(close[sd]?|fix(e[sd])?|resolve[sd]?):?\s+(#|https:\/\/github\.com\/\S+\/issues\/)\d+/i
// A bare #n, which GitHub autolinks to whatever issue or PR has that number.
const BARE = /(?<![\w/&[])#\d+\b/

const until = waitTodo
// C-J10-01: Ben, a maintainer, appends both TODOs and is their requester.
const REQUESTER: J10Actor = "Ben"
/** Runs one dependent step; its failure is reported and the journey goes on. */
const soft = async (name: string, step: () => Promise<void>): Promise<void> => {
  try { await step() } catch (error) { expect.soft(String(error), name).toBe("") }
}
const append = async (f: J10Install, actor: J10Actor, title: string, prompt: string, acceptance: string[]): Promise<number> => {
  const filed = await f.api(actor, "POST", "/api/todos", { title, prompt, acceptance, place: { mode: "append" } }, `c-j10-01-${title}`)
  expect(filed.status, JSON.stringify(filed.body)).toBe(202)
  expect(filed.body.state).toBe("accepted")
  return filed.body.n
}

const journey = scenario("journey-github-pr-shape", {
  capabilities: [],
  coverage: ["host:local", "host:production", "action:todo", "path:success", "door:button", "surface:todo", "dimension:github", "evidence:github-write-log"],
  description: "C-J10-01: TODO PRs on smithers/<slug> from main with prompt, evidence, included items and requester; drafts; item-only diff; amend and rebase keep one PR."
})

test("C-J10-01 PR shape on smithers/<slug>", journey, async ({ browser }, info) => {
  test.setTimeout(2_400_000)
  await withJ10Install(browser, info, async f => {
    const ben = f.members.Ben, requester = f.members[REQUESTER]
    // Steps 1-2: Ben appends T1, then T2 after it; each reaches In review.
    const t1 = await append(f, REQUESTER, T1.title, f.prompt(T1.file, T1.text), [])
    const first = await until(f, t1, "in_review")
    const t2 = await append(f, REQUESTER, T2.title, f.prompt(T2.file, T2.text), [T2.acceptance])
    const second = await until(f, t2, "in_review")
    const pull1 = await f.github.pull(first.pr.number)
    const main = await f.github.main()

    // Step 3: T2's PR and its head commit, as GitHub holds them. The review
    // of the open PR adds its summary to the body after In review.
    let pull2 = await f.github.pull(second.pr.number)
    for (const deadline = Date.now() + 180_000; !/^Review: \S/m.test(pull2.body) && Date.now() < deadline;) {
      await new Promise(resolve => setTimeout(resolve, 1_000))
      pull2 = await f.github.pull(second.pr.number)
    }
    const head2 = await f.github.commit(pull2.head.sha)
    await attachJson(info, "pr-2.json", pull2)
    await attachJson(info, "commit.json", { step: 2, sha: pull2.head.sha, ...head2 })
    await info.attach("body-1.md", { body: pull2.body, contentType: "text/markdown" })
    expect.soft(pull2.title).toBe(T2.title)
    expect.soft(pull2.head.ref).toBe(T2.branch)
    expect.soft(pull2.base.ref).toBe("main")
    expect.soft(pull2.head.sha).toBe(second.pr.head)
    expect.soft(await f.github.appOpened(pull2)).toBe(true)
    expect.soft(await f.github.pulls(T2.branch)).toEqual([pull2.number])
    // One parent, main's tip; T1's and T2's changes both in its tree.
    expect.soft(head2.parents).toEqual([main])
    const t1Paths = await f.github.changed(main, pull1.head.sha)
    const t2Paths = await f.github.changed(main, pull2.head.sha)
    expect.soft(t1Paths.length).toBeGreaterThan(0)
    for (const path of t1Paths) expect.soft(t2Paths).toContain(path)
    expect.soft(t2Paths.length).toBeGreaterThan(t1Paths.length)
    if (f.kind === "composed") {
      expect.soft(t1Paths).toEqual([T1.file])
      expect.soft(head2.paths).toEqual(expect.arrayContaining([T1.file, T2.file]))
    }
    // The body: revision 1, acceptance, checks, diff stat, review, T1 linked, the TODO, the requester.
    const body = pull2.body
    expect.soft(body).toContain(T2.text)
    expect.soft(body).toContain(T2.acceptance)
    expect.soft(body).toMatch(/^Checks:?\n(?:[-|] .+\n?)+/m)
    expect.soft(body).toMatch(/\d+ files? changed/)
    expect.soft(body).toMatch(/^Review: \S/m)
    expect.soft(body).toContain(`[T${t1}](${pull1.html_url})`)
    expect.soft(body).toContain(f.origin)
    expect.soft(body).toContain(`Requested by @${requester.login}`)
    expect.soft(body).not.toMatch(CLOSING)
    expect.soft(body).not.toMatch(BARE)
    // Drafts: the first TODO's PR is ready, every later one a draft.
    expect.soft(pull1.head.ref).toBe(T1.branch)
    expect.soft(pull1.draft).toBe(false)
    expect.soft(pull2.draft).toBe(true)

    // Step 4: T2's TODO card and its item-only diff in Ben's browser.
    await runSlash(ben.page, `/todo T${t2}`)
    const todo = ben.page.getByRole("article", { name: `TODO T${t2}`, exact: true }).last()
    await expect.soft(todo).toContainText(T2.title)
    await expect.soft(todo).toContainText(`Includes T${t1}`)
    await expect.soft(todo.locator(`a[href="${pull2.html_url}"]`).first()).toBeVisible()
    await info.attach("todo-card.png", { body: await ben.page.screenshot(), contentType: "image/png" })
    await runSlash(ben.page, `/diff ${T2.branch}`)
    for (const path of t2Paths.filter(path => !t1Paths.includes(path))) await expect.soft(ben.page.getByText(path, { exact: true }).last()).toBeVisible()
    for (const path of t1Paths) await expect.soft(ben.page.getByText(path, { exact: true })).toHaveCount(0)
    await info.attach("diff.png", { body: await ben.page.screenshot(), contentType: "image/png" })

    // The served item-only diff: one model per T2 file, against T1's accepted candidate.
    const served = await f.read("Ben", `/api/branches/${encodeURIComponent(T2.branch)}/diff`)
    await attachJson(info, "branch-diff.json", served)
    const paths = (served.files as { path: string }[]).map(file => file.path).sort()
    expect.soft(paths).toEqual(t2Paths.filter(path => !t1Paths.includes(path)).sort())
    const [accepted] = f.sql(`SELECT candidate_head FROM mythical_items WHERE number = ${t1}`) as { candidate_head: string }[]
    for (const file of served.files as { against: { kind: string; rev: string }; hunks: { lines: { op: string }[] }[] }[]) {
      expect.soft(file.against).toEqual({ kind: "item_base", rev: accepted!.candidate_head })
      expect.soft(file.hunks.length).toBeGreaterThan(0)
      for (const hunk of file.hunks) for (const line of hunk.lines) expect.soft(["+", "-", " "]).toContain(line.op)
    }

    // Step 5: Ben amends T2 (+1); the same PR shows revision 2, not revision 1.
    // A failed step is reported and the journey continues to step 6.
    let revised = pull2
    await soft("step 5: the amend reaches the same PR", async () => {
      const amended = await f.api(REQUESTER, "PATCH", `/api/todos/${t2}`, { prompt: f.prompt(T2.file, AMEND), acceptance: [T2.acceptance] }, "c-j10-01-amend")
      expect(amended.status, JSON.stringify(amended.body)).toBe(202)
      await until(f, t2, "in_review", async now => {
        revised = await f.github.pull(pull2.number)
        return now.pr.number === pull2.number && now.pr.head !== pull2.head.sha && revised.head.sha === now.pr.head && revised.body.includes(AMEND)
      }, 300_000)
      await attachJson(info, "pr-2.json", revised)
      await attachJson(info, "commit.json", { step: 5, sha: revised.head.sha, ...await f.github.commit(revised.head.sha) })
      await info.attach("body-5.md", { body: revised.body, contentType: "text/markdown" })
      expect.soft(revised.body).not.toContain(T2.text)
    })
    expect.soft(await f.github.pulls(T2.branch)).toEqual([pull2.number])

    // Step 6: the owner merges T1 in Smithers; T2 follows the new main.
    const t1Now = await until(f, t1, "in_review", now => now.merge.state === "ready")
    const merged = await f.api("Owner", "POST", `/api/todos/${t1}/merge`, { reviewed_head_sha: t1Now.pr.head }, "c-j10-01-merge-t1")
    expect(merged.status, JSON.stringify(merged.body)).toBe(202)
    await until(f, t1, "merged")
    await soft("step 6: T2 follows the new main under the same PR", async () => {
      let rebased = revised
      let newMain = ""
      await until(f, t2, "in_review", async now => {
        rebased = await f.github.pull(pull2.number)
        newMain = await f.github.main()
        const parents = (await f.github.commit(rebased.head.sha)).parents
        return newMain !== main && now.pr.head === rebased.head.sha && parents.length === 1 && parents[0] === newMain && !rebased.draft
      }, 480_000)
      const rebasedCommit = await f.github.commit(rebased.head.sha)
      await attachJson(info, "pr-2.json", rebased)
      await attachJson(info, "commit.json", { step: 6, sha: rebased.head.sha, ...rebasedCommit })
      await info.attach("body-6.md", { body: rebased.body, contentType: "text/markdown" })
      expect.soft(rebased.head.sha).not.toBe(revised.head.sha)
      expect.soft(rebasedCommit.parents).toEqual([newMain])
      expect.soft(rebased.body).not.toContain(`[T${t1}]`)
      expect.soft(rebased.body).not.toContain(pull1.html_url)
      expect.soft(rebased.body).not.toMatch(CLOSING)
      expect.soft(rebased.body).not.toMatch(BARE)
    })
    // An amend or a rebase never opens a second PR.
    expect.soft(await f.github.pulls(T2.branch)).toEqual([pull2.number])
    expect.soft(await f.github.pulls(T1.branch)).toEqual([pull1.number])
  })
})
