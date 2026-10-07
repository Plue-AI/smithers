import { journeyActivate } from "./support/keyboard-journey-input"
import { readFileSync } from "node:fs"
import type { Locator } from "@playwright/test"
import { test } from "./support"
import { scenario } from "./coverage/types"
import { withReference, createTodo, openTodo, todoCard, home, runSlash, expect, attachJson, required, JourneyUnavailable, type Actor } from "./todo/reference"

// C-J4-03 steps 9-10 on the reference host: only the first unmerged item
// offers Merge; later items say "Merges after Tn", and the API refuses them
// too. The reference host's outbound HTTP recorder supplies append-only JSONL
// {method,path,body,at} of the App's GitHub transport; without it zero merge
// calls cannot be proved, so the journey refuses to run rather than skip.
test("C-J4-03 only the next item merges; later items say Merges after Tn", scenario("journey-todo-merge-order", { capabilities: [],
  coverage: ["action:todo.new", "host:local", "host:production", "path:success", "path:permission", "surface:todo", "surface:home", "door:button", "dimension:merge", "dimension:order", "evidence:github-merge-and-main-readback"] }), async ({ browser }, info) => {
  test.setTimeout(1_800_000)
  const auditPath = required("SMITHERS_JOURNEY_GITHUB_AUDIT_LOG")
  const audit = () => readFileSync(auditPath, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line))
  audit()
  await withReference(browser, info, async f => {
    const ben = f.members.Ben.page
    const merges = () => audit().filter(r => r.method === "PUT" && r.path.startsWith(`/repos/${f.repo}/pulls/`) && r.path.endsWith("/merge"))
    const land = (id: string) => f.sql(`SELECT checks->'land' AS land FROM mythical_items WHERE id = '${id.replace(/'/g, "''")}'`)[0].land
    const status = (sha: string) => f.github("Will", "POST", `/statuses/${sha}`, { context: "canary/required", state: "success", description: "Required passed" })
    const protect = (reviews: number) => f.github("Will", "PUT", "/branches/main/protection", {
      required_status_checks: { strict: false, contexts: ["canary/required"] }, enforce_admins: true,
      required_pull_request_reviews: reviews ? { required_approving_review_count: reviews } : null, restrictions: null
    })
    // A press through the numbered door exactly as the card sends it: the
    // person's session, its CSRF pair and an Idempotency-Key.
    const press = async (actor: Actor, n: number, sha: string, key: string) => {
      const page = f.members[actor].page
      const target = new URL(`/api/todos/${n}/merge`, page.url())
      const csrf = (await page.context().cookies(target.origin)).find(cookie => cookie.name === "__csrf")?.value
      if (!csrf) throw new JourneyUnavailable(`${actor}'s session has no CSRF cookie`)
      return page.context().request.post(target.toString(), { headers: { Origin: target.origin, "X-CSRF-Token": csrf, "Idempotency-Key": key }, data: { reviewed_head_sha: sha } })
    }
    const homeRow = (n: number) => home(ben).locator(".stack-row").filter({ has: ben.locator(".ref", { hasText: new RegExp(`^T${n}$`) }) })
    const mergeButton = (scope: Locator) => scope.getByRole("button", { name: "Merge", exact: true })

    await f.github("Will", "PATCH", "", { allow_squash_merge: true })
    await protect(0)
    for (const prompt of ["Add an ORDER-ONE line to README.md.", "Add an ORDER-TWO line to README.md.", "Add an ORDER-THREE line to README.md."])
      await createTodo(f.members.Will.page, prompt)
    let todos: any[] = []
    await expect.poll(async () => {
      todos = await f.read("Will", "/api/todos")
      return todos.map((t: any) => [t.number, t.state, Boolean(t.pr?.head)])
    }, { timeout: 1_200_000, intervals: [1000, 2000, 5000] }).toEqual([[1, "in_review", true], [2, "in_review", true], [3, "in_review", true]])
    for (const todo of todos) await status(todo.pr.head)
    const heads = Object.fromEntries(todos.map((t: any) => [t.number, t.pr.head])) as Record<number, string>
    expect((await f.github("Will", "GET", `/pulls/${todos[0].pr.number}`) as any).draft).toBe(false)
    for (const later of todos.slice(1)) expect((await f.github("Will", "GET", `/pulls/${later.pr.number}`) as any).draft).toBe(true)
    await expect.poll(async () => (await f.read("Ben", "/api/todos/1")).merge?.state, { timeout: 120_000 }).toBe("ready")

    // Step 9, before the merge: only T1 offers Merge, on Home and on its card.
    await runSlash(ben, "/home")
    await expect(mergeButton(homeRow(1))).toBeEnabled()
    for (const n of [2, 3]) {
      await expect(homeRow(n)).toContainText("Merges after T1")
      await expect(mergeButton(homeRow(n))).toHaveCount(0)
    }
    await info.attach("home-before", { body: await ben.screenshot(), contentType: "image/png" })
    for (const n of [1, 2, 3]) {
      await openTodo(ben, n)
      if (n === 1) await expect(mergeButton(todoCard(ben, n))).toBeEnabled()
      else {
        await expect(todoCard(ben, n)).toContainText("Merges after T1")
        await expect(mergeButton(todoCard(ben, n))).toHaveCount(0)
      }
    }
    // Hidden is not enough: the API refuses the out-of-order press as well.
    const before = merges().length
    const outOfOrder = await press("Ben", 2, heads[2], "c-j4-03-out-of-order")
    expect(outOfOrder.status()).toBe(409)
    expect(await outOfOrder.json()).toMatchObject({ code: "order", class: "conflict", message: "Merges after T1" })
    expect(merges().slice(before)).toEqual([])

    // Ben presses Merge on T1's card; the press binds the head it displays.
    await openTodo(ben, 1)
    const sent = ben.waitForRequest(r => r.method() === "POST" && new URL(r.url()).pathname === "/api/todos/1/merge")
    await journeyActivate(mergeButton(todoCard(ben, 1)))
    expect((await sent).postDataJSON().reviewed_head_sha).toBe(heads[1])
    let first: any
    await expect.poll(async () => {
      first = await f.read("Ben", "/api/todos/1")
      const pull = await f.github("Ben", "GET", `/pulls/${first.pr.number}`) as any
      const main = await f.github("Ben", "GET", "/commits?sha=main&per_page=3") as any[]
      return first.state === "merged" && pull.merged && main.some(c => c.sha === pull.merge_commit_sha)
    }, { timeout: 300_000, intervals: [1000, 2000] }).toBe(true)
    const calls = merges().slice(before)
    expect(calls).toHaveLength(1)
    expect(calls[0].body).toMatchObject({ sha: heads[1], merge_method: "squash" })
    expect(land(first.id)).toMatchObject({ by: expect.any(String), head: heads[1] })

    // T2 rebases onto the new main and its PR is force-updated (§10.6.3).
    let second: any
    await expect.poll(async () => {
      second = await f.read("Ben", "/api/todos/2")
      return second.state === "in_review" && second.pr?.head !== heads[2]
    }, { timeout: 1_200_000, intervals: [1000, 2000, 5000] }).toBe(true)
    await status(second.pr.head)
    await expect.poll(async () => (await f.read("Ben", "/api/todos/2")).merge?.state, { timeout: 300_000 }).toBe("ready")
    expect((await f.github("Ben", "GET", `/pulls/${second.pr.number}`) as any).draft).toBe(false)

    // Step 9, after the merge: T2 offers Merge and T3 merges after T2.
    await runSlash(ben, "/home")
    await expect(mergeButton(homeRow(2))).toBeEnabled()
    await expect(homeRow(3)).toContainText("Merges after T2")
    await expect(mergeButton(homeRow(3))).toHaveCount(0)
    await info.attach("home-after", { body: await ben.screenshot(), contentType: "image/png" })
    await openTodo(ben, 2)
    await expect(mergeButton(todoCard(ben, 2))).toBeEnabled()
    await openTodo(ben, 3)
    await expect(todoCard(ben, 3)).toContainText("Merges after T2")
    await expect(mergeButton(todoCard(ben, 3))).toHaveCount(0)

    // Step 10: GitHub's required review refuses the merge; the card shows
    // GitHub's sentence word for word (T-GH-03 supplies protection text).
    const sentence = "At least 1 approving review is required by reviewers with write access."
    await protect(1)
    try {
      await openTodo(ben, 2)
      await journeyActivate(mergeButton(todoCard(ben, 2)))
      await expect(todoCard(ben, 2)).toContainText(sentence, { timeout: 300_000 })
      await info.attach("step-10-refusal", { body: await ben.screenshot(), contentType: "image/png" })
      expect((await f.read("Ben", "/api/todos/2")).state).toBe("in_review")
      expect((await f.github("Ben", "GET", `/pulls/${second.pr.number}`) as any).merged).toBe(false)
    } finally {
      await protect(0)
    }
    await attachJson(info, "merge-order", { todos: await f.read("Ben", "/api/todos"), calls: merges(), land: { T1: land(first.id), T2: land(second.id) } })
  })
})

