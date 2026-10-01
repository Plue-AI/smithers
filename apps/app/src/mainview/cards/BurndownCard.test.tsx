import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import run3 from "../../../e2e/fixtures/burndown/run-3.json"
import exhausted from "../../../e2e/fixtures/burndown/exhausted.json"
import cancelled from "../../../e2e/fixtures/burndown/cancelled.json"
import sleeping from "../../../e2e/fixtures/burndown/sleeping.json"
import completed from "../../../e2e/fixtures/burndown/completed.json"
import failed from "../../../e2e/fixtures/burndown/failed.json"
import empty from "../../../e2e/fixtures/burndown/empty.json"
import overflow from "../../../e2e/fixtures/burndown/overflow.json"
import type { Card } from "../state/AppState"
import { burndownOf } from "./Burndown"
import { ACCOUNTS_RESET, BurndownBody, burndownAnnouncement, GROUP_CAP } from "./BurndownCard"

/*
 * The burndown card in each state a run and its watch can be in: what it
 * draws, and which controls it offers. A control that does not apply is
 * absent from the markup, never disabled.
 */

type RunCard = Extract<Card, { kind: "run-trace" }>
type Payload = RunCard["payload"]
type Journal = { readonly input: Record<string, unknown>; readonly events: ReadonlyArray<Record<string, unknown>> }

const card = (phase: Payload["phase"], journal: Journal | undefined, extra: Partial<Payload> = {}): RunCard => ({
  id: "flow-run-r", kind: "run-trace", title: "issue-sweep", status: "active", createdAt: 1, ordinal: 1,
  payload: {
    repo: "smithersai/smithers", runId: "r", workflow: "issue-sweep", phase, steps: [], result: null, lastSeq: 0,
    ...(journal === undefined ? {} : { input: journal.input, events: [...journal.events] }),
    ...extra
  } as Payload
})

const render = (subject: RunCard, notices?: string) =>
  renderToStaticMarkup(<BurndownBody card={subject} onRunCommand={() => {}} now={1790900100000} notices={notices} />)

/** The value of an attribute on the element with this test id. */
const attr = (markup: string, testId: string, name: string): string | undefined => {
  const tag = new RegExp(`<[^>]*data-testid="${testId}"[^>]*>`).exec(markup)?.[0]
  return tag === undefined ? undefined : new RegExp(` ${name}="([^"]*)"`).exec(tag)?.[1]
}
const has = (markup: string, testId: string) => markup.includes(`data-testid="${testId}"`)
/** A pill's words: its text past the leading dot. */
const pill = (markup: string, testId: string): string | undefined => {
  const from = markup.indexOf(`data-testid="${testId}"`)
  if (from < 0) return undefined
  const inner = markup.slice(markup.indexOf(">", from) + 1).replace(/^<span[^>]*><\/span>/, "")
  return inner.slice(0, inner.indexOf("</span>"))
}
const status = (markup: string) => pill(markup, "burndown-status")

describe("a run that has not been read yet", () => {
  test("launching: the status says so, the layout is placeholders, and there is nothing to stop or filter", () => {
    const markup = render(card("launching", undefined, { runId: "pending-abc", input: { repo: "smithersai/smithers" } }))
    expect(attr(markup, "burndown-pending-abc", "data-stage")).toBe("launching")
    expect(attr(markup, "burndown-pending-abc", "aria-busy")).toBe("true")
    expect(markup).toContain("Starting…")
    // The card's title names the repository; the board does not say it again.
    expect(markup).not.toContain("smithersai/smithers")
    for (const part of ["burndown-strip-skeleton", "burndown-meters-skeleton", "burndown-board-skeleton"]) expect(has(markup, part)).toBe(true)
    expect(markup.match(/data-skeleton="true" class="burndown-row"|class="burndown-row" data-skeleton="true"/g)).toHaveLength(GROUP_CAP)
    for (const control of ["burndown-stop", "burndown-resume", "burndown-retry", "burndown-strip", "burndown-board"]) expect(has(markup, control)).toBe(false)
    expect(markup).not.toContain("<button")
  })

  test("loading: the run is known, its board is placeholders, and its controls wait for the journal", () => {
    const markup = render(card("running", undefined))
    expect(attr(markup, "burndown-r", "data-stage")).toBe("loading")
    expect(status(markup)).toBe("Running")
    expect(has(markup, "burndown-board-skeleton")).toBe(true)
    expect(markup).not.toContain("<button")
    expect(has(markup, "burndown-strip")).toBe(false)
  })

  test("a run parked before its first listing draws no placeholder: nothing is on the way", () => {
    const markup = render(card("running", sleeping))
    expect(has(markup, "burndown-board-skeleton")).toBe(false)
    expect(has(markup, "burndown-empty")).toBe(false)
    expect(attr(markup, "burndown-r", "aria-busy")).toBe("false")
  })

  test("a journal with no round's issues yet keeps the board as placeholders, not as empty", () => {
    const markup = render(card("running", { input: {}, events: [] }))
    expect(attr(markup, "burndown-r", "data-stage")).toBe("ready")
    expect(attr(markup, "burndown-r", "aria-busy")).toBe("true")
    expect(has(markup, "burndown-board-skeleton")).toBe(true)
    expect(has(markup, "burndown-empty")).toBe(false)
    expect(has(markup, "burndown-strip")).toBe(true)
  })
})

