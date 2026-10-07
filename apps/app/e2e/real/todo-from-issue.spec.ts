import { journeyActivate, journeyEnter, journeySelect, journeyChecked, journeyReach } from "./support/keyboard-journey-input"
import { test } from "./support"
import { scenario } from "./coverage/types"
import { withReference, seedIssueSeven, createTodo, home, todoCard, openTodo, expect, runSlash, attachJson } from "./todo/reference"

const journey = scenario("journey-todo-from-issue", { capabilities: [], coverage: ["host:local", "host:production", "path:success", "surface:todo", "door:button", "dimension:idempotent", "dimension:private-draft"] })
test("C-J2-01 Make TODO freezes the private draft and commits once", journey, async ({ browser }, info) => {
  // The oracle requires a complete 120 s issues interval plus 30 s.
  test.setTimeout(360_000)
  await withReference(browser, info, async f => {
    const ben = f.members.Ben.page, will = f.members.Will.page
    await seedIssueSeven(f)
    await createTodo(will, "T1 fixture; remain queued")
    await createTodo(will, "T2 fixture; remain queued")
    const before = await f.read("Ben", "/api/todos")
    expect(before.map((t: any) => [t.n, t.state])).toEqual([[1, "queued"], [2, "queued"]])
    const labelsBefore = await f.github("Ben", "GET", "/issues/7/labels")
    const commentsBefore = await f.github("Ben", "GET", "/issues/7/comments")
    await runSlash(ben, "/issue 7")
    await journeyActivate(ben.getByRole("button", { name: "Make TODO", exact: true }))
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
    await journeyEnter(draft.getByLabel("Prompt", { exact: true }), `${prompt}\nLog each retry.`)
    await journeySelect(draft.getByLabel("Place", { exact: true }), "Before T2")
    await journeyChecked(draft.getByLabel("Fixes", { exact: true }), true)
    // Remote changes after drafting must not refresh revision 1 or context.
    await f.github("Ben", "PATCH", "/issues/7", { body: "Remote changed body" })
    const activations: string[] = []
    ben.on("request", request => {
      if (request.method() === "POST" && new URL(request.url()).pathname === "/api/todos") activations.push(request.headers()["idempotency-key"] ?? "")
    })
    const submitted = ben.waitForRequest(r => r.method() === "POST" && new URL(r.url()).pathname === "/api/todos")
    const committed = ben.waitForResponse(r => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/todos")
    await journeyReach(draft.getByRole("button", { name: "Commit", exact: true }))
    await ben.keyboard.press("Enter")
    await ben.keyboard.press("Enter")
    const request = await submitted, response = await committed
    expect(response.status()).toBe(202)
    const originalResult = await response.json()
    const data = request.postDataJSON(), headers = await request.allHeaders()
    expect(headers["idempotency-key"]).toEqual(expect.any(String))
    expect(data.issue_digest).toEqual(expect.any(String))
    const todo = await f.read("Ben", "/api/todos/3")
    expect(todo.issue.fixes).toBe(true)
    expect(todo.prompt_revisions).toHaveLength(1)
    const member = await f.read("Ben", "/api/user")
    expect(todo.prompt_revisions[0]).toMatchObject({ reason: "from-issue", text: `${prompt}\nLog each retry.`, issue_digest: data.issue_digest, by: { kind: "person", login: member.username } })
    // The served card intentionally omits the private issue snapshot. Observe
    // retained context read-only rather than assuming a second public contract.
    const frozen = f.sql("SELECT issue_body, checks->'issue_context' AS context FROM mythical_items WHERE number = 3 AND repository_id = (SELECT repository_id FROM mythical_stacks WHERE state = 'active')")
    expect(frozen).toHaveLength(1)
    expect(frozen[0].issue_body).toBe("Webhooks fail on 502")
    expect(JSON.stringify(frozen[0].context)).toContain("retry at most 5 times with jittered backoff")
    expect(JSON.stringify(frozen[0].context)).not.toContain("Remote changed body")
    const assertOne = async () => {
      expect((await f.read("Ben", "/api/todos")).map((t: any) => t.n)).toEqual([1, 3, 2])
      expect((await f.read("Ben", "/api/todos/3")).prompt_revisions).toEqual(todo.prompt_revisions)
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
    expect(duplicate.status()).toBe(response.status())
    expect(await duplicate.json()).toEqual(originalResult)
    expect(activations).toEqual([headers["idempotency-key"]])
    await attachJson(info, "duplicate-activation", { key: headers["idempotency-key"], result: originalResult, buttonRequests: activations.length })
    await assertOne()
    // Both digests are invalid for this actor. The second is a real snapshot
    // drafted by Will, not a random string masquerading as another member's.
    await runSlash(will, "/issue 7")
    const otherDraft = will.waitForResponse(r => r.request().method() === "POST" && r.url().includes("from-issue"))
    await journeyActivate(will.getByRole("button", { name: "Make TODO", exact: true }).last())
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
