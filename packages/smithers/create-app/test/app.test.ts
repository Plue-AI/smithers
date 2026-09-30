import * as AgentAction from "@smthrs/agent/AgentAction"
import { Flow as FlowDeclaration } from "@smthrs/flow"
/**
 * Layer constructors keep tagged data; file flows use the canonical authoring API.
 */
import { describe, expect, it } from "@effect/vitest"
import * as Schema from "effect/Schema"
import { defaultCallLimit, defaultDirs, defaultMaxFrames, defineAgent, defineSandbox, defineTools } from "../src/app.ts"

describe("defineAgent", () => {
  it("tags the spec and keeps every declared field", () => {
    const agent = defineAgent({
      seat: "anthropic:claude-sonnet-4-5",
      system: ["You answer questions about the ledger."],
      limits: { calls: 32 },
      maxFrames: 12
    })
    expect(agent).toEqual({
      _tag: "AgentSpec",
      seat: "anthropic:claude-sonnet-4-5",
      system: ["You answer questions about the ledger."],
      limits: { calls: 32 },
      maxFrames: 12
    })
  })

  it("leaves the optional limits absent rather than defaulting them here", () => {
    // The defaults belong to the host that builds the layer, so a spec that
    // declares nothing stays distinguishable from one that declares the
    // default value.
    const agent = defineAgent({ seat: "test:scripted", system: [] })
    expect(agent.limits).toBeUndefined()
    expect(agent.maxFrames).toBeUndefined()
  })
})

describe("defineSandbox", () => {
  it("tags the spec and keeps the declared limits", () => {
    const sandbox = defineSandbox({ limits: { heapBytes: 1024, interruptChecks: 10, wallClockMs: 5 } })
    expect(sandbox).toEqual({ _tag: "SandboxSpec", limits: { heapBytes: 1024, interruptChecks: 10, wallClockMs: 5 } })
  })
})

describe("defineTools", () => {
  it("tags the spec and keeps the sources in declaration order", () => {
    const first = { name: "ledger", flows: [] } as never
    const second = { name: "ui", flows: [] } as never
    expect(defineTools({ sources: [first, second] })).toEqual({
      _tag: "ToolsSpec",
      sources: [first, second],
      grant: []
    })
  })
})

describe("canonical Flow.make", () => {
  it("tags the spec and keeps the prompt callable", () => {
    const flow = FlowDeclaration.make("echo", {
      description: "Answers a question about the ledger.",
      payload: { message: Schema.String },
      success: Schema.Struct({ answer: Schema.String }),
      error: AgentAction.AgentFailure,
      prompt: ({ message }) => message,
      chat: true
    })
    expect(flow._tag).toBe("echo")
    expect(flow.chat).toBe(true)
    expect(flow.prompt({ message: "hello" })).toBe("hello")
  })

  it("declares no chat mode and no extra teaching by default", () => {
    const flow = FlowDeclaration.make("echo", {
      description: "Summarizes a block.",
      payload: { number: Schema.Number },
      success: Schema.Struct({ summary: Schema.String }),
      error: AgentAction.AgentFailure,
      prompt: ({ number }) => `Summarize block ${number}.`
    })
    expect(flow.chat).toBeUndefined()
    expect(flow.system).toBeUndefined()
  })
})

describe("defaults", () => {
  it("names the conventional directory layout and host budgets", () => {
    expect(defaultDirs).toEqual({ app: "app", flows: "flows", tools: "tools" })
    expect(defaultCallLimit).toBe(16)
    expect(defaultMaxFrames).toBe(8)
  })
})

describe("defineTools grant", () => {
  it("defaults to the empty envelope", () => {
    const tools = defineTools({ sources: [] })
    expect(tools.grant).toEqual([])
  })

  it("keeps the all-action grant only when declared", () => {
    const tools = defineTools({ sources: [], grant: [{ action: "*", resource: "*" }] })
    expect(tools.grant).toEqual([{ action: "*", resource: "*" }])
  })

  it("keeps a narrowed grant as declared", () => {
    const tools = defineTools({ sources: [], grant: [{ action: "net:post", resource: "https://example.com/*" }] })
    expect(tools.grant).toEqual([{ action: "net:post", resource: "https://example.com/*" }])
  })
})
