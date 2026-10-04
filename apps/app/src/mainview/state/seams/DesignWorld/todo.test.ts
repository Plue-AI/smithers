import { describe, expect, test } from "bun:test"
import { TodoCardSchema } from "@smthrs/rpc/TodoCard"
import { DraftCardSchema } from "@smthrs/rpc/DraftCard"
import { createAppStore } from "../../AppStore"
import { memoryStorage } from "../../TestFixtures"
import type { SeamContext } from "../SeamContext"
import { createTodoSeam, type DraftEntry, type TodoEntry } from "../TodoSeam"
import { createDesignWorld, MAYA, type DesignTimers } from "./index"
import { designAudience, designTodoCard, withDesignTodos } from "./todo"

/** Timers that never fire: the seed's script stays where the mutation left it. */
const stillTimers: DesignTimers = { set: () => 0, clear: () => {} }

/** The controller's wiring, signed out: no identity row, no topics, no HTTP. */
const harness = async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const context: SeamContext = {
    http: () => Promise.reject(new Error("no backend")), store, dispatch: store.dispatch, baseUrl: "http://localhost:5174",
    actor: () => "user", nextOrdinal: store.nextOrdinal, isDisposed: () => false
  }
  const design = createDesignWorld({ timers: stillTimers, viewer: MAYA })
  const seam = withDesignTodos(createTodoSeam(context, { debounceMs: 1, onDispose: () => {} }), context, design)
  const todo = (n: number) => store.collections.cards.get(`todo:${n}`) as TodoEntry | undefined
  const drafts = (): DraftEntry[] => [...store.collections.cards.values()].flatMap(row => row.kind === "draft" ? [row as DraftEntry] : [])
  const seeded = (ref: string) => design.world().todos.find(each => each.ref === ref)!
  return { store, design, seam, todo, drafts, seeded }
}

