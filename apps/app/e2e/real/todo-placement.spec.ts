import { test } from "./support"
import { scenario } from "./coverage/types"
import { withReference, required, runSlash, home, openTodo, todoCard, expect, attachJson } from "./todo/reference"
import { journeyActivate, journeyEnter, journeySelect } from "./support/keyboard-journey-input"

// Prepared through real app work: T1 In review, T2 Working, T3 Queued.
// No fixture flow or held model substitutes for the live implementation.
test("C-J7-01 insert before T3 and amend the existing working T2", scenario("journey-todo-placement", {
  capabilities: [], coverage: ["host:local", "host:production", "door:slash", "door:button", "surface:home", "surface:draft", "surface:todo", "dimension:keyboard", "path:persistence", "evidence:placement-and-amendment"]
}), async ({ browser }, info) => {
  test.setTimeout(1_800_000)
  expect(required("SMITHERS_JOURNEY_KEYBOARD")).toBe("1")
  expect(["light", "dark"]).toContain(required("SMITHERS_JOURNEY_THEME"))
  await withReference(browser, info, async f => {
    const ben = f.members.Ben.page
    const member = await f.read("Ben", "/api/user")
    const login = member.username
    const before = await f.read("Ben", "/api/todos")
    expect(before.map((item: any) => [item.n, item.state])).toEqual([[1, "in_review"], [2, "working"], [3, "queued"]])
    const original = await f.read("Ben", "/api/todos/2")
    expect(original.run.id).toEqual(expect.any(String))
    expect(original.prompt_revisions).toHaveLength(1)
    const identity = { branch: original.branch, run: original.run.id, attempt: original.run.attempt }
    await runSlash(ben, "/todo.new Add a jitter helper")
    const draft = ben.locator('.smithers-card[data-kind="draft"]').last()
    await journeySelect(draft.getByLabel("Place", { exact: true }), "Before T3")
    const accepted = ben.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/todos")
    await journeyActivate(draft.getByRole("button", { name: "Commit", exact: true }))
    const created = await accepted
    expect(created.status()).toBe(202)
    expect(created.request().postDataJSON().place).toEqual({ mode: "before", n: 3 })
    const number = (await created.json()).n
    expect(number).toBe(4)
    const order = async () => (await f.read("Ben", "/api/todos")).map((item: any) => item.n)
    await expect.poll(order).toEqual([1, 2, 4, 3])
    await runSlash(ben, "/home")
    const renderedOrder = () => home(ben).locator(".stack-row .ref").allTextContents()
    await expect.poll(renderedOrder).toEqual(["T1", "T2", "T4", "T3"])
    await runSlash(ben, "/todo.amend T2")
    const amendment = ben.locator('.smithers-card[data-kind="draft"]').last()
    const text = `${original.prompt_revisions[0].text}\nAlso log each retry.`
    await journeyEnter(amendment.getByLabel("Prompt", { exact: true }), text)
    const amended = ben.waitForResponse(response => response.request().method() === "PATCH" && new URL(response.url()).pathname === "/api/todos/2")
    await journeyActivate(amendment.getByRole("button", { name: "Commit", exact: true }))
    expect((await amended).status()).toBe(202)
    const current = await f.read("Ben", "/api/todos/2")
    expect(current.branch.id).toBe(identity.branch.id)
    expect(current.branch.name).toBe(identity.branch.name)
    expect(current.run.id).toBe(identity.run)
    expect(current.run.attempt).toBe(identity.attempt)
    expect(current.state).not.toBe("queued")
    expect(current.prompt_revisions).toHaveLength(2)
    expect(current.prompt_revisions[1]).toMatchObject({ text, by: { kind: "person", login } })
    expect(current.prompt_revisions[1].acceptance).toEqual(original.prompt_revisions[0].acceptance)
    await openTodo(ben, 2)
    await expect(todoCard(ben, 2)).toContainText("+1")
    expect(await order()).toEqual([1, 2, 4, 3])
    const revisions = f.sql("SELECT number,revisions FROM mythical_items WHERE number=2 AND repository_id=(SELECT repository_id FROM mythical_stacks WHERE state='active')")
    expect(revisions).toHaveLength(1)
    expect(revisions[0].revisions).toHaveLength(2)
    expect(revisions[0].revisions[1]).toMatchObject({ reason: "amend", text, by: { kind: "person", login } })
    const criteria = original.prompt_revisions[0].acceptance as string[]
    const feedback = text + (criteria.length ? `\n\nAcceptance:${criteria.map(criterion => `\n- ${criterion}`).join("")}` : "")
    await expect.poll(async () => (await f.read("Ben", "/api/todos/2")).steers.some((steer: any) => steer.text === feedback && steer.by.login === login),
      { timeout: 120_000 }).toBe(true)
    // Allow the genuine model run to finish; no release hook or SQL state write.
    await expect.poll(async () => (await f.read("Ben", "/api/todos/2")).state, { timeout: 900_000 }).toBe("in_review")
    await expect.poll(async () => (await f.read("Ben", "/api/todos/4")).state, { timeout: 900_000 }).toBe("in_review")
    const candidate = f.sql("SELECT number,base_commit,candidate_head FROM mythical_items WHERE number IN (2,4) AND repository_id=(SELECT repository_id FROM mythical_stacks WHERE state='active') ORDER BY number")
    expect(candidate).toHaveLength(2)
    expect(candidate[0].candidate_head).toMatch(/^[0-9a-f]{40}$/)
    expect(candidate[1].base_commit).toBe(candidate[0].candidate_head)
    const inserted = await f.read("Ben", "/api/todos/4")
    const pull = await f.github("Ben", "GET", `/pulls/${inserted.pr.number}`) as any
    expect(pull.draft).toBe(true)
    expect(pull.body).toContain("T2")
    expect(await order()).toEqual([1, 2, 4, 3])
    const events = f.sql("SELECT sequence,event_type,data FROM product_job_events WHERE data->>'n' IN ('2','4') AND tenant_id=(SELECT repository_id::text FROM mythical_stacks WHERE state='active') ORDER BY sequence")
    for (const [kind, n] of [["todo.created", 4], ["todo.amended", 2]] as const) {
      const rows = events.filter(event => event.event_type === kind && Number(event.data.n) === n)
      expect(rows).toHaveLength(1)
      if (kind === "todo.amended") expect(rows[0].data.by).toEqual({ person: login })
      else expect(rows[0].data.actor).toBe(member.id)
    }
    await attachJson(info, "placement-amendment", { identity, revisions, candidate, events, inserted: number, pull })
  })
})
