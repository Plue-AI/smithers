import { CODING_POC_HOST_EVENTS, CODING_POC_RESULT, codingPocJournal } from "./fixtures/CodingPoc"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import type { Card } from "../state/AppState"
import { createAppStore } from "../state/AppStore"
import { memoryStorage } from "../state/TestFixtures"
import { phasePins, PROTOTYPE_BANNER, RunTraceBody, traceOf } from "./RunTraceCard"
import { WorkflowRunCardBody } from "./WorkflowCards"
import { CODING_PLAN } from "./fixtures/CodingPlan"
import { completedRequestCard, vibeCatalog, CODING_REQUEST_ID, publicationVibeCard } from "./fixtures/CodingVibe"
import { blockedCodingJournal, earlyCodingJournal, preparedCodingJournal } from "./fixtures/CodingJournal"
import { traceFromJournal, turnNarratives } from "./RunTrace"

/*
 * The run trace (factory spec 06, mocks #s5 and #s6): one card shows every
 * run as a trace. A run of kind prototype wears the never-promoted banner,
 * offers `all | messages | failed` and no Steer row; every other run has the
 * shared filters and the steer row while live. The tree nests the journal,
 * the waterfall has one bar per span, the selected span fills the pane with
 * what the journal recorded, and a run with no journal yet is the root alone
 * with the run's status. Filter, selection and cursor are read off the card
 * payload (§5) and every chip, row and bar dispatches a registered hidden
 * flow (§6); the component holds no state of its own.
 */

GlobalRegistrator.register()
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const mounted: Array<{ root: Root; host: HTMLElement }> = []
afterEach(async () => {
  for (const { root, host } of mounted.splice(0)) {
    await act(async () => root.unmount())
    host.remove()
  }
})

afterAll(async () => {
  for (let tick = 0; tick < 3; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT
  await GlobalRegistrator.unregister()
})

const stamp = (sequence: number, kind: string, payload: Record<string, unknown>, at: number) => ({
  sequence,
  kind,
  occurredAt: at,
  payload: { ...payload, at }
})

const JOURNAL = [
  stamp(1, "control.agent.turn-opened", { seat: "openai:gpt-5.6-sol" }, 1000),
  stamp(2, "control.agent.cell-produced", { language: "ts", text: "const fps = await ctx.call(\"target.run\", { label: \"//apps/app:e2e-smoke\" })" }, 1200),
  stamp(3, "control.agent.cell-call-started", { flowName: "target.run", input: { label: "//apps/app:e2e-smoke" } }, 1300),
  stamp(4, "control.agent.cell-call-settled", { flowName: "target.run", outcome: "failure", message: "12 fps at 500 nodes" }, 4300),
  stamp(5, "control.agent.cell-printed", { cell: "c", text: "svg dies at 500 nodes" }, 4400),
  stamp(6, "control.agent.cell-settled", { outcome: "success" }, 4400),
  stamp(7, "control.agent.turn-opened", { seat: "openai:gpt-5.6-sol" }, 5000),
  stamp(8, "control.agent.cell-call-started", { flowName: "agent/send", input: { to: "w6", text: "not rewriting" } }, 5100)
]

const runCard = (
  overrides: Partial<Extract<Card, { kind: "run-trace" }>["payload"]>
): Extract<Card, { kind: "run-trace" }> => ({
  id: "flow-run-run-1",
  kind: "run-trace",
  title: "prototype · graph view of the wiki",
  status: "active",
  createdAt: 0,
  ordinal: 0,
  payload: {
    repo: "smithersai/smithers",
    runId: "run-1",
    workflow: "prototype",
    phase: "running",
    steps: [],
    result: null,
    lastSeq: 1,
    traceView: "timeline",
    ...overrides
  }
})

const noop = (): void => {}

const render = (element: React.ReactElement): HTMLElement => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  mounted.push({ root, host })
  act(() => {
    root.render(element)
  })
  return host
}

const renderRun = (overrides: Partial<Extract<Card, { kind: "run-trace" }>["payload"]>) => {
  const dispatched: Array<{ name: string; args?: string }> = []
  const host = render(
    <WorkflowRunCardBody
      card={runCard(overrides)}
      onStopRun={noop}
      onRetryRun={noop}
      onRunCommand={(name, args) => dispatched.push({ name, args })}
    />
  )
  return { host, dispatched }
}

const renderTrace = (overrides: Partial<Extract<Card, { kind: "run-trace" }>["payload"]>) => {
  const dispatched: Array<{ name: string; args?: string }> = []
  const host = render(<RunTraceBody card={runCard(overrides)} onRunCommand={(name, args) => dispatched.push({ name, args })} />)
  return { host, dispatched }
}

/* One of the sentences flows/repository/triggers.ts refuses a registration with, and the verdict line that clips it. */
const REFUSAL = 'Add a model to "nightly-lint" to schedule it.'
const VERDICT = `failed — invalid_receipt: ${REFUSAL.slice(0, 20)}`
const failedJournal = (cause: string) =>
  [{ sequence: 1, kind: "control.run.failed", runId: "run-1", occurredAt: 1, payload: { runId: "run-1", status: "failed", cause } }]
/* The run's failure notice (FailureNotice): its sentence <p>, its fault, and the raw text inside its collapsed Details. */
const notice = (host: HTMLElement): Element => host.querySelector(".run-failure[data-fault]")!
const refusal = (host: HTMLElement): Element => notice(host).querySelector(":scope > p")!
const faultOf = (host: HTMLElement): string | null => notice(host).getAttribute("data-fault")
const technical = (host: HTMLElement): string | undefined =>
  notice(host).querySelector("details")?.querySelector("pre")?.textContent ?? undefined

const chips = (host: HTMLElement): Array<string | null> =>
  [...host.querySelectorAll("[data-filter]")].map((chip) => chip.getAttribute("data-filter"))

const click = (element: Element | null): void => {
  act(() => {
    ;(element as HTMLElement).click()
  })
}

