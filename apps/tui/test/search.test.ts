import { describe, expect, it } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Search from "../src/search.ts"

const waitFor = async (condition: () => boolean): Promise<void> => {
  const deadline = Date.now() + 6_000
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("Search child did not reach the expected state")
    await Bun.sleep(10)
  }
}

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
  }, 15_000)

  it("treats dots literally unless a regex is given", async () => {
    const literal = await Search.run({ cwd, query: "a.b" }).done
    expect(literal._tag === "done" ? literal.hits : undefined).toEqual([])
    const regex = await Search.run({ cwd, query: "/a.b/", regex: "a.b" }).done
    expect(regex._tag === "done" ? regex.hits.map((hit) => hit.path) : undefined).toContain("dots.txt")
  }, 15_000)

  it("keeps a colon inside a path", async () => {
    const outcome = await Search.run({ cwd, query: "needle" }).done
    expect(outcome._tag === "done" ? outcome.hits : undefined).toEqual([{
      path: "we:ird.js",
      line: 1,
      text: "needle here"
    }])
  }, 15_000)

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
  }, 15_000)

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
  }, 15_000)

  it("stops at the cap and says so", async () => {
    const outcome = await Search.run({ cwd, query: "repeated", limit: 50 }).done
    expect(outcome._tag).toBe("done")
    if (outcome._tag !== "done") return
    expect(outcome.hits).toHaveLength(50)
    expect(outcome.truncated).toBe(true)
  }, 15_000)

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
  }, 15_000)

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
    const running = Search.run({ cwd, query: "x", command: shim })
    running.cancel()
    running.cancel()
    expect(await running.done).toEqual({ _tag: "cancelled" })
  }, 15_000)

  it("regression: child PID cancellation waits for readiness and reaping in a path with spaces", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tui slow rg-"))
    const shim = join(dir, "rg")
    const pidFile = join(dir, "pid")
    const reapedFile = join(dir, "reaped")
    const parentPidFile = join(dir, "parent-pid")
    const childScript = join(dir, "child.cjs")
    const parentScript = join(dir, "parent.cjs")
    // The child announces readiness after installing its signal handler. Its
    // parent stays alive to reap it, making PID disappearance meaningful.
    writeFileSync(
      childScript,
      `
const { writeFileSync, renameSync } = require("node:fs")
process.on("SIGTERM", () => process.exit(0))
writeFileSync("pid.tmp", String(process.pid))
renameSync("pid.tmp", "pid")
setInterval(() => {}, 1000)
`
    )
    writeFileSync(
      parentScript,
      `
const { spawn } = require("node:child_process")
const { writeFileSync, renameSync } = require("node:fs")
process.on("SIGTERM", () => {})
writeFileSync("parent-pid.tmp", String(process.pid))
renameSync("parent-pid.tmp", "parent-pid")
const child = spawn(process.execPath, ["child.cjs"], { stdio: "inherit" })
child.on("exit", (code, signal) => {
  writeFileSync("reaped.tmp", JSON.stringify({ pid: child.pid, code, signal }))
  renameSync("reaped.tmp", "reaped")
  process.exit(0)
})
`
    )
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
    writeFileSync(shim, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(parentScript)}\n`)
    chmodSync(shim, 0o755)
    const running = Search.run({ cwd: dir, query: "x", command: shim })
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0)
        return true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
        return false
      }
    }
    let pid = 0
    try {
      await waitFor(() => existsSync(pidFile))
      pid = Number(readFileSync(pidFile, "utf8").trim())
      expect(pid).toBeGreaterThan(0)
      expect(alive(pid)).toBe(true)
      running.cancel()
      expect(await running.done).toEqual({ _tag: "cancelled" })
      await waitFor(() => existsSync(reapedFile))
      expect(JSON.parse(readFileSync(reapedFile, "utf8"))).toEqual({ pid, code: 0, signal: null })
      await waitFor(() => !alive(pid))
      expect(alive(pid)).toBe(false)
    } finally {
      running.cancel()
      await running.done
      // Cleanup must also work when process-group creation itself regresses.
      if (!existsSync(reapedFile)) {
        for (const file of [pidFile, parentPidFile]) {
          if (!existsSync(file)) continue
          const ownedPid = Number(readFileSync(file, "utf8"))
          try {
            process.kill(ownedPid, "SIGKILL")
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
          }
        }
      }
      rmSync(dir, { recursive: true, force: true })
    }
  }, 15_000)

  it("returns no hits, not a failure, when nothing matches", async () => {
    expect(await Search.run({ cwd, query: "zzz-not-here" }).done).toEqual({ _tag: "done", hits: [], truncated: false })
  }, 15_000)
})
