import { describe, expect, test } from "vitest"
import { CardSchema } from "../src/Cards.ts"
import {
  ChangeAnalyzerRunSchema,
  ChangeLandedSchema,
  ChangeOwnersSchema,
  ChangeReviewRequestSchema,
  ChangeThreadSchema,
  ChangeTurnSchema,
  ChangeWalkthroughSchema,
  LandingBlockSchema,
  RevisionPinSchema
} from "../src/Changes.ts"

/*
 * Lane change (ADR 0003 — the change is the unit): the change and diff card
 * payloads, and the revision pin on the file card. Degraded forms (no
 * revisions, no findings, no commit ids on verdicts) must parse — they are
 * what the seam builds today.
 */

const base = { id: "change-1", title: "qupxosqw", status: "active", createdAt: 0, ordinal: 0 } as const

const changePayload = {
  repo: "smithersai/smithers",
  changeId: "qupxosqw",
  description: "Serve repository files through one bounded, confined route",
  commitId: "a03f5f1e",
  currentSeq: null,
  revisionCount: null,
  revisions: [],
  authorName: "will",
  timestamp: "2026-09-02T10:00:00Z",
  repos: [{ repo: "smithersai/smithers", additions: 312, deletions: 41 }],
  diff: null,
  checks: [{ context: "typecheck", state: "success" }],
  findings: null,
  reviews: [{
    reviewer: "will",
    reviewerKind: "human",
    verdict: "approve",
    confidence: null,
    summary: "",
    commitId: null,
    seq: null,
    lastReviewedSeq: null
  }],
  threads: [{ path: "src/server.ts", line: 12, body: "why bounded?", author: null, createdAt: null, state: null }],
  conflicts: [],
  stack: {
    landingNumber: 12,
    state: "open",
    position: 2,
    size: 3,
    changeIds: ["yyyrqlqw", "qupxosqw", "ronvznsk"],
    targetBookmark: "main",
    conflictStatus: "none"
  },
  changeset: null
}

describe("the change card", () => {
  test("the degraded payload (no revisions, no findings, verdicts without commit ids) parses", () => {
    const card = CardSchema.parse({ ...base, kind: "change", payload: changePayload })
    if (card.kind !== "change") throw new Error("wrong kind")
    expect(card.payload.currentSeq).toBeNull()
    expect(card.payload.revisions).toEqual([])
    expect(card.payload.findings).toBeNull()
    expect(card.payload.reviews?.[0]?.commitId).toBeNull()
  })

  test("a payload with revisions and a changeset parses (the post-#450 shape)", () => {
    const card = CardSchema.parse({
      ...base,
      kind: "change",
      payload: {
        ...changePayload,
        currentSeq: 5,
        revisionCount: 5,
        revisions: [{ seq: 5, commitId: "a03f5f1e", source: "agent", agentSessionId: "a03f5f" }],
        findings: [{
          analyzer: "lint",
          severity: "warn",
          path: "src/a.ts",
          line: 3,
          summary: "unused",
          raisedAtSeq: 3
        }],
        changeset: {
          id: 7,
          organization: "canary-changesets-e2e",
          superproject: "canary-changesets-e2e/cs-super",
          changeId: "qupxosqw",
          state: "failed",
          failureReason: "member cs-web conflicted",
          targetBookmark: "main",
          members: [
            {
              repository: "canary-changesets-e2e/cs-api",
              path: "api",
              changeId: "qupxosqw",
              commitId: "a03f5f1e",
              targetBookmark: "main",
              previousCommitId: null,
              landedCommitId: null
            }
          ]
        }
      }
    })
    if (card.kind !== "change") throw new Error("wrong kind")
    expect(card.payload.currentSeq).toBe(5)
    expect(card.payload.changeset?.state).toBe("failed")
  })

  test("a missing landing state (stack: null) parses — a change with no landing request", () => {
    const card = CardSchema.parse({
      ...base,
      kind: "change",
      payload: { ...changePayload, stack: null, reviews: null, threads: null }
    })
    if (card.kind !== "change") throw new Error("wrong kind")
    expect(card.payload.stack).toBeNull()
  })

  test("an unread auxiliary is null and `unread` names why — conflicts included, never collapsed into []", () => {
    const card = CardSchema.parse({
      ...base,
      kind: "change",
      payload: {
        ...changePayload,
        conflicts: null,
        checks: null,
        stack: null,
        unread: {
          conflicts: "Reading conflicts failed (500)",
          checks: "Reading statuses failed (500)",
          stack: "upstream down"
        }
      }
    })
    if (card.kind !== "change") throw new Error("wrong kind")
    expect(card.payload.conflicts).toBeNull()
    expect(card.payload.unread?.conflicts).toBe("Reading conflicts failed (500)")
    /* The stack keeps the request's change ids so the card can name the top change a whole-stack land runs from. */
    expect(
      CardSchema.safeParse({
        ...base,
        kind: "change",
        payload: { ...changePayload, stack: { ...changePayload.stack, changeIds: undefined } }
      }).success
    ).toBe(false)
  })
})