describe("the run card as a trace", () => {
  test("a failed run uses typed infra copy and keeps raw errors inside a closed disclosure", () => {
    const raw = "failed — Error: Error: git exited 1"
    const { host } = renderRun({ phase: "failed", error: raw })
    const alert = host.querySelector('.run-failure[role="alert"]')!
    expect(refusal(host).textContent).toContain("Not your fault")
    expect(refusal(host).textContent).not.toContain(raw)
    expect(alert.getAttribute("data-fault")).toBe("infra")
    const detail = alert.querySelector("details")!
    expect(detail.querySelector("summary")?.textContent).toBe("Details")
    expect(detail.open).toBe(false)
    expect(detail.querySelector("pre")?.textContent).toBe(raw)
  })
  test("the registrar's refusal leads with its own sentence; another flow's invalid_receipt keeps the infra headline", () => {
    const cause = `invalid_receipt: ${REFUSAL}\n    at repository/trigger (flows/repository/triggers.ts:20)`
    const refused = renderRun({ workflow: "repository/trigger", phase: "failed", error: VERDICT, events: failedJournal(cause) })
    expect(refusal(refused.host).textContent).toBe(REFUSAL)
    expect(refusal(refused.host).textContent).not.toContain("Not your fault")
    expect(faultOf(refused.host)).toBe("user")
    expect(technical(refused.host)).toBe(`invalid_receipt: ${REFUSAL}`)

    const engine = renderRun({ workflow: "coding/request", phase: "failed", error: VERDICT,
      events: failedJournal("invalid_receipt: Native source creation returned an invalid receipt") })
    expect(refusal(engine.host).textContent).toContain("Not your fault")
    expect(faultOf(engine.host)).toBe("infra")
    expect(technical(engine.host)).toBe(VERDICT)
  })
  test("a setup refusal the person must answer leads with the host's sentence; the bridge's own invalid_receipt does not", () => {
    /* .artifacts/mvp-canary-walk-20260917/B-18-state-trial-terminal.json: `Create test issue` before the evals passed. */
    const trial = "Run evals for this exact candidate before continuing"
    const setupVerdict = `failed — invalid_receipt: ${trial}`
    const refused = renderRun({ workflow: "repository/setup", phase: "failed", error: setupVerdict,
      events: failedJournal(`invalid_receipt: ${trial}\n    at repository/Setup (flows/repository/receipts.ts:109)`) })
    expect(refusal(refused.host).textContent).toBe(trial)
    expect(refusal(refused.host).textContent).not.toContain("invalid_receipt")
    expect(faultOf(refused.host)).toBe("user")
    expect(technical(refused.host)).toBe(`invalid_receipt: ${trial}`)

    const bridge = renderRun({ workflow: "repository/setup", phase: "failed", error: setupVerdict,
      events: failedJournal("invalid_receipt: Setup output failed the shared response contract") })
    expect(refusal(bridge.host).textContent).toContain("Not your fault")
    expect(faultOf(bridge.host)).toBe("infra")
    expect(technical(bridge.host)).toBe(setupVerdict)
  })
  test("a refusal written to the stream before this change replays, and the reopened card still leads with it", async () => {
    const card = runCard({ workflow: "repository/trigger" })
    const scope = { repo: card.payload.repo, runId: card.payload.runId }
    const observation = { scope,
      summary: { runId: scope.runId, flowId: "repository/trigger", status: "failed" as const, createdAt: 1, updatedAt: 10,
        turns: 1, calls: 1, callsFailed: 1, editsAttempted: 0, editsSucceeded: 0, inputTokens: 0, outputTokens: 0,
        verdict: VERDICT, diagnosis: VERDICT },
      journal: { mode: "full" as const, events: failedJournal(`invalid_receipt: ${REFUSAL}\n    at repository/trigger`) } }
    const storage = memoryStorage()
    const written = await createAppStore({ kind: "localStorage", storage })
    await written.dispatch({ type: "card.upsert", actor: "system", card }).isPersisted.promise
    await written.dispatch({ type: "gateway.run.observed", actor: "system", observation }).isPersisted.promise
    /* A maximized frame hashes the projected cards, so the projected error must stay the verdict byte for byte. */
    await written.dispatch({ type: "card.maximized", actor: "user", id: card.id }).isPersisted.promise
    expect((written.collections.cards.get(card.id) as typeof card).payload.error).toBe(VERDICT)
    await written.verifyState()
    await written.dispose?.()

    const reopened = await createAppStore({ kind: "localStorage", storage })
    await reopened.verifyState()
    const restored = reopened.collections.cards.get(card.id) as typeof card
    expect(restored.payload.error).toBe(VERDICT)
    const { host } = renderRun(restored.payload)
    expect(faultOf(host)).toBe("user")
    expect(refusal(host).textContent).toBe(REFUSAL)
    await reopened.dispose?.()
  })
  test("a repository job's result reads in the same fold a setup run uses, and prose still renders as prose", () => {
    const fold = (host: HTMLElement) =>
      [...host.querySelectorAll("details")].find(node => node.querySelector("summary")?.textContent === "Technical details")
    const output = JSON.stringify({ job: "issues", reply: { body: "Research issue\nThe greeting is hello.", issueNumber: 42, state: "drafted" } })
    const job = renderRun({ phase: "completed", workflow: "repository-jobs/issues", result: output })
    expect(fold(job.host)?.querySelector("pre")?.textContent).toBe(output)
    expect(job.host.querySelector(".run-result")).toBeNull()
    const setup = renderRun({ phase: "completed", workflow: "repository/setup", result: "Applied revision 2." })
    expect(fold(setup.host)?.querySelector("pre")?.textContent).toBe("Applied revision 2.")
    const coding = renderRun({ phase: "completed", workflow: "coding", result: "Finished the implementation." })
    expect(coding.host.querySelector(".run-result")?.textContent).toContain("Finished the implementation.")
  })

  test("an observation refusal keeps the completed verdict and offers the existing keyboard-reachable retry", () => {
    const retried: Array<string> = []
    const host = render(<WorkflowRunCardBody
      card={runCard({ phase: "completed", result: "Finished the implementation.", observationError: "Engine evidence could not be read." })}
      onStopRun={noop} onRetryRun={(id) => retried.push(id)} onRunCommand={noop}
    />)
    expect(host.textContent).toContain("Finished the implementation.")
    const observed = host.querySelector("[data-failure='run.observe.completed']")!
    expect(observed.querySelector(":scope > p")?.textContent).toBe("This run finished, but Smithers could not read all of its record. Not your fault.")
    expect(observed.querySelector("details pre")?.textContent).toBe("Engine evidence could not be read.")
    const retry = host.querySelector("[data-flow='flow.run.retry']") as HTMLButtonElement
    retry.focus()
    expect(document.activeElement).toBe(retry)
    click(retry)
    expect(retried).toEqual(["flow-run-run-1"])
  })
  test("native work uses the same keyboard-focusable selection and reveals results only at their recorded cursor", () => {
    const native = (sequence: number, terminal: boolean) => ({
      sequence, kind: "control.engine.event", occurredAt: 1000 + sequence,
      payload: {
        version: 1, executionId: "native", generation: 0, sequence, eventId: `native/${sequence}`,
        sourceId: "engine", sourceSequence: sequence, emittedAtMs: sequence + 100,
        eventType: "flows.engine.run-decision", meta: { lineageId: "native" },
        payload: {
          decision: terminal ? "transitioned" : "created", ...(terminal ? { status: "completed" } : {}),
          state: { version: 1, flowName: "coding/ImplementPlan", payload: {}, ...(terminal ? {
            result: { _tag: "Complete", exit: { _tag: "Success", value: { checks: ["typecheck"] } } }
          } : {}) }
        }
      }
    })
    const events = [native(1, false), native(2, true)]
    const compact = renderTrace({ events, traceView: "turns", phase: "completed" })
    const row = compact.host.querySelector("[data-engine-span]") as HTMLButtonElement
    expect(row.tagName).toBe("BUTTON")
    row.focus()
    expect(document.activeElement).toBe(row)
    expect(row.textContent).toContain("coding/ImplementPlan · completed")
    expect(compact.host.querySelector("[data-testid='run-trace-pane-run-1']")).toBeNull()
    click(row)
    expect(compact.dispatched).toEqual([{ name: "runs.trace.select", args: "sourceCard=flow-run-run-1 run-1 engine:native:0" }])
    const before = renderTrace({ events, traceView: "turns", selection: "engine:native:0", cursorSeq: 1, liveTail: false })
    expect(before.host.querySelector("[data-testid='run-trace-pane-run-1']")?.textContent).not.toContain("typecheck")
    const after = renderTrace({ events, traceView: "turns", selection: "engine:native:0", cursorSeq: 2, liveTail: false })
    expect(after.host.querySelector("[data-testid='run-trace-pane-run-1']")?.textContent).toContain('"checks":["typecheck"]')
    expect(after.host.querySelector("[aria-label='Recorded call path']")).toBeNull()
    expect(after.host.querySelector("[data-flow='runs.open']")).toBeNull()
  })
  test("the default view is a cheap turn list and expands recorded detail only after a persisted selection", () => {
    const { host, dispatched } = renderTrace({ events: JOURNAL, traceView: undefined })
    expect(host.querySelector("[aria-label='What each frame did']")?.textContent).toContain("target.run")
    expect(host.querySelector("[aria-label='Call tree']")).toBeNull()
    expect(host.querySelector("[data-testid='run-trace-pane-run-1']")).toBeNull()
    click(host.querySelector("[data-frame-line='frame-1']"))
    expect(dispatched).toEqual([{ name: "runs.trace.select", args: "sourceCard=flow-run-run-1 run-1 frame-1" }])
    expect(host.querySelector("[aria-label='Call tree']")).toBeNull()

    const selected = renderTrace({ events: JOURNAL, traceView: "turns", selection: "call-1", liveTail: false, cursorSeq: 8 })
    expect([...selected.host.querySelectorAll("[data-evidence-span]")].map((row) => row.getAttribute("data-evidence-span"))).toEqual(["cell-2", "call-1"])
    expect(selected.host.querySelector("[aria-label='Recorded call path']")).toBeNull()
    const callFailure = selected.host.querySelector("[data-testid='run-trace-failure']")!
    expect(callFailure.getAttribute("role")).toBe("alert")
    expect(callFailure.getAttribute("data-failure")).toBe("run.trace.call")
    expect(callFailure.getAttribute("data-fault")).toBe("factory")
    expect(callFailure.querySelector(":scope > p")?.textContent).toBe("This call failed. Not your fault.")
    expect((callFailure.querySelector("details") as HTMLDetailsElement).open).toBe(false)
    expect(callFailure.querySelector("details pre")?.textContent).toBe("12 fps at 500 nodes")
    click(selected.host.querySelector("[data-flow='runs.trace.live']"))
    expect(selected.dispatched).toEqual([{ name: "runs.trace.live", args: "sourceCard=flow-run-run-1 run-1" }])
    expect(selected.host.textContent).toContain("At #8")
  })

  test("a spawned child run is a subagent card once its spawn was recorded, and opens as its run card", () => {
    const events = [
      stamp(1, "control.agent.turn-opened", {}, 1),
      stamp(2, "control.agent.cell-call-started", { flowName: "agent/spawn", input: { flow: "review" } }, 2),
      stamp(3, "control.agent.cell-call-settled", { flowName: "agent/spawn", outcome: "success", value: { child: "run-1/child/review" } }, 3)
    ]
    const before = renderRun({ events, traceView: "turns", selection: "call-1", cursorSeq: 2, liveTail: false })
    expect(before.host.querySelector("[data-flow='runs.open']")).toBeNull()
    expect(before.host.querySelector(".subagent-card")).toBeNull()
    expect(before.host.textContent).not.toContain("Inspect child run")
    const after = renderRun({ events, traceView: "turns", selection: "call-1", cursorSeq: 3, liveTail: false })
    const child = after.host.querySelector<HTMLElement>(".subagent-card")!
    expect(child.querySelector(".subagent-title")?.textContent).toMatch(/^[◐◓◑◒] review$/)
    expect(after.host.querySelector(".subagent-header")?.textContent).toContain("Running 1 subagent")
    // Unobserved, the child has no stop door of its own yet.
    expect(child.querySelector(".subagent-stop")).toBeNull()
    click(child)
    expect(after.dispatched).toEqual([{ name: "runs.open", args: "sourceCard=flow-run-run-1 run-1/child/review smithersai/smithers" }])
  })
  test("a run of kind prototype wears the never-promoted banner, offers all | messages | failed, and has no Steer row", () => {
    const { host } = renderRun({ kind: "prototype", events: JOURNAL })
    expect(host.querySelector("[data-testid='run-trace-run-1']")).not.toBeNull()
    expect(host.querySelector("[data-testid='run-trace-banner-run-1']")?.textContent).toContain(PROTOTYPE_BANNER)
    expect(host.querySelector("[data-testid='run-trace-banner-run-1']")?.textContent).toContain("kind: prototype · never promoted")
    expect(chips(host)).toEqual(["all", "messages", "failed"])
    // Spec 06 §3: no Steer for a prototype; the run's other acts stay.
    expect(host.querySelector("[data-testid='flow-run-steer-run-1']")).toBeNull()
    expect(host.querySelector("[data-testid='flow-run-stop-run-1']")).not.toBeNull()
    expect(host.querySelector(".flow-run-card")?.getAttribute("data-run-kind")).toBe("prototype")
    // The secondary tabs stay; there is no Trace tab because the trace is the body.
    expect([...host.querySelectorAll("[role='tablist'] button")].map((tab) => tab.textContent)).toEqual(["Trace", "Transcript"])
  })

  test("every other run is the same trace with the shared filters and the steer row while live; an implement run needs no banner", () => {
    const { host } = renderRun({ workflow: "review", steps: ["1 turn · 2 calls"], events: JOURNAL })
    expect(host.querySelector("[data-testid='run-trace-run-1']")).not.toBeNull()
    expect(host.textContent).toContain("2 turns · 2 calls")
    expect(chips(host)).toEqual(["all", "running", "failed", "model", "flow", "forks"])
    expect(host.querySelector("[data-testid='flow-run-steer-run-1']")).not.toBeNull()
    expect(host.querySelector("[data-testid='run-trace-banner-run-1']")).toBeNull()

    const implement = renderRun({ workflow: "implement", kind: "implement", events: JOURNAL })
    expect(implement.host.querySelector("[data-testid='run-trace-run-1']")).not.toBeNull()
    expect(implement.host.querySelector("[data-testid='run-trace-banner-run-1']")).toBeNull()
    expect(implement.host.querySelector("[data-testid='flow-run-steer-run-1']")).not.toBeNull()
  })

  test("the tree nests the journal, the waterfall has one bar per span, and the payload's selection fills the pane", () => {
    const { host, dispatched } = renderTrace({ kind: "prototype", events: JOURNAL, liveTail: false })
    const nodes = [...host.querySelectorAll("[data-trace-span]")]
    expect(nodes.map((node) => `${node.getAttribute("data-depth")}:${node.getAttribute("data-kind")}:${node.getAttribute("data-status")}`)).toEqual([
      "0:run:running",
      "1:frame:completed",
      "2:cell:completed",
      "3:call:failed",
      "1:frame:running",
      "2:call:running"
    ])
    // One bar per span, none for the run itself; the open call's bar runs to the axis end.
    expect(host.querySelectorAll("[data-trace-bar]")).toHaveLength(5)
    const open = host.querySelector("[data-trace-bar='call-2'] .run-trace-water-bar") as HTMLElement | null
    expect(open?.getAttribute("data-open")).toBe("true")
    expect(open?.style.left).toBe("100%")
    const failed = host.querySelector("[data-trace-bar='call-1'] .run-trace-water-bar") as HTMLElement | null
    // 1300 → 4300 on a 1000 → 5100 axis.
    expect(failed?.style.left).toBe("7.32%")
    expect(failed?.style.width).toBe("73.17%")
    // Spec 06 §7: a bar is a button named by the span summary.
    expect(failed?.tagName).toBe("BUTTON")
    expect(failed?.getAttribute("aria-label")).toBe("target.run · failed · 3.0s")
    expect(host.querySelector("[data-testid='run-trace-clock-run-1']")?.textContent).toBe("5 spans · 2 running · 1 failed · t = 4.1s")

    // With live tail off and nothing selected, the run itself is selected: the pane names it and its kind.
    const pane = () => host.querySelector("[data-testid='run-trace-pane-run-1']")
    expect(pane()?.getAttribute("data-span")).toBe("run:run-1")
    expect(pane()?.textContent).toContain(`${"kind".padEnd(12)}prototype`)

    // A row click and a bar click both dispatch runs.trace.select; nothing changes until the payload does.
    click(host.querySelector("[data-trace-span='call-1']"))
    click(failed)
    expect(dispatched).toEqual([
      { name: "runs.trace.select", args: "sourceCard=flow-run-run-1 run-1 call-1" },
      { name: "runs.trace.select", args: "sourceCard=flow-run-run-1 run-1 call-1" }
    ])
    expect(pane()?.getAttribute("data-span")).toBe("run:run-1")

    const selectedCall = renderTrace({ kind: "prototype", events: JOURNAL, selection: "call-1" })
    const callPane = selectedCall.host.querySelector("[data-testid='run-trace-pane-run-1']")
    expect(callPane?.getAttribute("data-span")).toBe("call-1")
    expect(callPane?.textContent).toContain("call · target.run")
    expect(callPane?.textContent).toContain("//apps/app:e2e-smoke")
    expect(callPane?.querySelector("[role='alert'] > p")?.textContent).toBe("This call failed. Not your fault.")
    expect(callPane?.querySelector("[role='alert'] > p")?.textContent).not.toContain("12 fps")
    expect(callPane?.querySelector("[role='alert'] details pre")?.textContent).toBe("12 fps at 500 nodes")
    expect(callPane?.textContent).toContain("duration3.0s")
    expect(selectedCall.host.querySelector("[data-trace-span='call-1']")?.getAttribute("aria-pressed")).toBe("true")
    expect(selectedCall.host.querySelector("[data-trace-bar='call-1'] .run-trace-water-bar")?.getAttribute("aria-pressed")).toBe("true")

    const selectedCell = renderTrace({ kind: "prototype", events: JOURNAL, selection: "cell-2" })
    const cellPane = selectedCell.host.querySelector("[data-testid='run-trace-pane-run-1']")
    expect(cellPane?.textContent).toContain("Script")
    expect(cellPane?.textContent).toContain("await ctx.call(\"target.run\"")
    expect(cellPane?.textContent).toContain("Printed")
    expect(cellPane?.textContent).toContain("svg dies at 500 nodes")

    const selectedFrame = renderTrace({ kind: "prototype", events: JOURNAL, selection: "frame-1" })
    const framePane = selectedFrame.host.querySelector("[data-testid='run-trace-pane-run-1']")
    expect(framePane?.textContent).toContain("seatopenai:gpt-5.6-sol")
    expect(framePane?.textContent).toContain("control.agent.turn-opened · #1")
  })

  test("live tail selects the newest frame; a selection the fold no longer holds falls back the same way", () => {
    const tailing = renderTrace({ events: JOURNAL })
    expect(tailing.host.querySelector("[data-testid='run-trace-pane-run-1']")?.getAttribute("data-span")).toBe("frame-2")
    const stale = renderTrace({ events: JOURNAL, selection: "call-99" })
    expect(stale.host.querySelector("[data-testid='run-trace-pane-run-1']")?.getAttribute("data-span")).toBe("frame-2")
    const parked = renderTrace({ events: JOURNAL, selection: "call-99", liveTail: false })
    expect(parked.host.querySelector("[data-testid='run-trace-pane-run-1']")?.getAttribute("data-span")).toBe("run:run-1")
  })

  test("the payload's filter keeps the failing call's ancestors and drops the rest; a chip dispatches runs.trace.filter", () => {
    const { host, dispatched } = renderTrace({ events: JOURNAL, filter: "failed" })
    expect([...host.querySelectorAll("[data-trace-span]")].map((node) => node.getAttribute("data-trace-span"))).toEqual([
      "run:run-1",
      "frame-1",
      "cell-2",
      "call-1"
    ])
    expect(host.querySelector("[data-filter='failed']")?.getAttribute("aria-pressed")).toBe("true")
    click(host.querySelector("[data-filter='all']"))
    expect(dispatched).toEqual([{ name: "runs.trace.filter", args: "sourceCard=flow-run-run-1 run-1 all" }])
    // The click is a request, not a change: the rows stay filtered until the payload says otherwise.
    expect(host.querySelectorAll("[data-trace-span]")).toHaveLength(4)
    expect(renderTrace({ events: JOURNAL }).host.querySelectorAll("[data-trace-span]")).toHaveLength(6)
    // A filter the kind does not offer (a prototype has no `model` chip) renders as `all`, never as an invented chip.
    const prototype = renderTrace({ kind: "prototype", events: JOURNAL, filter: "model" })
    expect(prototype.host.querySelector("[data-filter='all']")?.getAttribute("aria-pressed")).toBe("true")
    expect(prototype.host.querySelectorAll("[data-trace-span]")).toHaveLength(6)
  })

  test("the cursor renders the journal up to that seq, so a scrub shows the run as it stood", () => {
    const { host } = renderTrace({ events: JOURNAL, cursorSeq: 4, liveTail: false })
    expect([...host.querySelectorAll("[data-trace-span]")].map((node) => node.getAttribute("data-trace-span"))).toEqual([
      "run:run-1",
      "frame-1",
      "cell-2",
      "call-1"
    ])
    expect(host.querySelector("[data-trace-span='run:run-1']")?.getAttribute("data-status")).toBe("running")
    expect(host.querySelector("[data-testid='run-trace-clock-run-1']")?.textContent).toBe("3 spans · 2 running · 1 failed · t = 3.3s")
  })

  test("no journal yet is the root alone with the run's status, never an invented span", () => {
    const { host } = renderTrace({ kind: "prototype", phase: "launching" })
    const nodes = [...host.querySelectorAll("[data-trace-span]")]
    expect(nodes).toHaveLength(1)
    expect(nodes[0]?.getAttribute("data-status")).toBe("launching")
    expect(host.querySelectorAll("[data-trace-bar]")).toHaveLength(0)
    expect(host.querySelector("[data-testid='run-trace-empty-run-1']")?.textContent).toBe("No spans yet.")
    expect(host.querySelector("[data-testid='run-trace-clock-run-1']")?.textContent).toBe("no journal yet")
  })
})


