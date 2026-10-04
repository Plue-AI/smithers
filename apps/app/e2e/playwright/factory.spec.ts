import { mkdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { controlTabKey, expect, test, type Locator, type Page } from "./browserTest"
import { boxRunCardId, FIXTURE_BOX, installCloudFixture, runningBox } from "./cloudFixture"

/*
 * The web factory UX (2026-09-28 pass) against server doubles: the run
 * forest on a run's Graph, the token meter on the run header, the History
 * card as the factory's issue list and metrics, and the run inbox's Needs you
 * group answering a HumanTask question. Every act is a keyboard gesture:
 * Tab to a control and press Enter, or a slash command in the composer.
 *
 * The run journal is the recorded `gateway/GraphFixture` run
 * (src/mainview/cards/fixtures/GraphRunJournal.json) plus three agent rows
 * that give the meter a seat and two settled model calls.
 *
 * EVIDENCE_DIR, when set, receives one PNG per state; otherwise each lands in
 * the test's own Playwright output directory, which CI keeps as an artifact.
 */

const REPO = "smithersai/smithers"
const RUN_ID = "run-1"
const FLOW = "gateway/GraphFixture"
const GATE = "c7eac2d2567599c2bcbcbaa35ac4e07acf21e6e01c23753262361a60a7e0f07d"

type Row = Record<string, unknown>
const RECORDED: { readonly rows: ReadonlyArray<Row> } =
  JSON.parse(readFileSync(join(__dirname, "../../src/mainview/cards/fixtures/GraphRunJournal.json"), "utf8"))
const lastSequence = Math.max(...RECORDED.rows.map((row) => Number(row.sequence)))
const agentRow = (offset: number, kind: string, payload: Row): Row => {
  const sequence = lastSequence + offset
  return { cursor: { sequence }, sequence, kind, runId: RUN_ID, occurredAt: 1789826454300 + offset, payload }
}
/* claude-opus-4-1 is a Claude id the catalog meets under /claude/: a 200k window. */
const JOURNAL: ReadonlyArray<Row> = [
  ...RECORDED.rows,
  agentRow(1, "control.agent.turn-opened", { seat: "anthropic:claude-opus-4-1" }),
  agentRow(2, "control.agent.model-settled", { text: "ok", usage: { inputTokens: 24_000, outputTokens: 1200, cachedInputTokens: 22_000 } }),
  agentRow(3, "control.agent.model-settled", { text: "ok", usage: { inputTokens: 10_112, outputTokens: 800, cachedInputTokens: 10_000 } }),
  /* Two relevance readings: three memories in, two only ever withheld (p is Jev's probability an item is NOT needed). */
  agentRow(4, "control.agent.relevance-settled", { scope: "run", frame: "turn-1", source: "supervisor", withholdAt: 0.9, latencyMs: 3,
    kept: [{ kind: "memory", id: "mem-retries", digest: "sha256:a1", p: 0.1 }, { kind: "memory", id: "mem-gateway", digest: "sha256:a2", p: 0.3 },
      /* Not a memory: the In tab's memory row must not count it. */
      { kind: "tool", id: "tool-bash", digest: "sha256:t1", p: 0.05 }],
    withheld: [{ kind: "memory", id: "mem-css", digest: "sha256:a3", p: 0.95 }] }),
  agentRow(5, "control.agent.relevance-settled", { scope: "run", frame: "turn-2", source: "supervisor", withholdAt: 0.9, latencyMs: 3,
    kept: [{ kind: "memory", id: "mem-journal", digest: "sha256:a4", p: 0.2 }],
    withheld: [{ kind: "memory", id: "mem-billing", digest: "sha256:a5", p: 0.97 }, { kind: "memory", id: "mem-gateway", digest: "sha256:a2", p: 0.92 }] })
]

interface RpcCall {
  readonly procedure: string
  readonly payload: Record<string, unknown>
}

const summary = (runId: string, flowId: string, status: string, extra: Row = {}): Row => ({
  runId, flowId, status, createdAt: Date.now(), updatedAt: Date.now(), turns: 1, calls: 2, callsFailed: 0,
  editsAttempted: 0, editsSucceeded: 0, inputTokens: 0, outputTokens: 0, verdict: status, diagnosis: status, ...extra
})

/** The HumanTask gate the inbox answers: a `select` question with three options. */
const QUESTION_RUN = "run-ask"
const QUESTION_TITLE = "Which service owns retries?"
const OPTIONS = ["scheduler", "gateway", "worker"] as const
const questionGate: Row = {
  runId: QUESTION_RUN, requestId: "ask-1", title: QUESTION_TITLE, requestedAt: Date.now(), status: "pending",
  waitRunId: "wait-1", request: { kind: "select", prompt: QUESTION_TITLE, options: [...OPTIONS] },
  payload: { target: { _tag: "Node", runId: QUESTION_RUN, requestId: "ask-1", digest: "sha256:test",
    envelope: { capabilities: [], flows: [], budget: {} } }, scope: "run", idempotencyKey: "approve:ask-1" }
}

/** The gateway double: one box, the recorded run, a waiting run with a question, and a done run. */
const serveGateway = async (page: Page, extra: {
  readonly runs?: ReadonlyArray<Row>
  readonly journals?: Readonly<Record<string, ReadonlyArray<Row>>>
  /** `cloud.terminal`: the box terminal tunnel exists on this host. */
  readonly terminal?: boolean
} = {}): Promise<{ rpc: Array<RpcCall> }> => {
  const rpc: Array<RpcCall> = []
  let answered = false
  await installCloudFixture(page, { capabilities: ["agent", "identity", "cloud", "cloud.pat", ...extra.terminal ? ["cloud.terminal" as const] : []],
    workspaces: [runningBox(REPO)] })
  await page.route("**/api/workflow/provision", (route) => route.fulfill({ json: { status: "ready", repo: REPO, gatewayId: "gw-1" } }))
  await page.route("**/api/workflow/rpc", async (route) => {
    const call = route.request().postDataJSON() as RpcCall
    rpc.push(call)
    const rows = (projection: string, value: ReadonlyArray<unknown>) =>
      route.fulfill({ json: { ok: true, payload: { cursor: { projection, runId: null, value: 0 }, rows: value } } })
    const workspace = () => [
      summary(QUESTION_RUN, "coding/request", answered ? "running" : "waiting-approval"),
      summary("run-busy", "coding/vibe", "running"),
      summary(RUN_ID, FLOW, "completed"),
      ...extra.runs ?? []
    ]
    switch (call.procedure) {
      case "Approval.Submit":
        answered = true
        return route.fulfill({ json: { ok: true, payload: { decision: { _tag: "Accepted", receiptId: "a" } } } })
      case "Projection.Snapshot": {
        const selector = (call.payload.selector ?? {}) as { _tag?: string; runId?: string }
        switch (selector._tag) {
          case "workspace-runs":
            return rows("workspace-runs", workspace())
          case "run-summary":
            return rows("run-summary", workspace().filter((row) => row.runId === (selector.runId ?? RUN_ID)))
          case "approvals":
            return rows("approvals", answered || (selector.runId !== undefined && selector.runId !== QUESTION_RUN) ? [] : [questionGate])
          case "run-events": {
            const journal = selector.runId === undefined || selector.runId === RUN_ID ? JOURNAL : extra.journals?.[selector.runId] ?? []
            const after = call.payload.after as { value: number; offset: number } | undefined
            let offset = 0
            return rows("run-events", journal.filter((event, index) => {
              offset = index > 0 && journal[index - 1]?.sequence === event.sequence ? offset + 1 : 0
              return after === undefined || Number(event.sequence) > after.value ||
                (event.sequence === after.value && offset > after.offset)
            }))
          }
          default:
            return rows(String(selector._tag), [])
        }
      }
      default:
        return route.fulfill({ json: { ok: true, payload: { _tag: "Accepted", receiptId: "ok" } } })
    }
  })
  return { rpc }
}

/** The mythical stack double: two needs-you items, two working, two landed today with first-observed stamps, a revert. */
/** Reach a control through the keyboard order, never by pointer. */
const tabTo = async (page: Page, target: Locator, limit = 200): Promise<void> => {
  await expect(target).toBeVisible()
  for (let step = 0; step < limit; step++) {
    if (await target.evaluate((element) => element === document.activeElement)) return
    await page.keyboard.press(controlTabKey(page))
  }
  throw new Error("The control was not reachable with Tab")
}

/** A slash command through the composer: Control+K, type, Enter, Escape. */
const command = async (page: Page, line: string): Promise<void> => {
  const input = page.getByTestId("composer-input")
  if (!await input.isVisible()) await page.keyboard.press("Control+k")
  await expect(input).toBeFocused()
  await page.keyboard.insertText(line)
  await page.keyboard.press("Enter")
  await expect(input).toHaveValue("")
  if (await input.isVisible()) await page.keyboard.press("Escape")
}

const boot = async (page: Page): Promise<void> => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" })
  await page.goto("/")
  await expect(page.getByTestId("composer-input")).toBeAttached()
}

