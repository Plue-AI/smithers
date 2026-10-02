import { describe, expect, test } from "bun:test"
import run3 from "../../../e2e/fixtures/burndown/run-3.json"
import exhausted from "../../../e2e/fixtures/burndown/exhausted.json"
import cancelled from "../../../e2e/fixtures/burndown/cancelled.json"
import sleeping from "../../../e2e/fixtures/burndown/sleeping.json"
import completed from "../../../e2e/fixtures/burndown/completed.json"
import failed from "../../../e2e/fixtures/burndown/failed.json"
import empty from "../../../e2e/fixtures/burndown/empty.json"
import overflow from "../../../e2e/fixtures/burndown/overflow.json"
import {
  BURNDOWN_STATES, burndownAgent, burndownControls, burndownMoves, burndownObserver, burndownOf, burndownStage, diffStat, exhaustedAccounts, PLACEMENT_WORDS, salvage
} from "./Burndown"

type Events = ReadonlyArray<Record<string, unknown>>

/* One engine row as `run-events` carries it. */
let sequence = 0
const engine = (executionId: string, eventType: string, payload: Record<string, unknown>) => ({
  sequence: sequence++, kind: "control.engine.event", runId: "run-t", occurredAt: sequence,
  payload: { version: 1, executionId, eventType, payload, meta: {} }
})
const scheduled = (executionId: string, action: string, nodeId = action) =>
  engine(executionId, "flows.engine.node-scheduled", { action, nodeId, attempt: 1 })
const settled = (executionId: string, action: string, outcome: string, value?: unknown, nodeId = action, cut?: number) => {
  const text = value === undefined ? undefined : JSON.stringify(value)
  return engine(executionId, "flows.engine.node-settled", {
    action, nodeId, outcome,
    ...(text === undefined ? {} : { result: { bytes: text.length, preview: cut === undefined ? text : text.slice(0, cut), truncated: cut !== undefined && cut < text.length } })
  })
}
const decision = (executionId: string, status: string, extra: Record<string, unknown> = {}) =>
  engine(executionId, "flows.engine.run-decision", { decision: "transitioned", executionFact: { observation: {
    executionId, flowName: "issue-sweep/work", status, createdAtMs: 10, startedAtMs: 10, finishedAtMs: null, ...extra } } })
const listed = (...numbers: Array<number>) =>
  settled("rounds", "issue-sweep/list-issues", "built", numbers.map((number) => ({ id: String(number), number, title: `Issue ${number}`, labels: [] })))
const dispatched = (rows: Array<{ id: string; status: string; detail: string }>) =>
  settled("rounds", "issue-sweep/dispatch", "built", { rows, launched: rows.length, deferred: 0 })
const report = { agent: "codex", account: "codex-3", workspace: "/w", base: "b", change: "c", report: "r",
  changed: "a.ts | 3 +-\n2 files changed, 12 insertions(+), 4 deletions(-)", patch: "diff --git a/a.ts b/a.ts\n" }
const stateOf = (events: Events, number: number) => burndownOf(events).items.find((item) => item.number === number)?.state

describe("salvage reads a preview cut at 2 KB", () => {
  test("a complete text parses whole", () => {
    expect(salvage("{\"a\":1,\"b\":[true,null]}")).toEqual({ value: { a: 1, b: [true, null] }, complete: true })
  })

  test("complete leading fields survive and the cut field is dropped", () => {
    expect(salvage("{\"agent\":\"codex\",\"account\":\"codex-4\",\"report\":\"Fixed tw")).toEqual({
      value: { agent: "codex", account: "codex-4" }, complete: false
    })
  })

  test("a cut array keeps its complete elements and the complete fields of the cut one", () => {
    expect(salvage("[{\"number\":1,\"title\":\"a\"},{\"number\":2,\"tit")).toEqual({
      value: [{ number: 1, title: "a" }, { number: 2 }], complete: false
    })
  })

  test("a number that runs to the cut is not trusted: 12 may be 1234", () => {
    expect(salvage("{\"slots\":12")?.value).toEqual({})
    expect(salvage("{\"slots\":12}")?.value).toEqual({ slots: 12 })
  })

  test("escapes inside strings do not end them", () => {
    expect(salvage("{\"m\":\"say \\\"hi\\\"\\n\",\"n\":1}")?.value).toEqual({ m: "say \"hi\"\n", n: 1 })
  })

  test("nothing complete, garbage and blank text answer undefined and never throw", () => {
    for (const text of ["", "   ", "\"cut", "{\"a", "nul", "<html>", "{\"a\" 1}"]) {
      expect(() => salvage(text)).not.toThrow()
    }
    expect(salvage("")).toBeUndefined()
    expect(salvage("\"cut")).toBeUndefined()
    expect(salvage("<html>")).toBeUndefined()
    expect(salvage("{\"a")?.value).toEqual({})
  })
})

describe("the parsers the projection reads", () => {
  test("diffStat reads jj diff --stat's summary line, singular and missing parts included", () => {
    expect(diffStat(report.changed)).toEqual({ files: 2, insertions: 12, deletions: 4 })
    expect(diffStat("1 file changed, 1 insertion(+)")).toEqual({ files: 1, insertions: 1, deletions: 0 })
    expect(diffStat("3 files changed, 2 deletions(-)")).toEqual({ files: 3, insertions: 0, deletions: 2 })
    expect(diffStat("no summary")).toBeUndefined()
  })

  test("exhaustedAccounts reads every account and its state from the capacity detail", () => {
    expect(exhaustedAccounts("reset accounts: codex-1 (usage limit until 18:00), claude-2 (signed out)")).toEqual([
      { label: "codex-1", state: "usage limit until 18:00" },
      { label: "claude-2", state: "signed out" }
    ])
    expect(exhaustedAccounts("reset accounts: no signed-in accounts")).toEqual([])
    // A model cooldown's state holds its own parenthesis (flows/issue-sweep/accounts.ts cooledPool).
    expect(exhaustedAccounts("reset accounts: codex-1 (cooling (codex-1@gpt-6.1-sol)), claude-2 (cooling (claude-2))")).toEqual([
      { label: "codex-1", state: "cooling (codex-1@gpt-6.1-sol)" },
      { label: "claude-2", state: "cooling (claude-2)" }
    ])
  })
})

