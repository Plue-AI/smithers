import { describe, expect, test } from "bun:test"
import type { MythicalItem, MythicalStack, MythicalWiki } from "@smthrs/rpc/Mythical"
import { renderToStaticMarkup } from "react-dom/server"
import { StackBody } from "./StackCard"
import type { StackBodyProps } from "./StackCard"
import { elapsedLabel } from "../Timestamps"
import { accountLabel, itemStateLabel, laneRows, stackCounts, stackRows, wikiRow } from "@smthrs/rpc/StackView"

/*
 * The Stack card renders exactly what the snapshot states: counts, lanes
 * against maxParallel, the ordered stack with each row's issue, state,
 * checks and pull request, and every failure beside the door that retries it.
 */

const REPO = "smithersai/smithers"
// The body reads the real clock; a minute ago keeps the Done rows inside "Done today".
const RECENT = new Date(Date.now() - 60_000).toISOString()
const item = (id: string, state: MythicalItem["state"], extra: Partial<MythicalItem> = {}): MythicalItem => ({
  id, state, attempt: 1, runs: {}, dependsOn: [], updatedAt: RECENT,
  issue: { number: Number(id.replace(/\D/g, "")), title: `Issue ${id}`, url: `https://github.com/${REPO}/issues/${id.replace(/\D/g, "")}` },
  ...extra
})
const STACK: MythicalStack = {
  repository: REPO, state: "active", generation: 9, mainBehind: false,
  tip: { changeId: "kzzzzzzz", commitId: "c3" },
  changes: [
    { changeId: "kzzzzzzzaaaa", commitId: "c3", title: "Fix the toast", kind: "item", state: "landed", itemId: "i4", issue: 4 },
    { changeId: "kyyyyyyybbbb", commitId: "c2", title: "Initial import", kind: "bootstrap", state: "landed" }
  ],
  items: [
    item("i1", "running", { lane: 0 }),
    item("i2", "retrying", { lane: 1, integration: { conflict: { paths: ["src/a.ts", "src/b.ts"] } } }),
    item("i3", "queued"),
    item("i4", "proposed", { checks: { state: "passed", failed: [] }, pullRequest: { number: 44, url: "https://github.com/pr/44", state: "open" } }),
    item("i5", "blocked", { reason: "3 attempts failed", checks: { state: "failed", failed: ["//:ci"] } }),
    item("i6", "skipped", { reason: "not actionable" }),
    item("i7", "landed"),
    item("i8", "declined", { reason: "Already done." })
  ],
  lanes: [
    { index: 0, state: "busy", itemId: "i1", workspaceId: "ws-000111222", startedAt: "2026-09-25T09:52:53Z",
      account: { provider: "claude", label: "work@example.com", count: 2 }, seat: "opus" },
    { index: 1, state: "busy", itemId: "i2", startedAt: "2026-09-25T08:59:00Z", account: { provider: "codex", count: 1 }, seat: "luna" }
  ],
  limits: { maxParallel: 2 }
}

const render = (props: Partial<StackBodyProps> = {}, calls: Array<[string, string | undefined]> = []): string =>
  renderToStaticMarkup(<StackBody repo={REPO} snapshot={{ stack: STACK, error: null }} failure={null} bootstrapping={false}
    onRunCommand={(name, args) => { calls.push([name, args]) }} {...props} />)

