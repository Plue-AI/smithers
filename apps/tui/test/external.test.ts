import { describe, expect, it } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as External from "../src/external.ts"

describe("external editor", () => {
  it("passes the file safely under a path with spaces, keeps editor arguments, and removes the file", async () => {
    const parent = join(mkdtempSync(join(tmpdir(), "tui-editor-")), "with space")
    mkdirSync(parent)
    expect(await External.edit("draft", "printf 'edited\\n' >", parent)).toBe("edited")
    expect(readdirSync(parent)).toEqual([])
  })

  it("keeps the draft when the editor fails, and still removes the file", async () => {
    const parent = mkdtempSync(join(tmpdir(), "tui-editor-"))
    expect(await External.edit("draft", "false", parent)).toBeUndefined()
    expect(readdirSync(parent)).toEqual([])
    expect(existsSync(parent)).toBe(true)
  })
})

describe("bounded quit", () => {
  it("returns when the work settles", async () => {
    const started = Date.now()
    await External.bounded(Promise.resolve(), 5_000)
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it("returns after the bound when the work hangs", async () => {
    const started = Date.now()
    await External.bounded(new Promise(() => {}), 100)
    expect(Date.now() - started).toBeGreaterThanOrEqual(90)
  })

  it("returns when the work rejects", async () => {
    await External.bounded(Promise.reject(new Error("dispose failed")), 5_000)
  })
})

it("keeps the event loop responsive while the external editor is open", async () => {
  let progressed = false
  const timer = setTimeout(() => {
    progressed = true
  }, 10)
  try {
    await External.edit("draft", "sleep 0.2; printf edited >")
    expect(progressed).toBe(true)
  } finally {
    clearTimeout(timer)
  }
})
