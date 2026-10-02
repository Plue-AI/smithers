import { readFileSync } from "node:fs"
import { join } from "node:path"
import { controlTabKey, expect, test, type Page } from "./browserTest"
import { installCloudFixture, runningBox } from "./cloudFixture"

/*
 * The issue-sweep burndown (#3336): the repository's `issue-sweep` flow,
 * started through its three doors, and its run card. The journal the card
 * reads is the recorded live run-3 (e2e/fixtures/burndown/run-3.json, from
 * `smthrs runs logs run-3 --format jsonl`) or a journal synthesized from the
 * flow's own schemas for the states run-3 never reached (exhausted, sleeping,
 * cancelled, completed, failed, empty, and overflow: vm children beside cloud
 * ones; each file names what it was made from).
 */

const repo = "smithersai/smithers"
type Fixture = {
  /** What the journal was recorded or made from. */
  readonly capturedFrom: string
  readonly input: Record<string, unknown>
  /** The run's summary row once it settled; absent for a run still going. */
  readonly summary?: { readonly status: string; readonly verdict: string }
  readonly events: ReadonlyArray<{ readonly sequence: number; readonly kind: string; readonly payload: Record<string, any> }>
}
const fixture = (name: string): Fixture => JSON.parse(readFileSync(join(__dirname, `../fixtures/burndown/${name}.json`), "utf8"))
/* Every synthesized journal starts at this instant and ends within two minutes of it; read ten minutes in, a child still running has run for minutes. */
const SYNTHESIZED_EPOCH = 1790900000000
const SYNTHESIZED_NOW = SYNTHESIZED_EPOCH + 10 * 60_000
const factory = readFileSync(join(__dirname, "../../../../.smithers/factory.json"), "utf8")

type Call = { readonly procedure: string; readonly payload: Record<string, any> }

/** What a test holds back or refuses, changed while the page runs. */
interface Workspace {
  /** Resolves when the workspace may answer Run: until then the card is launching. */
  run?: Promise<void>
  /** Resolves when the journal may be read: until then the card is loading. */
  events?: Promise<void>
  /** Resolves when Cancel may be answered. */
  cancel?: Promise<void>
  /** Procedures the workspace refuses. */
  refuse: Set<string>
  /** The journal is served up to this sequence. */
  upTo: number
  /** The summary row's status once `upTo` is lifted past the journal's end. */
  status?: string
}

const refusal = { ok: false, error: { message: "The workspace is not reachable.", detail: { code: "provider_unavailable" } } }

/** The repository's projection, its box, and a workspace that answers the run with `journal`. */
const serve = async (page: Page, journal: Fixture, runId = "burndown-run", workspace: Workspace = { refuse: new Set(), upTo: Infinity }) => {
  const calls: Array<Call> = []
  let cancelled = false
  const settled = (): { readonly status: string; readonly verdict: string } =>
    cancelled ? { status: "cancelled", verdict: "Cancelled" }
      : workspace.status !== undefined ? { status: workspace.status, verdict: journal.summary?.verdict ?? "Running" }
      : journal.summary ?? { status: "running", verdict: "Running" }
  // A synthesized journal is read at a fixed instant after it (timers still run); the recorded run-3 is read at the wall clock.
  if (journal.capturedFrom.startsWith("synthesized")) await page.clock.setFixedTime(SYNTHESIZED_NOW)
  await installCloudFixture(page, { capabilities: ["agent", "identity", "cloud", "cloud.pat"], workspaces: [runningBox(repo)] })
  await page.route("**/api/agent/**", route => route.continue())
  await page.route(url => url.pathname === `/api/repos/${repo}`, route => route.fulfill({ json: { full_name: repo } }))
  await page.route(`**/api/repos/${repo}/contents/.smithers/factory.json*`, route =>
    route.fulfill({ json: { type: "file", path: ".smithers/factory.json", encoding: "utf-8", content: factory } }))
  await page.route("**/api/workflow/provision", route => route.fulfill({ json: { status: "ready" } }))
  await page.route("**/api/workflow/rpc", async route => {
    const call = route.request().postDataJSON() as Call
    calls.push(call)
    const tag = call.procedure === "Projection.Snapshot" ? call.payload.selector?._tag : undefined
    if (workspace.refuse.has(call.procedure) || (tag !== undefined && workspace.refuse.has(tag))) return route.fulfill({ json: refusal })
    let payload: unknown = {}
    if (call.procedure === "Plan") payload = { planId: "plan-burndown", digest: "digest", envelope: { capabilities: [], flows: [], budget: {} } }
    if (call.procedure === "Run") {
      await workspace.run
      payload = { runId }
    }
    if (call.procedure === "Cancel") {
      await workspace.cancel
      // Held, then refused: the answer is the workspace's mind when it answers.
      if (workspace.refuse.has("Cancel")) return route.fulfill({ json: refusal })
      cancelled = true
    }
    if (tag === "run-summary") {
      const { status, verdict } = settled()
      payload = { rows: [{
        runId, flowId: "issue-sweep", status, createdAt: 1, updatedAt: status === "running" ? 2 + Math.min(workspace.upTo, 1) : 4,
        turns: 0, calls: 0, callsFailed: 0, editsAttempted: 0, editsSucceeded: 0, inputTokens: 0, outputTokens: 0,
        verdict, diagnosis: "Recorded status"
      }] }
    } else if (tag === "run-events") {
      await workspace.events
      const after = typeof call.payload.after?.value === "number" ? call.payload.after.value : -1
      payload = { rows: journal.events.filter(event => event.sequence > after && event.sequence <= workspace.upTo).map(event => ({ ...event, runId })) }
    } else if (tag !== undefined) payload = { rows: [] }
    await route.fulfill({ json: { ok: true, payload } }).catch(() => {})
  })
  return { calls, runId, workspace }
}

/** A promise a test settles when it chooses. */
const gate = () => {
  let open = () => {}
  const held = new Promise<void>(resolve => { open = resolve })
  return { held, open }
}

/** The app, once its first-run card stands (the session has booted). */
const open = async (page: Page) => {
  await page.goto("/")
  await expect(page.getByTestId("setup-checklist")).toBeVisible({ timeout: 15_000 })
}

const composer = async (page: Page) => {
  const input = page.getByTestId("composer-input")
  const chat = page.getByRole("button", { name: "Chat", exact: true })
  if (!await input.isVisible()) {
    if (await chat.isVisible()) await chat.click()
    else await page.keyboard.press("Control+k")
  }
  await expect(input).toBeVisible()
  return input
}

const send = async (page: Page, text: string) => {
  const input = await composer(page)
  await input.fill(text)
  await page.getByTestId("composer-send").click()
  await expect(input).toHaveValue("")
  await input.press("Escape").catch(() => {})
}

/* The board on screen: when the shell also opens the run in a frame, the chat's copy is mounted but hidden. */
const board = (page: Page, runId: string) => page.getByTestId(`burndown-${runId}`).filter({ visible: true })
/** The card around the board: its chrome (title, maximize, restore) and the body below the board. */
const shell = (page: Page) => page.locator('section.smithers-card[data-kind="run-trace"]:has(section.burndown)')

