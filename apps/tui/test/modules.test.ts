import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { Effect } from "effect"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Context from "../src/context.ts"
import * as Editor from "../src/editor.ts"
import * as Replay from "../src/replay.ts"
import * as Session from "../src/session.ts"
import * as Shell from "../src/shell.ts"
import * as Steering from "../src/steering.ts"

let previousSessionDirectory: string | undefined
beforeEach(() => {
  previousSessionDirectory = process.env.SMITHERS_TUI_SESSION_DIR
})
afterEach(() => {
  if (previousSessionDirectory === undefined) delete process.env.SMITHERS_TUI_SESSION_DIR
  else process.env.SMITHERS_TUI_SESSION_DIR = previousSessionDirectory
})

describe("History", () => {
  it("walks back from the newest prompt, returns the draft past the newest, and skips a repeat", () => {
    const history = new Editor.History(["one", "two", "two"])
    expect(history.up("draft")).toBe("two")
    expect(history.up("two")).toBe("one")
    expect(history.up("one")).toBeUndefined()
    expect(history.down()).toBe("two")
    expect(history.down()).toBe("draft")
    expect(history.browsing).toBe(false)
  })

  it("keeps the newest 100 prompts", () => {
    const history = new Editor.History(Array.from({ length: 120 }, (_, index) => `p${index}`))
    let oldest: string | undefined
    for (let step = 0; step < 200; step++) oldest = history.up("") ?? oldest
    expect(oldest).toBe("p20")
  })
})

describe("commands", () => {
  it("parses a command and its argument", () => {
    expect(Editor.parseCommand("/model  gpt 6 ")).toEqual({ name: "model", argument: "gpt 6" })
    expect(Editor.parseCommand("/new")).toEqual({ name: "new", argument: "" })
  })

  it("formats token counts like pi's footer", () => {
    expect([950, 1234, 45_000, 1_234_567].map(Editor.tokens)).toEqual(["950", "1.2k", "45k", "1.2M"])
  })
})

describe("shell", () => {
  it("tells !, !! and prose apart", () => {
    expect(Shell.parse("!ls -la")).toEqual({ command: "ls -la", excluded: false })
    expect(Shell.parse("!! git status")).toEqual({ command: "git status", excluded: true })
    expect(Shell.parse("fix it!")).toBeUndefined()
  })

  it("strips escapes and normalizes carriage returns", () => {
    expect(Shell.clean("\x1b[31mred\x1b[0m\r\nnext\rover")).toBe("red\nnext\nover")
  })

  it("keeps the tail within pi's line limit", () => {
    const text = Array.from({ length: Shell.maxLines + 5 }, (_, index) => `line ${index}`).join("\n")
    const kept = Shell.tail(text)
    expect(kept.truncated).toBe(true)
    expect(kept.text.split("\n")).toHaveLength(Shell.maxLines)
    expect(kept.text.endsWith(`line ${Shell.maxLines + 4}`)).toBe(true)
  })

  it("writes pi's context template", () => {
    expect(Shell.contextText({ command: "ls", output: "a\nb", exitCode: 0, cancelled: false })).toBe(
      "Ran `ls`\n```\na\nb\n```"
    )
    expect(Shell.contextText({ command: "false", output: "", exitCode: 1, cancelled: false })).toBe(
      "Ran `false`\n```\n(no output)\n```\n\nCommand exited with code 1"
    )
    expect(Shell.contextText({ command: "sleep 9", output: "", exitCode: null, cancelled: true })).toContain(
      "(command cancelled)"
    )
  })

  it("runs in the working directory and reports a nonzero exit", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tui-shell-"))
    writeFileSync(join(cwd, "marker"), "")
    const streamed: Array<string> = []
    const result = await Shell.run({ command: "ls; exit 3", cwd, onOutput: (text) => streamed.push(text) }).done
    expect(result).toMatchObject({ output: "marker", exitCode: 3, cancelled: false })
    expect(streamed.join("")).toContain("marker")
  })

  it("cancels the whole process group", async () => {
    const running = Shell.run({ command: "sleep 30", cwd: tmpdir(), onOutput: () => {} })
    setTimeout(running.cancel, 100)
    const started = Date.now()
    const result = await running.done
    expect(result.cancelled).toBe(true)
    expect(Date.now() - started).toBeLessThan(5_000)
  })
})

