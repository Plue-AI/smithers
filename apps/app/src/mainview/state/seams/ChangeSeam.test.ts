import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"
import { createAppStore } from "../AppStore"
import type { AppStore } from "../AppStore"
import { createChangeSeam, DEGRADED_CHANGE_REFUSAL, NO_REVERT_REFUSAL, NO_SPLIT_REFUSAL } from "./ChangeSeam"
import { SIGN_OUT_REFUSAL } from "./CloudSignIn"
import type { SeamContext } from "./SeamContext"

/*
 * The changes seam (lane change, ADR 0003; lane L1, the live plue routes):
 * the change card carries every read — revisions, reviews, threads with
 * their lifecycle, findings with analyzer runs, checks with their work,
 * owners, landed provenance, the walkthrough — and the acts ride the live
 * routes (interdiff pins, thread transitions, land with commit_id, snapshot
 * fork) or refuse where none exists (finding feedback / fix, split, revert).
 *
 * Fixtures are shaped from plue's response structs at the deployed commit
 * (internal/services/change.go, landing.go, ownership.go,
 * change_walkthrough.go, commit_status.go @ 1f8b9e2a909b) — source-verified,
 * not observed on the wire; the L1 REPORT marks them `unverified`.
 */

const memoryStorage = (): StorageApi => {
  const data = new Map<string, string>()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key)
  }
}

/* A route factory: a Response's body is consumed once, so shared fixtures must build a fresh one per call. */
const json = (status: number, body: unknown): Route => () =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

/** The change GET (plue ChangeDetailResponse): two revisions, one human approval at rev 1, an agent LGTM at rev 2. */
const CHANGE = {
  change_id: "qupxosqw",
  commit_id: "a03f5f",
  description: "Add the split flow\n\nLong body.",
  author_name: "will",
  author_email: "will@example.com",
  timestamp: "2026-09-01T10:00:00Z",
  has_conflict: true,
  is_empty: false,
  parent_change_ids: ["mzxvbnmk"],
  parent_change_id: "mzxvbnmk",
  revisions: [
    { seq: 1, commit_id: "b775d9", parent_commit_id: "p1", source: "push", operation_ids: [], created_at: "2026-09-01T08:00:00Z" },
    {
      seq: 2,
      commit_id: "a03f5f",
      parent_commit_id: "p2",
      source: "agent",
      agent_session_id: "sess-a03",
      workspace_snapshot_id: "s_8d1",
      operation_ids: ["op1"],
      created_at: "2026-09-01T10:00:00Z"
    }
  ],
  /*
   * plue#484 added `type` beside `verdict`. plue's own query is
   * `COALESCE(lrr.verdict, lrr.type) AS verdict`, so a human's two words are
   * the same and an AGENT's differ (`lgtm` counting as an `approve`).
   */
  reviews: [
    { reviewer: "will", reviewer_login: "will", reviewer_kind: "human", type: "approve", verdict: "approve", confidence_bucket: null, summary: "", commit_id: "b775d9", seq: 1, last_reviewed_seq: 1 },
    /* plue#500: an agent review keeps the session id in `reviewer` and names the session's title in `reviewer_login`. */
    { reviewer: "sess-a03", reviewer_login: "Review agent", reviewer_kind: "agent", type: "approve", verdict: "lgtm", confidence_bucket: "low", summary: "Bounded reads hold; see F-2", commit_id: "a03f5f", seq: 2, last_reviewed_seq: 2 }
  ],
  current_seq: 2,
  conflicts: [{ path: "src/app.ts", state: "unresolved" }],
  /* plue#485: the landing request's NUMBER rides beside its unusable DB id; plue#484: the turn names its actor's login. */
  stack: {
    landing_request_id: 900,
    landing_request_number: 42,
    position: 2,
    size: 2,
    turn: { party: "reviewer", actor_id: "9", actor_login: "will", since: "2026-09-01T10:03:00Z", reason: "revision pushed" }
  },
  turn: { party: "reviewer", actor_id: "9", actor_login: "will", since: "2026-09-01T10:03:00Z", reason: "revision pushed" },
  revision_seq: 2,
  owners: {
    touched_paths: [
      { path: "src/app.ts", package: "//src", owners: [{ login: "will", role: "owner", reasons: [] }, { team: "core", role: "owner", reasons: [] }], agent_policy: "human-approve", packages: ["//src"], satisfied_by: { login: "will", seq: 1 } },
      { path: "docs/guide.md", package: "//docs", owners: [{ login: "ana", role: "owner", reasons: [] }], agent_policy: "deny", packages: ["//docs"], satisfied_by: null }
    ],
    required_approvers: ["will", "ana"],
    suggested_reviewers: ["ana"],
    missing_approvals: [{ path: "docs/guide.md", candidates: ["ana"] }]
  },
  landed: null
}

const DIFF = {
  change_id: "qupxosqw",
  file_diffs: [
    {
      path: "src/app.ts",
      change_type: "modified",
      patch: "@@ -1 +1 @@\n-old\n+new",
      is_binary: false,
      additions: 1,
      deletions: 1
    },
    {
      path: "docs/guide.md",
      change_type: "added",
      patch: "@@ -0,0 +1 @@\n+hello",
      is_binary: false,
      additions: 1,
      deletions: 0
    }
  ]
}

/** One landing list row (plue LandingRequestResponse): readiness fields ride the list. */
const LANDING = {
  number: 42,
  state: "open",
  change_ids: ["mzxvbnmk", "qupxosqw"],
  stack_size: 2,
  target_bookmark: "main",
  conflict_status: "none",
  agent_authored: false,
  turn: { party: "reviewer", actor_id: "9", actor_login: "will", since: "2026-09-01T10:03:00Z", reason: "revision pushed" },
  /* plue#488: who has been asked to review — one human and one named agent. */
  review_requests: [
    {
      id: 5,
      requested_by: { id: 7, login: "will" },
      reviewer: { id: 9, login: "ana" },
      state: "requested",
      created_at: "2026-09-01T10:04:00Z"
    },
    {
      id: 6,
      requested_by: { id: 7, login: "will" },
      reviewer: null,
      agent: "smithers-review",
      state: "fulfilled",
      created_at: "2026-09-01T10:05:00Z"
    }
  ],
  auto_land: { enabled: false, set_by: null, set_at: null, waiting_on: [] },
  landable_prefix: 1,
  blocked_by: {
    qupxosqw: [{ kind: "check", name: "lint", repo: "smithers" }, { kind: "owner", path: "docs/guide.md", candidates: ["ana"] }]
  }
}

/*
 * Three threads (plue LandingCommentResponse): open, done (awaiting Ack),
 * resolved. plue#486 split the two states the response used to collide:
 * `state` is now the LIFECYCLE and `anchor_state` the anchor's position.
 * plue#484 names the author with `user_login`.
 */
const COMMENTS = [
  {
    id: 3, landing_request_id: 900, user_id: 9, user_login: "will", path: "src/app.ts", line: 12, side: "new", body: "why this?",
    commit_id: "b775d9", anchor_hash: "h1", state: "open", anchor_state: "moved", current_line: 14, done_at: null, done_by: null,
    resolved_in_revision: null, resolved_at: null, resolved_by: null, created_at: "2026-09-01T10:02:00Z", updated_at: "2026-09-01T10:02:00Z"
  },
  {
    id: 4, landing_request_id: 900, user_id: 9, user_login: "ana", path: "src/server.ts", line: 208, side: "new", body: "strip the header",
    commit_id: "a03f5f", anchor_hash: "h2", state: "done", anchor_state: "current", done_at: "2026-09-01T10:05:00Z", done_by: 7,
    resolved_in_revision: { commit_id: "a03f5f", seq: 2 }, resolved_at: null, resolved_by: null, created_at: "2026-09-01T10:04:00Z", updated_at: "2026-09-01T10:05:00Z"
  },
  {
    id: 5, landing_request_id: 900, user_id: 9, user_login: "will", path: "src/old.ts", line: 3, side: "new", body: "cap the listing",
    commit_id: "b775d9", anchor_hash: "h3", state: "resolved", anchor_state: "stale", done_at: "2026-09-01T09:00:00Z", done_by: 7,
    resolved_in_revision: { commit_id: "b775d9", seq: 1 }, resolved_at: "2026-09-01T09:30:00Z", resolved_by: 9, created_at: "2026-09-01T08:30:00Z", updated_at: "2026-09-01T09:30:00Z"
  }
]

/** The findings route (plue ChangeFindingsResponse): one current, one stale with feedback, two analyzer runs. */
const FINDINGS = {
  change_id: "qupxosqw",
  current_seq: 2,
  findings: [
    { id: 11, seq: 2, commit_id: "a03f5f", analyzer: "smithers-review", source: "agent", path: "src/app.ts", line: 40, side: "new", severity: "warning", text: "error bodies leak the absolute path", state: "current", created_at: "2026-09-01T10:06:00Z" },
    /* plue#487: `feedback` is an OBJECT (services.FindingFeedbackResponse), not a word. */
    { id: 12, seq: 1, commit_id: "b775d9", analyzer: "lint", source: "analyzer", path: "src/old.ts", line: 3, side: "new", severity: "info", text: "unused import", feedback: { useful: false, by_user_id: 7 }, feedback_counts: { useful: 0, not_useful: 1 }, state: "stale", created_at: "2026-09-01T08:10:00Z" }
  ],
  analyzers: [
    { name: "smithers-review", state: "finished", seq: 2, started_at: "2026-09-01T10:05:00Z", finished_at: "2026-09-01T10:06:00Z" },
    { name: "lint", state: "paused", seq: 2, started_at: null, finished_at: null, paused_by: "quota", paused_reason: "monthly analyzer budget spent" }
  ]
}

/** The statuses route (plue db.CommitStatus): the newest per context wins; rows carry their work. */
const STATUSES = {
  statuses: [
    { context: "build", status: "success", created_at: "2026-09-01T09:59:00Z", targets_affected: 12, targets_ran: 4, targets_cached: 8, duration_ms: 12000, workspace_id: "ws-1" },
    { context: "build", status: "pending", created_at: "2026-09-01T09:00:00Z", targets_affected: 0, targets_ran: 0, targets_cached: 0, duration_ms: 0, workspace_id: null },
    { context: "lint", status: "pending", created_at: "2026-09-01T09:59:00Z", targets_affected: 0, targets_ran: 0, targets_cached: 0, duration_ms: 0, workspace_id: null }
  ]
}

const WALKTHROUGH = {
  sections: [
    { title: "What changed", markdown: "The split flow lands in **one** module." },
    { title: "How it flows", markdown: "Two steps.", diagram: "graph TD; A-->B" }
  ],
  quiz: [{ question: "Where does the split live?", answer: "packages/smithers/flows/flow" }]
}

const REPO = "api/repos/will/smithers"
const CHANGE_ROUTE = `${REPO}/changes/qupxosqw`

