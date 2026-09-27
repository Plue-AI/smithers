import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import type { Card } from "../state/AppState"
import { ChangeCardBody, DiffCardBody } from "./ChangeCards"
import { gitPatch } from "./DiffSurface"
import { timeLabel } from "../Timestamps"

/*
 * The change and diff cards (lane change, ADR 0003; ADR 0004; lane L1 — the
 * live plue shapes): every facet renders the server's facts — revisions
 * with provenance, interdiff pickers, findings with analyzer runs and the
 * two acts, checks with their work, the verdict strip with the confidence
 * WORD, threads with Done / Ack / Reopen, owners, the landed row, the
 * walkthrough — and a facet whose field is absent renders nothing invented.
 * The Land button names the gate's block. Every act rides onRunCommand with
 * a complete invocation.
 */

GlobalRegistrator.register()

afterAll(async () => {
  for (let tick = 0; tick < 3; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  await GlobalRegistrator.unregister()
})

type ChangePayload = Extract<Card, { kind: "change" }>["payload"]
type DiffPayload = Extract<Card, { kind: "diff" }>["payload"]

/** The pre-revisions payload: no revisions, no reviews, no threads — every L1 field absent. */
const changeCard = (overrides: Partial<ChangePayload> = {}): Extract<Card, { kind: "change" }> => ({
  id: "change-will/smithers-qupxosqw",
  kind: "change",
  title: "qupxosqw · Add the split flow",
  status: "active",
  createdAt: 0,
  ordinal: 0,
  payload: {
    repo: "will/smithers",
    changeId: "qupxosqw",
    description: "Add the split flow\n\nLong body.",
    commitId: "a03f5f1111111111",
    currentSeq: null,
    revisionCount: null,
    revisions: [],
    authorName: "will",
    timestamp: "2026-09-01T10:00:00Z",
    repos: [{ repo: "will/smithers", additions: 2, deletions: 1 }],
    diff: {
      from: "parent",
      to: "current",
      files: [
        { path: "src/app.ts", changeType: "modified", isBinary: false, additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-old\n+new" },
        { path: "docs/guide.md", changeType: "added", isBinary: false, additions: 1, deletions: 0 }
      ]
    },
    checks: [{ context: "build", state: "success" }],
    findings: null,
    reviews: [],
    threads: [],
    conflicts: [],
    stack: stackOf(),
    changeset: null,
    ...overrides
  }
})

/** The default landing request: qupxosqw is its top, 2 of 2 by request order. */
function stackOf(): NonNullable<ChangePayload["stack"]> {
  return {
    landingNumber: 42,
    state: "open",
    position: 2,
    size: 2,
    changeIds: ["mzxvbnmk", "qupxosqw"],
    targetBookmark: "main",
    conflictStatus: "none"
  }
}

/** The live shape (plue #450–#467): two revisions, an agent LGTM and a human approval, three threads, owners. */
const REVISIONS: ChangePayload["revisions"] = [
  { seq: 1, commitId: "b775d9aaaaaaaaaa", parentCommitId: "p1", source: "push", operationIds: [], createdAt: "2026-09-01T08:00:00Z" },
  {
    seq: 2,
    commitId: "a03f5f1111111111",
    parentCommitId: "p2",
    source: "agent",
    agentSessionId: "sess-a03f5f",
    workspaceSnapshotId: "s_8d1",
    operationIds: ["op1"],
    createdAt: "2026-09-01T10:00:00Z"
  }
]

const REVIEWS: NonNullable<ChangePayload["reviews"]> = [
  { reviewer: "will", reviewerLogin: "will", reviewerKind: "human", type: "approve", verdict: "approve", confidence: null, summary: "", commitId: "b775d9aaaaaaaaaa", seq: 1, lastReviewedSeq: 1 },
  /* plue#484: the agent's own word is `lgtm`; its `type` says it counts as an approve. */
  /* plue#500: `reviewer` stays the agent session's id; `reviewerLogin` is the session's title. */
  { reviewer: "sess-a03f5f", reviewerLogin: "Review agent", reviewerKind: "agent", type: "approve", verdict: "lgtm", confidence: "low", summary: "Bounded reads hold; see F-2", commitId: "a03f5f1111111111", seq: 2, lastReviewedSeq: 2 }
]

/** plue#488: the landing's review requests — one human still standing, one agent already fulfilled. */
const REVIEW_REQUESTS: NonNullable<ChangePayload["reviewRequests"]> = [
  { id: 5, reviewer: "ana", agent: null, requestedBy: "will", state: "requested", createdAt: "2026-09-01T10:04:00Z" },
  { id: 6, reviewer: null, agent: "smithers-review", requestedBy: "will", state: "fulfilled", createdAt: "2026-09-01T10:05:00Z" }
]

const THREADS: NonNullable<ChangePayload["threads"]> = [
  { id: 3, path: "src/app.ts", line: 12, currentLine: 14, body: "why this?", author: "will", createdAt: "2026-09-01T10:02:00Z", state: "open", anchor: "moved", commitId: "b775d9aaaaaaaaaa", resolvedInRevision: null },
  { id: 4, path: "src/server.ts", line: 208, currentLine: null, body: "strip the header", author: "ana", createdAt: null, state: "done", anchor: "current", commitId: "a03f5f1111111111", resolvedInRevision: { commitId: "a03f5f1111111111", seq: 2 } },
  { id: 5, path: "src/old.ts", line: 3, currentLine: null, body: "cap the listing", author: "will", createdAt: null, state: "resolved", anchor: "stale", commitId: "b775d9aaaaaaaaaa", resolvedInRevision: { commitId: "b775d9aaaaaaaaaa", seq: 1 } }
]

const OWNERS: NonNullable<ChangePayload["owners"]> = {
  touchedPaths: [
    { path: "src/app.ts", owners: ["will", "core"], agentPolicy: "human-approve", satisfiedBy: { login: "will", seq: 1 } },
    { path: "docs/guide.md", owners: ["ana"], agentPolicy: "human-approve", satisfiedBy: null }
  ],
  requiredApprovers: ["will", "ana"],
  suggestedReviewers: ["ana"],
  missingApprovals: [{ path: "docs/guide.md", candidates: ["ana", "bo"] }]
}

const liveCard = (overrides: Partial<ChangePayload> = {}) =>
  changeCard({
    currentSeq: 2,
    revisionCount: 2,
    revisions: REVISIONS,
    reviews: REVIEWS,
    threads: THREADS,
    turn: { party: "reviewer", actorId: "9", actorLogin: "will", since: "2026-09-01T10:03:00Z", reason: "revision pushed" },
    reviewRequests: REVIEW_REQUESTS,
    owners: OWNERS,
    stack: { ...stackOf(), positionFrom: "server", landablePrefix: 1, blockedBy: [] },
    ...overrides
  })

type Changeset = NonNullable<ChangePayload["changeset"]>

const member = (repository: string, path: string): Changeset["members"][number] => ({
  repository,
  path,
  changeId: "qupxosqw",
  commitId: "a03f5f",
  targetBookmark: "main",
  previousCommitId: null,
  landedCommitId: null
})

const changesetOf = (overrides: Partial<Changeset> = {}): Changeset => ({
  id: 7,
  organization: "will",
  superproject: "will/smithers",
  changeId: "qupxosqw",
  state: "pending",
  failureReason: null,
  targetBookmark: "main",
  members: [],
  ...overrides
})

const landButton = (host: HTMLElement): HTMLButtonElement =>
  host.querySelector('button[data-flow="change.land"]') as HTMLButtonElement

/** The blocking reason a disabled Land wears: the span right after the button. */
const landReason = (host: HTMLElement): string | null => landButton(host).nextElementSibling?.textContent ?? null

const diffCard = (overrides: Partial<DiffPayload> = {}): Extract<Card, { kind: "diff" }> => ({
  id: "diff-will/smithers-qupxosqw",
  kind: "diff",
  title: "qupxosqw · parent → current",
  status: "active",
  createdAt: 0,
  ordinal: 0,
  payload: {
    repo: "will/smithers",
    changeId: "qupxosqw",
    from: "parent",
    to: "current",
    pin: { changeId: "qupxosqw", seq: null, commitId: "a03f5f1111111111" },
    files: [
      { path: "src/app.ts", changeType: "modified", isBinary: false, additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-old\n+new" }
    ],
    ...overrides
  }
})

const renderChange = (card: Extract<Card, { kind: "change" }>) => {
  const commands: Array<{ name: string; args?: string }> = []
  const host = document.createElement("div")
  document.body.append(host)
  flushSync(() => {
    createRoot(host).render(
      <ChangeCardBody card={card} onRunCommand={(name, args) => commands.push({ name, args })} />
    )
  })
  return { host, commands }
}

const renderDiff = (card: Extract<Card, { kind: "diff" }>) => {
  const commands: Array<{ name: string; args?: string }> = []
  const host = document.createElement("div")
  document.body.append(host)
  flushSync(() => {
    createRoot(host).render(
      <DiffCardBody card={card} onRunCommand={(name, args) => commands.push({ name, args })} />
    )
  })
  return { host, commands }
}

test("review evidence labels outdated checks and unread findings and opens the existing facet", () => {
  const { host, commands } = renderChange(liveCard({ checksAt: 1, findings: null,
    unread: { findings: "Analyzer unavailable" } }))
  const evidence = host.querySelector('[aria-label="Review evidence"]')!
  expect(evidence.textContent).toContain("rev 1 · not current")
  expect(evidence.textContent).toContain("Not read: Analyzer unavailable")
  expect(evidence.textContent).toContain("1 open · 1 awaiting acknowledgment")
  const inspect = [...evidence.querySelectorAll("button")].find(button => button.textContent === "Inspect checks")!
  inspect.click()
  expect(commands).toEqual([{ name: "change.facet", args: "qupxosqw checks" }])
})

const click = (host: HTMLElement, testIdOrText: string): void => {
  const button = [...host.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.includes(testIdOrText) || candidate.getAttribute("aria-label") === testIdOrText)
  if (button === undefined) throw new Error(`no button named ${testIdOrText}`)
  flushSync(() => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }))
  })
}

