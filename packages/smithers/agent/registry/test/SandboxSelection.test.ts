/**
 * Selecting a sandbox from markdown frontmatter.
 *
 * Discovery is where a sandbox selection is decided: a flow that asked for
 * isolation and is discovered without it would run on the host its author
 * meant to keep it off, so every malformed selection refuses the flow instead
 * of being dropped.
 */
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import * as Descriptor from "../src/Descriptor.ts"
import * as MarkdownFlow from "../src/MarkdownFlow.ts"

const provenance = new Descriptor.Provenance({ source: "test", root: "/flows" })

const fromMarkdown = (text: string) =>
  MarkdownFlow.fromMarkdown({
    text,
    path: "/flows/review/SKILL.md",
    baseDirectory: "/flows/review",
    naming: "frontmatter",
    name: Option.some("review"),
    dirBasename: "review",
    provenance
  })

const skill = (...sandbox: ReadonlyArray<string>) =>
  ["---", "name: review", "description: Review", ...sandbox, "---", "Review it."].join("\n")

const refusal = (result: MarkdownFlow.FromMarkdownResult) => {
  expect(Option.isNone(result.descriptor)).toBe(true)
  const warnings = result.warnings.filter((warning) => warning.code === "invalid_sandbox")
  expect(warnings).toHaveLength(1)
  expect(warnings[0]!.message).toMatch(/; the flow is not discovered$/)
  return warnings[0]!.message
}

