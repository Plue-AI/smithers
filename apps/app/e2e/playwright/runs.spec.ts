import type { Locator,Page } from "./browserTest"
import { controlTabKey, expect,test } from "./browserTest"
import type { StatusRollup } from "@smthrs/rpc/Health"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { earlyCodingJournal } from "../../src/mainview/cards/fixtures/CodingJournal"
import { CODING_PLAN } from "../../src/mainview/cards/fixtures/CodingPlan"
import { FIXTURE_BOX, installCloudFixture, runningBox } from "./cloudFixture.ts"
import { prepareHealthPage,sendHealthCommand } from "./healthFixture"

/*
 * Lane runs T1 (docs/workbench-lanes/runs.md "Exit"): launch a fixture flow,
 * steer it, stop it, and see it in the run inbox — the whole lifecycle over
 * the workspace gateway, with the server as a double: the shared cloud
 * fixture (cloudFixture.ts) answers the bootstrap, the sessions and the
 * Smithers Cloud inventory, this spec adds the gateway, and the RPC double
 * records each procedure so the test asserts the wire, not just the pixels.
 */

const REPO = "smithersai/smithers"
const RUN_ID = "run-e2e"

interface RpcCall {
  readonly repo: string
  readonly procedure: string
  readonly payload: Record<string, unknown>
}

const summaryRow = (status: string) => ({
  runId: RUN_ID,
  flowId: "review-pr",
  status,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  turns: 1,
  calls: 2,
  callsFailed: 0,
  editsAttempted: 0,
  editsSucceeded: 0,
  inputTokens: 0,
  outputTokens: 0,
  verdict: status === "completed" ? "completed — done." : status,
  diagnosis: "Verdict   done."
})

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body)
})

