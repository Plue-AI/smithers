import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { inspect } from "node:util"
import * as Session from "../src/session.ts"

let previousSessionDirectory: string | undefined
beforeEach(() => {
  previousSessionDirectory = process.env.SMITHERS_TUI_SESSION_DIR
})
afterEach(() => {
  if (previousSessionDirectory === undefined) delete process.env.SMITHERS_TUI_SESSION_DIR
  else process.env.SMITHERS_TUI_SESSION_DIR = previousSessionDirectory
})

beforeEach(() => {
  process.env.SMITHERS_TUI_SESSION_DIR = mkdtempSync(join(tmpdir(), "tui-sessions-"))
})

describe("session files", () => {
  it("restores a person's flow run where it was started, as their line and one card, without opening a turn", () => {
    const writer = Session.create("/work/repo")
    const run = {
      id: "sum-1",
      flow: "sum",
      by: "user" as const,
      input: { a: 2, b: 3, unit: "kg" },
      requested: "{}",
      status: "done" as const,
      startedAt: 2,
      answer: "5"
    }
    writer.append({ type: "user", at: 1, text: "hello" })
    writer.append({ type: "outcome", at: 2, prompt: "hello", outcome: { _tag: "done", answer: "hi" } })
    writer.append({ type: "flow", run })
    writer.append({ type: "run", at: 3, surface: "flow:sum-1", title: "sum", request: "/flow sum" })
    writer.append({ type: "run", at: 3, surface: "flow:sum-1", title: "sum", request: "/flow sum" })
    writer.append({ type: "run", at: 4, surface: "flow:key-1", title: "audit" })
    const records = Session.load(writer.file)
    // A flow card is not a prompt: nothing reads as an interrupted turn.
    expect(Session.recover(records).receipt).toBeUndefined()
    const restored = Session.restore(records)
    expect(restored.transcript.items.map((item) => item.kind)).toEqual(["user", "run", "run"])
    expect(restored.transcript.items[1]).toMatchObject({ surface: "flow:sum-1", title: "sum", request: "/flow sum" })
    expect(restored.transcript.items[2]).not.toHaveProperty("request")
    expect(restored.flows).toEqual([run])
    expect(restored.entries).toEqual([{ kind: "exchange", user: "hello", answer: "hi" }])
  })

  it("drops a torn last line instead of failing the load", () => {
    const writer = Session.create("/work/repo")
    writer.append({ type: "user", at: 1, text: "fix add" })
    appendFileSync(writer.file, "{\"type\":\"user\",\"at\":2,\"te")
    expect(Session.load(writer.file).map((record) => record.type)).toEqual(["session", "user"])
  })

  it.each(["", "\n", "\n\n"])("repairs a torn tail before appending after resume (suffix %j)", (suffix) => {
    const writer = Session.create("/work/repo")
    writer.append({ type: "user", at: 1, text: "kept 中文 🦉" })
    appendFileSync(writer.file, "{\"type\":\"user\",\"at\":2,\"te" + suffix)
    expect(Session.load(writer.file)).toHaveLength(2)
    Session.reopen(writer.file).append({ type: "user", at: 3, text: "after resume" })
    expect(Session.load(writer.file).filter((record) => record.type === "user").map((record) => record.text))
      .toEqual(["kept 中文 🦉", "after resume"])
  })

  it("repairs a large torn Unicode fragment across backward-read boundaries without changing complete bytes", () => {
    const writer = Session.create("/work/repo")
    writer.append({ type: "user", at: 1, text: "kept 中文 🦉".repeat(10_000) })
    const before = readFileSync(writer.file)
    const torn = Buffer.from("{\"type\":\"user\",\"text\":\"" + "中文 🦉".repeat(15_000))
    appendFileSync(writer.file, torn.subarray(0, torn.length - 2))
    Session.reopen(writer.file).append({ type: "name", name: "recovered" })
    expect(readFileSync(writer.file).subarray(0, before.length).equals(before)).toBe(true)
    expect(Session.load(writer.file).at(-1)).toEqual({ type: "name", name: "recovered" })
  })

  it("separates a complete final record without a newline before appending", () => {
    const writer = Session.create("/work/repo")
    writer.append({ type: "user", at: 1, text: "complete 🦉" })
    writeFileSync(writer.file, readFileSync(writer.file, "utf8").trimEnd())
    Session.reopen(writer.file).append({ type: "user", at: 2, text: "next" })
    expect(Session.load(writer.file).filter((record) => record.type === "user").map((record) => record.text))
      .toEqual(["complete 🦉", "next"])
  })

  it("refuses a record damaged before the last line with its line number", () => {
    const writer = Session.create("/work/repo")
    writer.append({ type: "user", at: 1, text: "one" })
    appendFileSync(writer.file, "{oops\n")
    writer.append({ type: "user", at: 2, text: "two" })
    expect(() => Session.load(writer.file)).toThrow(/line 3/)
  })

  it("quarantines a damaged file so the listing moves on", () => {
    const damaged = Session.create("/work/repo")
    damaged.append({ type: "user", at: 1, text: "one" })
    appendFileSync(damaged.file, "{oops\n")
    damaged.append({ type: "user", at: 2, text: "two" })
    const error = (() => {
      try {
        Session.load(damaged.file)
      } catch (error) {
        return error
      }
    })()
    expect(Session.quarantine(damaged.file, error)).toContain(".damaged")
    expect(existsSync(damaged.file)).toBe(false)
    expect(Session.list("/work/repo")).toEqual([])
  })

  it("lists every other session when one holds garbage", () => {
    const good = Session.create("/work/repo")
    good.append({ type: "user", at: 1, text: "good" })
    const folder = Session.directory("/work/repo")
    writeFileSync(join(folder, "bad.jsonl"), "\u0000garbage\n{nope")
    expect(Session.list("/work/repo").map((row) => row.firstPrompt)).toContain("good")
  })

  it("keeps distinct paths whose slugs match in distinct folders", () => {
    expect(Session.directory("/tmp/foo-bar")).not.toBe(Session.directory("/tmp/foo/bar"))
    Session.create("/tmp/foo-bar").append({ type: "user", at: 1, text: "dash" })
    Session.create("/tmp/foo/bar").append({ type: "user", at: 1, text: "slash" })
    expect(Session.list("/tmp/foo-bar").map((row) => row.firstPrompt)).toEqual(["dash"])
    expect(Session.list("/tmp/foo/bar").map((row) => row.firstPrompt)).toEqual(["slash"])
  })

  it.each(["nested-project-", "项目👩🏽‍💻-"])(
    "saves long %s paths without exceeding a filesystem component",
    (part) => {
      const cwd = "/work/" + part.repeat(40) + "/repo"
      const other = cwd + "-other"
      expect(Buffer.byteLength(basename(Session.directory(cwd)))).toBeLessThanOrEqual(255)
      expect(Session.directory(cwd)).not.toBe(Session.directory(other))
      const chat = Session.create(cwd)
      chat.append({ type: "user", at: 1, text: "saved in a deep project" })
      const worker = Session.create(cwd, "worker")
      worker.append({ type: "user", at: 2, text: "worker saved too" })
      expect(Session.latest(cwd)).toBe(chat.file)
      expect(Session.list(cwd).map((row) => row.firstPrompt)).toEqual(["saved in a deep project"])
      expect(Session.load(worker.file).at(-1)).toMatchObject({ text: "worker saved too" })
      expect(Session.list(other)).toEqual([])
    }
  )

  it("still lists a session in the pre-hash folder when its header names this cwd", () => {
    const legacy = join(process.env.SMITHERS_TUI_SESSION_DIR!, "--tmp-foo-bar--")
    mkdirSync(legacy, { recursive: true })
    const line = (record: Session.Record) => JSON.stringify(record) + "\n"
    const header = (cwd: string): Session.Record => ({ type: "session", version: 1, id: cwd, cwd, createdAt: 1 })
    writeFileSync(join(legacy, "a.jsonl"), line(header("/tmp/foo-bar")) + line({ type: "user", at: 1, text: "mine" }))
    writeFileSync(join(legacy, "b.jsonl"), line(header("/tmp/foo/bar")) + line({ type: "user", at: 1, text: "other" }))
    expect(Session.list("/tmp/foo-bar").map((row) => row.firstPrompt)).toEqual(["mine"])
    expect(Session.list("/tmp/foo/bar").map((row) => row.firstPrompt)).toEqual(["other"])
  })

  it.skipIf(process.platform !== "darwin")(
    "finds an existing APFS Unicode folder whose name exceeds Linux's byte limit",
    () => {
      const cwd = "/" + "项".repeat(100)
      const oldFolder = join(
        process.env.SMITHERS_TUI_SESSION_DIR!,
        `--${cwd.slice(1)}--${createHash("sha256").update(cwd).digest("hex").slice(0, 12)}`
      )
      mkdirSync(oldFolder)
      const file = join(oldFolder, "old.jsonl")
      writeFileSync(
        file,
        JSON.stringify({ type: "session", version: 1, id: "old", cwd, createdAt: 1 }) + "\n" +
          JSON.stringify({ type: "user", at: 1, text: "before bounding" }) + "\n"
      )
      expect(Session.list(cwd).map((row) => row.firstPrompt)).toEqual(["before bounding"])
      expect(Session.latest(cwd)).toBe(file)
    }
  )

  it("writes owner-only folders and files, repairing a reopened file", () => {
    const writer = Session.create("/work/repo", "worker")
    writer.append({ type: "user", at: 1, text: "secret" })
    expect(statSync(writer.file).mode & 0o777).toBe(0o600)
    expect(statSync(Session.directory("/work/repo")).mode & 0o777).toBe(0o700)
    expect(statSync(join(Session.directory("/work/repo"), "workers")).mode & 0o777).toBe(0o700)
    const loose = join(Session.directory("/work/repo"), "loose.jsonl")
    writeFileSync(loose, "", { mode: 0o644 })
    Session.reopen(loose).append({ type: "name", name: "n" })
    expect(statSync(loose).mode & 0o777).toBe(0o600)
  })

  it("names a session from its last name record and its first prompt", () => {
    const writer = Session.create("/work/repo")
    writer.append({ type: "name", name: "first name" })
    writer.append({ type: "user", at: 1, text: "one" })
    writer.append({ type: "user", at: 2, text: "two" })
    writer.append({ type: "name", name: "second name" })
    expect(Session.list("/work/repo")).toMatchObject([{ name: "second name", firstPrompt: "one" }])
  })
})

