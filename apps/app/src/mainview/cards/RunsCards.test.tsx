import { approvalActionId } from "../state/ApprovalReference"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, describe, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import type { Card } from "../state/AppState"
import { runTraceCardFamily as workflowCardFamily, WorkflowRunCardBody } from "./RunTraceCard"
import { ApprovalsInboxCardBody, RunListCardBody } from "./RunsCards"

/*
 * Lane runs — the cards themselves, per phase and waiting reason: the run
 * inbox's count line, chips and stop-all; the approvals inbox's row
 * decisions addressed by inbox, run and request; and the run card's lifecycle
 * acts (Stop on every live phase, Resume on a named wait, Run again when
 * settled), its steer row, and its transcript and events facets.
 */

GlobalRegistrator.register()

afterAll(async () => {
  // React's scheduler drains unmount work on a macrotask that reads `window`,
  // so the globals have to outlive the last teardown by a tick or two.
  for (let tick = 0; tick < 3; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  await GlobalRegistrator.unregister()
})

const REPO = "codeplanesmithers/smithers-demo"

const runListCard = (
  runs: Extract<Card, { kind: "run-list" }>["payload"]["runs"],
  status?: string
): Extract<Card, { kind: "run-list" }> => ({
  id: `run-list-${REPO}`,
  kind: "run-list",
  title: `Runs — ${REPO}`,
  status: "active",
  createdAt: 0,
  ordinal: 0,
  payload: { repo: REPO, ...(status === undefined ? {} : { status }), runs }
})

const inboxCard = (
  approvals: Extract<Card, { kind: "approvals-inbox" }>["payload"]["approvals"]
): Extract<Card, { kind: "approvals-inbox" }> => ({
  id: `approvals-inbox-${REPO}`,
  kind: "approvals-inbox",
  title: `Approvals — ${REPO}`,
  status: "active",
  createdAt: 0,
  ordinal: 0,
  payload: { repo: REPO, approvals }
})

const runCard = (
  overrides: Partial<Extract<Card, { kind: "run-trace" }>["payload"]>
): Extract<Card, { kind: "run-trace" }> => ({
  id: "flow-run-run-1",
  kind: "run-trace",
  title: "deploy — repo",
  status: "active",
  createdAt: 0,
  ordinal: 0,
  payload: {
    repo: REPO,
    runId: "run-1",
    workflow: "deploy",
    phase: "running",
    steps: ["1 turn · 2 calls"],
    result: null,
    lastSeq: 1,
    ...overrides
  }
})

const render = (element: React.ReactElement): HTMLElement => {
  const host = document.createElement("div")
  document.body.append(host)
  flushSync(() => {
    createRoot(host).render(element)
  })
  return host
}

const click = (element: Element): void => {
  ;(element as HTMLElement).click()
}

describe("the run inbox card", () => {
  test("pending and failed reads keep Refresh without claiming an empty result", () => {
    const card = runListCard([])
    card.payload.listRequest = { id: "request", owner: "owner", repo: REPO, state: "pending" }
    const pending = render(<RunListCardBody card={card} onRunCommand={() => {}} />)
    expect(pending.textContent).not.toContain("No runs match.")
    expect(pending.textContent).toContain("Refresh")
    card.payload.listRequest.state = "failed"
    card.payload.observationError = "Gateway unavailable"
    const failed = render(<RunListCardBody card={card} onRunCommand={() => {}} />)
    const notice = failed.querySelector<HTMLElement>('[data-testid="run-list-failure"]')!
    expect(notice.getAttribute("role")).toBe("alert")
    expect(notice.dataset.failure).toBe("runs.list.failed")
    expect(notice.dataset.fault).toBe("infra")
    expect(notice.querySelector(":scope > p")?.textContent).toBe("Smithers could not load this repository's runs. Not your fault.")
    expect(notice.querySelector(":scope > p")?.textContent).not.toContain("Gateway unavailable")
    expect((notice.querySelector("details") as HTMLDetailsElement).open).toBe(false)
    expect(notice.querySelector("details pre")?.textContent).toBe("Gateway unavailable")
    expect(failed.textContent).not.toContain("No runs match.")
  })

  test("a partial read says some runs could not be read and keeps the gateway's words behind Details", () => {
    const card = runListCard([{ runId: "run-new", flowId: "deploy", status: "parked", createdAt: 5, turns: 1, calls: 2 }])
    card.payload.listRequest = { id: "request", owner: "owner", repo: REPO, state: "complete" }
    card.payload.observationError = "HTTP 503 · statuses unavailable"
    const notice = render(<RunListCardBody card={card} onRunCommand={() => {}} />).querySelector<HTMLElement>('[data-testid="run-list-failure"]')!
    expect(notice.dataset.failure).toBe("runs.list.partial")
    expect(notice.querySelector(":scope > p")?.textContent).toBe("Smithers could not read every run. Not your fault.")
    expect(notice.querySelector(":scope > p")?.textContent).not.toContain("503")
    expect(notice.querySelector("details pre")?.textContent).toBe("HTTP 503 · statuses unavailable")
  })

  const runs = [
    { runId: "run-new", flowId: "deploy", status: "parked", waiting: "approval", createdAt: 5, turns: 1, calls: 2 },
    { runId: "run-old", flowId: "review-pr", status: "completed", createdAt: 1, turns: 4, calls: 9 }
  ]

  test("the header counts by status and the rows carry runId · flow · waiting · work", () => {
    const host = render(<RunListCardBody card={runListCard(runs)} onRunCommand={() => {}} />)
    expect(host.querySelector("[data-testid='run-list-counts']")?.textContent).toBe("2 runs · 1 parked · 1 completed")
    const text = host.textContent ?? ""
    expect(text).toContain("run-new")
    expect(text).toContain("deploy")
    expect(text).toContain("waiting · approval")
    expect(text).toContain("1 turn · 2 calls")
    expect(text).toContain("4 turns · 9 calls")
  })

  test("the filter chips re-invoke runs.list with the chip's argument and the workspace", () => {
    const dispatched: Array<{ name: string; args?: string }> = []
    const host = render(
      <RunListCardBody
        card={runListCard(runs)}
        onRunCommand={(name, args) => dispatched.push({ name, args })}
      />
    )
    click(host.querySelector("[data-testid='run-list-chip-parked']")!)
    expect(dispatched[0]).toEqual({ name: "runs.list", args: JSON.stringify({ status: "parked", sourceCard: `run-list-${REPO}`, repo: REPO }) })
  })

  test("the footer stops every live run through the confirming flow", () => {
    const dispatched: Array<{ name: string; args?: string }> = []
    const host = render(
      <RunListCardBody
        card={runListCard(runs)}
        onRunCommand={(name, args) => dispatched.push({ name, args })}
      />
    )
    const stopAll = host.querySelector("[data-testid='run-list-stop-all']")
    expect(stopAll?.textContent).toBe("Stop all 1")
    click(stopAll!)
    expect(dispatched[0]).toEqual({ name: "flow.run.stop-all", args: `sourceCard=run-list-${REPO} ${REPO}` })
  })

  test("a row opens its run card", () => {
    const dispatched: Array<{ name: string; args?: string }> = []
    const host = render(
      <RunListCardBody
        card={runListCard(runs)}
        onRunCommand={(name, args) => dispatched.push({ name, args })}
      />
    )
    click(host.querySelector("[data-testid='runs-open-run-old']")!)
    expect(dispatched[0]).toEqual({ name: "runs.open", args: `sourceCard=run-list-${REPO} run-old` })
  })
})

describe("the run inbox's groups", () => {
  const row = (runId: string, status: string, waiting?: string) =>
    ({ runId, flowId: `flow/${runId}`, status, ...(waiting === undefined ? {} : { waiting }), createdAt: 1, turns: 0, calls: 0 })
  const all = [
    row("gate", "waiting-approval"), row("question", "parked", "approval"), row("cap", "parked", "budget"), row("held", "parked", "parked"),
    row("new", "accepted", "executor"), row("busy", "running"), row("limit", "parked", "quota"), row("clock", "parked", "timer"),
    row("signal", "parked", "event"), row("done", "completed"), row("broke", "failed"), row("gone", "cancelled")
  ]
  const ids = (host: HTMLElement, group: string) =>
    [...host.querySelectorAll(`[data-testid='runs-inbox-${group}'] li`)].map((li) => li.querySelector(".world-card-path")?.textContent)
  const heading = (host: HTMLElement, group: string) =>
    host.querySelector(`[data-testid='runs-inbox-${group}'] h3`)?.textContent

  test("a person's parks need you; clocks, provider limits and events work; settled runs are done", () => {
    const host = render(<RunListCardBody card={runListCard(all)} onRunCommand={() => {}} />)
    expect(ids(host, "needs-you")).toEqual(["gate", "question", "cap", "held"])
    expect(ids(host, "working")).toEqual(["new", "busy", "limit", "clock", "signal"])
    expect(ids(host, "done")).toEqual(["done", "broke", "gone"])
    expect(heading(host, "needs-you")).toBe("◆ Needs you 4")
    expect(heading(host, "working")).toBe("◐ Working 5")
    expect(heading(host, "done")).toBe("● Done 3")
    const tones = [...host.querySelectorAll("li[data-tone]")].map((li) => `${li.querySelector(".world-card-path")?.textContent}:${li.getAttribute("data-tone")}`)
    expect(tones).toEqual([
      "gate:needs-you", "question:needs-you", "cap:needs-you", "held:needs-you",
      "new:working", "busy:working", "limit:parked", "clock:parked", "signal:working",
      "done:completed", "broke:failed", "gone:cancelled"
    ])
  })

  test("a gate only an admin decides offers no Answer to anyone else, as on the run card", () => {
    const setup = { ...row("setup", "waiting-approval"), flowId: "register-repository" }
    expect(render(<RunListCardBody card={runListCard([setup])} onRunCommand={() => {}} />)
      .querySelector("[data-testid='runs-answer-setup']")).toBeNull()
    expect(render(<RunListCardBody admin card={runListCard([setup])} onRunCommand={() => {}} />)
      .querySelector("[data-testid='runs-answer-setup']")).not.toBeNull()
  })

  test("an empty group is absent", () => {
    const host = render(<RunListCardBody card={runListCard([row("done", "completed")])} onRunCommand={() => {}} />)
    expect(host.querySelector("[data-testid='runs-inbox-needs-you']")).toBeNull()
    expect(host.querySelector("[data-testid='runs-inbox-working']")).toBeNull()
    expect(heading(host, "done")).toBe("● Done 1")
  })

  test("a gate or cap is answered through approvals.open; an operator's park resumes; nothing else asks", () => {
    const dispatched: Array<{ name: string; args?: string }> = []
    const host = render(<RunListCardBody card={runListCard(all)} onRunCommand={(name, args) => dispatched.push({ name, args })} />)
    const answers = [...host.querySelectorAll("[data-testid^='runs-answer-']")]
    expect(answers.map((button) => button.getAttribute("data-testid"))).toEqual(["runs-answer-gate", "runs-answer-question", "runs-answer-cap"])
    expect(answers.every((button) => button.textContent === "Answer" && button.tagName === "BUTTON")).toBe(true)
    click(answers[2]!)
    expect(dispatched.at(-1)).toEqual({ name: "approvals.open", args: `sourceCard=run-list-${REPO} cap` })
    expect([...host.querySelectorAll("[data-testid^='runs-resume-']")].map((button) => button.getAttribute("data-testid"))).toEqual(["runs-resume-held"])
    click(host.querySelector("[data-testid='runs-resume-held']")!)
    expect(dispatched.at(-1)).toEqual({ name: "runs.resume", args: `sourceCard=run-list-${REPO} held` })
    expect(host.querySelectorAll("[data-testid^='runs-open-']").length).toBe(all.length)
  })

  test("a provider limit says whose fault it is and asks nothing", () => {
    const host = render(<RunListCardBody card={runListCard(all)} onRunCommand={() => {}} />)
    expect([...host.querySelectorAll("[data-testid^='runs-limit-']")].map((node) => node.getAttribute("data-testid"))).toEqual(["runs-limit-limit"])
    expect(host.querySelector("[data-testid='runs-limit-limit']")?.textContent).toBe("Not your fault · @fucory")
    expect(host.textContent).toContain("spend cap")
  })

  test("a pending approval joins its run's row, or stands as its own needs-you row", () => {
    const dispatched: Array<{ name: string; args?: string }> = []
    const card = runListCard([row("gate", "waiting-approval"), row("done", "completed")], "attention")
    card.payload.approvals = [
      { runId: "gate", requestId: "r-1", title: "Deploy?" },
      { runId: "elsewhere", requestId: "r-2", title: "Which auth?" }
    ]
    const host = render(<RunListCardBody card={card} onRunCommand={(name, args) => dispatched.push({ name, args })} />)
    expect(ids(host, "needs-you")).toEqual(["elsewhere", "gate"])
    expect(heading(host, "needs-you")).toBe("◆ Needs you 2")
    /* The joined gate's own words are on its run's row before anyone opens it. */
    expect(host.querySelector("[data-testid='runs-gate-gate']")?.textContent).toBe("Deploy?")
    expect(host.textContent).toContain("Which auth?")
    click(host.querySelector("[data-testid='runs-answer-elsewhere']")!)
    expect(dispatched.at(-1)).toEqual({ name: "approvals.open", args: `sourceCard=run-list-${REPO} elsewhere` })
  })
})

describe("the approvals inbox card", () => {
  const gate = {
    runId: "run-a",
    requestId: "req-1",
    title: "Run the deploy script?",
    approval: { target: { _tag: "Node" }, scope: "run", idempotencyKey: "k" },
    requestedAt: Date.now()
  }

  test("the count leads and a decision dispatches the row id", () => {
    const decisions: Array<{ id: string; decision: string }> = []
    const host = render(
      <ApprovalsInboxCardBody
        card={inboxCard([gate])}
        onDecideApproval={(id, decision) => decisions.push({ id, decision })}
      />
    )
    expect(host.querySelector("[data-testid='approvals-inbox-count']")?.textContent).toContain("1 approval pending")
    expect(host.textContent).toContain("Run the deploy script?")
    expect(host.textContent).toContain("run run-a")
    const approve = [...host.querySelectorAll("button")].find((button) =>
      button.textContent?.toLowerCase().includes("approve")
    )
    click(approve!)
    expect(decisions[0]).toEqual({ id: approvalActionId(`approvals-inbox-${REPO}`, { runId: "run-a", requestId: "req-1" }), decision: "approved" })
  })

  test("a guard's park reads as its incident and is decided as Continue or Stop", () => {
    const incident = { classification: "Runaway" as const, message: "The run would spend past its $1.00 budget" }
    const parked = { ...gate, requestId: "budget/run-a/usd", title: "Raise the USD budget from $1.00 to $2.20?", incident }
    const decisions: Array<{ id: string; decision: string }> = []
    const host = render(<ApprovalsInboxCardBody card={inboxCard([parked])} onDecideApproval={(id, decision) => decisions.push({ id, decision })} />)
    const prompt = host.querySelector(".sui-approval-question")
    expect(prompt?.textContent).toBe("Runaway · Raise the USD budget from $1.00 to $2.20?")
    expect(prompt?.getAttribute("title")).toBe(incident.message)
    const buttons = [...host.querySelectorAll("button")].filter((button) => button.getAttribute("data-slot") === "confirmation-action")
    expect(buttons.map((button) => button.textContent)).toEqual(["Continue", "Stop"])
    click(buttons[0]!)
    click(buttons[1]!)
    const id = approvalActionId(`approvals-inbox-${REPO}`, { runId: "run-a", requestId: "budget/run-a/usd" })
    expect(decisions).toEqual([{ id, decision: "approved" }, { id, decision: "denied" }])
    // Decided, the row says what the person chose in the incident's words.
    const at = Date.UTC(2026, 8, 30, 12, 0)
    const stopped = render(<ApprovalsInboxCardBody card={inboxCard([{ ...parked, decision: "denied", decidedAt: at }])} onDecideApproval={() => {}} />)
    expect(stopped.textContent).toContain("Stopped — ")
    const continued = render(<ApprovalsInboxCardBody card={inboxCard([{ ...parked, decision: "approved", decidedAt: at }])} onDecideApproval={() => {}} />)
    expect(continued.textContent).toContain("Continued — ")
  })

  test("grants and questions count apart", () => {
    const host = render(<ApprovalsInboxCardBody card={inboxCard([
      gate,
      { ...gate, requestId: "q-1", title: "Human input", question: { kind: "ask", prompt: "Which service owns retries?" } },
    ])} onDecideApproval={() => {}} />)
    expect(host.querySelector("[data-testid='approvals-inbox-count']")?.textContent).toBe("1 approval pending · 1 question pending")
  })

  test("only undecided rows count as pending, including in-flight and failed submissions", () => {
    const host = render(<ApprovalsInboxCardBody card={inboxCard([
      { ...gate, requestId: "approved", decision: "approved" },
      { ...gate, requestId: "denied", decision: "denied" },
      { ...gate, requestId: "sending", pending: true },
      { ...gate, requestId: "failed", decisionError: "Offline" },
    ])} onDecideApproval={() => {}} />)
    expect(host.querySelector("[data-testid='approvals-inbox-count']")?.textContent).toBe("2 approvals pending")
    const settled = render(<ApprovalsInboxCardBody card={inboxCard([
      { ...gate, decision: "approved" },
      { ...gate, requestId: "denied", decision: "denied" },
    ])} onDecideApproval={() => {}} />)
    expect(settled.querySelector("[data-testid='approvals-inbox-count']")?.textContent).toBe("0 approvals pending")
  })

  for (const decision of ["approved", "denied"] as const) {
    test(`a ${decision} row retains its grant title or human question without answer controls`, () => {
      const host = render(<ApprovalsInboxCardBody card={inboxCard([
        { ...gate, decision },
        { ...gate, requestId: "question", title: "Human input", decision,
          question: { kind: "ask", prompt: "Which service owns the retry budget?" } },
      ])} onDecideApproval={() => {}} />)
      expect([...host.querySelectorAll(".sui-approval-question")].map(node => node.textContent))
        .toEqual(["Run the deploy script?", "Which service owns the retry budget?"])
      expect(host.querySelectorAll("button, textarea, input").length).toBe(0)
    })
  }

  test("a decided row freezes; a refused one names the error", () => {
    const decided = render(
      <ApprovalsInboxCardBody card={inboxCard([{ ...gate, decision: "approved" }])} onDecideApproval={() => {}} />
    )
    expect(decided.textContent).toContain("Approved")
    const refused = render(
      <ApprovalsInboxCardBody
        card={inboxCard([{ ...gate, decisionError: "Stale: already decided" }])}
        onDecideApproval={() => {}}
      />
    )
    const notice = refused.querySelector<HTMLElement>('[data-testid="approval-decision-failure"]')!
    expect(notice.dataset.failure).toBe("approval.decide")
    expect(notice.dataset.fault).toBe("infra")
    expect(notice.querySelector(":scope > p")?.textContent).toBe("Smithers could not record this decision. Not your fault.")
    expect(notice.querySelector(":scope > p")?.textContent).not.toContain("Stale")
    expect((notice.querySelector("details") as HTMLDetailsElement).open).toBe(false)
    expect(notice.querySelector("details pre")?.textContent).toBe("Stale: already decided")
  })

  /*
   * The resolution stamp answers WHEN the decision was taken. A gate raised in
   * the morning and answered in the afternoon must read the afternoon time —
   * stamping requestedAt told the human the decision happened at the moment
   * the gate was raised.
   */
  test("a decided row stamps the decision time, not the request time", () => {
    const midnight = new Date()
    midnight.setHours(0, 0, 0, 0)
    const requestedAt = midnight.getTime() + 9 * 3_600_000 + 5 * 60_000
    const decidedAt = midnight.getTime() + 14 * 3_600_000 + 47 * 60_000
    const reading = (at: number): string =>
      new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    const approved = render(
      <ApprovalsInboxCardBody
        card={inboxCard([{ ...gate, requestedAt, decision: "approved", decidedAt }])}
        onDecideApproval={() => {}}
      />
    )
    expect(approved.querySelector("[data-slot='confirmation-accepted']")?.textContent)
      .toBe(`Approved — ${reading(decidedAt)}`)
    expect(approved.querySelector("[data-slot='confirmation-accepted']")?.textContent)
      .not.toContain(reading(requestedAt))
    const denied = render(
      <ApprovalsInboxCardBody
        card={inboxCard([{ ...gate, requestedAt, decision: "denied", decidedAt }])}
        onDecideApproval={() => {}}
      />
    )
    expect(denied.querySelector("[data-slot='confirmation-rejected']")?.textContent)
      .toBe(`Denied — ${reading(decidedAt)}`)
  })

  test("a decided row with no decision time states the decision alone", () => {
    const host = render(
      <ApprovalsInboxCardBody card={inboxCard([{ ...gate, decision: "denied" }])} onDecideApproval={() => {}} />
    )
    expect(host.querySelector("[data-slot='confirmation-rejected']")?.textContent).toBe("Denied")
  })
})

describe("the run card, per phase and waiting reason", () => {
  const renderRun = (
    overrides: Partial<Extract<Card, { kind: "run-trace" }>["payload"]>,
    debugVerbose = false
  ): { host: HTMLElement; dispatched: Array<{ name: string; args?: string }> } => {
    const dispatched: Array<{ name: string; args?: string }> = []
    const host = render(
      <WorkflowRunCardBody
        card={runCard(overrides)}
        onStopRun={() => {}}
        onRetryRun={() => {}}
        onRunCommand={(name, args) => dispatched.push({ name, args })}
        debugVerbose={debugVerbose}
      />
    )
    return { host, dispatched }
  }

  test("cancellation uses the stopped badge while failures and capacity refusals stay failed", () => {
    expect(workflowCardFamily["run-trace"].pill(runCard({ phase: "cancelled" }))).toBe("stopped")
    for (const phase of ["failed", "no-capacity"] as const) {
      expect(workflowCardFamily["run-trace"].pill(runCard({ phase }))).toBe("failed")
    }
  })

  test("a live phase offers Stop and the steer row", () => {
    const { host } = renderRun({ phase: "running" })
    expect(host.querySelector("[data-testid='flow-run-stop-run-1']")).not.toBeNull()
    expect(host.querySelector("[data-testid='flow-run-steer-run-1']")).not.toBeNull()
    expect(host.querySelector("[data-testid='flow-run-rerun-run-1']")).toBeNull()
  })

  test("accepted reads 'nothing is driving it' and offers Resume", () => {
    const { host, dispatched } = renderRun({ phase: "running", waiting: "executor" })
    expect(host.textContent).toContain("Accepted — waiting for an executor.")
    const resume = host.querySelector("[data-testid='flow-run-resume-run-1']")
    expect(resume).not.toBeNull()
    click(resume!)
    expect(dispatched[0]).toEqual({ name: "runs.resume", args: "sourceCard=flow-run-run-1 run-1" })
  })

  test("a parked wait names its reason; an approval wait offers no Resume (the gate answers)", () => {
    const quota = renderRun({ phase: "running", waiting: "quota" })
    expect(quota.host.textContent).toContain("Waiting on quota.")
    expect(quota.host.querySelector("[data-testid='flow-run-resume-run-1']")).not.toBeNull()
    const approval = renderRun({ phase: "waiting-approval", waiting: "approval" })
    expect(approval.host.querySelector("[data-testid='flow-run-resume-run-1']")).toBeNull()
  })

  test("a terminal phase offers Run again and no steer row", () => {
    const { host, dispatched } = renderRun({ phase: "completed", result: "done." })
    expect(host.querySelector("[data-testid='flow-run-steer-run-1']")).toBeNull()
    expect(host.querySelector("[data-testid='flow-run-stop-run-1']")).toBeNull()
    const rerun = host.querySelector("[data-testid='flow-run-rerun-run-1']")
    expect(rerun).not.toBeNull()
    click(rerun!)
    expect(dispatched[0]).toEqual({ name: "runs.rerun", args: "sourceCard=flow-run-run-1 run-1" })
  })

  for (const phase of ["completed", "failed", "cancelled", "no-capacity"] as const) {
    test(`a ${phase} run does not promise another turn for pending steering`, () => {
      const { host } = renderRun({ phase, steeringPending: true })
      expect(host.textContent).not.toContain("steering pending")
      expect(host.textContent).not.toContain("delivered at the next turn")
    })
  }

  test("a queued steer reads 'steering pending · delivered at the next turn'", () => {
    const { host } = renderRun({ phase: "running", steeringPending: true })
    expect(host.textContent).toContain("steering pending · delivered at the next turn")
  })

  test("the steer row dispatches runs.steer with the message", () => {
    const { host, dispatched } = renderRun({ phase: "running" })
    const input = host.querySelector("[data-testid='flow-run-steer-input-run-1']") as HTMLInputElement
    flushSync(() => {
      // React tracks the value through the native setter — assign through it or onChange never fires.
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "use the smaller diff")
      input.dispatchEvent(new Event("input", { bubbles: true }))
    })
    const send = [...host.querySelectorAll("button")].find((button) => button.textContent === "Steer")
    expect((send as HTMLButtonElement | undefined)?.disabled).toBe(false)
    flushSync(() => {
      send?.click()
    })
    expect(dispatched[0]).toEqual({ name: "runs.steer", args: "sourceCard=flow-run-run-1 run-1 use the smaller diff" })
  })

  test("the transcript facet renders its rows; the steps tab is the way back", () => {
    const { host, dispatched } = renderRun({
      phase: "running",
      facet: "transcript",
      transcriptRows: [{ sequence: 1, turn: 1, at: 100, kind: "agent.turn.started", text: "turn 1 begins" }]
    })
    expect(host.querySelector("[data-testid='flow-run-transcript-run-1']")?.textContent).toContain("turn 1 begins")
    click(host.querySelector("[data-testid='flow-run-facet-steps-run-1']")!)
    expect(dispatched[0]).toEqual({ name: "runs.steps", args: "sourceCard=flow-run-run-1 run-1" })
  })

  test("the events tab exists only under verbose, and renders the raw event JSON", () => {
    const quiet = renderRun({ phase: "running" }, false)
    expect(quiet.host.querySelector("[data-testid='flow-run-facet-events-run-1']")).toBeNull()
    const verbose = renderRun({
      phase: "running",
      facet: "events",
      events: [{ kind: "control.run.accepted", sequence: 1 }]
    }, true)
    expect(verbose.host.querySelector("[data-testid='flow-run-events-run-1']")?.textContent)
      .toContain("control.run.accepted")
  })
})
