import { afterAll, expect, it } from "@effect/vitest"
import * as Model from "@smthrs/model/Model"
import * as ModelEvent from "@smthrs/model/ModelEvent"
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { main } from "../src/25-agent-tools-in-sandbox.ts"

const directory = mkdtempSync(join(tmpdir(), "flows-examples-"))

const cellModel = (cell: string) => Model.make({
  stream: () => Stream.fromIterable([
    ModelEvent.ModelEvent.TextStart({ type: "text-start", id: "cell" }),
    ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id: "cell", text: "```cell\n" + cell + "\n```" }),
    ModelEvent.ModelEvent.TextEnd({ type: "text-end", id: "cell" }),
    ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })
  ])
})

afterAll(() => rmSync(directory, { recursive: true, force: true }))

it.effect("runs the model's cell in the sandbox and lets it reach real files", () =>
  Effect.gen(function*() {
    const summary = yield* main(join(directory, "audit.sqlite"), join(directory, "repo"))

    // The answer is schema-typed all the way out: no caller parses model text.
    expect(summary.tally.totalLines).toBe(3)
    expect(summary.tally.wrotePath).toBe("line-count.txt")
    expect(summary.tally.bytesWritten).toBe(2)

    // The cell's write landed on the real disk, which is the point of binding a
    // real FileSystem rather than a fake one.
    expect(summary.written).toBe("3\n")

    // The paths reached the model through the prompt rather than being baked
    // into the script.
    expect(summary.asked).toEqual([
      "notes.md -> line-count.txt"
    ])

    expect(summary.eventTypes).toContain("flows.engine.attempt-started")
  }), { timeout: 60_000 })

for (const attack of ["absolute", "traversal", "file-link", "directory-link", "dangling-link", "hard-link", "absolute-inside"]) {
  it.effect(`refuses ${attack} reads and writes through ctx.call`, () =>
    Effect.gen(function*() {
      const base = join(directory, attack)
      const root = join(base, "repo")
      mkdirSync(root, { recursive: true, mode: 0o700 })
      chmodSync(root, 0o700)
      const sentinel = join(base, "sentinel.txt")
      writeFileSync(sentinel, "outside-marker")
      symlinkSync(sentinel, join(root, "file-link"))
      symlinkSync(base, join(root, "directory-link"))
      symlinkSync(join(base, "missing"), join(root, "dangling-link"))
      linkSync(sentinel, join(root, "hard-link"))
      const path = {
        absolute: sentinel,
        "absolute-inside": join(root, "notes.md"),
        "hard-link": "hard-link",
        traversal: "../sentinel.txt",
        "file-link": "file-link",
        "directory-link": "directory-link/sentinel.txt",
        "dangling-link": "dangling-link/new.txt"
      }[attack]!
      const cell = `
const read = await ctx.call("read", { path: ${JSON.stringify(path)} });
const write = await ctx.call("write", { path: ${JSON.stringify(path)}, content: "overwritten-outside" });
ctx.done({ totalLines: read.ok === false ? 0 : 1, bytesWritten: write.ok === false ? 0 : 1, wrotePath: "probe" });`
      const model = cellModel(cell)
      // main reads its expected output back after the probe cell settles.
      writeFileSync(join(root, "line-count.txt"), "unchanged")
      const summary = yield* main(join(base, "audit.sqlite"), root, model)
      expect(summary.tally.totalLines).toBe(0)
      expect(summary.tally.bytesWritten).toBe(0)
      expect(readFileSync(sentinel, "utf8")).toBe("outside-marker")
      expect(existsSync(join(base, "missing"))).toBe(false)
    }), { timeout: 60_000 })
}

it.effect("creates nested files and overwrites existing files inside root through ctx.call", () =>
  Effect.gen(function*() {
    const root = join(directory, "nested")
    const summary = yield* main(join(directory, "nested.sqlite"), root, cellModel(`
await ctx.call("write", { path: "sub/count.txt", content: "first" });
const written = await ctx.call("write", { path: "sub/count.txt", content: "one\\ntwo" });
const page = await ctx.call("read", { path: "sub/count.txt" });
await ctx.call("write", { path: "line-count.txt", content: String(page.totalLines) });
ctx.done({ totalLines: page.totalLines, wrotePath: written.path, bytesWritten: written.bytesWritten });`))
    expect(summary.tally).toEqual({ totalLines: 2, wrotePath: "sub/count.txt", bytesWritten: 7 })
    expect(summary.written).toBe("2")
    expect(readFileSync(join(root, "sub/count.txt"), "utf8")).toBe("one\ntwo")
  }), { timeout: 60_000 })

for (const mode of [0o777, 0o755, 0o710]) {
  it.effect(`refuses a scratch root with mode ${mode.toString(8)} that other users may reach`, () =>
    Effect.gen(function*() {
      const root = join(directory, `shared-root-${mode.toString(8)}`)
      mkdirSync(root, { recursive: true })
      chmodSync(root, mode)
      const refused = yield* Effect.exit(main(join(directory, `shared-root-${mode.toString(8)}.sqlite`), root))
      expect(refused._tag).toBe("Failure")
      expect(String(refused)).toContain("grant no group or other permissions")
      expect(existsSync(join(root, "notes.md"))).toBe(false)
    }), { timeout: 60_000 })
}