/** Flip the theme through /theme and wait for the root to say so. */
const toggleTheme = async (page: Page, to: "light" | "dark"): Promise<void> => {
  await command(page, "/theme")
  await expect(page.locator("html")).toHaveAttribute("data-theme", to)
}

/** Whether a graph node lies inside its canvas's visible rectangle. */
const inCanvas = (node: Locator): Promise<boolean> => node.evaluate((element) => {
  const canvas = element.closest(".react-flow")?.getBoundingClientRect()
  const box = element.getBoundingClientRect()
  return canvas !== undefined && box.left >= canvas.left && box.right <= canvas.right && box.top >= canvas.top && box.bottom <= canvas.bottom
})

const shot = async (page: Page, target: Locator | Page, name: string): Promise<void> => {
  const evidence = process.env.EVIDENCE_DIR
  const path = evidence === undefined ? test.info().outputPath(name) : join(evidence, name)
  mkdirSync(dirname(path), { recursive: true })
  await page.mouse.move(0, 0)
  await target.screenshot({ path, animations: "disabled" })
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try {
      if (!window.sessionStorage.getItem("factory-spec-initialized")) {
        window.localStorage.clear()
        window.sessionStorage.setItem("factory-spec-initialized", "yes")
      }
    } catch {
      // A refused store is the empty store already.
    }
  })
})