describe("the diff card", () => {
  test("carries the two picker tokens, the pin, and the files", () => {
    const card = CardSchema.parse({
      ...base,
      kind: "diff",
      payload: {
        repo: "smithersai/smithers",
        changeId: "qupxosqw",
        from: "parent",
        to: "current",
        pin: { changeId: "qupxosqw", seq: null, commitId: "a03f5f1e" },
        files: [
          {
            path: "src/a.ts",
            changeType: "modified",
            isBinary: false,
            additions: 3,
            deletions: 1,
            patch: "@@ -1 +1 @@",
            conflicted: true
          },
          { path: "src/big.ts", changeType: "modified", isBinary: false, additions: 500, deletions: 0, patchLines: 812 }
        ]
      }
    })
    if (card.kind !== "diff") throw new Error("wrong kind")
    expect(card.payload.pin.seq).toBeNull()
    expect(card.payload.files[1]?.patch).toBeUndefined()
    expect(card.payload.files[1]?.patchLines).toBe(812)
  })

  test("the pin requires the change id — a card that cannot name its change is rejected", () => {
    const parsed = CardSchema.safeParse({
      ...base,
      kind: "diff",
      payload: {
        repo: "o/r",
        changeId: "qupxosqw",
        from: "parent",
        to: "current",
        pin: { seq: null, commitId: "a03f5f1e" },
        files: []
      }
    })
    expect(parsed.success).toBe(false)
  })
})

describe("the revision pin", () => {
  test("the file card's readAt accepts the pin's seq — optional, null until plue#450", () => {
    const card = CardSchema.parse({
      ...base,
      kind: "file",
      payload: {
        repo: "smithersai/smithers",
        path: "README.md",
        content: "# hi",
        truncated: false,
        readAt: { changeId: "qupxosqw", commitId: "a03f5f1e", seq: null, source: "head" }
      }
    })
    if (card.kind !== "file") throw new Error("wrong kind")
    expect(card.payload.readAt?.seq).toBeNull()
  })

  test("a bare commit pin (a local working copy) is valid — never a server seq", () => {
    const pin = RevisionPinSchema.parse({ changeId: "qupxosqw", seq: null, commitId: "a03f5f1e" })
    expect(pin.seq).toBeNull()
  })
})

/*
 * The lane-L1 schemas (plue #452, #460, #464, #465, #467, #488) as their own
 * contracts. Each is read off a change card payload, so it carries the same
 * persistence promise the card does: a field the route omits stays null, and
 * the enums here are the ones the body branches on.
 */

describe("path ownership (plue#467)", () => {
  const owners = {
    touchedPaths: [{
      path: "packages/rpc/src/Cards.ts",
      owners: ["will", "@smithersai/rpc"],
      agentPolicy: "human-approve",
      satisfiedBy: { login: "will", seq: 5 }
    }],
    requiredApprovers: ["will"],
    suggestedReviewers: ["ada"],
    missingApprovals: [{ path: "packages/rpc/src/Changes.ts", candidates: ["ada"] }]
  }

  test("carries the touched paths, the required and suggested names, and what is still missing", () => {
    expect(ChangeOwnersSchema.parse(owners)).toEqual(owners)
  })

  test("an unsatisfied path states null, and a satisfying approval may name no revision", () => {
    const unsatisfied = { ...owners.touchedPaths[0]!, satisfiedBy: null }
    const byCommit = { ...owners.touchedPaths[0]!, satisfiedBy: { login: "will", seq: null } }
    expect(ChangeOwnersSchema.parse({ ...owners, touchedPaths: [unsatisfied, byCommit] }).touchedPaths)
      .toEqual([unsatisfied, byCommit])
  })

  test("refuses a path with no policy and an owner list that is not names", () => {
    const { agentPolicy: _agentPolicy, ...noPolicy } = owners.touchedPaths[0]!
    expect(ChangeOwnersSchema.safeParse({ ...owners, touchedPaths: [noPolicy] }).success).toBe(false)
    expect(
      ChangeOwnersSchema.safeParse({
        ...owners,
        touchedPaths: [{ ...owners.touchedPaths[0]!, owners: [{ login: "will" }] }]
      }).success
    ).toBe(false)
  })
})