/** The routes a `change.view` touches for a repo with no org. */
const viewRoutes: Record<string, Route> = {
  [CHANGE_ROUTE]: json(200, CHANGE),
  [`${CHANGE_ROUTE}/diff`]: json(200, DIFF),
  [`${CHANGE_ROUTE}/findings`]: json(200, FINDINGS),
  [`${CHANGE_ROUTE}/walkthrough?rev=2`]: json(200, WALKTHROUGH),
  [`${REPO}/landings?limit=100`]: json(200, { items: [LANDING] }),
  [`${REPO}/commits/a03f5f/statuses?limit=100`]: json(200, STATUSES),
  [`${REPO}/landings/42/comments?limit=100`]: json(200, { comments: COMMENTS })
}

type Route = (request: { readonly method: string; readonly body: string | null }) => Response

const harness = async (
  routes: Record<string, Route>,
  options: { readonly signedIn?: boolean; readonly degraded?: boolean; readonly ownerKind?: "user" | "org"; readonly workspaceError?: string } = {}
) => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const requests: Array<string> = []
  const bodies: Record<string, string | null> = {}
  const shownWorkspaces: Array<string> = []
  const ctx: SeamContext = {
    http: async (input, init) => {
      const method = init?.method ?? "GET"
      const path = input.startsWith("/") ? input.slice(1) : input
      const key = `${method} ${path}`
      requests.push(key)
      const body = typeof init?.body === "string" ? init.body : null
      bodies[key] = body
      const route = routes[key] ?? routes[path]
      if (route === undefined) return json(404, { message: `no route ${key}` })({ method, body })
      return route({ method, body })
    },
    baseUrl: "",
    store,
    dispatch: store.dispatch,
    actor: () => "user",
    nextOrdinal: () => 0
  }
  if (options.signedIn !== false) {
    await store.dispatch({
      type: "cloud.session.loaded",
      actor: "system",
      state: "signed-in",
      username: "will",
      expiresAt: null,
      scopes: options.degraded === true ? "degraded" : null
    })
  }
  await store.dispatch({
    type: "repositories.loaded",
    actor: "system",
    repositories: [
      {
        id: "will/smithers",
        org: "will",
        ownerKind: options.ownerKind ?? "user",
        name: "smithers",
        head: { bookmark: "main", changeId: "qupxosqw", commitId: "c0ffee1" }
      }
    ]
  })
  const seam = createChangeSeam(ctx, {
    viewWorkspace: async (workspaceId) => {
      shownWorkspaces.push(workspaceId)
      return options.workspaceError ?? { value: `shown ${workspaceId}` }
    }
  })
  return { store, seam, requests, bodies, shownWorkspaces }
}

const textOf = (result: unknown): string | undefined =>
  typeof result === "string" ? result : (result as { value?: string } | null | undefined)?.value

const changeCardOf = (store: AppStore) => store.collections.cards.get("change-will/smithers-qupxosqw")
const diffCardOf = (store: AppStore) => store.collections.cards.get("diff-will/smithers-qupxosqw")

/** The change card's payload, narrowed; undefined when the card is absent. */
const payloadOf = (store: AppStore) => {
  const card = changeCardOf(store)
  return card?.kind === "change" ? card.payload : undefined
}

const diffPayloadOf = (store: AppStore) => {
  const card = diffCardOf(store)
  return card?.kind === "diff" ? card.payload : undefined
}

