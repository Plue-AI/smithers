import { journeyActivate, journeyDoubleActivate } from "../support/keyboard-journey-input"
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
export type Sample = { at: number; notices: Array<{ id: string; tone: string; text: string }>; composerDisabled: boolean; answering: boolean }

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
export const sampleScreen = async (page: Page) => {
  // Expand the existing notification stack so the action receipt remains
  // observable when setup and TODO state notices occupy its first three slots.
  const more = page.locator(".notify .notice-more")
  if (await more.isVisible()) await journeyActivate(more)
  return page.evaluate(() => {
    const samples: Sample[] = []
    ;(window as any).__j4Samples = samples
    const record = () => samples.push({
      at: Date.now(),
      notices: [...document.querySelectorAll<HTMLElement>(".notice")].map(node => ({ id: node.dataset.notice ?? "", tone: node.dataset.tone ?? "", text: node.textContent ?? "" })),
      composerDisabled: !!document.querySelector('[data-testid="composer-input"]:disabled'),
      answering: !!document.querySelector('[data-testid="transcript"][aria-busy="true"]')
    })
    new MutationObserver(record).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true })
    record()
  })
}
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

export type Timing = { action: string; n: number; ackMs: number; dispatchMs?: number; transportMs?: number; network?: { requestStart: number; responseStart: number; responseEnd: number }; browserTiming?: { dispatchMs: number; queueMs: number; transportMs: number; observerMs: number }; status: number; ack: unknown; body: unknown; answering: boolean; toastId?: string; pressedAt?: number }

/**
 * Step 4: Move T4 up once from its Home row's Order menu, pressed twice.
 * Answers the acknowledgement timing; one move is applied.
 */
export const moveUp = async (page: Page, t4: number): Promise<Timing> => {
  await journeyActivate(home(page).getByRole("button", { name: `Order ${TITLES[3]}`, exact: true }))
  const item = home(page).getByRole("menu", { name: `Order ${TITLES[3]}` }).getByRole("menuitem", { name: "Move up", exact: true })
  // Playwright actionability waits happen before the person's click. Measure
  // the DOM gesture to the response, excluding that test-driver preparation.
  await item.evaluate(node => node.addEventListener("click", () => {
    ;(window as any).__j4MovePressedAt = Date.now()
  }, { once: true }))
  const sent = page.waitForRequest(request => request.method() === "POST" && new URL(request.url()).pathname === `/api/todos/${t4}`)
    .then(() => Date.now())
  const acknowledged = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === `/api/todos/${t4}`)
    .then(response => ({ response, at: Date.now() }))
  await journeyDoubleActivate(item)
  const { response, at } = await acknowledged
  const clickedAt = await page.evaluate(() => (window as any).__j4MovePressedAt as number)
  const sentAt = await sent
  const ackMs = at - clickedAt
  const network = response.request().timing()
  // Request/response events are delivered to the Playwright process. On a
  // loaded recording host, its scheduling delay must not be blamed on the app.
  // Native browser resource timestamps separate that delay from client work
  // and transport; unavailable timing stays absent, never an invented zero.
  const browserTiming = network.startTime >= 0 && network.requestStart >= 0 && network.responseStart >= 0 ? {
    dispatchMs: network.startTime - clickedAt,
    queueMs: network.requestStart,
    transportMs: network.responseStart - network.requestStart,
    observerMs: at - (network.startTime + network.responseStart)
  } : undefined
  const answering = await page.locator('[data-testid="transcript"][aria-busy="true"]').count() > 0
  return { action: "move", n: t4, ackMs, dispatchMs: sentAt - clickedAt, transportMs: at - sentAt, network, browserTiming, pressedAt: clickedAt, status: response.status(), ack: await response.json(), body: response.request().postDataJSON(), answering,
    toastId: `toast-todo.request.${await response.request().headerValue("idempotency-key")}` }
}

/**
 * The action's notice settles from its terminal fact, never from the
 * acknowledgement: it is live (or not yet shown, under the shared 300 ms
 * debounce) until the fact for `n` reaches the page, then done or failed.
 * Other notices for the same TODO (its quiet state notices) are not the action's.
 */
export const expectSettledOnFact = (screen: Sample[], frames: LiveFrame[], title: string, type: string, n: number, pressedAt: number, toastId?: string) => {
  const terminal = frames.find(frame => frame.type === type && frame.n === n && frame.at >= pressedAt)
  expect(terminal, `the ${type} fact for T${n} reached the page`).toBeTruthy()
  const settled = screen.find(sample => sample.at >= pressedAt && sample.notices.some(notice => (toastId ? notice.id === toastId : notice.text.includes(title)) && (notice.tone === "done" || notice.tone === "failed")))
  expect(settled, `the ${title} notice settles`).toBeTruthy()
  expect(settled!.at, `the ${title} notice settles only after ${type}`).toBeGreaterThanOrEqual(terminal!.at)
}