describe("the run card reads as outcome, then turns", () => {
  const COMPLETED = [
    stamp(1, "control.agent.turn-opened", {}, 1000),
    stamp(2, "control.agent.model-settled", { text: "Write the test first, so the bug shows up as a failure." }, 1400),
    stamp(3, "control.agent.cell-produced", { language: "ts", text: "await ctx.call(\"edit\", { path: \"src/hello.test.ts\" })" }, 1500),
    stamp(4, "control.agent.cell-call-started", { flowName: "edit", input: { path: "src/hello.test.ts" } }, 1600),
    stamp(5, "control.agent.cell-call-settled", { flowName: "edit", outcome: "success", value: "src/hello.test.ts +4" }, 1900),
    stamp(6, "control.agent.cell-call-started", { flowName: "test", input: { target: "npm test" } }, 2000),
    stamp(7, "control.agent.cell-call-settled", { flowName: "test", outcome: "failure", message: "✖ greets the world when no name is given" }, 3600),
    stamp(8, "control.agent.cell-settled", { outcome: "success" }, 3700),
    stamp(9, "control.agent.turn-opened", {}, 4400),
    stamp(10, "control.agent.model-settled", { text: "Edit src/hello.ts: default a missing name to \"world\"." }, 4800),
    stamp(11, "control.agent.cell-call-started", { flowName: "edit", input: { path: "src/hello.ts" } }, 4900),
    stamp(12, "control.agent.cell-call-settled", { flowName: "edit", outcome: "success", value: "src/hello.ts −1 +1" }, 5200),
    stamp(13, "control.agent.resolved", { text: "2 commits on fix" }, 6000)
  ]
  test("a completed run whose reproduction test failed on purpose reads Finished; the failure stays on that call", () => {
    const { host } = renderRun({ phase: "completed", result: "2 commits on fix", steps: ["Writing the test…", "2 commits on fix"], events: COMPLETED, traceView: undefined })
    const outcome = host.querySelector("[data-testid='run-outcome-run-1']")!
    expect(outcome.textContent).toContain("Finished.")
    expect(outcome.textContent).toContain("2 turns · 3 calls · 5.0s")
    expect(outcome.textContent).not.toContain("failed")
    expect(outcome.querySelector(".run-outcome-dot")?.getAttribute("data-status")).toBe("completed")
    expect(host.textContent).toContain("2 commits on fix")
    const rows = [...host.querySelectorAll("[data-frame-line]")]
    expect(rows).toHaveLength(2)
    expect(rows[0]?.textContent).toContain("hello.test.ts")
    expect(host.querySelector("[aria-label='Recorded turn source']")).toBeNull()
    // Nothing is dumped twice: the result once, the progress folded once it settled, no filter chips, no empty-journal copy.
    expect(host.querySelectorAll(".run-result")).toHaveLength(1)
    expect(host.querySelector(".run-progress-fold [data-run-steps]")?.textContent).toContain("Writing the test…")
    expect(host.querySelectorAll("[data-run-steps]")).toHaveLength(1)
    expect(host.querySelectorAll("[data-filter]")).toHaveLength(0)
    expect(host.querySelector("[data-testid='run-trace-empty-run-1']")).toBeNull()
    expect(host.querySelector("[aria-label='Call tree']")).toBeNull()
    expect([...host.querySelectorAll("[role='tablist'] button")].map((tab) => tab.textContent)).toEqual(["Trace", "Transcript"])
  })
  test("a turn expands in place: its script, its calls and the selected span's facts sit under its row", () => {
    const { host } = renderRun({ phase: "completed", events: COMPLETED, traceView: undefined, selection: "call-2", liveTail: false })
    const rows = [...host.querySelectorAll("[data-frame-line]")]
    expect(rows.map((row) => row.getAttribute("aria-expanded"))).toEqual(["true", "false"])
    const open = host.querySelector("[data-turn-open='true']")!
    expect(open.querySelector("[aria-label='Recorded turn source']")?.textContent).toContain("src/hello.test.ts")
    expect([...open.querySelectorAll("[data-evidence-span]")].map((node) => node.getAttribute("data-evidence-span"))).toEqual(["model-2", "call-1", "call-2"])
    expect(open.querySelector("[aria-label='Call tree']")).toBeNull()
    expect(open.querySelector("[role='alert']")?.textContent).toContain("✖ greets the world")
    expect(host.querySelector("[aria-label='Waterfall']")).toBeNull()
    expect(host.querySelector("[data-frame-line='frame-1']")?.getAttribute("aria-controls")).toBe(open.querySelector(".run-turn-detail")?.id)
  })
  test("a live run shows its progress open and the phase words; a tutorial plan card shows neither outcome nor turns", () => {
    const live = renderRun({ phase: "running", steps: ["Writing the test…"], events: COMPLETED.slice(0, 4), traceView: undefined })
    // The header names the subject the row names: the declared `path` subject.
    expect(live.host.querySelector("[data-testid='run-outcome-run-1']")?.textContent).toContain("Editing hello.test.ts")
    expect(live.host.querySelector(".run-progress-fold")).toBeNull()
    expect(live.host.querySelector("[data-run-steps]")).toBeNull()
    const plan = renderRun({ kind: "change-plan", phase: "completed", input: { plan: { ...CODING_PLAN, changes: [CODING_PLAN.changes[0]!] } }, traceView: undefined })
    expect(plan.host.querySelector("[data-testid='run-outcome-run-1']")).toBeNull()
    expect(plan.host.querySelector("[data-testid='run-trace-empty-run-1']")).toBeNull()
    expect(plan.host.querySelector("[role='tablist']")).toBeNull()
    expect(plan.host.querySelector("[data-testid='flow-run-rerun-run-1']")).toBeNull()
    expect(plan.host.querySelector("[data-flow='agent.change.start']")).not.toBeNull()
  })
})

