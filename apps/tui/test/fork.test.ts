import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type * as Host from "../src/host.ts"
import * as Palette from "../src/palette.ts"
import * as Session from "../src/session.ts"
import { type Tab, Workspace } from "../src/workspace.ts"

let previousSessionDirectory: string | undefined
beforeEach(() => {
  previousSessionDirectory = process.env.SMITHERS_TUI_SESSION_DIR
})
afterEach(() => {
  if (previousSessionDirectory === undefined) delete process.env.SMITHERS_TUI_SESSION_DIR
  else process.env.SMITHERS_TUI_SESSION_DIR = previousSessionDirectory
})

const host: Host.Host = {
  cwd: "/work/repo",
  judged: false,
  dispose: async () => {},
  run: () => ({ done: new Promise(() => {}), cancel: () => {} })
}

/**
 * A chat session whose worker tab was saved as `status` before a second user turn.
 * With `settled`, the worker failed and the chat recorded that after the second turn.
 */
const session = (status: Tab["status"], settled?: string) => {
  process.env.SMITHERS_TUI_SESSION_DIR = mkdtempSync(join(tmpdir(), "tui-sessions-"))
  const worker = Session.create(host.cwd, "worker")
  worker.append({
    type: "outcome",
    at: 2,
    prompt: "fix",
    outcome: settled === undefined ? { _tag: "done", answer: "fixed" } : { _tag: "failed", message: settled }
  })
  const chat = Session.create(host.cwd)
  const tab: Tab = {
    id: "fix",
    title: "Fix",
    prompt: "fix",
    seat: "worker:test",
    file: worker.file,
    status,
    startedAt: 1,
    depth: 0
  }
  chat.append({ type: "user", at: 1, text: "delegate" })
  chat.append({ type: "tab", tab })
  chat.append({ type: "user", at: 3, text: "next" })
  if (settled !== undefined) {
    chat.append({ type: "tab", tab: { ...tab, status: "failed", message: settled, endedAt: 4 } })
  }
  const turn = Session.turns(Session.load(chat.file)).find((each) => each.text === "next")!
  const forked = Session.fork(chat.file, host.cwd, turn)
  if (forked._tag !== "Forked") throw new Error(forked._tag)
  const workspace = new Workspace({
    host,
    workerSeat: "worker:test",
    history: () => [],
    persist: forked.writer.append,
    restored: Session.restore(forked.records).workspace
  })
  return { chat, worker, forked, workspace }
}

describe("workers across a fork", () => {
  it("undo in a fork writes only its copied worker history", () => {
    const { chat, worker, forked, workspace } = session("done")
    const sourceChat = readFileSync(chat.file, "utf8")
    const sourceWorker = readFileSync(worker.file, "utf8")
    workspace.undone("fix", ["call"], ["a.ts"], 5)
    const file = workspace.snapshot().tabs[0]!.file
    expect(readFileSync(worker.file, "utf8")).toBe(sourceWorker)
    expect(readFileSync(chat.file, "utf8")).toBe(sourceChat)
    expect(file).not.toBe(worker.file)
    expect(Session.load(file).at(-1)).toMatchObject({ type: "undo", calls: ["call"] })
    expect(Session.restore(Session.load(forked.writer.file)).workspace.tabs[0]!.file).toBe(file)
    workspace.dispose()
  })

  it("recovers a running tab from its worker file and records it in the fork, not the source", () => {
    const { chat, forked, workspace } = session("running")
    const before = readFileSync(chat.file, "utf8")
    expect(workspace.read("fix")).toMatchObject({ status: "done", answer: "fixed" })
    expect(readFileSync(chat.file, "utf8")).toBe(before)
    expect(Session.load(forked.writer.file).at(-1)).toMatchObject({ type: "tab", tab: { status: "done" } })
    workspace.dispose()
  })

  it("keeps a worker's failure that settled after the fork point", () => {
    const { forked, workspace } = session("requested", "tests red")
    expect(workspace.read("fix")).toMatchObject({ status: "failed", message: "tests red" })
    expect(Session.load(forked.writer.file).filter((record) => record.type === "tab")).toHaveLength(2)
    workspace.dispose()
  })

  it("retries a failed tab without touching the source chat or its worker file", async () => {
    const { chat, worker, forked, workspace } = session("requested", "tests red")
    const sourceChat = readFileSync(chat.file, "utf8")
    const sourceWorker = readFileSync(worker.file, "utf8")
    workspace.retry("fix")
    await Promise.resolve()
    const file = workspace.snapshot().tabs[0]?.file
    expect(file).not.toBe(worker.file)
    expect(Session.load(forked.writer.file).at(-1)).toMatchObject({ type: "tab", tab: { id: "fix", file } })
    expect(readFileSync(chat.file, "utf8")).toBe(sourceChat)
    expect(readFileSync(worker.file, "utf8")).toBe(sourceWorker)
    workspace.dispose()
  })

  it("marks the fork in session rows", () => {
    const { chat, forked, workspace } = session("done")
    const rows = Palette.sessionRows(Session.list(host.cwd), "", Date.now())
    expect(rows.find((row) => row.file === chat.file)?.detail).toBe("just now")
    expect(rows.find((row) => row.file === forked.writer.file)?.detail).toBe("fork · just now")
    workspace.dispose()
  })
})