describe("context", () => {
  it("reads the first instruction file per directory, outermost first, after the global one", () => {
    const home = mkdtempSync(join(tmpdir(), "tui-home-"))
    mkdirSync(join(home, ".smithers", "agent"), { recursive: true })
    writeFileSync(join(home, ".smithers", "agent", "AGENTS.md"), "global")
    const root = mkdtempSync(join(tmpdir(), "tui-context-"))
    const nested = join(root, "a", "b")
    mkdirSync(nested, { recursive: true })
    mkdirSync(join(root, ".git"))
    writeFileSync(join(root, "CLAUDE.md"), "root")
    writeFileSync(join(root, "a", "AGENTS.md"), "a")
    writeFileSync(join(root, "a", "CLAUDE.md"), "shadowed")
    const files = Context.instructionFiles(nested, home)
    expect(files[0]).toBe(join(home, ".smithers", "agent", "AGENTS.md"))
    expect(files.slice(-2)).toEqual([join(root, "CLAUDE.md"), join(root, "a", "AGENTS.md")])
  })

  it("never reads instructions from above the repository root", () => {
    const home = mkdtempSync(join(tmpdir(), "tui-home-"))
    const outside = mkdtempSync(join(tmpdir(), "tui-context-"))
    const repository = join(outside, "repo")
    mkdirSync(join(repository, ".jj"), { recursive: true })
    writeFileSync(join(outside, "AGENTS.md"), "planted")
    writeFileSync(join(repository, "AGENTS.md"), "repo")
    expect(Context.instructionFiles(repository, home)).toEqual([join(repository, "AGENTS.md")])
  })

  it("reads only the working directory outside a repository", () => {
    const home = mkdtempSync(join(tmpdir(), "tui-home-"))
    const outside = mkdtempSync(join(tmpdir(), "tui-context-"))
    const loose = join(outside, "loose")
    mkdirSync(loose)
    writeFileSync(join(outside, "AGENTS.md"), "planted")
    expect(Context.instructionFiles(loose, home)).toEqual([])
    writeFileSync(join(loose, "AGENTS.md"), "here")
    expect(Context.instructionFiles(loose, home)).toEqual([join(loose, "AGENTS.md")])
  })

  it("hands the instruction files to the agent with their text, never inside the host system text", () => {
    const root = mkdtempSync(join(tmpdir(), "tui-instructions-"))
    mkdirSync(join(root, ".git"))
    writeFileSync(join(root, "AGENTS.md"), "- Use pnpm.\n")
    expect(Context.instructions(root).map((file) => file.path)).toEqual([...Context.instructionFiles(root)])
    expect(Context.instructions(root).at(-1)).toEqual({ path: join(root, "AGENTS.md"), text: "- Use pnpm.\n" })
    const system = Context.system(root, []).join("\n")
    expect(system).not.toContain("project_instructions")
    expect(system).not.toContain("Use pnpm")
  })

  it("tells every turn the repository's version control, the nearest repository deciding", () => {
    const root = mkdtempSync(join(tmpdir(), "tui-vcs-"))
    const nested = join(root, "apps", "tui")
    mkdirSync(nested, { recursive: true })
    const told = () => Context.system(nested, []).filter((part) => part.includes(" jj") || part.includes(" git"))
    expect(told()).toEqual([Context.noVcsRule])
    mkdirSync(join(root, ".git"))
    expect(told()).toEqual([Context.gitRule])
    mkdirSync(join(root, ".jj"))
    expect(told()).toEqual([Context.jjRule])
    mkdirSync(join(root, "apps", ".git"))
    expect(Context.vcs(nested)).toBe("git")
  })

  it("tells the next turn about earlier exchanges and shell commands", () => {
    const [, ...rest] = Context.system("/nowhere-at-all", [
      { kind: "exchange", user: "fix it", answer: "fixed" },
      { kind: "shell", text: "Ran `ls`\n```\na\n```" }
    ])
    expect(rest.at(-1)).toContain("User: fix it\nYou answered: fixed")
    expect(rest.at(-1)).toContain("User ran a shell command:\nRan `ls`")
  })
})

