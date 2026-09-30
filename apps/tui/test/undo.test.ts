import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { Effect } from "effect"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import * as Changes from "../src/changes.ts"
import * as Context from "../src/context.ts"
import * as Session from "../src/session.ts"
import * as Summary from "../src/summary.ts"
import * as Transcript from "../src/transcript.ts"
import * as Undo from "../src/undo.ts"
import { Workspace } from "../src/workspace.ts"

let previousSessionDirectory: string | undefined
beforeEach(() => {
  previousSessionDirectory = process.env.SMITHERS_TUI_SESSION_DIR
})
afterEach(() => {
  if (previousSessionDirectory === undefined) delete process.env.SMITHERS_TUI_SESSION_DIR
  else process.env.SMITHERS_TUI_SESSION_DIR = previousSessionDirectory
})

const scratch = () => mkdtempSync(join(tmpdir(), "tui-undo-"))
const put = (cwd: string, path: string, content: string) => {
  mkdirSync(dirname(join(cwd, path)), { recursive: true })
  writeFileSync(join(cwd, path), content)
}
const get = (cwd: string, path: string) => readFileSync(join(cwd, path), "utf8")
const sh = (cwd: string, ...command: string[]) => {
  const result = Bun.spawnSync(command, { cwd, stdout: "ignore", stderr: "ignore" })
  if (result.exitCode !== 0) throw new Error(`${command.join(" ")} failed`)
}
const gitRepo = () => {
  const cwd = scratch()
  sh(cwd, "git", "init", "-q")
  return cwd
}
const gitCommit = (cwd: string) => {
  sh(cwd, "git", "add", "-A")
  sh(cwd, "git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init")
}

/**
 * A session as the app writes it: prompts, harness call events, and receipts
 * produced by the real `Changes.capture` around a binding that mutates files.
 */
const recorder = (cwd: string) => {
  const records: Session.Record[] = []
  let at = 1
  let frame = 0
  let ordinal = 0
  const event = (event: unknown) => records.push({ type: "event", at: at++, event: event as never })
  return {
    records,
    prompt: (text: string) => records.push({ type: "user", at: at++, text }),
    cell: () => {
      frame++
      event({ _tag: "cell-produced", cell: { text: `// cell ${frame}` } })
    },
    settle: () => event({ _tag: "cell-settled", outcome: { _tag: "settled" } }),
    /** A flow call; `mutate` is what the binding does. `capture: false` records no receipt (a legacy session). */
    call: async (flow: string, input: unknown, mutate: () => void, capture = true) => {
      const identity = { session: "test", frame, cell: frame, ordinal: ordinal++ }
      event({ _tag: "cell-call-started", call: { flowName: flow, input, identity } })
      const source = {
        name: "test",
        bindings: () =>
          Effect.succeed([{
            descriptor: { name: flow },
            run: () =>
              Effect.sync(() => {
                mutate()
                return { outcome: "success", value: {} }
              })
          }])
      } as unknown as Parameters<typeof Changes.capture>[0]
      const receipts: Changes.Receipt[] = []
      if (capture) {
        const [binding] = await Effect.runPromise(
          Changes.capture(source, cwd, (receipt) => receipts.push(receipt)).bindings()
        )
        await Effect.runPromise(binding!.run({ flowName: flow, input, identity } as never))
      } else mutate()
      for (const receipt of receipts) records.push({ type: "patch", receipt })
      event({ _tag: "cell-call-settled", flowName: flow, identity, result: { outcome: "success", value: {} } })
      return { identity: Changes.identity(identity as never), receipts }
    },
    transcript: () => Session.restore(records).transcript
  }
}
const cellRows = (transcript: Transcript.Transcript) => transcript.items.filter((item) => item.kind === "cell")
/** Plans the turn `rowId` belongs to and writes every file it can; the plan, or the failure. */
const undo = async (cwd: string, transcript: Transcript.Transcript, rowId: string) => {
  const plan = await Undo.plan(cwd, Undo.turn(transcript, rowId).cells)
  if ("_tag" in plan) return plan
  return (await Undo.commit(cwd, Undo.chosen(plan, Undo.ready(plan)))) ?? plan
}
const write = (cwd: string, path: string, content: string) => () => put(cwd, path, content)
const entries = (plan: Undo.Plan | Undo.Failure) =>
  "_tag" in plan ? plan : plan.entries.map((entry) => ({ path: entry.path, refused: entry.refused }))
/** A cell holding forged receipts, as a session file could carry them. */
const cellOf = (...calls: ReadonlyArray<Transcript.Call>): Undo.Cell => ({
  kind: "cell",
  id: "forged",
  index: 1,
  prose: "",
  source: "",
  status: "done",
  calls,
  printed: "",
  startedAt: 0
})
const forged = (flow: string, ...patches: ReadonlyArray<Changes.Patch>): Transcript.Call => ({
  flow,
  identity: `forged-${flow}`,
  subject: "",
  status: "ok",
  startedAt: 0,
  patches
})

