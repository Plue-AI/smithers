/**
 * Durable follow-ups, interrupted turns and the single `!cmd` slot, in a real
 * PTY (#1982, #1983, #1984). The session file is read after every step: the
 * screen alone never proves a receipt was kept.
 */
import { afterEach, describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import * as Session from "../src/session.ts"
import { key, Tui } from "./tmux.ts"

const app = resolve(import.meta.dir, "..")
const fixture = join(app, "test", "fixtures", "fix-add.jsonl")
const drawn = (screen: string) => /↑\S+ ↓\S+/.test(screen)
const idle = (screen: string) => drawn(screen) && !screen.includes("esc Interrupt") && !/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] \d/.test(screen)
const altEnter = "\x1b\r"
const altUp = "\x1b[1;3A"

let tui: Tui | undefined
afterEach(async () => {
  await tui?.stop()
  tui = undefined
})

const repository = () => {
  const directory = mkdtempSync(join(tmpdir(), "tui-repo-"))
  writeFileSync(join(directory, "math.js"), "export const add = (a, b) => a - b\n")
  writeFileSync(
    join(directory, "check.mjs"),
    "import { add } from \"./math.js\"\nif (add(2, 3) !== 5) { console.error(\"add is wrong\"); process.exit(1) }\nconsole.log(\"ok\")\n"
  )
  return directory
}

const start = async (
  options: { readonly cwd: string; readonly sessions: string; readonly holdMs?: number; readonly args?: string }
) => {
  tui = await Tui.start({
    cwd: options.cwd,
    command: `bun ${join(app, "src", "main.tsx")} ${options.cwd} ${options.args ?? ""}`,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      SMITHERS_TUI_REPLAY: fixture,
      SMITHERS_TUI_REPLAY_HOLD_MS: String(options.holdMs ?? 0),
      SMITHERS_TUI_REPLAY_SPEED: "20",
      SMITHERS_TUI_SESSION_DIR: options.sessions
    }
  })
  await tui.until(drawn, 20_000, "first draw")
  return tui
}

/** Every chat session file under the root, newest last. */
const chats = (sessions: string): ReadonlyArray<string> =>
  readdirSync(sessions, { withFileTypes: true }).filter((entry) => entry.isDirectory()).flatMap((folder) =>
    readdirSync(join(sessions, folder.name)).filter((name) => name.endsWith(".jsonl")).map((name) =>
      join(sessions, folder.name, name)
    )
  ).sort()
const records = (file: string) => Session.load(file).filter((record) => record.type !== "event")
const pending = (file: string) => Session.restore(Session.load(file)).queued.map((prompt) => prompt.text)
const interruptions = (file: string) =>
  records(file).filter((record) => record.type === "outcome" && record.outcome._tag === "interrupted").length