/** Whether a focused element's ring (outline width + offset) is drawn whole: no scrolling or clipping ancestor cuts it. */
const ringWhole = (target: ReturnType<Page["locator"]>) => target.evaluate((node) => {
  const style = getComputedStyle(node)
  const ring = Number.parseFloat(style.outlineWidth) + Math.max(Number.parseFloat(style.outlineOffset), 0)
  const box = node.getBoundingClientRect()
  // Up to the card itself: past it is the transcript's own scroll, which focus already scrolled to.
  for (let parent = node.parentElement; parent !== null && parent.parentElement?.closest(".smithers-card") !== null; parent = parent.parentElement) {
    const clip = getComputedStyle(parent)
    if (clip.overflowX === "visible" && clip.overflowY === "visible") continue
    const edge = parent.getBoundingClientRect()
    const inside = box.left - ring >= edge.left + parent.clientLeft - 0.5 && box.right + ring <= edge.left + parent.clientLeft + parent.clientWidth + 0.5 &&
      box.top - ring >= edge.top + parent.clientTop - 0.5 && box.bottom + ring <= edge.top + parent.clientTop + parent.clientHeight + 0.5
    // A scroller clips only what is inside its scrolled view; the row it scrolled into view must fit inside it.
    if (!inside) return `clipped by ${parent.className}`
  }
  // Drawn and whole; its width and offset are the tokens' business, not this spec's.
  return style.outlineStyle === "none" || ring <= 0 ? "none" : "whole"
})

/** Tab until `target` holds focus: the keyboard-only path, no pointer. */
const tabTo = async (page: Page, target: ReturnType<Page["locator"]>) => {
  for (let step = 0; step < 120 && !await target.evaluate(node => node === document.activeElement).catch(() => false); step++) {
    await page.keyboard.press(controlTabKey(page))
  }
  await expect(target).toBeFocused()
}

test.use({ viewport: { width: 1280, height: 900 } })

test("slash without the width runs on the flow's default; the run card shows every state run-3 recorded, with its counts", async ({ page }) => {
  const { calls, runId } = await serve(page, fixture("run-3"))
  await open(page)
  await send(page, "/issue-sweep vm attempt=10")
  await expect.poll(() => calls.filter(call => call.procedure === "Run").length).toBe(1)
  await expect(page.locator('form.flow-form[data-flow-name="issue-sweep"]')).toHaveCount(0)
  const plan = JSON.stringify(calls.find(call => call.procedure === "Plan")?.payload)
  expect(plan).toContain("issue-sweep")
  expect(plan).not.toContain("maxAgents")
  const card = board(page, runId)
  await expect(card).toBeVisible({ timeout: 15_000 })
  const strip = card.getByTestId("burndown-strip")
  const count = (state: string) => strip.locator(`[data-state="${state}"] .burndown-count-n`)
  await expect(count("working")).toHaveText("3")
  await expect(count("landing")).toHaveText("15")
  await expect(count("failed")).toHaveText("24")
  await expect(count("ours")).toHaveText("11")
  await expect(count("landed")).toHaveText("0")
  for (const state of ["ours", "working", "landing", "failed"]) await expect(card.locator(`.burndown-group[data-state="${state}"]`)).toBeVisible()
  await expect(card.getByTestId("burndown-capacity")).toContainText("3/32")
  await expect(card.getByTestId("burndown-machine")).toContainText("VMs")
  await expect(card.getByTestId("burndown-machine").locator(".burndown-meter-value")).toHaveText("3/32")
  // Each meter has a name, a value, a range and the words for them.
  for (const [name, now] of [["Slots", "3"], ["VMs", "3"]] as const) {
    const meter = card.getByRole("progressbar", { name })
    await expect(meter).toHaveAttribute("aria-valuenow", now)
    await expect(meter).toHaveAttribute("aria-valuemax", "32")
    await expect(meter).toHaveAttribute("aria-valuetext", `${now} of 32`)
  }
  await expect(card.getByTestId("burndown-accounts").locator("li")).toHaveCount(6)
  await expect(card.getByTestId("burndown-status")).toHaveText("Running")
  // The card's title names the repository and the board says the status: each once.
  await expect(shell(page).locator(".smithers-card-header")).toContainText(repo)
  await expect(shell(page).locator('.smithers-card-header [data-testid="status-details"]')).toHaveCount(0)
  // The board is the run's summary: no row per child execution under it.
  await expect(shell(page).locator(".run-engine")).toHaveCount(0)
  // The board owns the run's acts: no generic footer Stop, facet tabs or steer row under it.
  await expect(shell(page).locator('[data-testid^="flow-run-stop-"], [data-testid^="flow-run-facet-"], [aria-label="Steer this run"]')).toHaveCount(0)
  // A row's first line is its state's mark, its number and its title; no line holds the mark alone. Only a group whose rows carry meta has the meta line.
  const parts = (row: ReturnType<Page["locator"]>) => row.evaluate(node => [...node.children].map(child => [...child.classList].find(name => name.startsWith("burndown-"))))
  expect(await parts(card.locator('.burndown-group[data-state="landing"] .burndown-row').first())).toEqual(["burndown-mark", "burndown-row-number", "burndown-row-title", "burndown-row-meta"])
  expect(await parts(card.locator('.burndown-group[data-state="ours"] .burndown-row').first())).toEqual(["burndown-mark", "burndown-row-number", "burndown-row-title"])
  // Embedded, a long group shows its first rows and a control for the rest; the keyboard reaches it.
  const failedRows = card.locator('.burndown-group[data-state="failed"] .burndown-row')
  await expect(failedRows).toHaveCount(5)
  const more = card.getByTestId("burndown-more-failed")
  await expect(more).toHaveText("19 more")
  await more.focus()
  await page.keyboard.press("Enter")
  await expect(failedRows).toHaveCount(24)
  await expect(more).toHaveAttribute("aria-expanded", "true")
  await page.keyboard.press("Enter")
  await expect(failedRows).toHaveCount(5)
  // Within a group every row is the same height, meta or not; a group without meta is a line shorter a row.
  const heightsIn = (state: string) => card.locator(`.burndown-group[data-state="${state}"] .burndown-row`)
    .evaluateAll(rows => [...new Set(rows.map(row => Math.round(row.getBoundingClientRect().height)))])
  for (const state of ["ours", "working", "landing", "failed"]) expect(await heightsIn(state), state).toHaveLength(1)
  expect((await heightsIn("ours"))[0]).toBeLessThan((await heightsIn("landing"))[0]!)
})

test("the featured button resolves the typed entry and carries its repository: the run starts, never a form", async ({ page }) => {
  const { calls, runId } = await serve(page, fixture("run-3"))
  await open(page)
  const featured = page.getByRole("button", { name: "Work every open GitHub issue that no other machine holds", exact: true })
  await expect(featured).toBeVisible({ timeout: 15_000 })
  await expect(featured).toHaveAttribute("data-flow", "issue-sweep")
  await expect(featured).toHaveAttribute("data-flow-args", repo)
  await featured.click()
  await expect.poll(() => calls.filter(call => call.procedure === "Run").length).toBe(1)
  await expect(page.locator('form.flow-form[data-flow-name="issue-sweep"]')).toHaveCount(0)
  await expect(board(page, runId)).toBeVisible({ timeout: 15_000 })
})

test("the agent door: the model's call becomes a confirmation, and only the human's press runs it", async ({ page }) => {
  const { calls, runId } = await serve(page, fixture("run-3"))
  await open(page)
  await send(page, `stub-tool issue-sweep {"maxAgents":4,"placement":"local"}`)
  const confirm = page.locator('button.message-cta[data-flow="issue-sweep"]')
  await expect(confirm).toBeVisible({ timeout: 15_000 })
  await expect(confirm).toHaveText(/^Confirm: /)
  expect(calls.filter(call => call.procedure === "Run")).toHaveLength(0)
  await confirm.click()
  await expect.poll(() => calls.filter(call => call.procedure === "Run").length).toBe(1)
  await expect(board(page, runId)).toBeVisible({ timeout: 15_000 })
})

