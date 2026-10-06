import { describe, expect, it } from "vitest"
import * as Audience from "../src/Audience.ts"

const terminal = { stdin: true, stdout: true, stderr: true }
describe("consumer detection", () => {
  it.each(Audience.markers)("detects $harness in a PTY through $variable", (marker) => {
    const policy = Audience.resolve({ ...terminal, env: { [marker.variable]: marker.equals ?? "session-123" } })
    expect(policy).toMatchObject({ audience: "agent", progress: "silent", interactive: false, structured: true })
    expect(policy.harnesses).toContain(marker.harness)
    expect(JSON.stringify(policy)).not.toContain("session-123")
  })
  it("never treats credentials, config directories or editor terminals as harness evidence", () => {
    expect(
      Audience.resolve({
        ...terminal,
        env: {
          OPENAI_API_KEY: "secret",
          GEMINI_API_KEY: "secret",
          CODEX_HOME: "/tmp",
          CLAUDE_CONFIG_DIR: "/tmp",
          TERM_PROGRAM: "vscode",
          CURSOR_TRACE_ID: "editor"
        }
      })
    ).toMatchObject({
      audience: "human",
      harnesses: [],
      progress: "live",
      structured: false
    })
  })
  it.each(["", " ", "0", "false", "FALSE", "no", "off"])("ignores disabled marker values: %j", (value) => {
    const env = Object.fromEntries(Audience.markers.map((marker) => [marker.variable, value]))
    expect(Audience.resolve({ ...terminal, env })).toMatchObject({
      audience: "human",
      source: "terminal",
      harnesses: []
    })
  })
  it("does not mistake human shells or unverified product settings for agent execution", () => {
    const env = {
      AGENT: "monitoring-daemon",
      OPENCLAW_SHELL: "tui-local",
      OPENCLAW_CLI: "1",
      AMP_THREAD_ID: "portal-service",
      AIDER_MODEL: "local",
      FACTORY_API_KEY: "secret",
      DROID: "1",
      KIRO_HOME: "/tmp/kiro",
      ANTIGRAVITY_AGENT: "1",
      WINDSURF_SESSION_ID: "editor-session",
      PI_CODING_AGENT_DIR: "/tmp/pi"
    }
    expect(Audience.resolve({ ...terminal, env })).toMatchObject({
      audience: "human",
      source: "terminal",
      harnesses: []
    })
  })
  it("records all nested harnesses once without leaking or changing the environment", () => {
    const env = Object.freeze({
      CLAUDECODE: "1",
      CODEX_THREAD_ID: "private-thread",
      CODEX_SESSION_ID: "private-session",
      GOOSE_TERMINAL: "1",
      AGENT: "goose",
      OPENAI_API_KEY: "private-credential"
    })
    const before = JSON.stringify(env)
    const policy = Audience.resolve({ ...terminal, env })
    expect(policy.harnesses).toEqual(["claude-code", "codex", "goose"])
    expect(JSON.stringify(policy)).not.toContain("private-")
    expect(JSON.stringify(env)).toBe(before)
  })
  it("allows overrides but never a human MCP transport", () => {
    expect(Audience.resolve({ ...terminal, audience: "human", env: { CLAUDECODE: "1" } }).audience).toBe("human")
    expect(Audience.resolve({ ...terminal, audience: "human", mcp: true, env: {} })).toMatchObject({
      audience: "agent",
      progress: "silent"
    })
    expect(Audience.resolve({ ...terminal, env: { SMITHERS_AUDIENCE: "agent" } }).audience).toBe("agent")
    expect(Audience.resolve({ ...terminal, env: { SMITHERS_AUDIENCE: "human", CLAUDECODE: "1" } })).toMatchObject({
      audience: "human",
      source: "override",
      progress: "live"
    })
    expect(Audience.resolve({ ...terminal, audience: "agent", env: { SMITHERS_AUDIENCE: "human" } })).toMatchObject({
      audience: "agent",
      source: "override",
      progress: "silent"
    })
    expect(() => Audience.resolve({ env: { SMITHERS_AUDIENCE: "typo" } })).toThrow("SMITHERS_AUDIENCE")
  })
  it("keeps human progress separate from machine-readable redirected results", () => {
    expect(Audience.resolve({ ...terminal, stdout: false, env: {} })).toMatchObject({
      audience: "human",
      structured: true,
      progress: "live"
    })
    expect(Audience.resolve({ ...terminal, formatExplicit: true, env: {} })).toMatchObject({
      audience: "human",
      structured: true,
      progress: "live"
    })
    expect(Audience.resolve({ ...terminal, silent: true, env: {} }).progress).toBe("silent")
  })
  it("handles CI booleans and non-animated terminals", () => {
    expect(Audience.resolve({ ...terminal, env: { CI: "false" } }).audience).toBe("human")
    expect(Audience.resolve({ ...terminal, env: { CI: "1" } }).audience).toBe("agent")
    expect(Audience.resolve({ ...terminal, env: { TERM: "dumb" } }).progress).toBe("plain")
    expect(Audience.resolve({ stdin: false, stdout: false, stderr: false, env: {} })).toMatchObject({
      audience: "agent",
      source: "pipe"
    })
    expect(Audience.resolve({ ...terminal, verbose: true, env: { CLAUDECODE: "1" } })).toMatchObject({
      progress: "plain",
      interactive: false
    })
  })
  it("normalizes format without overriding explicit formats or application arguments", () => {
    const policy = Audience.fromArguments(["--audience", "agent"], { ...terminal, env: {} })
    expect(Audience.incurArguments(["flow", "list"], policy)).toEqual(["--format", "toon", "flow", "list"])
    expect(Audience.incurArguments(["runs", "logs", "id"], policy)).toEqual(["--format", "jsonl", "runs", "logs", "id"])
    expect(Audience.incurArguments(["runs", "logs", "id", "--follow"], policy)).toEqual([
      "--format",
      "jsonl",
      "runs",
      "logs",
      "id",
      "--follow"
    ])
    expect(Audience.incurArguments(["runs", "logs", "id", "--format=jsonl"], policy)).toEqual([
      "runs",
      "logs",
      "id",
      "--format=jsonl"
    ])
    expect(Audience.fromArguments(["--", "--silent", "--audience", "agent"], { ...terminal, env: {} }).audience).toBe(
      "human"
    )
    expect(Audience.fromArguments(["--audience=agent", "--verbose", "--silent"], { ...terminal, env: {} }).progress)
      .toBe("silent")
    expect(Audience.incurArguments(["--help"], policy)).toEqual(["--help"])
  })
})

it("honors the executable's authoritative MCP selection instead of reinterpreting opaque words", () => {
  expect(Audience.fromArguments(["--mcp"], { env: {}, stdout: false, stderr: false, mcp: false }).source).toBe("pipe")
  expect(Audience.fromArguments([], { env: {}, mcp: true }).source).toBe("mcp")
  expect(Audience.fromArguments(["--mcp"], { env: {}, stdout: false, stderr: false }).source).toBe("mcp")
})