describe("the recorded run-3 journal (issue-sweep, placement vm, 32 slots)", () => {
  const view = burndownOf(run3.events, { phase: "running", input: run3.input })

  test("counts what the live run reported: 3 working, 15 awaiting landing, 24 failed, 11 discovered without a child", () => {
    expect(view.counts).toEqual({ skip: 0, ours: 11, claimed: 0, working: 3, adopting: 0, landing: 15, landed: 0, held: 0, failed: 24 })
    expect(view.items).toHaveLength(53)
    expect(view.status).toBe("running")
  })

  test("capacity is the round's 32 slots against the 3 in flight, each in a local microVM", () => {
    expect(view.capacity).toEqual({ slots: 32, active: 3 })
    expect(view.machine).toMatchObject({ health: "healthy", freshness: "fresh", vms: 3, maxAgents: 32 })
    expect(view.parked).toEqual({ kind: "none" })
  })

  test("a landed-pending item carries its account and the diff stat from its truncated report", () => {
    const item = view.items.find((each) => each.number === 3219)
    expect(item).toMatchObject({ state: "landing", account: "codex-4", agent: "codex", placement: "vm", diff: { files: 3, insertions: 67, deletions: 1 } })
    // The report was cut before its patch, so no patch is claimed.
    expect(item?.patch).toBeUndefined()
    expect(item!.startedAt).toBeLessThan(item!.finishedAt!)
  })

  test("a failed item carries the agent's own message as its failure detail, and its account parsed from it", () => {
    const item = view.items.find((each) => each.number === 3252)
    expect(item?.state).toBe("failed")
    expect(item?.account).toBe("codex-1")
    // Raw journal words are a diagnostic (RawErrorRender.test.ts), never the authored reason.
    expect(item?.failure).toStartWith("codex-1 on issue-sweep:smithersai/smithers#3252: no change:")
    expect(item?.reason).toBeUndefined()
  })

  test("every item is titled: from the discovery the preview kept, else from its child's fetched issue", () => {
    expect(view.items.find((each) => each.number === 3334)?.title).toBe("App: agent-pinnable rail icons for any flow (rail empty by default)")
    // 3168 fell past the cut discovery; its fetch-issue preview leads with the title.
    expect(view.items.find((each) => each.number === 3168)?.title).toBe("Production workspaces boot without the smithers CLI or bootstrap artifacts")
    expect(view.items.every((each) => each.title !== undefined)).toBe(true)
  })

  test("accounts are every account seen, none needing a reset while capacity is available", () => {
    expect(view.accounts.map((account) => account.label)).toEqual(["codex-1", "codex-2", "codex-3", "codex-4", "codex-5", "codex-acct-1"])
    expect(view.accounts.every((account) => !account.needsReset)).toBe(true)
    expect(view.accounts.reduce((sum, account) => sum + account.failed, 0)).toBe(23)
  })

  test("items run in board order, then newest issue first", () => {
    const ranks = view.items.map((item) => BURNDOWN_STATES.indexOf(item.state))
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b))
    const failed = view.items.filter((item) => item.state === "failed").map((item) => item.number)
    expect(failed).toEqual([...failed].sort((a, b) => b - a))
  })
})

describe("synthesized journals for states run-3 lacks", () => {
  test("exhausted: parked on the reset signal, naming each account to reset", () => {
    const view = burndownOf(exhausted.events, { phase: "running", input: exhausted.input })
    expect(view.status).toBe("parked")
    // `since` is the journal sequence of the open wait: the signal the card sends is judged against it.
    const wait = exhausted.events.find((event) => (event.payload as { payload?: { action?: string } }).payload?.action === "system/wait-for")!
    expect(view.parked).toEqual({ kind: "exhausted", since: wait.sequence, accounts: [
      { label: "codex-1", state: "usage limit until 18:00" }, { label: "claude-2", state: "signed out" }
    ] })
    expect(view.accounts.filter((account) => account.needsReset).map((account) => account.label)).toEqual(["claude-2", "codex-1"])
    expect(view.capacity.slots).toBeUndefined()
  })

  test("exhausted: the first round's dispatch rows settle landed, held, skipped and failed", () => {
    const view = burndownOf(exhausted.events, { phase: "running", input: exhausted.input })
    expect(view.counts).toMatchObject({ skip: 1, ours: 1, landed: 1, held: 1, failed: 1, landing: 0 })
    expect(view.items.find((item) => item.number === 3350)).toMatchObject({
      state: "landed", commit: "7f3a9c21b0de", agent: "claude", account: "claude-2", placement: "local",
      diff: { files: 2, insertions: 14, deletions: 3 }
    })
    expect(view.items.find((item) => item.number === 3350)?.patch).toStartWith("diff --git")
    expect(view.items.find((item) => item.number === 3346)?.reason).toBe("#3346 is closed; change vpkunskurvxukzwxprwnsmrrmytwxmzo not landed")
  })

  test("cancelled: the run and its interrupted child both read cancelled", () => {
    const view = burndownOf(cancelled.events, { phase: "cancelled", input: cancelled.input })
    expect(view.status).toBe("cancelled")
    expect(view.items.find((item) => item.number === 3350)).toMatchObject({ state: "failed", reason: "cancelled", placement: "local" })
    // The journal's own control.run.cancelled agrees without a phase.
    expect(burndownOf(cancelled.events).status).toBe("cancelled")
  })

  test("wait-until: parked on a timer until the capacity's instant", () => {
    const view = burndownOf(sleeping.events)
    expect(view.parked).toEqual({ kind: "wait-until", at: 1790900000000 + 3_600_000 })
    expect(view.status).toBe("parked")
  })

  test("completed: every issue is settled, nothing is in flight or parked, and the counts are final", () => {
    const view = burndownOf(completed.events, { phase: "completed", input: completed.input })
    expect(view.status).toBe("completed")
    expect(view.counts).toEqual({ skip: 1, ours: 0, claimed: 0, working: 0, adopting: 0, landing: 0, landed: 2, held: 1, failed: 1 })
    expect(view.capacity.active).toBe(0)
    expect(view.parked).toEqual({ kind: "none" })
    expect(view.discovered).toBe(true)
    expect(view.failure).toBeUndefined()
    // The journal's own control.run.completed agrees without a phase.
    expect(burndownOf(completed.events).status).toBe("completed")
  })

  test("failed: the run's status and its summary's message; the issue whose workspace failed says why", () => {
    const view = burndownOf(failed.events, { phase: "failed", error: failed.summary.verdict, input: failed.input })
    expect(view.status).toBe("failed")
    expect(view.failure).toBe(failed.summary.verdict)
    expect(view.items.find((item) => item.number === 3350)).toMatchObject({ state: "failed" })
    expect(view.items.find((item) => item.number === 3350)?.failure).toContain("No space left on device")
    expect(view.items.find((item) => item.number === 3349)?.state).toBe("ours")
    expect(burndownOf(failed.events).status).toBe("failed")
  })

  test("completed: an issue landed in an earlier round keeps the title that round read, though the last round no longer lists it", () => {
    const view = burndownOf(completed.events, { phase: "completed", input: completed.input })
    expect(view.items.find((item) => item.number === 3350)).toMatchObject({ state: "landed", title: "Burndown card: count tiles stay put while rows move" })
    expect(view.items.find((item) => item.number === 3346)).toMatchObject({ state: "failed", title: "Landing fails: the issue was closed meanwhile" })
    expect(view.items.every((item) => item.title !== undefined)).toBe(true)
  })

  test("an issue an earlier round listed and the latest does not, with no child and no row, is no longer on the board", () => {
    const view = burndownOf([listed(7, 8), listed(8)])
    expect(view.items.map((item) => item.number)).toEqual([8])
  })

  test("a message is a failed run's alone: a live or finished run carries none", () => {
    expect(burndownOf(run3.events, { phase: "running", error: "stale words" }).failure).toBeUndefined()
    expect(burndownOf(completed.events, { phase: "completed", error: "stale words" }).failure).toBeUndefined()
    expect(burndownOf(failed.events, { phase: "failed", error: "" }).failure).toBeUndefined()
  })

  test("empty: discovery answered with no issue, so the board is empty and not unread", () => {
    const view = burndownOf(empty.events, { phase: "completed", input: empty.input })
    expect(view.items).toEqual([])
    expect(view.discovered).toBe(true)
    expect(view.status).toBe("completed")
    expect(view.accounts).toEqual([])
  })
})

