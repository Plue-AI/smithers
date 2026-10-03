import { describe, expect, test } from "bun:test"
import type { MythicalItem, MythicalStack } from "@smthrs/rpc/Mythical"
import { MythicalItemSchema } from "@smthrs/rpc/Mythical"
import { renderToStaticMarkup } from "react-dom/server"
import { StackBody } from "./StackCard"
import type { StackBodyProps } from "./StackCard"
import { issueGroupOf, issueGroups, issueWord, settledItems, spanLabel, stackMetrics, issueToLandedMs } from "@smthrs/rpc/StackIssues"
import { flowArgs } from "../flows/FlowArgs"
import { payloadFor } from "../flows/SlashPayload"

/*
 * The History card is the factory's issue list: every item in exactly one of
 * Needs you / Working / Done, the measured numbers above them, and a metrics
 * view the card payload holds and `history.view` switches.
 */

const REPO = "smithersai/smithers"
// Rendered bodies read the real clock; a minute ago keeps Done rows inside "Done today".
const RECENT = new Date(Date.now() - 60_000).toISOString()
const item = (id: string, state: MythicalItem["state"], extra: Partial<MythicalItem> = {}): MythicalItem => ({
  id, state, attempt: 1, runs: {}, dependsOn: [], updatedAt: RECENT,
  issue: { number: Number(id.replace(/\D/g, "")), title: `Issue ${id}`, url: `https://github.com/${REPO}/issues/${id.replace(/\D/g, "")}` },
  ...extra
})
const stack = (items: ReadonlyArray<MythicalItem>, extra: Partial<MythicalStack> = {}): MythicalStack => ({
  repository: REPO, state: "active", generation: 1, mainBehind: false, changes: [], items: [...items], lanes: [],
  limits: { maxParallel: 2 }, ...extra
})
const render = (props: Partial<StackBodyProps> & { readonly stack: MythicalStack }, calls: Array<[string, string | undefined]> = []): string =>
  renderToStaticMarkup(<StackBody repo={REPO} snapshot={{ stack: props.stack, error: null }} failure={null} bootstrapping={false}
    onRunCommand={(name, args) => { calls.push([name, args]) }} {...props} />)
const section = (html: string, id: string): string => {
  const start = html.indexOf(`data-testid="stack-group-${id}"`)
  return html.slice(start, html.indexOf("</section>", start))
}