describe("whose turn it is (plue#460)", () => {
  test("a wire that named no actor, no time and no reason still parses: the line falls back to the party", () => {
    const bare = { party: "author", actorId: null, since: null, reason: null }
    const parsed = ChangeTurnSchema.parse(bare)
    expect(parsed).toEqual(bare)
    expect(parsed.actorLogin).toBeUndefined()
  })

  test("plue#484's actor login rides beside the id, and the party is required", () => {
    const full = {
      party: "reviewer",
      actorId: "u-1",
      actorLogin: "will",
      since: "2026-09-05T09:00:00Z",
      reason: "changes requested"
    }
    expect(ChangeTurnSchema.parse(full)).toEqual(full)
    expect(ChangeTurnSchema.safeParse({ actorId: null, since: null, reason: null }).success).toBe(false)
  })
})

describe("a review request (plue#488)", () => {
  test("names either a human or an agent, never both, and keeps plue's own state word", () => {
    const human = { id: 9, reviewer: "will", agent: null, requestedBy: "ada", state: "requested", createdAt: null }
    const agent = { ...human, id: 10, reviewer: null, agent: "reviewer", state: "dismissed" }
    expect(ChangeReviewRequestSchema.parse(human)).toEqual(human)
    expect(ChangeReviewRequestSchema.parse(agent)).toEqual(agent)
  })

  test("refuses a fractional id — the id is what the DELETE route addresses", () => {
    const row = { id: 9.5, reviewer: "will", agent: null, requestedBy: null, state: "requested", createdAt: null }
    expect(ChangeReviewRequestSchema.safeParse(row).success).toBe(false)
    expect(ChangeReviewRequestSchema.safeParse({ ...row, id: 9 }).success).toBe(true)
  })
})

describe("a landed change's provenance (plue#464)", () => {
  test("parses with neither a time nor an author, and with no approvals recorded", () => {
    const bare = { at: null, by: null, approvedBy: [] }
    const parsed = ChangeLandedSchema.parse(bare)
    expect(parsed).toEqual(bare)
    expect(parsed.landingRequestNumber).toBeUndefined()
  })

  test("carries plue#485's landing request number, which is 1-based: 0 is refused", () => {
    const landed = {
      at: "2026-09-05T09:02:00Z",
      by: "will",
      landingRequestNumber: 12,
      approvedBy: [{ login: "will", seq: 5 }, { login: "ada", seq: null }]
    }
    expect(ChangeLandedSchema.parse(landed)).toEqual(landed)
    expect(ChangeLandedSchema.safeParse({ ...landed, landingRequestNumber: 0 }).success).toBe(false)
    expect(ChangeLandedSchema.safeParse({ ...landed, landingRequestNumber: null }).success).toBe(true)
  })
})

describe("a walkthrough artifact (plue#465)", () => {
  test("carries the sections verbatim, a section without a diagram is null, and ignores retired quiz data", () => {
    const walkthrough = {
      seq: 5,
      sections: [
        { title: "The route", markdown: "one bounded read", diagram: "graph TD; a-->b" },
        { title: "The cap", markdown: "400 patch lines", diagram: null }
      ]
    }
    expect(ChangeWalkthroughSchema.parse({ ...walkthrough, quiz: [{ question: "retired" }] })).toEqual(walkthrough)
  })

  test("an artifact the server pinned to no revision is null, and seq is 1-based", () => {
    expect(ChangeWalkthroughSchema.parse({ seq: null, sections: [] }).seq).toBeNull()
    expect(ChangeWalkthroughSchema.safeParse({ seq: 0, sections: [] }).success).toBe(false)
  })
})

