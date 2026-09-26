import { expect, it, spyOn } from "bun:test"
import * as fs from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Session from "../src/session.ts"

it("lists metadata and picks latest without loading whole session files", () => {
  const prior = process.env.SMITHERS_TUI_SESSION_DIR
  const root = fs.mkdtempSync(join(tmpdir(), "tui-listing-"))
  process.env.SMITHERS_TUI_SESSION_DIR = root
  const writer = Session.create("/repo")
  writer.append({ type: "user", at: 1, text: "First prompt" })
  fs.appendFileSync(writer.file, JSON.stringify({ type: "event", payload: "x".repeat(200_000) }) + "\n")
  writer.append({ type: "name", name: "Latest name" })
  const original = fs.readFileSync
  const reads = spyOn(fs, "readFileSync").mockImplementation(
    ((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      if (file === writer.file) throw new Error("Whole-session read is forbidden in a picker")
      return (original as Function)(file, ...args)
    }) as typeof fs.readFileSync
  )
  try {
    expect(Session.latest("/repo")).toBe(writer.file)
    expect(Session.list("/repo")).toMatchObject([{
      file: writer.file,
      name: "Latest name",
      firstPrompt: "First prompt"
    }])
  } finally {
    reads.mockRestore()
    if (prior === undefined) delete process.env.SMITHERS_TUI_SESSION_DIR
    else process.env.SMITHERS_TUI_SESSION_DIR = prior
    fs.rmSync(root, { recursive: true, force: true })
  }
})
