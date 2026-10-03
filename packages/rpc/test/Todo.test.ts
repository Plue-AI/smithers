import { describe, expect, test } from "vitest"
import {
  ActorRefSchema,
  BranchActivityListSchema,
  parseTodoRef,
  TODO_ROUTES,
  TodoCreateAnswerSchema,
  TodoCreateSchema,
  todoName,
  todoRoute,
  TodoSchema,
  TodoStateSchema
} from "../src/Todo.ts"

// The REST API resource as the backend writes it (services.TodoView).
const todo = {
  n: 12,
  title: "Add the footer link",
  state: "queued",
  owner: 7,
  place: 1,
  amendments: 0,
  lessons: 0,
  branch: { id: "8d4c9f6e-1111-4111-8111-111111111111", name: "smithers/add-the-footer-link" },
  created_by: { kind: "person", id: 7 },
  seq: 1,
  revisions: [{
    rev: 1,
    prompt: "Make it findable.",
    reason: "create",
    author: { kind: "person", id: 7 },
    at: "2026-10-02T12:00:00Z"
  }],
  created_at: "2026-10-02T12:00:00Z",
  updated_at: "2026-10-02T12:00:00Z"
}

describe("TODO wire schema", () => {
  test("the nine states of spec §4.1, and nothing else", () => {
    expect(TodoStateSchema.options).toEqual([
      "queued",
      "starting",
      "working",
      "needs_you",
      "paused",
      "failed",
      "in_review",
      "merged",
      "dropped"
    ])
    expect(TodoStateSchema.safeParse("draft").success).toBe(false)
    expect(TodoStateSchema.safeParse("proposed").success).toBe(false)
  })

  test("a create answers requested with the TODO card", () => {
    const answer = TodoCreateAnswerSchema.parse({ state: "requested", todo })
    expect(answer.todo.n).toBe(12)
    expect(TodoCreateAnswerSchema.safeParse({ state: "queued", todo }).success).toBe(false)
  })

  test("a failed TODO carries its typed failure; a list row carries no revisions", () => {
    const failed = TodoSchema.parse({
      ...todo,
      state: "failed",
      failure: { step: "start", class: "infra", message: "The machine did not start", retryable: true },
      revisions: undefined
    })
    expect(failed.failure?.step).toBe("start")
    expect(failed.revisions).toBeUndefined()
    expect(TodoSchema.safeParse({ ...todo, n: 0 }).success).toBe(false)
  })

  test("a create places at the end only, with a bounded title", () => {
    expect(TodoCreateSchema.parse({ title: "t", place: "append" }).place).toBe("append")
    expect(TodoCreateSchema.safeParse({ title: "t", place: "before T3" }).success).toBe(false)
    expect(TodoCreateSchema.safeParse({ title: "" }).success).toBe(false)
    expect(TodoCreateSchema.safeParse({ title: "x".repeat(257) }).success).toBe(false)
  })

  test("activity entries carry one of spec §3's kinds", () => {
    const entry = {
      seq: 1,
      at: "2026-10-02T12:00:00Z",
      actor: { kind: "agent", agent: "coding", run: "r1", todo: 12 },
      kind: "step",
      summary: { step: "implement", phase: "request", run: "r1" }
    }
    expect(BranchActivityListSchema.parse({ entries: [entry] }).entries[0]?.kind).toBe("step")
    expect(BranchActivityListSchema.safeParse({ entries: [{ ...entry, kind: "chat" }] }).success).toBe(false)
  })

  test("system history activity preserves the member who requested it", () => {
    const entry = {
      seq: 2,
      at: "2026-10-02T12:00:00Z",
      actor: { kind: "system", name: "stack" },
      asked_by: { kind: "person", id: 7, via: "smithers", session: "s1" },
      kind: "rebase",
      summary: { onto: 8 }
    }
    expect(BranchActivityListSchema.parse({ entries: [entry] }).entries[0]).toEqual(entry)
    expect(
      BranchActivityListSchema.safeParse({ entries: [{ ...entry, asked_by: { kind: "person", id: "7" } }] }).success
    ).toBe(
      false
    )
  })

  test("TODOs are named T<n> and read from 12 or T12", () => {
    expect(todoName(12)).toBe("T12")
    expect(parseTodoRef("T12")).toBe(12)
    expect(parseTodoRef("t7")).toBe(7)
    expect(parseTodoRef(" 3 ")).toBe(3)
    expect(parseTodoRef(`T${Number.MAX_SAFE_INTEGER}`)).toBe(Number.MAX_SAFE_INTEGER)
    for (const bad of ["", "T", "T0", "012", "#12", "T1.5", "12a", "T9007199254740993", `T${"9".repeat(400)}`]) {
      expect(parseTodoRef(bad), bad).toBeUndefined()
    }
    expect(todoRoute(12)).toBe("/api/todos/12")
    expect(TODO_ROUTES.todos).toBe("/api/todos")
  })
})

// Library-owner contract: REST actor references share card actor kinds.
describe("ActorRef", () => {
  test("requires exactly one actor identity", () => {
    for (
      const actor of [{}, { kind: "person" }, { kind: "agent", agent: "coding" }, { kind: "system" }, {
        kind: "outside"
      }, { kind: "person", id: 7, agent: "coding", run: "r" }]
    ) {
      expect(ActorRefSchema.safeParse(actor).success).toBe(false)
    }
    for (
      const actor of [{ kind: "person", id: 7, via: "codex", session: "s" }, {
        kind: "agent",
        agent: "coding",
        run: "r",
        todo: 12
      }, { kind: "system", name: "stack" }]
    ) {
      expect(ActorRefSchema.safeParse(actor).success).toBe(true)
    }
  })
  test("uses the shared queue and wait kinds", () => {
    expect(TodoSchema.safeParse({ ...todo, queue: { reason: "daily_limit", position: 1 } }).success).toBe(true)
    expect(TodoSchema.safeParse({ ...todo, queue: { reason: "made_up", position: 1 } }).success).toBe(false)
    expect(TodoSchema.safeParse({ ...todo, needs_you: { kind: "order" } }).success).toBe(false)
    expect(TodoSchema.safeParse({ ...todo, needs_you: { kind: "conflict" } }).success).toBe(true)
  })
})
