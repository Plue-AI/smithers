import { MythicalStackSchema } from "@smthrs/rpc/Mythical"
import { expect, it } from "bun:test"
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
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

it("preserves missing-stack messages and bounds cause chains and plain records", () => {
  const previous = process.env.SMITHERS_TUI_SESSION_DIR
  const root = mkdtempSync(join(tmpdir(), "tui-log-bounds-"))
  process.env.SMITHERS_TUI_SESSION_DIR = root
  try {
    const absent = new Error("no stack available")
    delete absent.stack
    const empty = new Error("empty stack available")
    empty.stack = ""
    let chain = new Error("outside retained chain")
    for (let index = 15; index >= 0; index--) {
      chain = new Error(`retained ${index}`, { cause: chain })
      delete chain.stack
    }
    Log.write("absent", absent)
    Log.write("empty", empty)
    Log.write("chain", chain)
    Log.write("bounded", { payload: "x".repeat(80_000) })
    Log.write(
      "unreadable",
      new Proxy({ toString: () => "unreadable record" }, {
        ownKeys: () => {
          throw new Error("record inspection refused")
        }
      })
    )
    const [noStack, emptyStack, boundedChain, boundedRecord, unreadable] = readFileSync(Log.path(), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line).detail as string)
    expect(noStack).toBe("Error: no stack available")
    expect(emptyStack).toBe("Error: empty stack available")
    expect(boundedChain).toStartWith("Error: retained 0")
    expect(boundedChain).toContain("Error: retained 15")
    expect(boundedChain).toEndWith("Caused by: [cause chain truncated]")
    expect(boundedChain).not.toContain("outside retained chain")
    if (boundedChain === undefined) throw new Error("Cause-chain record missing")
    expect(boundedChain.match(/Caused by:/g)).toHaveLength(16)
    expect(boundedRecord).toHaveLength(64_000)
    expect(unreadable).toBe("unreadable record")
  } finally {
    if (previous === undefined) delete process.env.SMITHERS_TUI_SESSION_DIR
    else process.env.SMITHERS_TUI_SESSION_DIR = previous
    rmSync(root, { recursive: true, force: true })
  }
})

it("notifies mounted listeners, removes its process hooks and retains another console owner's sink", () => {
  const previous = process.env.SMITHERS_TUI_SESSION_DIR
  const previousError = console.error
  const root = mkdtempSync(join(tmpdir(), "tui-log-listeners-"))
  process.env.SMITHERS_TUI_SESSION_DIR = root
  const events: string[] = []
  const unsubscribe = Log.subscribe((message) => events.push(message))
  const rejectionBefore = process.listeners("unhandledRejection")
  const exceptionBefore = process.listeners("uncaughtExceptionMonitor")
  const uninstall = Log.install()
  try {
    Log.alert("visible", "Cloud unavailable")
    const rejection = process.listeners("unhandledRejection").filter((listener) => !rejectionBefore.includes(listener))
    const exception = process.listeners("uncaughtExceptionMonitor").filter((listener) =>
      !exceptionBefore.includes(listener)
    )
    expect(rejection).toHaveLength(1)
    expect(exception).toHaveLength(1)
    // Invoke only our actual registered hooks: emitting globally would signal Bun's test runner too.
    rejection[0]!(new Error("connection rejected"), Promise.resolve())
    exception[0]!(new Error("renderer crashed"), "uncaughtException")
    expect(events).toEqual(["Cloud unavailable", "Terminal service failed", "Terminal service failed"])
    unsubscribe()
    Log.alert("after-unmount", "still recorded")
    expect(events).toHaveLength(3)
    const records = readFileSync(Log.path(), "utf8").trim().split("\n").map((line) => JSON.parse(line))
    expect(records.map((record) => record.tag)).toEqual([
      "visible",
      "unhandled-rejection",
      "uncaught-exception",
      "after-unmount"
    ])
    expect(records[1].detail).toContain("connection rejected")
    expect(records[2].detail).toContain("renderer crashed")
    const replacement = () => {}
    console.error = replacement
    uninstall()
    expect(console.error).toBe(replacement)
    expect(process.listeners("unhandledRejection")).toEqual(rejectionBefore)
    expect(process.listeners("uncaughtExceptionMonitor")).toEqual(exceptionBefore)
  } finally {
    unsubscribe()
    uninstall()
    console.error = previousError
    if (previous === undefined) delete process.env.SMITHERS_TUI_SESSION_DIR
    else process.env.SMITHERS_TUI_SESSION_DIR = previous
    rmSync(root, { recursive: true, force: true })
  }
})