describe("the run card's needs-help indicator", () => {
  const supervisor = (sequence: number, needsHelp: string) =>
    stamp(sequence, "control.agent.supervisor-settled", { scope: "run-1", frame: sequence, needsHelp }, 1000 + sequence)
  const unjudged = (sequence: number) =>
    stamp(sequence, "control.agent.supervisor-unjudged", { scope: "run-1", frame: sequence, reason: "interrupted", detail: "deadline" }, 1000 + sequence)
  const dot = (host: HTMLElement) => host.querySelector("[data-needs-help]")

  test("a run Jev judged needs help wears one focusable dot on the status header, labelled with the word", () => {
    const { host } = renderRun({ phase: "running", events: [supervisor(1, "stuck")] })
    const outcome = host.querySelector("[data-testid='run-outcome-run-1']")!
    const indicator = outcome.querySelector("[data-needs-help]")!
    expect(indicator.getAttribute("data-needs-help")).toBe("stuck")
    expect(indicator.getAttribute("aria-label")).toBe("Stuck")
    expect(indicator.getAttribute("title")).toBe("Stuck")
    expect(indicator.getAttribute("tabindex")).toBe("0")
    expect(host.querySelectorAll("[data-needs-help]")).toHaveLength(1)
  })
  test.each([
    ["clarification", "Needs clarification"],
    ["permission", "Needs permission"],
    ["risky_action", "Risky action"]
  ])("the %s reading says %s", (needsHelp, label) => {
    const { host } = renderRun({ phase: "running", events: [supervisor(1, needsHelp)] })
    expect(dot(host)?.getAttribute("aria-label")).toBe(label)
  })
  test("the newest settled reading wins, and an unjudged reading clears nothing", () => {
    const { host } = renderRun({
      phase: "running",
      events: [supervisor(1, "stuck"), unjudged(2), supervisor(3, "permission"), unjudged(4)]
    })
    expect(dot(host)?.getAttribute("aria-label")).toBe("Needs permission")
  })
  test("no reading, only unjudged readings, or a latest reading of none renders nothing", () => {
    expect(dot(renderRun({ phase: "running", events: JOURNAL }).host)).toBeNull()
    expect(dot(renderRun({ phase: "running", events: [unjudged(1)] }).host)).toBeNull()
    expect(dot(renderRun({ phase: "running", events: [supervisor(1, "stuck"), supervisor(2, "none")] }).host)).toBeNull()
  })
})

describe("predicted coding Changes in the same run card", () => {
  test("review feedback explains an intentional failed child and opens its existing debugger span", () => {
    const shown = renderTrace({ workflow: "coding", events: earlyCodingJournal(), traceView: "turns" })
    const feedback = shown.host.querySelector("[aria-label='Coding review feedback']")!
    expect(feedback.textContent).toContain("Review requested changes. Waiting for the correction result.")
    expect(feedback.textContent).toContain("Keep the causal revision when merging wiki edits.")
    expect(shown.host.querySelector("[aria-label='Coding outcome']")).toBeNull()
    const inspect = feedback.querySelector<HTMLButtonElement>("[data-flow='runs.trace.select']")!
    inspect.focus()
    expect(document.activeElement).toBe(inspect)
    click(inspect)
    expect(shown.dispatched).toEqual([{ name: "runs.trace.select", args: "sourceCard=flow-run-run-1 run-1 engine:observe:0" }])
    expect(renderTrace({ workflow: "coding", events: earlyCodingJournal(), cursorSeq: 5 }).host.querySelector("[aria-label='Coding review feedback']")).toBeNull()
    const long = JSON.parse(JSON.stringify(earlyCodingJournal()))
    const full = "Preserve every recorded edit. ".repeat(100)
    long.at(-1).payload.payload.state.result.exit.cause[0].error.result.findings[0].message = full
    const compact = renderTrace({ workflow: "coding", events: long, traceView: "turns" })
    expect(compact.host.querySelector("[aria-label='Coding review feedback']")?.textContent).not.toContain(full)
    const detailed = renderTrace({ workflow: "coding", events: long, traceView: "turns", selection: "engine:observe:0" })
    expect(detailed.host.querySelector("[data-testid='run-trace-pane-run-1']")?.textContent).toContain(full)
  })
  test("a prepared native child exposes the plan while its implementation runs, through the same selection command", () => {
    const shown = renderTrace({ workflow: "coding", input: { prompt: CODING_PLAN.prompt }, events: preparedCodingJournal(), traceView: undefined })
    expect(shown.host.querySelector("[aria-label='Goals']")?.textContent).toContain("Store repository memory")
    const button = shown.host.querySelector<HTMLButtonElement>("[data-flow='runs.coding.select']")!
    button.focus()
    expect(document.activeElement).toBe(button)
    click(button)
    expect(shown.dispatched).toEqual([{ name: "runs.coding.select", args: "sourceCard=flow-run-run-1 run-1 memory" }])
    expect(shown.host.querySelector("[aria-label='Coding outcome']")).toBeNull()
    expect(renderTrace({ workflow: "coding", input: { prompt: "Plan this" }, events: preparedCodingJournal(), cursorSeq: 3 }).host.querySelector("[aria-label='Coding plan']")).toBeNull()
  })

  test("a completed engine run reports blocked correction and opens its real failed execution in the existing trace", () => {
    const shown = renderTrace({ workflow: "coding", phase: "completed", input: { prompt: CODING_PLAN.prompt }, events: blockedCodingJournal(), traceView: undefined })
    const outcome = shown.host.querySelector("[aria-label='Coding outcome']")!
    expect(outcome.textContent).toContain("Blocked after 1 round.")
    expect(outcome.textContent).toContain("The required fast check failed.")
    expect(outcome.textContent).not.toContain("Validated")
    const inspect = outcome.querySelector<HTMLButtonElement>("[data-flow='runs.trace.select']")!
    inspect.focus()
    expect(document.activeElement).toBe(inspect)
    click(inspect)
    expect(shown.dispatched).toEqual([{ name: "runs.trace.select", args: "sourceCard=flow-run-run-1 run-1 engine:failed-round:0" }])
    const historical = renderTrace({ workflow: "coding", phase: "completed", input: { prompt: CODING_PLAN.prompt }, events: blockedCodingJournal(), cursorSeq: 7 })
    expect(historical.host.querySelector("[aria-label='Coding outcome']")).toBeNull()
  })

  test("the typed plan appears before any journal, with durable progressive detail and no invented outcomes", () => {
    const initial = renderTrace({ workflow: "coding", input: { plan: CODING_PLAN }, traceView: undefined })
    const outline = initial.host.querySelector("[aria-label='Goals']")
    expect(outline?.textContent).toContain("Store repository memory")
    expect(outline?.textContent).toContain("Connect the Wiki interface")
    expect(initial.host.querySelector("[aria-label='Predicted atomic changes']")).toBeNull()
    click(initial.host.querySelector("[data-flow='runs.coding.select']"))
    expect(initial.dispatched).toEqual([{ name: "runs.coding.select", args: "sourceCard=flow-run-run-1 run-1 memory" }])
    const selected = renderTrace({ workflow: "coding", input: { plan: CODING_PLAN }, codingChangeId: "memory", cursorSeq: 0, traceView: undefined })
    const details = selected.host.querySelector("[aria-label='Store repository memory']")!
    expect(details.textContent).toContain("✨ feat(memory): persist causal documents")
    expect(details.textContent).toContain("src/memory.test.ts")
    expect(details.textContent).toContain("fast · required")
    expect(details.textContent).toContain("slow · required")
    expect(details.textContent).toContain("wiki-revision-42")
    expect(details.textContent).not.toContain("passed")
    expect(details.textContent).not.toContain("vibed")
    // No journal, no turn list: the plan is the card's content until the run records a turn.
    expect(selected.host.querySelector("[aria-label='Turn explanations']")).toBeNull()
  })
  test("missing or invalid input cannot fabricate a coding plan", () => {
    expect(renderTrace({ workflow: "coding" }).host.querySelector("[aria-label='Coding plan']")).toBeNull()
    expect(renderTrace({ input: { plan: { ...CODING_PLAN, changes: [CODING_PLAN.changes[0], CODING_PLAN.changes[0]] } } }).host.querySelector("[aria-label='Coding plan']")).toBeNull()
  })
})


describe("retained prototype card", () => {
  test("real child source, findings and steering use the same embedded native card", () => {
    const { host, dispatched } = renderTrace({ events: CODING_POC_HOST_EVENTS, lastSeq: 263 })
    const poc = host.querySelector('[aria-label="Disposable prototype"]')!
    expect(poc.textContent).toContain("Drafted and discarded. No build or tests ran.")
    expect(poc.textContent).toContain("prototype greeting")
    const buttons = [...poc.querySelectorAll("button")]
    buttons.find(button => button.textContent?.includes("Inspect prototype execution"))!.click()
    buttons.find(button => button.textContent?.includes("Give prototype feedback"))!.click()
    expect(dispatched).toEqual([
      { name: "runs.trace.select", args: "sourceCard=flow-run-run-1 run-1 engine:a4392ed73b6ef7680ecd9a7068f3804e19d4e7de0358944469d54ebe8f4368fa:0" },
      { name: "runs.steer", args: "sourceCard=flow-run-run-1 run-1" }
    ])
    const completed = renderTrace({ events: CODING_POC_HOST_EVENTS, lastSeq: 263, phase: "completed" }).host
    expect(completed.querySelector('[aria-label="Disposable prototype"]')).not.toBeNull()
    expect(completed.querySelector('[aria-label="Disposable prototype"] [data-flow="runs.steer"]')).toBeNull()
  })

  test("file values are literal text; retained HTML and proposed scripts are not executed", () => {
    const result = { ...CODING_POC_RESULT, changes: { ...CODING_POC_RESULT.changes, files: [
      { ...CODING_POC_RESULT.changes.files[0]!, after: '<script>globalThis.pocExecuted = true</script><img src="https://example.test/leak">' }
    ], preview: { mediaType: "text/html" as const, content: '<script>globalThis.pocExecuted = true</script>' } } }
    const { host } = renderTrace({ events: codingPocJournal(result), lastSeq: 4 })
    const poc = host.querySelector('[aria-label="Disposable prototype"]')!
    expect(poc.textContent).toContain('<script>globalThis.pocExecuted = true</script>')
    expect(poc.querySelector("script, iframe, img")).toBeNull()
    expect(renderTrace({ events: codingPocJournal(result), lastSeq: 4, cursorSeq: 3 }).host.querySelector('[aria-label="Disposable prototype"]')).toBeNull()
  })
})