test("keyboard only: start, filter, open an issue, close it, and stop through the confirmation; reload keeps the filter and the issue", async ({ page }) => {
  const { calls, runId } = await serve(page, fixture("run-3"))
  await open(page)
  const input = await composer(page)
  await input.fill("/issue-sweep 32 vm attempt=10")
  await page.keyboard.press("Enter")
  await expect(input).toHaveValue("")
  await page.keyboard.press("Escape")
  const card = board(page, runId)
  await expect(card).toBeVisible({ timeout: 15_000 })
  await expect(card.getByTestId("burndown-strip").locator('[data-state="failed"] .burndown-count-n')).toHaveText("24")

  // The count strip is one tab stop; arrows rove; Enter toggles the filter.
  const first = card.getByTestId("burndown-strip").locator("button").first()
  await tabTo(page, first)
  for (let step = 0; step < 8; step++) await page.keyboard.press("ArrowRight")
  const failed = card.getByTestId("burndown-strip").locator('[data-state="failed"]')
  await expect(failed).toBeFocused()
  await page.keyboard.press("Enter")
  await expect(failed).toHaveAttribute("aria-pressed", "true")
  await expect(card.locator(".burndown-group")).toHaveCount(1)
  await expect(card.locator('.burndown-group[data-state="failed"] .burndown-row')).toHaveCount(24)

  // The board is one tab stop; arrows move; Enter opens the detail; Escape closes it.
  const rows = card.locator(".burndown-row")
  await page.keyboard.press(controlTabKey(page))
  await expect(rows.first()).toBeFocused()
  await page.keyboard.press("ArrowDown")
  await expect(rows.nth(1)).toBeFocused()
  const issue = await rows.nth(1).getAttribute("data-issue")
  await page.keyboard.press("Enter")
  await expect(card.getByTestId("burndown-detail")).toContainText(`#${issue}`)
  await expect(rows.nth(1)).toHaveAttribute("aria-expanded", "true")
  await page.keyboard.press("Escape")
  await expect(card.getByTestId("burndown-detail")).toHaveCount(0)
  await page.keyboard.press("Enter")
  await expect(card.getByTestId("burndown-detail")).toContainText(`#${issue}`)

  // Reload: the filter and the open issue live on the card.
  await page.reload()
  await expect(card.getByTestId("burndown-strip").locator('[data-state="failed"]')).toHaveAttribute("aria-pressed", "true", { timeout: 15_000 })
  await expect(card.getByTestId("burndown-detail")).toContainText(`#${issue}`)

  // Stop: the control asks once more; the safe choice has focus; Escape backs out; the act sends Cancel.
  const stop = card.getByTestId("burndown-stop")
  await tabTo(page, stop)
  await page.keyboard.press("Enter")
  const confirmation = card.getByTestId("burndown-confirm")
  await expect(confirmation.getByRole("button", { name: "Not yet" })).toBeFocused()
  await page.keyboard.press("Escape")
  await expect(confirmation).toHaveCount(0)
  await expect(stop).toBeFocused()
  expect(calls.filter(call => call.procedure === "Cancel")).toHaveLength(0)
  await page.keyboard.press("Enter")
  await page.keyboard.press(controlTabKey(page, true))
  await expect(confirmation.getByRole("button", { name: "Stop for now" })).toBeFocused()
  await page.keyboard.press("Enter")
  await expect.poll(() => calls.filter(call => call.procedure === "Cancel").length).toBe(1)
  expect(calls.find(call => call.procedure === "Cancel")?.payload.runId).toBe(runId)
  await expect(card.getByTestId("burndown-status")).toHaveText("Cancelled", { timeout: 15_000 })
})

test("keyboard only: arrows rove rows, groups and more controls; the detail opens under its row and Escape returns to it; confirmations hand focus back; maximize and restore", async ({ page }) => {
  const cancel = gate()
  const { calls, runId } = await serve(page, fixture("run-3"), "burndown-run", { refuse: new Set(), upTo: Infinity, cancel: cancel.held })
  await open(page)
  await send(page, "/issue-sweep 32 vm attempt=10")
  const card = board(page, runId)
  const strip = card.getByTestId("burndown-strip")
  await expect(strip.locator('[data-state="failed"] .burndown-count-n')).toHaveText("24", { timeout: 15_000 })

  // The strip: one tab stop; Home and End reach its ends; its ring is drawn whole.
  await tabTo(page, strip.locator("button").first())
  await page.keyboard.press("End")
  await expect(strip.locator('[data-state="failed"]')).toBeFocused()
  expect(await ringWhole(strip.locator('[data-state="failed"]'))).toBe("whole")
  await page.keyboard.press("Home")
  await expect(strip.locator("button").first()).toBeFocused()
  await expect(strip.locator('button[tabindex="0"]')).toHaveCount(1)

  // The board: the next tab stop, and only one.
  await page.keyboard.press(controlTabKey(page))
  const group = (state: string) => card.locator(`.burndown-group[data-state="${state}"] .burndown-row`)
  await expect(group("ours").first()).toBeFocused()
  await expect(card.locator('[data-stop][tabindex="0"]')).toHaveCount(1)
  expect(await ringWhole(group("ours").first())).toBe("whole")
  // Left and Right: the neighbouring group's first row.
  await page.keyboard.press("ArrowRight")
  await expect(group("working").first()).toBeFocused()
  await page.keyboard.press("ArrowLeft")
  await expect(group("ours").first()).toBeFocused()
  // Down past a capped group's last row: its "more" control, then the next group.
  for (let step = 0; step < 5; step++) await page.keyboard.press("ArrowDown")
  const more = card.getByTestId("burndown-more-ours")
  await expect(more).toBeFocused()
  await page.keyboard.press("Enter")
  await expect(group("ours")).toHaveCount(11)
  await expect(more).toBeFocused()
  await page.keyboard.press(" ")
  await expect(group("ours")).toHaveCount(5)
  await page.keyboard.press("ArrowDown")
  await expect(group("working").first()).toBeFocused()
  await page.keyboard.press("End")
  await expect(card.getByTestId("burndown-more-failed")).toBeFocused()
  await page.keyboard.press("Home")
  await expect(group("ours").first()).toBeFocused()

  // Space opens a failed issue's detail directly under its row; Tab walks into it; Escape closes it and returns to the row.
  for (let step = 0; step < 3; step++) await page.keyboard.press("ArrowRight")
  await page.keyboard.press("ArrowDown")
  const row = group("failed").nth(1)
  await expect(row).toBeFocused()
  await page.keyboard.press(" ")
  const detail = card.getByTestId("burndown-detail")
  await expect(detail).toBeVisible()
  await expect(row).toHaveAttribute("aria-expanded", "true")
  expect(await row.evaluate(node => node.nextElementSibling?.id)).toBe(await row.getAttribute("aria-controls"))
  await page.keyboard.press(controlTabKey(page))
  // A failed step's words sit behind the notice's Details: its summary is the detail's first stop.
  const failureDetails = detail.getByTestId("burndown-failure").locator("summary")
  await expect(failureDetails).toBeFocused()
  // Arrows inside the detail are the reader's, not the board's.
  await page.keyboard.press("ArrowDown")
  await expect(failureDetails).toBeFocused()
  await page.keyboard.press("Escape")
  await expect(detail).toHaveCount(0)
  await expect(row).toBeFocused()
  // Out of the board in one press.
  await page.keyboard.press(controlTabKey(page))
  expect(await page.evaluate(() => document.activeElement?.closest(".burndown-board") === null)).toBe(true)

  // Stop: focus moves into the confirmation on the safe choice; Escape gives it back; the act gives it back too, to the waiting control.
  const stop = card.getByTestId("burndown-stop")
  await tabTo(page, stop)
  expect(await ringWhole(stop)).toBe("whole")
  await page.keyboard.press("Enter")
  const confirmation = card.getByTestId("burndown-confirm")
  await expect(confirmation.getByRole("button", { name: "Not yet" })).toBeFocused()
  await page.keyboard.press("Escape")
  await expect(confirmation).toHaveCount(0)
  await expect(stop).toBeFocused()
  await page.keyboard.press(" ")
  await page.keyboard.press(controlTabKey(page, true))
  await expect(confirmation.getByRole("button", { name: "Stop for now" })).toBeFocused()
  await page.keyboard.press("Enter")
  await expect(stop).toHaveAttribute("aria-busy", "true")
  await expect(stop).toBeFocused()
  await expect.poll(() => calls.filter(call => call.procedure === "Cancel").length).toBe(1)

  // Maximize from the keyboard; Escape with an issue open closes the issue first, then restores the card, and focus returns to Maximize.
  const maximize = shell(page).locator('[data-testid^="card-maximize-"]')
  await tabTo(page, maximize)
  await page.keyboard.press("Enter")
  const restore = page.locator('[data-testid^="card-minimize-"]')
  await expect(restore).toBeFocused()
  await expect(shell(page)).toHaveAttribute("data-maximized", "true")
  await expect(shell(page).locator('[data-testid^="flow-run-stop-"], [data-testid^="flow-run-facet-"], [aria-label="Steer this run"]')).toHaveCount(0)
  await tabTo(page, card.locator('[data-stop][tabindex="0"]'))
  await page.keyboard.press("Enter")
  await expect(card.getByTestId("burndown-detail")).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(card.getByTestId("burndown-detail")).toHaveCount(0)
  await expect(shell(page)).toHaveAttribute("data-maximized", "true")
  expect(await ringWhole(card.locator('[data-stop][tabindex="0"]'))).toBe("whole")
  await page.keyboard.press("Escape")
  await expect(shell(page)).not.toHaveAttribute("data-maximized", "true")
  await expect(shell(page).locator('[data-testid^="card-maximize-"]')).toBeFocused()
  cancel.open()
})

