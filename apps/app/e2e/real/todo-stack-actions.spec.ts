import { closeComposer, command, reloadApp, test } from "./support"
import { scenario } from "./coverage/types"
import { readTodo } from "./support/seed-stack"
import { attachJson, expect, runSlash, withReference } from "./todo/reference"
import { ANSWER, QUESTION, STEER, TITLES, engineOrder, expectSettledOnFact, homeOrder, homeRow, moveUp, observeLive, quote, sampleScreen, samples, seedJ4, type Timing } from "./todo/stack-journey"

// C-J4-02 (T-STK-02, T-STK-05, T-APP-02) on the reference install, whose
// fixture `todo` flow and GitHub settle each action. The composed install
// runs the Move step (T-STK-02) from todo-stack-actions.browser.ts.
test("C-J4-02 answer, merge next, move up and retry with a steer, all while chatting", scenario("journey-todo-stack-actions", { capabilities: [], coverage: ["action:todo", "action:todo.answer", "action:merge", "action:stack.move", "action:todo.retry", "action:chat.send", "host:local", "host:production", "path:success", "surface:todo", "surface:stack", "door:button", "dimension:order", "dimension:instant-chat", "dimension:merge", "dimension:first-answer", "evidence:database-readback"] }), async ({ browser }, info) => {
  test.setTimeout(40 * 60_000)
  await withReference(browser, info, async f => {
    const page = f.members.Will.page
    const [t1, t2, t3, t4] = (await seedJ4(page)) as [number, number, number, number]
    const ours = [t1, t2, t3, t4]
    const frames = observeLive(page)
    await reloadApp(page)
    await runSlash(page, "/stack")
    await expect.poll(() => homeOrder(page, ours), { timeout: 30_000 }).toEqual(ours.map(n => `T${n}`))
    await info.attach("home-before", { body: await page.screenshot(), contentType: "image/png" })
    const previous = await readTodo(page, t3)
    await sampleScreen(page)
    // Step 1: ask the app agent; steps 2-5 run while it answers.
    await command(page, QUESTION)
    // Chat keeps answering behind the closed composer while the person acts.
    await closeComposer(page)
    const card = (n: number) => page.getByRole("article", { name: `TODO T${n}` }).last()
    const timings: Timing[] = []
    const pressed: Record<string, number> = {}
    const timed = async (action: string, n: number, path: string, press: () => Promise<void>) => {
      const acknowledged = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === path)
      pressed[action] = Date.now()
      await press()
      const response = await acknowledged
      const ackMs = Date.now() - pressed[action]!
      const answering = await page.locator('[data-testid="transcript"][aria-busy="true"]').count() > 0
      timings.push({ action, n, ackMs, status: response.status(), ack: await response.json(), body: response.request().postDataJSON(), answering })
    }
    // Step 2: answer T2's question, pressed twice.
    await runSlash(page, `/todo T${t2}`)
    await card(t2).getByLabel("Answer", { exact: true }).fill(ANSWER)
    await timed("answer", t2, `/api/todos/${t2}/answer`, () => card(t2).getByRole("button", { name: "Answer", exact: true }).dblclick())
    // Step 3: open T1's card and its evidence, then merge the reviewed head.
    await runSlash(page, `/todo T${t1}`)
    const head = (await readTodo(page, t1)).pr.head
    await expect(card(t1)).toBeVisible()
    await timed("merge", t1, `/api/todos/${t1}/merge`, () => card(t1).getByRole("button", { name: "Merge", exact: true }).click())
    // Step 4: move T4 above the stuck T3.
    await runSlash(page, "/stack")
    const moved = await moveUp(page, t4)
    timings.push(moved)
    pressed.move = Date.now() - moved.ackMs
    // Step 5: retry T3 with the steer, pressed twice.
    await runSlash(page, `/todo T${t3}`)
    const retry = card(t3).locator("form").filter({ has: page.getByRole("button", { name: "Retry", exact: true }) })
    await retry.getByLabel("Steer", { exact: true }).fill(STEER)
    await timed("retry", t3, `/api/todos/${t3}`, () => retry.getByRole("button", { name: "Retry", exact: true }).dblclick())
    await attachJson(info, "action-timing", timings)
    expect(timings.map(timing => timing.action)).toEqual(["answer", "merge", "move", "retry"])
    for (const timing of timings) {
      expect(timing.status, JSON.stringify(timing)).toBe(202)
      expect((timing.ack as { state: string }).state, timing.action).toMatch(/^(requested|accepted)$/)
      expect(timing.ackMs, timing.action).toBeLessThan(1000)
    }
    expect(timings[0]!.answering, "the first action is acknowledged while the agent is still answering").toBe(true)
    expect(timings.map(timing => timing.body)).toEqual([
      expect.objectContaining({ answer: ANSWER }), { reviewed_head_sha: head }, { op: "move", direction: "up" }, { op: "retry", steer: STEER }
    ])
    // Step 6: every action settles from its projection; Chat stays usable throughout.
    await expect(page.locator('[data-testid="transcript"][aria-busy="false"]')).toBeAttached({ timeout: 300_000 })
    await expect.poll(async () => (await readTodo(page, t1)).state, { timeout: 15 * 60_000, intervals: [1000, 2000] }).toBe("merged")
    await expect.poll(async () => (await readTodo(page, t2)).state, { timeout: 15 * 60_000, intervals: [1000, 2000] }).not.toMatch(/^(needs_you|queued)$/)
    let third: any
    await expect.poll(async () => (third = await readTodo(page, t3)).state, { timeout: 15 * 60_000, intervals: [1000, 2000] }).toMatch(/^(working|needs_you|in_review|merged)$/)
    for (const title of [TITLES[0], TITLES[1], TITLES[2], TITLES[3]]) {
      await expect(page.locator('.notice[data-tone="live"]').filter({ hasText: title })).toHaveCount(0, { timeout: 15 * 60_000 })
    }
    const screen = await samples(page)
    await attachJson(info, "screen-samples", screen)
    await attachJson(info, "live-frames", frames)
    expect(screen.filter(sample => sample.composerDisabled)).toEqual([])
    await expect(page.getByTestId("composer-input")).toBeEnabled()
    expectSettledOnFact(screen, frames, TITLES[1], "todo.answered", t2, pressed.answer!)
    expectSettledOnFact(screen, frames, TITLES[3], "todo.moved", t4, pressed.move!)
    // Final state: order T2, T4, T3 in the cards and the engine.
    const order = [t2, t4, t3]
    await runSlash(page, "/stack")
    await expect.poll(() => homeOrder(page, order), { timeout: 30_000 }).toEqual(order.map(n => `T${n}`))
    expect(engineOrder(f.sql, order)).toEqual(order)
    const event = (type: string, n: number) => f.sql(`SELECT data FROM product_job_events WHERE event_type = '${type}' AND (data->>'n')::bigint = ${quote(n)}`)
    expect(event("todo.answered", t2)).toHaveLength(1)
    expect(event("todo.moved", t4)).toHaveLength(1)
    expect(event("todo.retried", t3)).toHaveLength(1)
    // T3's attempt 2 runs with the steer first and keeps attempt 1's evidence.
    expect(third.run.attempt).toBe((previous.run?.attempt ?? 1) + 1)
    expect(third.steers[0]).toMatchObject({ text: STEER })
    expect(third.evidence.find((attempt: { attempt: number }) => attempt.attempt === previous.run?.attempt)).toBeTruthy()
    const t3Frames = frames.filter(frame => frame.topic === `todo:${t3}`).map(frame => frame.type)
    await attachJson(info, "t3-frames", t3Frames)
    // After the merge T4 waits on T2, and no Merge shows while T2 is not in review.
    await runSlash(page, `/todo T${t4}`)
    await expect(card(t4)).toContainText(`Merges after T${t2}`)
    // Merge is offered only on the first unmerged item, and only once it is in review.
    if ((await readTodo(page, t2)).state !== "in_review") {
      for (const n of order) await expect(homeRow(page, n).getByRole("button", { name: "Merge", exact: true })).toHaveCount(0)
    }
    await info.attach("home-after", { body: await page.screenshot(), contentType: "image/png" })
    await attachJson(info, "product-job-events", f.sql(`SELECT event_type, data FROM product_job_events WHERE (data->>'n')::bigint IN (${ours.map(quote).join(",")}) ORDER BY sequence`))
  })
})
