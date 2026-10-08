/**
 * C-J7-01 steps 1-2 (T-STK-02) on the composed install: member Ben's Draft
 * places "Add a jitter helper" Before T3, and the cards, the API and the
 * engine agree on T1, T2, TN, T3. Driven by packages/backend
 * TestTodoPlacementJourneyComposedInstall; no browser route or live frame is
 * mocked. Amend, its steer and TN's ancestry run on the reference install
 * (todo-placement.spec.ts).
 */
import { expect } from "@playwright/test"
import { command, reloadApp } from "./support"
import { marker, memberRequest, readStack, seedStack } from "./support/seed-stack"
import { runSlash } from "./todo/reference"
import { withComposedInstall } from "./todo/composed-install"
import { engineOrder, homeOrder, quote } from "./todo/stack-journey"

const JITTER = "Add a jitter helper"

await withComposedInstall(async f => {
  const ben = f.pages.Ben
  // Setup: T1 in review, T2 working at its implement step, T3 queued behind them.
  const [t1, t2, t3] = (await seedStack(f.pages.Will, `j7-${Date.now().toString(36)}`, [
    { title: "J7 ready", prompt: `${marker.pr} ${marker.file("t1.md")} Add a greeting to t1.md`, state: "in_review" },
    { title: "J7 retries", prompt: `${marker.hold("t2")} ${marker.file("t2.md")} Add a retry helper note to t2.md`, state: "working" },
    { title: "J7 jitter", prompt: `${marker.file("t3.md")} Add a jitter note to t3.md`, state: "queued" }
  ])) as [number, number, number]
  await reloadApp(ben)
  const expected = Math.max(...(await readStack(ben)).map(card => Number(card.n))) + 1
  const benId = (await memberRequest(ben, "GET", "/api/user")).body.id
  // Step 1: Ben's Draft, placed Before T3. It is private until Commit.
  await command(ben, `/todo.new ${JITTER}`)
  const draft = ben.getByRole("region", { name: "Draft", exact: true }).last()
  // A field's accessible name includes its value; find each by its caption.
  const field = (caption: string) => draft.locator("label").filter({ has: ben.locator("span", { hasText: new RegExp(`^${caption}$`) }) })
  const prompt = field("Prompt").locator("textarea")
  await prompt.fill(JITTER)
  await prompt.blur()
  await field("Place").locator("select").selectOption(JSON.stringify({ mode: "before", n: t3 }))
  await expect(field("Place").locator("select")).toHaveValue(JSON.stringify({ mode: "before", n: t3 }))
  expect((await readStack(ben)).map(card => card.n)).not.toContain(expected)
  const filed = ben.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/todos")
  await draft.getByRole("button", { name: "Commit", exact: true }).click()
  const response = await filed
  const receipt = await response.json()
  expect(response.status(), JSON.stringify(receipt)).toBe(202)
  expect(response.request().postDataJSON()).toMatchObject({ prompt: JITTER, place: { mode: "before", n: t3 } })
  expect(receipt).toMatchObject({ state: "accepted", n: expected })
  const tn = Number(receipt.n)
  await expect(draft).toContainText(`Committed as T${tn}`)
  // Step 2: the Home card, the API and the engine agree on T1, T2, TN, T3.
  await runSlash(ben, "/stack")
  const ours = [t1, t2, tn, t3]
  await expect.poll(() => homeOrder(ben, ours), { timeout: 30_000 }).toEqual(ours.map(n => `T${n}`))
  expect((await readStack(ben)).map(card => Number(card.n)).filter(n => ours.includes(n))).toEqual(ours)
  expect(engineOrder(f.sql, ours)).toEqual(ours)
  await f.snapshot("home-after-before", ben)
  // One placement fact, by Ben, naming Before T3.
  const created = f.sql(`SELECT data FROM product_job_events WHERE event_type = 'todo.created' AND (data->>'n')::bigint = ${quote(tn)}`)
  f.keep("placement-events", created)
  expect(created).toHaveLength(1)
  expect(created[0].data).toMatchObject({ n: tn, before: t3, actor: benId })
  // The engine admits TN before T3: T3 never runs while TN still waits.
  const admission: Array<Record<string, unknown>> = []
  await expect.poll(async () => {
    const cards = await readStack(ben)
    const placed = cards.find(card => card.n === tn), third = cards.find(card => card.n === t3)
    admission.push({ at: Date.now(), tn: { state: placed.state, queue: placed.queue }, t3: { state: third.state, queue: third.queue } })
    if (third.state !== "queued" && placed.state === "queued") throw new Error(`T${t3} was admitted before T${tn}`)
    if (placed.state !== "queued") return "admitted"
    return placed.queue?.position !== undefined && third.queue?.position !== undefined && placed.queue.position < third.queue.position ? "queued ahead" : "pending"
  }, { timeout: 60_000, intervals: [250, 500, 1000] }).not.toBe("pending")
  f.keep("admission-order", admission)
})
console.log("PLACEMENT_BROWSER_PASS private Draft placed Before T3 by Ben; Home, API and engine order T1, T2, TN, T3; one todo.created by Ben; TN queued ahead of T3")
