import { test } from "./support"
import { withReference, createTodo, todoCard, home, openTodo, expect, attachJson, JourneyUnavailable, runSlash } from "./todo/reference"

test.use({ realScenario: { id: "journey-todo-needs-you", capabilities: [], coverage: ["host:production", "surface:todo", "path:first-answer", "door:button"] } })
test("C-J2-03 implement ask opens Needs you; first answer wins @production", async ({ browser }, info) => {
  // 15 minutes is the oracle's inconclusive bound, not a timeout workaround.
  test.setTimeout(960_000)
  await withReference(browser, info, async f => {
    const stage = Number(process.env.SMITHERS_JOURNEY_STAGE ?? "1")
    expect([1, 2, 3]).toContain(stage)
    const actors = ["Will", "Ben", "Alice"] as const
    const observed: Record<string, Array<{ at: number; needs: boolean; toast: boolean }>> = {}
    for (const actor of actors) {
      observed[actor] = []
      await f.members[actor].page.evaluate(() => {
        const samples: any[] = []
        ;(window as any).__j2Samples = samples
        const record = () => samples.push({ at: Date.now(),
          needs: !!document.querySelector('.smithers-card.mvp-home')?.textContent?.includes("Needs you 1"),
          toast: [...document.querySelectorAll('[role="status"]')].some(node => !!node.textContent?.includes("Answer")) })
        new MutationObserver(record).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true })
        record()
      })
    }
    await createTodo(f.members.Will.page, "Add a retry policy to webhook delivery. Before editing, ask me whether to use backoff or a fixed delay.")
    if (stage >= 2) await runSlash(f.members.Ben.page, "/branch T1")
    let todo: any
    try {
      await expect.poll(async () => { todo = await f.read("Will", "/api/todos/1"); return todo.state }, { timeout: 900_000, intervals: [250, 500, 1000] }).toBe("needs_you")
    } catch (cause) {
      throw new JourneyUnavailable(`Inconclusive: no question raised within 15 minutes: ${String(cause)}`)
    }
    expect(todo.needs_you.kind).toBe("question")
    const wait = todo.needs_you.wait_id
    expect(wait).toEqual(expect.any(String))
    const events = f.sql("SELECT * FROM product_job_events WHERE todo_id = 1 ORDER BY id")
    const opened = events.find(e => e.kind === "wait_opened")
    expect(opened).toMatchObject({ from_state: "working", to_state: "needs_you", kind: "wait_opened" })
    const openedAt = Date.parse(opened.created_at)
    expect(opened.run_id).toBe(todo.run_id)
    const transcript = await f.read("Will", `/api/runs/${todo.run_id}`)
    expect(transcript.events.filter((e: any) => e.tool === "ask" && e.step === "implement")).toHaveLength(1)
    for (const actor of actors) {
      const page = f.members[actor].page
      await expect(home(page)).toContainText("Needs you 1")
      await expect(home(page)).toContainText(todo.needs_you.question)
      observed[actor] = await page.evaluate(() => (window as any).__j2Samples)
      expect(observed[actor].filter(s => s.needs || s.toast).every(s => s.at >= openedAt)).toBe(true)
      if (actor === "Will" || (stage >= 2 && actor === "Ben")) {
        await expect(page.getByRole("status").filter({ has: page.getByRole("button", { name: "Answer", exact: true }) })).toBeVisible()
        const toast = observed[actor].find(s => s.toast)
        expect(toast).toBeTruthy()
        expect(toast!.at - openedAt).toBeLessThanOrEqual(1000)
      } else expect(observed[actor].some(s => s.toast)).toBe(false)
      await info.attach(`needs-you-${actor}`, { body: await page.screenshot(), contentType: "image/png" })
      await openTodo(page, 1)
      // Chat remains available while the wait is open.
      await expect(page.getByRole("button", { name: "Chat", exact: true })).toBeEnabled()
    }
    const texts = { Ben: "Use backoff", Alice: "Use fixed delay" }
    for (const actor of ["Ben", "Alice"] as const) await todoCard(f.members[actor].page, 1).getByRole("textbox").fill(texts[actor])
    const results = await Promise.all((["Ben", "Alice"] as const).map(async actor => {
      const page = f.members[actor].page
      const pending = page.waitForResponse(r => r.request().method() === "POST" && r.request().postDataJSON()?.wait_id === wait)
      await todoCard(page, 1).getByRole("button", { name: "Answer", exact: true }).click()
      const response = await pending
      return { actor, status: response.status(), body: await response.json() }
    }))
    await attachJson(info, "answer-responses", results)
    const success = results.filter(r => r.status >= 200 && r.status < 300), conflict = results.filter(r => r.status === 409)
    expect(success).toHaveLength(1); expect(conflict).toHaveLength(1)
    const winner = success[0].actor, loser = conflict[0].actor
    expect(conflict[0].body).toMatchObject({ answered_by: winner })
    const losingCard = todoCard(f.members[loser].page, 1)
    await expect(losingCard).toContainText(`${winner} answered`)
    await expect(losingCard.getByRole("textbox")).toHaveValue(texts[loser])
    await expect(losingCard.getByRole("button", { name: "Send as steer", exact: true })).toBeVisible()
    await expect.poll(async () => (await f.read("Will", "/api/todos/1")).state).toBe("working")
    for (const actor of actors) await expect(todoCard(f.members[actor].page, 1)).toContainText(texts[winner])
    const closed = f.sql("SELECT * FROM product_job_events WHERE todo_id = 1 AND from_state = 'needs_you' AND to_state = 'working' ORDER BY id")[0]
    expect(closed).toBeTruthy()
    const ownerSamples = await f.members.Will.page.evaluate(() => (window as any).__j2Samples) as Array<{ at: number; needs: boolean; toast: boolean }>
    const firstToast = ownerSamples.find(s => s.toast)!
    expect(ownerSamples.filter(s => s.at >= firstToast.at && s.at < Date.parse(closed.created_at)).every(s => s.toast)).toBe(true)
    const answered = f.sql("SELECT * FROM product_job_events WHERE todo_id = 1 AND kind = 'answer'")
    expect(answered).toHaveLength(1); expect(answered[0].actor).toBe(winner)
    const activity = f.sql("SELECT * FROM branch_activity WHERE kind = 'answer'")
    expect(activity).toHaveLength(1); expect(activity[0].actor).toBe(winner); expect(activity[0].avatar).toBeTruthy()
    const run = await f.read("Will", `/api/runs/${todo.run_id}`)
    expect(run.events.filter((e: any) => e.kind === "answer").map((e: any) => e.text)).toEqual([texts[winner]])
    await losingCard.getByRole("button", { name: "Send as steer", exact: true }).click()
    await expect.poll(async () => (await f.read("Will", `/api/runs/${todo.run_id}`)).events.filter((e: any) => e.kind === "steer" && e.author === loser).map((e: any) => e.text)).toEqual([texts[loser]])
    await attachJson(info, "wait-timing", { opened, observed, answered, activity })
  })
})
