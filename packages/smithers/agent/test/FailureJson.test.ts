/**
 * The package's one failure serializer and the boundaries that share it.
 *
 * `AgentAction`, `Budget` and `AgentSession` each used to carry their own JSON
 * conversion, and the copies diverged: a native `Error` nested in a cause kept
 * its message through the session settlement and encoded as `{}` through the
 * other two, so the same storage refusal was legible in one durable record and
 * empty in the next. The table below is the one answer all three now give; the
 * action and budget boundaries are pinned end to end in `AgentAction.test.ts`
 * and `Budget.test.ts`.
 */
import { describe, expect, it } from "vitest"
import * as AgentSession from "../src/AgentSession.ts"
import { failureJson } from "../src/internal/FailureJson.ts"

/** A cause that refers to itself, which no round trip can render. */
const cyclic = (): Record<string, unknown> => {
  const value: Record<string, unknown> = { flowId: "agents/notes" }
  value["self"] = value
  return value
}

/**
 * One row per shape a durable boundary has to survive. `expected` is a literal
 * where the rendering is exact and `"string"` where the value only has a text
 * approximation, which is all any of the three boundaries may rely on.
 */
const table: ReadonlyArray<{ readonly name: string; readonly value: () => unknown; readonly expected: unknown }> = [
  {
    name: "a native Error nested in a cause",
    value: () => ({ nested: new Error("storage unavailable") }),
    expected: { nested: { message: "storage unavailable" } }
  },
  {
    name: "a native Error nested under a tagged refusal",
    value: () => ({ _tag: "journal/SinkFailed", code: "sink_failed", cause: new Error("disk full") }),
    expected: { _tag: "journal/SinkFailed", code: "sink_failed", cause: { message: "disk full" } }
  },
  { name: "a plain JSON cause", value: () => ({ code: "quota_exceeded" }), expected: { code: "quota_exceeded" } },
  { name: "a bigint primitive", value: () => 2n ** 63n, expected: "string" },
  { name: "an undefined primitive", value: () => undefined, expected: "string" },
  { name: "a function primitive", value: () => () => undefined, expected: "string" },
  { name: "a cyclic object", value: cyclic, expected: "string" },
  { name: "an object carrying a BigInt field", value: () => ({ offset: 2n ** 63n }), expected: "string" }
]

describe("the failure serializer every durable boundary shares", () => {
  for (const row of table) {
    it(`renders ${row.name} the same way at every boundary`, () => {
      const rendered = failureJson(row.value())
      if (row.expected === "string") {
        expect(typeof rendered).toBe("string")
        expect(rendered).not.toBe("")
      } else {
        expect(rendered).toEqual(row.expected)
      }
      // The session settlement is the boundary that was already correct, so it
      // is the one that pins the shared answer directly. The other two reach
      // the same function through their own encoders.
      const settled = AgentSession.settlementFailure(row.value())
      if (row.expected === "string") expect(typeof settled).toBe("string")
      else expect(settled).toEqual(rendered)
    })
  }

  it("survives throwing accessors and reflective proxy traps", () => {
    const getterFailure = {
      get message(): string {
        throw new Error("diagnostic getter failed")
      }
    }
    const nestedGetter = { cause: getterFailure }
    const arrayGetter = [getterFailure]
    const trapped = new Proxy({}, {
      getPrototypeOf() {
        throw new Error("prototype trap failed")
      },
      ownKeys() {
        throw new Error("keys trap failed")
      }
    })

    for (const failure of [getterFailure, nestedGetter, arrayGetter, trapped]) {
      const rendered = failureJson(failure)
      expect(typeof rendered).toBe("string")
      expect(rendered).not.toBe("")
      expect(typeof AgentSession.settlementFailure(failure)).toBe("string")
    }
  })

  it("never throws, whatever the failure channel hands it", () => {
    let deep: Record<string, unknown> = {}
    for (let level = 0; level < 20_000; level++) deep = { deep }

    for (const value of [deep, cyclic(), Symbol("refusal"), Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(typeof failureJson(value)).toBe("string")
    }
  })
})
