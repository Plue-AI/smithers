import { test } from "./support"
import { withReference, seedIssueSeven, createTodo, home, todoCard, openTodo, expect, runSlash, attachJson } from "./todo/reference"

test.use({ realScenario: { id: "journey-todo-from-issue", capabilities: [], coverage: ["host:production", "surface:todo", "door:button", "path:idempotent", "path:private-draft"] } })
test("C-J2-01 Make TODO freezes the private draft and commits once @production", async ({ browser }, info) => {
  // The oracle requires a complete 120 s issues interval plus 30 s.
  test.setTimeout(360_000)
  await withReference(browser, info, async f => {
    const ben = f.members.Ben.page, will = f.members.Will.page
    await seedIssueSeven(f)
    await createTodo(will, "T1 fixture; remain queued")
    await createTodo(will, "T2 fixture; remain queued")
    const before = await f.read("Ben", "/api/todos")
    expect(before.map((t: any) => [t.number, t.state])).toEqual([[1, "queued"], [2, "queued"]])
    const labelsBefore = await f.github("Ben", "GET", "/issues/7/labels")
    const commentsBefore = await f.github("Ben", "GET", "/issues/7/comments")
    await runSlash(ben, "/issue 7")
    await ben.getByRole("button", { name: "Make TODO", exact: true }).click()
    // DraftView uses the mounted draft kind (06efaa113d); preserve all field assertions.
    const draft = ben.locator('.smithers-card[data-kind="draft"]').last()
    await expect(draft).toBeVisible()
    for (const label of ["Title", "Prompt", "Acceptance", "Fixes", "Place"]) await expect(draft.getByLabel(label, { exact: true })).toBeVisible()
    await expect(will.locator('.smithers-card[data-kind="draft"]')).toHaveCount(0)
    const prompt = await draft.getByLabel("Prompt", { exact: true }).inputValue()
    const acceptance = await draft.getByLabel("Acceptance", { exact: true }).inputValue()
    expect(prompt + acceptance).toContain("retry at most 5 times with jittered backoff")
    expect(await f.read("Ben", "/api/todos")).toEqual(before)
    expect(await f.github("Ben", "GET", "/issues/7/labels")).toEqual(labelsBefore)
    expect(await f.github("Ben", "GET", "/issues/7/comments")).toEqual(commentsBefore)
    await info.attach("private-draft-Ben", { body: await ben.screenshot(), contentType: "image/png" })
    await info.attach("private-draft-Will", { body: await will.screenshot(), contentType: "image/png" })
    await draft.getByLabel("Prompt", { exact: true }).fill(`${prompt}\nLog each retry.`)
    await draft.getByLabel("Place", { exact: true }).selectOption({ label: "Before T2" })
    await draft.getByLabel("Fixes", { exact: true }).check()
    // Remote changes after drafting must not refresh revision 1 or context.
    await f.github("Ben", "PATCH", "/issues/7", { body: "Remote changed body" })
    const submitted = ben.waitForRequest(r => r.method() === "POST" && new URL(r.url()).pathname === "/api/todos")
    const committed = ben.waitForResponse(r => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/todos")
    await draft.getByRole("button", { name: "Commit", exact: true }).click()
    const request = await submitted, response = await committed
    expect([200, 201]).toContain(response.status())
    const data = request.postDataJSON(), headers = await request.allHeaders()
    expect(headers["idempotency-key"]).toEqual(expect.any(String))
    expect(data.issue_digest).toEqual(expect.any(String))
    const todo = await f.read("Ben", "/api/todos/3")
    expect(todo.fixes_issue).toBe(true)
    expect(todo.revisions).toHaveLength(1)
    expect(todo.revisions[0]).toMatchObject({ revision: 1, reason: "from-issue", prompt: `${prompt}\nLog each retry.`, issue_digest: data.issue_digest, actor: "Ben" })
    expect(JSON.stringify(todo.context)).toContain("Webhooks fail on 502")
    expect(JSON.stringify(todo.context)).toContain("retry at most 5 times with jittered backoff")
    expect(JSON.stringify(todo.context)).not.toContain("Remote changed body")
    const assertOne = async () => {
      expect((await f.read("Ben", "/api/todos")).map((t: any) => t.number)).toEqual([1, 3, 2])
      expect((await f.read("Ben", "/api/todos/3")).revisions).toEqual(todo.revisions)
      const labels = await f.github("Ben", "GET", "/issues/7/labels") as any[]
      expect(labels.filter(l => l.name === "todo")).toHaveLength(1)
      const comments = await f.github("Ben", "GET", "/issues/7/comments") as any[]
      const made = comments.filter(c => c.body.includes("Committed as T3 ↗"))
      expect(made).toHaveLength(1)
      expect(made[0].user.type).toBe("Bot")
      expect(made[0].performed_via_github_app).toBeTruthy()
      expect(made[0].body).toContain(`/todos/3`)
      // Make TODO may label/comment, but must never file another issue.
      expect((await f.github("Ben", "GET", "/issues?state=all") as any[])).toHaveLength(7)
      await attachJson(info, "github-labels-comments", { labels, comments })
    }
    await assertOne()
    for (const page of [ben, will]) {
      await openTodo(page, 3)
      await expect(todoCard(page, 3)).toContainText("Log each retry.")
      await expect(home(page)).toContainText(/T1[\s\S]*T3[\s\S]*T2/)
      await info.attach(`committed-${page === ben ? "Ben" : "Will"}`, { body: await page.screenshot(), contentType: "image/png" })
    }
    await new Promise(resolve => setTimeout(resolve, 150_000))
    await assertOne()
    const duplicate = await ben.context().request.post(request.url(), { headers, data })
    expect([200, 201]).toContain(duplicate.status())
    await assertOne()
    // Both digests are invalid for this actor. The second is a real snapshot
    // drafted by Will, not a random string masquerading as another member's.
    await runSlash(will, "/issue 7")
    const otherDraft = will.waitForResponse(r => r.request().method() === "POST" && r.url().includes("from-issue"))
    await will.getByRole("button", { name: "Make TODO", exact: true }).last().click()
    const other = await (await otherDraft).json()
    for (const digest of ["unknown-digest", other.issue_digest]) {
      expect(digest).toEqual(expect.any(String))
      const invalid = await ben.context().request.post(request.url(), { headers: { ...headers, "idempotency-key": crypto.randomUUID() }, data: { ...data, issue_digest: digest } })
      expect(invalid.ok()).toBe(false)
      await assertOne()
    }
    const writes = f.sql("SELECT method, path FROM github_outbound WHERE state = 'done'")
    expect(writes.filter(w => w.method === "POST" && /issues\/7\/labels$/.test(w.path))).toHaveLength(1)
    expect(writes.filter(w => w.method === "POST" && /issues\/7\/comments$/.test(w.path))).toHaveLength(1)
  })
})
