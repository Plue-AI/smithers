/** Frozen T-APP-19 lead/design rulings, 2026-10-02. */
import { expect, test } from "vitest"
import { ActorSchema, EvidenceSchema, MergeSchema, QueueSchema } from "../../src/CardPrimitives.ts"
import { ConfirmCardSchema } from "../../src/ConfirmCard.ts"
import { DraftCardSchema } from "../../src/DraftCard.ts"
import { HomeCardSchema } from "../../src/HomeCard.ts"
import { TodoCardSchema } from "../../src/TodoCard.ts"
import { agent, ben, outside, person, system } from "../fixtures/_shared.ts"
import { fixtures as confirms } from "../fixtures/Confirm.ts"
import { fixtures as drafts } from "../fixtures/Draft.ts"
import { fixtures as home } from "../fixtures/Home.ts"
import { fixtures as todos } from "../fixtures/Todo.ts"

// Lead rulings 1 and 2 override design's alternate evidence shape.
test("revision evidence preserves previous results while review is running", () => {
  const evidence = [{
    attempt: 2,
    revision: "r2",
    items: [{ kind: "test", label: "Passed" }],
    previous: { revision: "r1", items: [{ kind: "test", label: "Failed" }] },
    reviewing: true
  }]
  expect(EvidenceSchema.parse(evidence)).toEqual(evidence)
  expect(TodoCardSchema.parse({ ...todos.in_review, evidence, approved_revision: "r1" }).evidence).toEqual(evidence)
  expect(ConfirmCardSchema.parse({ ...confirms.review_merge, evidence, approved_revision: "r1" }).approved_revision)
    .toBe("r1")
  expect(EvidenceSchema.safeParse([{ attempt: 1, items: [] }]).success).toBe(false)
})
test.each(["ready", "waiting", "blocked", "merging", "done"])(
  "one %s merge shape on TODO Home and Confirm",
  (state) => {
    const merge = { state, reason: "pending_work", detail: "Rechecking", on_github: false }
    expect(MergeSchema.parse(merge)).toEqual(merge)
    expect(TodoCardSchema.parse({ ...todos.in_review, merge }).merge).toEqual(merge)
    expect(HomeCardSchema.parse({ ...home.active, items: [{ ...home.active.items[0]!, merge }] }).items[0]!.merge)
      .toEqual(merge)
    expect(ConfirmCardSchema.parse({ ...confirms.review_merge, merge }).merge).toEqual(merge)
  }
)
// spec §10.6.2a: first failed merge predicate's reason code.
test.each(["state", "order", "attention", "merging", "rechecking", "pending_work", "stale_head", "checks", "github"])(
  "merge reason %s",
  (reason) => {
    expect(MergeSchema.safeParse({ state: "blocked", reason, on_github: false }).success).toBe(true)
  }
)
test("queue uses codes and a predecessor, never rendered copy", () => {
  for (const reason of ["machine", "merge_order", "rebase"]) {
    expect(QueueSchema.parse({ reason, after: 8, position: 2 })).toEqual({ reason, after: 8, position: 2 })
  }
  expect(QueueSchema.safeParse({ reason: "merges after Tn", position: 2 }).success).toBe(false)
})
// M-34: Smithers is system, agents and people share presence and identity colour.
test.each([person, agent, system, outside, { kind: "github", login: "ben", color_index: 3 }])(
  "actor has bounded identity colour: %j",
  (actor) => {
    expect(ActorSchema.parse(actor)).toEqual(actor)
    for (const color_index of [-1, 6, 0.5]) expect(ActorSchema.safeParse({ ...actor, color_index }).success).toBe(false)
  }
)
test("Smithers for a member uses one system actor shape", () => {
  const actor = { ...system, for: ben }
  expect(ActorSchema.parse(actor)).toEqual(actor)
  expect(ActorSchema.safeParse({ ...person, via: "smithers" }).success).toBe(false)
})
test("confirmation variants keep one-click exact text and review merge data", () => {
  expect(ConfirmCardSchema.parse({ ...confirms.one_click, text: "Drop T12" }).text).toBe("Drop T12")
  expect(ConfirmCardSchema.parse(confirms.done).receipt?.text).toBe("Dropped T12")
  expect(ConfirmCardSchema.parse(confirms.review_merge).pr?.number).toBe(3475)
})
// spec §14.3 Draft row; explicit fixture coverage required by ticket Scope In.
test("Draft fixtures cover placement issue seed and commit receipt", () => {
  expect([drafts.append.place.mode, drafts.before.place.mode, drafts.amend.place.mode]).toEqual([
    "append",
    "before",
    "amend"
  ])
  expect(DraftCardSchema.parse(drafts.issue).issue?.fixes).toBe(true)
  expect(DraftCardSchema.parse(drafts.seed).seed?.files).toEqual(["packages/rpc/src/TodoCard.ts"])
  expect(DraftCardSchema.parse(drafts.committed).committed).toEqual({ n: 12, rev: 1 })
})
test("TODO fixtures cover all nine states", () => {
  expect([...new Set(Object.values(todos).map((value) => value.state))].sort()).toEqual([
    "dropped",
    "failed",
    "in_review",
    "merged",
    "needs_you",
    "paused",
    "queued",
    "starting",
    "working"
  ])
})
test("Home and TODO use the same branch shape and agent presence", () => {
  const todo = TodoCardSchema.parse(todos.working)
  const row = HomeCardSchema.parse({
    ...home.active,
    items: [{ ...home.active.items[0]!, branch: todo.branch, present: todo.present }]
  }).items[0]!
  expect(row.branch).toEqual(todo.branch)
  expect(row.present.some((actor) => actor.kind === "agent")).toBe(true)
})