describe("each run state: its status and only the controls that apply", () => {
  const controls = (markup: string) => ["burndown-retry", "burndown-stop", "burndown-resume"].filter((control) => has(markup, control))

  test("running", () => {
    const markup = render(card("running", run3))
    expect(status(markup)).toBe("Running")
    expect(controls(markup)).toEqual(["burndown-stop"])
    expect(attr(markup, "burndown-r", "aria-busy")).toBe("false")
    expect(has(markup, "burndown-observer")).toBe(false)
  })

  test("parked on exhausted accounts: the accounts to reset, Resume as the reset signal", () => {
    const markup = render(card("running", exhausted))
    expect(status(markup)).toBe("Parked")
    expect(controls(markup)).toEqual(["burndown-stop", "burndown-resume"])
    expect(attr(markup, "burndown-resume", "data-flow")).toBe("runs.signal")
    expect(attr(markup, "burndown-resume", "data-flow-args")).toContain(ACCOUNTS_RESET)
    expect(has(markup, "burndown-reset")).toBe(true)
  })

  test("parked until a time: the instant as a time element, and no Resume, because the timer ends the park", () => {
    const markup = render(card("running", sleeping))
    expect(status(markup)).toBe("Parked")
    expect(controls(markup)).toEqual(["burndown-stop"])
    expect(markup).toContain(`dateTime="${new Date(1790900000000 + 3_600_000).toISOString()}"`)
    expect(has(markup, "burndown-reset")).toBe(false)
  })

  test("stopped: Resume restarts the sweep with the same input", () => {
    const markup = render(card("cancelled", cancelled))
    expect(status(markup)).toBe("Cancelled")
    expect(controls(markup)).toEqual(["burndown-resume"])
    expect(attr(markup, "burndown-resume", "data-flow")).toBe("issue-sweep")
    expect(attr(markup, "burndown-resume", "data-flow-args")).toContain("smithersai/smithers")
    expect(attr(markup, "burndown-resume", "data-flow-args")).toContain("&quot;attempt&quot;:1")
  })

  test("cloud overflow: a Cloud meter of cloud children working against cloudAgents, beside the VMs; none for a run that asked for no cloud agents", () => {
    const markup = render(card("running", overflow))
    expect(has(markup, "burndown-cloud")).toBe(true)
    expect(markup.indexOf('data-testid="burndown-cloud"')).toBeGreaterThan(markup.indexOf('data-testid="burndown-machine"'))
    const cloud = markup.slice(markup.indexOf('data-testid="burndown-cloud"'), markup.indexOf('data-testid="burndown-accounts"'))
    expect(cloud).toContain(">Cloud<")
    expect(cloud).toContain('aria-valuetext="1 of 3"')
    expect(cloud).toContain(">1/3<")
    const machine = markup.slice(markup.indexOf('data-testid="burndown-machine"'), markup.indexOf('data-testid="burndown-cloud"'))
    expect(machine).toContain(">2/2<")
    expect(has(render(card("running", run3)), "burndown-cloud")).toBe(false)
  })

  test("a restart carries the run's landers and cloud agents with the rest of its input", () => {
    const markup = render(card("cancelled", { ...cancelled, input: { ...cancelled.input, landers: 3, cloudAgents: 2 } }))
    expect(attr(markup, "burndown-resume", "data-flow-args")).toContain("&quot;landers&quot;:3")
    expect(attr(markup, "burndown-resume", "data-flow-args")).toContain("&quot;cloudAgents&quot;:2")
  })

  test("finished and drained: final counts, nothing in flight, no controls", () => {
    const markup = render(card("completed", completed))
    expect(status(markup)).toBe("Finished")
    expect(controls(markup)).toEqual([])
    expect(markup).toContain('data-state="landed"')
    expect(markup).not.toContain('class="burndown-group" data-state="working"')
  })

  test("failed: the shell's failure notice sits under the header, and Resume restarts", () => {
    const markup = render(card("failed", failed, { error: failed.summary.verdict }), "NOTICE")
    expect(status(markup)).toBe("Failed")
    expect(controls(markup)).toEqual(["burndown-resume"])
    expect(markup.indexOf("NOTICE")).toBeGreaterThan(markup.indexOf("</header>"))
    expect(markup.indexOf("NOTICE")).toBeLessThan(markup.indexOf('data-testid="burndown-strip"'))
  })

  test("empty: discovery found nothing, said in two words, with no group drawn", () => {
    const markup = render(card("completed", empty))
    expect(has(markup, "burndown-empty")).toBe(true)
    expect(markup).toContain("No issues")
    expect(markup).not.toContain('class="burndown-group"')
    expect(has(markup, "burndown-board-skeleton")).toBe(false)
    expect(controls(markup)).toEqual([])
  })

  test("a state with no issue has no group", () => {
    const markup = render(card("running", run3))
    for (const state of ["skip", "claimed", "adopting", "landed", "held"]) expect(markup).not.toContain(`class="burndown-group" data-state="${state}"`)
    for (const state of ["ours", "working", "landing", "failed"]) expect(markup).toContain(`class="burndown-group" data-state="${state}"`)
  })
})