describe("createChangeSeam", () => {
  test("change.view loads the change row, every auxiliary, and renders the card", async () => {
    const { store, seam } = await harness(viewRoutes)
    const result = await seam.viewChange("qupxosqw")

    expect(textOf(result)).toBe("Change qupxosqw on will/smithers — the card tracks it.")
    const row = store.collections.changes.get("will/smithers#qupxosqw")
    expect(row?.changeId).toBe("qupxosqw")
    expect(row?.commitId).toBe("a03f5f")
    expect(row?.hasConflict).toBe(true)
    expect(row?.parentChangeIds).toEqual(["mzxvbnmk"])
    expect(row?.currentSeq).toBe(2)
    expect(row?.revisionCount).toBe(2)

    const payload = payloadOf(store)
    expect(payload?.repo).toBe("will/smithers")
    expect(payload?.description).toBe("Add the split flow\n\nLong body.")
    expect(payload?.commitId).toBe("a03f5f")
    expect(payload?.currentSeq).toBe(2)
    expect(payload?.authorName).toBe("will")
    expect(payload?.repos).toEqual([{ repo: "will/smithers", additions: 2, deletions: 1 }])
    expect(payload?.diff?.from).toBe("parent")
    expect(payload?.diff?.to).toBe("current")
    expect(payload?.diff?.files).toHaveLength(2)
    expect(payload?.conflicts).toEqual([{ path: "src/app.ts", state: "unresolved" }])
    expect(payload?.stack?.landingNumber).toBe(42)
    expect(payload?.stack?.changeIds).toEqual(["mzxvbnmk", "qupxosqw"])
    expect(payload?.changeset).toBeNull()
    expect(payload?.unread).toBeUndefined()
    const card = changeCardOf(store)
    expect(card?.title).toBe("qupxosqw · Add the split flow")
    expect(card?.status).toBe("active")
  })

  test("revisions ride the change GET with parent commit, source, session, snapshot, and created_at (plue#450)", async () => {
    const { store, seam } = await harness(viewRoutes)
    await seam.viewChange("qupxosqw")
    expect(payloadOf(store)?.revisions).toEqual([
      { seq: 1, commitId: "b775d9", parentCommitId: "p1", source: "push", operationIds: [], createdAt: "2026-09-01T08:00:00Z" },
      {
        seq: 2,
        commitId: "a03f5f",
        parentCommitId: "p2",
        source: "agent",
        agentSessionId: "sess-a03",
        workspaceSnapshotId: "s_8d1",
        operationIds: ["op1"],
        createdAt: "2026-09-01T10:00:00Z"
      }
    ])
    expect(payloadOf(store)?.revisionCount).toBe(2)
  })

  test("reviews ride the change GET with reviewer_kind, plue#500's reviewer_login, the verdict AND plue#484's type, the confidence WORD, and last_reviewed_seq", async () => {
    const { store, seam, requests } = await harness(viewRoutes)
    await seam.viewChange("qupxosqw")
    expect(payloadOf(store)?.reviews).toEqual([
      { reviewer: "will", reviewerLogin: "will", reviewerKind: "human", type: "approve", verdict: "approve", confidence: null, summary: "", commitId: "b775d9", seq: 1, lastReviewedSeq: 1 },
      /* The agent's own word is `lgtm`; plue#484's `type` says it counts to the gate as an approve. */
      /* plue#500: `reviewer` stays the agent session's id and `reviewer_login` names the session. */
      { reviewer: "sess-a03", reviewerLogin: "Review agent", reviewerKind: "agent", type: "approve", verdict: "lgtm", confidence: "low", summary: "Bounded reads hold; see F-2", commitId: "a03f5f", seq: 2, lastReviewedSeq: 2 }
    ])
    /* The landing's own /reviews list is not read: the change GET is the revision-aware source. */
    expect(requests.some((request) => request.includes("/landings/42/reviews"))).toBe(false)
  })

  test("a review row that states no reviewer_login carries none — the card keeps the reviewer the wire named (plue#500)", async () => {
    /*
     * plue writes `reviewer_login` without omitempty and leaves it EMPTY when
     * the identity lookup misses, so an unresolved row and a server that
     * predates #500 look the same to the app: no login, and the reviewer
     * field stands as it did before.
     */
    const { store, seam } = await harness({
      ...viewRoutes,
      [CHANGE_ROUTE]: json(200, {
        ...CHANGE,
        reviews: [
          { reviewer: "sess-a03", reviewer_login: "", reviewer_kind: "agent", verdict: "lgtm", confidence_bucket: null, summary: "", commit_id: "a03f5f", seq: 2, last_reviewed_seq: 2 },
          { reviewer: "will", reviewer_kind: "human", verdict: "approve", confidence_bucket: null, summary: "", commit_id: "b775d9", seq: 1, last_reviewed_seq: 1 }
        ]
      })
    })
    await seam.viewChange("qupxosqw")
    expect((payloadOf(store)?.reviews ?? []).map((review) => [review.reviewer, review.reviewerLogin])).toEqual([
      ["sess-a03", null],
      ["will", null]
    ])
  })

  test("the turn, the server's stack position, and the gate's blocks ride the card (plue#460, #452)", async () => {
    const { store, seam } = await harness(viewRoutes)
    await seam.viewChange("qupxosqw")
    const payload = payloadOf(store)
    /* plue#484: the turn names its actor's LOGIN beside the id the card never renders. */
    expect(payload?.turn).toEqual({
      party: "reviewer",
      actorId: "9",
      actorLogin: "will",
      since: "2026-09-01T10:03:00Z",
      reason: "revision pushed"
    })
    expect(payload?.stack?.position).toBe(2)
    expect(payload?.stack?.size).toBe(2)
    expect(payload?.stack?.positionFrom).toBe("server")
    expect(payload?.stack?.landablePrefix).toBe(1)
    expect(payload?.stack?.blockedBy).toEqual([
      { kind: "check", name: "lint", repo: "smithers", missing: null, count: null, path: null, candidates: [] },
      { kind: "owner", name: null, repo: null, missing: null, count: null, path: "docs/guide.md", candidates: ["ana"] }
    ])
  })

  test("threads carry plue#486's own state and anchor_state, plue#484's author, and resolved_in_revision", async () => {
    const { store, seam } = await harness(viewRoutes)
    await seam.viewChange("qupxosqw")
    const threads = payloadOf(store)?.threads ?? []
    expect(threads.map((thread) => [thread.id, thread.state, thread.anchor, thread.currentLine])).toEqual([
      [3, "open", "moved", 14],
      [4, "done", "current", null],
      [5, "resolved", "stale", null]
    ])
    expect(threads[1]?.resolvedInRevision).toEqual({ commitId: "a03f5f", seq: 2 })
    expect(threads[0]?.resolvedInRevision).toBeNull()
    /* plue#484: the comment row names its author's login, and the card renders that. */
    expect(threads.map((thread) => thread.author)).toEqual(["will", "ana", "will"])
  })

  test("findings ride with their revision, state, feedback, and the analyzer runs (plue#454)", async () => {
    const { store, seam } = await harness(viewRoutes)
    await seam.viewChange("qupxosqw")
    const payload = payloadOf(store)
    expect(payload?.findings).toEqual([
      { id: 11, analyzer: "smithers-review", source: "agent", severity: "warning", path: "src/app.ts", line: 40, summary: "error bodies leak the absolute path", suggestion: null, raisedAtSeq: 2, commitId: "a03f5f", state: "current", feedback: null },
      { id: 12, analyzer: "lint", source: "analyzer", severity: "info", path: "src/old.ts", line: 3, summary: "unused import", suggestion: null, raisedAtSeq: 1, commitId: "b775d9", state: "stale", feedback: "not useful" }
    ])
    expect(payload?.analyzers).toEqual([
      { name: "smithers-review", state: "finished", seq: 2, startedAt: "2026-09-01T10:05:00Z", finishedAt: "2026-09-01T10:06:00Z", pausedBy: null, pausedReason: null, failureReason: null },
      { name: "lint", state: "paused", seq: 2, startedAt: null, finishedAt: null, pausedBy: "quota", pausedReason: "monthly analyzer budget spent", failureReason: null }
    ])
  })

  test("checks carry their work and workspace, newest per context, read at the current revision (plue#452)", async () => {
    const { store, seam } = await harness(viewRoutes)
    await seam.viewChange("qupxosqw")
    expect(payloadOf(store)?.checks).toEqual([
      { context: "build", state: "success", targetsAffected: 12, targetsRan: 4, targetsCached: 8, durationMs: 12000, workspaceId: "ws-1" },
      { context: "lint", state: "pending", targetsAffected: 0, targetsRan: 0, targetsCached: 0, durationMs: 0, workspaceId: null }
    ])
    expect(payloadOf(store)?.checksAt).toBe(2)
  })

  test("change.checks reads the statuses at another revision's commit", async () => {
    const { store, seam, requests } = await harness({
      ...viewRoutes,
      [`${REPO}/commits/b775d9/statuses?limit=100`]: json(200, {
        statuses: [{ context: "build", status: "failure", created_at: "2026-09-01T08:30:00Z", targets_affected: 3, targets_ran: 3, targets_cached: 0, duration_ms: 900 }]
      })
    })
    expect(textOf(await seam.checksAt("qupxosqw", 1))).toBe("Checks of qupxosqw at rev 1.")
    expect(requests).toContain(`GET ${REPO}/commits/b775d9/statuses?limit=100`)
    expect(payloadOf(store)?.checks).toEqual([
      { context: "build", state: "failure", targetsAffected: 3, targetsRan: 3, targetsCached: 0, durationMs: 900 }
    ])
    expect(payloadOf(store)?.checksAt).toBe(1)
    expect(payloadOf(store)?.facet).toBe("checks")

    expect(textOf(await seam.checksAt("qupxosqw", 7))).toBe("qupxosqw has no rev 7 to read checks at.")
  })

  test("owners ride the change GET: touched paths with owners by name, the policy word, satisfied_by, and the missing approvals (plue#467)", async () => {
    const { store, seam } = await harness(viewRoutes)
    await seam.viewChange("qupxosqw")
    expect(payloadOf(store)?.owners).toEqual({
      touchedPaths: [
        { path: "src/app.ts", owners: ["will", "core"], agentPolicy: "human-approve", satisfiedBy: { login: "will", seq: 1 } },
        { path: "docs/guide.md", owners: ["ana"], agentPolicy: "deny", satisfiedBy: null }
      ],
      requiredApprovers: ["will", "ana"],
      suggestedReviewers: ["ana"],
      missingApprovals: [{ path: "docs/guide.md", candidates: ["ana"] }]
    })
  })

  test("the walkthrough at the current revision rides the card; a 404 is 'none', never an unread (plue#465)", async () => {
    const { store, seam } = await harness(viewRoutes)
    await seam.viewChange("qupxosqw")
    expect(payloadOf(store)?.walkthrough).toEqual({
      seq: 2,
      sections: [
        { title: "What changed", markdown: "The split flow lands in **one** module.", diagram: null },
        { title: "How it flows", markdown: "Two steps.", diagram: "graph TD; A-->B" }
      ],
      quiz: [{ question: "Where does the split live?", answer: "packages/smithers/flows/flow" }]
    })

    const none = await harness({ ...viewRoutes, [`${CHANGE_ROUTE}/walkthrough?rev=2`]: json(404, { message: "walkthrough not found" }) })
    await none.seam.viewChange("qupxosqw")
    expect(payloadOf(none.store)?.walkthrough).toBeNull()
    expect(payloadOf(none.store)?.unread).toBeUndefined()

    const down = await harness({ ...viewRoutes, [`${CHANGE_ROUTE}/walkthrough?rev=2`]: json(500, { message: "artifact store down" }) })
    await down.seam.viewChange("qupxosqw")
    expect(payloadOf(down.store)?.walkthrough).toBeNull()
    expect(payloadOf(down.store)?.unread?.walkthrough).toBe("artifact store down")
  })

  test("landed provenance rides the change GET (plue#464)", async () => {
    const { store, seam } = await harness({
      ...viewRoutes,
      [CHANGE_ROUTE]: json(200, {
        ...CHANGE,
        landed: { at: "2026-09-01T12:00:00Z", by: "will", approved_by: [{ login: "ana", seq: 2 }] }
      })
    })
    await seam.viewChange("qupxosqw")
    expect(payloadOf(store)?.landed).toEqual({
      at: "2026-09-01T12:00:00Z",
      by: "will",
      /* plue#485: a landed row states the request's NUMBER; this fixture states none. */
      landingRequestNumber: null,
      approvedBy: [{ login: "ana", seq: 2 }]
    })
  })

  test("change.view with a rev pins the Diff facet parent → rev through the interdiff route (plue#451)", async () => {
    const { store, seam, requests } = await harness({
      ...viewRoutes,
      [`${CHANGE_ROUTE}/diff?from=parent&to=1`]: json(200, { change_id: "qupxosqw", file_diffs: [DIFF.file_diffs[0]] })
    })
    expect(textOf(await seam.viewChange("qupxosqw", 1))).toBe("Change qupxosqw on will/smithers at rev 1 — the card's diff is pinned parent → rev 1.")
    expect(requests).toContain(`GET ${CHANGE_ROUTE}/diff?from=parent&to=1`)
    expect(payloadOf(store)?.diff?.from).toBe("parent")
    expect(payloadOf(store)?.diff?.to).toBe("1")
    expect(payloadOf(store)?.diff?.files).toHaveLength(1)
    expect(payloadOf(store)?.facet).toBe("diff")
  })

  test("change.view with a rev the change lacks refuses by name and reads no diff", async () => {
    const { seam, requests } = await harness(viewRoutes)
    expect(textOf(await seam.viewChange("qupxosqw", 7))).toBe("qupxosqw has no rev 7 — its revisions are 1 → 2.")
    expect(requests.some((request) => request.includes("/diff"))).toBe(false)
  })

  test("change.pins reads the interdiff rev N → rev M and keeps the Diff facet", async () => {
    const { store, seam, requests } = await harness({
      ...viewRoutes,
      [`${CHANGE_ROUTE}/diff?from=1&to=2`]: json(200, { change_id: "qupxosqw", file_diffs: [] })
    })
    expect(textOf(await seam.setPins("qupxosqw", "1", "2"))).toBe("Diff of qupxosqw pinned rev 1 → rev 2.")
    expect(requests).toContain(`GET ${CHANGE_ROUTE}/diff?from=1&to=2`)
    expect(payloadOf(store)?.diff).toEqual({ from: "1", to: "2", files: [], sinceReview: null })

    /* `current` on the to side names the current revision's seq. */
    requests.length = 0
    expect(textOf(await seam.setPins("qupxosqw", "1", "current"))).toBe("Diff of qupxosqw pinned rev 1 → current.")
    expect(requests).toContain(`GET ${CHANGE_ROUTE}/diff?from=1&to=2`)

    /* Back to the default: the bare route. */
    requests.length = 0
    await seam.setPins("qupxosqw", "parent", "current")
    expect(requests).toContain(`GET ${CHANGE_ROUTE}/diff`)
  })

  /*
   * A picker changes ONE panel. The loaded card already carries the
   * revisions its pins resolve against, so `change.pins` and
   * `change.checks` read the single route they change and leave every other
   * panel at the freshness `change.view` gave it — the Diff facet no longer
   * waits on the walkthrough, the findings and the landing list to render.
   */
  test("a picker on a loaded card reads only the panel it names", async () => {
    const { store, seam, requests } = await harness({
      ...viewRoutes,
      [`${CHANGE_ROUTE}/diff?from=1&to=2`]: json(200, { change_id: "qupxosqw", file_diffs: [DIFF.file_diffs[0]] }),
      [`${REPO}/commits/b775d9/statuses?limit=100`]: json(200, {
        statuses: [{ context: "build", status: "failure", created_at: "2026-09-01T08:30:00Z", targets_affected: 3, targets_ran: 3, targets_cached: 0, duration_ms: 900 }]
      })
    })
    await seam.viewChange("qupxosqw")

    requests.length = 0
    expect(textOf(await seam.setPins("qupxosqw", "1", "2"))).toBe("Diff of qupxosqw pinned rev 1 → rev 2.")
    expect(requests).toEqual([`GET ${CHANGE_ROUTE}/diff?from=1&to=2`])
    expect(payloadOf(store)?.diff?.from).toBe("1")
    expect(payloadOf(store)?.diff?.to).toBe("2")
    expect(payloadOf(store)?.diff?.files).toHaveLength(1)
    expect(payloadOf(store)?.repos).toEqual([{ repo: "will/smithers", additions: 1, deletions: 1 }])
    expect(payloadOf(store)?.facet).toBe("diff")
    /* every panel the pin does not name keeps what change.view read. */
    expect(payloadOf(store)?.checks).toHaveLength(2)
    expect(payloadOf(store)?.checksAt).toBe(2)
    expect(payloadOf(store)?.findings).toHaveLength(2)
    expect(payloadOf(store)?.walkthrough?.sections).toHaveLength(2)
    expect(payloadOf(store)?.threads).toHaveLength(3)
    expect(payloadOf(store)?.stack?.landingNumber).toBe(42)
    expect(payloadOf(store)?.conflicts).toEqual([{ path: "src/app.ts", state: "unresolved" }])

    requests.length = 0
    expect(textOf(await seam.checksAt("qupxosqw", 1))).toBe("Checks of qupxosqw at rev 1.")
    expect(requests).toEqual([`GET ${REPO}/commits/b775d9/statuses?limit=100`])
    expect(payloadOf(store)?.checks).toEqual([
      { context: "build", state: "failure", targetsAffected: 3, targetsRan: 3, targetsCached: 0, durationMs: 900 }
    ])
    expect(payloadOf(store)?.checksAt).toBe(1)
    expect(payloadOf(store)?.facet).toBe("checks")
    /* the diff the checks picker left alone. */
    expect(payloadOf(store)?.diff?.from).toBe("1")
    expect(payloadOf(store)?.walkthrough?.sections).toHaveLength(2)
  })

  test("a picker's own unread answer marks its panel, and only its panel", async () => {
    /* No `from=1&to=2` route: the interdiff answers 404, the rest of the card stands. */
    const { store, seam } = await harness(viewRoutes)
    await seam.viewChange("qupxosqw")
    expect(textOf(await seam.setPins("qupxosqw", "1", "2"))).toBe("Diff of qupxosqw pinned rev 1 → rev 2.")
    expect(payloadOf(store)?.diff).toBeNull()
    expect(payloadOf(store)?.unread?.diff).toBeDefined()
    expect(payloadOf(store)?.checks).toHaveLength(2)
    expect(payloadOf(store)?.walkthrough?.sections).toHaveLength(2)
  })

  test("a picker for a revision the loaded card lacks rereads the change first", async () => {
    const routes: Record<string, Route> = {
      ...viewRoutes,
      [`${CHANGE_ROUTE}/diff?from=1&to=3`]: json(200, { change_id: "qupxosqw", file_diffs: [DIFF.file_diffs[1]] }),
      [`${REPO}/commits/c99f01/statuses?limit=100`]: json(200, { statuses: [] })
    }
    const { store, seam, requests } = await harness(routes)
    await seam.viewChange("qupxosqw")
    /* A third revision lands after the card was read. */
    routes[CHANGE_ROUTE] = json(200, {
      ...CHANGE,
      current_seq: 3,
      revisions: [
        ...CHANGE.revisions,
        { seq: 3, commit_id: "c99f01", parent_commit_id: "p3", source: "push", operation_ids: [], created_at: "2026-09-01T11:00:00Z" }
      ]
    })

    requests.length = 0
    expect(textOf(await seam.setPins("qupxosqw", "1", "3"))).toBe("Diff of qupxosqw pinned rev 1 → rev 3.")
    expect(requests[0]).toBe(`GET ${CHANGE_ROUTE}`)
    expect(requests).toContain(`GET ${CHANGE_ROUTE}/diff?from=1&to=3`)
    expect(payloadOf(store)?.diff?.to).toBe("3")

    requests.length = 0
    expect(textOf(await seam.checksAt("qupxosqw", 3))).toBe("Checks of qupxosqw at rev 3.")
    expect(requests).toContain(`GET ${REPO}/commits/c99f01/statuses?limit=100`)
    expect(payloadOf(store)?.checksAt).toBe(3)

    /* A revision no read records still refuses by name. */
    expect(textOf(await seam.setPins("qupxosqw", "1", "9"))).toBe("qupxosqw has no rev 9 — its revisions are 1 → 3.")
    expect(textOf(await seam.checksAt("qupxosqw", 9))).toBe("qupxosqw has no rev 9 to read checks at.")
  })

  test("review.since-mine pins the diff from my last_reviewed_seq to current and names it", async () => {
    const { store, seam, requests } = await harness({
      ...viewRoutes,
      [`${CHANGE_ROUTE}/diff?from=1&to=2`]: json(200, { change_id: "qupxosqw", file_diffs: [DIFF.file_diffs[1]] })
    })
    expect(textOf(await seam.sinceMyReview("qupxosqw"))).toBe("Diff of qupxosqw since your review at rev 1 → current.")
    expect(requests).toContain(`GET ${CHANGE_ROUTE}/diff?from=1&to=2`)
    expect(payloadOf(store)?.diff?.sinceReview).toEqual({ reviewer: "will", seq: 1 })
    expect(payloadOf(store)?.diff?.from).toBe("1")
  })

  test("review.since-mine without a review of mine, or one at the current revision, says so and pins nothing", async () => {
    const none = await harness({ ...viewRoutes, [CHANGE_ROUTE]: json(200, { ...CHANGE, reviews: [] }) })
    expect(textOf(await none.seam.sinceMyReview("qupxosqw"))).toBe(
      "No review by will is recorded on qupxosqw — /prs.review posts one; the diff stays parent → current."
    )
    const current = await harness({
      ...viewRoutes,
      [CHANGE_ROUTE]: json(200, {
        ...CHANGE,
        reviews: [{ reviewer: "will", reviewer_kind: "human", verdict: "approve", confidence_bucket: null, summary: "", commit_id: "a03f5f", seq: 2, last_reviewed_seq: 2 }]
      })
    })
    expect(textOf(await current.seam.sinceMyReview("qupxosqw"))).toBe(
      "Your last review of qupxosqw is at the current revision (rev 2) — nothing changed since."
    )
  })

  test("change.view requires a signed-in session", async () => {
    const { seam, requests } = await harness({}, { signedIn: false })
    expect(textOf(await seam.viewChange("qupxosqw"))).toBe("Sign in to Smithers Cloud to continue.")
    expect(requests).toEqual([])
  })

  test("a degraded sign-in reads a change freely", async () => {
    const { store, seam } = await harness(viewRoutes, { degraded: true })
    const result = await seam.viewChange("qupxosqw")
    expect(textOf(result)).toBe("Change qupxosqw on will/smithers — the card tracks it.")
    expect(payloadOf(store)?.commitId).toBe("a03f5f")
  })

  test("change.view leaves an absent answer as an absent field, with its reason, when an auxiliary 404s", async () => {
    /* A DTO with no revisions/reviews/conflicts keys: every auxiliary comes off its own route, and each 404s. */
    const { store, seam } = await harness({
      [CHANGE_ROUTE]: json(200, {
        change_id: "qupxosqw",
        commit_id: "a03f5f",
        description: "Add the split flow",
        author_name: "will",
        timestamp: "2026-09-01T10:00:00Z",
        has_conflict: false,
        parent_change_ids: []
      })
    })
    await seam.viewChange("qupxosqw")
    const payload = payloadOf(store)
    expect(payload?.currentSeq).toBeNull()
    expect(payload?.revisions).toEqual([])
    expect(payload?.diff).toBeNull()
    expect(payload?.repos).toEqual([])
    expect(payload?.checks).toBeNull()
    expect(payload?.findings).toBeNull()
    expect(payload?.reviews).toBeNull()
    expect(payload?.threads).toBeNull()
    expect(payload?.stack).toBeNull()
    expect(payload?.conflicts).toBeNull()
    expect(payload?.owners).toBeNull()
    expect(payload?.turn).toBeNull()
    expect(payload?.walkthrough).toBeNull()
    expect(payload?.unread).toEqual({
      diff: `no route GET ${CHANGE_ROUTE}/diff`,
      conflicts: `no route GET ${CHANGE_ROUTE}/conflicts`,
      checks: `no route GET ${REPO}/commits/a03f5f/statuses?limit=100`,
      findings: `no route GET ${CHANGE_ROUTE}/findings`,
      reviews: "the change DTO carried no reviews[]",
      threads: `the landing list wasn't read: no route GET ${REPO}/landings?limit=100`,
      reviewRequests: `the landing list wasn't read: no route GET ${REPO}/landings?limit=100`,
      stack: `no route GET ${REPO}/landings?limit=100`
    })
  })

  test("threads are [] — a fact — once the landing list was read and no request carries the change", async () => {
    const { store, seam } = await harness({
      ...viewRoutes,
      [`${REPO}/landings?limit=100`]: json(200, { items: [] })
    })
    await seam.viewChange("qupxosqw")
    expect(payloadOf(store)?.threads).toEqual([])
    expect(payloadOf(store)?.stack).toBeNull()
    /* The turn still rides the change GET when no landing list row carries the change. */
    expect(payloadOf(store)?.turn?.party).toBe("reviewer")
    expect(payloadOf(store)?.unread).toBeUndefined()
  })

  test("a failed re-read nulls every auxiliary with its reason — nothing from the earlier read survives", async () => {
    const routes: Record<string, Route> = { ...viewRoutes }
    const { store, seam } = await harness(routes)
    await seam.viewChange("qupxosqw")
    expect(payloadOf(store)?.stack?.landingNumber).toBe(42)
    expect(payloadOf(store)?.findings).toHaveLength(2)

    /* The second read: the change answers (its inline conflicts with it), every other route 500s. */
    for (const key of Object.keys(routes)) {
      if (key !== CHANGE_ROUTE) routes[key] = json(500, { message: "upstream down" })
    }
    await seam.viewChange("qupxosqw")
    const payload = payloadOf(store)
    expect(payload?.diff).toBeNull()
    expect(payload?.repos).toEqual([])
    expect(payload?.stack).toBeNull()
    expect(payload?.checks).toBeNull()
    expect(payload?.findings).toBeNull()
    expect(payload?.walkthrough).toBeNull()
    expect(payload?.unread).toEqual({
      diff: "upstream down",
      checks: "upstream down",
      findings: "upstream down",
      reviewRequests: "the landing list wasn't read: upstream down",
      threads: "the landing list wasn't read: upstream down",
      stack: "upstream down",
      walkthrough: "upstream down"
    })

    /* A facet switch reads nothing, so it keeps that honest state rather than resurrecting the first read. */
    await seam.setFacet("qupxosqw", "checks")
    expect(payloadOf(store)?.stack).toBeNull()
    expect(payloadOf(store)?.unread?.stack).toBe("upstream down")
  })

  test("a changeset attaches only when its superproject or a member is THIS repository's change", async () => {
    /* Another repo's changeset holding the same jj change id: a bare id match would attach — and land — it. */
    const foreign = {
      id: 7,
      organization: "will",
      description: "atom",
      state: "pending",
      failure_reason: null,
      superproject: "will/api",
      change_id: "qupxosqw",
      commit_id: "a03f5f",
      target_bookmark: "main",
      members: [{ repository: "will/api", path: "api", change_id: "qupxosqw", commit_id: "a03f5f", target_bookmark: "main" }]
    }
    const { store, seam, requests } = await harness(
      {
        ...viewRoutes,
        "api/orgs/will/changesets": json(200, { changesets: [foreign] }),
        "POST api/orgs/will/changesets/7/land": json(200, { ...foreign, state: "landed" }),
        [`PUT ${REPO}/landings/42/land`]: json(202, { status: "queued" })
      },
      { ownerKind: "org" }
    )
    await seam.viewChange("qupxosqw")
    expect(payloadOf(store)?.changeset).toBeNull()

    await seam.landChange("qupxosqw")
    expect(requests).not.toContain("POST api/orgs/will/changesets/7/land")
    expect(requests).toContain(`PUT ${REPO}/landings/42/land`)
  })

  test("a changeset attaches through a member row in this repository", async () => {
    const changeset = {
      id: 7,
      organization: "will",
      description: "atom",
      state: "pending",
      failure_reason: null,
      superproject: "will/super",
      change_id: "zzzzzzzz",
      commit_id: "ffffff",
      target_bookmark: "main",
      members: [{ repository: "will/smithers", path: "smithers", change_id: "qupxosqw", commit_id: "a03f5f", target_bookmark: "main" }]
    }
    const { store, seam } = await harness(
      { ...viewRoutes, "api/orgs/will/changesets": json(200, { changesets: [changeset] }) },
      { ownerKind: "org" }
    )
    await seam.viewChange("qupxosqw")
    expect(payloadOf(store)?.changeset?.id).toBe(7)
    expect(payloadOf(store)?.changeset?.superproject).toBe("will/super")
    expect(payloadOf(store)?.changeset?.members).toEqual([
      {
        repository: "will/smithers",
        path: "smithers",
        changeId: "qupxosqw",
        commitId: "a03f5f",
        targetBookmark: "main",
        previousCommitId: null,
        landedCommitId: null
      }
    ])
  })

  test("change.diff renders the diff card pinned at the current revision; conflicted files lead", async () => {
    const { store, seam } = await harness({
      [CHANGE_ROUTE]: json(200, { ...CHANGE, conflicts: [{ path: "docs/guide.md", state: "unresolved" }] }),
      [`${CHANGE_ROUTE}/diff`]: json(200, DIFF)
    })
    const result = await seam.diffChange("qupxosqw")

    expect(textOf(result)).toBe("Diff of qupxosqw (parent → current) — 2 files.")
    const payload = diffPayloadOf(store)
    expect(payload?.repo).toBe("will/smithers")
    expect(payload?.from).toBe("parent")
    expect(payload?.to).toBe("current")
    expect(payload?.pin).toEqual({ changeId: "qupxosqw", seq: 2, commitId: "a03f5f" })
    expect(payload?.files[0]?.path).toBe("docs/guide.md")
    expect(payload?.files[0]?.conflicted).toBe(true)
    expect(payload?.files[1]?.conflicted).toBeUndefined()
  })

  test("change.diff between two revisions reads the interdiff and pins the diff card at the `to` revision (plue#451)", async () => {
    const { store, seam, requests } = await harness({
      [CHANGE_ROUTE]: json(200, CHANGE),
      [`${CHANGE_ROUTE}/diff?from=1&to=2`]: json(200, { change_id: "qupxosqw", file_diffs: [DIFF.file_diffs[1]] })
    })
    expect(textOf(await seam.diffChange("qupxosqw", "1", "2"))).toBe("Diff of qupxosqw (rev 1 → rev 2) — 1 file.")
    expect(requests).toContain(`GET ${CHANGE_ROUTE}/diff?from=1&to=2`)
    expect(diffPayloadOf(store)?.pin).toEqual({ changeId: "qupxosqw", seq: 2, commitId: "a03f5f" })
    expect(diffCardOf(store)?.title).toBe("qupxosqw · rev 1 → rev 2")

    /* parent → rev 1 pins the card at rev 1's commit. */
    const pinned = await harness({
      [CHANGE_ROUTE]: json(200, CHANGE),
      [`${CHANGE_ROUTE}/diff?from=parent&to=1`]: json(200, { change_id: "qupxosqw", file_diffs: [] })
    })
    await pinned.seam.diffChange("qupxosqw", "parent", "1")
    expect(diffPayloadOf(pinned.store)?.pin).toEqual({ changeId: "qupxosqw", seq: 1, commitId: "b775d9" })
  })

  test("change.diff with a pin no revision answers refuses by name — never a guessed pair", async () => {
    const { seam, requests } = await harness({ [CHANGE_ROUTE]: json(200, CHANGE) })
    expect(textOf(await seam.diffChange("qupxosqw", "1", "9"))).toBe("qupxosqw has no rev 9 — its revisions are 1 → 2.")
    expect(textOf(await seam.diffChange("qupxosqw", "x", "2"))).toBe(
      "change.diff's from pin is \"parent\" or a revision number — not \"x\""
    )
    expect(requests.some((request) => request.includes("/diff"))).toBe(false)

    const bare = await harness({ [CHANGE_ROUTE]: json(200, { ...CHANGE, revisions: [], current_seq: 0 }) })
    expect(textOf(await bare.seam.diffChange("qupxosqw", "1", "2"))).toBe(
      "No revisions are recorded for qupxosqw, so rev 2 can't be pinned — the diff offers parent → current."
    )
  })

  test("change.diff on a single file keeps that file's hunk inline regardless of size", async () => {
    const bigPatch = Array.from({ length: 500 }, (_, index) => `+line ${index}`).join("\n")
    const { store, seam, requests } = await harness({
      [CHANGE_ROUTE]: json(200, CHANGE),
      [`${CHANGE_ROUTE}/diff?path=src%2Fbig.ts`]: json(200, {
        change_id: "qupxosqw",
        file_diffs: [
          { path: "src/big.ts", change_type: "modified", patch: bigPatch, is_binary: false, additions: 500, deletions: 0 }
        ]
      })
    })
    const result = await seam.diffChange("qupxosqw", undefined, undefined, "src/big.ts")
    expect(requests).toContain(`GET ${CHANGE_ROUTE}/diff?path=src%2Fbig.ts`)
    expect(diffPayloadOf(store)?.files[0]?.patch).toBe(bigPatch)
    expect(textOf(result)).toContain("1 file")
  })

  test("change.diff marks an oversized hunk by reference, not inline", async () => {
    const bigPatch = Array.from({ length: 500 }, (_, index) => `+line ${index}`).join("\n")
    const { store, seam } = await harness({
      [CHANGE_ROUTE]: json(200, CHANGE),
      [`${CHANGE_ROUTE}/diff`]: json(200, {
        change_id: "qupxosqw",
        file_diffs: [
          { path: "src/big.ts", change_type: "modified", patch: bigPatch, is_binary: false, additions: 500, deletions: 0 }
        ]
      })
    })
    await seam.diffChange("qupxosqw")
    const file = diffPayloadOf(store)?.files[0]
    expect(file?.patch).toBeUndefined()
    expect(file?.patchLines).toBe(500)
  })

  test("change.land PUTs the change's current commit_id, queues the carrying landing request, and re-reads", async () => {
    const { store, seam, requests, bodies } = await harness({
      ...viewRoutes,
      [`PUT ${REPO}/landings/42/land`]: json(202, { status: "queued" })
    })
    const result = await seam.landChange("qupxosqw")

    /* qupxosqw is the request's top (2 of 2), so the PUT is in scope — and the line names the whole scope it covered. */
    expect(textOf(result)).toBe(
      "Landing request #42 is queued — it lands 1 → 2 together (mzxvbnmk, qupxosqw); the card tracks it."
    )
    expect(requests).toContain(`PUT ${REPO}/landings/42/land`)
    /* plue's land requires the commit it lands (LandLandingRequestInput.commit_id); the change is re-read for it right before. */
    expect(JSON.parse(bodies[`PUT ${REPO}/landings/42/land`] ?? "null")).toEqual({ commit_id: "a03f5f" })
    expect(payloadOf(store)?.stack?.landingNumber).toBe(42)
    expect(payloadOf(store)?.stack?.changeIds).toEqual(["mzxvbnmk", "qupxosqw"])
  })

  test("change.land on a mid-stack change refuses, names the whole-request scope and the top, and PUTs nothing", async () => {
    const { seam, requests } = await harness({
      ...viewRoutes,
      [`${REPO}/landings?limit=100`]: json(200, {
        items: [{ ...LANDING, change_ids: ["qupxosqw", "ronvznsk"] }]
      }),
      [`PUT ${REPO}/landings/42/land`]: json(202, { status: "queued" })
    })
    expect(textOf(await seam.landChange("qupxosqw"))).toBe(
      "Land all 2 changes from ronvznsk."
    )
    expect(requests.some((request) => request.startsWith("PUT "))).toBe(false)
  })

  test("change.land on a queued landing request refuses without a PUT — plue lands only open or failed", async () => {
    const { seam, requests } = await harness({
      ...viewRoutes,
      [`${REPO}/landings?limit=100`]: json(200, { items: [{ ...LANDING, state: "queued" }] }),
      [`PUT ${REPO}/landings/42/land`]: json(202, { status: "queued" })
    })
    expect(textOf(await seam.landChange("qupxosqw"))).toBe(
      "Landing request #42 is queued. Only open or failed requests can land."
    )
    expect(requests.some((request) => request.startsWith("PUT "))).toBe(false)
  })

  test("change.land refuses when the org's changesets weren't read — a land can't clear the change of one", async () => {
    const { seam, requests } = await harness(
      {
        ...viewRoutes,
        "api/orgs/will/changesets": json(500, { message: "changesets down" }),
        [`PUT ${REPO}/landings/42/land`]: json(202, { status: "queued" })
      },
      { ownerKind: "org" }
    )
    expect(textOf(await seam.landChange("qupxosqw"))).toBe(
      "The changesets qupxosqw might belong to weren't read (changesets down) — nothing was landed."
    )
    expect(requests.some((request) => request.startsWith("PUT ") || request.startsWith("POST "))).toBe(false)
  })

  test("change.land without a carrying landing request says so and names the way out", async () => {
    const { seam } = await harness({
      [`${REPO}/landings?limit=100`]: json(200, { items: [] })
    })
    expect(textOf(await seam.landChange("qupxosqw"))).toBe(
      "No landing request carries qupxosqw on will/smithers."
    )
  })

  /*
   * Walk run 3, C3-N8: the door read the repository's landing requests, sent no
   * land, and put nothing on screen — its sentence reached the person only as a
   * toast that leaves after four seconds, and the next session could not read it
   * back. A land that lands writes its card; a land that refuses writes the
   * sentence, so a door that acted on nothing still says so where the person is
   * looking.
   */
  test("every change.land refusal is in the transcript, not only in a toast that leaves", async () => {
    const said = (store: AppStore) => [...store.collections.messages.values()].map((message) => message.text)

    const absent = await harness({ [`${REPO}/landings?limit=100`]: json(200, { items: [] }) })
    await absent.seam.landChange("qupxosqw")
    expect(said(absent.store)).toEqual(["No landing request carries qupxosqw on will/smithers."])

    const unread = await harness({ [`${REPO}/landings?limit=100`]: json(500, { message: "landings down" }) })
    await unread.seam.landChange("qupxosqw")
    expect(said(unread.store)).toEqual(["The landing requests of will/smithers weren't read (landings down) — nothing was landed."])

    const signedOut = await harness({}, { signedIn: false })
    await signedOut.seam.landChange("qupxosqw")
    expect(said(signedOut.store)).toEqual([SIGN_OUT_REFUSAL])

    /* A queued land already renders its card; its line is not said twice. */
    const queued = await harness({ ...viewRoutes, [`PUT ${REPO}/landings/42/land`]: json(202, { status: "queued" }) })
    await queued.seam.landChange("qupxosqw")
    expect(said(queued.store)).toEqual([])
  })

  test("change.land lands the changeset through its own route when one carries the change", async () => {
    const changeset = {
      id: 7,
      organization: "will",
      description: "atom",
      state: "pending",
      failure_reason: null,
      superproject: "will/smithers",
      change_id: "qupxosqw",
      commit_id: "a03f5f",
      target_bookmark: "main",
      members: []
    }
    const { seam, requests } = await harness(
      {
        "api/orgs/will/changesets": json(200, { changesets: [changeset] }),
        "POST api/orgs/will/changesets/7/land": json(200, { ...changeset, state: "landed" }),
        ...viewRoutes
      },
      { ownerKind: "org" }
    )
    const result = await seam.landChange("qupxosqw")

    expect(textOf(result)).toBe("Changeset 7 landed — every member bookmark moved together.")
    expect(requests).toContain("POST api/orgs/will/changesets/7/land")
    /* Request keys are `${method} ${path}` with the cloud prefix stripped, so the landing-request route would record as `PUT api/repos/...`. */
    expect(requests.some((request) => request.startsWith("PUT api/repos/"))).toBe(false)
    expect(requests.some((request) => request.startsWith("PUT "))).toBe(false)
  })

  test("change.land on a failed changeset re-reads and renders the failure reason", async () => {
    const changeset = {
      id: 7,
      organization: "will",
      description: "atom",
      state: "pending",
      failure_reason: null,
      superproject: "will/smithers",
      change_id: "qupxosqw",
      commit_id: "a03f5f",
      target_bookmark: "main",
      members: []
    }
    const { store, seam } = await harness(
      {
        "api/orgs/will/changesets": json(200, { changesets: [changeset] }),
        "POST api/orgs/will/changesets/7/land": json(409, { message: "changeset land failed: bookmark moved" }),
        ...viewRoutes
      },
      { ownerKind: "org" }
    )
    const result = await seam.landChange("qupxosqw")

    expect(textOf(result)).toBe("changeset land failed: bookmark moved")
    expect(payloadOf(store)?.changeset?.state).toBe("pending")
  })

  test("review.done / ack / reopen POST the thread transition on the carrying landing and re-read the card", async () => {
    const done = { ...COMMENTS[0], state: "done", anchor_state: "current", done_at: "2026-09-01T11:00:00Z", done_by: 7, resolved_in_revision: { commit_id: "a03f5f", seq: 2 } }
    const { store, seam, requests } = await harness({
      ...viewRoutes,
      [`POST ${REPO}/landings/42/threads/3/done`]: json(200, done),
      [`POST ${REPO}/landings/42/threads/4/ack`]: json(200, { ...COMMENTS[1], state: "resolved", resolved_at: "2026-09-01T11:01:00Z", resolved_by: 9 }),
      [`POST ${REPO}/landings/42/threads/5/reopen`]: json(200, { ...COMMENTS[2], state: "open", done_at: null, resolved_at: null, resolved_in_revision: null })
    })
    await seam.viewChange("qupxosqw")
    requests.length = 0

    expect(textOf(await seam.threadDone("qupxosqw", 3))).toBe("Comment 3 on qupxosqw is done — the card tracks it.")
    /* The landing number comes off the card's stack: no list re-read before the POST. */
    expect(requests[0]).toBe(`POST ${REPO}/landings/42/threads/3/done`)
    expect(payloadOf(store)?.facet).toBe("review")

    expect(textOf(await seam.threadAck("qupxosqw", 4))).toBe("Comment 4 on qupxosqw is resolved — the card tracks it.")
    expect(requests).toContain(`POST ${REPO}/landings/42/threads/4/ack`)
    expect(textOf(await seam.threadReopen("qupxosqw", 5))).toBe("Comment 5 on qupxosqw is open — the card tracks it.")
    expect(requests).toContain(`POST ${REPO}/landings/42/threads/5/reopen`)
  })

  test("a thread transition the platform refuses answers its message verbatim", async () => {
    const { seam } = await harness({
      ...viewRoutes,
      [`POST ${REPO}/landings/42/threads/4/ack`]: json(403, { message: "only the reviewer who opened the thread can acknowledge it" })
    })
    expect(textOf(await seam.threadAck("qupxosqw", 4))).toBe("only the reviewer who opened the thread can acknowledge it")
  })

  test("a thread transition without a carrying landing request says so", async () => {
    const { seam, requests } = await harness({ [`${REPO}/landings?limit=100`]: json(200, { items: [] }) })
    expect(textOf(await seam.threadDone("qupxosqw", 3))).toBe(
      "No landing request carries qupxosqw on will/smithers — its review comments live on one."
    )
    expect(requests.some((request) => request.startsWith("POST "))).toBe(false)
  })

  test("findings.not-useful records useful:false on plue's own route and the re-read dims the row (plue#487)", async () => {
    const { store, seam, requests, bodies } = await harness({
      ...viewRoutes,
      [`POST ${CHANGE_ROUTE}/findings/11/feedback`]: json(200, { useful: false, by_user_id: 7 }),
      /* The re-read is what dims the row: the card never guesses ahead of the server. */
      [`${CHANGE_ROUTE}/findings`]: json(200, {
        ...FINDINGS,
        findings: [
          { ...FINDINGS.findings[0], feedback: { useful: false, by_user_id: 7 } },
          FINDINGS.findings[1]
        ]
      })
    })

    const result = await seam.notUseful("qupxosqw", 11)

    expect(requests).toContain(`POST ${CHANGE_ROUTE}/findings/11/feedback`)
    /* plue's body is `{ useful }`; no note is invented on the human's behalf. */
    expect(JSON.parse(bodies[`POST ${CHANGE_ROUTE}/findings/11/feedback`] ?? "null")).toEqual({ useful: false })
    expect(textOf(result)).toBe("Finding 11 of qupxosqw is recorded not useful — the card dims it.")
    expect(payloadOf(store)?.findings?.[0]?.feedback).toBe("not useful")
    expect(payloadOf(store)?.facet).toBe("findings")
  })

  test("a feedback plue refuses reads its own sentence and records nothing", async () => {
    const { store, seam } = await harness({
      ...viewRoutes,
      [`POST ${CHANGE_ROUTE}/findings/11/feedback`]: json(404, { message: "finding not found" })
    })

    expect(textOf(await seam.notUseful("qupxosqw", 11))).toBe("finding not found")
    expect(payloadOf(store)).toBeUndefined()
  })

  test("findings.please-fix dispatches the agent and lends the run's computer to the workspace seam (plue#487)", async () => {
    const { seam, requests, shownWorkspaces } = await harness({
      ...viewRoutes,
      /*
       * plue answers 202 with the SESSION it created
       * (services.AgentSessionResponse), which — RFD-004 — names the
       * kind=agent workspace the run executes in.
       */
      [`POST ${CHANGE_ROUTE}/findings/11/dispatch`]: json(202, {
        id: "sess-fix-11",
        repository_id: 7,
        user_id: 3,
        title: "Fix finding #11",
        status: "queued",
        message_count: 1,
        workspace_id: "ws-agent-1",
        created_at: "2026-09-01T11:00:00Z",
        updated_at: "2026-09-01T11:00:00Z",
        metadata: { finding_id: 11 }
      })
    })

    const result = await seam.pleaseFix("qupxosqw", 11)

    expect(requests).toContain(`POST ${CHANGE_ROUTE}/findings/11/dispatch`)
    /* The returned run renders as the existing card kind: the computer it runs in. */
    expect(shownWorkspaces).toEqual(["ws-agent-1"])
    expect(textOf(result)).toBe(
      "The agent is on finding 11 of qupxosqw (session sess-fix-11) — the computer ws-agent-1 card tracks the run."
    )
  })

  test("a dispatch that names no workspace names its session and renders no computer", async () => {
    const { seam, shownWorkspaces } = await harness({
      ...viewRoutes,
      [`POST ${CHANGE_ROUTE}/findings/11/dispatch`]: json(202, { id: "sess-fix-11", title: "Fix finding #11", status: "queued" })
    })

    expect(textOf(await seam.pleaseFix("qupxosqw", 11))).toBe(
      "The agent is on finding 11 of qupxosqw (session sess-fix-11)."
    )
    expect(shownWorkspaces).toEqual([])
  })

  test("a dispatch plue already has running reads its own 409, verbatim", async () => {
    const { seam } = await harness({
      ...viewRoutes,
      [`POST ${CHANGE_ROUTE}/findings/11/dispatch`]: json(409, { message: "finding dispatch already running" })
    })

    expect(textOf(await seam.pleaseFix("qupxosqw", 11))).toBe("finding dispatch already running")
  })

  test("a degraded sign-in dispatches nothing on a finding, and neither act takes a finding id it cannot use", async () => {
    const degraded = await harness(viewRoutes, { degraded: true })
    expect(textOf(await degraded.seam.pleaseFix("qupxosqw", 11))).toBe(DEGRADED_CHANGE_REFUSAL)
    expect(degraded.requests).toEqual([])

    const { seam, requests } = await harness(viewRoutes)
    expect(textOf(await seam.pleaseFix("qupxosqw", 0))).toBe(
      "findings.please-fix needs a finding id: /findings.please-fix <changeId> <findingId>"
    )
    expect(textOf(await seam.notUseful("qupxosqw", -1))).toBe(
      "findings.not-useful needs a finding id: /findings.not-useful <changeId> <findingId>"
    )
    expect(requests).toEqual([])
  })

  test("the landing's review_requests ride the card, human and named agent alike (plue#488)", async () => {
    const { store, seam } = await harness(viewRoutes)

    await seam.viewChange("qupxosqw")

    expect(payloadOf(store)?.reviewRequests).toEqual([
      { id: 5, reviewer: "ana", agent: null, requestedBy: "will", state: "requested", createdAt: "2026-09-01T10:04:00Z" },
      { id: 6, reviewer: null, agent: "smithers-review", requestedBy: "will", state: "fulfilled", createdAt: "2026-09-01T10:05:00Z" }
    ])
  })

  test("a landing request that carries no review_requests[] key is unread, not empty", async () => {
    const withoutRequests: Record<string, unknown> = { ...LANDING }
    delete withoutRequests.review_requests
    const { store, seam } = await harness({
      ...viewRoutes,
      [`${REPO}/landings?limit=100`]: json(200, { items: [withoutRequests] })
    })

    await seam.viewChange("qupxosqw")

    expect(payloadOf(store)?.reviewRequests).toBeNull()
    expect(payloadOf(store)?.unread?.reviewRequests).toBe("the landing request carried no review_requests[]")
  })

  test("review.request posts the login on the landing the change GET numbered, then re-reads the facet (plue#488)", async () => {
    const { store, seam, requests, bodies } = await harness({
      ...viewRoutes,
      [`POST ${REPO}/landings/42/review-requests`]: json(201, {
        id: 7,
        requested_by: { id: 7, login: "will" },
        reviewer: { id: 11, login: "bo" },
        state: "requested",
        created_at: "2026-09-01T11:00:00Z"
      })
    })

    const result = await seam.requestReview("qupxosqw", "bo")

    expect(requests).toContain(`POST ${REPO}/landings/42/review-requests`)
    /* plue refuses a body that names both a reviewer and an agent, so exactly one is sent. */
    expect(JSON.parse(bodies[`POST ${REPO}/landings/42/review-requests`] ?? "null")).toEqual({ reviewer: "bo" })
    expect(textOf(result)).toBe("Review of qupxosqw requested from bo on landing request #42.")
    expect(payloadOf(store)?.facet).toBe("review")
  })

  test("review.request agent:<name> asks the named agent, never a login", async () => {
    const { seam, bodies } = await harness({
      ...viewRoutes,
      [`POST ${REPO}/landings/42/review-requests`]: json(201, {
        id: 8,
        requested_by: { id: 7, login: "will" },
        reviewer: null,
        agent: "smithers-review",
        state: "requested",
        created_at: "2026-09-01T11:00:00Z"
      })
    })

    const result = await seam.requestReview("qupxosqw", "agent:smithers-review")

    expect(JSON.parse(bodies[`POST ${REPO}/landings/42/review-requests`] ?? "null")).toEqual({ agent: "smithers-review" })
    expect(textOf(result)).toBe("Review of qupxosqw requested from agent smithers-review on landing request #42.")
  })

  test("a review request plue refuses reads its own sentence", async () => {
    const { seam } = await harness({
      ...viewRoutes,
      [`POST ${REPO}/landings/42/review-requests`]: json(409, { message: "review has already been requested from this reviewer" })
    })

    expect(textOf(await seam.requestReview("qupxosqw", "ana"))).toBe(
      "review has already been requested from this reviewer"
    )
  })

  test("review.request without a reviewer, and on a change no landing carries, call nothing", async () => {
    const { seam, requests } = await harness(viewRoutes)
    expect(textOf(await seam.requestReview("qupxosqw", "  "))).toBe(
      "review.request needs a reviewer: /review.request <changeId> <login|agent:name>"
    )
    expect(requests).toEqual([])

    const orphan = await harness({ [`${REPO}/landings?limit=100`]: json(200, { items: [] }) })
    expect(textOf(await orphan.seam.requestReview("qupxosqw", "ana"))).toBe(
      "No landing request carries qupxosqw on will/smithers — its review comments live on one."
    )
    expect(orphan.requests.some((request) => request.startsWith("POST "))).toBe(false)
  })

  test("review.unrequest DELETEs the request the card listed, then re-reads (plue#488)", async () => {
    const { store, seam, requests } = await harness({
      ...viewRoutes,
      [`DELETE ${REPO}/landings/42/review-requests/5`]: json(204, null)
    })
    await seam.viewChange("qupxosqw")
    requests.length = 0

    const result = await seam.unrequestReview("qupxosqw", 5)

    /* The landing number is on the card already: no landings-list read before the DELETE. */
    expect(requests[0]).toBe(`DELETE ${REPO}/landings/42/review-requests/5`)
    expect(textOf(result)).toBe("Review request 5 on landing request #42 is dismissed.")
    expect(payloadOf(store)?.facet).toBe("review")
  })

  test("review.unrequest without a request id calls nothing", async () => {
    const { seam, requests } = await harness(viewRoutes)
    expect(textOf(await seam.unrequestReview("qupxosqw", 0))).toBe(
      "review.unrequest needs a review-request id: /review.unrequest <changeId> <requestId>"
    )
    expect(requests).toEqual([])
  })

  test("the landing number comes off the change GET, not the 100-row list (plue#485)", async () => {
    /*
     * plue#485 put `landing_request_number` on the change GET's `stack`
     * beside the DB id, so a thread transition on a change nobody has viewed
     * addresses its landing without reading the whole landings list.
     */
    const { seam, requests } = await harness({
      ...viewRoutes,
      [`POST ${REPO}/landings/42/threads/3/done`]: json(200, { ...COMMENTS[0], state: "done", done_at: "2026-09-01T11:00:00Z" })
    })

    await seam.threadDone("qupxosqw", 3)

    expect(requests).toContain(`POST ${REPO}/landings/42/threads/3/done`)
    /* The list is read only by the card's own re-read afterwards, never before the POST. */
    expect(requests.indexOf(`POST ${REPO}/landings/42/threads/3/done`)).toBeLessThan(
      requests.indexOf(`GET ${REPO}/landings?limit=100`)
    )
  })

  test("a change GET that numbers no landing request falls back to the list", async () => {
    const stack = { ...(CHANGE.stack as Record<string, unknown>) }
    delete stack.landing_request_number
    const { store, seam, requests } = await harness({
      ...viewRoutes,
      [CHANGE_ROUTE]: json(200, { ...CHANGE, stack })
    })

    await seam.viewChange("qupxosqw")

    /* The number still lands — from the list row that carries the change. */
    expect(payloadOf(store)?.stack?.landingNumber).toBe(42)
    expect(requests).toContain(`GET ${REPO}/landings?limit=100`)
  })

  test("a comment row that spells no lifecycle falls back to the timestamps (plue#486's fallback)", async () => {
    /* A server older than #486 states the anchor in `state` and the lifecycle only in the timestamps. */
    const { store, seam } = await harness({
      ...viewRoutes,
      [`${REPO}/landings/42/comments?limit=100`]: json(200, {
        comments: [
          { id: 3, path: "src/app.ts", line: 12, body: "why this?", state: "moved", current_line: 14, done_at: null, resolved_at: null, created_at: "2026-09-01T10:02:00Z" },
          { id: 4, path: "src/server.ts", line: 208, body: "strip the header", state: "current", done_at: "2026-09-01T10:05:00Z", resolved_at: null, created_at: "2026-09-01T10:04:00Z" },
          { id: 5, path: "src/old.ts", line: 3, body: "cap the listing", state: "stale", done_at: "2026-09-01T09:00:00Z", resolved_at: "2026-09-01T09:30:00Z", created_at: "2026-09-01T08:30:00Z" }
        ]
      })
    })

    await seam.viewChange("qupxosqw")

    expect((payloadOf(store)?.threads ?? []).map((thread) => [thread.id, thread.state, thread.anchor])).toEqual([
      [3, "open", "moved"],
      [4, "done", "current"],
      [5, "resolved", "stale"]
    ])
  })

  test("a comment row that states neither a lifecycle nor timestamps renders no state at all", async () => {
    const { store, seam } = await harness({
      ...viewRoutes,
      [`${REPO}/landings/42/comments?limit=100`]: json(200, {
        comments: [{ id: 9, path: "src/app.ts", line: 1, body: "hm", anchor_state: "current", created_at: "2026-09-01T10:02:00Z" }]
      })
    })

    await seam.viewChange("qupxosqw")

    const thread = (payloadOf(store)?.threads ?? [])[0]
    expect(thread?.state ?? null).toBeNull()
    expect(thread?.anchor).toBe("current")
  })

  test("change.split moves the named paths and renders both returned changes (plue#489)", async () => {
    const splitChangeId = "wqnrtmzx"
    const { store, seam, requests, bodies } = await harness({
      ...viewRoutes,
      [`POST ${CHANGE_ROUTE}/split`]: json(200, {
        original: { change_id: "qupxosqw", commit_id: "a03f5f", description: "Add the split flow", parent_change_ids: [] },
        split: { change_id: splitChangeId, commit_id: "77aa22", description: "docs/guide.md", parent_change_ids: ["qupxosqw"] }
      }),
      [`${REPO}/changes/${splitChangeId}`]: json(200, { ...CHANGE, change_id: splitChangeId, commit_id: "77aa22" }),
      [`${REPO}/changes/${splitChangeId}/diff`]: json(200, DIFF),
      [`${REPO}/changes/${splitChangeId}/findings`]: json(200, FINDINGS),
      [`${REPO}/changes/${splitChangeId}/walkthrough?rev=2`]: json(404, { message: "walkthrough not found" })
    })

    const result = await seam.splitChange("qupxosqw", ["docs/guide.md"])

    expect(requests).toContain(`POST ${CHANGE_ROUTE}/split`)
    expect(JSON.parse(bodies[`POST ${CHANGE_ROUTE}/split`] ?? "null")).toEqual({ paths: ["docs/guide.md"] })
    expect(textOf(result)).toBe(
      `docs/guide.md moved out of qupxosqw into the new change ${splitChangeId} — both cards track them.`
    )
    /* Both returned changes render: the original that kept the rest, and the new one that took the paths. */
    expect(store.collections.cards.get("change-will/smithers-qupxosqw")).toBeDefined()
    expect(store.collections.cards.get(`change-will/smithers-${splitChangeId}`)).toBeDefined()
  })

  test("change.split with no path calls nothing — plue refuses an empty paths list", async () => {
    const { seam, requests } = await harness(viewRoutes)
    expect(textOf(await seam.splitChange("qupxosqw", ["   "]))).toBe(
      "change.split needs at least one path to move: /change.split <changeId> <path> [path…]"
    )
    expect(requests).toEqual([])
  })

  test("a split plue refuses reads its own sentence and renders no new change", async () => {
    const { store, seam } = await harness({
      ...viewRoutes,
      [`POST ${CHANGE_ROUTE}/split`]: json(409, { message: "landed changes cannot be split" })
    })

    expect(textOf(await seam.splitChange("qupxosqw", ["docs/guide.md"]))).toBe("landed changes cannot be split")
    expect(store.collections.cards.size).toBe(0)
  })

  test("a split answer that names no changes says so rather than claiming one", async () => {
    const { seam } = await harness({
      ...viewRoutes,
      [`POST ${CHANGE_ROUTE}/split`]: json(200, { original: {}, split: {} })
    })

    expect(textOf(await seam.splitChange("qupxosqw", ["docs/guide.md"]))).toBe(
      "Smithers Cloud's answer for the split of qupxosqw named no changes."
    )
  })

  test("change.split-ready refuses — the ready members aren't recorded (plue#452)", async () => {
    const changeset = {
      id: 7,
      organization: "will",
      description: "atom",
      state: "pending",
      failure_reason: null,
      superproject: "will/smithers",
      change_id: "qupxosqw",
      commit_id: "a03f5f",
      target_bookmark: "main",
      members: []
    }
    const { seam } = await harness(
      { "api/orgs/will/changesets": json(200, { changesets: [changeset] }) },
      { ownerKind: "org" }
    )
    expect(textOf(await seam.splitReady("qupxosqw"))).toBe(NO_SPLIT_REFUSAL)
  })

  test("change.split-ready without a changeset says so", async () => {
    const { seam } = await harness({})
    expect(textOf(await seam.splitReady("qupxosqw"))).toBe(
      "Split ready members applies to a changeset — qupxosqw on will/smithers belongs to none."
    )
  })

  test("change.resolve refuses a degraded sign-in with the enable wording", async () => {
    const { seam, requests } = await harness({}, { degraded: true })
    expect(textOf(await seam.resolveConflict("qupxosqw", "src/app.ts"))).toBe(DEGRADED_CHANGE_REFUSAL)
    expect(requests).toEqual([])
  })

  test("change.resolve POSTs the conflict's path, names the agent session, and re-reads (plue#455)", async () => {
    const { seam, requests, bodies } = await harness({
      ...viewRoutes,
      [`POST ${CHANGE_ROUTE}/conflicts/resolve`]: json(202, { agent_session_id: "sess-r1" })
    })
    expect(textOf(await seam.resolveConflict("qupxosqw", "src/app.ts"))).toBe(
      "Dispatched an agent (session sess-r1) to resolve src/app.ts in qupxosqw — the next revision carries the resolution."
    )
    expect(requests).toContain(`POST ${CHANGE_ROUTE}/conflicts/resolve`)
    expect(JSON.parse(bodies[`POST ${CHANGE_ROUTE}/conflicts/resolve`] ?? "null")).toEqual({ path: "src/app.ts" })
  })

  test("change.revert refuses on an unlanded change", async () => {
    const { seam } = await harness({ [`${REPO}/landings?limit=100`]: json(200, { items: [LANDING] }) })
    expect(textOf(await seam.revertChange("qupxosqw"))).toBe(
      "Revert is offered on a landed change — qupxosqw has not landed (the landing request is open)."
    )
  })

  test("change.revert on a landed change refuses honestly — not wired (plue#456)", async () => {
    const { seam } = await harness({
      [`${REPO}/landings?limit=100`]: json(200, { items: [{ ...LANDING, state: "merged" }] })
    })
    expect(textOf(await seam.revertChange("qupxosqw"))).toBe(NO_REVERT_REFUSAL)
  })

  test("change.facet switches the card's tab without re-reading", async () => {
    const { store, seam, requests } = await harness(viewRoutes)
    await seam.viewChange("qupxosqw")
    requests.length = 0

    const result = await seam.setFacet("qupxosqw", "checks")
    expect(result).toBeUndefined()
    expect(payloadOf(store)?.facet).toBe("checks")
    expect(payloadOf(store)?.checks).toHaveLength(2)
    expect(payloadOf(store)?.revisions).toHaveLength(2)
    expect(requests).toEqual([])
  })

  test("change.facet on an unread change names the way out", async () => {
    const { seam } = await harness({})
    expect(await seam.setFacet("qupxosqw", "checks")).toBe(
      "Change qupxosqw is not loaded — /change.view qupxosqw reads it first"
    )
  })

  test("a change act resolves the repo from the changes collection after a view", async () => {
    const { store, seam, requests } = await harness(viewRoutes)
    await seam.viewChange("qupxosqw")
    requests.length = 0
    await seam.setFacet("qupxosqw", "diff")
    expect(payloadOf(store)?.facet).toBe("diff")
    expect(requests).toEqual([])
  })
})


