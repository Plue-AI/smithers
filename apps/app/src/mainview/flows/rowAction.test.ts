import { describe, expect, it } from "bun:test"
import { type Action, ActionSchema } from "@smthrs/rpc/CardAction"
import { actionFor } from "./rowAction"

const states = ["queued", "starting", "working", "needs_you", "paused", "failed", "in_review", "merged", "dropped"] as const
const kinds = [undefined, "question", "approval", "conflict", "moved_off", "foreign_push"] as const
const roles = ["owner", "maintainer", "member"] as const
const waits: Record<Exclude<typeof kinds[number], undefined>, Action> = {
  question: { tag: "todo.answer", label: "Answer", args: { n: "3" }, primary: true },
  approval: { tag: "todo.answer", label: "Answer", args: { n: "3" }, primary: true },
  conflict: { tag: "branch", label: "Resolve", args: { name: "T3" }, primary: true },
  moved_off: { tag: "branch", label: "Resolve", args: { name: "T3" }, primary: true },
  foreign_push: { tag: "todo", label: "Review", args: { n: "3" }, primary: true }
}

describe("shared viewer action", () => {
  for (const state of states) for (const kind of kinds) for (const first of [false, true]) for (const role of roles) for (const ready of [false, true]) for (const draft of [undefined, false, true]) for (const place of [undefined, 1, 2]) {
    it(`${state}/${kind}/${first}/${role}/${ready}/${draft}/${place}`, () => {
      const entry = { n: 3, state, needs_you: kind === undefined ? undefined : { kind }, first_in_order: first, place, merge: { state: ready ? "ready" : "waiting" }, pr: draft === undefined ? undefined : { draft } }
      const result = actionFor(entry, { role })
      const expected: Action | undefined = state === "needs_you" && kind !== undefined ? waits[kind]
        : state === "failed" ? { tag: "todo.retry", label: "Retry", args: { n: "3" }, primary: true }
        : state === "paused" ? { tag: "todo.resume", label: "Resume", args: { n: "3" }, primary: true }
        : state === "in_review" && first && ready && draft === false && role !== "member" ? { tag: "merge", label: "Merge", args: { n: "3" }, primary: true }
        : undefined
      expect(result).toEqual(expected)
      if (result && expected) expect(ActionSchema.parse(result)).toEqual(expected)
    })
  }
  it("invalid TODO identities fail closed", () => {
    for (const n of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(actionFor({ n, state: "failed" }, { role: "owner" })).toBeUndefined()
    }
  })
  it("an entry without a TODO or a state offers no action", () => {
    expect(actionFor({ state: "failed" }, { role: "owner" })).toBeUndefined()
    expect(actionFor({ n: 3 }, { role: "owner" })).toBeUndefined()
  })
})

// BUG: a needs_you row without a recorded primary kind cannot offer an action.
it("flags the missing needs_you kind rather than masking it with Answer", () => {
  const broken = { n: 3, state: "needs_you" as const }
  expect("needs_you" in broken).toBe(false)
  for (const role of roles) expect(actionFor(broken, { role })).toBeUndefined()
})