describe("steering", () => {
  it("delivers a steer once per boundary and hands back what no boundary took", async () => {
    const queue = Steering.make()
    queue.steer("check the tests")
    const first = await Effect.runPromise(queue.source.drain({ boundary: "b1", wouldIdle: false }))
    const again = await Effect.runPromise(queue.source.drain({ boundary: "b1", wouldIdle: false }))
    expect(first.inserts).toHaveLength(1)
    expect(again).toMatchObject({ duplicate: true })
    expect(again.inserts).toEqual(first.inserts)
    queue.steer("late")
    expect(queue.take()).toEqual(["late"])
    expect(queue.take()).toEqual([])
  })
})

describe("sessions", () => {
  it("rebuilds the screen, the agent's context and the prompt history from the file", () => {
    process.env.SMITHERS_TUI_SESSION_DIR = mkdtempSync(join(tmpdir(), "tui-sessions-"))
    const writer = Session.create("/work/repo")
    const result = { command: "ls", output: "a", exitCode: 0, cancelled: false }
    writer.append({ type: "name", name: "fixing add" })
    writer.append({ type: "user", at: 1, text: "fix add" })
    writer.append({ type: "outcome", at: 2, prompt: "fix add", outcome: { _tag: "done", answer: "fixed" } })
    writer.append({ type: "shell", at: 3, result, excluded: false })
    writer.append({ type: "shell", at: 4, result: { ...result, command: "secret" }, excluded: true })
    const [summary] = Session.list("/work/repo")
    expect(summary).toMatchObject({ file: writer.file, name: "fixing add", firstPrompt: "fix add" })
    const restored = Session.restore(Session.load(writer.file))
    expect(restored.name).toBe("fixing add")
    expect(restored.prompts).toEqual(["fix add", "!ls", "!!secret"])
    expect(restored.entries).toEqual([
      { kind: "exchange", user: "fix add", answer: "fixed" },
      { kind: "shell", text: Shell.contextText(result) }
    ])
    expect(restored.transcript.items.map((item) => item.kind)).toEqual(["user", "shell", "shell"])
  })

  it("restores flow runs, the last record per id winning", () => {
    const run = { id: "r1", flow: "review", by: "user" as const, input: {}, requested: "{}", startedAt: 1 }
    const restored = Session.restore([
      { type: "flow", run: { ...run, status: "requested" } },
      { type: "flow", run: { ...run, id: "r2", status: "done", answer: "ok" } },
      { type: "flow", run: { ...run, status: "running", runId: "run-1" } }
    ])
    expect(restored.flows).toEqual([
      { ...run, status: "running", runId: "run-1" },
      { ...run, id: "r2", status: "done", answer: "ok" }
    ])
  })

  const seeded = () => {
    process.env.SMITHERS_TUI_SESSION_DIR = mkdtempSync(join(tmpdir(), "tui-sessions-"))
    const writer = Session.create("/work/repo")
    const result = { command: "ls", output: "a", exitCode: 0, cancelled: false }
    writer.append({ type: "user", at: 1, text: "first" })
    writer.append({ type: "outcome", at: 2, prompt: "first", outcome: { _tag: "done", answer: "one" } })
    writer.append({ type: "user", at: 3, text: "steer", steered: true })
    writer.append({ type: "shell", at: 4, result, excluded: false })
    writer.append({ type: "user", at: 5, text: "second" })
    writer.append({ type: "outcome", at: 6, prompt: "second", outcome: { _tag: "done", answer: "two" } })
    writer.append({ type: "name", name: "n" })
    writer.append({ type: "user", at: 7, text: "third" })
    const records = Session.load(writer.file)
    const turn = (text: string) => Session.turns(records).find((each) => each.text === text)!
    return { source: writer.file, records, result, turn }
  }

  it("lists fork points newest first, skipping steers and shell commands", () => {
    const { records } = seeded()
    expect(Session.turns(records)).toEqual([
      { index: 8, at: 7, text: "third" },
      { index: 5, at: 5, text: "second" },
      { index: 1, at: 1, text: "first" }
    ])
  })

  it("forks before a turn into a new file with a parent, leaving the source unchanged", () => {
    const { source, records, result, turn } = seeded()
    const before = readFileSync(source, "utf8")
    const forked = Session.fork(source, "/work/repo", turn("second"))
    if (forked._tag !== "Forked") throw new Error(forked._tag)
    expect(forked.text).toBe("second")
    expect(readFileSync(source, "utf8")).toBe(before)
    const [header, ...rest] = Session.load(forked.writer.file)
    expect(header).toMatchObject({ type: "session", parent: source })
    expect(header?.type === "session" && records[0]?.type === "session" && header.id !== records[0].id).toBe(true)
    expect(rest).toEqual(records.slice(1, 5))
    expect(forked.records).toEqual(records.slice(1, 5))
    const restored = Session.restore(Session.load(forked.writer.file))
    expect(restored.entries).toEqual([
      { kind: "exchange", user: "first", answer: "one" },
      { kind: "shell", text: Shell.contextText(result) }
    ])
    expect(restored.prompts).toEqual(["first", "steer", "!ls"])
    expect(Session.list("/work/repo")).toHaveLength(2)
  })

  it("forks before the first turn into an empty session written on the first append", () => {
    const { source, turn } = seeded()
    const forked = Session.fork(source, "/work/repo", turn("first"))
    if (forked._tag !== "Forked") throw new Error(forked._tag)
    expect(forked.records).toEqual([])
    expect(existsSync(forked.writer.file)).toBe(false)
    forked.writer.append({ type: "user", at: 9, text: "again" })
    expect(Session.load(forked.writer.file)[0]).toMatchObject({ type: "session", parent: source })
  })

  it("refuses a turn that no longer matches the file", () => {
    const { source, turn } = seeded()
    expect(Session.fork(source, "/work/repo", { ...turn("second"), at: 999 })).toEqual({ _tag: "Stale" })
    expect(Session.fork(source, "/work/repo", { index: 3, at: 3, text: "steer" })).toEqual({ _tag: "Stale" })
    expect(Session.list("/work/repo")).toHaveLength(1)
  })

  it("leaves no file behind when writing a seeded session fails", () => {
    const base = mkdtempSync(join(tmpdir(), "tui-sessions-"))
    const blocked = join(base, "file")
    writeFileSync(blocked, "")
    process.env.SMITHERS_TUI_SESSION_DIR = blocked
    try {
      expect(() => Session.create("/work/repo", "chat", { seed: [{ type: "name", name: "n" }] })).toThrow()
    } finally {
      process.env.SMITHERS_TUI_SESSION_DIR = base
    }
    expect(readdirSync(base)).toEqual(["file"])
  })
})