test("run forest: a child execution opens in place and Open on its up node returns; the header shows the meter", async ({ page }) => {
  test.setTimeout(150_000)
  await serveGateway(page)
  await boot(page)
  await command(page, `/runs.open ${RUN_ID} ${REPO}`)
  const card = page.getByTestId(`card-${boxRunCardId(REPO, RUN_ID)}`)
  await expect(card).toBeVisible({ timeout: 15_000 })

  // The meter: 34k in, 2.0k out, 34,112 of 200k is 5.1% (latest call 10,112), cache 94%.
  const meter = card.getByTestId(`run-meter-${RUN_ID}`)
  await expect(meter).toHaveText("↑34k ↓2.0k · 5.1%/200k · cache 94%")
  await expect(meter).toHaveAttribute("aria-label", "34k tokens in, 2.0k out, 5.1% of 200k window, cache 94%")
  await shot(page, card.getByTestId(`run-outcome-${RUN_ID}`), "03-meter.png")

  // Graph, through the trace bar's own button.
  await tabTo(page, card.getByRole("button", { name: "Graph", exact: true }))
  await page.keyboard.press("Enter")
  const gate = card.locator(`[data-node="exec:${GATE}"]`)
  await expect(gate).toBeVisible({ timeout: 15_000 })
  await expect(gate).toHaveAttribute("data-forest", "flow")
  await expect(gate.locator(".flow-graph-node-word")).toHaveText("done")
  await expect(gate.locator(".flow-run-node-id")).toHaveText("flow")

  // Maximize the card so the canvas has room; focusing a node pans the camera to it.
  await tabTo(page, card.getByRole("button", { name: "Maximize card", exact: true }))
  await page.keyboard.press("Enter")
  await expect(card).toHaveAttribute("data-maximized", "true")
  const gateNode = card.locator(`.react-flow__node[data-id="exec:${GATE}"]`)
  await tabTo(page, gateNode)
  await expect.poll(() => inCanvas(gateNode)).toBe(true)
  await shot(page, card, "01-forest.png")
  await toggleTheme(page, "dark")
  await gateNode.focus()
  await shot(page, card, "01-forest-dark.png")
  await toggleTheme(page, "light")

  // Select the child execution: Tab to its node and press Enter; the drawer names it and offers Open.
  await tabTo(page, gateNode)
  await page.keyboard.press("Enter")
  const drawer = card.locator(`aside.flow-graph-drawer[data-node="exec:${GATE}"]`)
  await expect(drawer).toBeVisible()
  await expect(drawer.locator(".flow-graph-drawer-tag")).toHaveText("gateway/graph/Gate")
  await expect(drawer.locator(".flow-graph-drawer-word")).toHaveText("done")
  const open = drawer.getByRole("button", { name: "Open", exact: true })
  await tabTo(page, open)
  await page.keyboard.press("Enter")

  // The canvas now draws Gate's nodes, with an up node for GraphFixture.
  await expect(gate).toHaveCount(0)
  const up = card.locator(`[data-forest="flow"]`).filter({ has: page.locator(".flow-graph-node-word") })
  const upNode = card.locator(".react-flow__node").filter({ has: page.locator('[data-forest="flow"]') })
    .filter({ hasText: "done" })
  await expect(up.first()).toBeVisible()
  const upId = await card.locator("[data-forest]").evaluateAll((nodes) =>
    nodes.map((node) => ({ id: node.getAttribute("data-node"), label: node.closest(".react-flow__node")?.getAttribute("aria-label") ?? "" })))
  const fixtureUp = upId.find((node) => node.label.includes(FLOW))
  expect(fixtureUp, JSON.stringify(upId)).toBeDefined()
  const gateNodes = await card.locator(".react-flow__node").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-label") ?? ""))
  expect(gateNodes.length).toBeGreaterThan(1)
  expect(gateNodes.some((label) => label.includes(FLOW))).toBe(true)
  await expect(upNode.first()).toBeVisible()
  // Whether the re-drawn canvas frames any of Gate's nodes before the reader moves the camera.
  const framedOnOpen = await card.locator(".react-flow__node").evaluateAll((nodes) => {
    const canvas = nodes[0]?.closest(".react-flow")?.getBoundingClientRect()
    return canvas === undefined ? 0 : nodes.filter((node) => {
      const box = node.getBoundingClientRect()
      return box.right > canvas.left && box.left < canvas.right && box.bottom > canvas.top && box.top < canvas.bottom
    }).length
  })
  /* Opening another execution mounts a canvas framed on its own nodes, not the parent's viewport. */
  expect(framedOnOpen).toBeGreaterThan(0)
  await shot(page, card, "02-forest-opened-initial.png")
  const upFocus = card.locator(`.react-flow__node[data-id="${fixtureUp!.id}"]`)
  await tabTo(page, upFocus)
  await expect.poll(() => inCanvas(upFocus)).toBe(true)
  await shot(page, card, "02-forest-opened.png")

  // Open on the up node returns to GraphFixture's own graph, where Gate's execution node is back.
  await tabTo(page, card.locator(`.react-flow__node[data-id="${fixtureUp!.id}"]`))
  await page.keyboard.press("Enter")
  const upDrawer = card.locator(`aside.flow-graph-drawer[data-node="${fixtureUp!.id}"]`)
  await expect(upDrawer.locator(".flow-graph-drawer-tag")).toHaveText(FLOW)
  await tabTo(page, upDrawer.getByRole("button", { name: "Open", exact: true }))
  await page.keyboard.press("Enter")
  await expect(gate).toBeVisible()
  await expect(card.locator(`[data-node="${fixtureUp!.id}"]`)).toHaveCount(0)
})

