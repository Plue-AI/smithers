/**
 * C-J4-02 step 4 (T-STK-02) on the composed install: the lead moves a ready
 * TODO above a stuck one while the app agent answers. Driven by packages/backend
 * TestTodoStackMoveJourneyComposedInstall; no browser route or live frame is
 * mocked. Answer, Merge and Retry run on the reference install
 * (todo-stack-actions.spec.ts).
 */
import { expect } from "@playwright/test"
import { closeComposer, command, reloadApp } from "./support"
import { readStack, readTodo } from "./support/seed-stack"
import { runSlash } from "./todo/reference"
import { withComposedInstall } from "./todo/composed-install"
import { QUESTION, TITLES, engineOrder, expectSettledOnFact, homeOrder, homeRow, moveUp, observeLive, quote, sampleScreen, samples, seedJ4 } from "./todo/stack-journey"

await withComposedInstall(async f => {
  const page = f.pages.Will
  const [t1, t2, t3, t4] = (await seedJ4(page)) as [number, number, number, number]
  const frames = observeLive(page)
  await reloadApp(page)
  await runSlash(page, "/stack")
  const ours = [t1, t2, t3, t4]
  await expect.poll(() => homeOrder(page, ours), { timeout: 30_000 }).toEqual(ours.map(n => `T${n}`))
  await f.snapshot("home-before", page)
  await sampleScreen(page)
  // Step 1: ask the app agent; step 4 runs while it answers.
  await command(page, QUESTION)
  await expect(page.getByTestId("transcript")).toContainText(QUESTION)
  await f.snapshot("asked", page)
  // Chat keeps answering behind the closed composer while the person acts.
  await closeComposer(page)
  const pressedAt = Date.now()
  const timing = await moveUp(page, t4)
  f.keep("action-timing", [timing])
  expect(timing.status, JSON.stringify(timing.ack)).toBe(202)
  expect(timing.ack).toEqual({ state: "accepted", place: 3 })
  expect(timing.body).toEqual({ op: "move", direction: "up" })
  expect(timing.ackMs).toBeLessThan(1000)
  expect(timing.answering, "the move is acknowledged while the agent is still answering").toBe(true)
  const moved = [t1, t2, t4, t3]
  await expect.poll(() => homeOrder(page, ours), { timeout: 30_000 }).toEqual(moved.map(n => `T${n}`))
  // The answer streams to completion beside the move; Chat is never disabled.
  await expect(page.getByTestId("transcript")).toContainText("the delivery worker's backoff loop.", { timeout: 60_000 })
  await expect(page.locator('[data-testid="transcript"][aria-busy="false"]')).toBeAttached({ timeout: 60_000 })
  await expect(page.getByTestId("composer-input")).toBeEnabled()
  await expect(page.locator('.notice[data-tone="live"]').filter({ hasText: TITLES[3] })).toHaveCount(0, { timeout: 60_000 })
  try {
    await expect.poll(async () => (await samples(page)).some(sample => sample.notices.some(notice => notice.tone === "done" && notice.id === timing.toastId)), { timeout: 60_000 }).toBe(true)
  } finally {
    f.keep("screen-samples", await samples(page))
    f.keep("live-frames", frames)
    await f.snapshot("notices", page)
  }
  const screen = await samples(page)
  expect(screen.filter(sample => sample.composerDisabled)).toEqual([])
  expectSettledOnFact(screen, frames, TITLES[3], "todo.moved", t4, pressedAt, timing.toastId)
  // The engine moved, not only the cards: the API, the stack positions and one fact.
  expect((await readStack(page)).map(card => Number(card.n)).filter(n => ours.includes(n))).toEqual(moved)
  expect(engineOrder(f.sql, ours)).toEqual(moved)
  const facts = f.sql(`SELECT data FROM product_job_events WHERE event_type = 'todo.moved' AND (data->>'n')::bigint = ${quote(t4)}`)
  f.keep("move-events", facts)
  expect(facts).toHaveLength(1)
  expect(facts[0].data).toMatchObject({ n: t4, direction: "up", past: t3, to: 3 })
  // T4 now merges after the first unmerged TODO, T1; no later TODO offers Merge.
  expect((await readTodo(page, t4)).merge).toMatchObject({ reason: "order", detail: `T${t1}` })
  await runSlash(page, `/todo T${t4}`)
  await expect(page.getByRole("article", { name: `TODO T${t4}` }).last()).toContainText(`Merges after T${t1}`)
  for (const n of [t2, t4, t3]) await expect(homeRow(page, n).getByRole("button", { name: "Merge", exact: true })).toHaveCount(0)
  await f.snapshot("home-after", page)
  f.keep("product-job-events", f.sql(`SELECT event_type, data FROM product_job_events WHERE (data->>'n')::bigint IN (${ours.map(quote).join(",")}) ORDER BY sequence`))
})
console.log("STACK_MOVE_BROWSER_PASS move acknowledged in under 1 s while the agent answered; Home, API and engine order T1, T2, T4, T3; one todo.moved; notice settled on the fact")
