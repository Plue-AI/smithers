import { expect, test } from "vitest"
import { ActorSchema, QueueSchema } from "../../src/CardPrimitives.ts"
import { DraftCardSchema } from "../../src/DraftCard.ts"
import { MonitorCardSchema } from "../../src/MonitorCard.ts"
test("Draft can represent a committed amendment", () => {
  expect(
    DraftCardSchema.safeParse({
      title: "Twelve",
      prompt: "Fix it",
      acceptance: ["Checks pass"],
      place: { mode: "amend", n: 12, options: [] },
      committed: { n: 12, rev: 2 },
      private: false
    }).success
  ).toBe(true)
})
test("queue carries machine-readable order and predecessor", () => {
  expect(QueueSchema.safeParse({ reason: "merge_order", after: 8, position: 2 }).success).toBe(true)
})
test("Smithers has exactly one actor encoding", () => {
  // M-34 rejects the old Smithers encoding itself, with all other fields valid.
  for (const agent of ["app", "fast"]) {
    expect(
      ActorSchema.safeParse({
        kind: "agent",
        id: "smithers",
        agent,
        avatar_url: "https://example.com/avatar.png",
        name: "Smithers",
        color_index: 6
      }).success
    ).toBe(false)
  }
  expect(
    ActorSchema.safeParse({
      kind: "person",
      login: "ben",
      name: "Ben",
      avatar_url: "https://example.com/avatar.png",
      color_index: 1,
      via: "smithers"
    }).success
  ).toBe(false)
})
test("Monitor records deterministic cells before model summaries arrive", () => {
  expect(
    MonitorCardSchema.safeParse({
      id: "r",
      title: "Check T12",
      flow: "todo",
      version: "v1",
      state: "done",
      attempts: [{
        n: 1,
        state: "done",
        graph: [],
        steps: [{ id: "check", label: "Check", state: "done" }],
        phases: [{
          id: "attempt-1-check",
          step: "check",
          title: "Ran checks · 2 failed",
          took_s: 3,
          tone: "fail",
          cells: [{ id: "attempt-1-check-run", kind: "run", label: "Ran pnpm test · 2 failed" }]
        }]
      }],
      waits: [],
      tokens: 0,
      time_s: 3,
      cost_usd: 0
    }).success
  ).toBe(true)
})