test("the completed Request card reuses source-qualified flow launch and catalog refresh", () => {
  const card = completedRequestCard(), sent: Array<{ name: string; args?: string }> = []
  const dispatch: Parameters<typeof RunTraceBody>[0]["onRunCommand"] = (name, args) => sent.push({ name, args })
  const host = render(<RunTraceBody card={card} onRunCommand={dispatch} workflowCatalogs={[vibeCatalog()]} />)
  const button = [...host.querySelectorAll("button")].find(element => element.textContent === "Vibe this change")!
  expect(button).toBeDefined()
  click(button)
  expect(sent).toEqual([{ name: "flow.run", args: `sourceCard=${card.id} coding/vibe ${JSON.stringify({ requestExecutionId: CODING_REQUEST_ID })}` }])
  const absent = render(<RunTraceBody card={card} onRunCommand={dispatch} />)
  expect(absent.textContent).toContain("Vibe is not available in this workspace's recorded flows.")
  expect(absent.textContent).not.toContain("Vibe this change")
  click([...absent.querySelectorAll("button")].find(element => element.textContent === "Check available flows")!)
  expect(sent.at(-1)).toEqual({ name: "flow.list", args: `sourceCard=${card.id}` })
})


test("source retention is an early fact with the existing exact child debugger action", () => {
  const original = publicationVibeCard()
  const card = { ...original, payload: { ...original.payload, cursorSeq: 5 } }
  const sent: Array<{ name: string; args?: string }> = []
  const host = render(<RunTraceBody card={card} onRunCommand={(name, args) => sent.push({ name, args })} />)
  expect(host.textContent).toContain("Original source retained.")
  expect(host.textContent).not.toContain("Validated request admitted for cleanup.")
  expect(host.textContent).not.toContain("landed")
  expect(host.textContent).not.toContain("shipped")
  const inspect = [...host.querySelectorAll("button")].find(button => button.textContent === "Inspect original source receipt")!
  inspect.focus()
  expect(document.activeElement).toBe(inspect)
  inspect.click()
  expect(sent).toEqual([{ name: "runs.trace.select", args: "sourceCard=vibe-card vibe-root engine:original-publication:0" }])
})


/*
 * The timeline's phase band, its milestone pins, the plain-English rows and
 * the discipline notes. The fold derives all four from the calls the journal
 * recorded and from the check targets the plan declared; the card renders
 * exactly what the fold produced, and every affordance is the existing
 * `runs.trace.select`, now carrying the seq its grammar has always parsed.
 */