test("run inbox: Needs you names the gate, Answer opens one button per option, and choosing one submits the answer", async ({ page }) => {
  test.setTimeout(120_000)
  const { rpc } = await serveGateway(page)
  await boot(page)
  await command(page, `/runs.attention ${REPO}`)
  const inbox = page.locator('[data-kind="run-list"]')
  const needsYou = inbox.getByTestId("runs-inbox-needs-you")
  await expect(needsYou).toBeVisible({ timeout: 15_000 })
  await expect(needsYou.locator("h3")).toHaveText("◆ Needs you 1")
  await expect(needsYou.getByTestId(`runs-gate-${QUESTION_RUN}`)).toHaveText(QUESTION_TITLE)
  await shot(page, inbox, "06-inbox-attention.png")

  // The whole inbox: Needs you, Working and Done, each with its count.
  await command(page, `/runs.list ${REPO}`)
  const all = inbox.filter({ has: page.getByTestId("runs-inbox-working") })
  await expect(all.getByTestId("runs-inbox-needs-you").locator("h3")).toHaveText("◆ Needs you 1", { timeout: 15_000 })
  await expect(all.getByTestId("runs-inbox-working").locator("h3")).toHaveText("◐ Working 1")
  await expect(all.getByTestId("runs-inbox-done").locator("h3")).toHaveText("● Done 1")
  await expect(all.getByTestId("runs-inbox-done")).toContainText(RUN_ID)
  await shot(page, all, "06-inbox.png")
  await toggleTheme(page, "dark")
  await shot(page, all, "06-inbox-dark.png")
  await toggleTheme(page, "light")

  const answer = all.getByTestId(`runs-answer-${QUESTION_RUN}`)
  await expect(answer).toHaveText("Answer")
  await tabTo(page, answer)
  await page.keyboard.press("Enter")
  const approval = page.locator('[data-kind="approval"]').filter({ hasText: QUESTION_TITLE })
  await expect(approval).toBeVisible({ timeout: 15_000 })
  const choices = approval.locator('[data-testid^="approval-answer-option-"]')
  await expect(choices).toHaveText([...OPTIONS])
  await shot(page, approval, "07-answer.png")

  await tabTo(page, approval.getByTestId("approval-answer-option-gateway"))
  await page.keyboard.press("Enter")
  await expect.poll(() => rpc.filter((call) => call.procedure === "Approval.Submit").at(-1)?.payload.answer).toBe("gateway")
  await expect(approval.getByTestId("approval-answer-option-gateway")).toHaveCount(0)
  await shot(page, approval, "08-answered.png")
})