describe("the watch's state sits beside the run's status", () => {
  const observer = (markup: string) => pill(markup, "burndown-observer")

  test("reconnecting: the run keeps its status and its Stop", () => {
    const markup = render(card("reconnecting", run3))
    expect(status(markup)).toBe("Running")
    expect(observer(markup)).toBe("Reconnecting…")
    expect(has(markup, "burndown-stop")).toBe(true)
    expect(has(markup, "burndown-retry")).toBe(false)
  })

  test("quiet: Check again beside Stop", () => {
    const markup = render(card("quiet", run3))
    expect(observer(markup)).toBe("No recent progress")
    expect(attr(markup, "burndown-retry", "data-flow")).toBe("flow.run.retry")
    expect(has(markup, "burndown-stop")).toBe(true)
  })

  test("stopped watching (a refused stop leaves this): Check again, and no Stop to press at a run nobody is watching", () => {
    const markup = render(card("stopped", run3, { observationError: "The workspace refused." }))
    expect(status(markup)).toBe("Running")
    expect(observer(markup)).toBe("Stopped watching")
    expect(has(markup, "burndown-retry")).toBe(true)
    expect(has(markup, "burndown-stop")).toBe(false)
  })

  test("a stale observation says Stale in place of the health it can no longer vouch for", () => {
    const stale = { ...exhausted, events: [...exhausted.events, { sequence: 999, kind: "control.status.observed", payload: { health: "healthy", freshness: "stale", observedAt: 1 } }] }
    const machine = (markup: string) => markup.slice(markup.indexOf('data-testid="burndown-machine"'), markup.indexOf('data-testid="burndown-accounts"'))
    expect(machine(render(card("running", stale)))).toContain("Stale")
    expect(machine(render(card("running", stale)))).not.toContain("Healthy")
    expect(machine(render(card("running", exhausted)))).toContain("Healthy")
  })
})

describe("a request this card sent", () => {
  const since = burndownOf(exhausted.events).parked
  if (since.kind !== "exhausted") throw new Error("the exhausted fixture parks on the reset signal")
  const request = (state: "pending" | "failed" | "sent", afterSeq: number, error?: string) =>
    render(card("running", exhausted, { signalRequest: { name: ACCOUNTS_RESET, state, afterSeq, ...(error === undefined ? {} : { error }) } }))

  test("pending: Resume stays in place, busy", () => {
    const markup = request("pending", since.since)
    expect(attr(markup, "burndown-resume", "aria-busy")).toBe("true")
    expect(attr(markup, "burndown-resume", "aria-disabled")).toBe("true")
    expect(has(markup, "burndown-refused")).toBe(false)
  })

  test("refused: the workspace's words are shown and Resume can be pressed again", () => {
    const markup = request("failed", since.since, "The workspace is not reachable.")
    expect(has(markup, "burndown-refused")).toBe(true)
    expect(markup).toContain("The workspace is not reachable.")
    expect(attr(markup, "burndown-resume", "aria-busy")).toBe("false")
  })

  test("accepted: busy while the same park stands; a park scheduled after the signal offers Resume again", () => {
    expect(attr(request("sent", since.since, undefined), "burndown-resume", "aria-busy")).toBe("true")
    expect(attr(request("sent", since.since - 1, undefined), "burndown-resume", "aria-busy")).toBe("false")
  })

  test("another signal's request is not this control's", () => {
    const markup = render(card("running", exhausted, { signalRequest: { name: "other/signal", state: "pending", afterSeq: since.since } }))
    expect(attr(markup, "burndown-resume", "aria-busy")).toBe("false")
  })

  test("a stop the engine recorded and has not finished: Stop stays in place, busy", () => {
    const stopping = { ...run3, events: [...run3.events, { sequence: 99999, kind: "control.engine.event", payload: { executionId: "run-3", eventType: "flows.engine.run-decision",
      payload: { executionFact: { observation: { executionId: "run-3", flowName: "agent/run", status: "running", parentRunId: null, cancelRequestedAtMs: 5 } } } } }] }
    expect(attr(render(card("running", stopping)), "burndown-stop", "aria-busy")).toBe("true")
    expect(attr(render(card("running", run3)), "burndown-stop", "aria-busy")).toBe("false")
  })
})

