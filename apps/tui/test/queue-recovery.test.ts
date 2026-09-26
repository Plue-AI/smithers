/**
 * Follow-ups and interrupted turns as the session file keeps them (#1982, #1983).
 * Each case writes a real file through `Session.create` and reads it back.
 */
import { expect, it } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Session from "../src/session.ts"

const scratch = () => {
  process.env.SMITHERS_TUI_SESSION_DIR = mkdtempSync(join(tmpdir(), "tui-queue-"))
  return mkdtempSync(join(tmpdir(), "tui-queue-cwd-"))
}
const prompt = (id: string, text: string) => ({ id, text, scope: "chat" })

it("rebuilds the pending follow-ups oldest first, less the ones that left", () => {
  const writer = Session.create(scratch())
  writer.append({ type: "user", at: 1, text: "first" })
  writer.append({ type: "queued", at: 2, prompt: prompt("a", "alpha") })
  writer.append({ type: "queued", at: 3, prompt: prompt("b", "beta") })
  writer.append({ type: "queued", at: 4, prompt: prompt("c", "gamma") })
  writer.append({ type: "queued", at: 4, prompt: prompt("c", "gamma") })
  writer.append({ type: "outcome", at: 5, prompt: "first", outcome: { _tag: "done", answer: "ok" } })
  writer.append({ type: "dequeued", at: 5, id: "a", reason: "started" })
  expect(Session.restore(Session.load(writer.file)).queued.map((each) => each.text)).toEqual(["beta", "gamma"])
  writer.append({ type: "dequeued", at: 6, id: "c", reason: "restored" })
  expect(Session.restore(Session.load(writer.file)).queued.map((each) => each.id)).toEqual(["b"])
})

it("keeps a queued prompt's bytes: they are what its turn sends", () => {
  const writer = Session.create(scratch())
  const secret = "use sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789"
  writer.append({ type: "queued", at: 1, prompt: prompt("a", secret) })
  expect(Session.restore(Session.load(writer.file)).queued[0]!.text).toBe(secret)
})

it("settles a turn with no outcome as interrupted and returns its receipt", () => {
  const writer = Session.create(scratch())
  writer.append({ type: "user", at: 10, text: "first slow turn" })
  writer.append({ type: "event", at: 11, event: { _tag: "model-requested" } } as unknown as Session.Record)
  writer.append({ type: "user", at: 12, text: "steer", steered: true })
  const records = Session.load(writer.file)
  const before = Session.restore(records)
  expect(before.transcript.requestedAt).toBe(11)

  const recovered = Session.recover(records, 20)
  expect(recovered.receipt).toEqual({
    type: "outcome",
    at: 20,
    prompt: "first slow turn",
    outcome: { _tag: "interrupted", headline: "Interrupted" }
  })
  const after = Session.restore(recovered.records)
  expect(after.transcript.requestedAt).toBeUndefined()
  expect(after.transcript.activity?.status).toBe("failed")
  expect(after.transcript.items.at(-1)).toMatchObject({ kind: "error", text: "Interrupted" })
  expect(after.prompts).toEqual(["first slow turn", "steer"])

  // Appended once, the file no longer reads as interrupted.
  writer.append(recovered.receipt!)
  expect(Session.recover(Session.load(writer.file)).receipt).toBeUndefined()
  expect(readFileSync(writer.file, "utf8")).toContain("\"interrupted\"")
})

it("settles an older file's abandoned turn in place, before the turn that followed it", () => {
  const writer = Session.create(scratch())
  writer.append({ type: "user", at: 1, text: "lost turn" })
  writer.append({ type: "event", at: 2, event: { _tag: "model-requested" } } as unknown as Session.Record)
  writer.append({ type: "user", at: 5, text: "next turn" })
  writer.append({ type: "outcome", at: 6, prompt: "next turn", outcome: { _tag: "done", answer: "A" } })
  const recovered = Session.recover(Session.load(writer.file))
  expect(recovered.receipt).toBeUndefined()
  const kinds = recovered.records.flatMap((record) => record.type === "session" ? [] : [record.type])
  expect(kinds).toEqual(["user", "event", "outcome", "user", "outcome"])
  const items = Session.restore(recovered.records).transcript.items
  expect(items.map((item) => item.kind)).toEqual(["user", "error", "user"])
  expect(Session.restore(recovered.records).transcript.past?.[1]?.status).toBe("failed")
})

it("leaves a settled session and a shell-only session alone", () => {
  const writer = Session.create(scratch())
  writer.append({ type: "user", at: 1, text: "q" })
  writer.append({ type: "outcome", at: 2, prompt: "q", outcome: { _tag: "cancelled" } })
  writer.append({
    type: "shell",
    at: 3,
    result: { command: "true", output: "", exitCode: 0, cancelled: false },
    excluded: false
  })
  const records = Session.load(writer.file)
  expect(Session.recover(records)).toEqual({ records })
})

it("a fork never inherits the source's queue", () => {
  const cwd = scratch()
  const source = Session.create(cwd)
  source.append({ type: "user", at: 1, text: "one" })
  source.append({ type: "queued", at: 2, prompt: prompt("a", "later") })
  source.append({ type: "outcome", at: 3, prompt: "one", outcome: { _tag: "done", answer: "A" } })
  source.append({ type: "user", at: 4, text: "two" })
  source.append({ type: "outcome", at: 5, prompt: "two", outcome: { _tag: "done", answer: "B" } })
  const turn = Session.turns(Session.load(source.file))[0]!
  const forked = Session.fork(source.file, cwd, turn)
  if (forked._tag !== "Forked") throw new Error("stale")
  expect(Session.restore(Session.load(forked.writer.file)).queued).toEqual([])
  expect(Session.restore(Session.load(source.file)).queued.map((each) => each.text)).toEqual(["later"])
})