/*
 * The box behind the runs: its detail row (box.view), its terminal sessions
 * (openTerminal POSTs one and polls it until running) and the terminal socket
 * over the same-origin tunnel, whose binary input frames are captured.
 */
/* The inventory row (cloudFixture runningBox) titles the box "Box"; the card and the In tab name it so. */
const BOX_NAME = "Box"
const TERMINAL = "term-1"
const serveBox = async (page: Page): Promise<{ sessionPosts: Array<Row>; typed: Array<string> }> => {
  const sessionPosts: Array<Row> = []
  const typed: Array<string> = []
  const box = { id: FIXTURE_BOX, repo_full_name: REPO, name: BOX_NAME, target_bookmark: "main", status: "running",
    provisioning_stage: null, suspended_at: null, created_at: "2026-09-26T00:00:00Z" }
  const session = { id: TERMINAL, status: "running", workspace_id: FIXTURE_BOX, kind: "terminal", created_at: "2026-09-28T00:00:00Z" }
  await page.route((url) => url.pathname === `/api/repos/${REPO}/workspaces/${FIXTURE_BOX}`, (route) => route.fulfill({ json: box }))
  await page.route((url) => url.pathname === `/api/repos/${REPO}/workspace/sessions`, (route) => {
    if (route.request().method() === "POST") {
      sessionPosts.push(route.request().postDataJSON() as Row)
      return route.fulfill({ status: 201, json: session })
    }
    return route.fulfill({ json: sessionPosts.length === 0 ? [] : [session] })
  })
  await page.route((url) => url.pathname === `/api/repos/${REPO}/workspace/sessions/${TERMINAL}`, (route) => route.fulfill({ json: session }))
  /* The web host authorizes a terminal socket with a one-use ticket (@smthrs/rpc ApplicationAuth SOCKET_TICKET_PATH). */
  await page.route((url) => url.pathname === "/api/auth/sse-ticket", (route) =>
    route.fulfill({ json: { ticket: "ticket-1", expires_at: new Date(Date.now() + 60_000).toISOString() } }))
  await page.routeWebSocket(/\/workspace\/sessions\/[^/]+\/terminal/, (socket) => {
    socket.onMessage((message) => {
      if (typeof message !== "string") typed.push(new TextDecoder().decode(message))
    })
    socket.send(Buffer.from("$ "))
  })
  return { sessionPosts, typed }
}

