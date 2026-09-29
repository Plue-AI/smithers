import { describe, expect, test } from "bun:test"
import * as Agents from "../src/agents.ts"
import type * as Extension from "../src/extension.ts"
import * as Models from "../src/models.ts"

const agent = (overrides: Partial<Extension.Descriptor> = {}): Extension.Descriptor => ({
  name: "review",
  description: "Reviews the change.",
  modelInvocable: true,
  kind: "markdown",
  seat: "sol",
  effort: "high",
  flows: ["read", "bash"],
  capabilities: ["fs:read:**"],
  path: "/repo/flows/review/flow.mdx",
  ...overrides
})
const listed = [agent(), agent({ name: "echo", kind: "module" }), agent({ name: "manual", modelInvocable: false })]
const body = {
  descriptor: agent(),
  text: "Review the change.",
  baseDirectory: "/repo/flows/review",
  digest: "d".repeat(64)
}
const seatOf = (declared: string) => Models.seatOf(declared, [])
const code = (run: () => unknown) => {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(Agents.AgentError)
    expect((error as Agents.AgentError).message).not.toContain("\n")
    return (error as Agents.AgentError).code
  }
  return undefined
}

describe("find", () => {
  test("returns a listed markdown flow", () => {
    expect(Agents.find(listed, "review", "agent").name).toBe("review")
    expect(Agents.find(listed, "manual", "user").name).toBe("manual")
  })
  test("refuses with a typed code", () => {
    expect(code(() => Agents.find(listed, "missing", "user"))).toBe("unknown_agent")
    expect(code(() => Agents.find(listed, "echo", "user"))).toBe("not_an_agent")
    expect(code(() => Agents.find(listed, "manual", "agent"))).toBe("not_invocable")
  })
  test("names the flow door for a module flow", () => {
    expect(() => Agents.find(listed, "echo", "agent")).toThrow(/flow/)
  })
})

describe("profile", () => {
  test("resolves ordered fallback seats and rejects unknown fallback names", () => {
    const profile = Agents.profile(agent({ fallbackSeats: ["sol", "unknown"] }), body, (id) => `resolved:${id}`)
    expect(profile.seat).toBe("resolved:sol")
    expect(profile.fallbackSeats).toEqual(["resolved:sol", "resolved:unknown"])
    expect(Agents.profile(agent({ fallbackSeats: [] }), body, seatOf).fallbackSeats).toEqual([])
    expect(
      code(() =>
        Agents.profile(agent({ fallbackSeats: ["missing"] }), body, (id) => id === "sol" ? "resolved:sol" : undefined)
      )
    ).toBe("unknown_seat")
  })
  test("narrows to the file's declared capabilities when the registry widened them for flows", () => {
    const widened = agent({ capabilities: ["*"], flows: ["read", "grep"] })
    expect(Agents.profile(widened, { ...body, capabilities: ["fs:read:**"] }, seatOf).envelope).toEqual(["fs:read:**"])
    expect(Agents.profile(widened, body, seatOf).envelope).toEqual([])
  })
  test("renders the body as the system prompt and resolves the declared seat", () => {
    const profile = Agents.profile(agent(), body, seatOf)
    expect(profile).toMatchObject({
      name: "review",
      digest: body.digest,
      seat: "openai:gpt-6-sol",
      thinking: "high",
      flows: ["read", "bash"],
      envelope: ["fs:read:**"]
    })
    expect(profile.system).toStartWith("Review the change.")
    expect(profile.system).toContain("Base directory: /repo/flows/review")
  })
  test("empty flows and capabilities keep the host defaults", () => {
    const profile = Agents.profile(
      agent({ flows: [], capabilities: [], seat: undefined, effort: undefined }),
      body,
      seatOf
    )
    expect(profile.flows).toEqual([])
    expect(profile.envelope).toEqual([])
    expect(profile.seat).toBeUndefined()
    expect(profile.thinking).toBeUndefined()
    // The registry's bare `*` is the host default too.
    expect(Agents.profile(agent({ capabilities: ["*"] }), body, seatOf).envelope).toEqual([])
  })
  test("an unknown seat or effort is a typed failure", () => {
    expect(code(() => Agents.profile(agent({ seat: "gpt-9" }), body, seatOf))).toBe("unknown_seat")
    expect(code(() => Agents.profile(agent({ effort: "extreme" }), body, seatOf))).toBe("unknown_effort")
  })
  test("an unreadable body is a typed, one-line failure", () => {
    const error = Agents.unreadable(new Error("body for flow \"review\" is unavailable\n  at stack"))
    expect(error.code).toBe("unreadable")
    expect(error.message).toBe("body for flow \"review\" is unavailable")
    expect(Agents.unreadable(new Agents.AgentError("unknown_agent", "gone")).code).toBe("unknown_agent")
  })
})

describe("context", () => {
  test("lists model-invocable agents only, at most 20", () => {
    const many = Array.from({ length: 30 }, (_, index) => agent({ name: `a${index}` }))
    expect(JSON.parse(Agents.context(listed))).toEqual([{ name: "review", description: "Reviews the change." }])
    expect(JSON.parse(Agents.context(many))).toHaveLength(20)
  })
})

describe("port.load", () => {
  test("takes launch settings from the descriptor verified with the fresh body", async () => {
    const warm = agent({ flows: ["read", "bash"], capabilities: ["*"] })
    const edited = agent({
      description: "Checks the edited change.",
      seat: "opus",
      effort: "low",
      modelInvocable: false,
      flows: ["read"],
      capabilities: ["fs:read:**"]
    })
    const freshBody = { ...body, descriptor: edited, text: "Check the edited change.", capabilities: ["fs:read:**"] }
    const port = Agents.port({ known: () => [warm], listing: async () => [warm] }, { body: async () => freshBody })
    const loaded = await port.load("review")
    expect(loaded).toEqual({ descriptor: edited, body: freshBody })
    expect(code(() => Agents.find([loaded.descriptor], "review", "agent"))).toBe("not_invocable")
    expect(Agents.profile(loaded.descriptor, loaded.body, seatOf)).toMatchObject({
      seat: "opus",
      thinking: "low",
      flows: ["read"],
      envelope: ["fs:read:**"]
    })
  })

  test("reuses a recent listing and refuses an unknown agent before reading a body", async () => {
    const options: Array<unknown> = []
    const reads: Array<string> = []
    const port = Agents.port({
      known: () => listed,
      listing: async (option) => {
        options.push(option)
        return listed
      }
    }, {
      body: async (name) => {
        reads.push(name)
        return body
      }
    })

    await expect(port.load("missing")).rejects.toMatchObject({ code: "unknown_agent" })
    expect(options).toEqual([{ maxAgeMs: 1000 }])
    expect(reads).toEqual([])
    expect(await port.load("review")).toEqual({ descriptor: listed[0]!, body })
    expect(reads).toEqual(["review"])
  })
})