describe("cloud overflow (synthesized: vm children on this Mac, cloud children beyond them)", () => {
  const view = burndownOf(overflow.events, { phase: "running", input: overflow.input })

  test("each child runs where its own payload says, never where the run's input says", () => {
    const where = Object.fromEntries(view.items.map((item) => [item.number, item.placement]))
    expect(where).toEqual({ 3360: "vm", 3359: "vm", 3358: "cloud", 3357: "cloud", 3356: "cloud", 3355: undefined })
  })

  test("the VMs count the vm children working; the cloud meter counts cloud children working against cloudAgents", () => {
    expect(view.machine.vms).toBe(2)
    expect(view.machine.cloud).toEqual({ active: 1, agents: 3 })
  })

  test("the placement choices beside the children are not issues, and a remote Claude account is read", () => {
    expect(view.items).toHaveLength(6)
    expect(view.counts).toMatchObject({ ours: 1, working: 3, adopting: 1, landing: 1 })
    expect(view.items.find((item) => item.number === 3356)).toMatchObject({ agent: "claude", account: "claude-1", state: "landing" })
    expect(view.accounts.map((account) => account.label)).toEqual(["claude-1", "codex-4"])
  })
})

describe("the card's states", () => {
  const ready = { phase: "running", runId: "run-3", events: run3.events }

  test("launching: a card with no run yet, whatever it holds; loading: a run whose journal is unread; else ready", () => {
    expect(burndownStage({ phase: "launching", runId: "pending-abc" })).toBe("launching")
    expect(burndownStage({ phase: "launching", runId: "run-9", events: [] })).toBe("launching")
    expect(burndownStage({ phase: "running", runId: "pending-abc" })).toBe("launching")
    expect(burndownStage({ phase: "running", runId: "" })).toBe("launching")
    expect(burndownStage({ phase: "running", runId: "run-9" })).toBe("loading")
    expect(burndownStage({ phase: "completed", runId: "run-9" })).toBe("loading")
    expect(burndownStage({ phase: "running", runId: "run-9", events: [] })).toBe("ready")
    expect(burndownStage(ready)).toBe("ready")
  })

  test("a journal read before any round listed the issues is undiscovered", () => {
    expect(burndownOf([]).discovered).toBe(false)
    expect(burndownOf([scheduled("rounds", "issue-sweep/list-issues")]).discovered).toBe(false)
    expect(burndownOf([listed()]).discovered).toBe(true)
    expect(burndownOf(run3.events).discovered).toBe(true)
  })

  test("the watch's state is the phases about this client; every other phase is connected", () => {
    expect(["reconnecting", "quiet", "stopped"].map(burndownObserver)).toEqual(["reconnecting", "quiet", "stopped"])
    expect(["launching", "running", "waiting-approval", "completed", "failed", "cancelled", "no-capacity", undefined].map(burndownObserver))
      .toEqual(Array.from({ length: 8 }, () => "connected"))
  })

  test("stopping: a cancel recorded on the run's own execution, until the run settles; a child's cancel is not the run's", () => {
    const root = (extra: Record<string, unknown>) => decision("run-t", "running", { flowName: "issue-sweep", parentRunId: null, ...extra })
    expect(burndownOf([root({ cancelRequestedAtMs: null })]).stopping).toBe(false)
    expect(burndownOf([root({ cancelRequestedAtMs: 20 })]).stopping).toBe(true)
    expect(burndownOf([root({}), decision("issue-sweep/7/attempt-1", "running", { parentRunId: "rounds", cancelRequestedAtMs: 20 })]).stopping).toBe(false)
    expect(burndownOf([root({ cancelRequestedAtMs: 20 })], { phase: "cancelled" }).stopping).toBe(false)
    expect(burndownOf(run3.events).stopping).toBe(false)
  })

  test("controls: only the ones the state allows", () => {
    const of = (view: ReturnType<typeof burndownOf>, stage: Parameters<typeof burndownControls>[1] = "ready", observer: Parameters<typeof burndownControls>[2] = "connected") =>
      burndownControls(view, stage, observer)
    // Nothing to stop or resume before a run exists.
    expect(of(burndownOf([], { phase: "launching" }), "launching")).toEqual({ stop: false, retry: false })
    // A run still unread offers nothing yet: its controls arrive with its board; a watch gone quiet can still be checked again.
    expect(of(burndownOf([], { phase: "running" }), "loading")).toEqual({ stop: false, retry: false })
    expect(of(burndownOf([], { phase: "quiet" }), "loading", "quiet")).toEqual({ stop: false, retry: true })
    expect(of(burndownOf(run3.events, { phase: "running" }))).toEqual({ stop: true, retry: false })
    expect(of(burndownOf(exhausted.events, { phase: "running" }))).toEqual({ stop: true, resume: "signal", retry: false })
    // A timer ends its own park: there is nothing to resume.
    expect(of(burndownOf(sleeping.events, { phase: "running" }))).toEqual({ stop: true, retry: false })
    expect(of(burndownOf(cancelled.events, { phase: "cancelled" }))).toEqual({ stop: false, resume: "restart", retry: false })
    expect(of(burndownOf(failed.events, { phase: "failed" }))).toEqual({ stop: false, resume: "restart", retry: false })
    // A drained sweep has nothing left to do.
    expect(of(burndownOf(completed.events, { phase: "completed" }))).toEqual({ stop: false, retry: false })
    expect(of(burndownOf(empty.events, { phase: "completed" }))).toEqual({ stop: false, retry: false })
    // The watch: reconnecting keeps the run's controls; quiet adds Check again; stopped watching cannot stop.
    expect(of(burndownOf(run3.events, { phase: "reconnecting" }), "ready", "reconnecting")).toEqual({ stop: true, retry: false })
    expect(of(burndownOf(run3.events, { phase: "quiet" }), "ready", "quiet")).toEqual({ stop: true, retry: true })
    expect(of(burndownOf(run3.events, { phase: "stopped" }), "ready", "stopped")).toEqual({ stop: false, retry: true })
    expect(of(burndownOf(exhausted.events, { phase: "stopped" }), "ready", "stopped")).toEqual({ stop: false, resume: "signal", retry: true })
  })

  test("moves: the issues whose state changed between two readings; a newly listed issue is not a move", () => {
    const child = "issue-sweep/7/attempt-1"
    const before = burndownOf([listed(7, 8), decision(child, "running"), scheduled(child, "issue-sweep/fix")])
    const after = burndownOf([listed(7, 8, 9), decision(child, "running"), scheduled(child, "issue-sweep/fix"),
      settled(child, "issue-sweep/work", "built", report), dispatched([{ id: "8", status: "held", detail: "Claimed by x" }])])
    expect(burndownMoves(before, after)).toEqual([{ number: 7, from: "working", to: "landing" }, { number: 8, from: "ours", to: "held" }])
    expect(burndownMoves(after, after)).toEqual([])
    expect(burndownMoves(burndownOf([]), after)).toEqual([])
  })
})

