import type { Page } from "@playwright/test"
import { expect, test } from "@playwright/test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import {
  GRAPH_CACHED,
  GRAPH_FAILING_NODE,
  GRAPH_FAN_OUT,
  GRAPH_FLOW,
  GRAPH_FLOW_SOURCE,
  GRAPH_GATE,
  GRAPH_GATE_FIRST_EDGE,
  GRAPH_GATE_QUESTION,
  GRAPH_MERGE,
  GRAPH_NODE_ACTIONS,
  GRAPH_NODE_IDS,
  GRAPH_REPO,
  GRAPH_RETRIED,
  GRAPH_SCHEDULE,
  GRAPH_STEADY
} from "./workspace.ts"
import { overTrackedFile } from "../../scripts/flow-graph-fixture-source.ts"
import { finishSignup, openChat } from "./app.ts"

/*
 * The plan door, end to end, over the real stack.
 *
 * Everything below the browser is real: the local origin, the relay, the
 * gateway, a real control plane, a real engine, two SQLite files and the
 * bridge between the journals (`e2e/graph/README.md`). Playwright's routing
 * call appears nowhere in this file on purpose — a spec that answered
 * `/api/workflow/rpc` itself would prove its own fixture and nothing else, and
 * the node ids asserted here are the ones the engine also schedules and
 * settles (`packages/smithers/test/FlowGraphRun.test.ts`).
 */

/** The canvas a run card draws its graph on; the plan card draws on the same one. */
const canvasOf = (page: Page) => page.locator(".flow-plan-canvas")

/**
 * Whether one node is drawn inside the canvas that draws it.
 *
 * This is what a camera is for, and the only thing the DOM can be asked about
 * one: a transform that moved is not a node a reader can see.
 */
const framed = (page: Page, nodeId: string): Promise<boolean> =>
  page.evaluate((id) => {
    const canvas = document.querySelector(".flow-plan-canvas")
    const node = canvas?.querySelector(`[data-node="${id}"]`)
    if (canvas === null || canvas === undefined || node === null || node === undefined) return false
    const frame = canvas.getBoundingClientRect()
    const drawn = node.getBoundingClientRect()
    return drawn.top >= frame.top && drawn.bottom <= frame.bottom &&
      drawn.left >= frame.left && drawn.right <= frame.right
  }, nodeId)

/** React Flow pans a focused node into view. Use that accessible navigation
 * before clicking a node outside the readable (never fit-all) viewport. */
const openNode = async (page: Page, id: string): Promise<void> => {
  const node = canvasOf(page).locator(".react-flow__node").filter({ has: page.locator(`[data-node="${id}"]`) })
  // Auto-pan follows keyboard focus-visible, not a programmatic focus left
  // in pointer modality by the Plan button.
  await page.keyboard.press("Tab")
  await node.focus()
  await expect.poll(() => framed(page, id)).toBe(true)
  await node.click()
  await expect(drawer(page)).toHaveAttribute("data-node", id)
}

/** The zoom the canvas is at, read off the transform React Flow writes. */
const zoomOf = async (page: Page): Promise<number> => {
  const transform = await canvasOf(page).locator(".react-flow__viewport").getAttribute("style")
  return Number(/scale\(([\d.]+)\)/.exec(transform ?? "")?.[1] ?? 0)
}

/** Opens the app and lists the workspace's flows, which is what draws the row. */
const listFlows = async (page: Page): Promise<void> => {
  await page.goto("/")
  await finishSignup(page)
  await command(page, `/flow.list ${GRAPH_REPO}`)
  await expect(page.locator(`[data-flow="flow.run"][data-flow-args="${GRAPH_FLOW}"]`)).toBeVisible()
}

/**
 * One slash command, typed.
 *
 * The composer lives behind the chat door, which is a TOGGLE: opening it a
 * second time closes it. So the door is pressed only where the composer is
 * not already there, and the press is followed to the composer rather than
 * assumed.
 */
const command = async (page: Page, text: string): Promise<void> => {
  const composer = page.getByTestId("composer-input")
  await openChat(page)
  await composer.fill(text)
  await composer.press("Enter")
}

/**
 * How many runs of the fixture this file has finished on the host.
 *
 * The browser context is fresh per test and the conversation with it, but the
 * control plane behind the origin is not: it is one host for the whole file,
 * and the `flow-durations` projection folds every finished run of the flow it
 * has ever seen. So the sample count a node's history states is the number of
 * runs THIS file finished, which is what {@link runFixture} counts. A test
 * that asserted a constant would be asserting the order it happened to be
 * declared in.
 */
let finished = 0

/** The run card this launch opened, under the run id the control plane keyed. */
const runIdOf = async (page: Page): Promise<string> => {
  const trace = page.locator('.smithers-card[data-kind="run-trace"]').last().locator('.run-trace[data-testid]')
  await expect(trace).toHaveAttribute("data-testid", /^run-trace-(?!pending-).+/)
  return (await trace.getAttribute("data-testid"))!.replace("run-trace-", "")
}

/**
 * Launches the fixture, answers the gate it parks on, and waits for the run
 * to finish.
 *
 * The gate is a real `HumanTask` and the run really waits on it, so nothing
 * here is a sleep: the answer goes in through the card the run parked on, and
 * the card's own outcome line is what says the run is over.
 */
