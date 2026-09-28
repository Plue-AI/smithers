import { describe, expect, it } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Search from "../src/search.ts"

const tree = () => {
  const cwd = mkdtempSync(join(tmpdir(), "tui-search-"))
  writeFileSync(join(cwd, "math.js"), "export const add = (a, b) => a - b\n")
  writeFileSync(join(cwd, "dots.txt"), "axb\n")
  writeFileSync(join(cwd, "we:ird.js"), "needle here\n")
  mkdirSync(join(cwd, "many"))
  for (let file = 0; file < 30; file++) {
    writeFileSync(join(cwd, "many", `f${file}.txt`), Array.from({ length: 10 }, () => "repeated").join("\n") + "\n")
  }
  return cwd
}

describe("rg search", () => {
  const cwd = tree()

  it("finds a literal by default", async () => {
    const outcome = await Search.run({ cwd, query: "a - b" }).done
    expect(outcome._tag).toBe("done")
    if (outcome._tag !== "done") return
    expect(outcome.hits).toHaveLength(1)
    expect(outcome.hits[0]).toMatchObject({ path: "math.js", line: 1 })
    expect(outcome.hits[0]!.text).toContain("a - b")
    expect(outcome.truncated).toBe(false)
  })

  it("treats dots literally unless a regex is given", async () => {
    const literal = await Search.run({ cwd, query: "a.b" }).done
    expect(literal._tag === "done" ? literal.hits : undefined).toEqual([])
    const regex = await Search.run({ cwd, query: "/a.b/", regex: "a.b" }).done
    expect(regex._tag === "done" ? regex.hits.map((hit) => hit.path) : undefined).toContain("dots.txt")
  })

  it("keeps a colon inside a path", async () => {
    const outcome = await Search.run({ cwd, query: "needle" }).done
    expect(outcome._tag === "done" ? outcome.hits : undefined).toEqual([{
      path: "we:ird.js",
      line: 1,
      text: "needle here"
    }])
  })

  it("finds hits in files with newline, tab, Unicode, quote, and backslash names, keeping exact paths", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tui-search-odd-"))
    const names = ["new\nline.txt", "tab\there.txt", "café 日本.txt", "say \"hi\".txt", "back\\slash.txt"]
    for (const name of names) writeFileSync(join(dir, name), `a\tpin "q" \\ é\n`)
    const outcome = await Search.run({ cwd: dir, query: "pin" }).done
    expect(outcome._tag).toBe("done")
    if (outcome._tag !== "done") return
    expect(outcome.hits.map((hit) => hit.path).sort()).toEqual([...names].sort())
    for (const hit of outcome.hits) {
      expect(readFileSync(join(dir, hit.path), "utf8")).toContain("pin")
      expect(hit).toMatchObject({ line: 1, text: "a\tpin \"q\" \\ é" })
    }
  })

  it("decodes rg's base64 bytes, caps line text, and skips a path it cannot name exactly", () => {
    const b64 = (bytes: Buffer) => bytes.toString("base64")
    const match = (path: object, lines: object) =>
      JSON.stringify({ type: "match", data: { path, lines, line_number: 7 } })
    expect(
      Search.parse(
        match({ bytes: b64(Buffer.from("./café.txt")) }, { bytes: b64(Buffer.from([0x70, 0x69, 0x6e, 0xff, 0x0a])) })
      )
    )
      .toEqual({ path: "café.txt", line: 7, text: "pin\ufffd" })
    expect(Search.parse(match({ bytes: b64(Buffer.from([0x62, 0xff])) }, { text: "pin\n" }))).toBeUndefined()
    expect(Search.parse(match({ text: "./long.txt" }, { text: `${"x".repeat(300)}\n` }))?.text).toHaveLength(200)
    expect(Search.parse(JSON.stringify({ type: "begin", data: { path: { text: "a" } } }))).toBeUndefined()
    expect(Search.parse("not json")).toBeUndefined()
  })

  it("keeps more than twenty matches from one file until the global cap", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tui-search-one-file-"))
    writeFileSync(join(dir, "matches.txt"), "needle\n".repeat(75))
    const complete = await Search.run({ cwd: dir, query: "needle" }).done
    expect(complete._tag).toBe("done")
    if (complete._tag !== "done") return
    expect(complete.hits).toHaveLength(75)
    expect(complete.hits.at(-1)?.line).toBe(75)
    expect(complete.truncated).toBe(false)
    const capped = await Search.run({ cwd: dir, query: "needle", limit: 50 }).done
    expect(capped._tag === "done" ? capped.hits.length : undefined).toBe(50)
    expect(capped._tag === "done" && capped.truncated).toBe(true)
  })

  it("stops at the cap and says so", async () => {
    const outcome = await Search.run({ cwd, query: "repeated", limit: 50 }).done
    expect(outcome._tag).toBe("done")
    if (outcome._tag !== "done") return
    expect(outcome.hits).toHaveLength(50)
    expect(outcome.truncated).toBe(true)
  })

  it("types a bad pattern", async () => {
    expect(await Search.run({ cwd, query: "/(/", regex: "(" }).done).toMatchObject({
      _tag: "failed",
      reason: "bad-pattern",
      message: "unclosed group"
    })
  })

  it("reports a missing rg executable from a valid working directory", async () => {
    expect(await Search.run({ cwd, query: "x", command: "rg-does-not-exist" }).done).toMatchObject({
      _tag: "failed",
      reason: "missing-rg"
    })
  })

  it("reports a missing working directory and can retry after it is created", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "tui-search-missing-cwd-")), "later")
    expect(existsSync(dir)).toBe(false)
    const outcome = await Search.run({ cwd: dir, query: "needle" }).done
    expect(outcome).toMatchObject({ _tag: "failed", reason: "rg-error" })
    if (outcome._tag !== "failed") return
    expect(outcome.message).toContain(dir)

    mkdirSync(dir)
    writeFileSync(join(dir, "found.txt"), "needle\n")
    expect(await Search.run({ cwd: dir, query: "needle" }).done).toEqual({
      _tag: "done",
      hits: [{ path: "found.txt", line: 1, text: "needle" }],
      truncated: false
    })
  })

  it("reports a regular file used as the working directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tui-search-file-cwd-"))
    const file = join(dir, "not-a-directory")
    writeFileSync(file, "needle\n")
    const outcome = await Search.run({ cwd: file, query: "needle" }).done
    expect(outcome).toMatchObject({ _tag: "failed", reason: "rg-error" })
    if (outcome._tag !== "failed") return
    expect(outcome.message).toContain(file)
  })

  it("resolves cancelled once when cancelled before rg finishes", async () => {
    const shim = join(mkdtempSync(join(tmpdir(), "tui-slow-rg-")), "rg")
    writeFileSync(shim, "#!/bin/sh\nsleep 30\n")
    chmodSync(shim, 0o755)
    const started = Date.now()
    const running = Search.run({ cwd, query: "x", command: shim })
    running.cancel()
    running.cancel()
    expect(await running.done).toEqual({ _tag: "cancelled" })
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it("kills rg and its children on cancel", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tui-slow-rg-"))
    const shim = join(dir, "rg")
    const pidFile = join(dir, "pid")
    // A grandchild, so only a process-group kill reaches it.
    writeFileSync(shim, `#!/bin/sh\nsleep 30 &\necho $! > ${pidFile}\nwait\n`)
    chmodSync(shim, 0o755)
    const running = Search.run({ cwd, query: "x", command: shim })
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }
    let pid = 0
    for (let tries = 0; tries < 100 && pid === 0; tries++) {
      await Bun.sleep(20)
      pid = existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8").trim()) : 0
    }
    expect(pid).toBeGreaterThan(0)
    expect(alive(pid)).toBe(true)
    running.cancel()
    for (let tries = 0; tries < 100 && alive(pid); tries++) await Bun.sleep(20)
    expect(alive(pid)).toBe(false)
  })

  it("returns no hits, not a failure, when nothing matches", async () => {
    expect(await Search.run({ cwd, query: "zzz-not-here" }).done).toEqual({ _tag: "done", hits: [], truncated: false })
  })
})