describe("committed change mutations", () => {
  const refreshFailure = json(503, { message: "refresh unavailable" })

  test("please-fix retains its session and opens its workspace after a failed change refresh", async () => {
    const { seam, requests, shownWorkspaces } = await harness({
      ...viewRoutes,
      [CHANGE_ROUTE]: refreshFailure,
      [`POST ${CHANGE_ROUTE}/findings/11/dispatch`]: json(201, { id: "session-created", workspace_id: "ws-created" })
    })
    const result = await seam.pleaseFix("qupxosqw", 11)
    expect(result).toEqual({ value: expect.stringContaining("session session-created") })
    expect(textOf(result)).toContain("finding 11 of qupxosqw")
    expect(textOf(result)).toContain("ws-created")
    expect(textOf(result)).toContain("Refresh warning")
    expect(textOf(result)).toContain("refresh unavailable")
    expect(shownWorkspaces).toEqual(["ws-created"])
    expect(requests.filter((request) => request.startsWith("POST "))).toHaveLength(1)
  })

  test("please-fix keeps its session when both the change and workspace refresh fail", async () => {
    const { seam, shownWorkspaces } = await harness({
      ...viewRoutes,
      [CHANGE_ROUTE]: refreshFailure,
      [`POST ${CHANGE_ROUTE}/findings/11/dispatch`]: json(201, { id: "session-created", workspace_id: "ws-created" })
    }, { workspaceError: "workspace unavailable" })
    const result = await seam.pleaseFix("qupxosqw", 11)
    expect(result).toEqual({ value: expect.stringContaining("session session-created") })
    expect(textOf(result)).toContain("refresh unavailable")
    expect(textOf(result)).toContain("workspace unavailable")
    expect(shownWorkspaces).toEqual(["ws-created"])
  })

  test("resolve retains the dispatched session after a failed change refresh", async () => {
    const { seam } = await harness({
      ...viewRoutes,
      [CHANGE_ROUTE]: refreshFailure,
      [`POST ${CHANGE_ROUTE}/conflicts/resolve`]: json(201, { agent_session_id: "session-created" })
    })
    const result = await seam.resolveConflict("qupxosqw", "src/app.ts")
    expect(result).toEqual({ value: expect.stringContaining("session session-created") })
    expect(textOf(result)).toContain("src/app.ts in qupxosqw")
    expect(textOf(result)).toContain("Refresh warning")
    expect(textOf(result)).toContain("refresh unavailable")
  })

  for (const failed of ["original", "created", "both"]) {
    test(`split retains both change identities when ${failed} refresh fails and attempts both cards`, async () => {
      const createdRoute = `${REPO}/changes/new-change`
      const { seam, requests } = await harness({
        ...viewRoutes,
        [CHANGE_ROUTE]: failed === "created" ? json(200, CHANGE) : refreshFailure,
        [createdRoute]: failed === "original" ? json(200, { ...CHANGE, change_id: "new-change" }) : refreshFailure,
        [`POST ${CHANGE_ROUTE}/split`]: json(201, { original: CHANGE, split: { change_id: "new-change" } })
      })
      const result = await seam.splitChange("qupxosqw", ["docs/guide.md"])
      expect(result).toEqual({ value: expect.stringContaining("new-change") })
      expect(textOf(result)).toContain("docs/guide.md moved out of qupxosqw")
      expect(textOf(result)).toContain("Refresh warning")
      expect(textOf(result)).toContain("refresh unavailable")
      expect(requests).toContain(`GET ${CHANGE_ROUTE}`)
      expect(requests).toContain(`GET ${createdRoute}`)
      expect(requests.filter((request) => request.startsWith("POST "))).toHaveLength(1)
    })
  }

  test("land retains the queued request and scope after a failed change refresh", async () => {
    let committed = false
    const { seam, requests } = await harness({
      ...viewRoutes,
      [CHANGE_ROUTE]: (request) => (committed ? refreshFailure : json(200, CHANGE))(request),
      [`PUT ${REPO}/landings/42/land`]: (request) => {
        committed = true
        return json(202, { state: "queued" })(request)
      }
    })
    const result = await seam.landChange("qupxosqw")
    expect(result).toEqual({ value: expect.stringContaining("Landing request #42 is queued") })
    expect(textOf(result)).toContain("mzxvbnmk, qupxosqw")
    expect(textOf(result)).toContain("Refresh warning")
    expect(textOf(result)).toContain("refresh unavailable")
    expect(requests.filter((request) => request.startsWith("PUT "))).toHaveLength(1)
  })

  test("land retains the committed changeset after a failed change refresh", async () => {
    const changeset = { id: 7, organization: "will", state: "pending", superproject: "will/smithers", change_id: "qupxosqw", members: [] }
    const { seam } = await harness({
      ...viewRoutes,
      [CHANGE_ROUTE]: refreshFailure,
      "api/orgs/will/changesets": json(200, { changesets: [changeset] }),
      "POST api/orgs/will/changesets/7/land": json(201, { ...changeset, state: "landed" })
    }, { ownerKind: "org" })
    const result = await seam.landChange("qupxosqw")
    expect(result).toEqual({ value: expect.stringContaining("Changeset 7 landed") })
    expect(textOf(result)).toContain("Refresh warning")
    expect(textOf(result)).toContain("refresh unavailable")
  })

  const reviewCases = [
    { act: "threadDone", arg: 3, route: `POST ${REPO}/landings/42/threads/3/done`, body: { ...COMMENTS[0], state: "done" }, success: "Comment 3 on qupxosqw is done" },
    { act: "threadAck", arg: 3, route: `POST ${REPO}/landings/42/threads/3/ack`, body: { ...COMMENTS[0], state: "resolved" }, success: "Comment 3 on qupxosqw is resolved" },
    { act: "threadReopen", arg: 3, route: `POST ${REPO}/landings/42/threads/3/reopen`, body: { ...COMMENTS[0], state: "open" }, success: "Comment 3 on qupxosqw is open" },
    { act: "notUseful", arg: 11, route: `POST ${CHANGE_ROUTE}/findings/11/feedback`, body: { useful: false }, success: "Finding 11 of qupxosqw is recorded not useful" },
    { act: "requestReview", arg: "ana", route: `POST ${REPO}/landings/42/review-requests`, body: { id: 8 }, success: "Review of qupxosqw requested from ana on landing request #42" },
    { act: "unrequestReview", arg: 5, route: `DELETE ${REPO}/landings/42/review-requests/5`, body: {}, success: "Review request 5 on landing request #42 is dismissed" }
  ] as const
  for (const entry of reviewCases) {
    test(`${entry.act} retains the committed result after a failed change refresh`, async () => {
      const { seam } = await harness({ ...viewRoutes, [CHANGE_ROUTE]: refreshFailure, [entry.route]: json(201, entry.body) })
      const result = entry.act === "requestReview"
        ? await seam.requestReview("qupxosqw", entry.arg)
        : await seam[entry.act]("qupxosqw", entry.arg)
      expect(result).toEqual({ value: expect.stringContaining(entry.success) })
      expect(textOf(result)).toContain("Refresh warning")
      expect(textOf(result)).toContain("refresh unavailable")
    })
  }
})

describe("change repository resolution", () => {
  test("bare mutations refuse duplicate change ids across repositories; explicit repositories still route", async () => {
    const otherRoute = "api/repos/ana/other/changes/qupxosqw"
    const { seam, requests } = await harness({
      ...viewRoutes,
      [otherRoute]: json(200, CHANGE),
      [`POST ${otherRoute}/conflicts/resolve`]: json(201, { agent_session_id: "explicit-session" })
    })
    await seam.viewChange("qupxosqw", undefined, "will/smithers")
    await seam.viewChange("qupxosqw", undefined, "ana/other")
    requests.length = 0
    const refusal = "Change qupxosqw is loaded in several repositories (ana/other, will/smithers) — name one as owner/repo"
    expect(await seam.landChange("qupxosqw")).toBe(refusal)
    expect(await seam.splitChange("qupxosqw", ["docs/guide.md"])).toBe(refusal)
    expect(requests).toEqual([])
    expect(textOf(await seam.resolveConflict("qupxosqw", "src/app.ts", "ana/other"))).toContain("explicit-session")
    expect(requests.filter((request) => request.startsWith("POST "))).toEqual([`POST ${otherRoute}/conflicts/resolve`])
  })
})