/** Install the server double: signed in as the scoped-down user, one loaded repo, one gateway that accepts everything. */
const serve = async (page: Page, journal: ReadonlyArray<Record<string, unknown>> = [], options: {
  readonly approvals?: ReadonlyArray<Record<string, unknown>>
  readonly submitApproval?: () => Promise<boolean>
  readonly completedRequest?: boolean
  readonly health?: () => StatusRollup
  readonly inputSchema?: unknown
  readonly attention?: boolean
} = {}): Promise<{ rpc: Array<RpcCall> }> => {
  const rpc: Array<RpcCall> = []
  let planned: { flowId: string; input: unknown } | undefined
  /** The engine's own accounting: a steer the gateway took is pending until the next turn. */
  let steeringPending = 0
  let cancelled = false
  await installCloudFixture(page, { capabilities: ["agent", "identity", "cloud", "cloud.pat"], workspaces: [runningBox("smithersai/smithers")] })
  await page.route("**/api/workflow/provision", (route) =>
    route.fulfill(json({ status: "ready", repo: REPO, gatewayId: "gw-1" })))
  await page.route("**/api/workflow/rpc", async (route) => {
    const call = route.request().postDataJSON() as RpcCall
    rpc.push(call)
    const rows = (projection: string, value: ReadonlyArray<unknown>) =>
      route.fulfill(json({ ok: true, payload: { cursor: { projection, runId: null, value: 0 }, rows: value } }))
    switch (call.procedure) {
      case "List":
        return route.fulfill(json({
          ok: true,
          payload: { _tag: "flows", items: options.completedRequest ? [{ flowId: "coding/vibe", description: "Finalize validated changes" }]
            : [{ flowId: "review-pr", description: "Review a PR", ...(options.inputSchema === undefined ? {} : { inputSchema: options.inputSchema }) }] }
        }))
      case "Plan":
        planned = { flowId: String(call.payload.flowId), input: call.payload.input }
        return route.fulfill(json({
          ok: true,
          payload: {
            planId: "plan-1",
            flowId: planned.flowId,
            digest: "digest-1",
            envelope: { capabilities: [], flows: [], budget: {} },
            inputSummary: "",
            deployClass: false,
            nodes: []
          }
        }))
      case "Run":
        return route.fulfill(json({ ok: true, payload: { _tag: "Accepted", receiptId: "r",
          runId: options.completedRequest && planned?.flowId === "coding/vibe" ? "vibe-e2e" : RUN_ID } }))
      case "Approval.Submit":
        if (options.submitApproval && !await options.submitApproval()) return route.fulfill(json({ ok: false, error: { message: "Approval unavailable" } }))
        // The launch path auto-approves the plan it just made.
        return route.fulfill(json({ ok: true, payload: { decision: { _tag: "Accepted", receiptId: "a" } } }))
      case "Steer":
        steeringPending += 1
        return route.fulfill(json({ ok: true, payload: { _tag: "Accepted", receiptId: "ok" } }))
      case "Resume":
      case "Signal":
        return route.fulfill(json({ ok: true, payload: { _tag: "Accepted", receiptId: "ok" } }))
      case "Cancel":
        cancelled = true
        return route.fulfill(json({ ok: true, payload: { _tag: "Accepted", receiptId: "ok" } }))
      case "Projection.Snapshot": {
        const selector = (call.payload.selector ?? {}) as { _tag?: string; runId?: string }
        switch (selector._tag) {
          case "workspace-runs":
            return rows("workspace-runs", [{ ...summaryRow(cancelled ? "cancelled" : options.attention ? "failed" : "running"), steeringPending }])
          case "run-summary":
            return rows("run-summary", [{ ...summaryRow(cancelled ? "cancelled" : options.health?.().state ?? (options.completedRequest && selector.runId !== "vibe-e2e" ? "completed" : "running")),
              ...(options.health === undefined ? {} : { statusRollup: options.health() }),
              ...(options.completedRequest ? { runId: selector.runId ?? RUN_ID, flowId: selector.runId === "vibe-e2e" ? "coding/vibe" : "coding/request" } : {}), steeringPending }])
          case "approvals":
            return rows("approvals", options.approvals ?? [])
          case "transcript":
            return rows("transcript", [])
          case "run-events": {
            if (options.completedRequest && selector.runId === "vibe-e2e") return rows("run-events", [])
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
        return route.fulfill(json({ ok: false, error: { message: `no ${call.procedure}` } }))
    }
  })
  return { rpc }
}

const send = async (page: Page, text: string): Promise<void> => {
  await expect(page.locator(".app-shell")).toBeVisible()
  if (!await page.getByTestId("composer-input").isVisible()) await page.keyboard.press("Control+k")
  await page.getByTestId("composer-input").fill(text)
  await page.getByTestId("composer-input").press("Enter")
  await expect(page.getByTestId("composer-input")).toHaveValue("")
  await expect(page.getByTestId("composer-input")).toBeHidden()
}

/** Exercise workspace flows after the introduction, using its existing command. */
const finishGuide = async (page: Page): Promise<void> => {
  await expect(page.getByTestId("first-run-actions")).toBeVisible()
  await page.getByRole("button", { name: "Dismiss", exact: true }).click()
}

test.beforeEach(async ({ page }) => {
  // A persisted store from an earlier test must not carry state across tests.
  await page.addInitScript(() => {
    try {
      if (!window.sessionStorage.getItem("runs-spec-initialized")) {
        window.localStorage.clear()
        window.sessionStorage.setItem("runs-spec-initialized", "yes")
      }
    } catch {
      // Storage the browser refuses is the empty store already.
    }
  })
})

test("T1: approval counts settle with receipts and decided questions survive reload", async ({ page }) => {
  const gate = (requestId: string, title: string) => ({
    runId: RUN_ID, requestId, title, requestedAt: Date.now(), status: "pending",
    request: {}, payload: { target: { _tag: "Node", runId: RUN_ID, requestId,
      digest: "sha256:test", envelope: { capabilities: [], flows: [], budget: {} } },
      scope: "run", idempotencyKey: `approve:${requestId}` }
  })
  let release!: (accepted: boolean) => void
  const held = new Promise<boolean>(resolve => { release = resolve })
  let submissions = 0
  const prompt = "Which service owns retries?"
  const { rpc } = await serve(page, [], {
    approvals: [gate("grant", "Run the deploy script?"),
      { ...gate("question", "Human input"), waitRunId: "wait-1", request: { kind: "ask", prompt } }],
    submitApproval: async () => ++submissions === 1 ? held : true,
  })
  try {
    await page.goto(`/${REPO}`)
    await finishGuide(page)
    await send(page, `/approvals.list ${REPO}`)
    const card = page.locator('[data-kind="approvals-inbox"]')
    const count = card.getByTestId("approvals-inbox-count")
    const grant = card.locator('[data-slot="confirmation"]').filter({ hasText: "Run the deploy script?" })
    await expect(count).toHaveText("1 approval pending · 1 question pending")
    await grant.getByRole("button", { name: "Approve", exact: true }).focus()
    await page.keyboard.press("Enter")
    await expect.poll(() => submissions).toBe(1)
    await expect(count).toHaveText("1 approval pending · 1 question pending")
    await page.keyboard.press("Control+k")
    await expect(page.getByTestId("composer-input")).toBeFocused()
    await page.keyboard.press("Escape")
    release(false)
    await expect(card.getByRole("alert")).toContainText("Smithers could not record this decision. Not your fault.")
    await expect(count).toHaveText("1 approval pending · 1 question pending")
    await grant.getByRole("button", { name: "Deny", exact: true }).click()
    await expect(count).toHaveText("1 question pending")
    await expect(grant).toContainText("Denied")
    await card.getByRole("textbox", { name: prompt, exact: true }).fill("The scheduler")
    await card.getByTestId("approval-answer-send").focus()
    await page.keyboard.press("Enter")
    await expect(count).toHaveText("0 approvals pending")
    await expect(card.locator('.sui-approval-question').filter({ hasText: prompt })).toBeVisible()
    expect(rpc.filter(call => call.procedure === "Approval.Submit").at(-1)?.payload.answer).toBe("The scheduler")
    await page.reload()
    await expect(count).toHaveText("0 approvals pending")
    await expect(card).toContainText("Run the deploy script?")
    await expect(card).toContainText(prompt)
    await expect(card.getByRole("textbox")).toHaveCount(0)
    await expect(card.getByRole("button", { name: "Approve", exact: true })).toHaveCount(0)
    await card.screenshot({ path: test.info().outputPath("approvals-settled.png") })
  } finally { release(false) }
})

test("T1: launch a fixture flow, steer it, stop it, and see it in the run inbox", async ({ page }) => {
  const { rpc } = await serve(page)
  await page.goto("/")
  await finishGuide(page)

  // Launch: /flow.run provisions the workspace, plans, and runs — the card tracks the run.
  await send(page, `/flow.run review-pr ${REPO}`)
  const card = page.locator(`[data-kind="run-trace"][data-run-id="${RUN_ID}"]`)
  await expect(card).toBeVisible({ timeout: 15_000 })
  await expect(card).toContainText("Running")
  expect(rpc.map((call) => call.procedure)).toContain("Run")

  // Steer: the row's message rides the Steer procedure with the steer envelope.
  await card.getByTestId(`flow-run-steer-input-${RUN_ID}`).fill("use the smaller diff")
  await card.getByRole("button", { name: "Steer" }).click()
  await expect.poll(() => rpc.some((call) => call.procedure === "Steer")).toBe(true)
  const steer = rpc.find((call) => call.procedure === "Steer")!
  expect(steer.payload.runId).toBe(RUN_ID)
  expect(steer.payload.message).toMatchObject({ kind: "Message", body: "use the smaller diff", runId: RUN_ID })
  await expect(card).toContainText("steering pending")

  // The run inbox: /runs.list renders the workspace's runs, this one among them.
  await send(page, `/runs.list ${REPO}`)
  const runListCardId = `run-list-${REPO}-${FIXTURE_BOX}`
  const inbox = page.getByTestId(`card-${runListCardId}`)
  await expect(inbox).toBeVisible()
  await expect(inbox).toContainText(RUN_ID)
  await expect(inbox).toContainText("review-pr")
  expect(rpc.some((call) =>
    call.procedure === "Projection.Snapshot" &&
    JSON.stringify(call.payload).includes("workspace-runs")
  )).toBe(true)

  // Stop through the shared worker toast; the worker receipt settles its status.
  const notice = page.locator(".toast").filter({ has: page.locator(".toast-title", { hasText: "review-pr" }) }).first()
  await notice.getByRole("button", { name: "Stop", exact: true }).focus()
  await page.keyboard.press("Enter")
  await expect.poll(() => rpc.some((call) => call.procedure === "Cancel")).toBe(true)
  const cancel = rpc.find((call) => call.procedure === "Cancel")!
  expect(cancel.payload.runId).toBe(RUN_ID)
  await expect(card.getByTestId(`run-outcome-${RUN_ID}`)).toHaveAttribute("data-phase", "cancelled")
  await expect(card.locator(".smithers-card-header")).toContainText("Stopped")
  await expect(card).not.toContainText("steering pending")
  await expect(notice).toHaveAttribute("data-toast-status", "cancelled")
  await expect(notice).toHaveAttribute("role", "status")
  await expect(notice.locator(".toast-detail")).toHaveText("Cancelled")
  await expect(notice.locator(".toast-title")).not.toContainText("completed")
  await page.screenshot({ path: test.info().outputPath("cancelled-run.png") })
})


/** Reach a native control through the keyboard order; never move focus with a pointer or DOM mutation. */
const tabTo = async (page: Page, target: Locator): Promise<void> => {
  for (let step = 0; step < 100; step++) {
    if (await target.evaluate((element) => element === document.activeElement)) return
    await page.keyboard.press(controlTabKey(page))
  }
  throw new Error("The coding control was not reachable with Tab")
}

test("T1: early review feedback opens durable debugger detail through the keyboard", async ({ page }, testInfo) => {
  test.setTimeout(120_000)
  // Synthetic producer-shaped evidence; the browser exercises the actual
  // controller, persisted selection and existing frame presentation.
  await serve(page, JSON.parse(JSON.stringify(earlyCodingJournal()).replaceAll("run-1", RUN_ID)))
  await page.goto("/")
  await finishGuide(page)
  await page.keyboard.press("Control+k")
  await expect(page.getByTestId("composer-input")).toBeFocused()
  await page.keyboard.insertText(`/flow.run coding ${REPO} ${JSON.stringify({ prompt: CODING_PLAN.prompt })}`)
  await page.keyboard.press("Enter")
  const card = page.locator(`[data-kind="run-trace"][data-run-id="${RUN_ID}"]`)
  const feedback = card.getByLabel("Coding review feedback", { exact: true })
  await expect(feedback).toContainText("Review requested changes. Waiting for the correction result.")
  await expect(feedback).toContainText("Keep the causal revision when merging wiki edits.")
  await expect(card.getByLabel("Coding outcome", { exact: true })).toHaveCount(0)
  const memory = card.locator('[data-goal="memory"]').getByRole("button")
  await tabTo(page, memory)
  await page.keyboard.press("Enter")
  await expect(memory).toHaveAttribute("aria-expanded", "true")
  await page.reload()
  await expect(memory).toHaveAttribute("aria-expanded", "true")
  await expect(card.getByRole("region", { name: "Store repository memory", exact: true })).toBeVisible()
  await tabTo(page, memory)
  await page.keyboard.press("Enter")
  await expect(memory).toHaveAttribute("aria-expanded", "false")
  await page.reload()
  await expect(memory).toHaveAttribute("aria-expanded", "false")
  await expect(card.getByRole("region", { name: "Store repository memory", exact: true })).toHaveCount(0)
  await page.keyboard.press("Control+k")
  await expect(page.getByTestId("composer-input")).toBeFocused()
  await page.keyboard.insertText("/debug.verbose")
  await page.keyboard.press("Enter")
  await expect(page.getByText("Verbose on — showing every flow, including hidden and background ones", { exact: true })).toBeVisible()
  const inspect = feedback.getByRole("button", { name: "Inspect review feedback" })
  await tabTo(page, inspect)
  expect(await inspect.evaluate(element => getComputedStyle(element).outlineStyle)).not.toBe("none")
  await page.keyboard.press("Enter")
  const pane = card.locator("[data-span='engine:observe:0']")
  await expect(pane).toContainText("coding/EarlyFeedback")
  const notice = pane.getByTestId("run-trace-failure")
  await expect(notice.locator(":scope > p")).toHaveText("This call failed. Not your fault.")
  const disclosure = notice.locator("details > summary")
  await tabTo(page, disclosure)
  await page.keyboard.press("Enter")
  await expect(notice.locator("details")).toHaveAttribute("open", "")
  const failure = notice.locator("details pre")
  await tabTo(page, failure)
  expect(await failure.evaluate(element => getComputedStyle(element).outlineStyle)).not.toBe("none")
  const initialScroll = await failure.evaluate(element => element.scrollTop)
  await page.keyboard.press("PageDown")
  await expect.poll(() => failure.evaluate(element => element.scrollTop)).toBeGreaterThan(initialScroll)
  await expect(page.getByText(/You ran \/runs\.trace\.select sourceCard=\S+ run-e2e engine:observe:0 .*→ executed/)).toBeVisible()
  await page.reload()
  await expect(pane).toContainText("coding/EarlyFeedback")
  await expect(feedback).toContainText("Waiting for the correction result.")
  await page.keyboard.press("Control+k")
  await expect(page.getByTestId("composer-input")).toBeFocused()
  const node = await card.getByRole("region", { name: "Coding plan" }).elementHandle()
  await tabTo(page, card.getByRole("button", { name: "Maximize card", exact: true }))
  await page.keyboard.press("Enter")
  await expect(card).toHaveAttribute("data-maximized", "true")
  expect(await card.getByRole("region", { name: "Coding plan" }).evaluate((element, original) => element === original, node)).toBe(true)
  await expect(page.getByTestId("composer-input")).toBeVisible()
  await expect(card).toHaveCSS("opacity", "1")
  await expect(card).toHaveCSS("transform", "none")
  await page.screenshot({ path: testInfo.outputPath("smithers-coding-early-feedback-ui.png"), fullPage: true })
  await testInfo.attach("smithers-coding-early-feedback-ui.png", { path: testInfo.outputPath("smithers-coding-early-feedback-ui.png"), contentType: "image/png" })
})


test("T1: real retained prototype source and feedback remain embedded and keyboard accessible", async ({ page }, testInfo) => {
  test.setTimeout(120_000)
  const records = readFileSync(join(__dirname, "../../src/mainview/cards/fixtures/CodingPocHostDecisions.ndjson"), "utf8").trim().split("\n").map(line => JSON.parse(line))
  const events = JSON.parse(JSON.stringify(records).replaceAll('"run-1"', JSON.stringify(RUN_ID)))
  const { rpc } = await serve(page, events)
  await page.goto("/")
  await finishGuide(page)
  await page.keyboard.press("Control+k")
  await expect(page.getByTestId("composer-input")).toBeFocused()
  await page.keyboard.insertText(`/flow.run coding ${REPO} ${JSON.stringify({ prompt: "Add a greeting" })}`)
  await page.keyboard.press("Enter")
  const card = page.locator(`[data-kind="run-trace"][data-run-id="${RUN_ID}"]`)
  const poc = card.getByRole("region", { name: "Disposable prototype", exact: true })
  await expect(poc).toContainText("Drafted and discarded. No build or tests ran.")
  const preview = poc.getByText("Retained source preview", { exact: true })
  await tabTo(page, preview)
  await page.keyboard.press("Enter")
  await expect(poc.getByRole("region", { name: "hello.txt", exact: true })).toContainText("prototype greeting")
  await expect(poc.locator("iframe, script, img")).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath("smithers-coding-poc-source-ui.png"), fullPage: true })
  await testInfo.attach("smithers-coding-poc-source-ui.png", { path: testInfo.outputPath("smithers-coding-poc-source-ui.png"), contentType: "image/png" })
  const feedback = poc.getByRole("button", { name: "Give prototype feedback", exact: true })
  await tabTo(page, feedback)
  await page.keyboard.press("Enter")
  const form = page.locator('.flow-form[data-flow-name="runs.steer"]')
  const body = form.getByTestId("flow-form-body")
  await expect(body).toBeVisible()
  await expect(form).toHaveAttribute("data-via", "user")
  await tabTo(page, body)
  await page.keyboard.insertText("Keep the greeting small; use the expected real text.")
  await page.keyboard.press(controlTabKey(page))
  const submit = form.getByTestId("flow-form-submit")
  await expect(submit).toBeEnabled()
  await tabTo(page, submit)
  await page.keyboard.press("Enter")
  await expect.poll(() => rpc.find(call => call.procedure === "Steer")?.payload).toMatchObject({
    runId: RUN_ID, message: { kind: "Message", body: "Keep the greeting small; use the expected real text.", runId: RUN_ID }
  })
  await expect(card).toContainText("steering pending")
  await expect(card).not.toContainText("Validated after")
  await page.keyboard.press("Escape")
  await page.reload()
  await expect(poc).toContainText("Drafted and discarded. No build or tests ran.")
  await expect(card).toHaveAttribute("data-maximized", "false")
})

test("T1: bounded long prototype values keep the summary compact and source keyboard-scrollable", async ({ page }, testInfo) => {
  test.setTimeout(120_000)
  // Synthetic display bounds around the real producer envelope; this test
  // makes no claim that these deliberately long values were a native POC.
  const records = readFileSync(join(__dirname, "../../src/mainview/cards/fixtures/CodingPocHostDecisions.ndjson"), "utf8").trim().split("\n").map(line => JSON.parse(line))
  const events = JSON.parse(JSON.stringify(records).replaceAll('"run-1"', JSON.stringify(RUN_ID)))
  const result = events.find((row: { sequence: number }) => row.sequence === 263).payload.payload.state.result.exit.value
  result.findings = ["Unvalidated hypothesis. ".repeat(600)]
  result.feedback = "Long next-plan feedback. ".repeat(1000)
  result.changes.files[0].after = "Long retained source line.\n".repeat(2000)
  await serve(page, events)
  await page.goto("/")
  await finishGuide(page)
  await page.keyboard.press("Control+k")
  await expect(page.getByTestId("composer-input")).toBeFocused()
  await page.keyboard.insertText(`/flow.run coding ${REPO} ${JSON.stringify({ prompt: "Inspect source bounds" })}`)
  await page.keyboard.press("Enter")
  const poc = page.getByRole("region", { name: "Disposable prototype", exact: true })
  await expect(poc).toBeVisible()
  expect((await poc.boundingBox())!.height).toBeLessThan(350)
  expect(await poc.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
  const preview = poc.getByText("Retained source preview", { exact: true })
  await tabTo(page, preview)
  await page.keyboard.press("Enter")
  const source = poc.getByRole("region", { name: "hello.txt", exact: true }).locator("pre").last()
  await tabTo(page, source)
  expect((await source.boundingBox())!.height).toBeLessThanOrEqual(162)
  await page.keyboard.press("PageDown")
  await expect.poll(() => source.evaluate(node => node.scrollTop)).toBeGreaterThan(0)
  await page.screenshot({ path: testInfo.outputPath("smithers-coding-poc-long-source-ui.png"), fullPage: true })
  await testInfo.attach("smithers-coding-poc-long-source-ui.png", { path: testInfo.outputPath("smithers-coding-poc-long-source-ui.png"), contentType: "image/png" })
})

test("health: gateway observations distinguish working, idle and input, then expire offline without changing execution", async ({ page }) => {
  const now = Date.now()
  let status: StatusRollup = { subjectId: `run:${RUN_ID}`, state: "running", activity: "working", health: "healthy", attention: "none",
    freshness: "fresh", updatedAt: now, provenance: { checkerId: "fixture.semantic", monitorId: "host", observedAt: now,
      expiresAt: now + 120_000, evidenceSeq: 1, incarnation: "opaque-owner", version: 1 } }
  const { rpc } = await serve(page, [], { health: () => status })
  await page.clock.install({ time: new Date(now) })
  await page.goto("/")
  await prepareHealthPage(page)
  await sendHealthCommand(page, `/flow.run review-pr ${REPO}`)
  const card = page.locator(`[data-kind="run-trace"][data-run-id="${RUN_ID}"]`)
  const details = card.getByTestId("status-details")
  await expect(details).toHaveText("Running · Working")
  const authorityCallsAtLaunch = rpc.filter((call) => call.procedure === "Approval.Submit" || call.procedure === "Resume").length
  status = { ...status, activity: "idle", provenance: { ...status.provenance!, version: 2 } }
  await expect(details).toHaveText("Running · Idle", { timeout: 10_000 })
  status = { ...status, activity: "needs-input", attention: "needs-input", provenance: { ...status.provenance!, version: 3 } }
  await expect(details).toHaveText("Running · Needs input", { timeout: 10_000 })
  const steer = card.getByTestId(`flow-run-steer-input-${RUN_ID}`)
  await steer.fill("Continue with the smaller change")
  await steer.press(controlTabKey(page))
  await expect(card.getByRole("button", { name: "Steer" })).toBeFocused()
  await page.keyboard.press("Enter")
  await expect.poll(() => rpc.some((call) => call.procedure === "Steer")).toBe(true)
  await page.route("**/api/workflow/rpc", (route) => route.abort())
  await page.clock.fastForward(120_001)
  await expect(details).toHaveText("Running · Stale")
  await expect(details).toHaveAttribute("data-health", "unknown")
  await expect(card).not.toContainText("Completed.")
  expect(rpc.some((call) => /Health|Status/.test(call.procedure))).toBe(false)
  expect(rpc.filter((call) => call.procedure === "Approval.Submit" || call.procedure === "Resume")).toHaveLength(authorityCallsAtLaunch)
})
