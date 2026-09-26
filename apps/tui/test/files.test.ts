import { expect, it } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Complete from "../src/complete.ts"
import * as Editor from "../src/editor.ts"
import * as Files from "../src/files.ts"
import * as Palette from "../src/palette.ts"

it("shows palette commands immediately and fills files after asynchronous enumeration", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "tui-files-"))
  const saved = process.env.PATH
  writeFileSync(join(cwd, "git"), "#!/bin/sh\n/bin/sleep 0.4\nprintf \"a.ts\\000\"\n", { mode: 0o755 })
  process.env.PATH = cwd
  try {
    let refreshed = 0
    const files = Files.lister(cwd, Date.now, () => refreshed++)
    const sources = { commands: Editor.commands, files, sessions: [], tabs: [], hits: [], now: Date.now() }
    const started = Date.now()
    const initial = Palette.rows(Palette.parse(""), sources)
    expect(Date.now() - started).toBeLessThan(200)
    expect(initial.every((row) => row.value.kind === "command")).toBe(true)
    expect(initial.length).toBe(Editor.commands.length)
    await Bun.sleep(10)
    expect(refreshed).toBe(0)
    for (let n = 0; n < 200 && refreshed === 0; n++) await Bun.sleep(10)
    expect(refreshed).toBe(1)
    expect(Palette.rows(Palette.parse(""), sources).at(-1)?.value).toEqual({ kind: "file", path: "a.ts" })
  } finally {
    process.env.PATH = saved
    rmSync(cwd, { recursive: true, force: true })
  }
})

it("times out file enumeration without blocking timers", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "tui-files-timeout-"))
  const saved = process.env.PATH
  for (const command of ["git", "rg"]) {
    writeFileSync(join(cwd, command), "#!/bin/sh\nexec /bin/sleep 0.4\n", { mode: 0o755 })
  }
  process.env.PATH = cwd
  try {
    let timerRan = false
    const timer = setTimeout(() => {
      timerRan = true
    }, 5)
    const started = Date.now()
    expect(await Files.list(cwd, 30)).toEqual([])
    expect(timerRan).toBe(true)
    expect(Date.now() - started).toBeLessThan(300)
    clearTimeout(timer)
  } finally {
    process.env.PATH = saved
    rmSync(cwd, { recursive: true, force: true })
  }
})

const awkward = [
  "café.txt",
  "日本語.txt",
  "my notes.md",
  "tab\there.txt",
  "new\nline.txt",
  "say \"hi\".txt",
  "back\\slash.txt",
  "bell\u0007.txt",
  "line.ts:12"
]

/** The path a mention names, read back the way a model or user would. */
const named = (mention: string): string => {
  const body = mention.slice(1, -1).replace(/(?<=^".*"|^[^"].*):\d+$/, "")
  return body.startsWith("\"") ? JSON.parse(body) : body
}

const which = (command: string) => execFileSync("/usr/bin/which", [command], { encoding: "utf8" }).trim()

const repository = (): string => {
  const cwd = mkdtempSync(join(tmpdir(), "tui-files-real-"))
  mkdirSync(join(cwd, "sub"))
  for (const name of awkward) writeFileSync(join(cwd, "sub", name), name)
  writeFileSync(join(cwd, ".gitignore"), "ignored.txt\n")
  writeFileSync(join(cwd, "ignored.txt"), "")
  return cwd
}

const expectExact = async (cwd: string, extra: string) => {
  const files = await Files.list(cwd)
  expect([...files].sort()).toEqual([extra, ...awkward.map((name) => `sub/${name}`)].sort())
  for (const path of files) {
    expect(existsSync(join(cwd, path))).toBe(true)
    expect(named(Complete.mention(path))).toBe(path)
    expect(named(Complete.mention(path, 3))).toBe(path)
  }
  // @ completion inserts a mention that names the existing file.
  for (const name of awkward) {
    const completion = Complete.complete(`@${name.slice(0, 2)}`, 3, { models: [], files: () => files })!
    const item = completion.items.find((each) => named(each.insert) === `sub/${name}`)!
    expect(readFileSync(join(cwd, named(item.insert)), "utf8")).toBe(name)
    expect(item.label).not.toMatch(/[\u0000-\u001f\u007f]/)
  }
  // Ctrl+K file rows carry the exact path Palette.mention inserts.
  const rows = Palette.rows(Palette.parse("café"), {
    commands: [],
    files: () => files,
    sessions: [],
    tabs: [],
    hits: [],
    now: 0
  })
  const row = rows.find((each) => each.value.kind === "file")!
  expect(row.value).toEqual({ kind: "file", path: "sub/café.txt" })
  expect(Palette.mention("sub/café.txt")).toBe("@sub/café.txt ")
}

it("lists Unicode, whitespace, quote, backslash, and control-character names exactly from git", async () => {
  const cwd = repository()
  try {
    execFileSync(which("git"), ["init", "-q"], { cwd })
    execFileSync(which("git"), ["add", "sub/café.txt", "sub/日本語.txt", "sub/tab\there.txt"], { cwd })
    // Tracked and untracked names both arrive unquoted; core.quotePath is on by default.
    expect(execFileSync(which("git"), ["ls-files"], { cwd, encoding: "utf8" })).toContain("\"sub/caf\\303\\251.txt\"")
    await expectExact(cwd, ".gitignore")
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

it("lists the same exact names from rg outside a repository", async () => {
  const cwd = repository()
  const bin = mkdtempSync(join(tmpdir(), "tui-files-bin-"))
  const saved = process.env.PATH
  symlinkSync(which("rg"), join(bin, "rg"))
  process.env.PATH = bin
  try {
    // Outside a repository rg skips hidden files and does not read .gitignore.
    await expectExact(cwd, "ignored.txt")
  } finally {
    process.env.PATH = saved
    rmSync(cwd, { recursive: true, force: true })
    rmSync(bin, { recursive: true, force: true })
  }
})

it("drops names that are not UTF-8 and repeated unmerged entries", () => {
  const stdout = Buffer.concat([Buffer.from("a.ts\0"), Buffer.from([0x62, 0xff, 0x00]), Buffer.from("a.ts\0café\0")])
  expect(Files.parse(stdout)).toEqual(["a.ts", "café"])
})