const choose = (host: HTMLElement, ariaLabel: string, value: string): void => {
  const select = host.querySelector(`select[aria-label="${ariaLabel}"]`) as HTMLSelectElement | null
  if (select === null) throw new Error(`no select labelled ${ariaLabel}`)
  select.value = value
  flushSync(() => {
    select.dispatchEvent(new Event("change", { bubbles: true }))
  })
}

const tabs = (host: HTMLElement): Array<string> =>
  [...host.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent?.trim() ?? "")

describe("the change card", () => {
  test("the header omits provenance filler and unrecorded revision counts", () => {
    const { host } = renderChange(changeCard())
    const text = host.textContent ?? ""
    expect(text).not.toContain("will/smithers · qupxosqw · a03f5f11 · will")
    expect(text).not.toContain("Not recorded")
    expect(text).not.toContain("revision not recorded")
    expect(text).not.toContain("rev ")
    expect(text).not.toContain("turn:")
    host.remove()
  })

  test("the header reads rev N of M and the turn's LOGIN once the change GET states them (plue#450, #460, #484)", () => {
    const { host } = renderChange(liveCard())
    const text = host.textContent ?? ""
    expect(text).toContain("rev 2 of 2")
    /* plue#484: the login, then the party — never the numeric actor id. */
    expect(text).toContain("turn: will · reviewer")
    expect(text).not.toContain("turn: 9")
    host.remove()
  })

  test("a turn that names no login falls back to the party alone", () => {
    const { host } = renderChange(
      liveCard({ turn: { party: "author", actorId: "9", actorLogin: null, since: null, reason: null } })
    )
    expect(host.textContent).toContain("turn: author")
    host.remove()
  })

  test("the review strip: the agent's verdict with its confidence WORD, the human approval with revisions since, the owners line (ADR 0004)", () => {
    const { host } = renderChange(liveCard())
    const strip = host.querySelector('[aria-label="Review strip"]')?.textContent ?? ""
    expect(strip).toContain("agent lgtm at rev 2 (low confidence)")
    expect(strip).toContain("will approve at rev 1 · 1 revision since")
    expect(strip).toContain("owners · 1 path missing")
    expect(strip).not.toMatch(/\d+(\.\d+)?%/)
    host.remove()

    const denied = renderChange(
      liveCard({ owners: { ...OWNERS, touchedPaths: [{ path: "docs/guide.md", owners: ["ana"], agentPolicy: "deny", satisfiedBy: null }] } })
    )
    expect(denied.host.querySelector('[aria-label="Review strip"]')?.textContent ?? "").toContain("owners · agent changes denied on docs/guide.md")
    denied.host.remove()

    /* Without reviews or owners the strip is absent — no "not available" line is invented. */
    const bare = renderChange(changeCard())
    expect(bare.host.querySelector('[aria-label="Review strip"]')).toBeNull()
    expect(bare.host.textContent ?? "").not.toContain("owners")
    bare.host.remove()
  })

  test("the diff facet lists the files, each opening its one-file diff at the current pins", () => {
    const { host, commands } = renderChange(changeCard())
    const text = host.textContent ?? ""
    expect(text).toContain("src/app.ts")
    expect(text).toContain("+1 −1")
    click(host, "Open the diff of src/app.ts")
    expect(commands).toEqual([{ name: "change.diff", args: "qupxosqw parent current src/app.ts" }])
    /* No revisions recorded: no pickers to pick from. */
    expect(host.querySelector("select")).toBeNull()
    host.remove()
  })

  test("the diff facet's two pickers pin the interdiff through change.pins; since my review rides review.since-mine (plue#451)", () => {
    const { host, commands } = renderChange(liveCard({ diff: { from: "1", to: "2", files: [] } }))
    const from = host.querySelector('select[aria-label="Diff from"]') as HTMLSelectElement
    const to = host.querySelector('select[aria-label="Diff to"]') as HTMLSelectElement
    expect([...from.options].map((option) => option.textContent)).toEqual(["parent", "rev 1", "rev 2"])
    expect([...to.options].map((option) => option.textContent)).toEqual(["rev 1", "rev 2", "current"])
    expect(from.value).toBe("1")
    expect(to.value).toBe("2")
    expect(host.textContent ?? "").toContain("qupxosqw changes no files rev 1 → rev 2.")
    choose(host, "Diff from", "parent")
    choose(host, "Diff to", "current")
    click(host, "Show the diff since my last review")
    expect(commands).toEqual([
      { name: "change.pins", args: "qupxosqw parent 2" },
      { name: "change.pins", args: "qupxosqw 1 current" },
      { name: "review.since-mine", args: "qupxosqw" }
    ])
    host.remove()

    const since = renderChange(liveCard({ diff: { from: "1", to: "current", files: [], sinceReview: { reviewer: "will", seq: 1 } } }))
    expect(since.host.textContent ?? "").toContain("since your review at rev 1 → current")
    click(since.host, "show all")
    expect(since.commands).toEqual([{ name: "change.pins", args: "qupxosqw parent current" }])
    since.host.remove()
  })

  test("the Request review picker lists the landing's requests and unrequests the one still standing (plue#488)", () => {
    const { host, commands } = renderChange(liveCard({ facet: "review" }))
    const rows = [...host.querySelectorAll('[aria-label="Review requests"] > li')].map((row) => row.textContent ?? "")
    expect(rows[0]).toContain("ana")
    expect(rows[0]).toContain("requested · asked by will")
    /* A request that names an agent renders the agent, not a login. */
    expect(rows[1]).toContain("agent smithers-review")
    expect(rows[1]).toContain("fulfilled")
    /* Only a request still standing can be dismissed. */
    expect(host.querySelectorAll('button[data-flow="review.unrequest"]')).toHaveLength(1)
    click(host, "Dismiss review request 5")
    expect(commands[0]).toEqual({ name: "review.unrequest", args: "qupxosqw 5" })
    host.remove()
  })

  test("a landing whose review requests were not read says so; one that answered none says nobody was asked", () => {
    const unread = renderChange(
      liveCard({ facet: "review", reviewRequests: null, unread: { reviewRequests: "the landing list wasn't read: 503" } })
    )
    expect(unread.host.textContent).toContain("review requests not read (the landing list wasn't read: 503)")
    unread.host.remove()

    const empty = renderChange(liveCard({ facet: "review", reviewRequests: [] }))
    expect(empty.host.textContent).toContain("Nobody has been asked to review qupxosqw.")
    empty.host.remove()
  })

  test("the Suggested reviewers slot asks each name with one click (ADR 0004, plue#488)", () => {
    const { host, commands } = renderChange(liveCard({ facet: "review" }))
    click(host, "Request review from bo")
    expect(commands[0]).toEqual({ name: "review.request", args: "qupxosqw bo" })
    host.remove()
  })

  test("the diff facet offers Split per file while the landable prefix is shorter than the stack (plue#489)", () => {
    const { host, commands } = renderChange(liveCard({ facet: "diff" }))
    /* plue#489 splits by PATH, so the act names the file it moves. */
    expect(host.querySelectorAll('button[data-flow="change.split"]')).toHaveLength(2)
    click(host, "Split docs/guide.md into a new change")
    expect(commands[0]).toEqual({ name: "change.split", args: "qupxosqw docs/guide.md" })
    host.remove()
  })

  test("a stack whose whole prefix can land offers no Split, and neither does one that states no prefix", () => {
    const whole = renderChange(
      liveCard({ facet: "diff", stack: { ...stackOf(), positionFrom: "server", landablePrefix: 2, blockedBy: [] } })
    )
    expect(whole.host.querySelectorAll('button[data-flow="change.split"]')).toHaveLength(0)
    whole.host.remove()

    const silent = renderChange(liveCard({ facet: "diff", stack: { ...stackOf(), positionFrom: "server" } }))
    expect(silent.host.querySelectorAll('button[data-flow="change.split"]')).toHaveLength(0)
    silent.host.remove()
  })

  test("the history facet renders each revision's provenance, Diff to current, Open the computer iff a snapshot exists, and the landed row (plue#450, #464)", () => {
    const { host, commands } = renderChange(
      liveCard({
        facet: "history",
        /* plue#485 states the landing request's NUMBER on the landed row. */
        landed: { at: "2026-09-01T12:00:00Z", by: "will", landingRequestNumber: 42, approvedBy: [{ login: "ana", seq: 2 }] }
      })
    )
    const rows = [...host.querySelectorAll('[aria-label="Revisions"] > li')].map((row) => row.textContent ?? "")
    expect(rows[0]).toContain("rev 1")
    expect(rows[0]).toContain("b775d9aa · push · " + timeLabel(Date.parse("2026-09-01T08:00:00Z")))
    expect(rows[1]).toContain("rev 2")
    expect(rows[1]).toContain("a03f5f11 · agent · agent session sess-a03f5f · snapshot s_8d1 · " + timeLabel(Date.parse("2026-09-01T10:00:00Z")))
    expect(rows[2]).toContain("landed")
    expect(rows[2]).toContain("landing #42 · by will · approved by ana at rev 2 · " + timeLabel(Date.parse("2026-09-01T12:00:00Z")))
    /* rev 1 offers Diff to current; the current revision does not. rev 2 carries the snapshot; rev 1 does not. */
    expect(host.querySelectorAll('button[data-flow="change.pins"]')).toHaveLength(1)
    expect(host.querySelectorAll('button[data-flow="change.open-computer"]')).toHaveLength(0)
    click(host, "Diff rev 1 to current")
    expect(commands).toEqual([
      { name: "change.pins", args: "qupxosqw 1 current" },
    ])
    host.remove()
  })

  test("the history facet with no revisions and no landed row states the empty fact — nothing invented", () => {
    const { host } = renderChange(changeCard({ facet: "history" }))
    const text = host.textContent ?? ""
    expect(text).toContain("No revisions recorded for qupxosqw.")
    expect(text).not.toContain("plue#450")
    expect(text).not.toContain("landed")
    host.remove()
  })

  test("the findings facet renders the analyzer runs, each finding with its revision and state, Please fix, and Not useful (plue#454)", () => {
    const { host, commands } = renderChange(
      liveCard({
        facet: "findings",
        findings: [
          { id: 11, analyzer: "smithers-review", severity: "warning", path: "src/app.ts", line: 40, summary: "error bodies leak the absolute path", raisedAtSeq: 2, state: "current", feedback: null },
          { id: 12, analyzer: "lint", severity: "info", path: "src/old.ts", line: 3, summary: "unused import", raisedAtSeq: 1, state: "stale", feedback: "not_useful" }
        ],
        analyzers: [
          { name: "smithers-review", state: "finished", seq: 2, startedAt: null, finishedAt: null, pausedBy: null, pausedReason: null, failureReason: null },
          { name: "lint", state: "paused", seq: 2, startedAt: null, finishedAt: null, pausedBy: "quota", pausedReason: "monthly analyzer budget spent", failureReason: null }
        ]
      })
    )
    const runs = host.querySelector('[aria-label="Analyzer runs"]')?.textContent ?? ""
    expect(runs).toContain("smithers-review")
    expect(runs).toContain("finished · rev 2")
    expect(runs).toContain("paused · rev 2 · monthly analyzer budget spent")
    const rows = [...host.querySelectorAll('[aria-label="Findings"] > li')]
    expect(rows[0]?.textContent).toContain("warning")
    expect(rows[0]?.textContent).toContain("src/app.ts:40")
    expect(rows[0]?.textContent).toContain("error bodies leak the absolute path")
    expect(rows[0]?.textContent).toContain("rev 2")
    expect(rows[0]?.textContent).not.toContain("stale")
    /* The stale finding stays visible; its recorded feedback dims the row and reads the word. */
    expect(rows[1]?.textContent).toContain("rev 1 · stale · not useful")
    expect(rows[1]?.classList.contains("change-finding--dimmed")).toBe(true)
    expect(rows[0]?.classList.contains("change-finding--dimmed")).toBe(false)
    expect(rows[1]?.querySelector('button[data-flow="findings.not-useful"]')).toBeNull()
    click(host, "Dispatch the agent on finding 11")
    click(host, "Mark finding 11 not useful")
    expect(commands).toEqual([
      { name: "findings.please-fix", args: "qupxosqw 11" },
      { name: "findings.not-useful", args: "qupxosqw 11" }
    ])
    host.remove()
  })

  test("unread findings say so with the reason; a read, empty list states the empty fact — never 'don't exist yet'", () => {
    const unread = renderChange(changeCard({ facet: "findings", findings: null, unread: { findings: "Reading findings failed (500)" } }))
    expect(unread.host.textContent ?? "").toContain("findings not read (Reading findings failed (500))")
    expect(unread.host.textContent ?? "").not.toContain("plue#454")
    unread.host.remove()

    const empty = renderChange(changeCard({ facet: "findings", findings: [], analyzers: [] }))
    expect(empty.host.textContent ?? "").toContain("No findings recorded for qupxosqw.")
    empty.host.remove()
  })

  test("the checks facet renders one row per context with its work, the revision picker, and Open the computer iff the revision carries a snapshot (plue#452)", () => {
    const { host, commands } = renderChange(
      liveCard({
        facet: "checks",
        checksAt: 2,
        checks: [
          { context: "build", state: "success", targetsAffected: 12, targetsRan: 4, targetsCached: 8, durationMs: 12000, workspaceId: "ws-1" },
          { context: "lint", state: "pending", targetsAffected: 0, targetsRan: 0, targetsCached: 0, durationMs: 0, workspaceId: null }
        ]
      })
    )
    const text = host.textContent ?? ""
    expect(text).toContain("build")
    /* Duration reads through the one vocabulary (Timestamps durationLabel): a tenth of a second, not whole seconds. */
    expect(text).toContain("12 affected · 4 ran · 8 cached · 12.0s")
    expect(text).toContain("lint")
    expect(text).not.toContain("0 affected")
    expect((host.querySelector('select[aria-label="Checks at revision"]') as HTMLSelectElement).value).toBe("2")
    choose(host, "Checks at revision", "1")
    expect(commands).toEqual([
      { name: "change.checks", args: "qupxosqw 1" },
    ])
    host.remove()

    /* At rev 1 (no snapshot) the button is absent. */
    const atOne = renderChange(liveCard({ facet: "checks", checksAt: 1 }))
    expect(atOne.host.querySelector('button[data-flow="change.open-computer"]')).toBeNull()
    atOne.host.remove()

    /* Without recorded revisions there is no picker and no work line. */
    const plain = renderChange(changeCard({ facet: "checks" }))
    expect(plain.host.querySelector("select")).toBeNull()
    expect(plain.host.textContent ?? "").toContain("success")
    plain.host.remove()
  })

  test("the review facet renders the verdict rows and the threads with their glyph, anchor token, done revision, and one-click Done / Ack / Reopen (plue#459, #461)", () => {
    const { host, commands } = renderChange(liveCard({ facet: "review" }))
    const verdicts = host.querySelector('[aria-label="Verdicts"]')?.textContent ?? ""
    expect(verdicts).toContain("will")
    expect(verdicts).toContain("approve at rev 1 · 1 revision since")
    /* plue#484: the agent's own verdict word, and the type it counts as, both stated. */
    expect(verdicts).toContain("agent · lgtm · approve at rev 2 · low confidence")
    expect(verdicts).toContain("\"Bounded reads hold; see F-2\"")
    const rows = [...host.querySelectorAll('[aria-label="Review comments"] > li')].map((row) => row.textContent ?? "")
    expect(rows[0]).toContain("○")
    /* plue#484: the thread's author by login (ADR 0004's `· will ·`). */
    expect(rows[0]).toContain("src/app.ts:12 → :14 · will · rev 1 · moved")
    expect(rows[1]).toContain("src/server.ts:208 · ana · rev 2")
    expect(rows[0]).toContain("why this?")
    expect(rows[1]).toContain("◐")
    expect(rows[1]).toContain("done at rev 2")
    expect(rows[2]).toContain("●")
    expect(rows[2]).toContain("src/old.ts:3 · will · rev 1 · stale")
    expect(rows[2]).toContain("resolved")
    expect(host.textContent ?? "").not.toContain("plue#453")
    click(host, "Mark comment 3 done")
    click(host, "Acknowledge comment 4")
    click(host, "Reopen comment 4")
    click(host, "Reopen comment 5")
    expect(commands).toEqual([
      { name: "review.done", args: "qupxosqw 3" },
      { name: "review.ack", args: "qupxosqw 4" },
      { name: "review.reopen", args: "qupxosqw 4" },
      { name: "review.reopen", args: "qupxosqw 5" }
    ])
    /* Open threads carry no Ack; resolved threads carry no Done. */
    expect(host.querySelectorAll('button[data-flow="review.done"]')).toHaveLength(1)
    expect(host.querySelectorAll('button[data-flow="review.ack"]')).toHaveLength(1)
    /* Lane L6 (plue#488): each suggested name is one click of review.request, so the row reads as buttons. */
    expect(host.textContent ?? "").toContain("Suggested reviewers ·")
    expect(
      [...host.querySelectorAll('button[data-flow="review.request"]')].map((button) => button.textContent)
    ).toEqual(["ana", "bo"])
    host.remove()
  })

  test("a review row names the reviewer's login, never the agent session's id (plue#500)", () => {
    const { host } = renderChange(liveCard({ facet: "review" }))
    const verdicts = host.querySelector('[aria-label="Verdicts"]')?.textContent ?? ""
    /* plue#500: the agent row's `reviewer` is still the session id; the row reads the session's title. */
    expect(verdicts).toContain("Review agent")
    expect(verdicts).not.toContain("sess-a03f5f")
    /* The strip's human row reads the same field. */
    expect(host.querySelector('[aria-label="Review strip"]')?.textContent ?? "").toContain("will approve at rev 1")
    host.remove()
  })

  test("a review row that names no login keeps the reviewer the wire gave (plue#500)", () => {
    const { host } = renderChange(
      liveCard({
        facet: "review",
        reviews: [
          { reviewer: "sess-a03f5f", reviewerKind: "agent", verdict: "lgtm", confidence: null, summary: "", commitId: "a03f5f1111111111", seq: 2, lastReviewedSeq: 2 },
          { reviewer: "will", reviewerLogin: null, reviewerKind: "human", verdict: "approve", confidence: null, summary: "", commitId: "b775d9aaaaaaaaaa", seq: 1, lastReviewedSeq: 1 }
        ]
      })
    )
    const verdicts = host.querySelector('[aria-label="Verdicts"]')?.textContent ?? ""
    expect(verdicts).toContain("sess-a03f5f")
    expect(verdicts).toContain("will")
    host.remove()
  })

  test("a thread whose lifecycle the server did not state renders no glyph and no act", () => {
    const { host } = renderChange(
      changeCard({
        facet: "review",
        threads: [{ path: "src/app.ts", line: 12, body: "why this?", author: null, createdAt: "2026-09-01T10:02:00Z", state: null }]
      })
    )
    const text = host.textContent ?? ""
    expect(text).toContain("why this?")
    expect(text).not.toContain("○")
    expect(text).not.toContain("stale")
    expect(text).not.toContain("moved")
    expect(host.querySelector('button[data-flow="review.done"]')).toBeNull()
    expect(host.querySelector('button[data-flow="review.reopen"]')).toBeNull()
    /* No owners on the payload: no Suggested reviewers slot is invented. */
    expect(text).not.toContain("Suggested reviewers")
    host.remove()
  })

  test("the Land button names the gate's block: open threads and the landing list's blocked_by (ADR 0004)", () => {
    const { host } = renderChange(liveCard())
    expect(landButton(host).disabled).toBe(true)
    expect(landReason(host)).toBe("2 comments open")
    host.remove()

    const blocked = renderChange(
      liveCard({
        threads: [],
        stack: {
          ...stackOf(),
          blockedBy: [
            { kind: "check", name: "lint", repo: "smithers", missing: null, count: null, path: null, candidates: [] },
            { kind: "review", name: null, repo: null, missing: "agent_lgtm", count: null, path: null, candidates: [] },
            { kind: "agent_policy", name: null, repo: null, missing: null, count: null, path: "docs/guide.md", candidates: ["ana"] }
          ]
        }
      })
    )
    expect(landButton(blocked.host).disabled).toBe(true)
    expect(landReason(blocked.host)).toBe("check lint · agent LGTM missing · agent changes denied on docs/guide.md")
    blocked.host.remove()

    /* A person's requested changes read plainly, and that person is one press from being asked again. */
    const requested = renderChange(
      liveCard({
        threads: [],
        stack: {
          ...stackOf(),
          blockedBy: [{ kind: "review", name: "ana", repo: null, missing: "changes_requested", count: null, path: null, candidates: [] }]
        }
      })
    )
    expect(landButton(requested.host).disabled).toBe(true)
    expect(landReason(requested.host)).toBe("changes requested by ana")
    const ask = requested.host.querySelector('button[aria-label="Request review from ana"]') as HTMLButtonElement
    expect(ask.textContent).toBe("Ask ana")
    expect(ask.getAttribute("data-flow")).toBe("review.request")
    requested.host.remove()

    /* Every thread resolved and no block: Land runs. */
    const clear = renderChange(liveCard({ threads: [THREADS[2]!] }))
    expect(landButton(clear.host).disabled).toBe(false)
    expect(landButton(clear.host).textContent).toContain("Land 1 → 2")
    clear.host.remove()
  })

  test("the owners facet lists each touched path with its owners by name, the policy word, and who satisfied or is asked (plue#467)", () => {
    const { host } = renderChange(liveCard({ facet: "owners" }))
    expect(tabs(host)).toEqual(["Diff", "Findings", "Checks", "Review", "History", "Owners"])
    const rows = [...host.querySelectorAll('[aria-label="Touched paths"] > li')].map((row) => row.textContent ?? "")
    expect(rows[0]).toContain("src/app.ts")
    expect(rows[0]).toContain("will, core · human-approve · approved by will at rev 1")
    expect(rows[1]).toContain("docs/guide.md")
    expect(rows[1]).toContain("ana · human-approve · missing · ask")
    /* Lane L6 (ADR 0004 row 10, live on plue#488): each candidate carries its own Request review. */
    expect(
      [...host.querySelectorAll('[aria-label="Touched paths"] button[data-flow="review.request"]')].map((button) =>
        button.getAttribute("aria-label")
      )
    ).toEqual(["Request review of docs/guide.md from ana", "Request review of docs/guide.md from bo"])
    const text = host.textContent ?? ""
    expect(text).toContain("Required approvers · will, ana")
    expect(text).toContain("Suggested reviewers ·")
    host.remove()

    /* No owners on the change GET: no Owners tab. */
    const none = renderChange(changeCard())
    expect(tabs(none.host)).toEqual(["Diff", "Findings", "Checks", "Review", "History"])
    none.host.remove()
  })

  test("the walkthrough facet exists only when an artifact does, leads for a large agent revision, and renders its sections (plue#465)", () => {
    const walkthrough = {
      seq: 2,
      sections: [
        { title: "What changed", markdown: "The split flow lands in one module.", diagram: null },
        { title: "How it flows", markdown: "Two steps.", diagram: "graph TD; A-->B" }
      ],
      quiz: [{ question: "q" }]
    }
    const trailing = renderChange(liveCard({ walkthrough, facet: "walkthrough" }))
    expect(tabs(trailing.host)).toEqual(["Diff", "Findings", "Checks", "Review", "History", "Walkthrough", "Owners"])
    const text = trailing.host.textContent ?? ""
    expect(text).toContain("walkthrough of rev 2")
    expect(text).toContain("What changed")
    expect(text).toContain("The split flow lands in one module.")
    expect(text).toContain("graph TD; A-->B")
    expect(text).toContain("Quiz · 1 question")
    trailing.host.remove()

    const files = Array.from({ length: 21 }, (_, index) => ({
      path: `src/f${index}.ts`, changeType: "modified", isBinary: false, additions: 1, deletions: 0
    }))
    const leading = renderChange(liveCard({ walkthrough, diff: { from: "parent", to: "current", files } }))
    expect(tabs(leading.host)[0]).toBe("Walkthrough")
    leading.host.remove()

    /* No artifact: no tab, no "coming soon"; a stale facet pin falls back to the diff. */
    const none = renderChange(changeCard({ facet: "walkthrough" }))
    expect(tabs(none.host)).not.toContain("Walkthrough")
    expect(none.host.textContent ?? "").not.toContain("coming soon")
    expect(none.host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("Diff")
    none.host.remove()
  })

  test("a conflicted change names the files and offers Resolve", () => {
    const { host, commands } = renderChange(
      changeCard({ conflicts: [{ path: "src/app.ts", state: "unresolved" }] })
    )
    expect(host.textContent ?? "").toContain("Conflicted: src/app.ts")
    click(host, "Dispatch an agent to resolve the conflict in src/app.ts")
    expect(commands).toEqual([{ name: "change.resolve", args: "qupxosqw src/app.ts" }])
    host.remove()
  })

  test("an unlanded change never offers Revert; a landed one does", () => {
    const open = renderChange(changeCard())
    expect(open.host.textContent ?? "").not.toContain("Revert")
    open.host.remove()

    const landed = renderChange(changeCard({ stack: { ...stackOf(), state: "merged" } }))
    click(landed.host, "Revert the landed change")
    expect(landed.commands).toEqual([{ name: "change.revert", args: "qupxosqw" }])
    landed.host.remove()
  })

  test("a failed changeset renders its failure reason verbatim with Retry land", () => {
    const { host, commands } = renderChange(
      changeCard({ changeset: changesetOf({ state: "failed", failureReason: "bookmark moved under the land" }) })
    )
    const text = host.textContent ?? ""
    expect(text).toContain("bookmark moved under the land")
    expect(text).toContain("Changeset 7 → main")
    expect(landButton(host).disabled).toBe(false)
    expect(landButton(host).textContent).toContain("Retry land")
    click(host, "Land the changeset")
    expect(commands[0]).toEqual({ name: "change.land", args: "qupxosqw" })
    host.remove()
  })

  test("Land is disabled with the reason while a changeset is landing or landed", () => {
    const landing = renderChange(changeCard({ changeset: changesetOf({ state: "landing" }) }))
    expect(landButton(landing.host).disabled).toBe(true)
    expect(landReason(landing.host)).toBe("landing…")
    landing.host.remove()

    const landed = renderChange(changeCard({ changeset: changesetOf({ state: "landed" }) }))
    expect(landButton(landed.host).disabled).toBe(true)
    expect(landReason(landed.host)).toBe("landed")
    landed.host.remove()
  })

  test("a changeset lists its members as repository · path before the Land confirm", () => {
    const { host } = renderChange(
      changeCard({ changeset: changesetOf({ members: [member("will/cs-api", "services/api"), member("will/cs-web", "apps/web")] }) })
    )
    const text = host.textContent ?? ""
    expect(text).toContain("2 members")
    expect(text).toContain("will/cs-api · services/api")
    expect(text).toContain("will/cs-web · apps/web")
    host.remove()
  })

  test("a changeset's change offers Split ready; a plain one doesn't", () => {
    const plain = renderChange(changeCard())
    expect(plain.host.textContent ?? "").not.toContain("Split ready")
    plain.host.remove()

    const { host, commands } = renderChange(changeCard({ changeset: changesetOf() }))
    click(host, "Split the ready members into a new change")
    expect(commands).toEqual([{ name: "change.split-ready", args: "qupxosqw" }])
    host.remove()

    /* Landed: nothing is left to split. */
    const landed = renderChange(changeCard({ changeset: changesetOf({ state: "landed" }) }))
    expect(landed.host.textContent ?? "").not.toContain("Split ready")
    landed.host.remove()
  })

  test("the Land and Full diff acts carry complete invocations", () => {
    const { host, commands } = renderChange(changeCard())
    click(host, "Land 1 → 2")
    click(host, "Open the full diff card")
    expect(commands).toEqual([
      { name: "change.land", args: "qupxosqw" },
      { name: "change.diff", args: "qupxosqw" }
    ])
    host.remove()
  })

  test("a retained legacy Change opens its recorded change through the shared diff flow", () => {
    const { host, commands } = renderChange(changeCard({ repo: "practice:smithersai/hello-server", stack: null, changeId: "live-change" }))
    click(host, "Open the full diff card")
    expect(commands).toEqual([{ name: "change.diff", args: "live-change" }])
    host.remove()
  })

  test("an error the seam recorded renders on the card", () => {
    const { host } = renderChange(changeCard({ error: "the land failed: bookmark moved" }))
    expect(host.textContent ?? "").toContain("the land failed: bookmark moved")
    host.remove()
  })

  test("an unread checks list says so with its reason — never 'No checks recorded'", () => {
    const unread = renderChange(
      changeCard({ facet: "checks", checks: null, unread: { checks: "Reading statuses failed (500)" } })
    )
    expect(unread.host.textContent ?? "").toContain("checks not read (Reading statuses failed (500))")
    expect(unread.host.textContent ?? "").not.toContain("No checks recorded")
    unread.host.remove()

    const empty = renderChange(changeCard({ facet: "checks", checks: [] }))
    expect(empty.host.textContent ?? "").toContain("No checks recorded at this revision.")
    empty.host.remove()
  })

  test("unread reviews and threads say so with their reasons — never 'No review is recorded'", () => {
    const { host } = renderChange(
      changeCard({
        facet: "review",
        reviews: null,
        threads: null,
        unread: { reviews: "the change DTO carried no reviews[]", threads: "the landing list wasn't read: 502" }
      })
    )
    const text = host.textContent ?? ""
    expect(text).toContain("reviews not read (the change DTO carried no reviews[])")
    expect(text).toContain("threads not read (the landing list wasn't read: 502)")
    expect(text).not.toContain("No review is recorded")
    host.remove()

    const empty = renderChange(changeCard({ facet: "review", reviews: [], threads: [] }))
    expect(empty.host.textContent ?? "").toContain("No review is recorded for qupxosqw.")
    empty.host.remove()
  })

  test("unread conflicts render as unread, never as a clean change", () => {
    const { host } = renderChange(changeCard({ conflicts: null, unread: { conflicts: "Reading conflicts failed (500)" } }))
    expect(host.textContent ?? "").toContain("conflicts not read (Reading conflicts failed (500))")
    expect(host.textContent ?? "").not.toContain("Conflicted:")
    host.remove()
  })

  test("every conflicted file carries its own Resolve", () => {
    const { host, commands } = renderChange(
      changeCard({
        conflicts: [{ path: "src/app.ts", state: "unresolved" }, { path: "docs/guide.md", state: "unresolved" }]
      })
    )
    click(host, "Dispatch an agent to resolve the conflict in docs/guide.md")
    click(host, "Dispatch an agent to resolve the conflict in src/app.ts")
    expect(commands).toEqual([
      { name: "change.resolve", args: "qupxosqw docs/guide.md" },
      { name: "change.resolve", args: "qupxosqw src/app.ts" }
    ])
    host.remove()
  })

  test("a landing request's Land names its scope, and only its top change may land", () => {
    const top = renderChange(changeCard())
    expect(landButton(top.host).disabled).toBe(false)
    expect(landButton(top.host).textContent).toContain("Land 1 → 2")
    expect(landButton(top.host).getAttribute("aria-label")).toBe("Land the change: lands 1 → 2 together")
    top.host.remove()

    const mid = renderChange(
      changeCard({ stack: { ...stackOf(), position: 1, changeIds: ["qupxosqw", "ronvznsk"] } })
    )
    expect(landButton(mid.host).disabled).toBe(true)
    expect(landReason(mid.host)).toBe(
      "Land all 2 changes from ronvznsk."
    )
    mid.host.remove()

    const alone = renderChange(changeCard({ stack: { ...stackOf(), position: 1, size: 1, changeIds: ["qupxosqw"] } }))
    expect(landButton(alone.host).disabled).toBe(false)
    expect(landButton(alone.host).textContent?.trim()).toBe("Land")
    expect(landButton(alone.host).getAttribute("aria-label")).toBe("Land the change: lands qupxosqw alone")
    alone.host.remove()
  })

  test("Land is disabled with the state while a landing request is queued, landing, merged, or closed; failed re-lands", () => {
    const blocked: ReadonlyArray<readonly [string, string]> = [
      ["queued", "queued…"],
      ["landing", "landing…"],
      ["merged", "landed"],
      ["closed", "closed — only open or failed requests can land"]
    ]
    for (const [state, reason] of blocked) {
      const { host } = renderChange(changeCard({ stack: { ...stackOf(), state } }))
      expect(landButton(host).disabled).toBe(true)
      expect(landReason(host)).toBe(reason)
      host.remove()
    }
    const failed = renderChange(changeCard({ stack: { ...stackOf(), state: "failed" } }))
    expect(landButton(failed.host).disabled).toBe(false)
    expect(landButton(failed.host).textContent).toContain("Retry land 1 → 2")
    failed.host.remove()
  })

  test("the landing pill: merged is done, failed is failed, closed is neutral with plue's own word", () => {
    const pills: ReadonlyArray<readonly [string, string]> = [
      ["open", "pending"],
      ["merged", "done"],
      ["failed", "failed"],
      ["closed", "cancelled"]
    ]
    for (const [state, status] of pills) {
      const { host } = renderChange(changeCard({ stack: { ...stackOf(), state } }))
      const pill = host.querySelector("[data-status]")
      expect(pill?.getAttribute("data-status")).toBe(status)
      if (state === "closed") expect(pill?.textContent).toContain("Closed")
      host.remove()
    }
  })

  test("the stack line labels an inferred position as by request order and drops the label for the server's own; the landable prefix rides when stated", () => {
    const inferred = renderChange(changeCard())
    expect(inferred.host.textContent ?? "").toContain("Landing #42 · position 2 of 2 by request order · open → main")
    inferred.host.remove()

    const served = renderChange(liveCard())
    expect(served.host.textContent ?? "").toContain("Landing #42 · position 2 of 2 · open → main · 1 of 2 landable")
    expect(served.host.textContent ?? "").not.toContain("by request order")
    served.host.remove()
  })
})

/*
 * Code intelligence L5 (docs/code-intel/PLAN.md §7): a hunk renders through
 * the lazy DiffSurface on `@pierre/diffs` CodeView — the file card's engine
 * and theme mapping. The verbatim patch is the complete first state while the
 * chunk loads; a patch pierre cannot read stays verbatim (NO INVENTION).
 */
const diffView = (host: HTMLElement): HTMLElement | null => host.querySelector<HTMLElement>('[data-slot="pierre-diff-view"]')

const diffShadow = (host: HTMLElement): ShadowRoot | null => diffView(host)?.querySelector("diffs-container")?.shadowRoot ?? null

/** Poll until the lazy chunk mounted and pierre coloured a token; React settles between macrotasks. */
const highlighted = async (host: HTMLElement): Promise<void> => {
  for (let tick = 0; tick < 600 && diffShadow(host)?.querySelector("[data-line] span[style]") == null; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  if (diffShadow(host)?.querySelector("[data-line] span[style]") == null) throw new Error("the diff view never painted a token")
}

/** Enough macrotasks for a warm lazy boundary to commit and pierre to have started. */
const settled = async (): Promise<void> => {
  for (let tick = 0; tick < 20; tick += 1) await new Promise((resolve) => setTimeout(resolve, 10))
}

/** One file's patch as plue writes it (internal/diffview/diffview.go buildUnifiedPatch): `---`/`+++` labels and the hunks, no `diff --git` line. */
const PLUE_PATCH = "--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-const old = 1\n+const fresh = 2\n"

describe("the diff card's hunks on the code engine", () => {
  test("a hunk shows the verbatim patch first and the highlighted view once the surface has loaded", async () => {
    const { host } = renderDiff(
      diffCard({ files: [{ path: "src/app.ts", changeType: "modified", isBinary: false, additions: 1, deletions: 1, patch: PLUE_PATCH }] })
    )
    // The first diff render in this file: the chunk is cold, so the Suspense fallback is the verbatim patch.
    expect(host.querySelector("pre.world-card-path")?.textContent).toBe(PLUE_PATCH)
    expect(diffView(host)).toBeNull()
    await highlighted(host)
    const shadow = diffShadow(host)
    expect(shadow?.querySelectorAll("[data-line]")).toHaveLength(2)
    expect((shadow?.querySelectorAll("[data-line] span[style]").length ?? 0) > 1).toBe(true)
    // pierre names the file from the header built off the seam's path — the path itself, not `b/src/app.ts`, and no rename.
    expect(shadow?.querySelector("[data-title]")?.textContent).toBe("src/app.ts")
    expect(shadow?.textContent).toContain("const fresh = 2")
    expect(host.querySelector("pre.world-card-path")).toBeNull()
    host.remove()
  }, 30_000)

  test("a patch pierre cannot read stays the verbatim text", async () => {
    await highlighted(renderDiff(diffCard()).host)
    const { host } = renderDiff(
      diffCard({ files: [{ path: "src/app.ts", changeType: "modified", isBinary: false, additions: 1, deletions: 1, patch: "x" }] })
    )
    await settled()
    expect(host.querySelector("pre.world-card-path")?.textContent).toBe("x")
    expect(diffView(host)).toBeNull()
    host.remove()
  }, 30_000)

  test("the seam's headerless patch gains the git header pierre reads, old path first; a headed patch is left alone", () => {
    expect(gitPatch({ path: "src/app.ts", patch: "@@ -1 +1 @@\n-old\n+new" })).toBe("diff --git a/src/app.ts b/src/app.ts\n@@ -1 +1 @@\n-old\n+new")
    const renamed = "--- a/old.ts\n+++ b/new.ts\n@@ -1 +1 @@\n-old\n+new\n"
    expect(gitPatch({ path: "new.ts", oldPath: "old.ts", patch: renamed })).toBe(`diff --git a/old.ts b/new.ts\n${renamed}`)
    const headed = `diff --git a/x.ts b/x.ts\n${PLUE_PATCH}`
    expect(gitPatch({ path: "x.ts", patch: headed })).toBe(headed)
  })
})

describe("the diff card", () => {
  test("the header names the from → to pair and the pin's commit", () => {
    const { host } = renderDiff(diffCard())
    const text = host.textContent ?? ""
    expect(text).toContain("will/smithers · qupxosqw · parent → current")
    expect(text).toContain("pinned at a03f5f1")
    host.remove()
  })

  test("a revision pair reads rev N → rev M and the pin names its revision", () => {
    const { host } = renderDiff(diffCard({ from: "1", to: "2", pin: { changeId: "qupxosqw", seq: 2, commitId: "a03f5f1111111111" } }))
    const text = host.textContent ?? ""
    expect(text).toContain("qupxosqw · rev 1 → rev 2")
    expect(text).toContain("pinned at rev 2 · a03f5f1")
    host.remove()
  })

  test("an inline hunk renders through the diff view; a binary file says so", async () => {
    const { host } = renderDiff(
      diffCard({
        files: [
          { path: "src/app.ts", changeType: "modified", isBinary: false, additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-old\n+new" },
          { path: "logo.png", changeType: "modified", isBinary: true, additions: 0, deletions: 0 }
        ]
      })
    )
    await highlighted(host)
    expect(diffShadow(host)?.textContent).toContain("new")
    expect(host.textContent ?? "").toContain("logo.png is binary")
    host.remove()
  }, 30_000)

  test("an oversized hunk rides by reference and names the re-read command", () => {
    const { host, commands } = renderDiff(
      diffCard({
        files: [{ path: "src/big.ts", changeType: "modified", isBinary: false, additions: 500, deletions: 0, patchLines: 500 }]
      })
    )
    expect(host.textContent ?? "").toContain("src/big.ts's hunk is 500 lines — it rides by reference")
    click(host, "Read it")
    expect(commands).toEqual([{ name: "change.diff", args: "qupxosqw parent current src/big.ts" }])
    host.remove()
  })

  test("a conflicted file is marked", () => {
    const { host } = renderDiff(
      diffCard({
        files: [{ path: "src/app.ts", changeType: "modified", isBinary: false, additions: 1, deletions: 1, patch: "x", conflicted: true }]
      })
    )
    expect(host.textContent ?? "").toContain("conflicted")
    host.remove()
  })
})

/*
 * docs/LOCAL-APP.md's Cards section is this app's written contract, and it
 * drifted once: it stated the pre-plue#446/#450/#451/#453/#454/#468 degraded
 * cards (no `rev N of M`, no revision history, no findings per revision, no
 * stale/moved tokens, a refusing interdiff, a workspace DTO with no facts, a
 * sync card with no ops feed) as current behavior long after the cards had
 * outgrown them. These pin the retired sentences out of the doc and tie the
 * claims it still makes about the change card to what the card renders.
 */
describe("docs/LOCAL-APP.md's Cards section", () => {
  /** The contract as one line, so a claim that wraps across lines still matches. */
  const contract = async (): Promise<string> =>
    (await readFile(new URL("../../../docs/LOCAL-APP.md", import.meta.url), "utf8")).replace(/\s+/g, " ")

  test("no retired degraded claim comes back", async () => {
    const text = await contract()
    for (
      const retired of [
        "never `rev N of M`",
        "Five facet tabs",
        "no stale/moved tokens",
        "no findings per revision",
        "no revision history",
        "a rev → rev interdiff refuses",
        "carries no kind, no uptime, no workspace head",
        "Files and Services (empty with the ADR's wording",
        "The ops feed, the per-op retry, and the sync runs do not exist",
        "`/sync.retry` refuses with the wording",
        "no `/ops` or run route is ever called",
        "the flow refuses with the wording and nothing is called"
      ]
    ) {
      expect(text).not.toContain(retired)
    }
  })

  test("the change card's header form and facet strip are the ones the doc states", async () => {
    const text = await contract()
    const { host } = renderChange(liveCard({ walkthrough: { seq: 2, sections: [], quiz: [] } }))
    expect(host.textContent ?? "").toContain("rev 2 of 2")
    expect(text).toContain("The header names `rev N of M` when recorded")
    /* The five always-on facets, named in the order the strip renders them. */
    const listed = text.slice(text.indexOf("Five facets always switch the body:"))
    const always = tabs(host).filter((label) => label !== "Walkthrough" && label !== "Owners")
    const named = always.map((label) => listed.indexOf(label))
    expect(always.filter((_, index) => named[index] === -1)).toEqual([])
    expect(named).toEqual([...named].sort((left, right) => left - right))
    /* The two conditional facets are named as conditional, not as part of the five. */
    expect(tabs(host)).toContain("Walkthrough")
    expect(text).toContain("Walkthrough joins the strip only when an artifact exists")
    expect(text).toContain("Owners closes the strip only when the change GET carried ownership")
    host.remove()
  })

  test("the sync and workspace claims name routes their seams call", async () => {
    const text = await contract()
    const seam = async (name: string): Promise<string> =>
      (await readFile(new URL(`../state/seams/${name}.ts`, import.meta.url), "utf8")).replace(/\s+/g, " ")
    const workspace = await seam("WorkspaceSeam")
    /* Files and Services are documented as bound facets, and the seam GETs both. */
    expect(text).toContain("Files (the repository file card's own listing, bound to the workspace's routes)")
    expect(workspace).toContain('workspacePath(repoId, workspaceId, "/files")')
    expect(workspace).toContain('workspacePath(repoId, workspaceId, "/services")')

  })
})

test("absent Change auxiliaries render no invented unread sentences in any facet", () => {
  for (const facet of ["diff", "findings", "checks", "review"] as const) {
    const { host } = renderChange(changeCard({ facet, diff: null, conflicts: null, findings: null,
      checks: null, reviews: null, threads: null, reviewRequests: null, stack: null, changeset: null }))
    expect(host.textContent).not.toContain("not read")
    expect(host.textContent).not.toContain("no reason recorded")
    expect(host.textContent).not.toContain("Not recorded")
    expect(host.querySelector('[aria-label="Review evidence"]')).toBeNull()
    host.remove()
  }
})

test("the Change body omits its duplicate provenance timestamp", () => {
  const at = new Date().setHours(4, 5, 0, 0)
  const { host } = renderChange(changeCard({ timestamp: new Date(at).toISOString() }))
  expect(host.textContent).not.toContain(timeLabel(at))
  host.remove()
})

test("the diff header abbreviates commit ids to seven characters and retains full titles", () => {
  const from = "dfea1ec824d94623abeb224108c8b87e5983ad66"
  const to = "b19b9d00cb01b73370aa37bfa70097ca63d7fb71"
  const { host } = renderDiff(diffCard({ changeId: to, from, to, pin: { changeId: to, seq: null, commitId: to } }))
  const header = host.querySelector("p.world-card-path")!
  expect(header.textContent).toBe("will/smithers · b19b9d0 · rev dfea1ec → rev b19b9d0 · pinned at b19b9d0")
  expect(header.querySelector(`[title="${from}"]`)?.textContent).toContain("dfea1ec")
  expect(header.querySelectorAll(`[title="${to}"]`)).toHaveLength(3)
  host.remove()
})