describe("undo", () => {
  it("rollback restores bytes and original mode after a later write fails", async () => {
    const cwd = scratch()
    put(cwd, "secret", "secret\n")
    chmodSync(join(cwd, "secret"), 0o600)
    put(cwd, "second", "new\n")
    const files = [
      { path: "secret", current: "secret\n", next: null },
      { path: "second", current: "new\n", next: "old\n" }
    ]
    const result = await Undo.commit(cwd, files, undefined, async (path, content, mode) => {
      if (path.endsWith("/second") && content === "old\n") throw new Error("injected IO failure")
      await Undo.put(path, content, mode)
    })
    expect(result).toMatchObject({ _tag: "WriteFailed", restored: true })
    expect(get(cwd, "secret")).toBe("secret\n")
    expect(statSync(join(cwd, "secret")).mode & 0o7777).toBe(0o600)
  })

  it("rollback reports unrestored when bytes match but mode does not", async () => {
    const cwd = scratch()
    put(cwd, "secret", "secret\n")
    chmodSync(join(cwd, "secret"), 0o600)
    const result = await Undo.commit(
      cwd,
      [{ path: "secret", current: "secret\n", next: "old\n" }],
      undefined,
      async (path) => {
        chmodSync(path, 0o644)
        throw new Error("chmod refused")
      }
    )
    expect(result).toMatchObject({ _tag: "WriteFailed", restored: false })
  })

  it("undoes captured edits when a later writer was denied before execution", async () => {
    const cwd = scratch()
    put(cwd, "a.ts", "before\n")
    const r = recorder(cwd)
    r.prompt("change")
    r.cell()
    await r.call("write", { path: "a.ts" }, write(cwd, "a.ts", "after\n"))
    const identity = { session: "test", frame: 1, cell: 1, ordinal: 99 }
    r.records.push({
      type: "event",
      at: 10,
      event: { _tag: "cell-call-started", call: { flowName: "bash", input: { command: "true" }, identity } } as never
    })
    r.records.push({
      type: "event",
      at: 11,
      event: {
        _tag: "cell-call-settled",
        flowName: "bash",
        identity,
        result: { outcome: "failure", code: "capability_refused", message: "Denied: bash true" }
      } as never
    })
    r.settle()
    const result = await undo(cwd, r.transcript(), r.transcript().items[0]!.id)
    expect("_tag" in result).toBe(false)
    expect(get(cwd, "a.ts")).toBe("before\n")
  })

  it("reverses a captured edit and lists it with its counts", async () => {
    const cwd = scratch()
    put(cwd, "a.ts", "before\n")
    const r = recorder(cwd)
    r.prompt("change a")
    r.cell()
    await r.call("write", { path: "a.ts", content: "after\n" }, write(cwd, "a.ts", "after\n"))
    r.settle()
    const result = await undo(cwd, r.transcript(), cellRows(r.transcript())[0]!.id)
    expect((result as Undo.Plan).entries).toMatchObject([{ path: "a.ts", added: 1, removed: 1, with: ["a.ts"] }])
    expect((result as Undo.Plan).entries[0]!.state).toBeUndefined()
    expect(Undo.counts((result as Undo.Plan).entries[0]!)).toBe("+1 −1")
    expect(get(cwd, "a.ts")).toBe("before\n")
  })

  it("reverses a credential edit after the session was saved and reopened, byte for byte", async () => {
    const cwd = scratch()
    const before = "ANTHROPIC_API_KEY=sk-ant-api03-Qx7Lm2Vb9Tz4Rk8Wp1Ns6Hd3\n"
    const after = "ANTHROPIC_API_KEY=sk-ant-api03-Rotated9Tz4Rk8Wp1Ns6Hd3\n"
    put(cwd, ".env", before)
    const r = recorder(cwd)
    r.prompt("rotate the key")
    r.cell()
    await r.call("write", { path: ".env", content: after }, write(cwd, ".env", after))
    r.settle()
    process.env.SMITHERS_TUI_SESSION_DIR = scratch()
    const writer = Session.create(cwd)
    for (const record of r.records) writer.append(record)
    expect(readFileSync(writer.file, "utf8").split("\n").filter((line) => line.includes("\"event\"")).join("\n")).not
      .toContain("Rotated9")

    const transcript = Session.restore(Session.load(writer.file)).transcript
    const result = await undo(cwd, transcript, cellRows(transcript)[0]!.id)
    expect("_tag" in result).toBe(false)
    expect(get(cwd, ".env")).toBe(before)
  })

  it("restores a deleted file and removes a created one, marking each", async () => {
    const cwd = scratch()
    put(cwd, "c.ts", "keep me\n")
    const r = recorder(cwd)
    r.prompt("move things")
    r.cell()
    await r.call(
      "apply_patch",
      { input: "*** Begin Patch\n*** Delete File: c.ts\n*** Add File: n.ts\n+new\n*** End Patch" },
      () => {
        unlinkSync(join(cwd, "c.ts"))
        put(cwd, "n.ts", "new\n")
      }
    )
    r.settle()
    expect(Undo.changes(Undo.run(r.transcript())).map((change) => [change.path, Undo.counts(change)])).toEqual([
      ["c.ts", "deleted"],
      ["n.ts", "new"]
    ])
    const result = await undo(cwd, r.transcript(), cellRows(r.transcript())[0]!.id)
    expect((result as Undo.Plan).entries.map((entry) => [entry.path, entry.state])).toEqual([
      ["c.ts", "deleted"],
      ["n.ts", "new"]
    ])
    expect(get(cwd, "c.ts")).toBe("keep me\n")
    expect(existsSync(join(cwd, "n.ts"))).toBe(false)
  })

  it("undoes a move", async () => {
    const cwd = scratch()
    put(cwd, "a.ts", "moved\n")
    const r = recorder(cwd)
    r.prompt("rename")
    r.cell()
    await r.call("apply_patch", {
      input: "*** Begin Patch\n*** Update File: a.ts\n*** Move to: b.ts\n@@\n-moved\n+moved\n*** End Patch"
    }, () => {
      unlinkSync(join(cwd, "a.ts"))
      put(cwd, "b.ts", "moved\n")
    })
    r.settle()
    const result = await undo(cwd, r.transcript(), cellRows(r.transcript())[0]!.id)
    expect((result as Undo.Plan).entries.map((entry) => `${entry.path} ${Undo.counts(entry)}`)).toEqual([
      "a.ts deleted",
      "b.ts new"
    ])
    expect(get(cwd, "a.ts")).toBe("moved\n")
    expect(existsSync(join(cwd, "b.ts"))).toBe(false)
  })

  it("undoes both sides of a recorded rename together or not at all", async () => {
    const cwd = scratch()
    put(cwd, "new.ts", "same\n")
    const rename = {
      path: "new.ts",
      patch: "diff --git a/old.ts b/new.ts\nsimilarity index 100%\nrename from old.ts\nrename to new.ts\n"
    }
    const plan = await Undo.plan(cwd, [cellOf(forged("bash", rename))]) as Undo.Plan
    expect(plan.entries.map((entry) => [entry.path, entry.with.toSorted()])).toEqual([
      ["new.ts", ["new.ts", "old.ts"]],
      ["old.ts", ["new.ts", "old.ts"]]
    ])
    const both = Undo.ready(plan)
    expect(Undo.toggle(plan, both, "old.ts").size).toBe(0)
    expect(Undo.chosen(plan, Undo.toggle(plan, both, "old.ts"))).toEqual([])
    expect(await Undo.commit(cwd, Undo.chosen(plan, both))).toBeUndefined()
    expect(get(cwd, "old.ts")).toBe("same\n")
    expect(existsSync(join(cwd, "new.ts"))).toBe(false)

    put(cwd, "new.ts", "same\n")
    const blocked = await Undo.plan(cwd, [cellOf(forged("bash", rename))]) as Undo.Plan
    expect(entries(blocked)).toEqual([
      { path: "new.ts", refused: "changed" },
      { path: "old.ts", refused: "changed" }
    ])
  })

  it("refuses only a file changed since, undoing the rest", async () => {
    const cwd = scratch()
    put(cwd, "a.ts", "one\n")
    put(cwd, "b.ts", "before\n")
    const r = recorder(cwd)
    r.prompt("edit both")
    r.cell()
    await r.call("write", { path: "a.ts" }, write(cwd, "a.ts", "two\n"))
    await r.call("write", { path: "b.ts" }, write(cwd, "b.ts", "after\n"))
    r.settle()
    put(cwd, "a.ts", "three\n")
    const plan = await Undo.plan(cwd, Undo.run(r.transcript())) as Undo.Plan
    expect(entries(plan)).toEqual([{ path: "b.ts", refused: undefined }, { path: "a.ts", refused: "changed" }])
    expect([...Undo.ready(plan)]).toEqual(["b.ts"])
    // A refused file never toggles on.
    expect(Undo.toggle(plan, Undo.ready(plan), "a.ts")).toEqual(Undo.ready(plan))
    expect(await Undo.commit(cwd, Undo.chosen(plan, Undo.ready(plan)))).toBeUndefined()
    expect(get(cwd, "a.ts")).toBe("three\n")
    expect(get(cwd, "b.ts")).toBe("before\n")

    put(cwd, "b.ts", "changed again\n")
    const refused = await Undo.plan(cwd, Undo.run(r.transcript())) as Undo.Plan
    expect(Undo.ready(refused).size).toBe(0)
    expect(Undo.refusal(refused)).toBe("Not undone · changed since: a.ts, b.ts")
  })

  it("writes only the files left checked", async () => {
    const cwd = scratch()
    put(cwd, "a.ts", "a\n")
    put(cwd, "b.ts", "b\n")
    const r = recorder(cwd)
    r.prompt("edit both")
    r.cell()
    await r.call("write", { path: "a.ts" }, write(cwd, "a.ts", "A\n"))
    await r.call("write", { path: "b.ts" }, write(cwd, "b.ts", "B\n"))
    r.settle()
    const plan = await Undo.plan(cwd, Undo.run(r.transcript())) as Undo.Plan
    const checked = Undo.toggle(plan, Undo.ready(plan), "a.ts")
    expect([...checked]).toEqual(["b.ts"])
    expect([...Undo.toggle(plan, checked, "a.ts")].toSorted()).toEqual(["a.ts", "b.ts"])
    const files = Undo.chosen(plan, checked)
    expect(Undo.label(files)).toBe("Undo b.ts")
    expect(Undo.label(Undo.chosen(plan, Undo.ready(plan)))).toBe("Undo 2 files")
    expect(await Undo.commit(cwd, files)).toBeUndefined()
    expect(get(cwd, "a.ts")).toBe("A\n")
    expect(get(cwd, "b.ts")).toBe("b\n")
  })

  it("applies over later edits elsewhere in the file", async () => {
    const cwd = scratch()
    const lines = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`)
    put(cwd, "a.ts", `${lines.join("\n")}\n`)
    const r = recorder(cwd)
    r.prompt("first")
    r.cell()
    await r.call("write", { path: "a.ts" }, write(cwd, "a.ts", `${["LINE 1", ...lines.slice(1)].join("\n")}\n`))
    r.settle()
    r.prompt("second")
    r.cell()
    const later = ["LINE 1", ...lines.slice(1)]
    later[19] = "LINE 20"
    await r.call("write", { path: "a.ts" }, write(cwd, "a.ts", `${later.join("\n")}\n`))
    r.settle()
    const result = await undo(cwd, r.transcript(), cellRows(r.transcript())[0]!.id)
    expect("_tag" in result).toBe(false)
    const expected = [...lines]
    expected[19] = "LINE 20"
    expect(get(cwd, "a.ts")).toBe(`${expected.join("\n")}\n`)
  })

  it("reverses several calls on one file newest first", async () => {
    const cwd = scratch()
    put(cwd, "a.ts", "x = 1\n")
    const r = recorder(cwd)
    r.prompt("twice")
    r.cell()
    await r.call("edit", { path: "a.ts" }, write(cwd, "a.ts", "x = 2\n"))
    await r.call("edit", { path: "a.ts" }, write(cwd, "a.ts", "x = 3\n"))
    r.settle()
    const result = await undo(cwd, r.transcript(), cellRows(r.transcript())[0]!.id)
    expect((result as Undo.Plan).entries).toMatchObject([{ path: "a.ts", added: 2, removed: 2 }])
    expect(get(cwd, "a.ts")).toBe("x = 1\n")
  })

  it("refuses binary, large, and truncated changes one by one, undoing the text beside them", async () => {
    const cwd = scratch()
    put(cwd, "text.ts", "before\n")
    const r = recorder(cwd)
    r.prompt("binary")
    r.cell()
    await r.call("write", { path: "logo.png" }, () => writeFileSync(join(cwd, "logo.png"), new Uint8Array([1, 0, 2])))
    await r.call("write", { path: "text.ts" }, write(cwd, "text.ts", "after\n"))
    r.settle()
    const binary = await undo(cwd, r.transcript(), cellRows(r.transcript())[0]!.id)
    expect(entries(binary)).toEqual([
      { path: "text.ts", refused: undefined },
      { path: "logo.png", refused: "unrendered" }
    ])
    expect(get(cwd, "text.ts")).toBe("before\n")
    expect(existsSync(join(cwd, "logo.png"))).toBe(true)

    put(cwd, "big.ts", "x\n".repeat(20_000))
    r.prompt("large")
    r.cell()
    await r.call("write", { path: "big.ts" }, write(cwd, "big.ts", "y\n".repeat(20_000)))
    r.settle()
    const large = cellRows(r.transcript())[1]!
    expect(large.kind === "cell" && large.calls[0]!.patches![0]!.patch).toStartWith("Diff too large:")
    const refused = await Undo.plan(cwd, Undo.turn(r.transcript(), large.id).cells) as Undo.Plan
    expect(entries(refused)).toEqual([{ path: "big.ts", refused: "unrendered" }])
    expect(Undo.refusal(refused)).toBe("Not undone · binary or large: big.ts")

    const repo = scratch()
    const g = recorder(repo)
    g.prompt("many")
    g.cell()
    const many = Array.from({ length: 201 }, (_, index) => `f${index}.txt`)
    await g.call("apply_patch", {
      input: `*** Begin Patch\n${many.map((path) => `*** Add File: ${path}\n+x`).join("\n")}\n*** End Patch`
    }, () => {
      for (const path of many) put(repo, path, "x\n")
    })
    g.settle()
    const truncated = await Undo.plan(repo, Undo.run(g.transcript())) as Undo.Plan
    expect(truncated.entries.find((entry) => entry.path === "More changes")?.refused).toBe("unrendered")
    expect(Undo.ready(truncated).size).toBe(200)
  }, 60_000)

  it("undoes the captured files beside a call with no receipt, and has nothing to undo without one", async () => {
    const cwd = scratch()
    const r = recorder(cwd)
    r.prompt("shell")
    r.cell()
    const shell = await r.call("bash", { command: "echo x > a.ts" }, write(cwd, "a.ts", "x\n"))
    expect(shell.receipts).toHaveLength(0)
    await r.call("write", { path: "b.ts" }, write(cwd, "b.ts", "y\n"))
    r.settle()
    const result = await undo(cwd, r.transcript(), cellRows(r.transcript())[0]!.id)
    expect(entries(result)).toEqual([{ path: "b.ts", refused: undefined }])
    expect(existsSync(join(cwd, "b.ts"))).toBe(false)
    expect(get(cwd, "a.ts")).toBe("x\n")

    r.prompt("legacy")
    r.cell()
    await r.call("edit", { path: "a.ts", oldString: "x", newString: "z" }, write(cwd, "a.ts", "z\n"), false)
    r.settle()
    const legacy = Undo.turn(r.transcript(), cellRows(r.transcript())[1]!.id).cells
    expect(Undo.possible(legacy)).toBe(false)
    expect(await Undo.plan(cwd, legacy)).toEqual({ _tag: "NothingToUndo" })
  })

  it("undoes a turn with a verified-empty shell call and a captured write", async () => {
    const cwd = gitRepo()
    put(cwd, "a.ts", "x\n")
    gitCommit(cwd)
    const r = recorder(cwd)
    r.prompt("status")
    r.cell()
    const { receipts } = await r.call("bash", { command: "git status" }, () => {})
    expect(receipts.map((receipt) => receipt.patches)).toEqual([[]])
    await r.call("write", { path: "a.ts", content: "changed\n" }, write(cwd, "a.ts", "changed\n"))
    r.settle()
    const summary = Summary.panel(r.transcript())
    expect(summary.rows.flatMap((row) => row.details.filter((detail) => detail.kind === "diff"))).toHaveLength(1)
    expect(summary.rows.find((row) => row.details.some((detail) => detail.kind === "code"))?.label).toContain(
      "Wrote a.ts"
    )
    const result = await undo(cwd, r.transcript(), cellRows(r.transcript())[0]!.id)
    expect(result).toMatchObject({ entries: [{ path: "a.ts", next: "x\n" }] })
    expect(get(cwd, "a.ts")).toBe("x\n")
  })

  it("undoes a file a shell command wrote, and the edit before it, from their receipts", async () => {
    const cwd = gitRepo()
    put(cwd, "math.js", "export const add = (a, b) => a - b\n")
    gitCommit(cwd)
    const r = recorder(cwd)
    r.prompt("Fix add in math.js, then run node check.mjs > check.log")
    r.cell()
    await r.call("edit", { path: "math.js" }, write(cwd, "math.js", "export const add = (a, b) => a + b\n"))
    const shell = await r.call("bash", { command: "node check.mjs > check.log" }, write(cwd, "check.log", "ok\n"))
    expect(shell.receipts.map((receipt) => receipt.patches.map((patch) => patch.path))).toEqual([["check.log"]])
    r.settle()
    const run = Undo.run(r.transcript())
    expect(Undo.changes(run).map((change) => `${change.path} ${Undo.counts(change)}`)).toEqual([
      "math.js +1 −1",
      "check.log new"
    ])
    const plan = await Undo.plan(cwd, run) as Undo.Plan
    expect(plan.entries.map((entry) => `${entry.path} ${Undo.counts(entry)}`)).toEqual([
      "math.js +1 −1",
      "check.log new"
    ])
    expect(await Undo.commit(cwd, Undo.chosen(plan, Undo.ready(plan)))).toBeUndefined()
    expect(get(cwd, "math.js")).toBe("export const add = (a, b) => a - b\n")
    expect(existsSync(join(cwd, "check.log"))).toBe(false)
  })

  for (
    const [label, spelled] of [
      ["./a.ts", (_cwd: string) => "./a.ts"],
      ["an absolute path", (cwd: string) => join(cwd, "a.ts")],
      ["the workspace's real absolute path", (cwd: string) => join(realpathSync(cwd), "a.ts")]
    ] as const
  ) {
    it(`lists and undoes one file an edit named as ${label} and a shell command then wrote`, async () => {
      const cwd = gitRepo()
      put(cwd, "a.ts", "one\n")
      gitCommit(cwd)
      const r = recorder(cwd)
      r.prompt("edit then shell")
      r.cell()
      const edit = await r.call("edit", { path: spelled(cwd) }, write(cwd, "a.ts", "two\n"))
      expect(edit.receipts.flatMap((receipt) => receipt.patches.map((patch) => patch.path))).toEqual(["a.ts"])
      expect(edit.receipts[0]!.patches[0]!.patch).toContain("--- a/a.ts")
      await r.call("bash", { command: "echo three > a.ts" }, write(cwd, "a.ts", "three\n"))
      r.settle()
      const run = Undo.run(r.transcript())
      expect(Undo.changes(run).map((change) => `${change.path} ${Undo.counts(change)}`)).toEqual(["a.ts +2 −2"])
      const plan = await Undo.plan(cwd, run) as Undo.Plan
      expect(plan.entries.map((entry) => [entry.path, entry.next, entry.refused])).toEqual([
        ["a.ts", "one\n", undefined]
      ])
      const files = Undo.chosen(plan, Undo.ready(plan))
      expect(await Undo.commit(cwd, files)).toBeUndefined()
      expect(get(cwd, "a.ts")).toBe("one\n")
      expect(Undo.done(files)).toBe("Undid a.ts")
      const after = Transcript.undone(r.transcript(), plan.calls, Undo.recorded(plan, files), 9)
      expect(Undo.possible(Undo.run(after))).toBe(false)
    })
  }

  it("keeps a file named outside the workspace absolute, and refuses it", async () => {
    const root = scratch()
    const cwd = join(root, "repo")
    mkdirSync(cwd)
    put(root, "victim", "one\n")
    const r = recorder(cwd)
    r.prompt("outside")
    r.cell()
    const edit = await r.call("edit", { path: "../victim" }, write(root, "victim", "two\n"))
    expect(edit.receipts[0]!.patches.map((patch) => patch.path)).toEqual([join(root, "victim")])
    r.settle()
    const plan = await Undo.plan(cwd, Undo.run(r.transcript())) as Undo.Plan
    expect(entries(plan)).toEqual([{ path: join(root, "victim"), refused: "outside" }])
    expect(get(root, "victim")).toBe("two\n")
  })

  it("restores the run's first content when a saved receipt spells one file two ways", async () => {
    const cwd = scratch()
    put(cwd, "a.ts", "three\n")
    const edit = { ...forged("edit", Changes.patch("./a.ts", "one\n", "two\n")!), identity: "edit" }
    const shell = { ...forged("bash", Changes.patch("a.ts", "two\n", "three\n")!), identity: "shell" }
    const plan = await Undo.plan(cwd, [cellOf(edit, shell)]) as Undo.Plan
    expect(plan.entries.map((entry) => [entry.path, entry.next, entry.refused])).toEqual([
      ["./a.ts", "one\n", undefined],
      ["a.ts", "one\n", undefined]
    ])
    expect(await Undo.commit(cwd, Undo.chosen(plan, Undo.ready(plan)))).toBeUndefined()
    expect(get(cwd, "a.ts")).toBe("one\n")
  })

  it("captures only a named file while another worker edits elsewhere", async () => {
    const cwd = scratch()
    put(cwd, "a.ts", "original A\n")
    put(cwd, "b.ts", "original B\n")
    put(cwd, "c.ts", "original C\n")
    let started!: () => void
    let release!: () => void
    const entered = new Promise<void>((resolve) => {
      started = resolve
    })
    const hold = new Promise<void>((resolve) => {
      release = resolve
    })
    const receipts: Changes.Receipt[] = []
    const source = {
      name: "test",
      bindings: () =>
        Effect.succeed([{
          run: () =>
            Effect.promise(async () => {
              started()
              await hold
              put(cwd, "a.ts", "worker A\n")
              return { outcome: "success", value: {} }
            })
        }])
    } as unknown as Parameters<typeof Changes.capture>[0]
    const [binding] = await Effect.runPromise(
      Changes.capture(source, cwd, (receipt) => receipts.push(receipt)).bindings()
    )
    const identity = { session: "A", frame: 1, cell: 1, ordinal: 0 }
    const running = Effect.runPromise(
      binding!.run({ flowName: "write", input: { path: "a.ts", content: "worker A\n" }, identity } as never)
    )
    await entered
    put(cwd, "b.ts", "worker B\n")
    put(cwd, "c.ts", "external edit\n")
    release()
    await running
    expect(receipts.map((receipt) => receipt.patches.map((patch) => patch.path))).toEqual([["a.ts"]])
    expect(get(cwd, "b.ts")).toBe("worker B\n")
    expect(get(cwd, "c.ts")).toBe("external edit\n")
  })

  it("leaves a file another worker's named write changed out of a concurrent shell receipt", async () => {
    const cwd = gitRepo()
    put(cwd, "a.ts", "original A\n")
    put(cwd, "b.ts", "original B\n")
    gitCommit(cwd)
    let started!: () => void
    let release!: () => void
    const entered = new Promise<void>((resolve) => {
      started = resolve
    })
    const hold = new Promise<void>((resolve) => {
      release = resolve
    })
    const binding = async (receipts: Changes.Receipt[], body: () => Promise<void>) => {
      const source = {
        name: "test",
        bindings: () =>
          Effect.succeed([{
            run: () =>
              Effect.promise(async () => {
                await body()
                return { outcome: "success", value: {} }
              })
          }])
      } as unknown as Parameters<typeof Changes.capture>[0]
      const [bound] = await Effect.runPromise(
        Changes.capture(source, cwd, (receipt) => receipts.push(receipt)).bindings()
      )
      return bound!
    }
    const shellReceipts: Changes.Receipt[] = []
    const writeReceipts: Changes.Receipt[] = []
    const shell = await binding(shellReceipts, async () => {
      started()
      await hold
      put(cwd, "a.ts", "shell A\n")
    })
    const writer = await binding(writeReceipts, async () => put(cwd, "b.ts", "worker B\n"))
    const running = Effect.runPromise(
      shell.run({
        flowName: "bash",
        input: { command: "edit a.ts" },
        identity: { session: "A", frame: 1, cell: 1, ordinal: 0 }
      } as never)
    )
    await entered
    await Effect.runPromise(
      writer.run({
        flowName: "write",
        input: { path: "b.ts", content: "worker B\n" },
        identity: { session: "B", frame: 1, cell: 1, ordinal: 0 }
      } as never)
    )
    release()
    await running
    expect(shellReceipts.map((receipt) => receipt.patches.map((patch) => patch.path))).toEqual([["a.ts"]])
    expect(writeReceipts.map((receipt) => receipt.patches.map((patch) => patch.path))).toEqual([["b.ts"]])
  })

  it.skipIf(Bun.which("jj") === null)(
    "lists a concurrent edit a shell call observed, for the person to uncheck",
    async () => {
      const cwd = scratch()
      sh(cwd, "jj", "git", "init")
      put(cwd, "a.ts", "original A\n")
      put(cwd, "b.ts", "original B\n")
      put(cwd, "c.ts", "original C\n")
      let started!: () => void
      let release!: () => void
      const entered = new Promise<void>((resolve) => {
        started = resolve
      })
      const hold = new Promise<void>((resolve) => {
        release = resolve
      })
      const receipts: Changes.Receipt[] = []
      const source = {
        name: "test",
        bindings: () =>
          Effect.succeed([{
            run: () =>
              Effect.promise(async () => {
                started()
                await hold
                put(cwd, "a.ts", "worker A\n")
                return { outcome: "success", value: {} }
              })
          }])
      } as unknown as Parameters<typeof Changes.capture>[0]
      const [binding] = await Effect.runPromise(
        Changes.capture(source, cwd, (receipt) => receipts.push(receipt)).bindings()
      )
      const identity = { session: "A", frame: 1, cell: 1, ordinal: 0 }
      const running = Effect.runPromise(
        binding!.run({ flowName: "bash", input: { command: "edit a.ts" }, identity } as never)
      )
      await entered
      put(cwd, "b.ts", "worker B\n")
      put(cwd, "c.ts", "external edit\n")
      release()
      await running
      expect(receipts).toHaveLength(1)
      expect(receipts[0]!.patches.map((patch) => patch.path)).toContain("b.ts")
      expect(receipts[0]!.patches.map((patch) => patch.path)).toContain("c.ts")
      const transcript = Session.restore([
        { type: "user", at: 1, text: "edit a.ts" },
        { type: "event", at: 2, event: { _tag: "cell-produced", cell: { text: "// shell" } } },
        {
          type: "event",
          at: 3,
          event: { _tag: "cell-call-started", call: { flowName: "bash", input: { command: "edit a.ts" }, identity } }
        },
        { type: "patch", receipt: receipts[0]! },
        {
          type: "event",
          at: 4,
          event: { _tag: "cell-call-settled", flowName: "bash", identity, result: { outcome: "success", value: {} } }
        }
      ] as Session.Record[]).transcript
      const plan = await Undo.plan(cwd, Undo.run(transcript)) as Undo.Plan
      expect(plan.entries.map((entry) => entry.path).toSorted()).toEqual(["a.ts", "b.ts", "c.ts"])
      const checked = Undo.toggle(plan, Undo.toggle(plan, Undo.ready(plan), "b.ts"), "c.ts")
      expect(await Undo.commit(cwd, Undo.chosen(plan, checked))).toBeUndefined()
      expect(get(cwd, "a.ts")).toBe("original A\n")
      expect(get(cwd, "b.ts")).toBe("worker B\n")
      expect(get(cwd, "c.ts")).toBe("external edit\n")
    }
  )

  it("refuses when a file changes between plan and commit, and writes nothing", async () => {
    const cwd = scratch()
    put(cwd, "a.ts", "before\n")
    put(cwd, "b.ts", "before\n")
    const r = recorder(cwd)
    r.prompt("edit")
    r.cell()
    await r.call("write", { path: "a.ts" }, write(cwd, "a.ts", "after\n"))
    await r.call("write", { path: "b.ts" }, write(cwd, "b.ts", "after\n"))
    r.settle()
    const plan = await Undo.plan(cwd, Undo.run(r.transcript())) as Undo.Plan
    put(cwd, "a.ts", "someone else\n")
    expect(await Undo.commit(cwd, Undo.chosen(plan, Undo.ready(plan)))).toEqual({ _tag: "Conflict", paths: ["a.ts"] })
    expect(get(cwd, "a.ts")).toBe("someone else\n")
    expect(get(cwd, "b.ts")).toBe("after\n")
  })

  it("rolls back applied files when a write fails", async () => {
    const cwd = scratch()
    put(cwd, "a.ts", "before\n")
    put(cwd, "sub/d.ts", "deleted\n")
    const r = recorder(cwd)
    r.prompt("edit")
    r.cell()
    await r.call(
      "apply_patch",
      { input: "*** Begin Patch\n*** Delete File: sub/d.ts\n*** End Patch" },
      () => rmSync(join(cwd, "sub"), { recursive: true })
    )
    await r.call("write", { path: "a.ts" }, write(cwd, "a.ts", "after\n"))
    r.settle()
    const plan = await Undo.plan(cwd, Undo.run(r.transcript())) as Undo.Plan
    const files = Undo.chosen(plan, Undo.ready(plan))
    expect(files.map((file) => file.path)).toEqual(["sub/d.ts", "a.ts"])
    writeFileSync(join(cwd, "sub"), "a file where a directory was")
    const failure = await Undo.commit(cwd, files)
    expect(failure).toMatchObject({ _tag: "WriteFailed", path: "sub/d.ts", restored: true })
    expect(get(cwd, "a.ts")).toBe("after\n")
  })

  it("restores the failed file itself when its write truncated it before throwing", async () => {
    const cwd = scratch()
    put(cwd, "a.ts", "before a\n")
    put(cwd, "b.ts", "before b\n")
    const r = recorder(cwd)
    r.prompt("edit")
    r.cell()
    await r.call("write", { path: "a.ts" }, write(cwd, "a.ts", "after a\n"))
    await r.call("write", { path: "b.ts" }, write(cwd, "b.ts", "after b\n"))
    r.settle()
    const plan = await Undo.plan(cwd, Undo.run(r.transcript())) as Undo.Plan
    const files = Undo.chosen(plan, Undo.ready(plan))
    const failing = files.at(-1)!
    let failed = false
    const failure = await Undo.commit(cwd, files, undefined, async (path, content, mode) => {
      if (!failed && path === join(cwd, failing.path)) {
        failed = true
        writeFileSync(path, "")
        throw Object.assign(new Error("no space"), { code: "ENOSPC" })
      }
      return Undo.put(path, content, mode)
    })
    expect(failure).toMatchObject({ _tag: "WriteFailed", path: failing.path, message: "ENOSPC", restored: true })
    expect(get(cwd, "a.ts")).toBe("after a\n")
    expect(get(cwd, "b.ts")).toBe("after b\n")
  })

  it("reports files partly changed when the failed file cannot be put back", async () => {
    const cwd = scratch()
    put(cwd, "a.ts", "before\n")
    const r = recorder(cwd)
    r.prompt("edit")
    r.cell()
    await r.call("write", { path: "a.ts" }, write(cwd, "a.ts", "after\n"))
    r.settle()
    const plan = await Undo.plan(cwd, Undo.run(r.transcript())) as Undo.Plan
    const failure = await Undo.commit(cwd, Undo.chosen(plan, Undo.ready(plan)), undefined, async (path) => {
      writeFileSync(path, "")
      throw Object.assign(new Error("io"), { code: "EIO" })
    })
    expect(failure).toMatchObject({ _tag: "WriteFailed", path: "a.ts", restored: false })
  })

  it("restores a deleted executable with its mode", async () => {
    const cwd = scratch()
    put(cwd, "run.sh", "echo hi\n")
    chmodSync(join(cwd, "run.sh"), 0o755)
    const r = recorder(cwd)
    r.prompt("delete")
    r.cell()
    await r.call(
      "apply_patch",
      { input: "*** Begin Patch\n*** Delete File: run.sh\n*** End Patch" },
      () => unlinkSync(join(cwd, "run.sh"))
    )
    r.settle()
    const result = await undo(cwd, r.transcript(), cellRows(r.transcript())[0]!.id)
    expect("_tag" in result).toBe(false)
    expect(get(cwd, "run.sh")).toBe("echo hi\n")
    expect(statSync(join(cwd, "run.sh")).mode & 0o777).toBe(0o755)
  })

  it("restores a file a shell command deleted, with its mode", async () => {
    const cwd = gitRepo()
    put(cwd, "run.sh", "echo hi\n")
    chmodSync(join(cwd, "run.sh"), 0o755)
    gitCommit(cwd)
    const r = recorder(cwd)
    r.prompt("delete")
    r.cell()
    await r.call("bash", { command: "rm run.sh" }, () => unlinkSync(join(cwd, "run.sh")))
    r.settle()
    const result = await undo(cwd, r.transcript(), cellRows(r.transcript())[0]!.id)
    expect(entries(result)).toEqual([{ path: "run.sh", refused: undefined }])
    expect(get(cwd, "run.sh")).toBe("echo hi\n")
    expect(statSync(join(cwd, "run.sh")).mode & 0o777).toBe(0o755)
  })

  it("has nothing to write when a turn's edits net to no change, and recording that leaves nothing to undo", async () => {
    const cwd = scratch()
    put(cwd, "a.ts", "a\n")
    const r = recorder(cwd)
    r.prompt("round trip")
    r.cell()
    const one = await r.call("write", { path: "a.ts" }, write(cwd, "a.ts", "b\n"))
    const two = await r.call("write", { path: "a.ts" }, write(cwd, "a.ts", "a\n"))
    r.settle()
    expect(Undo.possible(Undo.run(r.transcript()))).toBe(true)
    const plan = await Undo.plan(cwd, Undo.run(r.transcript())) as Undo.Plan
    expect(plan).toEqual({ calls: [one.identity, two.identity], entries: [], settled: ["a.ts"] })
    expect(get(cwd, "a.ts")).toBe("a\n")
    const after = Transcript.undone(r.transcript(), plan.calls, Undo.recorded(plan, []), 9)
    expect(Undo.possible(Undo.run(after))).toBe(false)
    expect(Undo.undone(Undo.run(after))).toBe(true)
    expect(await Undo.plan(cwd, Undo.run(after))).toEqual({ _tag: "NothingToUndo" })
  })

  it("offers undo only for a change it can reverse, not a binary or large one", () => {
    const binary = forged("bash", { path: "logo.png", patch: "Binary or large file: logo.png" })
    const text = { ...forged("edit", Changes.patch("a.ts", "a\n", "b\n")!), identity: "text" }
    expect(Undo.possible([cellOf(binary)])).toBe(false)
    expect(Undo.possible([cellOf(binary, text)])).toBe(true)
    expect(Undo.possible([cellOf(binary, { ...text, patches: [{ ...text.patches![0]!, undone: true }] })])).toBe(false)
  })

  it("records a file that netted to no change with any undo of the run", async () => {
    const cwd = scratch()
    put(cwd, "a.ts", "a\n")
    put(cwd, "b.ts", "b\n")
    const r = recorder(cwd)
    r.prompt("round trip and an edit")
    r.cell()
    const one = await r.call("write", { path: "a.ts" }, write(cwd, "a.ts", "changed\n"))
    const two = await r.call("write", { path: "a.ts" }, write(cwd, "a.ts", "a\n"))
    const three = await r.call("write", { path: "b.ts" }, write(cwd, "b.ts", "B\n"))
    r.settle()
    const plan = await Undo.plan(cwd, Undo.run(r.transcript())) as Undo.Plan
    expect(plan.settled).toEqual(["a.ts"])
    expect(plan.calls).toEqual([one.identity, two.identity, three.identity])
    const files = Undo.chosen(plan, Undo.ready(plan))
    expect(Undo.recorded(plan, files)).toEqual(["b.ts", "a.ts"])
    const after = Transcript.undone(r.transcript(), plan.calls, Undo.recorded(plan, files), 9)
    expect(Undo.possible(Undo.run(after))).toBe(false)
    expect(Undo.undone(Undo.run(after))).toBe(true)
  })

  it("records a worker tab's undo in its own file, and the chat record only tells the context", async () => {
    const cwd = scratch()
    process.env.SMITHERS_TUI_SESSION_DIR = mkdtempSync(join(tmpdir(), "tui-sessions-"))
    put(cwd, "math.js", "a - b\n")
    const r = recorder(cwd)
    r.prompt("fix")
    r.cell()
    const edit = await r.call("edit", { path: "math.js" }, write(cwd, "math.js", "a + b\n"))
    r.settle()
    const worker = Session.create(cwd, "worker")
    for (const record of r.records) worker.append(record)
    const tab = {
      id: "fixer",
      title: "Fixer",
      prompt: "fix",
      seat: "w",
      file: worker.file,
      status: "done" as const,
      startedAt: 1,
      depth: 0
    }
    const host = {
      cwd,
      judged: false,
      dispose: async () => {},
      run: () => {
        throw new Error("no run")
      }
    }
    const workspace = new Workspace({
      host: host as never,
      workerSeat: "w",
      history: () => [],
      persist: () => {},
      restored: { tabs: [tab], panels: [] }
    })
    const result = await Undo.plan(cwd, Undo.run(workspace.transcript("fixer"))) as Undo.Plan
    expect(await Undo.commit(cwd, Undo.chosen(result, Undo.ready(result)))).toBeUndefined()
    expect(get(cwd, "math.js")).toBe("a - b\n")
    workspace.undone("fixer", [edit.identity], ["math.js"], 60)
    expect(Undo.possible(Undo.run(workspace.transcript("fixer")))).toBe(false)
    expect(Undo.undone(Undo.run(workspace.transcript("fixer")))).toBe(true)
    const reloaded = Session.restore(Session.load(worker.file))
    expect(await Undo.plan(cwd, Undo.run(reloaded.transcript))).toEqual({ _tag: "NothingToUndo" })
    const chat = Session.restore([
      { type: "user", at: 1, text: "delegate" },
      { type: "undo", at: 60, calls: [edit.identity], paths: ["math.js"], tab: "fixer" }
    ])
    expect(chat.transcript.items.some((item) => item.kind === "note")).toBe(false)
    expect(chat.entries).toEqual([{ kind: "undo", paths: ["math.js"] }])
  })

  it("finds the turn any row belongs to, from its prompt to the next", async () => {
    const cwd = scratch()
    put(cwd, "a.ts", "a\n")
    const r = recorder(cwd)
    r.prompt("first turn")
    r.cell()
    await r.call("write", { path: "a.ts" }, write(cwd, "a.ts", "b\n"))
    r.settle()
    r.cell()
    await r.call("write", { path: "a.ts" }, write(cwd, "a.ts", "c\n"))
    r.settle()
    r.prompt("second turn")
    r.cell()
    await r.call("write", { path: "a.ts" }, write(cwd, "a.ts", "d\n"))
    r.settle()
    r.records.push({ type: "outcome", at: 99, prompt: "second turn", outcome: { _tag: "done", answer: "Done." } })
    const transcript = Transcript.apply(
      r.transcript(),
      { _tag: "resolved", message: { content: [{ type: "text", text: "Done." }] } } as never,
      100
    )
    const [first, second, third] = cellRows(transcript)
    const firstUser = transcript.items.find((item) => item.kind === "user")!
    expect(Undo.turn(transcript, firstUser.id)).toEqual({ prompt: "first turn", cells: [first!, second!] })
    expect(Undo.turn(transcript, second!.id)).toEqual({ prompt: "first turn", cells: [first!, second!] })
    const answer = transcript.items.find((item) => item.kind === "answer")!
    expect(Undo.turn(transcript, answer.id)).toEqual({ prompt: "second turn", cells: [third!] })
    expect(Undo.turn(transcript, "missing")).toEqual({ prompt: undefined, cells: [] })
    expect(Undo.run(transcript)).toEqual([first!, second!, third!])
  })

  it("latest picks the newest prompt with changes left, passing over questions and undone turns", async () => {
    const cwd = scratch()
    put(cwd, "a.ts", "a\n")
    const r = recorder(cwd)
    expect(Undo.latest(r.transcript())).toEqual({ _tag: "NothingToUndo" })
    r.prompt("edit a")
    r.cell()
    const first = await r.call("write", { path: "a.ts" }, write(cwd, "a.ts", "b\n"))
    r.settle()
    r.prompt("edit again")
    r.cell()
    const second = await r.call("write", { path: "a.ts" }, write(cwd, "a.ts", "c\n"))
    r.settle()
    r.prompt("just a question")
    const newest = Undo.latest(r.transcript()) as ReturnType<typeof Undo.turn>
    expect(newest.cells.flatMap((cell) => cell.calls.map((call) => call.identity))).toEqual([second.identity])
    r.records.push({ type: "undo", at: 60, calls: [second.identity], paths: ["a.ts"] })
    const older = Undo.latest(r.transcript()) as ReturnType<typeof Undo.turn>
    expect(older.cells.flatMap((cell) => cell.calls.map((call) => call.identity))).toEqual([first.identity])
    r.records.push({ type: "undo", at: 61, calls: [first.identity], paths: ["a.ts"] })
    expect(Undo.latest(r.transcript())).toEqual({ _tag: "NothingToUndo" })
  })

  it("latest stops at the newest prompt that refuses, rather than undoing an older one", async () => {
    const cwd = scratch()
    put(cwd, "a.ts", "a\n")
    const r = recorder(cwd)
    r.prompt("edit a")
    r.cell()
    await r.call("write", { path: "a.ts" }, write(cwd, "a.ts", "b\n"))
    r.settle()
    r.prompt("newest edit")
    r.cell()
    const newestCall = await r.call("write", { path: "a.ts" }, write(cwd, "a.ts", "c\n"))
    r.settle()
    put(cwd, "a.ts", "external edit\n")
    const latest = Undo.latest(r.transcript()) as ReturnType<typeof Undo.turn>
    expect(latest.prompt).toBe("newest edit")
    expect(latest.cells.flatMap((cell) => cell.calls.map((call) => call.identity))).toEqual([newestCall.identity])
    const plan = await Undo.plan(cwd, latest.cells) as Undo.Plan
    expect(entries(plan)).toEqual([{ path: "a.ts", refused: "changed" }])
    expect(Undo.chosen(plan, Undo.ready(plan))).toEqual([])
    expect(get(cwd, "a.ts")).toBe("external edit\n")
  })

  it("records the undo: restored transcript, summary row, context, and nothing left to undo", async () => {
    const cwd = scratch()
    put(cwd, "math.js", "a - b\n")
    const r = recorder(cwd)
    r.prompt("fix")
    r.cell()
    const edit = await r.call(
      "edit",
      { path: "math.js", oldString: "a - b", newString: "a + b" },
      write(cwd, "math.js", "a + b\n")
    )
    r.settle()
    r.records.push({ type: "undo", at: 50, calls: [edit.identity], paths: ["math.js"] })
    const state = Session.restore(r.records)
    const cell = cellRows(state.transcript)[0]!
    expect(cell.kind === "cell" && cell.calls[0]!.patches![0]!.undone).toBe(true)
    expect(state.transcript.items.at(-1)).toMatchObject({ kind: "note", text: "Undid math.js" })
    expect(state.entries.at(-1)).toEqual({ kind: "undo", paths: ["math.js"] })
    expect(Context.system(cwd, state.entries).join("\n")).toContain("reverted earlier edits to: math.js")
    const row = Summary.panel(state.transcript).rows.find((each) => each.id === cell.id)!
    expect(row.label).toBe("Undone: Updated math.js")
    expect(row.status).toBe("cancelled")
    expect(Undo.possible(Undo.turn(state.transcript, cell.id).cells)).toBe(false)
    // The diff keeps the reversed change, marked.
    expect(Undo.changes(Undo.run(state.transcript))).toMatchObject([{ path: "math.js", undone: true }])
  })

  it("marks only the patches of the undone paths, leaving the rest to undo", () => {
    const call = forged("bash", Changes.patch("a.ts", "a\n", "A\n")!, Changes.patch("b.ts", null, "b\n")!)
    const transcript: Transcript.Transcript = { ...Transcript.empty, items: [cellOf(call)] }
    const after = Transcript.undone(transcript, [call.identity!], ["a.ts"], 1)
    const changes = Undo.changes(Undo.run(after))
    expect(changes.map((change) => [change.path, change.undone, Undo.counts(change)])).toEqual([
      ["a.ts", true, "+1 −1"],
      ["b.ts", false, "new"]
    ])
    expect(Undo.possible(Undo.run(after))).toBe(true)
    expect(Undo.undone(Undo.run(after))).toBe(false)
  })

  it("marks creation and deletion with /dev/null", () => {
    expect(Changes.patch("n.ts", null, "x\n")!.patch).toContain("--- /dev/null")
    expect(Changes.patch("d.ts", "x\n", null)!.patch).toContain("+++ /dev/null")
    expect(Changes.patch("same", null, null)).toBeUndefined()
    expect(Changes.patch("run.sh", "x\n", null, 0o755)!.patch).toStartWith(
      "diff --git a/run.sh b/run.sh\ndeleted file mode 100755\n"
    )
  })

  it("words failures in the fewest words", () => {
    expect(Undo.message({ _tag: "Busy" })).toBe("Stop running work first")
    expect(Undo.message({ _tag: "NothingToUndo" })).toBe("Nothing to undo")
    expect(Undo.message({ _tag: "Conflict", paths: ["math.js", "b.ts"] })).toBe(
      "Not undone · changed since: math.js, b.ts"
    )
    expect(Undo.message({ _tag: "WriteFailed", path: "math.js", message: "EACCES", restored: false })).toBe(
      "Undo failed · math.js: no permission · files partly changed"
    )
    // An unfamiliar code or an uncoded failure never reaches the toast as raw text.
    expect(Undo.message({ _tag: "WriteFailed", path: "a.ts", message: "EWEIRD", restored: true })).toBe(
      "Undo failed · a.ts: could not write"
    )
    expect(Undo.message({ _tag: "WriteFailed", path: "", message: "", restored: false })).toBe(
      "Undo failed: could not write · files partly changed"
    )
    expect(Undo.done([{ path: "math.js", current: "b", next: "a" }])).toBe("Undid math.js")
    expect(Undo.done([{ path: "a", current: "b", next: "a" }, { path: "b", current: "b", next: "a" }])).toBe(
      "Undid 2 files"
    )
  })
})

describe("undo containment", () => {
  const writeCall = (path: string, before: string | null, after: string | null) =>
    cellOf(forged("write", Changes.patch(path, before, after)!))

  it("skips a receipt whose path climbs out of the workspace, touching nothing", async () => {
    const root = scratch()
    const cwd = join(root, "repo")
    mkdirSync(cwd)
    put(root, "victim", "x\n")
    const plan = await Undo.plan(cwd, [writeCall("../victim", null, "x\n")]) as Undo.Plan
    expect(entries(plan)).toEqual([{ path: "../victim", refused: "outside" }])
    expect(Undo.chosen(plan, new Set(["../victim"]))).toEqual([])
    expect(Undo.refusal(plan)).toBe("Not undone · outside workspace: ../victim")
    expect(get(root, "victim")).toBe("x\n")
  })

  it("skips an absolute receipt path outside the workspace and undoes the file inside", async () => {
    const root = scratch()
    const cwd = join(root, "repo")
    mkdirSync(cwd)
    put(root, "victim", "after\n")
    put(cwd, "inside.ts", "after\n")
    const victim = join(root, "victim")
    let reads = 0
    const plan = await Undo.plan(
      cwd,
      [cellOf(
        forged("write", Changes.patch(victim, "before\n", "after\n")!),
        { ...forged("edit", Changes.patch("inside.ts", "before\n", "after\n")!), identity: "inside" }
      )],
      async (path) => {
        reads++
        expect(path).toBe(join(cwd, "inside.ts"))
        return Changes.read(path)
      }
    ) as Undo.Plan
    expect(reads).toBe(1)
    expect(entries(plan)).toEqual([{ path: "inside.ts", refused: undefined }, { path: victim, refused: "outside" }])
    expect(await Undo.commit(cwd, Undo.chosen(plan, Undo.ready(plan)))).toBeUndefined()
    expect(get(cwd, "inside.ts")).toBe("before\n")
    expect(get(root, "victim")).toBe("after\n")
  })

  it("skips a path that reaches outside through a symlink in the workspace", async () => {
    const root = scratch()
    const cwd = join(root, "repo")
    mkdirSync(join(root, "elsewhere"), { recursive: true })
    mkdirSync(cwd)
    put(root, "elsewhere/victim", "x\n")
    Bun.spawnSync(["ln", "-s", join(root, "elsewhere"), join(cwd, "link")])
    const plan = await Undo.plan(cwd, [writeCall("link/victim", null, "x\n")]) as Undo.Plan
    expect(entries(plan)).toEqual([{ path: "link/victim", refused: "outside" }])
    expect(get(root, "elsewhere/victim")).toBe("x\n")
  })

  it("words an outside refusal", () => {
    expect(Undo.message({ _tag: "Outside", paths: ["../victim"] })).toBe("Not undone · outside workspace: ../victim")
  })
})

describe("undo commit containment", () => {
  it("refuses a file whose path became a symlink out of the workspace after planning", async () => {
    const root = scratch()
    const cwd = join(root, "repo")
    mkdirSync(join(root, "elsewhere"), { recursive: true })
    mkdirSync(cwd)
    put(root, "elsewhere/victim", "x\n")
    Bun.spawnSync(["ln", "-s", join(root, "elsewhere"), join(cwd, "link")])
    expect(await Undo.commit(cwd, [{ path: "link/victim", current: "x\n", next: null }])).toEqual({
      _tag: "Outside",
      paths: ["link/victim"]
    })
    expect(get(root, "elsewhere/victim")).toBe("x\n")
  })
})