describe("the History card", () => {
  test("labels every API state in the owner's words", () => {
    const labels = Object.fromEntries(([
      "queued", "skipped", "declined", "cancelled", "running", "delivering", "integrating", "verifying", "proposing", "waiting",
      "proposed", "landed", "rejected", "retrying", "blocked"
    ] as const).map((state) => [state, itemStateLabel(item("i1", state))]))
    expect(labels).toEqual({
      queued: "queued", skipped: "skipped", declined: "declined", cancelled: "cancelled", running: "implementing", delivering: "checking",
      integrating: "rebasing", verifying: "checking", proposing: "proposing", waiting: "ready", proposed: "PR open",
      landed: "landed", rejected: "rejected", retrying: "retrying", blocked: "blocked"
    })
    expect(itemStateLabel(STACK.items[1]!)).toBe("conflict")
  })

  test("renders an unknown item state as a neutral chip", () => {
    const future = { ...STACK, items: [...STACK.items, item("i9", "unknown", { updatedAt: "2020-01-01T00:00:00Z" })] }
    const html = render({ snapshot: { stack: future, error: null } })
    const row = html.slice(html.indexOf('data-testid="stack-item-i9"'), html.indexOf("</li>", html.indexOf('data-testid="stack-item-i9"')))
    expect(row).toContain('data-group="working"')
    expect(row).toContain('class="stack-state" data-state="unknown">unknown</span>')
    expect(row).not.toContain("Retry")
    expect(html).toContain('data-testid="stack-item-i3"')
  })

  test("the history: each change says whether main contains it, and main moving past the stack shows", () => {
    const pending = { ...STACK, mainBehind: true, changes: [{ ...STACK.changes[1]!, state: "pending" as const }] }
    const html = render({ snapshot: { stack: pending, error: null } })
    expect(html).toContain("main ahead")
    expect(html).toMatch(/data-testid="stack-change-kyyyyyyybbbb".*data-state="pending">pending</)
  })

  test("counts, not prose", () => {
    expect(stackCounts(STACK)).toEqual({ changes: 2, landed: 2, busy: 2, maxParallel: 2, queued: 1, open: 1, blocked: 1, declined: 1 })
    const html = render()
    const counts = html.slice(html.indexOf("stack-counts"), html.indexOf("</p>", html.indexOf("stack-counts")))
    expect(counts).toContain("2 changes")
    expect(counts).not.toContain("main ahead")
    expect(counts).toContain("2/2 lanes")
    // Queued, PRs, blocked and declined are the issue groups' to count now.
    expect(counts).not.toMatch(/queued|PR|blocked|declined|landed/)
  })

  test("orders the stack: lanes, queue, decisions, declined, then the changes tip first", () => {
    expect(stackRows(STACK).map((row) => row.kind === "item" ? row.item.id : row.change.changeId))
      .toEqual(["i1", "i2", "i3", "i5", "i6", "i8", "kzzzzzzzaaaa", "kyyyyyyybbbb"])
    const html = render()
    expect(html.indexOf("stack-item-i1")).toBeLessThan(html.indexOf("stack-change-kzzzzzzzaaaa"))
    // The stack list holds only changes: the issue groups own the items.
    const rows = html.slice(html.indexOf('data-testid="stack-rows"'))
    expect(rows).not.toContain("stack-item-")
    // The change i4 made is joined to its issue, state, checks and pull request.
    const change = html.slice(html.indexOf("stack-change-kzzzzzzzaaaa"), html.indexOf("stack-change-kyyyyyyybbbb"))
    expect(change).toContain(`href="https://github.com/${REPO}/issues/4"`)
    expect(change).toContain("#4 Issue i4")
    expect(change).toContain("PR open")
    expect(change).toContain('data-checks="passed"')
    expect(change).toContain('href="https://github.com/pr/44"')
    expect(html).toContain("src/a.ts, src/b.ts")
    expect(html).toContain("✗ //:ci")
    // A skipped issue never entered the factory, so no group lists it or its reason (StackIssues.ts).
    expect(html).not.toContain("stack-item-i6")
    expect(html).not.toContain("not actionable")
    // A landed item that is no longer a stack row is in Done, not the stack list.
    expect(rows).not.toContain("#7 Issue i7")
  })

  test("lanes show the issue each works on and its workspace, and a lowered limit keeps a busy lane", () => {
    const html = render()
    const lane = html.slice(html.indexOf("stack-lane-0"), html.indexOf("stack-lane-1"))
    expect(lane).toContain("#1 Issue i1")
    expect(lane).toContain("implementing")
    expect(lane).toContain("ws-00011")
    const lowered = { ...STACK, limits: { maxParallel: 1 }, lanes: [STACK.lanes[0]!] }
    expect(laneRows(lowered).map((row) => [row.index, row.item?.id])).toEqual([[0, "i1"], [1, "i2"]])
    expect(stackCounts(lowered).busy).toBe(2)
  })

  test("a busy lane shows how long it has run, the account and the seat, and nothing it was not told", () => {
    const now = Date.parse("2026-09-25T10:00:00Z")
    expect(elapsedLabel("2026-09-25T09:52:53Z", now)).toBe("7:07")
    expect(elapsedLabel("2026-09-25T08:59:00Z", now)).toBe("1:01:00")
    expect(elapsedLabel("not a time", now)).toBeUndefined()
    expect(accountLabel({ provider: "claude", label: "work@example.com", count: 2 })).toBe("work@example.com +1")
    expect(accountLabel({ provider: "codex", count: 1 })).toBe("Codex")

    const html = render()
    const lane0 = html.slice(html.indexOf("stack-lane-0"), html.indexOf("stack-lane-1"))
    expect(lane0).toMatch(/<time[^>]*dateTime="2026-09-25T09:52:53Z"[^>]*data-testid="stack-lane-0-elapsed">\d+:\d{2}(:\d{2})?<\/time>/)
    expect(lane0).toContain(">work@example.com +1<")
    expect(lane0).toContain('data-testid="stack-lane-0-seat">opus<')
    const lane1 = html.slice(html.indexOf("stack-lane-1"), html.indexOf('data-testid="stack-rows"'))
    expect(lane1).toContain('data-provider="codex">Codex<')
    expect(lane1).toContain(">luna<")

    // A lane the snapshot says nothing more about shows no clock, account or seat.
    const bare = { ...STACK, lanes: [{ index: 0, state: "busy" as const, itemId: "i1" }, { index: 1, state: "busy" as const, itemId: "i2" }] }
    const plain = render({ snapshot: { stack: bare, error: null } })
    expect(plain).not.toContain("stack-lane-0-elapsed")
    expect(plain).not.toContain("stack-lane-1-elapsed")
    expect(plain).not.toContain("-account")
    expect(plain).not.toContain("-seat")
    expect(plain).not.toContain(" ago")
  })

  test("retry only where the API takes it, and admin doors carry typed args", () => {
    const html = render()
    const retries = [...html.matchAll(/data-flow="history.retry" data-flow-args="([^"]+)"/g)].map((match) => match[1])
    expect(retries).toEqual([`i5 ${REPO}`, `i8 ${REPO}`])
    const declined = html.slice(html.indexOf("stack-item-i8"), html.indexOf("stack-counts"))
    expect(declined).toContain(">declined<")
    expect(declined).toContain("Already done.")
    expect(html).toContain(`data-flow="history.backfill" data-flow-args="${REPO}"`)
    expect(html).toContain(`data-flow="history.parallel" data-flow-args="1 ${REPO}"`)
    expect(html).toContain(`data-flow="history.parallel" data-flow-args="3 ${REPO}"`)
    const chat = { ...STACK, items: [{ ...item("i9", "blocked"), issue: undefined }] }
    expect(render({ snapshot: { stack: chat, error: null } })).not.toContain('data-flow="history.retry"')
  })

  test("absent offers Bootstrap until a request is pending; frozen states its reason", () => {
    const absent = { ...STACK, state: "absent" as const, items: [], changes: [], lanes: [] }
    expect(render({ snapshot: { stack: absent, error: null } })).toContain(`data-flow="history.bootstrap" data-flow-args="${REPO}"`)
    expect(render({ snapshot: { stack: absent, error: null }, bootstrapping: true })).not.toContain("history.bootstrap")
    expect(render({ snapshot: { stack: { ...STACK, state: "frozen", reason: "main was force-pushed" }, error: null } }))
      .toContain("main was force-pushed")
  })

  test("a failure stays visible with its Retry, beside the last good snapshot", () => {
    const html = render({
      snapshot: { stack: STACK, error: "Reading the stack failed (502)" },
      failure: { act: "parallel", message: "Only a repository admin can change lanes.", args: `3 ${REPO}` }
    })
    expect(html).toContain('role="alert"')
    expect(html).toContain('data-act="parallel"')
    expect(html).toContain("<p>Smithers could not change the number of lanes.</p>")
    expect(html).toContain('<details><summary>Details</summary><pre tabindex="0">Only a repository admin can change lanes.</pre></details>')
    expect(html).toContain(`data-flow="history.parallel" data-flow-args="3 ${REPO}"`)
    expect(html).toContain("<p>Smithers could not read this history.</p>")
    expect(html).toContain('<pre tabindex="0">Reading the stack failed (502)</pre>')
    expect(html).toContain(`data-flow="history.show" data-flow-args="${REPO}"`)
    expect(html).toContain("stack-item-i1")
    // Before any snapshot, the failure is all there is.
    const empty = render({ snapshot: { stack: null, error: "Not found" } })
    expect(empty).toContain('data-act="read"')
    expect(empty).toContain('<pre tabindex="0">Not found</pre>')
    expect(empty).not.toContain("history.bootstrap")
  })
})