describe("an issue's failure", () => {
  test("the row carries its state as a mark and in its name; the detail shows the reason whole", () => {
    const failedIssue = burndownOf(run3.events).items.find((item) => item.state === "failed" && (item.reason ?? "").length > 200)!
    const markup = render(card("running", run3, { burndown: { filter: "failed", item: failedIssue.number } }))
    const row = new RegExp(`<button[^>]*data-issue="${failedIssue.number}"[^>]*>.*?</button>`, "s").exec(markup)![0]
    expect(row).toContain('data-state="failed"')
    expect(row).toContain("burndown-mark")
    expect(row).toMatch(/aria-label="#\d+[^"]*, Failed(?:, [^",]+)*"/)
    const reason = /<pre[^>]*data-testid="burndown-reason"[^>]*>([^]*?)<\/pre>/.exec(markup)![1]!
    const text = reason.replace(/&quot;/g, "\"").replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    expect(text).toBe(failedIssue.reason!)
  })
})

describe("the board's keyboard and its disclosure", () => {
  test("the open issue's detail is the next thing after its row, inside the same list item, and the row controls it", () => {
    const failedIssue = burndownOf(run3.events).items.find((item) => item.state === "failed")!
    const markup = render(card("running", run3, { burndown: { item: failedIssue.number } }))
    const item = new RegExp(`<li class="burndown-item"><button[^>]*data-issue="${failedIssue.number}"[^>]*>.*?</button>(<section[^>]*>)`, "s").exec(markup)
    expect(item?.[1]).toContain('data-testid="burndown-detail"')
    const id = /id="([^"]+)"/.exec(item![1]!)![1]
    expect(new RegExp(`<button[^>]*data-issue="${failedIssue.number}"[^>]*aria-controls="${id}"`).test(markup)).toBe(true)
    expect(markup.match(/data-testid="burndown-detail"/g)).toHaveLength(1)
  })

  test("one tab stop for the whole board, the open row by default; each \"more\" control is a stop in the arrows' order, not a tab stop", () => {
    const view = burndownOf(run3.events)
    const open = view.items.filter((item) => item.state === "landing")[2]!.number
    const markup = render(card("running", run3, { burndown: { item: open } }))
    const stops = [...markup.matchAll(/<button[^>]*data-stop="([^"]+)"[^>]*>/g)]
    expect(stops.filter((stop) => / tabindex="0"/.test(stop[0])).map((stop) => stop[1])).toEqual([`${open}`])
    expect(stops.filter((stop) => stop[1]!.startsWith("more:")).map((stop) => stop[1])).toEqual(["more:ours", "more:landing", "more:failed"])
  })

  test("the strip's tab stop is the pressed filter, and each count is named by its number and word", () => {
    const markup = render(card("running", run3, { burndown: { filter: "landing" } }))
    const stop = [...markup.matchAll(/<button[^>]*class="burndown-count"[^>]*>/g)].filter((tag) => / tabindex="0"/.test(tag[0]))
    expect(stop).toHaveLength(1)
    expect(stop[0]![0]).toContain('data-state="landing"')
    expect(stop[0]![0]).toContain('aria-label="15 Landing"')
  })
})

describe("what a new reading says, once", () => {
  const child = "issue-sweep/3350/attempt-1"
  const before = burndownOf(cancelled.events.filter((event) => event.kind !== "control.run.cancelled").slice(0, -2))
  const after = burndownOf(cancelled.events)

  test("the run's new status, then each issue that moved", () => {
    expect(before.items.find((item) => item.number === 3350)?.executionId).toBe(child)
    expect(burndownAnnouncement(before, after)).toBe("Cancelled, #3350 failed")
  })

  test("the same reading says nothing", () => {
    expect(burndownAnnouncement(after, after)).toBe("")
  })

  test("more than three moves are counted by state", () => {
    const moved = { ...after, status: before.status, items: run3Items("failed") }
    const from = { ...before, items: run3Items("working") }
    expect(burndownAnnouncement(from, moved)).toBe("4 failed")
  })
})

function run3Items(state: "working" | "failed") {
  return burndownOf(run3.events).items.slice(0, 4).map((item) => ({ ...item, state }))
}
