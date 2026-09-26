import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { Effect } from "effect"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
const undo = async (cwd: string, transcript: Transcript.Transcript, rowId: string) => {
  const target = Undo.target(transcript, rowId)
  if ("_tag" in target) return target
  const plan = await Undo.plan(cwd, target)
  if ("_tag" in plan) return plan
  return (await Undo.commit(cwd, plan)) ?? plan
}
const write = (cwd: string, path: string, content: string) => () => put(cwd, path, content)

describe("undo", () => {
  it("rollback restores bytes and original mode after a later write fails", async () => {
    const cwd = scratch()
    put(cwd, "secret", "secret\n")
    chmodSync(join(cwd, "secret"), 0o600)
    put(cwd, "second", "new\n")
    const plan = {
      calls: ["c"],
      files: [
        { path: "secret", current: "secret\n", next: null },
        { path: "second", current: "new\n", next: "old\n" }
      ]
    }
    const result = await Undo.commit(cwd, plan, undefined, async (path, content, mode) => {
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
      {
        calls: [],
        files: [
          { path: "secret", current: "secret\n", next: "old\n" }
        ]
      },
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

  it("reverses a captured edit", async () => {
    const cwd = scratch()
    put(cwd, "a.ts", "before\n")
    const r = recorder(cwd)
    r.prompt("change a")
    r.cell()
    await r.call("write", { path: "a.ts", content: "after\n" }, write(cwd, "a.ts", "after\n"))
    r.settle()
    const result = await undo(cwd, r.transcript(), cellRows(r.transcript())[0]!.id)
    expect("_tag" in result).toBe(false)
    expect((result as Undo.Plan).files.map((file) => file.path)).toEqual(["a.ts"])
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

  it("restores a deleted file and removes a created one", async () => {
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
    const result = await undo(cwd, r.transcript(), cellRows(r.transcript())[0]!.id)
    expect("_tag" in result).toBe(false)
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
    expect("_tag" in result).toBe(false)
    expect(get(cwd, "a.ts")).toBe("moved\n")
    expect(existsSync(join(cwd, "b.ts"))).toBe(false)
  })

  it("refuses all or nothing when a file changed since, naming it", async () => {
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
    const result = await undo(cwd, r.transcript(), cellRows(r.transcript())[0]!.id)
    expect(result).toEqual({ _tag: "Conflict", paths: ["a.ts"] })
    expect(get(cwd, "a.ts")).toBe("three\n")
    expect(get(cwd, "b.ts")).toBe("after\n")
    put(cwd, "b.ts", "changed again\n")
    expect(await undo(cwd, r.transcript(), cellRows(r.transcript())[0]!.id)).toEqual({
      _tag: "Conflict",
      paths: ["a.ts", "b.ts"]
    })
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
    expect("_tag" in result).toBe(false)
    expect(get(cwd, "a.ts")).toBe("x = 1\n")
  })

  it("refuses binary, large, and truncated changes without touching anything", async () => {
    const cwd = scratch()
    put(cwd, "text.ts", "before\n")
    const r = recorder(cwd)
    r.prompt("binary")
    r.cell()
    await r.call("write", { path: "logo.png" }, () => writeFileSync(join(cwd, "logo.png"), new Uint8Array([1, 0, 2])))
    await r.call("write", { path: "text.ts" }, write(cwd, "text.ts", "after\n"))
    r.settle()
    expect(Undo.target(r.transcript(), cellRows(r.transcript())[0]!.id)).toEqual({
      _tag: "Unrendered",
      paths: ["logo.png"]
    })
    expect(get(cwd, "text.ts")).toBe("after\n")

    put(cwd, "big.ts", "x\n".repeat(20_000))
    r.prompt("large")
    r.cell()
    await r.call("write", { path: "big.ts" }, write(cwd, "big.ts", "y\n".repeat(20_000)))
    r.settle()
    const large = cellRows(r.transcript())[1]!
    expect(large.kind === "cell" && large.calls[0]!.patches![0]!.patch).toStartWith("Diff too large:")
    expect(Undo.target(r.transcript(), large.id)).toEqual({ _tag: "Unrendered", paths: ["big.ts"] })

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
    const target = Undo.target(g.transcript(), cellRows(g.transcript())[0]!.id)
    expect(target).toMatchObject({ _tag: "Unrendered" })
    expect((target as { paths: ReadonlyArray<string> }).paths).toContain("More changes")
  }, 60_000)

  it("refuses a writer call with no receipt", async () => {
    const cwd = scratch()
    const r = recorder(cwd)
    r.prompt("shell")
    r.cell()
    const shell = await r.call("bash", { command: "echo x > a.ts" }, write(cwd, "a.ts", "x\n"))
    expect(shell.receipts).toHaveLength(0)
    await r.call("write", { path: "b.ts" }, write(cwd, "b.ts", "y\n"))
    r.settle()
    expect(Undo.target(r.transcript(), cellRows(r.transcript())[0]!.id)).toEqual({
      _tag: "Uncaptured",
      flows: ["bash"]
    })

    r.prompt("legacy")
    r.cell()
    await r.call("edit", { path: "a.ts", oldString: "x", newString: "z" }, write(cwd, "a.ts", "z\n"), false)
    r.settle()
    expect(Undo.target(r.transcript(), cellRows(r.transcript())[1]!.id)).toEqual({
      _tag: "Uncaptured",
      flows: ["edit"]
    })
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
    expect(result).toMatchObject({ files: [{ path: "a.ts", next: "x\n" }] })
    expect(get(cwd, "a.ts")).toBe("x\n")
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

  it.skipIf(Bun.which("jj") === null)("does not attribute a concurrent worker's edit to a shell call", async () => {
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
    expect(get(cwd, "a.ts")).toBe("worker A\n")
    expect(get(cwd, "b.ts")).toBe("worker B\n")
    expect(get(cwd, "c.ts")).toBe("external edit\n")
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
    expect(Undo.target(transcript, cellRows(transcript)[0]!.id)).toEqual({ _tag: "Uncaptured", flows: ["bash"] })
    expect(get(cwd, "b.ts")).toBe("worker B\n")
  })

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
    const target = Undo.target(r.transcript(), cellRows(r.transcript())[0]!.id) as Undo.Target
    const plan = await Undo.plan(cwd, target) as Undo.Plan
    put(cwd, "a.ts", "someone else\n")
    expect(await Undo.commit(cwd, plan)).toEqual({ _tag: "Conflict", paths: ["a.ts"] })
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
    const target = Undo.target(r.transcript(), cellRows(r.transcript())[0]!.id) as Undo.Target
    const plan = await Undo.plan(cwd, target) as Undo.Plan
    expect(plan.files.map((file) => file.path)).toEqual(["a.ts", "sub/d.ts"])
    writeFileSync(join(cwd, "sub"), "a file where a directory was")
    const failure = await Undo.commit(cwd, plan)
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
    const plan = await Undo.plan(
      cwd,
      Undo.target(r.transcript(), cellRows(r.transcript())[0]!.id) as Undo.Target
    ) as Undo.Plan
    const failing = plan.files.at(-1)!
    let failed = false
    const failure = await Undo.commit(cwd, plan, undefined, async (path, content, mode) => {
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
    const plan = await Undo.plan(
      cwd,
      Undo.target(r.transcript(), cellRows(r.transcript())[0]!.id) as Undo.Target
    ) as Undo.Plan
    const failure = await Undo.commit(cwd, plan, undefined, async (path) => {
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

  it("refuses a standalone shell deletion", async () => {
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
    expect(result).toEqual({ _tag: "Uncaptured", flows: ["bash"] })
    expect(existsSync(join(cwd, "run.sh"))).toBe(false)
  })

  it("has nothing to undo when a turn's edits net to no change", async () => {
    const cwd = scratch()
    put(cwd, "a.ts", "a\n")
    const r = recorder(cwd)
    r.prompt("round trip")
    r.cell()
    await r.call("write", { path: "a.ts" }, write(cwd, "a.ts", "b\n"))
    await r.call("write", { path: "a.ts" }, write(cwd, "a.ts", "a\n"))
    r.settle()
    const target = Undo.target(r.transcript(), cellRows(r.transcript())[0]!.id) as Undo.Target
    expect(await Undo.plan(cwd, target)).toEqual({ _tag: "NothingToUndo" })
    expect(get(cwd, "a.ts")).toBe("a\n")
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
      compaction: async () => undefined,
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
    const cell = cellRows(workspace.transcript("fixer"))[0]!
    const result = await undo(cwd, workspace.transcript("fixer"), cell.id)
    expect("_tag" in result).toBe(false)
    expect(get(cwd, "math.js")).toBe("a - b\n")
    workspace.undone("fixer", [edit.identity], ["math.js"], 60)
    expect(Undo.target(workspace.transcript("fixer"), cell.id)).toEqual({ _tag: "AlreadyUndone" })
    const reloaded = Session.restore(Session.load(worker.file))
    expect(Undo.target(reloaded.transcript, cell.id)).toEqual({ _tag: "AlreadyUndone" })
    const chat = Session.restore([
      { type: "user", at: 1, text: "delegate" },
      { type: "undo", at: 60, calls: [edit.identity], paths: ["math.js"], tab: "fixer" }
    ])
    expect(chat.transcript.items.some((item) => item.kind === "note")).toBe(false)
    expect(chat.entries).toEqual([{ kind: "undo", paths: ["math.js"] }])
  })

  it("targets a prompt's whole turn from its user row, newest call first", async () => {
    const cwd = scratch()
    put(cwd, "a.ts", "a\n")
    const r = recorder(cwd)
    r.prompt("first turn")
    r.cell()
    const one = await r.call("write", { path: "a.ts" }, write(cwd, "a.ts", "b\n"))
    r.settle()
    r.cell()
    const two = await r.call("write", { path: "a.ts" }, write(cwd, "a.ts", "c\n"))
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
    const firstUser = transcript.items.find((item) => item.kind === "user")!
    const target = Undo.target(transcript, firstUser.id) as Undo.Target
    expect(target.calls.map((call) => call.identity)).toEqual([two.identity, one.identity])
    expect(target.paths).toEqual(["a.ts"])
    const answer = transcript.items.find((item) => item.kind === "answer")!
    expect(Undo.target(transcript, answer.id)).toEqual({ _tag: "NothingToUndo" })
    const shell = Transcript.shell(
      transcript,
      { command: "ls", output: "", exitCode: 0, cancelled: false } as never,
      false,
      101
    )
    expect(Undo.target(shell, shell.items.at(-1)!.id)).toEqual({ _tag: "NothingToUndo" })
  })

  it("records the undo: restored transcript, summary row, context, and a second undo refuses", async () => {
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
    expect(cell.kind === "cell" && cell.calls[0]!.undone).toBe(true)
    expect(state.transcript.items.at(-1)).toMatchObject({ kind: "note", text: "Undid math.js" })
    expect(state.entries.at(-1)).toEqual({ kind: "undo", paths: ["math.js"] })
    expect(Context.system(cwd, state.entries).join("\n")).toContain("reverted earlier edits to: math.js")
    const row = Summary.panel(state.transcript).rows.find((each) => each.id === cell.id)!
    expect(row.label).toBe("Undone: Updated math.js")
    expect(row.status).toBe("cancelled")
    expect(Undo.target(state.transcript, cell.id)).toEqual({ _tag: "AlreadyUndone" })
  })

  it("marks creation and deletion with /dev/null", () => {
    expect(Changes.patch("n.ts", null, "x\n")!.patch).toContain("--- /dev/null")
    expect(Changes.patch("d.ts", "x\n", null)!.patch).toContain("+++ /dev/null")
    expect(Changes.patch("same", null, null)).toBeUndefined()
    expect(Changes.patch("run.sh", "x\n", null, 0o755)!.patch).toStartWith(
      "diff --git a/run.sh b/run.sh\ndeleted file mode 100755\n"
    )
  })

  it("refuses a plan over a bash call without touching the disk or asking the VCS", async () => {
    const cwd = scratch()
    put(cwd, "a.ts", "after\n")
    const call = {
      flow: "bash",
      identity: "shell",
      patches: [Changes.patch("a.ts", "before\n", "after\n")!]
    } as unknown as Parameters<typeof Undo.plan>[1]["calls"][number]
    let reads = 0
    const result = await Undo.plan(cwd, { calls: [call], paths: ["a.ts"] }, async () => {
      reads++
      return "after\n"
    })
    expect(result).toEqual({ _tag: "Uncaptured", flows: ["bash"] })
    expect(reads).toBe(0)
  })

  it("words failures in the fewest words", () => {
    expect(Undo.message({ _tag: "Busy" })).toBe("Stop running work first")
    expect(Undo.message({ _tag: "Conflict", paths: ["math.js", "b.ts"] })).toBe(
      "Not undone · changed since: math.js, b.ts"
    )
    expect(Undo.message({ _tag: "WriteFailed", path: "math.js", message: "EACCES", restored: false })).toBe(
      "Undo failed · math.js: EACCES · files partly changed"
    )
  })
})