describe("the Wiki row", () => {
  const wiki = (state: MythicalWiki["state"], extra: Partial<MythicalWiki> = {}): MythicalWiki =>
    ({ state, commit: "c3", pages: 12, edited: 0, attempt: 1, ...extra })
  const withWiki = (value: MythicalWiki | undefined) => render({ snapshot: { stack: { ...STACK, wiki: value }, error: null } })
  const row = (html: string) => {
    const start = html.indexOf('data-testid="stack-wiki"')
    return html.slice(start, html.indexOf("</div>", start))
  }

  test("no declared Wiki, no row", () => {
    expect(withWiki(undefined)).not.toContain("stack-wiki")
  })

  test("one row: Wiki, its state, the pages door to the repository Wiki, and nothing else while it is healthy", () => {
    for (const state of ["current", "refreshing", "stale"] as const) {
      const html = row(withWiki(wiki(state)))
      expect(html).toContain(">Wiki<")
      expect(html).toContain(`data-state="${state}">${state}<`)
      expect(html).toContain(`data-flow="wiki.cloud" data-flow-args="${REPO}"`)
      expect(html).toContain(">12 pages<")
      expect(html).not.toContain("wiki.create")
      expect(html).not.toContain("edited")
    }
    expect(wikiRow(wiki("current", { pages: 1 })).pages).toBe("1 page")
  })

  test("the edited count shows only when a person changed pages", () => {
    expect(wikiRow(wiki("current")).edited).toBeUndefined()
    expect(row(withWiki(wiki("current", { edited: 3 })))).toContain(">3 edited<")
  })

  test("Retry only on a failed refresh, with the error as its one line", () => {
    const html = row(withWiki(wiki("failed", { error: "2 pages failed review" })))
    expect(html).toContain('data-state="failed">failed<')
    expect(html).toContain(`data-flow="wiki.create" data-flow-args="${REPO}"`)
    expect(html).toContain(">Retry<")
    expect(html).toContain("2 pages failed review")
    expect(wikiRow(wiki("failed")).failure).toBe("")
    expect(row(withWiki(wiki("failed")))).toContain(">Retry<")
  })
})
