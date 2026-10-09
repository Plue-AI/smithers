import { expect, test, type Page } from "./browserTest"
import { installCloudFixture } from "./cloudFixture"
import { identityRoute } from "./identity"
import recorded from "../../src/mainview/state/testdata/external-recorded-conversation.json"

/*
 * #3728 and #3732 on a long conversation: the branch history an install serves for imported Codex work (M-38),
 * 60 turns of an agent at work, 540 entries. Intercepted: identity, the live channel, the conversation and its
 * view and, where titles are asked, the model. The entry shape is C-AGT-01's recorded import
 * (external-recorded-conversation.json).
 */
const [prompt, answer] = recorded.entries
const START = 1_791_225_945_426
const entries = Array.from({ length: 60 }, (_, turn) => [
  { ...prompt, id: `long-${turn}-prompt`, source_id: `long:${turn}:0`, ordinal: turn * 9, sequence: turn * 9 + 1, createdAt: START + turn * 60_000,
    text: turn === 0 ? "Step 1: harden webhook retries" : `Turn ${turn}: keep the retries going` },
  ...Array.from({ length: 8 }, (_, step) => ({ ...answer, id: `long-${turn}-${step}`, source_id: `long:${turn}:${step + 1}`, ordinal: turn * 9 + step + 1,
    sequence: turn * 9 + step + 2, createdAt: START + turn * 60_000 + (step + 1) * 1_000,
    text: step === 7 ? `Turn ${turn} done: retries now cover store.ts.` : `Turn ${turn}, step ${step + 1}: reading store.ts.` }))
]).flat()

/** Opens the conversation; with `titles`, the host can ask the model and every ask is recorded there. */
async function openLongConversation(page: Page, width: number, titles?: string[]) {
  await installCloudFixture(page, { capabilities: titles === undefined ? ["install", "identity", "agent"] : ["install", "identity", "agent", "model.turn"] })
  if (titles !== undefined) await modelTitles(page, titles)
  await page.route("**/api/auth/session", identityRoute())
  // A connected live channel: the conversation topic answers once, so the history is read on invalidation, as on
  // an install, instead of on every reconnect of a refused socket. Other topics stay quiet.
  await page.routeWebSocket("**/api/live", socket => socket.onMessage(raw => {
    if (typeof raw !== "string") return
    const frame = JSON.parse(raw)
    if (frame.t === "sub" && frame.topic === "conversation:main") socket.send(JSON.stringify({ t: "snap", id: frame.id, cursor: 1, data: {} }))
  }))
  await page.route("**/api/conversations/main", route => route.fulfill({ json: { id: "main", entries } }))
  // The member's view is theirs to save, as on an install: a jump's scroll anchor reads back.
  let view: object = { queue: [] }
  await page.route("**/api/conversations/main/view-state", route => {
    if (route.request().method() === "PUT") view = { ...route.request().postDataJSON(), queue: [] }
    return route.fulfill({ json: view })
  })
  await page.setViewportSize({ width, height: 1000 })
  await page.goto("/")
  await expect(page.getByTestId("transcript").getByText("Turn 59 done: retries now cover store.ts.", { exact: true })).toBeVisible({ timeout: 30_000 })
}

/** The stub model answers "Fast title for <N> entries." for a run of N; every folded line takes its own. */
async function modelTitles(page: Page, asked: string[]): Promise<void> {
  await page.route("**/api/model/stream", route => {
    asked.push(route.request().url())
    const { runId, messages } = route.request().postDataJSON()
    const count = /This stretch holds (\d+) entries/.exec(messages[0].content)?.[1]
    return route.fulfill({ contentType: "application/x-ndjson", body: [JSON.stringify({ runId, type: "delta", kind: "text", text: `Fast title for ${count} entries.` }), JSON.stringify({ runId, type: "done", reason: "stop" })].join("\n") })
  })
}

test("a long conversation's timeline zooms out with distance from the band, and a far line jumps there and opens", async ({ page }) => {
  await openLongConversation(page, 1280)
  const transcript = page.getByTestId("transcript")
  const rail = page.locator(".timeline > ol > li")
  const levels = async () => (await rail.evaluateAll(items => items.map(item => Number((item as HTMLElement).dataset.zoom ?? 0))))
  // Hundreds of entries, a few dozen lines: fine at the band (the end), coarser toward the start.
  await expect.poll(async () => (await levels()).length).toBeLessThan(80)
  const atEnd = await levels()
  expect(atEnd.at(-1)).toBe(0)
  expect(atEnd[0]).toBeGreaterThanOrEqual(3)
  expect(Math.max(...atEnd)).toBeGreaterThanOrEqual(3)
  await expect(page.locator(".timeline li[data-in-view]").last()).not.toHaveAttribute("data-zoom", /.*/)

  // The member has read to the end: no line is fresh, and the view stops saving read progress.
  await expect(page.locator(".timeline li[data-fresh]")).toHaveCount(0)
  // The first line stands for the opening of the conversation; a click jumps there and the zoom turns around.
  const first = rail.first()
  await expect(first).toHaveAttribute("data-zoom", /^[3-9]$/)
  await first.locator("button").first().click()
  await expect(transcript.getByText("Step 1: harden webhook retries", { exact: true })).toBeInViewport()
  await expect.poll(async () => (await levels())[0]).toBe(0)
  const atStart = await levels()
  expect(atStart.at(-1)).toBeGreaterThanOrEqual(3)
  const opening = rail.filter({ hasText: "Step 1: harden webhook retries" }).first()
  await expect(opening).not.toHaveAttribute("data-zoom", /.*/)
  const openingAt = await rail.evaluateAll(items => items.findIndex(item => item.textContent?.includes("Step 1: harden webhook retries")))
  expect(openingAt).toBeGreaterThanOrEqual(0)
  expect(openingAt).toBeLessThan(3)
})

test("the fast model titles a long conversation's folded lines, marked as written, and short lines keep their own (#3732)", async ({ page }) => {
  await openLongConversation(page, 1280, [])
  const folded = page.locator(".timeline > ol > li[data-zoom]")
  await expect.poll(async () => folded.count()).toBeGreaterThan(3)
  await expect.poll(async () => folded.locator(".written").count(), { timeout: 15_000 }).toBe(await folded.count())
  for (const item of await folded.all()) {
    const count = /^(\d+) entries/.exec(await item.locator(".tl-zoom").innerText())![1]
    await expect(item.locator(".tl-text b")).toHaveText(`Fast title for ${count} entries`)
  }
  // Lines near the band are not folded: they keep their own titles and no mark.
  await expect(page.locator(".timeline > ol > li:not([data-zoom]) .written")).toHaveCount(0)
  await expect(page.locator(".timeline > ol > li:not([data-zoom])", { hasText: "Turn 59 done: retries now cover store.ts." })).toBeVisible()
})

test("below 1,180 px, where the timeline is hidden, no title is asked of the model (#3732)", async ({ page }) => {
  const asked: string[] = []
  await openLongConversation(page, 1000, asked)
  // Past the 1.5 s debounce a visible timeline would have asked by now.
  await page.waitForTimeout(3_000)
  expect(asked).toEqual([])
  await page.setViewportSize({ width: 1280, height: 1000 })
  await expect.poll(() => asked.length, { timeout: 15_000 }).toBeGreaterThan(0)
})