describe("a landing gate's block (plue#452)", () => {
  test("states the gate's own fields, each null when the gate named none", () => {
    const block = { kind: "owner", name: null, repo: null, missing: null, count: null, path: null, candidates: [] }
    expect(LandingBlockSchema.parse(block)).toEqual(block)
  })

  test("a fully named block round-trips, and a block that names no kind or no candidates is refused", () => {
    const block = {
      kind: "owner",
      name: "will",
      repo: "smithersai/smithers",
      missing: "approval",
      count: 1,
      path: "packages/rpc/src/Cards.ts",
      candidates: ["will", "ada"]
    }
    expect(LandingBlockSchema.parse(block)).toEqual(block)
    const { kind: _kind, ...noKind } = block
    const { candidates: _candidates, ...noCandidates } = block
    expect(LandingBlockSchema.safeParse(noKind).success).toBe(false)
    expect(LandingBlockSchema.safeParse(noCandidates).success).toBe(false)
  })
})

describe("an analyzer run (plue#454)", () => {
  test("a paused run names who paused it and why; a failed one carries its reason", () => {
    const paused = {
      name: "lint",
      state: "paused",
      seq: 5,
      startedAt: "2026-09-05T09:00:00Z",
      finishedAt: null,
      pausedBy: "will",
      pausedReason: "waiting on the owner",
      failureReason: null
    }
    const failed = { ...paused, state: "failed", pausedBy: null, pausedReason: null, failureReason: "exit 1" }
    expect(ChangeAnalyzerRunSchema.parse(paused)).toEqual(paused)
    expect(ChangeAnalyzerRunSchema.parse(failed)).toEqual(failed)
  })

  test("every reason field is stated, null included: an absent one is not the same as none", () => {
    const row = {
      name: "lint",
      state: "running",
      seq: null,
      startedAt: null,
      finishedAt: null,
      pausedBy: null,
      pausedReason: null,
      failureReason: null
    }
    expect(ChangeAnalyzerRunSchema.parse(row)).toEqual(row)
    const { failureReason: _failureReason, ...missing } = row
    expect(ChangeAnalyzerRunSchema.safeParse(missing).success).toBe(false)
  })
})

/*
 * The thread's two enums are what the body branches on: `state` is the
 * lifecycle the Done and Ack acts move, `anchor` is where the server says the
 * thread sits at the current revision. Both are nullable and optional — a row
 * that stated neither is not a claim about either.
 */
describe("a comment thread's state and anchor (plue#461)", () => {
  const thread = { path: "src/a.ts", line: 12, body: "why bounded?", author: null, createdAt: null }

  test.each(["open", "done", "resolved"])("the %s state parses", (state) => {
    expect(ChangeThreadSchema.parse({ ...thread, state }).state).toBe(state)
  })

  test.each(["current", "stale", "moved"])("the %s anchor parses", (anchor) => {
    expect(ChangeThreadSchema.parse({ ...thread, anchor }).anchor).toBe(anchor)
  })

  test("a row that stated neither carries neither, and an explicit null is kept", () => {
    const bare = ChangeThreadSchema.parse(thread)
    expect(bare.state).toBeUndefined()
    expect(bare.anchor).toBeUndefined()
    expect(ChangeThreadSchema.parse({ ...thread, state: null, anchor: null })).toEqual({
      ...thread,
      state: null,
      anchor: null
    })
  })

  test("a state or anchor outside the enums is refused, so no body branches on a word it cannot render", () => {
    expect(ChangeThreadSchema.safeParse({ ...thread, state: "reopened" }).success).toBe(false)
    expect(ChangeThreadSchema.safeParse({ ...thread, anchor: "gone" }).success).toBe(false)
  })

  test("a moved thread carries where its hunk now sits and the revision Done recorded", () => {
    const moved = {
      ...thread,
      id: 3,
      currentLine: 14,
      state: "done",
      anchor: "moved",
      commitId: "a03f5f1e",
      resolvedInRevision: { commitId: "a03f5f1e", seq: 5 }
    }
    expect(ChangeThreadSchema.parse(moved)).toEqual(moved)
    expect(ChangeThreadSchema.parse({ ...moved, resolvedInRevision: null }).resolvedInRevision).toBeNull()
  })
})