/** Processes whose command line holds `marker`: a cancelled `!cmd` leaves none. */
const processes = (marker: string) =>
  spawnSync("pgrep", ["-f", marker], { encoding: "utf8" }).stdout.split("\n").filter((line) => line.trim() !== "")

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe("follow-up queue and interrupted turns across a restart", () => {
  it("keeps queued follow-ups, settles the lost turn once, and restores the queue to the editor", async () => {
    const cwd = repository()
    const sessions = mkdtempSync(join(tmpdir(), "tui-sessions-"))
    let screen = await start({ cwd, sessions, holdMs: 60_000 })
    await screen.type("first slow turn")
    await screen.press(key.enter)
    await screen.until((text) => text.includes("alt+enter to queue"), 10_000, "running turn")
    await screen.type("queued survive restart 123")
    await screen.press(altEnter)
    await screen.type("queued second 456")
    await screen.press(altEnter)
    await screen.until((text) => text.includes("Follow-up: queued second 456"), 5_000, "two follow-ups")
    const [file] = chats(sessions)
    expect(pending(file!)).toEqual(["queued survive restart 123", "queued second 456"])
    expect(interruptions(file!)).toBe(0)

    // The process dies mid-turn: nothing writes its outcome.
    const processInfo = { pid: screen.pid }
    process.kill(-processInfo.pid, "SIGKILL")
    await screen.waitForExit()
    await screen.stop()
    tui = undefined
    screen = await start({ cwd, sessions, holdMs: 60_000, args: "-c" })
    const restored = await screen.until(
      (text) => text.includes("Interrupted") && text.includes("Follow-up: queued second 456") && idle(text),
      10_000,
      "interrupted turn and its queue"
    )
    expect(restored).toContain("Follow-up: queued survive restart 123")
    expect(restored).toContain("first slow turn")
    expect(restored).not.toContain("esc Interrupt")
    expect(chats(sessions)).toEqual([file!])
    await screen.until(() => interruptions(file!) === 1, 5_000, "interrupted receipt")

    // A second restart reads the receipt; it neither adds another nor drops the queue.
    await screen.stop()
    tui = undefined
    screen = await start({ cwd, sessions, holdMs: 60_000, args: "-c" })
    await screen.until((text) => text.includes("Follow-up: queued second 456") && idle(text), 10_000, "second restart")
    expect(interruptions(file!)).toBe(1)
    expect(pending(file!)).toEqual(["queued survive restart 123", "queued second 456"])

    await screen.press(altUp)
    const editor = await screen.until(
      (text) => text.includes("Restored 2 queued messages"),
      5_000,
      "back to the editor"
    )
    expect(editor).not.toContain("Follow-up:")
    expect(editor).toMatch(/┃\s+queued survive restart 123/)
    expect(editor.indexOf("queued survive restart 123")).toBeLessThan(editor.indexOf("queued second 456"))
    expect(pending(file!)).toEqual([])
    expect(
      records(file!).filter((record) => record.type === "dequeued").map((record) =>
        record.type === "dequeued" && record.reason
      )
    )
      .toEqual(["restored", "restored"])
  }, 120_000)

  it("a fresh session starts with an empty queue and leaves the old one on disk", async () => {
    const cwd = repository()
    const sessions = mkdtempSync(join(tmpdir(), "tui-sessions-"))
    let screen = await start({ cwd, sessions, holdMs: 60_000 })
    await screen.type("first slow turn")
    await screen.press(key.enter)
    await screen.until((text) => text.includes("alt+enter to queue"), 10_000, "running turn")
    await screen.type("kept for the old session")
    await screen.press(altEnter)
    await screen.until((text) => text.includes("Follow-up: kept for the old session"), 5_000, "queued")
    await screen.stop()
    tui = undefined
    screen = await start({ cwd, sessions, holdMs: 60_000, args: "-c" })
    await screen.until((text) => text.includes("Follow-up: kept for the old session") && idle(text), 10_000, "restored")
    await screen.type("/new")
    await screen.press(key.enter)
    await screen.until(
      (text) => text.includes("New conversation started") && !text.includes("Follow-up:"),
      5_000,
      "fresh"
    )
    await screen.type("!echo fresh-row")
    await screen.press(key.enter)
    await screen.until((text) => /fresh-row[\s\S]*fresh-row/.test(text), 10_000, "fresh session writes")
    const [old, fresh] = chats(sessions)
    expect(pending(old!)).toEqual(["kept for the old session"])
    expect(records(fresh!).some((record) => record.type === "queued" || record.type === "dequeued")).toBe(false)
  }, 120_000)

  it("starts the oldest follow-up when the turn ends, recording its dequeue before its prompt", async () => {
    const cwd = repository()
    const sessions = mkdtempSync(join(tmpdir(), "tui-sessions-"))
    const screen = await start({ cwd, sessions, holdMs: 1_000 })
    await screen.type("node check.mjs fails. Fix it and show it passes.")
    await screen.press(key.enter)
    await screen.until((text) => text.includes("alt+enter to queue"), 10_000, "running turn")
    await screen.type("follow up 789")
    await screen.press(altEnter)
    await screen.until((text) => text.includes("Follow-up: follow up 789"), 5_000, "queued")
    const [file] = chats(sessions)
    await screen.until(
      () => records(file!).some((record) => record.type === "user" && record.text === "follow up 789"),
      90_000,
      "follow-up turn"
    )
    const kept = records(file!).filter((record) =>
      record.type === "user" || record.type === "outcome" || record.type === "queued" || record.type === "dequeued"
    )
    expect(kept.map((record) => record.type)).toEqual(["user", "queued", "outcome", "dequeued", "user"])
    expect(pending(file!)).toEqual([])
    await screen.press(key.escape)
    await screen.until((text) => text.includes("■ stopped") && idle(text), 10_000, "stopped")
  }, 120_000)
})

describe("one !cmd at a time", () => {
  it("refuses a second command in the same input batch, and esc stops the first's child", async () => {
    const cwd = repository()
    const screen = await start({ cwd, sessions: mkdtempSync(join(tmpdir(), "tui-sessions-")) })
    await screen.press("!sleep 5.137; printf ONE > race-one.txt\r!printf TWO > race-two.txt\r")
    await screen.until((text) => text.includes("A shell command is already running"), 5_000, "refusal")
    await wait(500)
    expect(existsSync(join(cwd, "race-two.txt"))).toBe(false)
    expect(processes("sleep 5.137").length).toBeGreaterThan(0)
    await screen.press(key.escape)
    await screen.until((text) => text.includes("(cancelled)"), 5_000, "cancelled")
    await wait(500)
    expect(processes("sleep 5.137")).toEqual([])
    expect(existsSync(join(cwd, "race-one.txt"))).toBe(false)
    expect(existsSync(join(cwd, "race-two.txt"))).toBe(false)
  }, 60_000)

  it("refuses /new typed in the same batch as a !cmd", async () => {
    const cwd = repository()
    const sessions = mkdtempSync(join(tmpdir(), "tui-sessions-"))
    const screen = await start({ cwd, sessions })
    await screen.press("!sleep 5.241\r/new\r")
    await screen.until((text) => text.includes("Stop running work first"), 5_000, "refusal")
    expect(screen.screen()).toContain("$ sleep 5.241")
    await screen.press(key.escape)
    await screen.until((text) => text.includes("(cancelled)"), 5_000, "cancelled")
    await wait(500)
    expect(processes("sleep 5.241")).toEqual([])
    expect(chats(sessions)).toHaveLength(1)
  }, 60_000)
})
