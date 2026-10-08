import { expect, type Locator, type Page } from "@playwright/test"
import { marker, seedStack } from "../support/seed-stack"

/**
 * C-J4-02's stack, actions and observations, shared by the reference journey
 * (e2e/real/todo-stack-actions.spec.ts) and the composed install's move proof
 * (e2e/real/todo-stack-actions.browser.ts). Every observation reads the real
 * page, its /api/live socket or PostgreSQL; nothing is intercepted.
 */

export const QUESTION = "where do we retry webhooks?"
export const ANSWER = "Use the existing helper"
export const STEER = "FIXED: fix the real bug, keep the test"
export const TITLES = ["J4 ready", "J4 asks", "J4 fails", "J4 ready next"] as const
export const quote = (n: number) => String(Math.trunc(n))

/** C-J4-02 setup, in stack order: T1 in review, T2 asking, T3 failed, T4 in review. */
export const seedJ4 = (page: Page) => seedStack(page, `j4-${Date.now().toString(36)}`, [
  { title: TITLES[0], prompt: `${marker.pr} ${marker.file("t1.md")} Add a greeting to t1.md`, state: "in_review" },
  { title: TITLES[1], prompt: `${marker.ask} ${marker.file("t2.md")} Add a greeting to t2.md`, state: "needs_you" },
  { title: TITLES[2], prompt: `${marker.fail} ${marker.file("t3.md")} Add a greeting to t3.md`, state: "failed" },
  { title: TITLES[3], prompt: `${marker.pr} ${marker.file("t4.md")} Add a greeting to t4.md`, state: "in_review" }
])

export type LiveFrame = { at: number; topic: string; type: string; n?: number }
export type Sample = { at: number; notices: Array<{ tone: string; text: string }>; composerDisabled: boolean; answering: boolean }

/**
 * Observes the page's real /api/live socket (no interception): each delta's
 * topic and fact type with its arrival time. Attach before the socket opens.
 */
export const observeLive = (page: Page): LiveFrame[] => {
  const frames: LiveFrame[] = []
  page.on("websocket", socket => {
    if (!new URL(socket.url()).pathname.endsWith("/api/live")) return
    const topics = new Map<number, string>()
    socket.on("framesent", ({ payload }) => {
      const frame = typeof payload === "string" ? JSON.parse(payload) : undefined
      if (frame?.t === "sub") topics.set(frame.id, frame.topic)
    })
    socket.on("framereceived", ({ payload }) => {
      const frame = typeof payload === "string" ? JSON.parse(payload) : undefined
      if (frame?.t !== "delta") return
      frames.push({ at: Date.now(), topic: topics.get(frame.id) ?? "", type: frame.data?.Type ?? "", n: frame.data?.Data?.n })
    })
  })
  return frames
}

/** Samples live notices, the composer and the transcript's busy state on every DOM change. */
export const sampleScreen = (page: Page) => page.evaluate(() => {
  const samples: Sample[] = []
  ;(window as any).__j4Samples = samples
  const record = () => samples.push({
    at: Date.now(),
    notices: [...document.querySelectorAll<HTMLElement>(".notice")].map(node => ({ tone: node.dataset.tone ?? "", text: node.textContent ?? "" })),
    composerDisabled: !!document.querySelector('[data-testid="composer-input"]:disabled'),
    answering: !!document.querySelector('[data-testid="transcript"][aria-busy="true"]')
  })
  new MutationObserver(record).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true })
  record()
})
export const samples = (page: Page): Promise<Sample[]> => page.evaluate(() => (window as any).__j4Samples)

export const home = (page: Page): Locator => page.locator(".home.smithers-card").last()
export const homeOrder = async (page: Page, numbers: readonly number[]): Promise<string[]> =>
  (await home(page).locator(".stack-row .ref").allTextContents()).filter(ref => numbers.some(n => ref === `T${n}`))
/** The engine's order of `numbers`: stack positions in PostgreSQL. */
export const engineOrder = (sql: (query: string) => any[], numbers: readonly number[]): number[] =>
  sql(`SELECT number FROM mythical_items WHERE checks->>'todo' = 'true' AND number IN (${numbers.map(quote).join(",")}) ORDER BY stack_position`)
    .map(row => Number(row.number))
export const homeRow = (page: Page, n: number): Locator =>
  home(page).locator(".stack-row").filter({ has: page.locator(".ref", { hasText: new RegExp(`^T${n}$`) }) })

export type Timing = { action: string; n: number; ackMs: number; status: number; ack: unknown; body: unknown; answering: boolean }

/**
 * Step 4: Move T4 up once from its Home row's Order menu, pressed twice.
 * Answers the acknowledgement timing; one move is applied.
 */
export const moveUp = async (page: Page, t4: number): Promise<Timing> => {
  await home(page).getByRole("button", { name: `Order ${TITLES[3]}`, exact: true }).click()
  const item = home(page).getByRole("menu", { name: `Order ${TITLES[3]}` }).getByRole("menuitem", { name: "Move up", exact: true })
  const acknowledged = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === `/api/todos/${t4}`)
  const clickedAt = Date.now()
  await item.dblclick()
  const response = await acknowledged
  const ackMs = Date.now() - clickedAt
  const answering = await page.locator('[data-testid="transcript"][aria-busy="true"]').count() > 0
  return { action: "move", n: t4, ackMs, status: response.status(), ack: await response.json(), body: response.request().postDataJSON(), answering }
}

/**
 * The action's notice settles from its terminal fact, never from the
 * acknowledgement: it is live (or not yet shown, under the shared 300 ms
 * debounce) until the fact for `n` reaches the page, then done or failed.
 * Other notices for the same TODO (its quiet state notices) are not the action's.
 */
export const expectSettledOnFact = (screen: Sample[], frames: LiveFrame[], title: string, type: string, n: number, pressedAt: number) => {
  const terminal = frames.find(frame => frame.type === type && frame.n === n && frame.at >= pressedAt)
  expect(terminal, `the ${type} fact for T${n} reached the page`).toBeTruthy()
  const settled = screen.find(sample => sample.at >= pressedAt && sample.notices.some(notice => notice.text.includes(title) && (notice.tone === "done" || notice.tone === "failed")))
  expect(settled, `the ${title} notice settles`).toBeTruthy()
  expect(settled!.at, `the ${title} notice settles only after ${type}`).toBeGreaterThanOrEqual(terminal!.at)
}