describe("the issue groups", () => {
  test("every API state lands in exactly one group", () => {
    const states: ReadonlyArray<MythicalItem["state"]> = [
      "blocked", "rejected", "proposed", "queued", "running", "delivering", "integrating", "verifying",
      "proposing", "waiting", "retrying", "unknown", "landed", "declined", "skipped", "cancelled"
    ]
    const groups = Object.fromEntries(states.map((state) => [state, issueGroupOf(item("i1", state))]))
    expect(groups).toEqual({
      // T-STK-01 Changes L39: an open PR is review, never a Needs you group.
      blocked: "needs-you", rejected: "needs-you", proposed: "working",
      queued: "working", running: "working", delivering: "working", integrating: "working", verifying: "working",
      proposing: "working", waiting: "working", retrying: "working", unknown: "working",
      landed: "done", declined: "done", skipped: "done", cancelled: "done"
    })
  })

  test("Needs you oldest first, Working lanes then queue, Done newest first", () => {
    const value = stack([
      item("i1", "blocked", { updatedAt: "2026-09-25T12:00:00Z" }),
      item("i2", "proposed", { updatedAt: "2026-09-25T09:00:00Z" }),
      item("i3", "queued"),
      item("i4", "running", { lane: 1 }),
      item("i5", "verifying", { lane: 0 }),
      item("i6", "landed", { updatedAt: "2026-09-20T00:00:00Z" }),
      item("i7", "cancelled", { updatedAt: "2026-09-24T00:00:00Z" })
    ])
    expect(issueGroups(value).map((group) => [group.label, group.glyph, group.items.map((row) => row.id)])).toEqual([
      ["Needs you", "◆", ["i1"]],
      ["Working", "◐", ["i5", "i4", "i2", "i3"]],
      ["Done", "●", ["i7", "i6"]]
    ])
  })

  test("the card renders the three groups in order, each with its count, and an empty group as its header", () => {
    const html = render({ stack: stack([item("i1", "running", { lane: 0 }), item("i2", "landed")]) })
    const order = ["needs-you", "working", "done"].map((id) => html.indexOf(`stack-group-${id}"`))
    expect(order).toEqual([...order].sort((a, b) => a - b))
    expect(html).toMatch(/data-testid="stack-group-needs-you-count">0</)
    expect(html).toMatch(/data-testid="stack-group-working-count">1</)
    expect(html).toMatch(/data-testid="stack-group-done-count">1</)
    expect(section(html, "needs-you")).not.toContain("<ol")
    expect(html.indexOf("stack-group-done")).toBeLessThan(html.indexOf("stack-counts"))
  })

  test("Done is Done today: with the card's clock only items that moved in the last 24 h; the metrics view keeps them all", () => {
    const now = Date.parse("2026-09-25T10:00:00Z")
    const value = stack([
      item("i1", "landed", { updatedAt: "2026-09-25T09:00:00Z" }),
      item("i2", "landed", { updatedAt: "2026-09-24T10:00:00Z" }),
      item("i3", "cancelled", { updatedAt: "2026-09-24T09:59:59Z" }),
      item("i4", "blocked", { updatedAt: "2026-09-01T00:00:00Z" }),
      item("i6", "landed", { updatedAt: "" })
    ])
    const groups = issueGroups(value, now)
    /* An unreadable stamp stays listed rather than vanishing from every group. */
    expect(groups.find((group) => group.id === "done")?.items.map((row) => row.id)).toEqual(["i1", "i2", "i6"])
    // Needs you keeps its old rows; only Done is a day window.
    expect(groups.find((group) => group.id === "needs-you")?.items.map((row) => row.id)).toEqual(["i4"])
    expect(issueGroups(value).find((group) => group.id === "done")?.items).toHaveLength(4)
    const old = stack([item("i2", "landed", { updatedAt: "2020-01-01T00:00:00Z" }), item("i5", "landed")])
    const html = render({ stack: old })
    expect(html).toMatch(/data-testid="stack-group-done-count">1</)
    expect(section(html, "done")).not.toContain("stack-item-i2")
    expect(render({ stack: old, view: "metrics" })).toContain("stack-metrics-i2")
  })

  test("unlabelled skipped issues do not appear in Done or the settled table", () => {
    const value = stack([item("i1", "skipped"), item("i2", "landed")])
    const issues = render({ stack: value })
    expect(issues).toMatch(/data-testid="stack-group-done-count">1</)
    expect(issues).not.toContain("stack-item-i1")
    expect(render({ stack: value, view: "metrics" })).not.toContain("stack-metrics-i1")
  })

  test("a row is glyph, linked `#n title`, one word, and Retry where the API takes it", () => {
    const value = stack([
      item("i5", "blocked", { reason: "3 attempts failed" }),
      item("i4", "proposed", { pullRequest: { number: 44, url: "https://github.com/pr/44", state: "open" } }),
      item("i1", "running", { lane: 0, updatedAt: "2026-09-25T09:52:53Z" }),
      item("i2", "retrying", { lane: 1, integration: { conflict: { paths: ["src/a.ts"] } } }),
      item("i3", "queued"),
      item("i8", "declined", { reason: "Already done." })
    ])
    const html = render({ stack: value })
    const needs = section(html, "needs-you")
    expect(needs).toContain(`href="https://github.com/${REPO}/issues/5"`)
    expect(needs).toContain("#5 Issue i5")
    // The reason is the row's one word, said once.
    expect(needs.split("3 attempts failed").length - 1).toBe(1)
    expect(needs).toContain(`data-flow="history.retry" data-flow-args="i5 ${REPO}"`)
    const working = section(html, "working")
    expect(needs).not.toContain('data-state="proposed"')
    expect(working).toContain('data-state="proposed">PR open<')
    expect(working).toContain('href="https://github.com/pr/44"')
    expect(working).toMatch(/<time[^>]*dateTime="2026-09-25T09:52:53Z"[^>]*data-testid="stack-item-i1-elapsed">\d+:\d{2}(:\d{2})?<\/time>/)
    expect(working).toContain("src/a.ts")
    expect(working).toContain('data-state="queued">queued<')
    expect(working).not.toContain("history.retry")
    const done = section(html, "done")
    expect(done).toContain('data-state="declined">declined<')
    expect(done).toContain("Already done.")
    expect(done).toContain(`data-flow="history.retry" data-flow-args="i8 ${REPO}"`)
    expect(issueWord(item("i9", "rejected"))).toBe("rejected")
  })

  test("Retry shows once per item even when its change is on the stack", () => {
    const value = stack([item("i5", "rejected")], {
      changes: [{ changeId: "kaaaaaaaaaaa", commitId: "c1", title: "Revert", kind: "item", state: "landed", itemId: "i5", issue: 5 }]
    })
    expect([...render({ stack: value }).matchAll(/data-flow="history.retry"/g)]).toHaveLength(1)
  })
})