/** WCAG contrast of two computed colours, read in the page (rgb(), or color(srgb ...) for color-mix results). */
const contrastIn = (target: ReturnType<Page["locator"]>) => target.evaluate((node) => {
  const parse = (value: string): [number, number, number, number] => {
    const srgb = /color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)(?: \/ ([\d.]+))?\)/.exec(value)
    if (srgb !== null) return [Number(srgb[1]) * 255, Number(srgb[2]) * 255, Number(srgb[3]) * 255, srgb[4] === undefined ? 1 : Number(srgb[4])]
    const rgb = /rgba?\(([\d.]+),? ([\d.]+),? ([\d.]+)(?:,? \/? ?([\d.]+))?\)/.exec(value)
    if (rgb !== null) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), rgb[4] === undefined ? 1 : Number(rgb[4])]
    throw new Error(`unreadable colour ${value}`)
  }
  // The painted background: the nearest opaque one, with translucent layers above it composited in.
  const layers: Array<[number, number, number, number]> = []
  for (let at: Element | null = node; at !== null; at = at.parentElement) {
    const layer = parse(getComputedStyle(at).backgroundColor)
    if (layer[3] > 0) layers.push(layer)
    if (layer[3] >= 1) break
  }
  const back = layers.reverse().reduce((under, [r, g, b, a]) => [r * a + under[0] * (1 - a), g * a + under[1] * (1 - a), b * a + under[2] * (1 - a), 1] as [number, number, number, number], [255, 255, 255, 1] as [number, number, number, number])
  const [r, g, b, a] = parse(getComputedStyle(node).color)
  const fore = [r * a + back[0] * (1 - a), g * a + back[1] * (1 - a), b * a + back[2] * (1 - a)]
  const lum = (c: ReadonlyArray<number>) => {
    const ch = c.map(v => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4 })
    return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!
  }
  const [hi, lo] = [Math.max(lum(fore), lum(back)), Math.min(lum(fore), lum(back))]
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100
})

