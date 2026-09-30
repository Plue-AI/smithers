import { MythicalStackSchema } from "@smthrs/rpc/Mythical"
import { expect, it } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { inspect } from "node:util"
import * as Log from "../src/log.ts"

it("appends private redacted diagnostics without losing earlier failures", () => {
  const previous = process.env.SMITHERS_TUI_SESSION_DIR
  const root = mkdtempSync(join(tmpdir(), "tui-log-"))
  process.env.SMITHERS_TUI_SESSION_DIR = root
  try {
    const token = `ghp_${"x".repeat(36)}`
    const cause = new Error(`missing dependency ${token}`)
    const failure = new Error("refused", { cause })
    cause.cause = failure
    Log.write("discovery", failure)
    Log.write("compaction", "seat unavailable")
    const saved = readFileSync(Log.path(), "utf8")
    const records = saved.trim().split("\n").map((line) => JSON.parse(line))
    expect(records.map((r) => r.tag)).toEqual(["discovery", "compaction"])
    expect(records[0].detail).toContain("Error: refused")
    expect(records[0].detail).toContain("Caused by: Error: missing dependency")
    expect(records[0].detail).toContain("[circular cause]")
    expect(saved.includes(token)).toBe(false)
    expect(statSync(Log.path()).mode & 0o777).toBe(0o600)
  } finally {
    if (previous === undefined) delete process.env.SMITHERS_TUI_SESSION_DIR
    else process.env.SMITHERS_TUI_SESSION_DIR = previous
    rmSync(root, { recursive: true, force: true })
  }
})

it("records a plain failure record by its fields, never as [object Object]", () => {
  const previous = process.env.SMITHERS_TUI_SESSION_DIR
  const root = mkdtempSync(join(tmpdir(), "tui-log-record-"))
  process.env.SMITHERS_TUI_SESSION_DIR = root
  try {
    const cyclic: Record<string, unknown> = { reason: "cyclic" }
    cyclic.self = cyclic
    Log.write("host.memory", { reason: "unreachable", detail: "Jev was unavailable" })
    Log.write("host.memory", cyclic)
    Log.write("worker.retry", { message: "bad key:\nsk-live-0123456789abcdefghij", apiKey: "plain" })
    const [record, loop, secret] = readFileSync(Log.path(), "utf8").trim().split("\n").map((line) => JSON.parse(line))
    expect(record.detail).toBe(`{"reason":"unreachable","detail":"Jev was unavailable"}`)
    expect(loop.detail).toBe(`{"reason":"cyclic","self":"[Circular]"}`)
    expect(secret.detail).not.toContain("sk-live-0123456789abcdefghij")
    expect(secret.detail).not.toContain("plain")
  } finally {
    if (previous === undefined) delete process.env.SMITHERS_TUI_SESSION_DIR
    else process.env.SMITHERS_TUI_SESSION_DIR = previous
    rmSync(root, { recursive: true, force: true })
  }
})

it("records renderer errors while retaining the renderer console sink", () => {
  const previousRoot = process.env.SMITHERS_TUI_SESSION_DIR
  const previousError = console.error
  const root = mkdtempSync(join(tmpdir(), "tui-render-log-"))
  process.env.SMITHERS_TUI_SESSION_DIR = root
  const captured: unknown[][] = []
  console.error = (...values) => {
    captured.push(values)
  }
  const uninstall = Log.install()
  try {
    console.error(new Error("render failed"))
    expect(captured).toHaveLength(1)
    expect(readFileSync(Log.path(), "utf8")).toContain("render failed")
  } finally {
    uninstall()
    console.error = previousError
    if (previousRoot === undefined) delete process.env.SMITHERS_TUI_SESSION_DIR
    else process.env.SMITHERS_TUI_SESSION_DIR = previousRoot
    rmSync(root, { recursive: true, force: true })
  }
})

it("redacts quoted multi-word, inspect-split and any-scheme header credentials in the diagnostic log", () => {
  const previous = process.env.SMITHERS_TUI_SESSION_DIR
  const root = mkdtempSync(join(tmpdir(), "tui-log-"))
  process.env.SMITHERS_TUI_SESSION_DIR = root
  try {
    const secret = "ZqSynthetic7Secret4Value9"
    Log.write("connect", `connect failed: password: 'correct horse ${secret}'`)
    Log.write("inspect", inspect({ privateKey: `${secret}\n`.repeat(8) }))
    Log.write("header", `request failed: Authorization: Token ${secret}`)
    const saved = readFileSync(Log.path(), "utf8")
    const records = saved.trim().split("\n").map((line) => JSON.parse(line))
    for (const record of records) expect(record.detail).toContain("[REDACTED")
    expect(saved.includes(secret)).toBe(false)
    expect(saved.includes("horse")).toBe(false)
  } finally {
    if (previous === undefined) delete process.env.SMITHERS_TUI_SESSION_DIR
    else process.env.SMITHERS_TUI_SESSION_DIR = previous
    rmSync(root, { recursive: true, force: true })
  }
})

it("keeps an error's message when its stack omits it, as a parser error's does", () => {
  const previous = process.env.SMITHERS_TUI_SESSION_DIR
  const root = mkdtempSync(join(tmpdir(), "tui-log-message-"))
  process.env.SMITHERS_TUI_SESSION_DIR = root
  try {
    let parser: unknown
    try {
      MythicalStackSchema.parse({})
    } catch (error) {
      parser = error
    }
    const bare = new Error(`token ghp_${"y".repeat(36)} rejected`)
    bare.stack = "Error\n    at read (cloud.ts:1:1)"
    const wrapped = new Error("stack unreadable", { cause: bare })
    const ordinary = new Error("disk full")
    Log.write("factory.load", parser)
    Log.write("factory.todo", wrapped)
    Log.write("factory.retry", ordinary)
    const saved = readFileSync(Log.path(), "utf8")
    const [parsed, nested, plain] = saved.trim().split("\n").map((line) => JSON.parse(line).detail as string)
    expect(parsed).toStartWith("ZodError: ")
    expect(parsed).toContain("invalid_type")
    expect(nested).toContain("Caused by: Error: token [REDACTED")
    expect(nested).toContain("at read (cloud.ts:1:1)")
    expect(saved.includes("y".repeat(36))).toBe(false)
    // A stack that already names the message is written once, as it was.
    expect(plain).toBe(ordinary.stack!)
  } finally {
    if (previous === undefined) delete process.env.SMITHERS_TUI_SESSION_DIR
    else process.env.SMITHERS_TUI_SESSION_DIR = previous
    rmSync(root, { recursive: true, force: true })
  }
})