const runFixture = async (page: Page): Promise<string> => {
  const traces = page.locator('.smithers-card[data-kind="run-trace"]')
  const before = await traces.count()
  await page.locator(`[data-flow="flow.run"][data-flow-args="${GRAPH_FLOW}"]`).click()
  await expect(traces).toHaveCount(before + 1)
  const runId = await runIdOf(page)
  await expect(page.getByTestId("approval-answer").last()).toContainText(GRAPH_GATE_QUESTION)
  await page.getByTestId("approval-answer-text").last().fill("merge")
  await page.getByTestId("approval-answer-send").last().click()
  await expect(page.getByTestId(`run-outcome-${runId}`)).toContainText("Finished")
  finished += 1
  return runId
}

/*
 * A run's canvas draws the plan's own nodes and, around them, the run forest
 * (`RunForest.ts`): the Gate child execution the run launched is hung off the
 * node whose action names its flow, as a node of the same grammar.
 */
const planNodesOf = (page: Page) => canvasOf(page).locator("[data-node]:not([data-forest])")
const childExecutionsOf = (page: Page) => canvasOf(page).locator('[data-node^="exec:"][data-forest="flow"]')

/** The run's graph, opened on the run card the launch left behind. */
const openRunGraph = async (page: Page, runId: string): Promise<void> => {
  await page.locator(`[data-flow="runs.trace.view"][data-flow-args="${runId} graph"]`).click()
  await expect(planNodesOf(page)).toHaveCount(GRAPH_NODE_IDS.length)
  await expect(childExecutionsOf(page)).toHaveCount(1)
}

/** The node the graph card has open, and the tab it is showing. */
const drawer = (page: Page) => page.locator(".flow-graph-drawer")

/**
 * The fixture's own source, read from the checkout this spec runs in.
 *
 * `__dirname` and not `import.meta`: Playwright transpiles a spec to CommonJS
 * and `import.meta` is a syntax error there, which takes the whole file out
 * of the run with "No tests found".
 */
const SOURCE_PATH = resolve(__dirname, "../../../..", GRAPH_FLOW_SOURCE)

/** One line of that file, 1-based, as the engine numbers a declaration site. */
const sourceLine = (line: number): string => readFileSync(SOURCE_PATH, "utf8").split("\n")[line - 1] ?? ""

/**
 * Runs a case that moves the fixture's source under the running host, and puts
 * the file back whatever happens, a SIGKILL included
 * (`scripts/flow-graph-fixture-source.ts`).
 */
const overTheFixtureSource = (
  body: (original: string, edit: (bytes: string) => void) => Promise<void>
): Promise<void> => overTrackedFile(SOURCE_PATH, body)