describe("withDesignTodos (mock seam): todo.* and draft.* land on the seed, signed out", () => {
  test("every seeded TODO projects to a TodoCard the wire accepts", async () => {
    const { design } = await harness()
    const world = design.world()
    for (const item of world.todos) expect(() => TodoCardSchema.parse(designTodoCard(world, item))).not.toThrow()
    const asking = designTodoCard(world, world.todos.find(each => each.ref === "T9")!)
    expect(asking.state).toBe("needs_you")
    expect(asking.waits.map(wait => wait.actions.map(action => action.tag))).toEqual([["todo.answer"]])
  })

  test("todo opens the Tn card without a session; an unknown number refuses by name", async () => {
    const h = await harness()
    expect(h.store.collections.identitySessions.get("identity")?.state).not.toBe("signed-in")
    expect(await h.seam.showTodo(9)).toEqual({ value: "Opened T9" })
    expect(h.todo(9)?.payload).toEqual({ n: 9, requests: [] })
    const ordinal = h.todo(9)!.ordinal
    expect(await h.seam.showTodo(9)).toEqual({ value: "Opened T9" })
    expect(h.todo(9)!.ordinal).toBe(ordinal)
    expect(await h.seam.showTodo(99)).toBe("No TODO T99")
    expect(h.todo(99)).toBeUndefined()
  })

  test("todo.answer and todo.steer reach the seed as the viewer", async () => {
    const h = await harness()
    expect(await h.seam.answerTodo(9, "Use the Stripe test clock")).toEqual({ value: "Answered T9" })
    expect(h.seeded("T9").question?.answer).toEqual({ by: MAYA, text: "Use the Stripe test clock" })
    expect(h.seeded("T9").state).not.toBe("needs-you")
    expect(typeof await h.seam.answerTodo(9, "again")).toBe("string")
    expect(await h.seam.steerTodo(10, "Keep the old route")).toEqual({ value: "Steered T10" })
    expect(h.seeded("T10").steers).toEqual([{ by: MAYA, text: "Keep the old route" }])
    expect(await h.seam.steerTodo(99, "nobody")).toBe("No TODO T99")
    expect(await h.seam.answerTodo(99, "nobody")).toBe("No TODO T99")
  })

  test("todo.stop, resume, retry and drop follow the seed's state rules", async () => {
    const h = await harness()
    expect(await h.seam.controlTodo(10, "retry")).toBe("Only failed TODOs retry")
    expect(await h.seam.controlTodo(10, "stop")).toEqual({ value: "Stopped T10" })
    expect(h.seeded("T10").state).toBe("paused")
    expect(await h.seam.controlTodo(10, "resume")).toEqual({ value: "Resumed T10" })
    expect(h.seeded("T10").state).toBe("queued")
    expect(await h.seam.controlTodo(11, "drop")).toEqual({ value: "Dropped T11" })
    expect(h.seeded("T11").state).toBe("dropped")
    expect(await h.seam.controlTodo(11, "drop")).toBe("Only unmerged TODOs drop")
    expect(await h.seam.controlTodo(99, "stop")).toBe("No TODO T99")
  })

  test("todo.new drafts privately, edits land on the seed, and Commit opens the new TODO", async () => {
    const h = await harness()
    expect(await h.seam.newTodo({})).toEqual({ value: "Drafted" })
    const draft = h.drafts()[0]!
    expect(draft.audience_member_id).toBe(designAudience(MAYA))
    expect(draft.title).toBe("New TODO")
    expect(draft.payload.private).toBe(true)
    expect(await h.seam.setTodoFormField(draft.id, "title", "Retry webhooks")).toBeUndefined()
    expect(await h.seam.setTodoFormField(draft.id, "prompt", "Retry failed webhooks three times.")).toBeUndefined()
    expect(await h.seam.setTodoFormField(draft.id, "acceptance", "Backoff doubles\nStops after three")).toBeUndefined()
    expect(await h.seam.setTodoFormField(draft.id, "place", JSON.stringify({ mode: "before", n: 11 }))).toBeUndefined()
    expect(await h.seam.setTodoFormField(draft.id, "colour", "red")).toBe("Unknown draft field.")
    const edited = DraftCardSchema.parse(h.drafts()[0]!.payload)
    expect([edited.title, edited.prompt, edited.acceptance, edited.place.mode]).toEqual(
      ["Retry webhooks", "Retry failed webhooks three times.", ["Backoff doubles", "Stops after three"], "before"])
    expect(await h.seam.newTodo({ text: "stale", cardId: draft.id })).toEqual({ value: "Committed as T12" })
    expect(h.todo(12)?.payload).toEqual({ n: 12, requests: [] })
    expect(h.drafts()[0]!.audience_member_id).toBeNull()
    expect(h.drafts()[0]!.payload.committed).toEqual({ n: 12, rev: 1 })
    const stack = h.design.world().repo.stack
    expect(stack.indexOf("t-t12")).toBe(stack.indexOf(h.seeded("T11").id) - 1)
    expect(await h.seam.newTodo({ text: "again", cardId: draft.id })).toBe("Already committed")
    expect(await h.seam.newTodo({ text: "x", cardId: "draft:nope" })).toBe("No such draft")
  })

  test("an amend-placed draft commits through todo.amend; discard removes the card", async () => {
    const h = await harness()
    expect(await h.seam.newTodo({ text: "Also log the retry count" })).toEqual({ value: "Drafted" })
    const draft = h.drafts()[0]!
    expect(draft.title).toBe("Also log the retry count")
    expect(await h.seam.setTodoFormField(draft.id, "place", JSON.stringify({ mode: "amend", n: 10 }))).toBeUndefined()
    expect(await h.seam.amendTodo({ n: 10, text: "stale", cardId: draft.id })).toEqual({ value: "Amended T10" })
    expect(h.seeded("T10").amendments).toEqual([{ by: MAYA, text: "Also log the retry count" }])
    expect(await h.seam.amendTodo({ n: 11, text: "Add a flag" })).toEqual({ value: "Amended T11" })
    expect(await h.seam.amendTodo({ n: 99, text: "Add a flag" })).toBe("No TODO T99")
    expect(await h.seam.newTodo({ text: "throwaway" })).toEqual({ value: "Drafted" })
    const second = h.drafts().find(row => row.id !== draft.id)!
    expect(h.seam.dismissTodoDraft(second.id)).toBeUndefined()
    expect(h.drafts().map(row => row.id)).toEqual([draft.id])
    expect(h.seam.dismissTodoDraft(second.id)).toBe("No such draft")
  })
})