describe("Session.guarded", () => {
  it("repairs a partial failed write before saving the next record", () => {
    const writer = Session.create("/work/repo")
    writer.append({ type: "user", at: 1, text: "before full disk" })
    let fail = true
    const reports: Array<Session.WriteFailed> = []
    const guarded = Session.guarded({
      file: writer.file,
      append: (record) => {
        if (fail) {
          fail = false
          appendFileSync(writer.file, "{\"type\":\"user\",\"text\":\"partial")
          throw new Error("ENOSPC: no space left on device")
        }
        writer.append(record)
      }
    }, (failure) => reports.push(failure))
    guarded.append({ type: "user", at: 2, text: "failed write" })
    guarded.append({ type: "user", at: 3, text: "after recovery" })
    expect(reports).toHaveLength(1)
    expect(Session.load(writer.file).filter((record) => record.type === "user").map((record) => record.text))
      .toEqual(["before full disk", "after recovery"])
  })

  it("reports the first refused write of each run of failures instead of throwing, and keeps saving once the disk accepts again", () => {
    const file = join(mkdtempSync(join(tmpdir(), "tui-session-")), "chat.jsonl")
    writeFileSync(file, "")
    const reports: Array<Session.WriteFailed> = []
    const writer = Session.guarded(Session.reopen(file), (failure) => reports.push(failure))
    const record = (text: string): Session.Record => ({ type: "user", at: 1, text })

    writer.append(record("saved"))
    chmodSync(file, 0o444)
    expect(() => writer.append(record("refused"))).not.toThrow()
    writer.append(record("refused again"))
    expect(reports).toEqual([{ _tag: "SessionWriteFailed", file, message: expect.stringContaining("EACCES") }])

    chmodSync(file, 0o600)
    writer.append(record("saved again"))
    chmodSync(file, 0o444)
    writer.append(record("refused after recovery"))
    expect(reports).toHaveLength(2)
    expect(Session.load(file).map((each) => (each.type === "user" ? each.text : each.type))).toEqual([
      "saved",
      "saved again"
    ])
  })
})