test.describe("the flow builder's plan door", () => {
  /*
   * A healthy stack raises nothing.
   *
   * The app reads four routes on its own the moment a session answers
   * signed-in, and this host answered 404 to all four. Three are dropped in
   * silence; `/api/billing/balance` is not, and its failure toast
   * ("Your balance couldn't be refreshed right now.") sat over the page for
   * the whole of a manual session, because a failed toast stays until it is
   * dismissed. A red toast over a stack that is working is the kind of thing
   * a reader learns to ignore, which is why it is asserted rather than
   * described.
   */
  test("boots with nothing failed on screen", async ({ page }) => {
    await page.goto("/")
    await finishSignup(page)
    // The session the relay answers is signed-in, which is what starts the
    // reads; waiting for a flow row means every one of them has been made.
    await command(page, `/flow.list ${GRAPH_REPO}`)
    await expect(page.locator(`[data-flow="flow.run"][data-flow-args="${GRAPH_FLOW}"]`)).toBeVisible()
    await expect(page.locator('[data-toast-status="failed"]')).toHaveCount(0)
    // The balance the host really reported, rather than the absence of a
    // toast alone: nothing here bills, so nothing has been charged, and a
    // launch is not gated on dollars this stack does not need.
    const balance = await page.evaluate(async () => {
      const token = document.querySelector('meta[name="smithers-local-session"]')?.getAttribute("content") ?? ""
      const response = await fetch("/api/billing/balance", { headers: { "x-smithers-local-session": token } })
      return { status: response.status, body: await response.json() as { allowedToStartWork?: unknown } }
    })
    expect(balance.status).toBe(200)
    expect(balance.body.allowedToStartWork).toBe(true)

    /*
     * The sandbox descriptor this host serves, read off the running host.
     *
     * `src/bun/server.test.ts` pins the same literal, but that file cannot be
     * run here: `bun test` over `src/bun` orphans `e2e/native` daemons, about
     * ten per run, so nothing executes it. This does, against the real
     * `startLocalServer` the host boots. It is a DESCRIPTOR and not `null`:
     * the host wraps no child process, so it says `unavailable` and
     * `unenforced` rather than claiming an enforcement it does not perform.
     */
    const bootstrap = await page.evaluate(async () => {
      const token = document.querySelector('meta[name="smithers-local-session"]')?.getAttribute("content") ?? ""
      const response = await fetch("/api/bootstrap", { headers: { "x-smithers-local-session": token } })
      return await response.json() as { host?: unknown; sandbox?: unknown }
    })
    expect(bootstrap.host).toBe("local")
    expect(bootstrap.sandbox).toEqual({
      platform: process.platform,
      mode: "unavailable",
      policies: { loader: "unenforced", targetRun: "unenforced" }
    })
  })

  test("draws the flow's real plan, with its node ids, its actions and its edges", async ({ page }) => {
    await listFlows(page)
    await page.locator(`[data-flow="flow.plan"][data-flow-args="${GRAPH_FLOW}"]`).click()

    // The count is the card's own, and it is the plan's node count.
    await expect(page.locator(".flow-plan-count")).toHaveText(String(GRAPH_NODE_IDS.length))

    // Every node the control plane keyed is drawn, under the id it keyed it
    // with. React Flow draws the id into `data-node`, so this reads the graph
    // and not a label.
    const drawn = page.locator(".flow-plan-canvas [data-node]")
    await expect(drawn).toHaveCount(GRAPH_NODE_IDS.length)
    expect((await drawn.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-node")))).sort())
      .toEqual([...GRAPH_NODE_IDS].sort())

    // A node that dispatches something is titled by the action it dispatches,
    // which is what tells a reader the Flaky arm from the Steady one.
    for (const [id, action] of Object.entries(GRAPH_NODE_ACTIONS)) {
      await expect(page.locator(`.flow-plan-canvas [data-node="${id}"]`)).toContainText(action)
    }
    // The tier every node was keyed at, reported and not guessed.
    await expect(page.locator('.flow-plan-canvas [data-node][data-tier="sealed"]')).toHaveCount(GRAPH_NODE_IDS.length)

    // Edges are what makes it a graph rather than a list, and the workspace's
    // labelled edges are what the card carries. The fan-out's four arms leave
    // the gate and the merge joins them, which is the shape a reader is here
    // for; React Flow writes each edge's `from->to` into `data-id`.
    for (const arm of GRAPH_FAN_OUT) {
      await expect(page.locator(`.flow-plan-canvas [data-id="${GRAPH_GATE}->${arm}"]`)).toHaveCount(1)
      await expect(page.locator(`.flow-plan-canvas [data-id="${arm}->${GRAPH_MERGE}"]`)).toHaveCount(1)
    }
    // Twenty labelled edges, one pair of which shares a `from->to` — the catch
    // arm is reached both as the continuation of the gate's subtree and as the
    // protected node's failure — and the drawer draws one line for a pair
    // (`FlowGraph.flowGraphModel`).
    await expect(page.locator(".flow-plan-canvas .react-flow__edge")).toHaveCount(19)
  })

  /*
   * The run's drawer: the node's own records, the file its action was
   * declared in, and the state surviving a reload.
   *
   * Everything asserted here is written by the engine — the tag, the tier,
   * the effects the plan record carried, the `node-*` rows naming this node,
   * and the attempt rows joined to it by the step key digests its settlement
   * states (D-048). The Code tab exists only because the engine recorded a
   * declaration site, and the file it opens is read from the repository
   * through the contents route, so the line a reader lands on is the line the
   * declaration is on.
   */
  test("opens a run node onto its own records, and onto the file it was declared in", async ({ page }) => {
    /*
     * This test owns the HOST's first run, and says so rather than relying on
     * the order it happens to be declared in. The fixture's retry is an
     * injected counter shared by the whole stack, so only the first run of a
     * host fails its first attempt (`FlowGraphRun.test.ts` states it in as
     * many words). A later run would show one attempt and the assertion below
     * would be reading a different fixture.
     */
    expect(finished, "this test reads the host's first run").toBe(0)
    await listFlows(page)
    const runId = await runFixture(page)
    await openRunGraph(page, runId)
    const canvas = canvasOf(page)

    const node = GRAPH_RETRIED
    await openNode(page, node)
    await expect(drawer(page)).toHaveAttribute("data-node", node)
    await expect(drawer(page).locator(".flow-graph-drawer-tag")).toHaveText(GRAPH_NODE_ACTIONS[node]!)
    await expect(drawer(page).locator(".flow-graph-drawer-word")).toHaveText("built")
    // The interpreter's own words for this node: its tier, the kind IT calls
    // this node (the plan scheduler calls the same node a `step`), and the
    // boundary the declaration was admitted under.
    await expect(drawer(page).locator('dd[data-field="tier"]')).toHaveText("sealed")
    await expect(drawer(page).locator('dd[data-field="kind"]')).toHaveText("ActionCall")
    await expect(drawer(page).locator('dd[data-field="boundary"]')).toHaveText("expected")
    // A recorded graph carries no step key, so the drawer shows none.
    await expect(drawer(page).locator('dd[data-field="key"]')).toHaveCount(0)

    // Events: this node's own two records, and nothing another node wrote.
    await drawer(page).locator('.flow-graph-drawer-tab[data-tab="events"]').click()
    await expect(drawer(page)).toHaveAttribute("data-tab", "events")
    await expect(drawer(page).locator(".flow-graph-events li .flow-graph-event-type"))
      .toHaveText(["node-scheduled", "node-settled"])
    await expect(drawer(page).locator(".flow-graph-events li").last()).toContainText("built")

    /*
     * Attempts: the dispatches that ran underneath one settlement, one row
     * each. The retry happens inside the dispatch, so the records carry a
     * step key digest and no node id; what joins them to this node is the
     * list of digests the node's own settlement names (D-052). The two
     * records one attempt is written as are folded into the row a reader
     * wants — which attempt, how it ended — so a retry is two rows and not
     * four. The count the node wears comes up from the dispatch the same
     * way, so it is the engine's number and not the walk's.
     */
    await drawer(page).locator('.flow-graph-drawer-tab[data-tab="attempts"]').click()
    const attempts = drawer(page).locator(".flow-graph-attempts li")
    await expect(attempts).toHaveCount(2)
    await expect(attempts.nth(0)).toHaveAttribute("data-attempt", "1")
    await expect(attempts.nth(0)).toHaveAttribute("data-state", "failed")
    await expect(attempts.nth(1)).toHaveAttribute("data-attempt", "2")
    await expect(attempts.nth(1)).toHaveAttribute("data-state", "succeeded")
    // And the node wears the count its own settlement states, which is the
    // engine's count of the dispatches it ran.
    await expect(canvas.locator(`[data-node="${node}"] .flow-run-node-attempt`)).toHaveText("attempt 2")
    /*
     * The foot's facts do not run together. `attempt 2` sat against `built`
     * with nothing between them, so the gap is MEASURED on the composited box
     * rather than read back out of the stylesheet that sets it.
     */
    const gap = await canvas.locator(`[data-node="${node}"] .flow-graph-node-foot`).evaluate((foot) => {
      const boxes = [...foot.children].map((child) => child.getBoundingClientRect())
      return boxes.slice(1).reduce((least, box, index) => Math.min(least, box.left - boxes[index]!.right), Infinity)
    })
    expect(gap).toBeGreaterThan(1)

    /*
     * Code: the declaration site the engine recorded, repo-relative, and the
     * real file behind it. The line is read off the card rather than written
     * down, and checked against the file on disk, so an edit that moves the
     * declaration moves both together or this fails.
     */
    await drawer(page).locator('.flow-graph-drawer-tab[data-tab="code"]').click()
    const site = (await drawer(page).locator(".flow-graph-code-path").textContent())!
    expect(site).toMatch(new RegExp(`^${GRAPH_FLOW_SOURCE.replaceAll(".", "\\.")}:\\d+$`))
    const line = Number(site.slice(site.lastIndexOf(":") + 1))
    expect(sourceLine(line)).toContain(`Action.make("${GRAPH_NODE_ACTIONS[node]}"`)

    await drawer(page).locator(".flow-graph-code-open").click()
    const file = page.locator(`.world-card-panel[data-line="${line}"]`)
    // ONE card, not two: the door asks this tab's own question, which is the
    // read at the recorded revision, so it cannot leave a second card of the
    // same file holding the working tree's bytes (D-068).
    await expect(file).toHaveCount(1)
    await expect(file).toBeVisible()
    // The file really was read: the line the card is anchored on holds the
    // declaration the node record pointed at.
    await expect(file.locator(`[data-line="${line}"]`)).toContainText(sourceLine(line).trim())

    /*
     * A reload. Which node is open and which tab it shows are facts on the
     * card, not component state, so the page that comes back is the page the
     * reader left.
     */
    await page.reload()
    await expect(drawer(page)).toHaveAttribute("data-node", node)
    await expect(drawer(page)).toHaveAttribute("data-tab", "code")
    await expect(drawer(page).locator(".flow-graph-code-path")).toHaveText(site)

    /*
     * A SECOND node of the same file. The bytes are in hand at the same
     * revision, so the door spends no request — it moves the card it already
     * has onto this node's line. One card, on the line the drawer is reading.
     */
    await openNode(page, GRAPH_STEADY)
    await drawer(page).locator('.flow-graph-drawer-tab[data-tab="code"]').click()
    const steadySite = (await drawer(page).locator(".flow-graph-code-path").textContent())!
    const steadyLine = Number(steadySite.slice(steadySite.lastIndexOf(":") + 1))
    expect(steadyLine).not.toBe(line)
    expect(sourceLine(steadyLine)).toContain(`Action.make("${GRAPH_NODE_ACTIONS[GRAPH_STEADY]}"`)
    await drawer(page).locator(".flow-graph-code-open").click()
    const moved = page.locator(".world-card-panel[data-line]")
    await expect(moved).toHaveCount(1)
    await expect(moved).toHaveAttribute("data-line", String(steadyLine))
    await expect(moved.locator(`[data-line="${steadyLine}"]`)).toContainText(sourceLine(steadyLine).trim())
  })

  /*
   * The run half: launch the flow and watch each node move on the same graph,
   * from the run's own `flows.engine.node-scheduled` and `node-settled`
   * records. Nothing here is staged — the gate really holds the run until a
   * person answers it through the card, and the words the nodes wear are the
   * engine's own (D-041).
   *
   * The three lifecycle states are each read off a node that is really in
   * them, never off a race: while the gate waits, it is `running` and the four
   * arms behind it are `pending`, because nothing behind a HumanTask can move
   * until it is answered; once the answer lands, all eleven settle. Catching
   * an arm mid-flight would be a timing bet, and the run is over in under two
   * seconds.
   */
  test("advances each node's status from the run's own node records", async ({ page }) => {
    await listFlows(page)
    await page.locator(`[data-flow="flow.run"][data-flow-args="${GRAPH_FLOW}"]`).click()

    // The card the launch opened, under the run id the control plane keyed.
    const runId = await runIdOf(page)

    await page.locator(`[data-flow="runs.trace.view"][data-flow-args="${runId} graph"]`).click()
    const canvas = canvasOf(page)
    await expect(planNodesOf(page)).toHaveCount(GRAPH_NODE_IDS.length)

    // Running: the gate is the node the engine scheduled and has not settled.
    await expect(canvas.locator(`[data-node="${GRAPH_GATE}"]`)).toHaveAttribute("data-state", "running")
    await expect(canvas.locator(`[data-node="${GRAPH_GATE}"]`)).toContainText("running")
    // Pending: every arm behind the gate, which no record names yet.
    for (const arm of GRAPH_FAN_OUT) {
      await expect(canvas.locator(`[data-node="${arm}"]`)).toHaveAttribute("data-state", "pending")
    }

    /*
     * The gate is a `HumanTask` three `.child()` boundaries down, so what the
     * run is waiting for is a person, and the card says so in the app's own
     * words beside the question the flow asked.
     */
    await expect(page.getByTestId(`run-outcome-${runId}`)).toContainText("Approval needed")
    await expect(page.locator('[data-status="waiting-approval"]').first()).toBeVisible()
    await expect(page.getByTestId("approval-answer")).toContainText(GRAPH_GATE_QUESTION)

    // D-024: follow starts on and frames the running node at readable size.
    // Turning it off freezes the reader's camera; it never shrinks to fit-all.
    const following = page.locator(`[data-flow="runs.graph.follow"][data-flow-args="${runId} off"]`)
    await expect(following).toHaveAttribute("data-on", "true")
    await expect.poll(() => framed(page, GRAPH_GATE)).toBe(true)
    expect(await zoomOf(page)).toBeGreaterThanOrEqual(1)
    await following.click()
    const follow = page.locator(`[data-flow="runs.graph.follow"][data-flow-args="${runId} on"]`)
    await expect(follow).toHaveAttribute("data-on", "false")
    expect(await zoomOf(page)).toBeGreaterThanOrEqual(1)
    await follow.click()
    await expect(following).toHaveAttribute("data-on", "true")
    await expect.poll(() => framed(page, GRAPH_GATE)).toBe(true)

    // Answered from the app, through the card the run parked on.
    await page.getByTestId("approval-answer-text").fill("merge")
    await page.getByTestId("approval-answer-send").click()

    /*
     * Settled. The recovered arm's protected node fails with the typed error
     * its sibling catch arm recovers from, so the run finishes with one node
     * settled `failed` and the other ten `built` — the same pair
     * `FlowGraphStatus.test.ts` folds off a recorded journal.
     */
    for (const id of GRAPH_NODE_IDS) {
      await expect(canvas.locator(`[data-node="${id}"]`))
        .toHaveAttribute("data-state", id === GRAPH_FAILING_NODE ? "failed" : "built")
    }
    await expect(canvas.locator('[data-node][data-state="failed"]')).toHaveCount(1)
    await expect(childExecutionsOf(page)).toHaveCount(1)
    await expect(page.getByTestId(`run-outcome-${runId}`)).toContainText("Finished")
    finished += 1
  })

  /*
   * The drill-in, on both cards.
   *
   * A plan node and a run node are the same drawer over two different sets of
   * evidence, and neither completes the other's: a plan carries the key the
   * control plane keyed the node under and no journal, a run carries the
   * journal and no key. So each half is asserted against what its own source
   * really holds, and against the tabs the other one does not get.
   */
  test("opens a plan node onto the key the control plane keyed it under", async ({ page }) => {
    await listFlows(page)
    await page.locator(`[data-flow="flow.plan"][data-flow-args="${GRAPH_FLOW}"]`).click()
    const canvas = canvasOf(page)
    await expect(canvas.locator("[data-node]")).toHaveCount(GRAPH_NODE_IDS.length)

    const node = GRAPH_STEADY
    await openNode(page, node)
    await expect(drawer(page)).toHaveAttribute("data-node", node)
    // The action it dispatches, its own id beneath, and the verdict the plan
    // reached — the card's own three facts about a node it has not run.
    await expect(drawer(page).locator(".flow-graph-drawer-tag")).toHaveText(GRAPH_NODE_ACTIONS[node]!)
    await expect(drawer(page).locator(".flow-graph-drawer-id")).toHaveText(node)
    await expect(drawer(page).locator(".flow-graph-drawer-word")).toHaveText("run")
    await expect(drawer(page).locator('dd[data-field="tier"]')).toHaveText("sealed")
    await expect(drawer(page).locator('dd[data-field="kind"]')).toHaveText("step")
    // The step key itself, as `@smthrs/plan` writes one: a versioned digest.
    // This is the only place a card can show what a node's identity IS, and
    // it is the number a re-key moves.
    await expect(drawer(page).locator('dd[data-field="key"]')).toHaveText(/^key1_[0-9a-f]{64}$/)

    // A plan has no journal, so the three tabs that read one are absent: a tab
    // with nothing behind it is absent, never empty (D-035). Code is there
    // because the workspace reported where the builder saw this node declared
    // (`PlanGraph.nodes[].declaredAt`), which is a fact about the SOURCE and
    // not about a run.
    await expect(drawer(page).locator(".flow-graph-drawer-tab")).toHaveCount(2)
    await expect(drawer(page).locator('.flow-graph-drawer-tab[data-tab="declaration"]')).toHaveAttribute("aria-selected", "true")
    await expect(drawer(page).locator('.flow-graph-drawer-tab[data-tab="output"]')).toHaveCount(0)
    await expect(drawer(page).locator('.flow-graph-drawer-tab[data-tab="events"]')).toHaveCount(0)
    await expect(drawer(page).locator('.flow-graph-drawer-tab[data-tab="attempts"]')).toHaveCount(0)

    // The site itself, read off the card and checked against the file on
    // disk, so an edit that moves the declaration moves both or this fails.
    await drawer(page).locator('.flow-graph-drawer-tab[data-tab="code"]').click()
    const site = (await drawer(page).locator(".flow-graph-code-path").textContent())!
    expect(site).toMatch(new RegExp(`^${GRAPH_FLOW_SOURCE.replaceAll(".", "\\.")}:\\d+$`))
    const line = Number(site.slice(site.lastIndexOf(":") + 1))
    expect(sourceLine(line)).toContain(`Action.make("${GRAPH_NODE_ACTIONS[node]}"`)
    await drawer(page).locator('.flow-graph-drawer-tab[data-tab="declaration"]').click()

    // A node the builder synthesised was declared nowhere, so it has the one
    // tab: the absence is about provenance, not about being a plan.
    await openNode(page, GRAPH_MERGE)
    await expect(drawer(page)).toHaveAttribute("data-node", GRAPH_MERGE)
    await expect(drawer(page).locator(".flow-graph-drawer-tab")).toHaveCount(1)
    await expect(drawer(page).locator('.flow-graph-drawer-tab[data-tab="code"]')).toHaveCount(0)
    await openNode(page, node)
    await expect(drawer(page)).toHaveAttribute("data-node", node)

    // What this node waits on is a door to that node, so the drawer walks the
    // graph the same way the canvas does.
    await drawer(page).locator(".flow-graph-depends-node").first().click()
    await expect(drawer(page)).toHaveAttribute("data-node", GRAPH_GATE)
    // And the close door leaves no node open at all.
    await drawer(page).locator(".flow-graph-drawer-close").click()
    await expect(drawer(page)).toHaveCount(0)
  })

  /*
   * D-068: the Code tab shows the source the plan was BUILT from.
   *
   * The host loaded this flow at startup and recorded the revision of the
   * tree it read it out of; the working tree moves afterwards, and the file
   * at that path is then not the file the plan was keyed from. So the edit
   * below happens BEFORE the tab is ever opened, which makes the read that
   * follows a fresh one: what it answers with is what the revision holds,
   * not what is on disk. The marker is inserted above the declaration, so a
   * reader served the working tree would see it and be one line off.
   */
  test("shows the source the plan was built from, not the file on disk", async ({ page }) => {
    await listFlows(page)
    const marker = "// edited after the host loaded this flow"
    await overTheFixtureSource(async (original, edit) => {
      await page.locator(`[data-flow="flow.plan"][data-flow-args="${GRAPH_FLOW}"]`).click()
      await expect(canvasOf(page).locator("[data-node]")).toHaveCount(GRAPH_NODE_IDS.length)
      const node = GRAPH_STEADY
      await openNode(page, node)
      await expect(drawer(page)).toHaveAttribute("data-node", node)

      // The site the plan recorded, and the line the checkout still has there.
      await drawer(page).locator('.flow-graph-drawer-tab[data-tab="declaration"]').click()
      const declaration = `Action.make("${GRAPH_NODE_ACTIONS[node]}"`
      const lines = original.split("\n")
      const index = lines.findIndex((line) => line.includes(declaration))
      expect(index).toBeGreaterThan(-1)
      const before = index + 1

      // The file changes under the plan, and the declaration moves down a line.
      edit([...lines.slice(0, index), marker, ...lines.slice(index)].join("\n"))
      expect(sourceLine(before)).toBe(marker)
      expect(sourceLine(before + 1)).toContain(declaration)

      // First open of the tab: the read happens now, against the revision.
      await drawer(page).locator('.flow-graph-drawer-tab[data-tab="code"]').click()
      const site = (await drawer(page).locator(".flow-graph-code-path").textContent())!
      expect(site).toBe(`${GRAPH_FLOW_SOURCE}:${before}`)
      const inline = drawer(page).locator(".flow-graph-code-file")
      await expect(inline).toBeVisible()
      // The bytes the revision holds: the declaration, and none of the edit.
      await expect(inline).toContainText(declaration)
      await expect(inline).not.toContainText(marker)
      // Nothing was refused: a read the route could not serve would say so here.
      await expect(drawer(page).locator(".flow-graph-code-error")).toHaveCount(0)
    })
  })

  /*
   * The keyboard. Every key is the same flow a click runs, so the arrows
   * reach nothing the pointer and the agent cannot (THE THREE-DOOR LAW). The
   * focus a reader actually has is React Flow's own node wrapper, which is
   * what the surface reads a key off, so this is the tier that proves it: a
   * component test can dispatch a key from anywhere it likes.
   */
  test("walks the graph from the keyboard and closes what it opened", async ({ page }) => {
    await listFlows(page)
    await page.locator(`[data-flow="flow.plan"][data-flow-args="${GRAPH_FLOW}"]`).click()
    const canvas = canvasOf(page)
    await expect(canvas.locator("[data-node]")).toHaveCount(GRAPH_NODE_IDS.length)

    // Clicking a node opens it AND leaves the browser focus on it, which is
    // where the next keystroke comes from.
    await openNode(page, GRAPH_GATE)
    await expect(drawer(page)).toHaveAttribute("data-node", GRAPH_GATE)

    // Down walks the FIRST edge OUT of the open node and Up the first edge
    // IN, both in the order the workspace reported the builder's edges. The
    // gate's first edge out is its `value` edge into the flow body it returns
    // into, ahead of the four arms it fans out to, and that same edge is the
    // first one into `root.flow`, so the pair is a round trip here.
    await page.keyboard.press("ArrowDown")
    await expect(drawer(page)).toHaveAttribute("data-node", GRAPH_GATE_FIRST_EDGE)
    await page.keyboard.press("ArrowUp")
    await expect(drawer(page)).toHaveAttribute("data-node", GRAPH_GATE)
    // The durable selection can render before React Flow applies its pan.
    // Finish that keyboard move before the helper focuses another node.
    await expect.poll(() => framed(page, GRAPH_GATE)).toBe(true)

    // The steady arm has one edge out and it joins the merge, which is the
    // fan-out shape a reader is here for. Up from the merge is NOT the way
    // back: the merge's first edge in is the gate's, so the arrows walk the
    // graph rather than a history of where the reader has been.
    await openNode(page, GRAPH_STEADY)
    await expect(drawer(page)).toHaveAttribute("data-node", GRAPH_STEADY)
    await page.keyboard.press("ArrowDown")
    await expect(drawer(page)).toHaveAttribute("data-node", GRAPH_MERGE)
    await page.keyboard.press("ArrowUp")
    await expect(drawer(page)).toHaveAttribute("data-node", GRAPH_GATE)

    // Enter opens the node the focus is on, wherever the selection is.
    const elsewhere = GRAPH_CACHED
    // React Flow owns the focusable element: the `tabindex` is on its own node
    // wrapper, around the node this app drew.
    await canvas.locator(`.react-flow__node:has([data-node="${elsewhere}"])`).focus()
    await page.keyboard.press("Enter")
    await expect(drawer(page)).toHaveAttribute("data-node", elsewhere)

    // Escape closes what is open, and closes it on the card, so nothing is
    // left holding a selection the payload does not have.
    await page.keyboard.press("Escape")
    await expect(drawer(page)).toHaveCount(0)
  })

  /*
   * A schedule on the canvas (D-031). It is a Dispatcher registration and not
   * a plan node: no key, no tier, no settlement, outside every count the plan
   * card states, and its detail is the panel that knows what a schedule is.
   * The row comes from the repository's registrations route
   * (`GET /api/workflow/trigger-registrations`), which the stack answers the
   * way Smithers Cloud does.
   */
  test("draws the registered schedule beside the plan, outside its count", async ({ page }) => {
    await listFlows(page)
    await command(page, `/triggers.list ${GRAPH_REPO}`)
    // The dispatcher card's own row for the registered schedule: a schedule
    // is registered, so the card is "listening" and the row is a row.
    await expect(page.getByTestId("trigger-live")).toBeVisible()
    const listed = page.locator(`[data-trigger="${GRAPH_SCHEDULE.id}"][data-source="box"]`)
    await expect(listed).toContainText(GRAPH_SCHEDULE.words)
    await expect(listed).toContainText(`runs ${GRAPH_FLOW}`)

    await page.locator(`[data-flow="flow.plan"][data-flow-args="${GRAPH_FLOW}"]`).click()
    const canvas = canvasOf(page)
    const trigger = canvas.locator(`[data-node="trigger:${GRAPH_SCHEDULE.id}"]`)
    // Armed: the registration is enabled.
    await expect(trigger).toHaveAttribute("data-trigger-state", "armed")
    // A fire starts the nodes that wait on nothing, which in this plan is the
    // gate alone. It is NOT the node id'd `root`: that one is the flow's own
    // body, it waits on everything, and it is drawn last. MANUAL-TEST.md
    // step 5 says which node the edge lands on, so the DOM says it here.
    await expect(canvas.locator(`[data-id="trigger:${GRAPH_SCHEDULE.id}->${GRAPH_GATE}"]`)).toHaveCount(1)
    await expect(canvas.locator(`[data-id^="trigger:${GRAPH_SCHEDULE.id}->"]`)).toHaveCount(1)
    // The count is the PLAN's, and a schedule is not in it.
    await expect(page.locator(".flow-plan-count")).toHaveText(String(GRAPH_NODE_IDS.length))
    await expect(canvas.locator("[data-node]")).toHaveCount(GRAPH_NODE_IDS.length + 1)

    await trigger.click()
    const panel = drawer(page).locator(`.flow-trigger[data-trigger="${GRAPH_SCHEDULE.id}"]`)
    await expect(panel).toHaveAttribute("data-trigger-state", "armed")
    // The one next fire the registration states, in UTC because that is the
    // zone a registration runs in.
    const fires = panel.locator(`[data-testid="trigger-fires-${GRAPH_SCHEDULE.id}"] li`)
    await expect(fires).toHaveCount(1)
    await expect(fires.first()).toContainText("03:00 UTC")
    // It carries the doors its slug addresses.
    await expect(panel.locator(`[data-testid="trigger-run-${GRAPH_SCHEDULE.slug}"]`)).toBeVisible()
    // A trigger is not a plan node, so it gets the panel and none of the
    // tabs that know what a plan node is.
    await expect(drawer(page).locator(".flow-graph-drawer-tab")).toHaveCount(0)
  })

  /*
   * Measured history (D-030). Two finished runs, and every node whose action
   * settled `built` in both of them wears what that action's history says it
   * takes, from the gateway's `flow-durations` projection.
   *
   * The HEADER states no estimate, and that is the point of asserting it: the
   * estimate is the longest path, the path runs through
   * `gateway/graph/Doomed`, and Doomed fails on every run. Only a `built`
   * outcome is measured, so that tag has no row, and a critical path with an
   * unmeasured node on it is silence rather than a sum that is short by
   * whatever Doomed takes.
   */
  test("wears the p50 two finished runs measured, and no estimate the path cannot make", async ({ page }) => {
    await listFlows(page)
    await runFixture(page)
    await runFixture(page)

    await page.locator(`[data-flow="flow.plan"][data-flow-args="${GRAPH_FLOW}"]`).click()
    const canvas = canvasOf(page)
    await expect(canvas.locator("[data-node]")).toHaveCount(GRAPH_NODE_IDS.length)

    // Every node that dispatches an action which settles `built` has a
    // measurement, and the claim behind the number says how many runs it was
    // folded from — the runs this file finished, and no others.
    for (const node of [GRAPH_STEADY, GRAPH_RETRIED, GRAPH_CACHED]) {
      const measured = canvas.locator(`[data-node="${node}"] .flow-graph-node-eta`)
      await expect(measured).toBeVisible()
      await expect(measured).toHaveAttribute("title", new RegExp(`^p50 of ${finished} runs · p90 `))
      expect(finished).toBeGreaterThanOrEqual(2)
    }
    // The node that fails has no measurement at all, and wears nothing.
    await expect(canvas.locator(`[data-node="${GRAPH_FAILING_NODE}"] .flow-graph-node-eta`)).toHaveCount(0)
    // So the header states no estimate.
    await expect(page.locator(".flow-plan-eta")).toHaveCount(0)
  })

  /*
   * The re-key preview: which keys a second plan changes (D-044).
   *
   * A step key is a function of what the step consumes, so the preview is the
   * plan a run was approved on compared with a fresh plan of the same flow.
   * Two edits are made here because they answer differently, and only one of
   * them is the answer a reader would guess:
   *
   *   - editing the flow's SOURCE re-keys nothing. The plan is built from the
   *     module this host loaded, and a declaration's source position is
   *     deliberately kept out of its key material (`DeclarationSite.annotate`
   *     stores it non-enumerably, so canonical serialization cannot see it).
   *     A host re-keys on an edit when it is restarted onto the new source,
   *     not when the bytes on disk change under it;
   *   - changing the flow's INPUT re-keys every node that consumes it, which
   *     is what the number states.
   *
   * There is no estimate beside either count, for the reason the test above
   * states: the work a second run would do runs through the node that fails,
   * and nothing has measured it.
   */
  test("counts the keys a second run would move, and only the ones that moved", async ({ page }) => {
    await listFlows(page)
    const runId = await runFixture(page)
    // The durable launch card has no progress sentence naming its run ID.
    // Read the recorded ID with runIdOf; the manual guide's old instruction
    // is tracked as a deviation rather than restoring unrequested copy.

    const rekey = page.locator(".flow-plan-rekey").last()
    await overTheFixtureSource(async (original, edit) => {
      edit(original.replace("steady:${label}", "steady-edited:${label}"))
      await command(page, `/flow.plan against=${runId} ${GRAPH_FLOW} ${GRAPH_REPO}`)
      await expect(rekey.locator(".flow-plan-rerun")).toHaveText(`re-keyed 0 of ${GRAPH_NODE_IDS.length}`)
      // `was` is a measurement of the run this plan was compared against: the
      // span of its own journal, first row to last.
      await expect(rekey.locator(".flow-plan-was")).toHaveText(/^was \d/)
      // A cache-hit count appears only where that run really settled nodes
      // clean, and nothing here declares a cache environment, so no run on
      // this host settles one (D-044, D-049).
      await expect(rekey.locator(".flow-plan-clean")).toHaveCount(0)
      // Doomed has no successful duration; unchanged does not make it free.
      await expect(rekey.locator(".flow-plan-rekey-eta")).toHaveCount(0)
    })

    await command(page, `/flow.plan against=${runId} ${GRAPH_FLOW} ${GRAPH_REPO} {"label":"edited"}`)
    // Ten of the eleven: every node whose key material carries the label. The
    // one that does not is the catch arm's own recovery, which consumes the
    // failure and not the input.
    await expect(rekey.locator(".flow-plan-rerun")).toHaveText(`re-keyed 10 of ${GRAPH_NODE_IDS.length}`)
    await expect(rekey.locator(".flow-plan-rekey-eta")).toHaveCount(0)
  })
})
