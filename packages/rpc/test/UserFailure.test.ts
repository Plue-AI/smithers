import { describe, expect, test } from "vitest"
import {
  failureDetail,
  presentUserFailure,
  UNKNOWN_FAILURE,
  USER_FAILURE_ACTIONS,
  type UserFailureCopy,
  type UserFailureRegistry
} from "../src/UserFailure.ts"

class Busy extends Error {
  readonly _tag = "Busy" as const
  readonly tab: string
  constructor(tab: string) {
    super(`internal lease ${tab} held; stack jargon`)
    this.tab = tab
  }
}
class Gone extends Error {
  readonly _tag = "Gone" as const
}
type Known = Busy | Gone

const registry: UserFailureRegistry<Known> = {
  Busy: (failure) => ({
    fault: "infra",
    sentence: `Busy in ${failure.tab === "a" ? "one" : "another"} tab.`,
    actions: ["use-here"]
  }),
  Gone: { fault: "user", sentence: "Sign in again.", actions: ["sign-in", "retry"] }
}

describe("presentUserFailure", () => {
  test("a registry must list every tag in the union and nothing else", () => {
    // @ts-expect-error Gone is missing, so the registry does not compile.
    const missing: UserFailureRegistry<Known> = { Busy: UNKNOWN_FAILURE }
    const extra: UserFailureRegistry<Known> = {
      Busy: UNKNOWN_FAILURE,
      Gone: UNKNOWN_FAILURE,
      // @ts-expect-error Stray is not a tag of the union.
      Stray: UNKNOWN_FAILURE
    }
    expect([missing, extra]).toHaveLength(2)
  })

  test("fixed and derived entries give their copy and keep the raw text as detail only", () => {
    const busy = presentUserFailure(registry, new Busy("b"))
    expect(busy).toMatchObject({ tag: "Busy", fault: "infra", sentence: "Busy in another tab.", actions: ["use-here"] })
    expect(busy.sentence).not.toContain("lease")
    expect(busy.detail).toContain("internal lease b held")
    expect(presentUserFailure(registry, new Gone("x"))).toMatchObject({
      tag: "Gone",
      fault: "user",
      actions: ["sign-in", "retry"]
    })
  })

  test("a tagged cause under an untagged wrapper still gets its own copy", () => {
    const wrapped = new Error("prepare runtime and persisted state: boom", {
      cause: new Error("x", { cause: new Gone("deep") })
    })
    const shown = presentUserFailure(registry, wrapped)
    expect(shown.tag).toBe("Gone")
    expect(shown.detail).toContain("prepare runtime")
    expect(shown.detail).toContain("Caused by")
  })

  for (
    const [name, value] of [
      ["Error", new Error("SECRET raw message")],
      ["string", "SECRET raw string"],
      ["object", { _tag: "NotRegistered", message: "SECRET tagged" }],
      ["prototype key", { _tag: "toString", message: "SECRET proto" }],
      ["number", 42],
      ["null", null],
      ["undefined", undefined]
    ] as const
  ) {
    test(`an unknown ${name} never shows its message and is reported once`, () => {
      const reported: Array<unknown> = []
      const shown = presentUserFailure(registry, value, { onUnknown: (error) => reported.push(error) })
      expect(shown.tag).toBeNull()
      expect(shown.sentence).toBe(UNKNOWN_FAILURE.sentence)
      expect(shown.actions).toEqual(["retry"])
      expect(shown.fault).toBe("bug")
      expect(shown.sentence).not.toContain("SECRET")
      expect(reported).toEqual([value])
    })
  }

  test("a surface's own unknown copy replaces the default, and a throwing reporter is contained", () => {
    const fallback: UserFailureCopy = {
      fault: "infra",
      sentence: "Could not start.",
      actions: ["retry", "reset-local-data"]
    }
    const shown = presentUserFailure(registry, new Error("x"), {
      unknown: fallback,
      onUnknown: () => {
        throw new Error("reporter down")
      }
    })
    expect(shown).toMatchObject({ tag: null, ...fallback })
  })

  test("a cause cycle stops", () => {
    const a = new Error("a") as Error & { cause?: unknown }
    const b = new Error("b", { cause: a })
    a.cause = b
    expect(presentUserFailure(registry, a).tag).toBeNull()
  })

  test("every action id is distinct", () => {
    expect(new Set(USER_FAILURE_ACTIONS).size).toBe(USER_FAILURE_ACTIONS.length)
  })
})

describe("failureDetail", () => {
  test("prints errors, strings, objects and unprintable values without throwing", () => {
    expect(failureDetail(new TypeError("bad"))).toContain("bad")
    expect(failureDetail("plain")).toBe("plain")
    expect(failureDetail({ a: 1 })).toBe("{\"a\":1}")
    expect(failureDetail(undefined)).toBe("undefined")
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(failureDetail(cyclic)).toBe("Unprintable error")
    const stackless = new Error("no stack")
    stackless.stack = ""
    expect(failureDetail(stackless)).toBe("Error: no stack")
  })
})
