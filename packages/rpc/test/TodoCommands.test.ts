import { describe, expect, test } from "vitest"
import { CardSchema } from "../src/Cards.ts"
import {
  draftCard,
  parseTodoArgs,
  STACK,
  STACK_COPY,
  TODO,
  TODO_COPY,
  TODO_NEW,
  TODO_NEW_COPY,
  todoCard,
  todoPath,
  TODOS_PATH
} from "../src/TodoCommands.ts"
import { fixtures } from "./fixtures/Todo.ts"

describe("the TODO commands every host binds", () => {
  test("are named, described and routed once", () => {
    expect([STACK, TODO, TODO_NEW]).toEqual(["stack", "todo", "todo.new"])
    expect(STACK_COPY).toEqual({ summary: "Show the stack and background runs" })
    expect(TODO_COPY).toEqual({ summary: "Open a TODO", args: "<Tn>" })
    expect(TODO_NEW_COPY).toEqual({ summary: "Write and place a TODO", args: "[text]" })
    expect(TODOS_PATH).toBe("/api/todos")
    expect(todoPath(12)).toBe("/api/todos/12")
  })

  test("the grammar reads a TODO number and its text, or the whole line as text", () => {
    const answer = parseTodoArgs("answer")
    expect(answer("T12 yes\nsecond line")).toEqual({ payload: { n: 12, answer: "yes\nsecond line" } })
    expect(answer("12")).toEqual({ payload: { n: 12 } })
    expect(answer("  T12  ")).toEqual({ payload: { n: 12 } })
    expect(answer("T0")).toEqual({ payload: {} })
    expect(answer("twelve")).toEqual({ payload: {} })
    expect(answer(undefined)).toEqual({ payload: {} })
    expect(parseTodoArgs()("T12 ignored text")).toEqual({ payload: { n: 12 } })
    const text = parseTodoArgs("text", false)
    expect(text("Log retry counts\nin the worker")).toEqual({ payload: { text: "Log retry counts\nin the worker" } })
    expect(text("   ")).toEqual({ payload: {} })
  })

  test("JSON input is lossless, and anything but an object is refused", () => {
    const answer = parseTodoArgs("answer")
    expect(answer("{\"n\":12,\"answer\":\" yes\\n \"}")).toEqual({ payload: { n: 12, answer: " yes\n " } })
    expect(parseTodoArgs("text", false)("{\"text\":\"x\",\"cardId\":\"draft:1\"}")).toEqual({
      payload: { text: "x", cardId: "draft:1" }
    })
    for (const refused of ["{broken", "{\"n\":1}x"]) expect(answer(refused)).toEqual({ error: "Invalid TODO input" })
  })

  test("the TODO card carries the model once read, and its number before", () => {
    const model = fixtures.queued.model
    const card = todoCard(12, model, 3, 1_000)
    expect(card).toEqual({
      id: "todo:12",
      kind: "todo",
      title: "Card model contracts",
      status: "active",
      createdAt: 1_000,
      ordinal: 3,
      payload: { n: 12, model, requests: [] }
    })
    expect(CardSchema.parse(card)).toEqual(card)
    const blank = todoCard(7, undefined, 0, 5)
    expect(blank).toEqual({
      id: "todo:7",
      kind: "todo",
      title: "T7",
      status: "active",
      createdAt: 5,
      ordinal: 0,
      payload: { n: 7, requests: [] }
    })
    expect(CardSchema.parse(blank)).toEqual(blank)
  })

  test("a Draft is private to its author and titled by its first line", () => {
    const options = [{ n: 8, title: "Persist merge requests", state: "in_review" as const }]
    const seed = {
      id: "draft:1",
      author: "ben",
      text: "Log retry counts\nin the worker",
      options,
      idempotencyKey: "k-1"
    }
    const appended = draftCard(seed, 4, 9)
    expect(appended).toEqual({
      id: "draft:1",
      kind: "draft",
      audience_member_id: "ben",
      title: "Log retry counts",
      status: "active",
      createdAt: 9,
      ordinal: 4,
      payload: {
        title: "Log retry counts",
        prompt: "Log retry counts\nin the worker",
        acceptance: [],
        place: { mode: "append", options },
        private: true,
        idempotencyKey: "k-1"
      }
    })
    expect(CardSchema.parse(appended)).toEqual(appended)
    const placed = draftCard({ ...seed, title: "Retry counts", acceptance: ["Counts log"], before: 8 }, 0, 0)
    expect(placed.title).toBe("Retry counts")
    expect(placed.payload).toMatchObject({
      title: "Retry counts",
      acceptance: ["Counts log"],
      place: { mode: "before", n: 8, options }
    })
    expect(CardSchema.parse(placed)).toEqual(placed)
    // An empty Draft is titled empty; the person fills it on the card.
    expect(draftCard({ ...seed, text: "" }, 0, 0).title).toBe("")
  })
})