describe("the timeline reads as phases, then what each frame did", () => {
  /** The targets the recipe's plan declared; a bash command is a check only when it ends with one. */
  const CHECK_TARGETS = CODING_PLAN.changes.flatMap((change) => change.checks.map((check) => check.target))
  const CHECK = CHECK_TARGETS[0]!

  /** A run that reads, edits, checks, edits again and checks again: one band per stretch. */
  const PHASED = [
    stamp(1, "control.agent.turn-opened", { seat: "openai:gpt-5.6-sol" }, 1000),
    stamp(2, "control.agent.cell-produced", { language: "ts", text: "await ctx.call(\"read\", { path: \"src/memory.ts\" })" }, 1100),
    stamp(3, "control.agent.cell-call-started", { flowName: "read", input: { path: "src/memory.ts" } }, 1200),
    stamp(4, "control.agent.cell-call-settled", { flowName: "read", outcome: "success", value: "80 lines" }, 1800),
    stamp(5, "control.agent.cell-settled", { outcome: "success" }, 1900),
    stamp(6, "control.agent.turn-opened", {}, 2000),
    stamp(7, "control.agent.cell-call-started", { flowName: "edit", input: { path: "src/memory.ts" } }, 2100),
    stamp(8, "control.agent.cell-call-settled", { flowName: "edit", outcome: "success", value: "src/memory.ts +12" }, 2600),
    stamp(9, "control.agent.turn-opened", {}, 3000),
    stamp(10, "control.agent.cell-call-started", { flowName: "bash", input: { command: `bun run check ${CHECK}` } }, 3100),
    stamp(11, "control.agent.cell-call-settled", { flowName: "bash", outcome: "failure", message: "2 errors" }, 4500),
    stamp(12, "control.agent.turn-opened", {}, 5000),
    stamp(13, "control.agent.cell-call-started", { flowName: "edit", input: { path: "src/memory.ts" } }, 5100),
    stamp(14, "control.agent.cell-call-settled", { flowName: "edit", outcome: "success", value: "src/memory.ts −1 +3" }, 5600),
    stamp(15, "control.agent.turn-opened", {}, 6000),
    stamp(16, "control.agent.cell-call-started", { flowName: "bash", input: { command: `bun run check ${CHECK}` } }, 6100),
    stamp(17, "control.agent.cell-call-settled", { flowName: "bash", outcome: "success", value: "0 errors" }, 7400),
    stamp(18, "control.run.completed", { runId: "run-1", status: "completed" }, 7500)
  ]

  /** The same failing command, unchanged, four turns running: a stall a reader must not have to infer. */
  const STALLED = [
    stamp(1, "control.agent.turn-opened", {}, 1000),
    stamp(2, "control.agent.cell-call-started", { flowName: "edit", input: { path: "src/memory.ts" } }, 1100),
    stamp(3, "control.agent.cell-call-settled", { flowName: "edit", outcome: "success", value: "src/memory.ts +2" }, 1300),
    ...[0, 1, 2, 3].flatMap((round) => {
      const base = 4 + round * 3
      const at = 2000 + round * 1000
      return [
        stamp(base, "control.agent.turn-opened", {}, at),
        stamp(base + 1, "control.agent.cell-call-started", { flowName: "bash", input: { command: `bun run check ${CHECK}` } }, at + 100),
        stamp(base + 2, "control.agent.cell-call-settled", { flowName: "bash", outcome: "failure", message: "2 errors" }, at + 800)
      ]
    }),
    /* What the harness journals when a run has spent its repeat cap (`@smthrs/agent` AgentEvent.RepeatDemanded). */
    stamp(16, "control.agent.repeat-demanded", { frames: 4, cap: 4, nextFrame: 6 }, 5900)
  ]

  /** The fold the card builds for these payloads: the same run, journal and declared targets. */
  const fold = (events: Array<ReturnType<typeof stamp>>, status = "completed") =>
    traceFromJournal({ runId: "run-1", flowId: "coding", status }, events, { checkTargets: CHECK_TARGETS })

  const timeline = (events: Array<ReturnType<typeof stamp>>, over: Partial<Extract<Card, { kind: "run-trace" }>["payload"]> = {}) =>
    renderTrace({ workflow: "coding", phase: "completed", input: { plan: CODING_PLAN }, events, traceView: "timeline", liveTail: false, ...over })

  test("the band is one segment per phase, and a press scrubs to that band's own seq", () => {
    const model = fold(PHASED)
    const { host, dispatched } = timeline(PHASED)
    const segments = [...host.querySelectorAll("[data-phase-band]")]
    expect(model.bands.length).toBeGreaterThan(1)
    expect(segments.map((segment) => segment.getAttribute("data-phase-band"))).toEqual(model.bands.map((band) => band.phase))
    // A band is a contiguous stretch of one phase, so no two neighbours can share one.
    expect(segments.filter((segment, index) =>
      index > 0 && segment.getAttribute("data-phase-band") === segments[index - 1]!.getAttribute("data-phase-band")
    )).toEqual([])
    // Width is the recorded duration on the bands' own axis: left to right, inside the axis, never overlapping.
    const boxes = segments.map((segment) => ({
      left: Number.parseFloat((segment as HTMLElement).style.left),
      width: Number.parseFloat((segment as HTMLElement).style.width)
    }))
    for (const [index, box] of boxes.entries()) {
      expect(box.left + box.width).toBeLessThanOrEqual(100.01)
      if (index > 0) expect(box.left).toBeGreaterThanOrEqual(boxes[index - 1]!.left + boxes[index - 1]!.width - 0.01)
    }
    const second = segments[1]!
    expect(second.getAttribute("data-seq")).toBe(String(model.bands[1]!.seq))
    click(second)
    expect(dispatched).toEqual([{
      name: "runs.trace.select",
      args: `sourceCard=flow-run-run-1 run-1 ${model.bands[1]!.frames[0]} ${model.bands[1]!.seq}`
    }])
  })

  test("milestone doors retain their labels and dispatch their recorded sequence", () => {
    const model = fold(PHASED)
    const { host, dispatched } = timeline(PHASED)
    const pins = [...host.querySelectorAll("[data-pin-row]")]
    expect(pins).toHaveLength(model.milestones.length)
    expect(pins.length).toBeGreaterThan(0)
    const placed = pins.map((pin) => ({
      row: pin.getAttribute("data-pin-row"),
      left: Number.parseFloat((pin as HTMLElement).style.left),
      bottom: (pin as HTMLElement).style.bottom
    }))
    for (const [index, pin] of placed.entries()) {
      for (const other of placed.slice(index + 1)) {
        if (pin.row === other.row) expect(Math.abs(pin.left - other.left)).toBeGreaterThanOrEqual(8)
      }
      // Rendered bounds are checked in Chromium by e2e/probes/run-trace-phase-strip.test.ts.
      expect(pin.bottom).toBe("")
    }
    expect(new Set(placed.map((pin) => pin.row)).size).toBeLessThanOrEqual(2)
    const ordered = [...model.milestones].sort((left, right) => left.seq - right.seq)
    expect(pins.map((pin) => pin.querySelector(".run-phase-pin-label")?.textContent)).toEqual(ordered.map((milestone) => milestone.label))
    expect(placed.map((pin) => pin.left)).toEqual([...placed.map((pin) => pin.left)].sort((left, right) => left - right))
    click(pins[0]!)
    expect(dispatched.at(0)?.name).toBe("runs.trace.select")
    expect(dispatched.at(0)?.args?.startsWith("sourceCard=flow-run-run-1 run-1 ")).toBe(true)
    expect(dispatched.at(0)?.args?.endsWith(` ${ordered[0]!.seq}`)).toBe(true)
  })

  test("a row per frame says what it did, marks the frame that wrote, and selects its span", () => {
    const model = fold(PHASED)
    const { host, dispatched } = timeline(PHASED)
    const rows = [...host.querySelectorAll("[data-frame-line]")]
    expect(model.lines.length).toBeGreaterThan(1)
    expect(rows.map((row) => row.getAttribute("data-frame-line"))).toEqual(model.lines.map((line) => line.spanId))
    const first = model.lines[0]!
    expect(rows[0]?.querySelector(".run-line-number")?.textContent).toBe(String(first.frame))
    expect(rows[0]?.querySelector(".run-line-verb")?.textContent).toBe(first.verb)
    expect(rows[0]?.querySelector(".run-line-subject")?.textContent).toBe(first.subject)
    expect(rows[0]?.querySelector(".run-line-result")?.textContent).toBe(first.result)
    const wrote = model.lines.find((line) => line.wrote)!
    expect(host.querySelector(`[data-frame-line="${wrote.spanId}"]`)?.getAttribute("data-wrote")).toBe("true")
    const failed = model.lines.find((line) => line.failed)!
    expect(host.querySelector(`[data-frame-line="${failed.spanId}"]`)?.getAttribute("data-failed")).toBe("true")
    click(rows[0]!)
    expect(dispatched).toEqual([{ name: "runs.trace.select", args: `sourceCard=flow-run-run-1 run-1 ${first.spanId}` }])
  })

  test("frame rows show settlement-aware verbs once and keep raw output behind call selection", () => {
    const output = { path: "a.ts", bytesWritten: 12, created: false }
    const cases = [
      [undefined, "writing", ""],
      [{ outcome: "failure", message: "read-only" }, "failed to write", "read-only"],
      [{ outcome: "success", value: output }, "wrote", "12 bytes"],
      [{ outcome: "success", value: { unsupported: "raw-only" } }, "wrote", ""]
    ] as const
    for (const [settlement, verb, result] of cases) {
      const events = [
        stamp(1, "control.agent.turn-opened", {}, 1000),
        stamp(2, "control.agent.cell-call-started", { flowName: "write", input: { path: "a.ts" } }, 1100),
        ...(settlement === undefined ? [] : [stamp(3, "control.agent.cell-call-settled", { flowName: "write", ...settlement }, 1200)])
      ]
      const { host, dispatched } = renderTrace({ events })
      const row = host.querySelector<HTMLButtonElement>('[data-frame-line="frame-1"]')!
      expect(row.querySelector(".run-line-verb")?.textContent).toBe(verb)
      expect(row.querySelector(".run-line-result")?.textContent).toBe(result)
      expect(row.querySelector(".run-line-wrote")).toBeNull()
      expect(row.textContent).not.toContain("bytesWritten")
      expect(row.textContent).not.toContain("raw-only")
      click(row)
      expect(dispatched).toEqual([{ name: "runs.trace.select", args: "sourceCard=flow-run-run-1 run-1 frame-1" }])
      if (settlement !== undefined && "value" in settlement) {
        const selected = renderTrace({ events, selection: "call-1" })
        expect(selected.host.querySelector('[aria-label="Output"]')?.textContent).toBe(JSON.stringify(settlement.value))
      }
    }
  })

  test("a stalled frame names the frame it repeats, and the discipline note sits under the frame it happened in", () => {
    const model = fold(STALLED, "running")
    const { host } = timeline(STALLED, { phase: "running" })
    const repeated = model.lines.filter((line) => line.repeatOf !== undefined)
    expect(repeated.length).toBeGreaterThan(0)
    const row = host.querySelector(`[data-frame-line="${repeated[0]!.spanId}"]`)
    expect(row?.textContent).toContain(`same as ${repeated[0]!.repeatOf}`)
    // Outside a stall streak nothing claims a repeat.
    expect(host.querySelectorAll(".run-line-repeat")).toHaveLength(repeated.length)
    const notes = [...host.querySelectorAll("[data-note]")]
    expect(model.notes.length).toBeGreaterThan(0)
    expect(notes.map((note) => note.getAttribute("data-note"))).toEqual(model.notes.map((note) => String(note.seq)))
    const note = model.notes[0]!
    const placed = host.querySelector(`[data-frame-line="${note.spanId}"]`)?.closest("li")
    expect(placed?.querySelector(`[data-note="${note.seq}"]`)).not.toBeNull()
    expect(placed?.querySelector(".run-note-title")?.textContent).toBe(note.title)
    expect(placed?.querySelector(".run-note-body")?.textContent).toBe(note.body)
  })

  /*
   * Five frames that each write inside one second of a long run, then a demand
   * the harness journals in the same second. Every moment lands inside
   * PIN_APART of its neighbour: the case the strip's rows cannot hold.
   */
  const CLUSTERED = [
    ...[0, 1, 2, 3, 4].flatMap((round) => [
      stamp(1 + round * 3, "control.agent.turn-opened", {}, 1000 + round * 50),
      stamp(2 + round * 3, "control.agent.cell-call-started", { flowName: "edit", input: { path: `src/a${round}.ts` } }, 1010 + round * 50),
      stamp(3 + round * 3, "control.agent.cell-call-settled", { flowName: "edit", outcome: "success", value: "+1" }, 1020 + round * 50)
    ]),
    stamp(16, "control.agent.unresolved-demanded", { flow: "bash", nextFrame: 6 }, 1260),
    stamp(17, "control.agent.turn-opened", {}, 20000),
    stamp(18, "control.agent.cell-call-started", { flowName: "read", input: { path: "src/z.ts" } }, 20100),
    stamp(19, "control.agent.cell-call-settled", { flowName: "read", outcome: "success", value: "80 lines" }, 20200),
    stamp(20, "control.run.completed", { runId: "run-1", status: "completed" }, 21000)
  ]

  test("a scrub keeps every later band and pin on the strip, marked as not reached, and stops the rows at the cursor", () => {
    const model = fold(PHASED)
    const parked = model.bands[1]!.seq
    const { host, dispatched } = timeline(PHASED, { cursorSeq: parked })
    const bands = [...host.querySelectorAll("[data-phase-band]")]
    // Every band the journal recorded is still there, including the ones after the cursor.
    expect(bands.map((band) => band.getAttribute("data-seq"))).toEqual(model.bands.map((band) => String(band.seq)))
    expect(bands.map((band) => band.getAttribute("data-reached"))).toEqual(model.bands.map((band) => String(band.seq <= parked)))
    expect(bands.filter((band) => band.getAttribute("data-reached") === "false").length).toBeGreaterThan(0)
    const pins = [...host.querySelectorAll("[data-pin-row]")]
    expect(pins).toHaveLength(model.milestones.length)
    expect(pins.filter((pin) => pin.getAttribute("data-reached") === "false"))
      .toHaveLength(model.milestones.filter((milestone) => milestone.seq > parked).length)
    // A band after the cursor is still a door: pressing it scrubs forward.
    const ahead = model.bands.at(-1)!
    click(bands.at(-1)!)
    expect(dispatched).toEqual([{
      name: "runs.trace.select",
      args: `sourceCard=flow-run-run-1 run-1 ${ahead.frames[0]} ${ahead.seq}`
    }])
    // The rows below are the log, and a log stops at the cursor.
    const capped = traceFromJournal(
      { runId: "run-1", flowId: "coding", status: "running" },
      PHASED.filter((record) => record.sequence <= parked),
      { checkTargets: CHECK_TARGETS }
    )
    expect(capped.lines.length).toBeLessThan(model.lines.length)
    expect([...host.querySelectorAll("[data-frame-line]")].map((row) => row.getAttribute("data-frame-line")))
      .toEqual(capped.lines.map((line) => line.spanId))
  })

  test("the outcome's counts are the run's own, so a parked cursor never puts a verdict beside a part of the run", () => {
    const model = fold(PHASED)
    const { host } = timeline(PHASED, { cursorSeq: model.bands[1]!.seq })
    const outcome = host.querySelector("[data-testid='run-outcome-run-1']")!
    const calls = model.rows.filter((span) => span.kind === "call").length
    expect(outcome.textContent).toContain("Finished.")
    expect(outcome.textContent).toContain(`${turnNarratives(model).length} turns · ${calls} calls`)
    // The same line the run reads at its live tail: the cursor moved the log, not the verdict.
    expect(timeline(PHASED).host.querySelector("[data-testid='run-outcome-run-1']")?.textContent).toBe(outcome.textContent)
  })

  test("a dense cluster discloses each member with its own sequence and the loudest tone", () => {
    const model = fold(CLUSTERED)
    // The cluster is real: six moments, five writes and the demand, inside one second of twenty.
    expect(model.milestones.map((milestone) => milestone.label))
      .toEqual(["a0.ts", "a1.ts", "a2.ts", "a3.ts", "a4.ts", "unresolved", "completed"])
    const { host, dispatched } = timeline(CLUSTERED)
    const pins = [...host.querySelectorAll("[data-pin-row]")]
    const placed = pins.map((pin) => ({
      row: pin.getAttribute("data-pin-row"),
      left: Number.parseFloat((pin as HTMLElement).style.left)
    }))
    for (const [index, pin] of placed.entries()) {
      for (const other of placed.slice(index + 1)) {
        if (pin.row === other.row) expect(Math.abs(pin.left - other.left)).toBeGreaterThanOrEqual(8)
      }
    }
    // Three rows and no more: a deeper cluster would otherwise stack a label per
    // moment over a track a fraction of that height.
    expect(placed.map((pin) => pin.row)).toEqual(["0", "1", "2", "0"])
    // The moments with no row left are not dropped and not overprinted: the
    // last pin placed stops naming one moment and counts the four it stands for.
    expect(pins.map((pin) => pin.querySelector(".run-phase-pin-label")?.textContent))
      .toEqual(["a0.ts", "a1.ts", "+4", "completed"])
    // One of the four is a failed demand, so the count wears its tone: a red
    // moment does not disappear into a write-coloured pin.
    expect(pins.map((pin) => pin.getAttribute("data-tone"))).toEqual(["brand", "brand", "bad", "good"])
    const disclosure = pins[2]! as HTMLDetailsElement
    expect(disclosure.tagName).toBe("DETAILS")
    const members = [...disclosure.querySelectorAll("button")]
    expect(members.map((member) => member.getAttribute("aria-label")))
      .toEqual(["a2.ts · #9", "a3.ts · #12", "a4.ts · #15", "unresolved · #16"])
    for (const member of members) click(member)
    expect(dispatched).toEqual([9, 12, 15, 16].map((seq, index) => ({
      name: "runs.trace.select", args: `sourceCard=flow-run-run-1 run-1 frame-${Math.min(index + 3, 5)} ${seq}`
    })))
  })

  test("one frame's fifteen edits are one pin", () => {
    const { host } = timeline([
      stamp(1, "control.agent.turn-opened", {}, 1000),
      ...Array.from({ length: 15 }, (_unused, index) => [
        stamp(2 + index * 2, "control.agent.cell-call-started", { flowName: "edit", input: { path: `src/a${index}.ts` } }, 1100 + index * 10),
        stamp(3 + index * 2, "control.agent.cell-call-settled", { flowName: "edit", outcome: "success", value: "+1" }, 1105 + index * 10)
      ]).flat(),
      stamp(32, "control.agent.turn-opened", {}, 20000)
    ], { phase: "running" })
    expect([...host.querySelectorAll(".run-phase-pin-label")].map((label) => label.textContent)).toEqual(["a0.ts +14"])
  })

  test("a pin belongs to the frame the journal opened before it, not to the frame its stamp lands inside", () => {
    const { host, dispatched } = timeline([
      stamp(1, "control.agent.turn-opened", {}, 1000),
      stamp(2, "control.agent.cell-call-started", { flowName: "edit", input: { path: "src/a.ts" } }, 1000),
      stamp(3, "control.agent.cell-call-settled", { flowName: "edit", outcome: "success", value: "+1" }, 1000),
      // Frame 2 opens on the stamp frame 1 closes on, and the demand is
      // recorded after it: by stamp alone the moment sits in both frames.
      stamp(4, "control.agent.turn-opened", {}, 2000),
      stamp(5, "control.agent.read-only-demanded", { streak: 4, cap: 4, nextFrame: 3, nextAction: "write" }, 2000)
    ])
    const pins = [...host.querySelectorAll(".run-phase-pin")]
    expect(pins.map((pin) => pin.querySelector(".run-phase-pin-label")?.textContent)).toEqual(["a.ts", "read-only"])
    click(pins[1]!)
    expect(dispatched).toEqual([{ name: "runs.trace.select", args: "sourceCard=flow-run-run-1 run-1 frame-2 5" }])
  })

  test("pins read in journal order, so a record stamped before the one it follows still reads after it", () => {
    const { host } = timeline([
      stamp(1, "control.agent.turn-opened", {}, 1000),
      stamp(2, "control.agent.cell-call-started", { flowName: "edit", input: { path: "README.md" } }, 1100),
      stamp(3, "control.agent.cell-call-settled", { flowName: "edit", outcome: "success", value: "+1" }, 1200),
      // The verdict shares the write's stamp; the drain after it was stamped
      // before both. The s16 timeline attachment ordered its pins 100, 167,
      // 159 for exactly this reason.
      stamp(4, "control.run.completed", { runId: "run-1", status: "completed" }, 1200),
      stamp(5, "control.agent.steering-drained", { messages: [{ role: "user", text: "ship it" }] }, 1150)
    ])
    const pins = [...host.querySelectorAll(".run-phase-pin")]
    expect(pins.map((pin) => pin.querySelector(".run-phase-pin-label")?.textContent))
      .toEqual(["README.md", "completed", "steering"])
    expect(pins.map((pin) => pin.getAttribute("data-flow-args")))
      .toEqual(["run-1 frame-1 3", "run-1 frame-1 4", "run-1 frame-1 5"])
    // Tab reads the DOM, and nothing here overrides it, so journal order is
    // the traversal order.
    expect(pins.map((pin) => pin.getAttribute("tabindex"))).toEqual([null, null, null])
    expect(pins.map((pin) => (pin as HTMLElement).tagName)).toEqual(["BUTTON", "BUTTON", "BUTTON"])
  })

  test("a moment the fold could not name gets no pin: the strip never paints an empty label", () => {
    /*
     * `AgentSession` replaces a call input over 64 KiB with { truncated, bytes,
     * digest }, so `subjectOf` has no path, command or pattern to name the write
     * by. The fold drops such a moment now; the strip drops one regardless of
     * what the fold hands it.
     */
    const unnamed = { seq: 3, at: 1200, label: "", tone: "brand", spanId: "frame-1" } as const
    const named = { seq: 6, at: 5200, label: "memory.ts", tone: "brand", spanId: "frame-2" } as const
    const pins = phasePins([unnamed, named], { start: 1000, end: 6000 })
    expect(pins.map((pin) => pin.milestone.label)).toEqual(["memory.ts"])
    expect(pins.map((pin) => pin.row)).toEqual([0])
  })

  test("one payload is folded once, so a re-render never walks the journal again", () => {
    const card = runCard({ workflow: "coding", phase: "completed", input: { plan: CODING_PLAN }, events: PHASED })
    // The fold is the walk `codingEvidenceOf` and `traceFromJournal` make over
    // the journal: holding it by payload is what stops every render repeating it.
    expect(traceOf(card)).toBe(traceOf(card))
    // A new payload over the same journal reuses its fold; a grown one steps it.
    const same = runCard({ workflow: "coding", phase: "completed", input: { plan: CODING_PLAN }, events: PHASED })
    expect(traceOf(same)).toBe(traceOf(card))
    const grown = runCard({ workflow: "coding", phase: "completed", input: { plan: CODING_PLAN },
      events: [...PHASED, stamp(99, "control.agent.checkpoint-minted", { ref: "abc" }, 9900)] })
    expect(traceOf(grown)).not.toBe(traceOf(card))
    expect(traceOf(grown)).toEqual(traceFromJournal({ runId: grown.payload.runId, flowId: "coding", status: "completed" },
      grown.payload.events!))
  })

  test("the primary view shares the band, pins and human rows", () => {
    const { host } = timeline(PHASED, { traceView: "turns" })
    expect(host.querySelector("[data-phase-band]")).not.toBeNull()
    expect(host.querySelector("[data-pin-row]")).not.toBeNull()
    expect(host.querySelector("[data-frame-line]")).not.toBeNull()
    expect(host.querySelector("[aria-label='Turn explanations']")).toBeNull()
    expect(host.querySelectorAll("[data-frame-line]")).toHaveLength(5)
  })

  test("a journal with no frames shows no band and no rows, never an empty one", () => {
    const { host } = timeline([])
    expect(host.querySelector("[aria-label='Phases']")).toBeNull()
    expect(host.querySelector("[aria-label='What each frame did']")).toBeNull()
  })
})