it("repairs old file permissions, keeps private directories and refuses an unwritable filesystem sink harmlessly", () => {
  const previous = process.env.SMITHERS_TUI_SESSION_DIR
  const root = mkdtempSync(join(tmpdir(), "tui-log-filesystem-"))
  process.env.SMITHERS_TUI_SESSION_DIR = join(root, "private")
  try {
    Log.write("first", "original failure")
    expect(statSync(process.env.SMITHERS_TUI_SESSION_DIR).mode & 0o777).toBe(0o700)
    chmodSync(Log.path(), 0o644)
    Log.write("second", "another failure")
    expect(statSync(Log.path()).mode & 0o777).toBe(0o600)
    expect(readFileSync(Log.path(), "utf8").trim().split("\n")).toHaveLength(2)
    const blocked = join(root, "not-a-directory")
    writeFileSync(blocked, "untouched")
    process.env.SMITHERS_TUI_SESSION_DIR = blocked
    expect(() => Log.write("refused", new Error("original request failed"))).not.toThrow()
    expect(readFileSync(blocked, "utf8")).toBe("untouched")
    expect(existsSync(join(blocked, "tui.log"))).toBe(false)
  } finally {
    if (previous === undefined) delete process.env.SMITHERS_TUI_SESSION_DIR
    else process.env.SMITHERS_TUI_SESSION_DIR = previous
    rmSync(root, { recursive: true, force: true })
  }
})

it("keeps the original error and mounted notification when append fails with ENOSPC", () => {
  const root = mkdtempSync(join(tmpdir(), "tui-log-full-disk-"))
  try {
    // A child-local append fault exercises the shared Log path without filling the host disk
    // or mutating Bun's filesystem module for any other test. mkdir/chmod remain real.
    const script = `
      import { mock } from "bun:test";
      import * as fs from "node:fs";
      const actual = { ...fs };
      const writes = [];
      mock.module("node:fs", () => ({ ...actual, appendFileSync(file, line, options) {
        writes.push({ file, record: JSON.parse(line), mode: options.mode });
        throw Object.assign(new Error("no space left"), { code: "ENOSPC" });
      }}));
      const Log = await import(${JSON.stringify(join(import.meta.dir, "../src/log.ts"))});
      const original = new Error("original request failed");
      const messages = [];
      const unsubscribe = Log.subscribe(message => messages.push(message));
      Log.write("original", original);
      Log.alert("visible", "Cloud unavailable");
      unsubscribe();
      console.log(JSON.stringify({ writes, messages, originalMessage: original.message,
        directoryMode: actual.statSync(process.env.SMITHERS_TUI_SESSION_DIR).mode & 0o777,
        logExists: actual.existsSync(Log.path()) }));
    `
    const child = Bun.spawnSync([process.execPath, "-e", script], {
      env: { ...process.env, SMITHERS_TUI_SESSION_DIR: join(root, "private") },
      stdout: "pipe",
      stderr: "pipe"
    })
    expect(child.exitCode).toBe(0)
    const result = JSON.parse(child.stdout.toString())
    expect(result.writes.map((write: { record: { tag: string } }) => write.record.tag)).toEqual(["original", "visible"])
    expect(result.writes.every((write: { mode: number }) => write.mode === 0o600)).toBe(true)
    expect(result.writes[0].record.detail).toContain("Error: original request failed")
    expect(result.originalMessage).toBe("original request failed")
    expect(result.messages).toEqual(["Cloud unavailable"])
    expect(result.directoryMode).toBe(0o700)
    expect(result.logExists).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