describe("replay", () => {
  it("splits a recording into one reply per model call, each ending in its settlement", () => {
    const recorded = readFileSync(join(import.meta.dir, "fixtures", "fix-add.jsonl"), "utf8")
    const replies = Replay.replies(recorded)
    const calls = recorded.trim().split("\n").filter((line) => JSON.parse(line).event._tag === "model-requested").length
    expect(replies).toHaveLength(calls)
    expect(replies.every((reply) => reply.at(-1)?.delta.type === "settle")).toBe(true)
  })
})

describe("context compaction", () => {
  const exchange = (text: string): Context.Entry => ({ kind: "exchange", user: text, answer: text })

  it("drops the oldest entries until the requested tokens are gone, and keeps the newest", () => {
    const history = [exchange("a".repeat(400)), exchange("b".repeat(400)), exchange("c".repeat(400))]
    expect(Context.compactable(history, 1)).toBe(1)
    expect(Context.compactable(history, 250)).toBe(2)
    expect(Context.compactable(history, 1_000_000)).toBe(2)
    expect(Context.compactable(history.slice(0, 1), 1_000_000)).toBe(0)
    expect(Context.compactable(history, 0)).toBe(0)
  })

  it("sends the model only what a compact record left", () => {
    const records: Array<Session.Record> = [
      { type: "outcome", at: 1, prompt: "first", outcome: { _tag: "done", answer: "one" } },
      { type: "outcome", at: 2, prompt: "second", outcome: { _tag: "done", answer: "two" } },
      { type: "compact", at: 3, dropped: 1 },
      { type: "outcome", at: 4, prompt: "third", outcome: { _tag: "done", answer: "three" } }
    ]
    const { entries } = Session.restore(records)
    expect(entries.map((entry) => entry.kind === "exchange" ? entry.user : "")).toEqual(["second", "third"])
    expect(Context.system("/tmp", entries).join("\n")).not.toContain("User: first")
  })
})