describe("each state rule", () => {
  const child = "issue-sweep/7/attempt-1"

  test("an empty journal is an empty, running board", () => {
    const view = burndownOf([])
    expect(view.items).toEqual([])
    expect(Object.values(view.counts).every((count) => count === 0)).toBe(true)
    expect(view.status).toBe("running")
    expect(view.capacity).toEqual({ active: 0 })
  })

  test("discovered without a child is ours", () => {
    expect(stateOf([listed(7)], 7)).toBe("ours")
  })

  test("a child that has started nothing is claimed", () => {
    expect(stateOf([listed(7), decision(child, "running")], 7)).toBe("claimed")
  })

  test("a fix in flight is working, local", () => {
    const view = burndownOf([listed(7), decision(child, "running"), scheduled(child, "issue-sweep/fix")])
    expect(view.items[0]).toMatchObject({ state: "working", placement: "local" })
    expect(view.machine.vms).toBe(0)
  })

  test("a remote fix in flight is working in the input's placement; adopt scheduled beside it does not make it adopting", () => {
    const events = [decision(child, "running"), scheduled(child, "issue-sweep/remote-fix"), scheduled(child, "issue-sweep/adopt")]
    const view = burndownOf(events, { input: { placement: "vm" } })
    expect(view.items[0]).toMatchObject({ state: "working", placement: "vm" })
    expect(view.machine.vms).toBe(1)
  })

  test("a settled remote fix whose adopt has not settled is adopting, with the remote account", () => {
    const events = [decision(child, "running"), scheduled(child, "issue-sweep/remote-fix"), scheduled(child, "issue-sweep/adopt"),
      settled(child, "issue-sweep/remote-fix", "built", { result: { agent: "codex", account: "codex-2", report: "r" }, work: {} })]
    expect(burndownOf(events).items[0]).toMatchObject({ state: "adopting", account: "codex-2" })
  })

  test("a completed child awaits landing until its dispatch row says landed", () => {
    const working = [listed(7), decision(child, "running"), scheduled(child, "issue-sweep/fix"),
      settled(child, "issue-sweep/fix", "built", report), settled(child, "issue-sweep/work", "built", report), decision(child, "completed")]
    expect(stateOf(working, 7)).toBe("landing")
    const landed = burndownOf([...working, dispatched([{ id: "7", status: "landed", detail: "0123456789ab by codex codex-3" }])]).items[0]
    expect(landed).toMatchObject({ state: "landed", commit: "0123456789ab", account: "codex-3", diff: { files: 2, insertions: 12, deletions: 4 }, patch: report.patch })
  })

  /*
   * The round journals each landing and release as it settles (#3346), so an
   * item lands on the board when its commit lands, not when its round ends.
   */
  describe("a round's landing and release steps", () => {
    const LAND = "flows/patterns/Burndown/land"
    const RELEASE = "flows/patterns/Burndown/release"
    const working = [listed(7), decision(child, "running"), scheduled(child, "issue-sweep/fix"),
      settled(child, "issue-sweep/fix", "built", report), settled(child, "issue-sweep/work", "built", report), decision(child, "completed")]
    const step = (action: string, outcome: string, row: { id: string; status: string; detail: string }, round = "rounds") =>
      settled(round, action, outcome, row, `issue-sweep/7/${action === LAND ? "land" : "release"}`)

    test("a landed step lands the item with its commit before the round's rows", () => {
      const landing = [...working, scheduled("rounds", LAND, "issue-sweep/7/land")]
      expect(stateOf(landing, 7)).toBe("landing")
      const landed = burndownOf([...landing, step(LAND, "built", { id: "7", status: "landed", detail: "0123456789ab by codex codex-3" })]).items[0]
      expect(landed).toMatchObject({ state: "landed", commit: "0123456789ab", account: "codex-3" })
    })

    test("a failed landing is failed with its reason", () => {
      const failed = burndownOf([...working, step(LAND, "failed", { id: "7", status: "failed", detail: "land: #7 is closed" })]).items[0]
      expect(failed).toMatchObject({ state: "failed", reason: "land: #7 is closed" })
    })

    test("a landing that settled with no row, such as a stopped round's, changes nothing", () => {
      const stopped = settled("rounds", LAND, "failed", { _tag: "flows/patterns/Burndown/Stop", message: "main is frozen" }, "issue-sweep/7/land")
      expect(stateOf([...working, stopped], 7)).toBe("landing")
    })

    test("the release's row is the round's last word; the round's own row agrees", () => {
      const landed = step(LAND, "built", { id: "7", status: "landed", detail: "0123456789ab by codex codex-3" })
      const requeued = { id: "7", status: "requeued", detail: "0123456789ab by codex codex-3; release: rate limited" }
      expect(stateOf([...working, landed, step(RELEASE, "failed", requeued)], 7)).toBe("ours")
      expect(stateOf([...working, landed, dispatched([requeued])], 7)).toBe("ours")
    })

    test("a later round's rows never replace a row an earlier round's step settled", () => {
      const landed = step(LAND, "built", { id: "7", status: "landed", detail: "0123456789ab by codex codex-3" }, "round-1")
      const skipped = step(RELEASE, "built", { id: "7", status: "skipped", detail: "x" }, "round-2")
      expect(stateOf([...working, landed, skipped, dispatched([{ id: "7", status: "failed", detail: "y" }])], 7)).toBe("landed")
    })
  })

  test("a dispatch row wins over the child's own state, and a skipped row yields to a later settled one", () => {
    const working = [listed(7), decision(child, "running"), scheduled(child, "issue-sweep/fix")]
    expect(stateOf([...working, dispatched([{ id: "7", status: "held", detail: "Claimed by x" }])], 7)).toBe("held")
    expect(stateOf([listed(7), dispatched([{ id: "7", status: "skipped", detail: "claimed on mini" }])], 7)).toBe("skip")
    const later = [listed(7), dispatched([{ id: "7", status: "skipped", detail: "a" }]), dispatched([{ id: "7", status: "failed", detail: "b" }]),
      dispatched([{ id: "7", status: "landed", detail: "c by d e" }])]
    expect(burndownOf(later).items[0]).toMatchObject({ state: "failed", reason: "b" })
  })

  test("a failed child is failed with its message as the failure detail; a cancelled one says cancelled", () => {
    const message = "codex-5 on issue-sweep:o/r#7: no change: tests already pass"
    const failed = [decision(child, "running"), scheduled(child, "issue-sweep/fix"),
      settled(child, "issue-sweep/work", "failed", { _tag: "issue-sweep/AgentFailed", message }), decision(child, "failed")]
    expect(burndownOf(failed).items[0]).toMatchObject({ state: "failed", failure: message, account: "codex-5" })
    expect(burndownOf(failed).items[0]?.reason).toBeUndefined()
    expect(burndownOf([decision(child, "running"), decision(child, "cancelled")]).items[0]).toMatchObject({ state: "failed", reason: "cancelled" })
  })

  describe("a failure's account", () => {
    const accountOf = (value: Record<string, unknown>) => burndownOf([decision(child, "running"), scheduled(child, "issue-sweep/fix"),
      settled(child, "issue-sweep/work", "failed", { _tag: "issue-sweep/AgentFailed", ...value }), decision(child, "failed")]).items[0]?.account

    test("the failure's own field wins, and survives a report cut at the preview", () => {
      const noChange = { _tag: "issue-sweep/NoChange", message: "claude claude-2: no change: done", account: "claude-2", report: "x".repeat(4000) }
      const events = [decision(child, "running"), scheduled(child, "issue-sweep/fix"),
        settled(child, "issue-sweep/work", "failed", noChange, undefined, 120), decision(child, "failed")]
      expect(burndownOf(events).items[0]?.account).toBe("claude-2")
    })

    test("a local run's exit and no-change messages name it after the agent", () => {
      expect(accountOf({ message: "codex codex-4: exit 1: boom" })).toBe("codex-4")
      expect(accountOf({ message: "claude claude-1: no change: nothing to do" })).toBe("claude-1")
    })

    test("a remote run's message names it before the placement, a Claude account included", () => {
      expect(accountOf({ message: "codex-6 on vm: exit 2: boom" })).toBe("codex-6")
      expect(accountOf({ message: "claude-3 on issue-sweep:o/r#7: no change: done" })).toBe("claude-3")
    })

    test("a remote no-change carries its account, whatever its agent", () => {
      expect(accountOf({ _tag: "issue-sweep/NoChange", message: "x", account: "claude-5", session: "s", report: "r" })).toBe("claude-5")
    })

    test("a guest's timeout names the agent, not an account", () => {
      expect(accountOf({ message: "codex on vm: no answer within 1h" })).toBeUndefined()
      expect(accountOf({ message: "claude on cloud: no answer within 1h" })).toBeUndefined()
    })

    test("a login that cannot be used names the account alone", () => {
      expect(accountOf({ message: "claude-1: no usable oauth-token file or unexpired Keychain login" })).toBe("claude-1")
      expect(accountOf({ message: "codex-2: no auth.json" })).toBe("codex-2")
      expect(accountOf({ message: "claude-1 on cloud: Claude failed (exit 1): boom" })).toBe("claude-1")
      expect(accountOf({ message: "Claude's captured work contains its borrowed login" })).toBeUndefined()
    })

    test("the rotator's unknown and a message naming no account give none", () => {
      expect(accountOf({ message: "codex unknown: exit 1: boom" })).toBeUndefined()
      expect(accountOf({ message: "no ready Codex or Claude account" })).toBeUndefined()
    })
  })

  describe("placement and agent on a row (main's Fix, RemoteFix and Adopt, both agents)", () => {
    const created = (placement: string) =>
      engine(child, "flows.engine.run-decision", { decision: "created",
        executionFact: { observation: { executionId: child, flowName: "issue-sweep/work", status: "pending", createdAtMs: 10, parentRunId: "rounds" } },
        state: { payload: { repo: "o/r", issue: 7, placement } } })
    const only = (events: Events) => burndownOf(events, { input: { placement: "vm", cloudAgents: 2 } }).items[0]!
    // Sandbox.Sandboxed(Remote): the agent's answer beside the work its machine captured.
    const remoted = (agent: string, account: string) => ({ result: { agent, account, report: "done\nCOMMIT: fix" }, work: { _tag: "Changed", session: "issue-sweep:o/r#7" } })

    test("a claimed child says where it will run and names no agent", () => {
      const item = only([created("cloud"), decision(child, "running")])
      expect(item).toMatchObject({ state: "claimed", placement: "cloud" })
      expect(item.agent).toBeUndefined()
      expect(burndownAgent(item)).toBeUndefined()
    })

    test("a working child, local, vm or cloud, has a placement and still no agent: it is journaled when the fix settles", () => {
      for (const [placement, action] of [["local", "issue-sweep/fix"], ["vm", "issue-sweep/remote-fix"], ["cloud", "issue-sweep/remote-fix"]] as const) {
        const item = only([created(placement), decision(child, "running"), scheduled(child, action)])
        expect(item).toMatchObject({ state: "working", placement })
        expect(burndownAgent(item)).toBeUndefined()
      }
    })

    test("a remote fix that settled names its agent and account, Codex in a VM and Claude in the cloud", () => {
      for (const [placement, agent, account] of [["vm", "codex", "codex-2"], ["cloud", "claude", "claude-1"], ["vm", "claude", "claude-3"], ["cloud", "codex", "codex-5"]] as const) {
        const item = only([created(placement), decision(child, "running"), scheduled(child, "issue-sweep/remote-fix"),
          settled(child, "issue-sweep/remote-fix", "built", remoted(agent, account)), scheduled(child, "issue-sweep/adopt")])
        expect(item).toMatchObject({ state: "adopting", placement, agent, account })
        expect(burndownAgent(item)).toBe(account)
      }
    })

    test("a remote answer whose report is cut at the preview still names them: agent and account lead it", () => {
      const item = only([created("cloud"), decision(child, "running"), scheduled(child, "issue-sweep/remote-fix"),
        settled(child, "issue-sweep/remote-fix", "built", { result: { agent: "claude", account: "claude-1", report: "x".repeat(4000) }, work: {} }, undefined, 200),
        scheduled(child, "issue-sweep/adopt")])
      expect(item).toMatchObject({ state: "adopting", placement: "cloud", agent: "claude", account: "claude-1" })
    })

    test("an adopted or locally fixed report names them through landing, and the landed row keeps them", () => {
      const claude = { ...report, agent: "claude", account: "claude-1" }
      const landing = [created("cloud"), decision(child, "running"), scheduled(child, "issue-sweep/remote-fix"),
        settled(child, "issue-sweep/remote-fix", "built", remoted("claude", "claude-1")),
        settled(child, "issue-sweep/adopt", "built", claude), settled(child, "issue-sweep/work", "built", claude), decision(child, "completed")]
      expect(only(landing)).toMatchObject({ state: "landing", placement: "cloud", agent: "claude", account: "claude-1" })
      const landed = only([listed(7), ...landing, dispatched([{ id: "7", status: "landed", detail: "0123456789ab by claude claude-1" }])])
      expect(landed).toMatchObject({ state: "landed", placement: "cloud", agent: "claude", account: "claude-1", commit: "0123456789ab" })
      const local = only([created("local"), decision(child, "running"), scheduled(child, "issue-sweep/fix"),
        settled(child, "issue-sweep/fix", "built", report), settled(child, "issue-sweep/work", "built", report), decision(child, "completed")])
      expect(local).toMatchObject({ state: "landing", placement: "local", agent: "codex", account: "codex-3" })
    })

    test("a failure names the agent only where its message does", () => {
      const failedWith = (placement: string, action: string, value: Record<string, unknown>) => only([created(placement), decision(child, "running"),
        scheduled(child, action), settled(child, action, "failed", value), settled(child, "issue-sweep/work", "failed", value), decision(child, "failed")])
      const local = failedWith("local", "issue-sweep/fix", { _tag: "issue-sweep/AgentFailed", message: "claude claude-2: exit 1: boom" })
      expect(local).toMatchObject({ state: "failed", placement: "local", agent: "claude", account: "claude-2" })
      const timeout = failedWith("cloud", "issue-sweep/remote-fix", { _tag: "issue-sweep/AgentFailed", message: "claude on cloud: no answer within 2h" })
      expect(timeout).toMatchObject({ state: "failed", placement: "cloud", agent: "claude" })
      expect(timeout.account).toBeUndefined()
      expect(burndownAgent(timeout)).toBe("claude")
      expect(failedWith("local", "issue-sweep/fix", { _tag: "issue-sweep/AgentFailed", message: "codex: no answer within 2h" }).agent).toBe("codex")
      const remote = failedWith("vm", "issue-sweep/remote-fix", { _tag: "issue-sweep/AgentFailed", message: "codex-6 on vm: exit 2: boom" })
      expect(remote).toMatchObject({ placement: "vm", account: "codex-6" })
      expect(remote.agent).toBeUndefined()
      expect(burndownAgent(remote)).toBe("codex-6")
      const noChange = failedWith("vm", "issue-sweep/remote-fix",
        { _tag: "issue-sweep/NoChange", message: "claude-3 on issue-sweep:o/r#7: no change: done", account: "claude-3", session: "issue-sweep:o/r#7", report: "done" })
      expect(burndownAgent(noChange)).toBe("claude-3")
      const nobody = failedWith("vm", "issue-sweep/remote-fix", { _tag: "issue-sweep/AgentFailed", message: "no ready Codex or Claude account" })
      expect(nobody).toMatchObject({ state: "failed", placement: "vm" })
      expect(burndownAgent(nobody)).toBeUndefined()
    })

    test("the words: the account when it carries its agent's name, the agent before one that does not, the agent alone", () => {
      expect(PLACEMENT_WORDS).toEqual({ local: "Local", vm: "VM", cloud: "Cloud" })
      expect(burndownAgent({ agent: "claude", account: "claude-1" })).toBe("claude-1")
      expect(burndownAgent({ agent: "codex", account: "codex-acct-1" })).toBe("codex-acct-1")
      expect(burndownAgent({ agent: "codex", account: "work" })).toBe("codex work")
      expect(burndownAgent({ agent: "claude" })).toBe("claude")
      expect(burndownAgent({ account: "codex-2" })).toBe("codex-2")
      expect(burndownAgent({})).toBeUndefined()
    })

    test("the overflow journal: a cloud child worked by Claude, vm children still working with no agent", () => {
      const view = burndownOf(overflow.events, { phase: "running", input: overflow.input })
      const said = Object.fromEntries(view.items.map((item) => [item.number, [item.state, item.placement, burndownAgent(item)]]))
      expect(said).toEqual({
        3360: ["working", "vm", undefined], 3359: ["working", "vm", undefined], 3358: ["working", "cloud", undefined],
        3357: ["adopting", "cloud", "codex-4"], 3356: ["landing", "cloud", "claude-1"], 3355: ["ours", undefined, undefined]
      })
    })

    test("the recorded run: every child from claimed onward ran in a VM, and each settled fix names a Codex account", () => {
      const view = burndownOf(run3.events, { phase: "running", input: run3.input })
      const worked = view.items.filter((item) => item.state !== "ours" && item.state !== "skip")
      expect(worked.length).toBeGreaterThan(0)
      expect(new Set(worked.map((item) => item.placement))).toEqual(new Set(["vm"]))
      for (const item of worked.filter((each) => each.state === "working")) expect(burndownAgent(item)).toBeUndefined()
      const named = worked.flatMap((item) => burndownAgent(item) ?? [])
      expect(named.length).toBeGreaterThan(30)
      for (const name of named) expect(name).toMatch(/^codex-/)
    })
  })

  test("a requeued row puts the item back in the queue, never failed; a later settled row wins over it", () => {
    const interrupted = [listed(7), decision(child, "running"), scheduled(child, "issue-sweep/fix"), decision(child, "cancelled"),
      dispatched([{ id: "7", status: "requeued", detail: "round interrupted" }])]
    expect(burndownOf(interrupted).items[0]).toMatchObject({ state: "ours" })
    expect(burndownOf(interrupted).counts.failed).toBe(0)
    expect(stateOf([...interrupted, dispatched([{ id: "7", status: "landed", detail: "0123456789ab by codex codex-3" }])], 7)).toBe("landed")
  })

  test("a requeued item whose child carries on reads the child's own progress", () => {
    const resumed = [listed(7), dispatched([{ id: "7", status: "requeued", detail: "round interrupted" }]),
      decision(child, "running"), scheduled(child, "issue-sweep/fix")]
    expect(stateOf(resumed, 7)).toBe("working")
  })

  describe("placement", () => {
    const created = (executionId: string, placement: string) =>
      engine(executionId, "flows.engine.run-decision", { decision: "created",
        executionFact: { observation: { executionId, flowName: "issue-sweep/work", status: "pending", createdAtMs: 10, parentRunId: "rounds" } },
        state: { payload: { repo: "o/r", issue: 7, placement } } })

    test("comes from each child's own payload, not the run's input: an overflow child runs in the cloud", () => {
      const events = [created(child, "cloud"), decision(child, "running"), scheduled(child, "issue-sweep/remote-fix")]
      const view = burndownOf(events, { input: { placement: "vm", cloudAgents: 2 } })
      expect(view.items[0]).toMatchObject({ state: "working", placement: "cloud" })
      expect(view.machine.vms).toBe(0)
      expect(view.machine.cloud).toEqual({ active: 1, agents: 2 })
    })

    test("a remote fix with no journaled payload runs in the run's vm placement, and in none it cannot name", () => {
      const events = [decision(child, "running"), scheduled(child, "issue-sweep/remote-fix")]
      expect(burndownOf(events, { input: { placement: "vm" } }).items[0]?.placement).toBe("vm")
      expect(burndownOf(events).items[0]?.placement).toBeUndefined()
    })

    test("the run's input is the journal's own, from its rounds' created payload, over the one this client launched with", () => {
      const rounds = engine("rounds", "flows.engine.run-decision", { decision: "created",
        executionFact: { observation: { executionId: "rounds", flowName: "issue-sweep/rounds", status: "pending", createdAtMs: 1, parentRunId: "run" } },
        state: { payload: { input: { repo: "o/r", maxAgents: 6, placement: "vm", cloudAgents: 4 } } } })
      const view = burndownOf([rounds, decision(child, "running"), scheduled(child, "issue-sweep/remote-fix")], { input: { repo: "o/r" } })
      expect(view.input).toEqual({ repo: "o/r", maxAgents: 6, placement: "vm", cloudAgents: 4 })
      expect(view.items[0]?.placement).toBe("vm")
      expect(view.machine).toMatchObject({ maxAgents: 6, cloud: { active: 0, agents: 4 } })
      // A run opened by id carries no launch input: the journal's still answers.
      expect(burndownOf([rounds]).input).toEqual({ repo: "o/r", maxAgents: 6, placement: "vm", cloudAgents: 4 })
      expect(burndownOf([], { input: { repo: "o/r" } }).input).toEqual({ repo: "o/r" })
    })

    test("the cloud meter exists only when the run asked for cloud agents", () => {
      expect(burndownOf([], { input: { cloudAgents: 0 } }).machine.cloud).toBeUndefined()
      expect(burndownOf([]).machine.cloud).toBeUndefined()
      expect(burndownOf([], { input: { cloudAgents: 3 } }).machine.cloud).toEqual({ active: 0, agents: 3 })
    })

    test("the placement choice beside a child is not an issue's child", () => {
      const choice = `${child}/placement`
      const events = [decision(child, "running", { createdAtMs: 10 }), scheduled(child, "issue-sweep/fix"),
        engine(choice, "flows.engine.run-decision", { decision: "transitioned", executionFact: { observation: {
          executionId: choice, flowName: "issue-sweep/placement", status: "completed", createdAtMs: 20 } } })]
      expect(burndownOf(events).items[0]).toMatchObject({ state: "working", executionId: child })
    })
  })

  describe("conflicted remote work", () => {
    const remoteAnswer = { result: { agent: "claude", account: "claude-4", report: "r" }, work: {} }
    const conflicted = [listed(7), decision(child, "running"), scheduled(child, "issue-sweep/remote-fix"), scheduled(child, "issue-sweep/adopt"),
      settled(child, "issue-sweep/remote-fix", "built", remoteAnswer),
      settled(child, "issue-sweep/adopt", "failed", { _tag: "issue-sweep/AdoptConflicted", message: "conflict in a.ts", title: "t", onto: "abc" }),
      settled(child, "issue-sweep/work", "failed", { _tag: "issue-sweep/AdoptConflicted", message: "conflict in a.ts", title: "t", onto: "abc" }),
      decision(child, "failed")]
    const readopt = `${child}/readopt-1`

    test("is adopting while the sweep waits to apply it again, with the remote's claude account", () => {
      expect(burndownOf(conflicted).items[0]).toMatchObject({ state: "adopting", account: "claude-4", agent: "claude" })
      expect(burndownOf(conflicted).counts.failed).toBe(0)
    })

    test("an applied re-application awaits landing with its report; one that fails otherwise is failed with its message", () => {
      const applied = [...conflicted, decision(readopt, "running", { flowName: "issue-sweep/readopt", createdAtMs: 30 }),
        settled(readopt, "issue-sweep/adopt", "built", { ...report, agent: "claude", account: "claude-4" })]
      expect(burndownOf(applied).items[0]).toMatchObject({ state: "landing", diff: { files: 2, insertions: 12, deletions: 4 }, executionId: child })
      const broken = [...conflicted, decision(readopt, "running", { flowName: "issue-sweep/readopt", createdAtMs: 30 }),
        settled(readopt, "issue-sweep/adopt", "failed", { _tag: "issue-sweep/AgentFailed", message: "the vm work: base gone" })]
      expect(burndownOf(broken).items[0]).toMatchObject({ state: "failed", failure: "the vm work: base gone" })
      const again = [...conflicted, decision(readopt, "running", { flowName: "issue-sweep/readopt", createdAtMs: 30 }),
        settled(readopt, "issue-sweep/adopt", "failed", { _tag: "issue-sweep/AdoptConflicted", message: "still", title: "t", onto: "def" })]
      expect(stateOf(again, 7)).toBe("adopting")
    })
  })

  test("a rerun under a round id replaces the cancelled attempt", () => {
    const rerun = "issue-sweep/7/attempt-1/round-2"
    const events = [decision(child, "cancelled", { createdAtMs: 10 }), decision(rerun, "running", { createdAtMs: 20 }), scheduled(rerun, "issue-sweep/fix")]
    expect(burndownOf(events).items[0]).toMatchObject({ state: "working", executionId: rerun })
  })

  test("a pull request appears only when a row's detail names one", () => {
    const pr = "https://github.com/smithersai/smithers/pull/3400"
    expect(burndownOf([dispatched([{ id: "7", status: "failed", detail: `handed off: ${pr}` }])]).items[0]?.pr).toBe(pr)
    expect(burndownOf([dispatched([{ id: "7", status: "failed", detail: "no pr" }])]).items[0]?.pr).toBeUndefined()
  })

  test("a truncated discovery keeps every complete issue", () => {
    const issues = Array.from({ length: 40 }, (_, index) => ({ id: String(index + 1), number: index + 1, title: `Issue ${index + 1}`, labels: [] }))
    const view = burndownOf([settled("rounds", "issue-sweep/list-issues", "built", issues, undefined, 500)])
    expect(view.items.length).toBeGreaterThan(5)
    expect(view.items.length).toBeLessThan(40)
    expect(view.items.every((item) => item.title === `Issue ${item.number}`)).toBe(true)
  })

  describe("a title from the child's fetched issue", () => {
    const issue = { title: "Fetched title", body: "x".repeat(200), comments: [{ author: { login: "a" }, body: "y" }] }
    const fetched = (cut?: number) => [decision(child, "running"),
      scheduled(child, "issue-sweep/fetch-issue", "root.flow.then.andThen"),
      settled(child, "issue-sweep/fetch-issue", "built", issue, "root.flow.then.andThen", cut)]
    const titleOf = (events: Events) => burndownOf(events).items.find((item) => item.number === 7)?.title

    test("a whole preview gives the title", () => {
      expect(titleOf(fetched())).toBe("Fetched title")
    })

    test("a preview cut after the title still gives it", () => {
      expect(titleOf(fetched(60))).toBe("Fetched title")
    })

    test("a preview cut inside the title gives none", () => {
      expect(titleOf(fetched(15))).toBeUndefined()
    })

    test("discovery's title wins over the fetched one", () => {
      expect(titleOf([listed(7), ...fetched()])).toBe("Issue 7")
    })

    test("a malformed or failed fetch gives none and never throws", () => {
      const junk = engine(child, "flows.engine.node-settled", { action: "issue-sweep/fetch-issue", nodeId: "n", outcome: "built",
        result: { bytes: 9, preview: "<html>", truncated: false } })
      expect(titleOf([decision(child, "running"), junk])).toBeUndefined()
      expect(titleOf([decision(child, "running"), settled(child, "issue-sweep/fetch-issue", "failed", { title: "no" })])).toBeUndefined()
      expect(titleOf([decision(child, "running"), settled(child, "issue-sweep/fetch-issue", "built", { title: 3 })])).toBeUndefined()
    })
  })

  test("malformed rows and unknown events are ignored, never thrown on", () => {
    const junk: Events = [{ kind: 3 }, { kind: "control.engine.event", payload: null }, { kind: "control.engine.event", payload: { executionId: "x", payload: "y" } },
      settled("rounds", "issue-sweep/dispatch", "built", { rows: [{ id: 1 }, { status: "held" }, null] }),
      settled("rounds", "issue-sweep/accounts", "built", { _tag: "Available" })]
    const view = burndownOf(junk)
    expect(view.items).toEqual([])
    expect(view.capacity.slots).toBeUndefined()
  })
})