test("the drawer's In tab: memory in and withheld, the box it runs on, and the secret names that box reaches", async ({ page }) => {
  test.setTimeout(150_000)
  await serveGateway(page)
  await serveBox(page)
  // The repository's secret metadata (SecretsSeam: GET /api/repos/{owner}/{repo}/secrets): names and bindings, never values.
  await page.route((url) => url.pathname === `/api/repos/${REPO}/secrets`, (route) => route.fulfill({ json: [
    { name: "NPM_TOKEN", main_only: false, hosts: ["registry.npmjs.org"], match_headers: ["authorization"], updated_at: "2026-08-01T00:00:00Z" }
  ] }))
  await boot(page)
  // The box's card names it; the secrets card lists the names its sessions may use (never values).
  await command(page, `/box.view ${FIXTURE_BOX}`)
  await expect(page.getByTestId(`card-workspace-${FIXTURE_BOX}`)).toContainText(BOX_NAME, { timeout: 15_000 })
  await command(page, `/secrets.list ${REPO}`)
  await expect(page.locator('[data-kind="secrets"]')).toContainText("NPM_TOKEN", { timeout: 15_000 })

  await command(page, `/runs.open ${RUN_ID} ${REPO}`)
  const card = page.getByTestId(`card-${boxRunCardId(REPO, RUN_ID)}`)
  await expect(card).toBeVisible({ timeout: 15_000 })
  await tabTo(page, card.getByRole("button", { name: "Graph", exact: true }))
  await page.keyboard.press("Enter")
  await expect(card.locator(".react-flow__node").first()).toBeVisible({ timeout: 15_000 })
  await tabTo(page, card.getByRole("button", { name: "Maximize card", exact: true }))
  await page.keyboard.press("Enter")
  await expect(card).toHaveAttribute("data-maximized", "true")

  // A recorded node (not a forest node): the graph's entry node.
  const recorded = await card.locator(".react-flow__node").evaluateAll((nodes) =>
    nodes.filter((node) => node.querySelector("[data-forest]") === null).map((node) => node.getAttribute("data-id") ?? ""))
  expect(recorded.length).toBeGreaterThan(0)
  const nodeId = recorded[0]!
  await tabTo(page, card.locator(`.react-flow__node[data-id="${nodeId}"]`))
  await page.keyboard.press("Enter")
  const drawer = card.locator(`aside.flow-graph-drawer[data-node="${nodeId}"]`)
  await expect(drawer).toBeVisible()
  const inTab = drawer.getByRole("tab", { name: "In", exact: true })
  /* The strip is one tab stop (the tab showing); arrow keys walk it (flowGraph/TabKeys.ts), whatever order it lays out. */
  if (await inTab.getAttribute("aria-selected") !== "true") {
    await tabTo(page, drawer.locator('[role="tab"][aria-selected="true"]'))
    const names = await drawer.getByRole("tab").allTextContents()
    const from = names.indexOf(await drawer.locator('[role="tab"][aria-selected="true"]').innerText())
    const to = names.indexOf("In")
    for (let step = 0; step < Math.abs(to - from); step++) {
      await page.keyboard.press(to > from ? "ArrowRight" : "ArrowLeft")
      await expect(drawer.getByRole("tab").nth(from + (to > from ? step + 1 : -(step + 1)))).toHaveAttribute("aria-selected", "true")
    }
  }
  await expect(inTab).toHaveAttribute("aria-selected", "true")
  await expect(drawer.getByTestId("run-inputs-memory")).toHaveText("memory · 3 in · 2 withheld")
  const memory = drawer.getByRole("list", { name: "Memory" }).locator("li")
  await expect(drawer).not.toContainText("tool-bash")
  /* Kept first, then withheld, each by relevance (1 − p); the glyph's spoken words are the drawer's own. */
  await expect(memory).toHaveText([/✓.*mem-retries \.90$/, /✓.*mem-journal \.80$/, /✓.*mem-gateway \.70$/, /–.*mem-css \.05$/, /–.*mem-billing \.03$/])
  expect(await memory.evaluateAll((rows) => rows.map((row) => row.getAttribute("data-kept")))).toEqual(["true", "true", "true", "false", "false"])
  await expect(drawer.getByTestId("run-inputs-where")).toHaveText(`runs on ${BOX_NAME}`)
  await expect(drawer.getByRole("list", { name: "Secrets" }).locator("li")).toHaveText(["⚷ NPM_TOKEN registry.npmjs.org"])
  await shot(page, drawer, "11-in-tab.png")
  await toggleTheme(page, "dark")
  await shot(page, drawer, "11-in-tab-dark.png")
  await toggleTheme(page, "light")
})