/*
 * Two readings the phase strip dropped: a moment the journal recorded before
 * any turn opened, and a run whose frames all land on one stamp.
 */
test("a journal that opened no turn still shows the moments it recorded", () => {
  const { host } = renderTrace({
    workflow: "coding",
    phase: "completed",
    liveTail: false,
    events: [
      stamp(1, "control.agent.read-only-demanded", { streak: 7, cap: 7, nextFrame: 1, nextAction: "write" }, 1000),
      stamp(2, "control.agent.sufficiency-observed", {}, 3000)
    ]
  })
  // No frame opened, so there is no band to draw; the moments are records all the same.
  expect([...host.querySelectorAll("[data-phase-band]")]).toHaveLength(0)
  expect([...host.querySelectorAll(".run-phase-pin-label")].map((pin) => pin.textContent))
    .toEqual(["read-only", "sufficiency"])
})

test("a run whose frames share one stamp lays its bands left to right, not stacked at zero", () => {
  const { host } = renderTrace({
    workflow: "coding",
    phase: "completed",
    liveTail: false,
    events: [
      stamp(1, "control.agent.turn-opened", {}, 1000),
      stamp(2, "control.agent.cell-call-started", { flowName: "read", input: { path: "src/x.ts" } }, 1000),
      stamp(3, "control.agent.cell-call-settled", { flowName: "read", outcome: "success", value: "ok" }, 1000),
      stamp(4, "control.agent.turn-opened", {}, 1000),
      stamp(5, "control.agent.cell-call-started", { flowName: "edit", input: { path: "src/x.ts" } }, 1000),
      stamp(6, "control.agent.cell-call-settled", { flowName: "edit", outcome: "success", value: "+1" }, 1000)
    ]
  })
  expect([...host.querySelectorAll("[data-phase-band]")].map((band) => [
    (band as HTMLElement).style.left,
    (band as HTMLElement).style.width
  ])).toEqual([["0%", "50%"], ["50%", "50%"]])
})

/*
 * A recorded coding run is pinned over its journal. Its last frame calls
 * `commit`, a name no standard flow carries (`@smthrs/std` has none), with
 * `{ message }` alone: a flow the verb table has never heard of, whose input
 * names nothing the fold reads as a subject. Such a line is the flow's name
 * and nothing else.
 */