describe("sandbox frontmatter", () => {
  it("refuses an unknown sandbox provider during markdown discovery", () => {
    const message = refusal(fromMarkdown(skill("sandbox:", "  provider: definitely-not-a-provider")))
    expect(message).toContain("Unknown sandbox provider \"definitely-not-a-provider\"")
    expect(message).toContain(Descriptor.SandboxProvider.literals.join(", "))
  })

  it("refuses a selection that names no provider", () => {
    expect(refusal(fromMarkdown(skill("sandbox:", "  cpus: 2")))).toContain("Unknown sandbox provider null")
  })

  it.each(Descriptor.SandboxProvider.literals)("accepts the %s provider and places the flow in a sandbox", (name) => {
    const result = fromMarkdown(skill("sandbox:", `  provider: ${name}`))
    const descriptor = Option.getOrThrow(result.descriptor)
    expect(descriptor.sandbox).toEqual({ provider: name })
    expect(Option.getOrThrow(descriptor.placement)).toBe("sandbox")
    expect(result.warnings.map((warning) => warning.code)).not.toContain("unknown_frontmatter_key")
    expect(result.warnings.map((warning) => warning.code)).not.toContain("invalid_sandbox")
  })

  it("decodes the numeric options YAML reads as strings", () => {
    const result = fromMarkdown(skill(
      "sandbox:",
      "  provider: container",
      "  network: none",
      "  cpus: 2",
      "  memoryMib: 2048",
      "  timeoutSecs: 900"
    ))
    expect(Option.getOrThrow(result.descriptor).sandbox).toStrictEqual({
      provider: "container",
      network: "none",
      cpus: 2,
      memoryMib: 2048,
      timeoutSecs: 900
    })
  })

  it("accepts a fractional cpu share", () => {
    const result = fromMarkdown(skill("sandbox: {provider: microsandbox, cpus: 0.5}"))
    expect(Option.getOrThrow(result.descriptor).sandbox).toEqual({ provider: "microsandbox", cpus: 0.5 })
  })

  it("reads a network allowlist", () => {
    const result = fromMarkdown(skill(
      "sandbox:",
      "  provider: vercel",
      "  network:",
      "    allow: [api.github.com, \"*.npmjs.org\"]"
    ))
    expect(Option.getOrThrow(result.descriptor).sandbox).toEqual({
      provider: "vercel",
      network: { allow: ["api.github.com", "*.npmjs.org"] }
    })
  })

  it.each([
    ["a number", "  network: 3", "sandbox.network must be none or { allow: [hosts] }"],
    ["another mode", "  network: host", "sandbox.network must be none or { allow: [hosts] }"],
    ["an object with an extra key", "  network: {allow: [a.dev], deny: [b.dev]}", "sandbox.network must be none"],
    ["a scalar allow", "  network: {allow: a.dev}", "sandbox.network.allow must be a list of host names"],
    ["an empty host", "  network: {allow: [\"\"]}", "sandbox.network.allow must be a list of host names"],
    ["a nested host", "  network: {allow: [[a.dev]]}", "sandbox.network.allow must be a list of host names"],
    ["a url", "  network: {allow: [\"https://a.dev\"]}", "sandbox.network.allow must be a list of host names"],
    ["a host with a port", "  network: {allow: [\"a.dev:443\"]}", "sandbox.network.allow must be a list of host names"],
    [
      "an overlong host",
      `  network: {allow: [${"a.".repeat(127)}dev]}`,
      "sandbox.network.allow must be a list of host names"
    ]
  ])("refuses a network that is %s", (_, line, expected) => {
    expect(refusal(fromMarkdown(skill("sandbox:", "  provider: container", line)))).toContain(expected)
  })

  it.each([
    ["cpus", "0", "sandbox.cpus must be a positive number"],
    ["cpus", "-1", "sandbox.cpus must be a positive number"],
    ["cpus", "two", "sandbox.cpus must be a positive number"],
    ["cpus", "\"\"", "sandbox.cpus must be a positive number"],
    ["cpus", "[2]", "sandbox.cpus must be a positive number"],
    ["memoryMib", "512.5", "sandbox.memoryMib must be a positive whole number"],
    ["memoryMib", "0", "sandbox.memoryMib must be a positive whole number"],
    ["timeoutSecs", "9007199254740993", "sandbox.timeoutSecs must be a positive whole number"],
    ["timeoutSecs", "Infinity", "sandbox.timeoutSecs must be a positive whole number"]
  ])("refuses %s: %s", (key, value, expected) => {
    expect(refusal(fromMarkdown(skill("sandbox:", "  provider: container", `  ${key}: ${value}`)))).toContain(
      expected
    )
  })

  it.each([
    ["a string", "sandbox: container"],
    ["a list", "sandbox: [container]"],
    ["null", "sandbox: null"]
  ])("refuses a selection that is %s", (_, line) => {
    // The failsafe YAML schema reads `null` as the string "null".
    expect(refusal(fromMarkdown(skill(line)))).toContain("sandbox must be an object with a provider")
  })

  it("refuses an unknown selection key instead of dropping a misspelled limit", () => {
    expect(refusal(fromMarkdown(skill("sandbox:", "  provider: container", "  cpu: 2")))).toContain(
      "Unknown frontmatter sandbox key: cpu"
    )
  })

  it.each(["local", "client", "remote", "orbit"])("refuses a selection beside placement %s", (placement) => {
    expect(refusal(fromMarkdown(skill(`placement: ${placement}`, "sandbox: {provider: container}")))).toContain(
      `conflicts with placement "${placement}"`
    )
  })

  it("agrees with an explicit sandbox placement", () => {
    const result = fromMarkdown(skill("placement: sandbox", "sandbox: {provider: kubernetes}"))
    expect(Option.getOrThrow(Option.getOrThrow(result.descriptor).placement)).toBe("sandbox")
  })

  it("leaves a flow that selects no sandbox without one", () => {
    const descriptor = Option.getOrThrow(fromMarkdown(skill()).descriptor)
    expect(descriptor.sandbox).toBeUndefined()
    expect("sandbox" in Schema.encodeSync(Descriptor.FlowDescriptor)(descriptor)).toBe(false)
  })

  it("makes the selection part of the executable identity", () => {
    const small = Option.getOrThrow(fromMarkdown(skill("sandbox: {provider: container, cpus: 1}")).descriptor)
    const large = Option.getOrThrow(fromMarkdown(skill("sandbox: {provider: container, cpus: 4}")).descriptor)
    expect(Descriptor.executionDigest(small)).not.toBe(Descriptor.executionDigest(large))
    expect(Descriptor.declarationDigest(small)).not.toBe(Descriptor.declarationDigest(large))
  })

  it("keys the typed selection itself, not only the frontmatter it came from", () => {
    const descriptor = Option.getOrThrow(fromMarkdown(skill("sandbox: {provider: container}")).descriptor)
    const retargeted = new Descriptor.FlowDescriptor({ ...descriptor, sandbox: { provider: "vercel" } })
    expect(Descriptor.declarationDigest(retargeted)).not.toBe(Descriptor.declarationDigest(descriptor))
    const { sandbox: _sandbox, ...rest } = descriptor
    const unselected = new Descriptor.FlowDescriptor(rest)
    expect(Descriptor.declarationDigest(unselected)).not.toBe(Descriptor.declarationDigest(descriptor))
  })
})
