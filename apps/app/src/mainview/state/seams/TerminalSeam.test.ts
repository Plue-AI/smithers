import { expect, test } from "bun:test"
import { createTerminalBinding, terminalModel } from "./TerminalSeam"
import type { CloudTerminalClient } from "../CloudTerminalClient"
const person = { kind: "person", login: "ben", name: "Ben", avatar_url: "https://github.com/ben.png", color_index: 0 }
const metadata = { terminals: [{ id: "term-1", title: "Shell", owner: person, agents: [], watchers: [], frozen: false }], rebase: undefined }
test("owner derives from authenticated identity; shared permission cannot grant input", () => {
  expect(terminalModel({ ...metadata, viewer_is_owner: true }, "b1", "term-1", "alice")?.viewer_is_owner).toBe(false)
  expect(terminalModel(metadata, "b1", "term-1", "ben")?.viewer_is_owner).toBe(true)
  expect(terminalModel(metadata, "b1", "term-1", undefined)).toBeUndefined()
  expect(terminalModel({ terminals: [{ ...metadata.terminals[0], owner: { kind: "agent", id: "app-ben", agent: "smithers", avatar_url: "https://github.com/a.png", color_index: 0, for_member: person } }] }, "b1", "term-1", "ben")?.viewer_is_owner).toBe(true)
  expect(terminalModel({ terminals: [{ ...metadata.terminals[0], owner: { kind: "agent", id: "coding", agent: "coding", avatar_url: "https://github.com/a.png", color_index: 0, for_member: person } }] }, "b1", "term-1", "ben")?.viewer_is_owner).toBe(false)
})
test("raw keys and geometry go only to the current owner; revocation and freeze stop existing callbacks", () => {
  const calls: unknown[] = []
  let data = metadata
  let viewer: string | undefined = "ben"
  const client = { dispose: () => {}, attach: (_repo, _id, attachment) => { attachment.onOutput("replay\r\n"); attachment.onOutput("live\r\n"); return () => calls.push("detach") }, input: (...args) => calls.push(args), resize: (...args) => calls.push(args) } as CloudTerminalClient
  const binding = createTerminalBinding({ repo: "o/r", branch: "b1", id: "term-1", client, available: () => true, metadata: () => data, viewer: () => viewer })
  const bytes: unknown[] = []
  const stop = binding.stream(value => bytes.push(value))
  expect(bytes).toEqual(["replay\r\n", "live\r\n"])
  binding.input("\x1b[A\x03\r")
  binding.resize({ cols: 80, rows: 24 })
  viewer = "alice"
  binding.input("bad")
  binding.resize({ cols: 1, rows: 1 })
  viewer = "ben"
  data = { ...metadata, terminals: [{ ...metadata.terminals[0], frozen: true }] }
  binding.input("bad")
  viewer = undefined
  expect(binding.stream(() => { throw new Error("must not attach") })).toBeUndefined()
  stop?.()
  expect(calls).toEqual([["term-1", "\x1b[A\x03\r"], ["term-1", 80, 24], "detach"])
})
test("missing provider or malformed metadata never attaches or writes", () => {
  const client = { attach: () => { throw new Error("attach") }, input: () => { throw new Error("input") }, resize: () => { throw new Error("resize") } } as unknown as CloudTerminalClient
  for (const options of [{ available: () => false, metadata: () => metadata }, { available: () => true, metadata: () => ({ terminals: [{}] }) }]) {
    const binding = createTerminalBinding({ repo: "o/r", branch: "b1", id: "term-1", client, viewer: () => "ben", ...options })
    expect(binding.stream(() => {})).toBeUndefined()
    binding.input("bad"); binding.resize({ cols: 80, rows: 24 })
  }
})