describe("credentials in a saved session", () => {
  const key = "sk-ant-api03-Qx7Lm2Vb9Tz4Rk8Wp1Ns6Hd3"
  const pat = "ghp_R4nD0mT0k3nV4lu3F0rT3st1ngPurp0s3s12"
  const pem =
    "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ\n-----END OPENSSH PRIVATE KEY-----"
  const identity = { session: "tui-1-0", frame: 1, cell: "c", ordinal: 0, declaration: "d", layers: [] }
  const records: ReadonlyArray<Session.Record> = [
    { type: "user", at: 1, text: "why does auth fail" },
    {
      type: "shell",
      at: 2,
      excluded: false,
      result: {
        command: "cat ~/.config/gh/hosts.yml",
        output: `github.com:\n  oauth_token: ${pat}\n`,
        exitCode: 0,
        cancelled: false
      }
    },
    {
      type: "event",
      at: 3,
      event: {
        _tag: "cell-call-started",
        call: { flowName: "read", input: { path: "~/.ssh/id_ed25519" }, identity }
      } as never
    },
    {
      type: "event",
      at: 4,
      event: {
        _tag: "cell-call-settled",
        flowName: "read",
        identity,
        result: { outcome: "success", value: { content: pem } }
      } as never
    },
    { type: "event", at: 5, event: { _tag: "cell-printed", cell: "c", text: `ANTHROPIC_API_KEY=${key}\n` } as never },
    {
      type: "outcome",
      at: 6,
      prompt: "why does auth fail",
      outcome: { _tag: "done", answer: `Your token ${pat} is expired.` }
    }
  ]

  for (const kind of ["chat", "worker"] as const) {
    it(`a ${kind} file holds no credential the shell or a harness call surfaced, and still restores`, () => {
      const writer = Session.create(mkdtempSync(join(tmpdir(), "tui-cwd-")), kind)
      for (const record of records) writer.append(record)

      const saved = readFileSync(writer.file, "utf8")
      for (const secret of [key, pat, "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ"]) expect(saved).not.toContain(secret)

      const restored = Session.restore(Session.load(writer.file))
      expect(restored.prompts).toEqual(["why does auth fail", "!cat ~/.config/gh/hosts.yml"])
      const shell = restored.transcript.items.find((item) => item.kind === "shell")
      expect(shell).toMatchObject({ output: "github.com:\n  oauth_token: [REDACTED]\n" })
      expect(restored.entries).toContainEqual({
        kind: "exchange",
        user: "why does auth fail",
        answer: "Your token [REDACTED] is expired."
      })
    })
  }

  it("a session file holds no quoted multi-word or inspect-split credential", () => {
    const secret = "ZqSynthetic7Secret4Value9"
    const writer = Session.create(mkdtempSync(join(tmpdir(), "tui-cwd-")), "chat")
    writer.append({ type: "user", at: 1, text: `connect failed: password: 'correct horse ${secret}'` })
    writer.append({ type: "user", at: 2, text: inspect({ privateKey: `${secret}\n`.repeat(8) }) })
    const saved = readFileSync(writer.file, "utf8")
    expect(saved).toContain("[REDACTED")
    expect(saved).not.toContain(secret)
    expect(saved).not.toContain("horse")
  })

  it("a fork of a session saved before redaction copies no credential either", () => {
    const cwd = mkdtempSync(join(tmpdir(), "tui-cwd-"))
    const source = join(mkdtempSync(join(tmpdir(), "tui-old-")), "old.jsonl")
    writeFileSync(
      source,
      [...records, { type: "user", at: 7, text: "next" }].map((record) => JSON.stringify(record)).join("\n") + "\n"
    )
    const [turn] = Session.turns(Session.load(source))
    const forked = Session.fork(source, cwd, turn!)
    if (forked._tag !== "Forked") throw new Error(forked._tag)
    const saved = readFileSync(forked.writer.file, "utf8")
    for (const secret of [key, pat]) expect(saved).not.toContain(secret)
  })

  it("keeps the bytes the TUI re-executes: a patch undo applies, a flow input and a worker prompt retry relaunches, a monitor's source", () => {
    const writer = Session.create(mkdtempSync(join(tmpdir(), "tui-cwd-")))
    const patch: Session.Record = {
      type: "patch",
      receipt: {
        call: "[]",
        patches: [{ path: ".env", patch: `-ANTHROPIC_API_KEY=${key}\n+ANTHROPIC_API_KEY=rotated\n` }]
      }
    }
    const flow: Extract<Session.Record, { type: "flow" }> = {
      type: "flow",
      run: {
        id: "r",
        flow: "deploy",
        by: "user",
        input: { token: pat, message: pat },
        requested: JSON.stringify({ token: pat }),
        status: "failed",
        startedAt: 1,
        message: `401 for ${pat}`
      }
    }
    const tab: Extract<Session.Record, { type: "tab" }> = {
      type: "tab",
      tab: {
        id: "t",
        title: "Rotate",
        prompt: `rotate ${pat}`,
        seat: "s",
        file: "/w.jsonl",
        depth: 1,
        status: "done",
        startedAt: 1,
        answer: `new token ${pat}`
      }
    }
    const monitor: Extract<Session.Record, { type: "monitor" }> = {
      type: "monitor",
      monitor: {
        id: "m",
        title: "Token",
        watch: "the token changes",
        source: { kind: "shell", command: `curl -H 'Authorization: Bearer ${pat}' https://example.com` },
        trigger: { kind: "interval", seconds: 60 },
        status: "active",
        seen: `token=${pat}`,
        updates: 0,
        createdAt: 1
      }
    }
    for (const record of [patch, flow, tab, monitor]) writer.append(record)
    expect(Session.load(writer.file).slice(1)).toEqual([
      patch,
      { ...flow, run: { ...flow.run, message: "401 for [REDACTED]" } },
      { ...tab, tab: { ...tab.tab, answer: "new token [REDACTED]" } },
      { ...monitor, monitor: { ...monitor.monitor, seen: "token=[REDACTED]" } }
    ])
  })

  it("keeps every view's, card's, status item's and key's action and redacts only their shown text (#2645)", () => {
    const operand = `docs/${key}/README.md`
    const flow = { kind: "flow", flow: "open", input: { path: operand } } as const
    const panel = {
      id: `ui-${key}`,
      title: `Title ${pat}`,
      summary: `Summary ${pat}`,
      bind: { tree: `tree-${key}` },
      rows: [
        {
          id: `row-${key}`,
          label: `Row ${pat}`,
          details: [{ kind: "text" as const, text: `detail ${pat}` }],
          action: { label: `Open ${pat}`, action: flow }
        },
        { id: "prompted", label: "Ask", details: [], action: { label: "Ask", prompt: `explain ${operand}` } },
        { id: "control", label: "docs/plain/README.md", details: [] }
      ]
    }
    const shownPanel = {
      ...panel,
      title: "Title [REDACTED]",
      summary: "Summary [REDACTED]",
      rows: [
        {
          ...panel.rows[0]!,
          label: "Row [REDACTED]",
          details: [{ kind: "text" as const, text: "detail [REDACTED]" }],
          action: { label: "Open [REDACTED]", action: flow }
        },
        panel.rows[1]!,
        panel.rows[2]!
      ]
    }
    type Contributed = Extract<Session.Record, { type: "contribution" }>
    const status: Contributed = {
      type: "contribution",
      owner: `runtime:${key}`,
      contribution: { kind: "status", status: { id: `ci-${key}`, text: `CI ${pat}`, action: flow } }
    }
    const keyed: Contributed & { readonly contribution: { readonly kind: "key" } } = {
      type: "contribution",
      owner: "runtime:chat",
      contribution: {
        kind: "key",
        key: { id: "open", key: "alt+o", label: `Open ${pat}`, action: flow, context: "panel" }
      }
    }
    const writer = Session.create(mkdtempSync(join(tmpdir(), "tui-cwd-")))
    const records: ReadonlyArray<Session.Record> = [
      { type: "panel", panel },
      { type: "card", at: 1, panel: { ...panel, id: "card" } },
      status,
      keyed
    ]
    for (const record of records) writer.append(record)
    const loaded = Session.load(writer.file).slice(1)
    expect(loaded).toEqual([
      { type: "panel", panel: shownPanel },
      { type: "card", at: 1, panel: { ...shownPanel, id: "card" } },
      { ...status, contribution: { kind: "status", status: { id: `ci-${key}`, text: "CI [REDACTED]", action: flow } } },
      { ...keyed, contribution: { kind: "key", key: { ...keyed.contribution.key, label: "Open [REDACTED]" } } }
    ])
    const saved = readFileSync(writer.file, "utf8")
    expect(saved).not.toContain(pat)
    expect(saved).toContain(operand)

    // Restored, each surface's action is the one published, byte for byte.
    const restored = Session.restore(loaded)
    expect(restored.workspace.panels.map((each) => each.rows[0]?.action)).toEqual([
      { label: "Open [REDACTED]", action: flow },
      { label: "Open [REDACTED]", action: flow }
    ])
    expect(restored.workspace.cards).toEqual(["card"])
    expect(restored.contributions.map(({ owner, contribution }) => [owner, contribution])).toEqual([
      [`runtime:${key}`, { kind: "status", status: { id: `ci-${key}`, text: "CI [REDACTED]", action: flow } }],
      ["runtime:chat", { ...keyed.contribution, key: { ...keyed.contribution.key, label: "Open [REDACTED]" } }]
    ])
  })
})

