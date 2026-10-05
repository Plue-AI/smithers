import { describe, expect, it } from "vitest"
import { ActionSchema, actionFor } from "../src/CardAction.ts"

const states = ["queued", "starting", "working", "needs_you", "paused", "failed", "in_review", "merged", "dropped"] as const
const kinds = [undefined, "question", "approval", "conflict", "moved_off", "foreign_push"] as const
const roles = ["owner", "maintainer", "member"] as const
const waits = {
  question: { tag: "todo.answer", label: "Answer", args: { n: "3" } },
  approval: { tag: "todo.answer", label: "Answer", args: { n: "3" } },
  conflict: { tag: "branch", label: "Resolve", args: { name: "T3" } },
  moved_off: { tag: "branch", label: "Resolve", args: { name: "T3" } },
  foreign_push: { tag: "todo", label: "Review", args: { n: "3" } }
}

describe("shared viewer action", () => {
  for (const state of states) for (const kind of kinds) for (const first of [false, true]) for (const role of roles) {
    it(`${state}/${kind}/${first}/${role}`, () => {
      const entry = { n: 3, state, needs_you: kind === undefined ? undefined : { kind }, first_in_order: first }
      const result = actionFor(entry, { role })
      const expected = state === "needs_you" && kind !== undefined ? waits[kind]
        : state === "failed" ? { tag: "todo.retry", label: "Retry", args: { n: "3" } }
        : state === "in_review" && first && role !== "member" ? { tag: "merge", label: "Merge", args: { n: "3" } }
        : undefined
      expect(result).toEqual(expected)
      if (result) expect(ActionSchema.parse(result)).toEqual(expected)
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
