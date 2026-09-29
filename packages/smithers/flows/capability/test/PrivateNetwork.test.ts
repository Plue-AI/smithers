import { Option } from "effect"
import { describe, expect, it } from "vitest"
import * as Capability from "../src/Capability.ts"
import * as Permission from "../src/Permission.ts"

const privateRequest = (origin: string) => Capability.make("net:private", origin)
const allow = (action: Capability.PatternAction, resource: string) =>
  new Permission.Rule({
    effect: "allow",
    pattern: new Capability.CapabilityPattern({ action, resource })
  })

describe("private network grants", () => {
  it("round trips an origin with scheme and port and classifies it as irreversible", () => {
    const request = privateRequest("http://127.0.0.1:8080")
    expect(Capability.format(request)).toBe("net:private:http://127.0.0.1:8080")
    expect(Option.getOrThrow(Capability.parse(Capability.format(request)))).toEqual(request)
    expect(Option.getOrThrow(Capability.parsePattern(Capability.format(request)))).toEqual(
      new Capability.CapabilityPattern({ action: "net:private", resource: "http://127.0.0.1:8080" })
    )
    expect(Capability.tierOf(request, { workspaceRoot: "/workspace" })).toBe("irreversible")
  })

  it("does not inherit authority from wildcard GET or POST grants", () => {
    const request = privateRequest("http://127.0.0.1:8080")
    expect(Permission.evaluate([[allow("net:get", "*"), allow("net:post", "*")]], request)).toBe("ask")
    expect(Capability.matches(new Capability.CapabilityPattern({ action: "net:get", resource: "*" }), request))
      .toBe(false)
    expect(Capability.matches(new Capability.CapabilityPattern({ action: "net:post", resource: "*" }), request))
      .toBe(false)
  })

  it("requires explicit private action even under broad allow patterns", () => {
    const request = privateRequest("http://127.0.0.1:8080")
    expect(Permission.evaluate([[allow("net:*", "*")]], request)).toBe("ask")
    expect(Permission.evaluate([[allow("*", "**")]], request)).toBe("ask")
    expect(Permission.evaluate([[allow("net:*", "*"), allow("net:private", request.resource)]], request))
      .toBe("allow")
  })

  it("keeps a broad deny in force against an explicit private allow", () => {
    const request = privateRequest("http://127.0.0.1:8080")
    const deny = new Permission.Rule({
      effect: "deny",
      pattern: new Capability.CapabilityPattern({ action: "*", resource: "**" })
    })
    expect(Permission.evaluate([[deny], [allow("net:private", request.resource)]], request)).toBe("deny")
  })

  it("limits an exact private grant to the same origin scheme and port", () => {
    const rules = [[allow("net:private", "http://127.0.0.1:8080")]]
    expect(Permission.evaluate(rules, privateRequest("http://127.0.0.1:8080"))).toBe("allow")
    for (const origin of ["https://127.0.0.1:8080", "http://127.0.0.1:8081", "http://127.0.0.2:8080"]) {
      expect(Permission.evaluate(rules, privateRequest(origin)), origin).toBe("ask")
    }
  })
})
