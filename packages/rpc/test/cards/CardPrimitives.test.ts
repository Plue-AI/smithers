/**
 * Shared card primitives: the queue, merge, machine and evidence shapes every card reuses.
 * @since 1.0.0
 */

import { describe, expect, test } from "vitest"
import {
  ActorSchema,
  EvidenceItemSchema,
  EvidenceSchema,
  MachineStateSchema,
  MergeSchema,
  QueueSchema,
  SyncHealthSchema
} from "../../src/CardPrimitives.ts"
import { person } from "../fixtures/_shared.ts"

// Literal oracles from ui-components.md v0.4 Shared types and spec §4.1.1, §4.2, §4.4, §10.4.3, §10.6.2a.
const MERGE_STATES = ["ready", "waiting", "blocked", "merging", "done"] as const
const MERGE_REASONS = [
  "state",
  "order",
  "attention",
  "merging",
  "rechecking",
  "pending_work",
  "stale_head",
  "checks",
  "review_required",
  "github"
] as const
const SYNC_HEALTH = ["fresh", "stale", "limited", "refused"] as const
const EVIDENCE_KINDS = ["diff", "check", "github_check", "review", "usage", "flow", "model_access"] as const

describe("queue", () => {
  test.each(["machine", "merge_order", "rebase", "daily_limit"])(
    "carries the %s code and its predecessor",
    (reason) => {
      expect(QueueSchema.parse({ reason, after: 8, position: 2 })).toEqual({ reason, after: 8, position: 2 })
    }
  )
  test("refuses rendered copy in place of a code", () => {
    expect(QueueSchema.safeParse({ reason: "merges after T8", position: 2 }).success).toBe(false)
  })
})

describe("merge", () => {
  test.each(MERGE_STATES)("accepts state %s", (state) => {
    expect(MergeSchema.safeParse({ state, on_github: false }).success).toBe(true)
  })
  test.each(MERGE_REASONS)("accepts reason %s", (reason) => {
    expect(MergeSchema.safeParse({ state: "blocked", reason, on_github: false }).success).toBe(true)
  })
  test.each(["merged", "held", "", "ready_to_merge"])("rejects state %j", (state) => {
    expect(MergeSchema.safeParse({ state, on_github: false }).success).toBe(false)
  })
  test("on_github is required", () => {
    expect(MergeSchema.safeParse({ state: "ready" }).success).toBe(false)
  })
})

describe("machine state", () => {
  test.each(["awake", "asleep", "waking", "closed"])("accepts %s", (state) => {
    expect(MachineStateSchema.parse({ state })).toEqual({ state })
  })
  test("waiting carries its position and failed carries its typed error", () => {
    expect(MachineStateSchema.safeParse({ state: "waiting", position: 2 }).success).toBe(true)
    expect(MachineStateSchema.safeParse({ state: "waiting" }).success).toBe(false)
    expect(MachineStateSchema.safeParse({ state: "waiting", position: 0 }).success).toBe(false)
    expect(
      MachineStateSchema.safeParse({ state: "failed", error: { class: "disk_full", message: "Disk full" } }).success
    )
      .toBe(true)
    expect(MachineStateSchema.safeParse({ state: "failed" }).success).toBe(false)
  })
  test.each(["ready", "building", "sleeping", "provisioning", ""])("rejects %j", (state) => {
    expect(MachineStateSchema.safeParse({ state }).success).toBe(false)
  })
})

describe("sync health", () => {
  test.each(SYNC_HEALTH)("accepts %s", (health) => {
    expect(SyncHealthSchema.parse(health)).toBe(health)
  })
  test.each(["ok", "degraded", ""])("rejects %j", (health) => {
    expect(SyncHealthSchema.safeParse(health).success).toBe(false)
  })
})

describe("evidence", () => {
  test.each(EVIDENCE_KINDS)("has a %s item", (kind) => {
    expect(EvidenceItemSchema.options.map((option) => option.shape.kind.value)).toContain(kind)
  })
  test("one attempt keeps its revision, the previous review and the running flag", () => {
    const evidence = {
      attempt: 2,
      revision: "r2",
      items: [{ kind: "review", summary: "Passed" }],
      previous: { revision: "r1", items: [{ kind: "review", summary: "Failed" }] },
      reviewing: true
    }
    expect(EvidenceSchema.parse(evidence)).toEqual(evidence)
    expect(EvidenceSchema.safeParse({ attempt: 2, items: [] }).success).toBe(false)
  })
  test("diff counts and usage are nonnegative integers or durations", () => {
    expect(EvidenceItemSchema.safeParse({ kind: "diff", files: 1, added: -1, removed: 0 }).success).toBe(false)
    expect(EvidenceItemSchema.safeParse({ kind: "diff", files: 1.5, added: 1, removed: 0 }).success).toBe(false)
    expect(EvidenceItemSchema.safeParse({ kind: "usage", tokens: 10, time_s: 1.5 }).success).toBe(true)
    expect(EvidenceItemSchema.safeParse({ kind: "usage", tokens: 10, time_s: -1 }).success).toBe(false)
  })
})

describe("Smithers has exactly one actor encoding: the smithers agent participant (M-34, §14.6a.1)", () => {
  const smithers = { kind: "agent", id: "smithers-install", agent: "smithers", avatar_url: person.avatar_url }
  test("is agent smithers with its own id and avatar", () => {
    expect(ActorSchema.safeParse({ ...smithers, color_index: 6 }).success).toBe(true)
  })
  test.each(["app", "fast"])("is never agent %s", (agent) => {
    expect(ActorSchema.safeParse({ ...smithers, agent, color_index: 6 }).success).toBe(false)
  })
  test("is never a person via smithers, and a system actor carries no member or id", () => {
    expect(ActorSchema.safeParse({ ...person, via: "smithers" }).success).toBe(false)
    expect(ActorSchema.parse({ kind: "system", for_member: person, id: "smithers", color_index: 7 })).toEqual({
      kind: "system",
      color_index: 7
    })
  })
})
