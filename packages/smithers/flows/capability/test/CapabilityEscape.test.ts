import { Option } from "effect"
import { describe, expect, it } from "vitest"
import * as Capability from "../src/Capability.ts"
import { evaluate, Rule } from "../src/Permission.ts"

const write = (resource: string): Capability.Capability => Capability.make("fs:write", resource)

describe("Capability.tierOf lexical escape boundaries", () => {
  /**
   * Known limit: lexical classification cannot see symlinks; callers that
   * materialize snapshots must resolve links first.
   */
  it("classifies a lexically-inside symlink escape as compensable without filesystem access", () => {
    const resourceWhoseFirstSegmentIsReallyASymlink = "linked-outside/secret.txt"

    expect(Capability.tierOf(write(resourceWhoseFirstSegmentIsReallyASymlink), { workspaceRoot: "/workspace" }))
      .toBe("compensable")
  })

  it("classifies parent traversal that escapes the workspace as irreversible", () => {
    expect(Capability.tierOf(write("a/../../outside"), { workspaceRoot: "/workspace" })).toBe("irreversible")
  })

  it("keeps POSIX backslashes literal when classifying workspace writes", () => {
    expect(Capability.tierOf(write("/workspace\\evil"), { workspaceRoot: "/workspace" }))
      .toBe("irreversible")
    expect(
      Capability.tierOf(write("/tmp/evil\\..\\..\\workspace\\x"), { workspaceRoot: "/workspace" })
    ).toBe("irreversible")
  })
})

describe("Capability.tierOf foreign-rooted resources", () => {
  it.each([
    ["C:\\Windows\\x"],
    ["c:/Windows/x"],
    ["\\\\host\\share\\x"],
    ["\\Windows\\x"],
    ["a\\..\\..\\x"],
    ["~/.ssh/authorized_keys"]
  ])("classifies %s as irreversible under a POSIX root", (resource) => {
    expect(Capability.tierOf(write(resource), { workspaceRoot: "/w" })).toBe("irreversible")
  })

  it("keeps an ordinary relative resource compensable", () => {
    expect(Capability.tierOf(write("src/a~b.ts"), { workspaceRoot: "/w" })).toBe("compensable")
  })
})

describe("uncanonicalized filesystem resources", () => {
  const grant = Capability.parsePattern("fs:write:/w/**")

  it.each([["/w/../etc/passwd"], ["/w/./x"], ["/w/a/.."], [".."], ["../etc/passwd"], ["src/../../etc"], ["C:/w/../x"], [
    "~/../x"
  ], ["x\\y/../z"]])(
    "no grant selects %s",
    (resource) => {
      expect(Option.isSome(grant)).toBe(true)
      const pattern = Option.getOrThrow(grant)
      expect(Capability.matches(pattern, write(resource))).toBe(false)
      expect(Capability.matches(new Capability.CapabilityPattern({ action: "*", resource: "**" }), write(resource)))
        .toBe(false)
    }
  )

  it("evaluates a dot-segment resource to deny even under an allow rule", () => {
    const allow = new Rule({ effect: "allow", pattern: Option.getOrThrow(grant) })
    expect(evaluate([[allow]], write("/w/../etc/passwd"))).toBe("deny")
    expect(evaluate([[allow]], write("/w/etc/passwd"))).toBe("allow")
  })

  it("does not prove /w/** covers /w/../**", () => {
    const covering = Option.getOrThrow(grant)
    expect(
      Capability.subsumes(covering, new Capability.CapabilityPattern({ action: "fs:write", resource: "/w/../**" }))
    )
      .toBe(false)
    expect(Capability.subsumes(covering, new Capability.CapabilityPattern({ action: "fs:write", resource: "/w/a/**" })))
      .toBe(true)
  })

  it.each([["."], ["./src/./out"], ["src/nested/../out"]])(
    "an allow-all grant selects the declared scope %s",
    (resource) => {
      const all = new Capability.CapabilityPattern({ action: "*", resource: "**" })
      const read = Capability.make("fs:read", resource)
      expect(Capability.matches(all, read)).toBe(true)
      expect(evaluate([[new Rule({ effect: "allow", pattern: all })]], read)).toBe("allow")
      expect(Capability.subsumes(all, new Capability.CapabilityPattern({ action: "fs:read", resource }))).toBe(true)
    }
  )

  it("requires a relative grant to select the normal form as well as the text", () => {
    const src = new Capability.CapabilityPattern({ action: "fs:write", resource: "src/**" })
    expect(Capability.matches(src, write("src/nested/../out"))).toBe(true)
    expect(Capability.matches(src, write("src/a/../../etc/passwd"))).toBe(false)
    expect(
      Capability.subsumes(src, new Capability.CapabilityPattern({ action: "fs:write", resource: "src/a/../../**" }))
    )
      .toBe(false)
    expect(Capability.subsumes(src, new Capability.CapabilityPattern({ action: "fs:write", resource: "src/*/../x" })))
      .toBe(false)
    expect(evaluate([[new Rule({ effect: "allow", pattern: src })]], write("src/../../etc"))).toBe("deny")
  })

  it("leaves dot segments literal for non-filesystem actions", () => {
    const pattern = new Capability.CapabilityPattern({ action: "net:get", resource: "https://h/**" })
    expect(Capability.matches(pattern, Capability.make("net:get", "https://h/a/../b"))).toBe(true)
  })
})