const RECORDED_EVENTS = [{"sequence": 1, "kind": "control.agent.turn-opened", "payload": {}, "occurredAt": 1757505600000}, {"sequence": 2, "kind": "control.agent.model-settled", "payload": {"text": "Write the test first, so the bug shows up as a failure."}, "occurredAt": 1757505600400}, {"sequence": 3, "kind": "control.agent.cell-produced", "payload": {"language": "ts", "text": "await ctx.call(\"edit\", { path: \"src/hello.test.ts\", append: TEST })\nawait ctx.call(\"test\", { target: \"npm test\" })"}, "occurredAt": 1757505600500}, {"sequence": 4, "kind": "control.agent.cell-call-started", "payload": {"flowName": "edit", "input": {"path": "src/hello.test.ts"}}, "occurredAt": 1757505600600}, {"sequence": 5, "kind": "control.agent.cell-call-settled", "payload": {"flowName": "edit", "outcome": "success", "value": "src/hello.test.ts +4"}, "occurredAt": 1757505600900}, {"sequence": 6, "kind": "control.agent.cell-call-started", "payload": {"flowName": "test", "input": {"target": "npm test"}}, "occurredAt": 1757505601000}, {"sequence": 7, "kind": "control.agent.cell-call-settled", "payload": {"flowName": "test", "outcome": "failure", "message": "\u2716 greets the world when no name is given\n  expected 'Hello, world!'\n  actual   'Hello, null!'"}, "occurredAt": 1757505602600}, {"sequence": 8, "kind": "control.agent.cell-settled", "payload": {"outcome": "success"}, "occurredAt": 1757505602700}, {"sequence": 9, "kind": "control.agent.turn-opened", "payload": {}, "occurredAt": 1757505603400}, {"sequence": 10, "kind": "control.agent.model-settled", "payload": {"text": "Edit src/hello.ts: default a missing name to \"world\" on line 2."}, "occurredAt": 1757505603800}, {"sequence": 11, "kind": "control.agent.cell-produced", "payload": {"language": "ts", "text": "const file = await ctx.call(\"files.read\", { path: \"src/hello.ts\" })\nawait ctx.call(\"edit\", { path: \"src/hello.ts\", line: 2, text: 'return `Hello, ${name || \"world\"}!`' })\nawait ctx.call(\"test\", { target: \"npm test\" })"}, "occurredAt": 1757505603900}, {"sequence": 12, "kind": "control.agent.cell-call-started", "payload": {"flowName": "files.read", "input": {"path": "src/hello.ts"}}, "occurredAt": 1757505604000}, {"sequence": 13, "kind": "control.agent.cell-call-settled", "payload": {"flowName": "files.read", "outcome": "success", "value": "export function greet(name: string | null): string {\n  return `Hello, ${name}!`\n}\n"}, "occurredAt": 1757505604200}, {"sequence": 14, "kind": "control.agent.cell-call-started", "payload": {"flowName": "edit", "input": {"path": "src/hello.ts", "line": 2}}, "occurredAt": 1757505604300}, {"sequence": 15, "kind": "control.agent.cell-call-settled", "payload": {"flowName": "edit", "outcome": "success", "value": "src/hello.ts \u22121 +1"}, "occurredAt": 1757505604600}, {"sequence": 16, "kind": "control.agent.cell-call-started", "payload": {"flowName": "test", "input": {"target": "npm test"}}, "occurredAt": 1757505604700}, {"sequence": 17, "kind": "control.agent.cell-call-settled", "payload": {"flowName": "test", "outcome": "success", "value": "\u2714 greets by name\n\u2714 greets the world when no name is given\n2 tests pass"}, "occurredAt": 1757505606200}, {"sequence": 18, "kind": "control.agent.cell-settled", "payload": {"outcome": "success"}, "occurredAt": 1757505606300}, {"sequence": 19, "kind": "control.agent.turn-opened", "payload": {}, "occurredAt": 1757505607000}, {"sequence": 20, "kind": "control.agent.model-settled", "payload": {"text": "Document the default in the README."}, "occurredAt": 1757505607300}, {"sequence": 21, "kind": "control.agent.cell-produced", "payload": {"language": "ts", "text": "await ctx.call(\"edit\", { path: \"README.md\", append: NOTE })"}, "occurredAt": 1757505607400}, {"sequence": 22, "kind": "control.agent.cell-call-started", "payload": {"flowName": "edit", "input": {"path": "README.md"}}, "occurredAt": 1757505607500}, {"sequence": 23, "kind": "control.agent.cell-call-settled", "payload": {"flowName": "edit", "outcome": "success", "value": "README.md +2"}, "occurredAt": 1757505607800}, {"sequence": 24, "kind": "control.agent.cell-settled", "payload": {"outcome": "success"}, "occurredAt": 1757505607900}, {"sequence": 25, "kind": "control.agent.turn-opened", "payload": {}, "occurredAt": 1757505608400}, {"sequence": 26, "kind": "control.agent.model-settled", "payload": {"text": "Split the work into three commits, ordered for review."}, "occurredAt": 1757505608700}, {"sequence": 27, "kind": "control.agent.cell-produced", "payload": {"language": "ts", "text": "await ctx.call(\"commit\", { message: \"Document the /hello default in README\" })\nawait ctx.call(\"commit\", { message: \"Default greet() name to \\\"world\\\"\" })\nawait ctx.call(\"commit\", { message: \"Test /hello without a name\" })"}, "occurredAt": 1757505608800}, {"sequence": 28, "kind": "control.agent.cell-call-started", "payload": {"flowName": "commit", "input": {"message": "Document the /hello default in README"}}, "occurredAt": 1757505608900}, {"sequence": 29, "kind": "control.agent.cell-call-settled", "payload": {"flowName": "commit", "outcome": "success", "value": "vztqlsrp 39f0e2ae8a38"}, "occurredAt": 1757505609000}, {"sequence": 30, "kind": "control.agent.cell-call-started", "payload": {"flowName": "commit", "input": {"message": "Default greet() name to \"world\""}}, "occurredAt": 1757505609100}, {"sequence": 31, "kind": "control.agent.cell-call-settled", "payload": {"flowName": "commit", "outcome": "success", "value": "sonryzll 403621e91240"}, "occurredAt": 1757505609200}, {"sequence": 32, "kind": "control.agent.cell-call-started", "payload": {"flowName": "commit", "input": {"message": "Test /hello without a name"}}, "occurredAt": 1757505609300}, {"sequence": 33, "kind": "control.agent.cell-call-settled", "payload": {"flowName": "commit", "outcome": "success", "value": "tvymolup 1a1b55cc6452"}, "occurredAt": 1757505609400}, {"sequence": 34, "kind": "control.agent.cell-settled", "payload": {"outcome": "success"}, "occurredAt": 1757505609500}, {"sequence": 35, "kind": "control.agent.resolved", "payload": {"text": "3 commits on smithers/fix-hello-3"}, "occurredAt": 1757505609600}] as never
test("a recorded run's timeline names an unknown flow alone, with no empty subject beside it", () => {
  const { host } = renderTrace({ runId: "recorded-run", workflow: "coding", phase: "completed", liveTail: false, events: RECORDED_EVENTS })
  const rows = [...host.querySelectorAll("[data-frame-line]")]
  expect(rows.map((row) => row.querySelector(".run-line-body")?.textContent))
    .toEqual(["edited hello.test.ts", "edited hello.ts", "edited README.md", "commit"])
  expect(rows.map((row) => row.querySelectorAll(".run-line-subject").length)).toEqual([1, 1, 1, 0])
  // One pin per frame that wrote, each under the strip's two rows.
  expect([...host.querySelectorAll(".run-phase-pin-label")].map((label) => label.textContent))
    .toEqual(["hello.test.ts", "hello.ts", "README.md"])
})

describe("the primary monitoring surface", () => {
  test.each([["reconnecting", "Reconnecting…"], ["quiet", "No recent progress"], ["stopped", "Stopped watching"]] as const)("%s does not present old activity as live", (phase, label) => {
    const { host } = renderTrace({ phase, events: JOURNAL, traceView: undefined })
    expect(host.querySelector(".run-outcome-words")?.textContent).toBe(label)
  })
  test("the default opens the phase strip and human rows, with technical views behind a flow", () => {
    const { host, dispatched } = renderTrace({ events: JOURNAL, traceView: undefined })
    expect(host.querySelector(".run-phases")).not.toBeNull()
    expect(host.querySelectorAll("[data-frame-line]")).toHaveLength(2)
    for (const label of ["Call tree", "Waterfall", "Recorded call path", "Recorded turn source"]) {
      expect(host.querySelector(`[aria-label='${label}']`)).toBeNull()
    }
    click(host.querySelector("[data-frame-line='frame-1']"))
    expect(dispatched).toEqual([{ name: "runs.trace.select", args: "sourceCard=flow-run-run-1 run-1 frame-1" }])
    expect(host.querySelector("[aria-label='Recorded turn source']")).toBeNull()
    const expanded = renderTrace({ events: JOURNAL, traceView: undefined, selection: "frame-1", liveTail: false, cursorSeq: 8 })
    expect(expanded.host.querySelector("[data-frame-line='frame-1']")?.getAttribute("aria-expanded")).toBe("true")
    expect(expanded.host.querySelector("[data-turn-open='true'] [aria-label='Recorded turn source']")).not.toBeNull()
    expect(expanded.host.querySelector("[aria-label='Call tree']")).toBeNull()
    click(expanded.host.querySelector("[data-flow='runs.trace.view']"))
    expect(expanded.dispatched).toEqual([{ name: "runs.trace.view", args: "sourceCard=flow-run-run-1 run-1 timeline" }])
  })
  test("the live header and existing approval control remain current while inspecting the past", () => {
    const events = [...JOURNAL, stamp(9, "control.approval.requested", { requestId: "q", question: "Continue?" }, 5500)]
    const { host, dispatched } = renderTrace({ events, cursorSeq: 4, liveTail: false, traceView: undefined })
    const header = host.querySelector("[data-testid='run-outcome-run-1']")!
    expect(header.textContent).toContain("Running agent/send")
    expect(header.textContent).toContain("Approval needed")
    click(header.querySelector("[data-flow='approvals.open']"))
    expect(dispatched).toEqual([{ name: "approvals.open", args: "sourceCard=flow-run-run-1 run-1" }])
    expect(host.querySelector(".run-trace-cursor")?.textContent).toBe("At #4")
  })
  test("known goals stay visible and a write does not tick them", () => {
    const { host } = renderTrace({ input: { plan: CODING_PLAN }, events: JOURNAL, traceView: undefined })
    expect(host.querySelectorAll("[data-goal]")).toHaveLength(2)
    expect([...host.querySelectorAll("[data-goal]")].map(node => node.getAttribute("data-state"))).toEqual(["pending", "pending"])
    expect(host.querySelector("[aria-label='Goals']")?.closest("details")).toBeNull()
  })
})

describe("the run card's token meter", () => {
  test("the header carries the meter; low cache warns and a full window is danger", () => {
    const events = [
      stamp(1, "control.agent.turn-opened", { seat: "openai:gpt-4o" }, 1000),
      stamp(2, "control.agent.model-settled", { text: "ok", usage: { inputTokens: 120_000, outputTokens: 2000, cachedInputTokens: 30_000 } }, 1500)
    ]
    const { host } = renderRun({ phase: "running", events })
    const meter = host.querySelector("[data-testid='run-outcome-run-1'] [data-testid='run-meter-run-1']")!
    expect(meter.textContent).toBe("↑120k ↓2.0k · 93.8%/128k · cache 25%")
    expect([...meter.querySelectorAll("[data-level]")].map((part) => part.getAttribute("data-level"))).toEqual(["danger", "warning"])
    // Colour and arrows are not the only signal: the label and titles say them in words.
    expect(meter.getAttribute("role")).toBe("img")
    expect(meter.getAttribute("aria-label")).toBe("120k tokens in, 2.0k out, 93.8% of 128k window, nearly full, cache 25%, low")
    expect([...meter.querySelectorAll("[data-level]")].map((part) => part.getAttribute("title"))).toEqual(["Context window nearly full", "Low cache hit rate"])
  })
  test("a run with no recorded usage has no meter", () => {
    const { host } = renderRun({ phase: "running", events: [stamp(1, "control.agent.turn-opened", { seat: "openai:gpt-4o" }, 1000)] })
    expect(host.querySelector("[data-testid='run-meter-run-1']")).toBeNull()
  })
})

describe("the run card's take over", () => {
  test("a live run on a box offers Take over; taken over, the same place offers Release", () => {
    const box = "3f2b8c1e-8a7d-4b2a-9c3e-1d2f3a4b5c6d"
    const header = (payload: Record<string, unknown>) => renderRun({ phase: "running", workspaceId: box, ...payload } as never).host
      .querySelector("[data-testid='run-outcome-run-1']")!
    const take = header({}).querySelector("[data-testid='flow-run-takeover-run-1']")!
    expect(take.textContent).toBe("Take over")
    expect(take.getAttribute("data-flow")).toBe("runs.takeover")
    const release = header({ takeover: { terminalSessionId: "t-1" } }).querySelector("[data-testid='flow-run-release-run-1']")!
    expect(release.textContent).toBe("Release")
    expect(release.getAttribute("data-flow")).toBe("runs.release")
    expect(renderRun({ phase: "completed", workspaceId: box } as never).host.querySelector("[data-testid^='flow-run-takeover']")).toBeNull()
  })
})