test("accessibility: names and values, targets, painted contrast in both themes, and reflow at 320px and 200% zoom", async ({ page }) => {
  const { runId } = await serve(page, fixture("exhausted"))
  await open(page)
  await send(page, "/issue-sweep 4 local")
  const card = board(page, runId)
  await expect(card.getByTestId("burndown-status")).toHaveText("Parked", { timeout: 15_000 })
  // Structure: a named region, a named toolbar, a named group of state sections with headings.
  await expect(page.getByRole("region", { name: "Issue burndown" })).toBeVisible()
  await expect(card.getByRole("toolbar", { name: "States" })).toBeVisible()
  await expect(card.getByRole("group", { name: "Issues" })).toBeVisible()
  await expect(card.getByRole("heading", { level: 5 }).first()).toBeVisible()
  // A count says its state in words, and an account out of quota says so in text, not only its hollow mark.
  await expect(card.getByTestId("burndown-strip").locator('[data-state="failed"]')).toHaveAccessibleName("1 Failed")
  await expect(card.getByTestId("burndown-accounts").locator('[data-reset="true"]').first()).toContainText("needs a reset")
  // Every control in the board is at least 24px square.
  const small = await card.locator("button").evaluateAll(buttons => buttons
    .map(button => button.getBoundingClientRect())
    .filter(box => box.width > 0 && (box.width < 24 || box.height < 24)).length)
  expect(small).toBe(0)

  for (const name of ["light", "dark"] as const) {
    await send(page, `/appearance.dark-mode ${name}`)
    await expect(page.locator("html")).toHaveAttribute("data-theme", name)
    await card.locator('.burndown-row[data-issue="3350"]').click()
    const open = card.locator('.burndown-row[aria-expanded="true"]')
    // Small text on the tints the board paints: an open row, a live count; 4.5:1.
    for (const [part, target] of [
      ["open row title", open.locator(".burndown-row-title")],
      ["open row number", open.locator(".burndown-row-number")],
      ["open row meta", open.locator(".burndown-row-meta code").first()],
      ["count word", card.getByTestId("burndown-strip").locator('[data-state="landed"] .burndown-count-word')],
      ["zero count word", card.getByTestId("burndown-strip").locator('[data-state="working"] .burndown-count-word')]
    ] as const) {
      expect(await contrastIn(target), `${name} ${part}`).toBeGreaterThanOrEqual(4.5)
    }
    await open.click()
  }
  await send(page, "/appearance.dark-mode light")

  // Reflow: at 320px wide, and at 200% zoom of a 1280px window (640 CSS px), nothing scrolls sideways and nothing is cut.
  for (const width of [320, 640]) {
    await page.setViewportSize({ width, height: 900 })
    await card.scrollIntoViewIfNeeded()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
    expect(await card.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
  }
})

test("parked on exhausted accounts: the reset list, then Resume confirms and signals issue-sweep/accounts-reset", async ({ page }) => {
  const { calls, runId } = await serve(page, fixture("exhausted"))
  await open(page)
  await send(page, "/issue-sweep 4 local")
  const card = board(page, runId)
  await expect(card).toBeVisible({ timeout: 15_000 })
  await expect(card.getByTestId("burndown-status")).toHaveText("Parked")
  const reset = card.getByTestId("burndown-reset")
  await expect(reset).toContainText("codex-1")
  await expect(reset).toContainText("usage limit until 18:00")
  await expect(reset).toContainText("claude-2")
  for (const state of ["skip", "ours", "landed", "held", "failed"]) {
    await expect(card.getByTestId("burndown-strip").locator(`[data-state="${state}"] .burndown-count-n`)).toHaveText("1")
  }
  await expect(card.getByTestId("burndown-accounts").locator('[data-reset="true"]')).toHaveCount(2)
  await card.getByTestId("burndown-resume").click()
  const confirmation = card.getByTestId("burndown-confirm")
  await expect(confirmation.getByRole("button", { name: "Not yet" })).toBeFocused()
  expect(calls.filter(call => call.procedure === "Signal")).toHaveLength(0)
  await confirmation.getByRole("button", { name: "Resume" }).click()
  await expect.poll(() => calls.filter(call => call.procedure === "Signal").length).toBe(1)
  const signal = calls.find(call => call.procedure === "Signal")!
  expect(signal.payload.runId).toBe(runId)
  expect(signal.payload.signal.name).toBe("issue-sweep/accounts-reset")
  // The landed issue's detail: its commit and its whole patch.
  await card.locator('.burndown-row[data-issue="3350"]').click()
  const detail = card.getByTestId("burndown-detail")
  await expect(detail).toContainText("7f3a9c21b0de")
  await expect(detail.locator('[data-slot="diff-hunks"], .sui-diff-hunks').first()).toBeVisible()
})

test("launching, then loading: placeholders hold the layout, and the board arrives under a strip that has not moved", async ({ page }) => {
  const run = gate(), events = gate()
  const { runId } = await serve(page, fixture("run-3"), "burndown-run", { refuse: new Set(), upTo: Infinity, run: run.held, events: events.held })
  await open(page)
  await send(page, "/issue-sweep 32 vm attempt=10")
  // No run yet: the status says so, the layout is placeholders, and there is no control to press.
  const launching = page.locator('section.burndown[data-stage="launching"]')
  await expect(launching).toBeVisible({ timeout: 15_000 })
  await expect(launching).toHaveAttribute("aria-busy", "true")
  await expect(launching.getByTestId("burndown-status")).toHaveText("Starting…")
  await expect(shell(page).locator(".smithers-card-header")).toContainText(repo)
  await expect(launching.getByTestId("burndown-board-skeleton").locator(".burndown-row")).toHaveCount(5)
  await expect(launching.locator("button")).toHaveCount(0)
  const top = async (part: string) => {
    const section = page.locator(`section[aria-label="Issue burndown"]`)
    return section.evaluate((node, selector) => {
      const target = node.querySelector(selector)!.getBoundingClientRect()
      return Math.round(target.top - node.getBoundingClientRect().top)
    }, part)
  }
  // A placeholder row reserves the meta line, as a row in a group that carries meta (here Working) does.
  const rowHeight = async (group = "") => page.locator(`section[aria-label="Issue burndown"] .burndown-group${group} .burndown-row`).first()
    .evaluate(node => Math.round(node.getBoundingClientRect().height))
  const placed = { strip: await top(".burndown-strip"), meters: await top(".burndown-meters"), board: await top(".burndown-board"), row: await rowHeight() }

  // The run exists and its journal is unread: the board is still placeholders, and its controls wait for it.
  run.open()
  const card = board(page, runId)
  await expect(card).toHaveAttribute("data-stage", "loading", { timeout: 15_000 })
  await expect(card.getByTestId("burndown-status")).toHaveText("Running")
  await expect(card.locator("button")).toHaveCount(0)
  await expect(card.getByTestId("burndown-board-skeleton")).toBeVisible()
  expect(await top(".burndown-strip")).toBe(placed.strip)
  expect(await top(".burndown-meters")).toBe(placed.meters)

  // The journal arrives: the strip and the meters stand where their placeholders stood, and a row with meta is the height its placeholder was.
  events.open()
  await expect(card).toHaveAttribute("data-stage", "ready", { timeout: 15_000 })
  await expect(card).toHaveAttribute("aria-busy", "false")
  await expect(card.getByTestId("burndown-strip").locator('[data-state="failed"] .burndown-count-n')).toHaveText("24")
  await expect(card.getByTestId("burndown-stop")).toBeVisible()
  expect(await top(".burndown-strip")).toBe(placed.strip)
  expect(await top(".burndown-meters")).toBe(placed.meters)
  expect(await rowHeight('[data-state="working"]')).toBe(placed.row)
})

test("every row from claimed onward says where it runs, and who worked it once its fix settled", async ({ page }) => {
  const meta = (card: ReturnType<typeof board>, issue: number) => card.locator(`.burndown-row[data-issue="${issue}"] .burndown-row-meta`)
  const { runId } = await serve(page, fixture("overflow"))
  await open(page)
  await send(page, "/issue-sweep 2 vm")
  const card = board(page, runId)
  await expect(card).toHaveAttribute("data-stage", "ready", { timeout: 15_000 })
  // An overflow child whose fix settled: the cloud, and the Claude account that worked it.
  await expect(meta(card, 3356).locator(".burndown-place")).toHaveText("Cloud")
  await expect(meta(card, 3356).locator('.burndown-place[data-placement="cloud"] svg')).toHaveCount(1)
  await expect(meta(card, 3356).locator(".burndown-row-agent")).toHaveText("claude-1")
  await expect(card.locator('.burndown-row[data-issue="3356"]')).toHaveAccessibleName(/, Landing, Cloud, claude-1$/)
  await expect(meta(card, 3357).locator(".burndown-place")).toHaveText("Cloud")
  await expect(meta(card, 3357).locator(".burndown-row-agent")).toHaveText("codex-4")
  // Children still working: where they run (this Mac's VMs, the cloud beyond them) and no agent, which the journal has not named yet.
  for (const [issue, place] of [[3360, "VM"], [3359, "VM"], [3358, "Cloud"]] as const) {
    await expect(meta(card, issue).locator(".burndown-place")).toHaveText(place)
    await expect(meta(card, issue).locator(".burndown-row-agent")).toHaveCount(0)
    // Read after the journal's own time, a running child has run for minutes.
    await expect(meta(card, issue).locator(".burndown-row-elapsed")).toHaveText(/^\d+m\d+s$/)
  }
  // A queued issue runs nowhere yet.
  await expect(card.locator('.burndown-row[data-issue="3355"] .burndown-row-meta')).toHaveCount(0)
  // Every row in a group is one height, and the meta line never wraps or outgrows its row.
  for (const state of ["working", "adopting", "landing"]) {
    const rows = card.locator(`.burndown-group[data-state="${state}"] .burndown-row`)
    expect(await rows.evaluateAll(all => new Set(all.map(row => Math.round(row.getBoundingClientRect().height))).size), state).toBe(1)
  }
  // The detail says the same two things in the same words.
  await card.locator('.burndown-row[data-issue="3356"]').click()
  const detail = card.getByTestId("burndown-detail")
  await expect(detail.locator(".burndown-place")).toHaveText("Cloud")
  await expect(detail.locator("dt", { hasText: "Agent" }).locator("+ dd")).toHaveText("claude-1")
})

test("the recorded run: every child in a VM, a Codex account on each whose fix settled, whole at the narrowest width", async ({ page }) => {
  const { runId } = await serve(page, fixture("run-3"))
  await open(page)
  await send(page, "/issue-sweep 32 vm attempt=10")
  const run3 = board(page, runId)
  await expect(run3).toHaveAttribute("data-stage", "ready", { timeout: 15_000 })
  const landing = run3.locator('.burndown-group[data-state="landing"] .burndown-row').first()
  await expect(landing.locator('.burndown-place[data-placement="vm"]')).toHaveText("VM")
  await expect(landing.locator(".burndown-row-agent")).toHaveText(/^codex-/)
  await expect(landing).toHaveAccessibleName(/, Landing, VM, codex-/)
  const working = run3.locator('.burndown-group[data-state="working"] .burndown-row').first()
  await expect(working.locator(".burndown-place")).toHaveText("VM")
  await expect(working.locator(".burndown-row-agent")).toHaveCount(0)
  // At the narrowest container the place and the agent are still whole inside the row.
  await page.setViewportSize({ width: 320, height: 900 })
  for (const part of [landing.locator(".burndown-place"), landing.locator(".burndown-row-agent")]) {
    const [box, row] = [await part.boundingBox(), await landing.boundingBox()]
    expect(box!.x + box!.width).toBeLessThanOrEqual(row!.x + row!.width)
  }
})

test("each settled state: its status, its counts, and only the controls that apply", async ({ page }) => {
  const expected = [
    { name: "sleeping", line: "/issue-sweep", status: "Parked", controls: ["burndown-stop"] },
    { name: "cancelled", line: "/issue-sweep 2 local", status: "Cancelled", controls: ["burndown-resume"] },
    { name: "completed", line: "/issue-sweep 4 local", status: "Finished", controls: [] },
    { name: "failed", line: "/issue-sweep 4 local", status: "Failed", controls: ["burndown-resume"] },
    { name: "empty", line: "/issue-sweep 4 local", status: "Finished", controls: [] }
  ] as const
  for (const state of expected) {
    const runId = `shot-${state.name}-state`
    await page.unrouteAll({ behavior: "ignoreErrors" })
    await serve(page, fixture(state.name), runId)
    await open(page)
    await send(page, state.line)
    const card = board(page, runId)
    await expect(card).toHaveAttribute("data-stage", "ready", { timeout: 15_000 })
    await expect(card.getByTestId("burndown-status")).toHaveText(state.status, { timeout: 15_000 })
    for (const control of ["burndown-stop", "burndown-resume", "burndown-retry"]) {
      await expect(card.getByTestId(control)).toHaveCount(state.controls.includes(control as never) ? 1 : 0)
    }
    if (state.name === "sleeping") await expect(card.getByTestId("burndown-until").locator("time")).toHaveAttribute("datetime", new Date(SYNTHESIZED_EPOCH + 3_600_000).toISOString())
    if (state.name === "completed") {
      const count = (name: string) => card.getByTestId("burndown-strip").locator(`[data-state="${name}"] .burndown-count-n`)
      await expect(count("landed")).toHaveText("2")
      for (const name of ["ours", "claimed", "working", "adopting", "landing"]) await expect(count(name)).toHaveText("0")
      await expect(card.locator(".burndown-group")).toHaveCount(4)
    }
    if (state.name === "failed") {
      // The run's failure is said once, under the header, above the counts; the issue's own words are whole behind its detail's Details.
      const notice = card.getByTestId(`flow-run-failure-${runId}`)
      await expect(notice).toBeVisible()
      await expect(page.getByTestId(`flow-run-failure-${runId}`)).toHaveCount(1)
      expect((await notice.boundingBox())!.y).toBeLessThan((await card.getByTestId("burndown-strip").boundingBox())!.y)
      await card.locator('.burndown-row[data-issue="3350"]').click()
      const failure = card.getByTestId("burndown-failure")
      await expect(failure.locator("p")).toHaveText("This issue's work failed. Not your fault.")
      await failure.locator("summary").click()
      const reason = failure.getByRole("region", { name: "Failure details" })
      await expect(reason).toContainText("No space left on device (os error 28)")
      expect(await reason.evaluate(node => node.scrollHeight <= node.clientHeight + 1 && node.scrollWidth <= node.clientWidth + 1)).toBe(true)
      // Selectable by the pointer, the way a person copies it: WebKit computes only -webkit-user-select, so ask the selection, not the style.
      await reason.click({ clickCount: 3 })
      const selected = await page.evaluate(() => getSelection()?.toString().trim() ?? "")
      expect(selected).not.toBe("")
      expect(await reason.innerText()).toContain(selected)
      await page.evaluate(() => getSelection()?.removeAllRanges())
    }
    if (state.name === "empty") {
      await expect(card.getByTestId("burndown-empty")).toHaveText("No issues")
      await expect(card.locator(".burndown-group")).toHaveCount(0)
    }
  }
})

test("a row that changes state arrives once, its count ticks, and the change is said once; reduced motion moves nothing", async ({ page }) => {
  const journal = fixture("completed")
  const child = "issue-sweep/3349/attempt-1"
  const fixed = journal.events.find(event => event.payload.executionId === child && event.payload.eventType === "flows.engine.node-settled")!
  const { runId, workspace } = await serve(page, journal, "burndown-run", { refuse: new Set(), upTo: fixed.sequence - 1, status: "running" })
  await open(page)
  await send(page, "/issue-sweep 4 local")
  const card = board(page, runId)
  const row = card.locator('.burndown-row[data-issue="3349"]')
  await expect(row).toHaveAttribute("data-state", "working", { timeout: 15_000 })
  const said = card.getByTestId("burndown-announce")
  // The first reading moved nothing: no row arrives, and nothing is said.
  await expect(card.locator('.burndown-row[data-moved="true"]')).toHaveCount(0)
  await expect(said).toHaveText("")
  const strip = card.getByTestId("burndown-strip")
  const before = await strip.locator(".burndown-count").evaluateAll(chips => chips.map(chip => Math.round(chip.getBoundingClientRect().left)))

  // The fix lands and the sweep drains.
  workspace.upTo = Infinity
  workspace.status = "completed"
  await expect(row).toHaveAttribute("data-state", "landed", { timeout: 15_000 })
  await expect(row).toHaveAttribute("data-moved", "true")
  expect(await row.evaluate(node => getComputedStyle(node).animationName)).toBe("burndown-arrive")
  expect(await row.evaluate(node => getComputedStyle(node).animationIterationCount)).toBe("1")
  await expect(strip.locator('[data-state="landed"] .burndown-count-n')).toHaveText("2")
  await expect(strip.locator('[data-state="landed"] .burndown-count-n')).toHaveAttribute("data-ticked", "true")
  await expect(strip.locator('[data-state="skip"] .burndown-count-n')).not.toHaveAttribute("data-ticked", "true")
  // Counts changed and no chip moved.
  expect(await strip.locator(".burndown-count").evaluateAll(chips => chips.map(chip => Math.round(chip.getBoundingClientRect().left)))).toEqual(before)
  await expect(said).toHaveText("Finished, #3349 landed")
  await expect(card.locator('[role="status"]')).toHaveCount(1)

  // Reduced motion: the state still changed, nothing animates.
  await page.emulateMedia({ reducedMotion: "reduce" })
  expect(await row.evaluate(node => getComputedStyle(node).animationName)).toBe("none")
  await page.emulateMedia({ reducedMotion: "no-preference" })

  // The next reading of the card moved nothing: the row is at rest and the words are gone, so nothing is said twice.
  await strip.locator('[data-state="landed"]').click()
  await expect(strip.locator('[data-state="landed"]')).toHaveAttribute("aria-pressed", "true")
  await expect(card.locator('.burndown-row[data-moved="true"]')).toHaveCount(0)
  await expect(said).toHaveText("")
})

test("a refused resume is shown and can be pressed again; an accepted one waits in place", async ({ page }) => {
  const { calls, runId, workspace } = await serve(page, fixture("exhausted"), "burndown-run", { refuse: new Set(["Signal"]), upTo: Infinity })
  await open(page)
  await send(page, "/issue-sweep 4 local")
  const card = board(page, runId)
  await expect(card.getByTestId("burndown-status")).toHaveText("Parked", { timeout: 15_000 })
  const resume = card.getByTestId("burndown-resume")
  await resume.click()
  await card.getByTestId("burndown-confirm").getByRole("button", { name: "Resume" }).click()
  const refused = card.getByTestId("burndown-refused")
  await expect(refused).toHaveText("The workspace refused the call.", { timeout: 15_000 })
  await expect(resume).toHaveAttribute("aria-busy", "false")
  expect(calls.filter(call => call.procedure === "Signal")).toHaveLength(1)
  // The same control asks again; this time the workspace accepts, and the control waits while the park still stands.
  workspace.refuse.clear()
  await resume.click()
  await card.getByTestId("burndown-confirm").getByRole("button", { name: "Resume" }).click()
  await expect.poll(() => calls.filter(call => call.procedure === "Signal").length).toBe(2)
  await expect(refused).toHaveCount(0)
  await expect(resume).toHaveAttribute("aria-busy", "true")
  // A waiting control does not ask again.
  await resume.click({ force: true })
  await expect(card.getByTestId("burndown-confirm")).toHaveCount(0)
  expect(calls.filter(call => call.procedure === "Signal")).toHaveLength(2)
})

test("a stop waits in place until the run settles; a refused stop says so and Check again brings the run back", async ({ page }) => {
  const cancel = gate()
  const { calls, runId, workspace } = await serve(page, fixture("run-3"), "burndown-run", { refuse: new Set(), upTo: Infinity, cancel: cancel.held })
  await open(page)
  await send(page, "/issue-sweep 32 vm attempt=10")
  const card = board(page, runId)
  await expect(card.getByTestId("burndown-status")).toHaveText("Running", { timeout: 15_000 })
  const stop = card.getByTestId("burndown-stop")
  await stop.click()
  await card.getByTestId("burndown-confirm").getByRole("button", { name: "Stop for now" }).click()
  // Sent and not yet answered: the control stays, busy, and does not ask again.
  await expect(stop).toHaveAttribute("aria-busy", "true")
  await stop.click({ force: true })
  await expect(card.getByTestId("burndown-confirm")).toHaveCount(0)
  // The workspace refuses.
  workspace.refuse.add("Cancel")
  cancel.open()
  await expect.poll(() => calls.filter(call => call.procedure === "Cancel").length).toBe(1)
  // Refused: the run keeps its status, the watch says it stopped, the notice sits under the header, and Stop is gone.
  await expect(card.getByTestId("burndown-observer")).toHaveText("Stopped watching", { timeout: 15_000 })
  await expect(card.getByTestId("burndown-status")).toHaveText("Running")
  await expect(card.getByTestId(`flow-run-observation-failure-${runId}`)).toBeVisible()
  await expect(stop).toHaveCount(0)
  // Check again resumes the watch; Stop is offered again, not busy, and this time the run stops.
  workspace.refuse.clear()
  // The transcript skips rendering what is far off screen; bring the header back before pressing.
  await card.getByTestId("burndown-retry").scrollIntoViewIfNeeded()
  await card.getByTestId("burndown-retry").click()
  await expect(card.getByTestId("burndown-observer")).toHaveCount(0, { timeout: 15_000 })
  await expect(stop).toHaveAttribute("aria-busy", "false")
  await stop.click()
  await card.getByTestId("burndown-confirm").getByRole("button", { name: "Stop for now" }).click()
  await expect(card.getByTestId("burndown-status")).toHaveText("Cancelled", { timeout: 15_000 })
  await expect(card.getByTestId("burndown-announce")).toContainText("Cancelled")
  await expect(card.getByTestId("burndown-resume")).toBeVisible()
  await expect(stop).toHaveCount(0)
})

test("a workspace that stops answering: the watch says reconnecting beside the run's status, and the run keeps its Stop", async ({ page }) => {
  const { runId, workspace } = await serve(page, fixture("run-3"))
  await open(page)
  await send(page, "/issue-sweep 32 vm attempt=10")
  const card = board(page, runId)
  await expect(card).toHaveAttribute("data-stage", "ready", { timeout: 15_000 })
  workspace.refuse.add("run-summary")
  await expect(card.getByTestId("burndown-observer")).toHaveText("Reconnecting…", { timeout: 30_000 })
  await expect(card.getByTestId("burndown-status")).toHaveText("Running")
  await expect(card.getByTestId("burndown-stop")).toBeVisible()
  await expect(card.getByTestId("burndown-strip").locator('[data-state="failed"] .burndown-count-n')).toHaveText("24")
  workspace.refuse.clear()
  await expect(card.getByTestId("burndown-observer")).toHaveCount(0, { timeout: 30_000 })
})

/*
 * BURNDOWN_SCREENSHOTS=<dir>: the card in every state, one test (and so one
 * fresh session) per state, each in light and dark, at conversation width
 * (412px window) and maximized. The maximized picture is the whole card, so
 * its gutters show. run-3 adds a 320px and a 720px window, a non-default
 * palette, and the keyboard's focus on a row and on an open detail.
 */
test.describe("screenshots", () => {
  const dir = process.env.BURNDOWN_SCREENSHOTS
  test.skip(dir === undefined || dir === "", "set BURNDOWN_SCREENSHOTS=<dir> to capture")
  test.setTimeout(300_000)

  const theme = async (page: Page, name: "light" | "dark") => {
    if (await page.locator("html").getAttribute("data-theme") === name) return
    await send(page, `/appearance.dark-mode ${name}`)
    await expect(page.locator("html")).toHaveAttribute("data-theme", name)
  }
  const narrow = async (page: Page, path: string, width = 412) => {
    const section = page.locator(`section[aria-label="Issue burndown"]`)
    await page.setViewportSize({ width, height: 4000 })
    await page.evaluate(() => document.fonts.ready)
    await section.scrollIntoViewIfNeeded()
    await section.screenshot({ path })
  }
  const wide = async (page: Page, path: string, before?: () => Promise<void>) => {
    const maximize = shell(page).locator('[data-testid^="card-maximize-"]').first()
    await page.setViewportSize({ width: 1440, height: 2400 })
    await maximize.click()
    const restore = page.locator('[data-testid^="card-minimize-"]').first()
    await expect(restore).toBeVisible()
    const maximized = page.locator('.smithers-card[data-maximized="true"]')
    // The card scales in over --dur; a picture taken before it settles shows it shrunk and cut at its edges.
    // A settled card's opacity transition is cancelled by the scale-in that owns opacity (WebKit rejects its `finished`); cancelled draws nothing.
    await maximized.evaluate(node => Promise.all(node.getAnimations().map(animation => animation.finished.catch(() => undefined))))
    await before?.()
    await maximized.screenshot({ path })
    await restore.click()
    await expect(maximize).toBeVisible()
  }
  /** The section at conversation width, then the whole maximized card, in each theme. */
  const shoot = async (page: Page, name: string) => {
    for (const mode of ["light", "dark"] as const) {
      await theme(page, mode)
      await narrow(page, `${dir}/${name}-${mode}-narrow.png`)
      await wide(page, `${dir}/${name}-${mode}-wide.png`)
    }
    await theme(page, "light")
  }
  const lines: Readonly<Record<string, string>> = {
    "run-3": "/issue-sweep 32 vm attempt=10", exhausted: "/issue-sweep 4 local", sleeping: "/issue-sweep",
    cancelled: "/issue-sweep 2 local", completed: "/issue-sweep 4 local", failed: "/issue-sweep 4 local", empty: "/issue-sweep 4 local",
    // The line cannot ask for cloud agents; the run's own input in its journal does.
    overflow: "/issue-sweep 2 vm"
  }
  const start = async (page: Page, name: string, runId: string, workspace?: Workspace) => {
    const served = await serve(page, fixture(name), runId, workspace)
    await open(page)
    // The run's toast floats over the transcript; the picture is of the card.
    await page.addStyleTag({ content: ".toast-stack { visibility: hidden !important; }" })
    await send(page, lines[name]!)
    return served
  }
  const STATUS: Readonly<Record<string, string>> = {
    "run-3": "Running", exhausted: "Parked", sleeping: "Parked", cancelled: "Cancelled", completed: "Finished", failed: "Failed", empty: "Finished",
    overflow: "Running"
  }

  test("launching and loading", async ({ page }) => {
    const run = gate(), events = gate()
    await start(page, "run-3", "shot-launching", { refuse: new Set(), upTo: Infinity, run: run.held, events: events.held })
    await expect(page.locator('section.burndown[data-stage="launching"]')).toBeVisible({ timeout: 15_000 })
    await shoot(page, "launching")
    run.open()
    await expect(board(page, "shot-launching")).toHaveAttribute("data-stage", "loading", { timeout: 15_000 })
    await shoot(page, "loading")
    events.open()
  })

  for (const name of ["run-3", "exhausted", "sleeping", "cancelled", "completed", "failed", "empty", "overflow"]) {
    test(name, async ({ page }) => {
      const runId = `shot-${name}`
      await start(page, name, runId)
      const card = board(page, runId)
      await expect(card).toHaveAttribute("data-stage", "ready", { timeout: 15_000 })
      await expect(card.getByTestId("burndown-status")).toHaveText(STATUS[name]!, { timeout: 15_000 })
      if (name === "overflow") {
        // Two vm children on this Mac, and the cloud's one working of the three the run asked for.
        await expect(card.getByTestId("burndown-machine").locator(".burndown-meter-value")).toHaveText("2/2")
        await expect(card.getByTestId("burndown-cloud").locator(".burndown-meter-value")).toHaveText("1/3")
        await card.locator('.burndown-row[data-issue="3358"]').click()
        await expect(card.getByTestId("burndown-detail")).toContainText("Cloud")
      }
      await shoot(page, name)
      if (name === "run-3") {
        for (const mode of ["light", "dark"] as const) {
          await theme(page, mode)
          for (const width of [320, 720]) await narrow(page, `${dir}/run-3-${mode}-${width}.png`, width)
        }
        await theme(page, "light")
        // The keyboard's ring on a row, then on an open detail's reason, under its row.
        for (const mode of ["light", "dark"] as const) {
          await theme(page, mode)
          await page.setViewportSize({ width: 412, height: 4000 })
          const row = card.locator('.burndown-group[data-state="landing"] .burndown-row').nth(1)
          await row.focus()
          await page.keyboard.press("ArrowDown")
          await page.keyboard.press("ArrowUp")
          await narrow(page, `${dir}/run-3-focus-row-${mode}-narrow.png`)
          await page.keyboard.press("Enter")
          await expect(card.getByTestId("burndown-detail")).toBeVisible()
          await narrow(page, `${dir}/run-3-focus-detail-${mode}-narrow.png`)
          await wide(page, `${dir}/run-3-focus-detail-${mode}-wide.png`, async () => {
            await card.locator('.burndown-row[aria-expanded="true"]').focus()
            await page.keyboard.press("ArrowDown")
            await page.keyboard.press("ArrowUp")
          })
          await card.locator('.burndown-row[aria-expanded="true"]').click()
        }
        await theme(page, "light")
      }
      if (name === "run-3" || name === "failed") {
        // An issue's failure: its notice in the detail, under its row.
        await card.getByTestId("burndown-strip").locator('[data-state="failed"]').click()
        await card.locator('.burndown-group[data-state="failed"] .burndown-row').nth(name === "run-3" ? 1 : 0).click()
        await expect(card.getByTestId("burndown-failure")).toBeVisible()
        await shoot(page, `${name}-issue-failed`)
      }
    })
  }

  test("the watch: reconnecting", async ({ page }) => {
    const { workspace } = await start(page, "run-3", "shot-reconnecting")
    const card = board(page, "shot-reconnecting")
    await expect(card).toHaveAttribute("data-stage", "ready", { timeout: 15_000 })
    workspace.refuse.add("run-summary")
    await expect(card.getByTestId("burndown-observer")).toHaveText("Reconnecting…", { timeout: 30_000 })
    await shoot(page, "reconnecting")
  })

  test("resume: asked, refused, waiting", async ({ page }) => {
    const { workspace } = await start(page, "exhausted", "shot-resume", { refuse: new Set(["Signal"]), upTo: Infinity })
    const card = board(page, "shot-resume")
    await expect(card.getByTestId("burndown-status")).toHaveText("Parked", { timeout: 15_000 })
    for (const mode of ["light", "dark"] as const) {
      await theme(page, mode)
      await page.setViewportSize({ width: 412, height: 4000 })
      await card.getByTestId("burndown-resume").click()
      await expect(card.getByTestId("burndown-confirm")).toBeVisible()
      await card.screenshot({ path: `${dir}/resume-confirm-${mode}-narrow.png` })
      await page.keyboard.press("Escape")
    }
    await theme(page, "light")
    await card.getByTestId("burndown-resume").click()
    await card.getByTestId("burndown-confirm").getByRole("button", { name: "Resume" }).click()
    await expect(card.getByTestId("burndown-refused")).toBeVisible({ timeout: 15_000 })
    await shoot(page, "resume-refused")
    workspace.refuse.clear()
    await card.getByTestId("burndown-resume").click()
    await card.getByTestId("burndown-confirm").getByRole("button", { name: "Resume" }).click()
    await expect(card.getByTestId("burndown-resume")).toHaveAttribute("aria-busy", "true", { timeout: 15_000 })
    await shoot(page, "resume-pending")
  })

  test("stop: waiting, refused", async ({ page }) => {
    const cancel = gate()
    const { workspace } = await start(page, "run-3", "shot-stop", { refuse: new Set(), upTo: Infinity, cancel: cancel.held })
    const card = board(page, "shot-stop")
    await expect(card).toHaveAttribute("data-stage", "ready", { timeout: 15_000 })
    await card.getByTestId("burndown-stop").click()
    await card.getByTestId("burndown-confirm").getByRole("button", { name: "Stop for now" }).click()
    await expect(card.getByTestId("burndown-stop")).toHaveAttribute("aria-busy", "true")
    await shoot(page, "stop-pending")
    workspace.refuse.add("Cancel")
    cancel.open()
    await expect(card.getByTestId("burndown-observer")).toHaveText("Stopped watching", { timeout: 15_000 })
    await shoot(page, "stop-refused")
  })
})