const plan = { id: "release", title: "Release plan", summary: "Two steps left.", rows: [] }

it("restores cards in place, runtime status and keys, and a worker's card placement", () => {
  const records: Session.Record[] = [
    { type: "user", at: 1, text: "Plan the release" },
    { type: "card", at: 2, panel: plan },
    {
      type: "contribution",
      owner: "runtime:chat",
      contribution: { kind: "status", status: { id: "ci", text: "CI ◌" } }
    },
    { type: "card", at: 3, panel: { ...plan, summary: "One step left." } },
    {
      type: "contribution",
      owner: "runtime:chat",
      contribution: { kind: "status", status: { id: "ci", text: "CI ✓" } }
    },
    {
      type: "contribution",
      owner: "runtime:fix",
      contribution: {
        kind: "key",
        key: { id: "fix/rerun", key: "alt+c", label: "Rerun", action: { kind: "prompt", prompt: "Rerun" } }
      }
    },
    { type: "panel", panel: { ...plan, id: "fix/plan" }, placement: "card" }
  ]
  const restored = Session.restore(records)
  const cards = restored.transcript.items.filter((item) => item.kind === "card")
  expect(cards).toHaveLength(1)
  expect(cards[0]).toMatchObject({ panel: { summary: "One step left." } })
  expect(restored.workspace.panels.map((panel) => panel.id)).toEqual(["release", "fix/plan"])
  expect(restored.workspace.cards).toEqual(["release", "fix/plan"])
  expect(restored.contributions).toEqual([
    { owner: "runtime:chat", contribution: { kind: "status", status: { id: "ci", text: "CI ✓" } } },
    {
      owner: "runtime:fix",
      contribution: (records[5] as Extract<Session.Record, { type: "contribution" }>).contribution
    }
  ])
})

it("stores model-call timing without duplicating the prompt and conversation", () => {
  for (const kind of ["chat", "worker"] as const) {
    const writer = Session.create("/work/private", kind)
    for (let frame = 0; frame < 20; frame++) {
      writer.append({
        type: "event",
        at: frame,
        event: {
          _tag: "model-requested",
          seat: "test",
          scope: "root",
          frame,
          request: { system: "private instruction".repeat(1000), messages: ["conversation".repeat(frame * 1000)] }
        } as never
      })
    }
    const saved = readFileSync(writer.file, "utf8")
    expect(saved.includes("private instruction")).toBe(false)
    expect(saved.includes("conversation")).toBe(false)
    expect(saved.length).toBeLessThan(8000)
    expect(
      Session.restore(Session.load(writer.file)).transcript.activity?.records.filter((r) =>
        r.kind === "control.agent.model-requested"
      )
    ).toHaveLength(20)
    expect(statSync(writer.file).mode & 0o777).toBe(0o600)
    expect(statSync(Session.directory("/work/private")).mode & 0o777).toBe(0o700)
  }
})
