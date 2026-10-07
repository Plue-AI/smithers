import { journeyEnter, journeyActivate } from "./support/keyboard-journey-input"
import { test } from "./support"
import { scenario } from "./coverage/types"
import { withReference, createTodo, todoCard, home, openTodo, expect, attachJson, JourneyUnavailable, runSlash } from "./todo/reference"

const journey = scenario("journey-todo-needs-you", { capabilities: [], coverage: ["host:local", "host:production", "path:success", "surface:todo", "dimension:first-answer", "door:button"] })
test("C-J2-03 implement ask opens Needs you; first answer wins", journey, async ({ browser }, info) => {
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
          needs: document.querySelector('.smithers-card.home [data-filter="needs_you"] b')?.textContent === "1",
          toast: [...document.querySelectorAll('[role="status"]')].some(node => !!node.textContent?.includes("Answer")) })
        new MutationObserver(record).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true })
        record()
      })
    }
    await createTodo(f.members.Will.page, "Add a retry policy to webhook delivery. Before editing, ask me whether to use backoff or a fixed delay.")
    if (stage >= 2) {
      let branch: string | undefined
      await expect.poll(async () => { branch = (await f.read("Ben", "/api/todos/1")).branch?.name; return branch }, { timeout: 120_000, intervals: [100] }).toBeTruthy()
      await runSlash(f.members.Ben.page, `/branch ${branch}`)
    }
    let todo: any
    try {
      await expect.poll(async () => { todo = await f.read("Will", "/api/todos/1"); return todo.state }, { timeout: 900_000, intervals: [250, 500, 1000] }).toBe("needs_you")
    } catch (cause) {
      throw new JourneyUnavailable(`Inconclusive: no question raised within 15 minutes: ${String(cause)}`)
    }
    const question = todo.waits.filter((wait: any) => wait.kind === "question")
    expect(question).toHaveLength(1)
    const wait = question[0].id
    expect(wait).toEqual(expect.any(String))
    expect(todo.run.id).toEqual(expect.any(String))
    const openedAt = Date.parse(question[0].since)
    expect(openedAt).not.toBeNaN()
    const events = () => f.sql("SELECT sequence, event_type, data, recorded_at FROM product_job_events WHERE data->>'n' = '1' AND tenant_id = (SELECT repository_id::text FROM mythical_stacks WHERE state = 'active') ORDER BY sequence")
    const logins = { Ben: (await f.read("Ben", "/api/user")).username, Alice: (await f.read("Alice", "/api/user")).username }
    for (const actor of actors) {
      const page = f.members[actor].page
      await expect(home(page).locator('[data-filter="needs_you"] b')).toHaveText("1")
      await expect(home(page)).toContainText(question[0].prompt)
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
    for (const actor of ["Ben", "Alice"] as const) await journeyEnter(todoCard(f.members[actor].page, 1).getByRole("textbox"), texts[actor])
    const results = await Promise.all((["Ben", "Alice"] as const).map(async actor => {
      const page = f.members[actor].page
      const pending = page.waitForResponse(r => r.request().method() === "POST" && r.request().postDataJSON()?.wait === wait)
      await journeyActivate(todoCard(page, 1).getByRole("button", { name: "Answer", exact: true }))
      const response = await pending
      return { actor, status: response.status(), body: await response.json() }
    }))
    await attachJson(info, "answer-responses", results)
    const success = results.filter(r => r.status >= 200 && r.status < 300), conflict = results.filter(r => r.status === 409)
    expect(success).toHaveLength(1); expect(conflict).toHaveLength(1)
    const winner = success[0].actor, loser = conflict[0].actor
    expect(conflict[0].body).toMatchObject({ code: "answered", class: "conflict", answered_by: logins[winner] })
    const losingCard = todoCard(f.members[loser].page, 1)
    await expect(losingCard).toContainText(`${logins[winner]} answered`)
    await expect(losingCard.getByRole("textbox")).toHaveValue(texts[loser])
    await expect(losingCard.getByRole("button", { name: "Send as steer", exact: true })).toBeVisible()
    await expect.poll(async () => (await f.read("Will", "/api/todos/1")).state).toBe("working")
    for (const actor of actors) await expect(todoCard(f.members[actor].page, 1)).toContainText(texts[winner])
    const resumed = await f.read("Will", "/api/todos/1")
    expect(resumed.run.id).toBe(todo.run.id)
    expect(resumed.first_answer).toMatchObject({ text: texts[winner], by: { kind: "person", login: logins[winner] } })
    const closedAt = Date.parse(resumed.first_answer.at)
    expect(closedAt).toBeGreaterThanOrEqual(openedAt)
    const ownerSamples = await f.members.Will.page.evaluate(() => (window as any).__j2Samples) as Array<{ at: number; needs: boolean; toast: boolean }>
    const firstToast = ownerSamples.find(s => s.toast)!
    expect(ownerSamples.filter(s => s.at >= firstToast.at && s.at < closedAt).every(s => s.toast)).toBe(true)
    const answered = events().filter(event => event.event_type === "todo.answered")
    expect(answered).toHaveLength(1)
    expect(answered[0].data).toMatchObject({ wait, run: todo.run.id, actor: { kind: "person", login: logins[winner] } })
    const replay = await f.read("Will", "/api/todos/1/events")
    expect(replay.Events.filter((event: any) => event.Type === "todo.answered")).toHaveLength(1)
    // Branch activity and the monitor are independent rendered/public readbacks.
    await runSlash(f.members.Will.page, `/branch ${todo.branch.name}`)
    const activity = f.members.Will.page.locator(".branch-activity > li").filter({ hasText: texts[winner] })
    await expect(activity).toHaveCount(1)
    await expect(activity.locator('.avatar[data-kind="person"]')).toBeVisible()
    await openTodo(f.members.Will.page, 1)
    await journeyActivate(todoCard(f.members.Will.page, 1).getByRole("button", { name: "Inspect", exact: true }))
    const trace = () => f.read("Will", `/api/runs/${encodeURIComponent(todo.run.id)}/trace`)
    const cells = (run: any, kind: string) => run.attempts.flatMap((attempt: any) => attempt.phases.flatMap((phase: any) =>
      phase.cells.filter((cell: any) => cell.kind === kind).map((cell: any) => ({ step: phase.step, cell }))))
    await expect.poll(async () => cells(await trace(), "ask").length).toBe(1)
    await expect.poll(async () => cells(await trace(), "answer").length).toBe(1)
    const run = await trace()
    const asks = cells(run, "ask")
    expect(asks).toHaveLength(1)
    expect(asks[0].step).toBe("implement")
    expect(JSON.stringify(asks[0].cell)).toContain(question[0].prompt)
    const answers = cells(run, "answer")
    expect(answers).toHaveLength(1)
    expect(JSON.stringify(answers[0].cell)).toContain(texts[winner])
    await journeyActivate(losingCard.getByRole("button", { name: "Send as steer", exact: true }))
    await expect.poll(async () => (await f.read("Will", "/api/todos/1")).steers.filter((steer: any) => steer.by.login === logins[loser]).map((steer: any) => steer.text)).toEqual([texts[loser]])
    await expect.poll(async () => cells(await trace(), "steer").filter((entry: any) => entry.cell.actor?.login === logins[loser]).map((entry: any) => entry.cell.quote ?? entry.cell.code ?? entry.cell.output)).toEqual([texts[loser]])
    await attachJson(info, "wait-timing", { wait: question[0], run: todo.run.id, observed, answered, closedAt })
  })
})