describe("the metrics", () => {
  const timed = stack([
    item("i1", "landed", { createdAt: "2026-09-25T08:00:00Z", updatedAt: "2026-09-25T10:00:00Z", route: { as: "bug", landed: "change" }, attempt: 2 }),
    item("i2", "landed", { createdAt: "2026-09-25T06:00:00Z", updatedAt: "2026-09-25T10:00:00Z", route: { as: "implement", landed: "change" } }),
    item("i3", "landed", { createdAt: "2026-09-24T10:00:00Z", updatedAt: "2026-09-25T10:00:00Z" }),
    item("i4", "landed", { updatedAt: "2026-09-25T10:00:00Z" }),
    item("i5", "rejected", { updatedAt: "2026-09-25T10:00:00Z" }),
    item("i6", "running", { lane: 0 })
  ], { changes: [
    { changeId: "krrrrrrrrrrr", commitId: "c2", title: "Revert #5", kind: "revert", state: "landed" },
    { changeId: "kiiiiiiiiiii", commitId: "c1", title: "Fix", kind: "item", state: "landed" }
  ] })

  test("landed out of decided, reverts, and p50 issue→landed from the items that carry createdAt", () => {
    expect(stackMetrics(timed)).toEqual({
      landed: 4, decided: 5, reverts: 1, p50Ms: 4 * 3_600_000,
      landedUnedited: 4, landedUneditedShare: 100, costPerLanded: undefined,
      misroutes: 0, replans: 0, veryHard: 0
    })
    const html = render({ stack: timed })
    expect(html).toContain('data-testid="stack-metric-landed">4/5 landed<')
    expect(html).toContain('data-testid="stack-metric-reverts">1 revert<')
    expect(html).toContain('data-testid="stack-metric-p50">4h p50<')
    expect(html).toContain('data-testid="stack-metric-unedited">100% landed unedited<')
    expect(html).toContain('data-testid="stack-metric-misroutes">0 misroutes<')
    expect(html).toContain('data-testid="stack-metric-replans">0 replans<')
    expect(html.indexOf("stack-metrics")).toBeLessThan(html.indexOf("stack-group-needs-you"))
  })

  test("the landed ratio counts what a lane worked or the planner declined, never what never started", () => {
    const value = stack([
      item("i1", "landed"), item("i2", "rejected"), item("i3", "blocked"), item("i4", "declined"),
      item("i5", "skipped"), item("i6", "cancelled"), item("i7", "running", { lane: 0 }), item("i8", "queued")
    ])
    expect(stackMetrics(value)).toMatchObject({ landed: 1, decided: 4 })
    expect(render({ stack: value })).toContain('data-testid="stack-metric-landed">1/4 landed<')
    // Only skipped and cancelled: nothing decided, no ratio.
    expect(render({ stack: stack([item("i5", "skipped"), item("i6", "cancelled")]) })).not.toContain("stack-metric-landed")
  })

  test("only measured numbers: no createdAt, no p50; nothing settled, no landed ratio", () => {
    const bare = stack([item("i1", "landed"), item("i2", "running", { lane: 0 })])
    expect(stackMetrics(bare).p50Ms).toBeUndefined()
    const html = render({ stack: bare })
    expect(html).not.toContain("stack-metric-p50")
    expect(html).toContain(">0 reverts<")
    const moving = render({ stack: stack([item("i2", "running", { lane: 0 })]) })
    expect(moving).not.toContain("stack-metric-landed")
    expect(moving).not.toMatch(/not measured|n\/a/i)
  })

  test("the History header and working rows show measured cost, route errors, and live plan progress", () => {
    const value = stack([
      item("i1", "landed", { costNanos: 3_000_000_000, route: { as: "close", landed: "change" } }),
      item("i2", "landed", { humanEdited: true, costNanos: 1_000_000_000, todo: { replans: 2, veryHard: true } }),
      item("i3", "running", { lane: 0, todo: { replans: 1 } }),
      item("i4", "running", { lane: 1, todo: { replans: 2, veryHard: true } }),
      item("i5", "blocked", { reason: "very hard: exhausted", todo: { replans: 2, veryHard: true } }),
      item("i6", "retrying", { todo: { replans: 0, veryHard: true } }),
      item("i7", "verifying", { todo: { replans: 2, veryHard: true } })
    ])
    const html = render({ stack: value })
    expect(html).toContain('data-testid="stack-metric-unedited">50% landed unedited<')
    expect(html).toContain('data-testid="stack-metric-cost">$2.00/landed<')
    expect(html).toContain('data-testid="stack-metric-misroutes">1 misroute<')
    expect(html).toContain('data-testid="stack-metric-replans">9 replans<')
    expect(html).toContain('data-testid="stack-metric-very-hard">2 very hard<')
    expect(html).toContain('data-testid="stack-item-i3-progress">plan 2 of 3<')
    expect(html).toContain('data-testid="stack-item-i4-progress">plan 3 of 3 · very hard<')
    expect(html).not.toContain('data-testid="stack-item-i2-progress"')
    expect(html).not.toContain('data-testid="stack-item-i5-progress"')
    expect(html).not.toContain('data-testid="stack-item-i6-progress">plan 1 of 3 · very hard')
    expect(html).toContain('data-testid="stack-item-i7-progress">plan 3 of 3 · very hard<')
    expect(section(html, "needs-you")).toContain('data-state="blocked">blocked<')
    const table = render({ stack: value, view: "metrics" })
    expect(table).toMatch(/<th scope="col">Cost<\/th><th scope="col">Edited<\/th><th scope="col">Replans<\/th><th scope="col">Route<\/th>/)
    const first = table.slice(table.indexOf('data-testid="stack-metrics-i1"'), table.indexOf("</tr>", table.indexOf('data-testid="stack-metrics-i1"')))
    expect(first).toContain("$3.00")
    expect(first).toContain("<td>–</td>")
    expect(first).toContain("<td>close</td>")
  })

  test("issue→landed needs a landed item with readable, ordered stamps", () => {
    expect(issueToLandedMs(item("i1", "landed", { createdAt: "2026-09-25T09:00:00Z", updatedAt: "2026-09-25T10:00:00Z" }))).toBe(3_600_000)
    expect(issueToLandedMs(item("i1", "rejected", { createdAt: "2026-09-25T09:00:00Z", updatedAt: "2026-09-25T10:00:00Z" }))).toBeUndefined()
    expect(issueToLandedMs(item("i1", "landed", { createdAt: "garbage", updatedAt: "2026-09-25T10:00:00Z" }))).toBeUndefined()
    expect(issueToLandedMs(item("i1", "landed", { createdAt: "2026-09-26T00:00:00Z", updatedAt: "2026-09-25T10:00:00Z" }))).toBeUndefined()
    expect([spanLabel(45 * 60_000), spanLabel(6 * 3_600_000), spanLabel(72 * 3_600_000)]).toEqual(["45m", "6h", "3d"])
  })

  test("the metrics view: the same numbers over a table of settled issues, and nothing of the issue list", () => {
    const html = render({ stack: timed, view: "metrics" })
    expect(html).toContain("4/5 landed")
    expect(html).not.toContain("stack-group-")
    expect(html).not.toContain("stack-lanes")
    expect(html).toMatch(/<th scope="col">Issue<\/th><th scope="col">Outcome<\/th><th scope="col">Issue→landed<\/th><th scope="col">Route<\/th><th scope="col">Attempt<\/th>/)
    expect(settledItems(timed).map((row) => row.id)).toEqual(["i1", "i2", "i3", "i4", "i5"])
    const row = html.slice(html.indexOf("stack-metrics-i1"), html.indexOf("</tr>", html.indexOf("stack-metrics-i1")))
    expect(row).toContain("#1 Issue i1")
    expect(row).toContain(">landed<")
    expect(row).toContain("<td>2h</td>")
    expect(row).toContain("<td>bug</td>")
    expect(row).toContain("<td>2</td>")
    // Without createdAt or a route anywhere, those columns are absent, never empty placeholders.
    const plain = render({ stack: stack([item("i4", "landed")]), view: "metrics" })
    expect(plain).not.toContain("Issue→landed")
    expect(plain).not.toContain("Route")
    expect(render({ stack: stack([item("i6", "running", { lane: 0 })]), view: "metrics" })).not.toContain("stack-metrics-table")
  })

  test("the homepage (no view) draws no switch: it has no card for history.view to change", () => {
    const html = render({ stack: timed })
    expect(html).not.toContain("history.view")
    expect(html).not.toContain("stack-views")
    expect(html).toContain("stack-group-needs-you")
  })

  test("the view switch is two native buttons on history.view with typed args, the current one pressed", () => {
    for (const view of ["issues", "metrics"] as const) {
      const html = render({ stack: timed, view })
      expect(html).toContain(`data-flow="history.view" data-flow-args="issues ${REPO}"`)
      expect(html).toContain(`data-flow="history.view" data-flow-args="metrics ${REPO}"`)
      expect(html).toMatch(new RegExp(`<button[^>]*aria-pressed="true"[^>]*data-flow-args="${view} `))
    }
    expect(flowArgs("history.view", { view: "metrics", repo: REPO })).toBe(`metrics ${REPO}`)
  })
})

describe("history.view and createdAt on the wire", () => {
  test("the slash grammar takes issues or metrics and an optional repository", () => {
    expect(payloadFor("history.view", `metrics ${REPO}`)).toEqual({ payload: { view: "metrics", repo: REPO } })
    expect(payloadFor("history.view", "issues")).toEqual({ payload: { view: "issues" } })
    expect(payloadFor("history.view", "graph")).toEqual({ error: "history.view takes issues or metrics" })
  })

  test("an item's createdAt is optional", () => {
    expect(MythicalItemSchema.safeParse(item("i1", "queued")).success).toBe(true)
    expect(MythicalItemSchema.safeParse(item("i1", "queued", { createdAt: "2026-09-25T09:00:00Z", updatedAt: "2026-09-25T10:00:00Z" })).data?.createdAt).toBe("2026-09-25T09:00:00Z")
  })
})
