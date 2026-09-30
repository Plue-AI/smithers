/** Typed command routes through the real terminal and their durable receipts. */
import { afterEach, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { key, Tui } from "./tmux.ts"

const app = resolve(import.meta.dir, "..")
const pong = join(app, "test", "fixtures", "pong.jsonl")
const drawn = (screen: string) => /↑\S+ ↓\S+/.test(screen)
let tui: Tui | undefined
afterEach(async () => {
  await tui?.stop()
  tui = undefined
})

const project = () => {
  const root = mkdtempSync(join(tmpdir(), "tui-routes-"))
  const cwd = join(root, "project")
  const home = join(root, "home")
  const sessions = join(root, "sessions")
  mkdirSync(cwd)
  mkdirSync(home)
  writeFileSync(join(cwd, "math.js"), "export const add = (a, b) => a - b\n")
  return { cwd, home, sessions }
}

const start = async (where: ReturnType<typeof project>, command: string) => {
  tui = await Tui.start({
    cwd: where.cwd,
    command,
    env: {
      HOME: where.home,
      PATH: process.env.PATH ?? "",
      SMITHERS_TUI_SESSION_DIR: where.sessions,
      SMITHERS_TUI_REPLAY: pong,
      SMITHERS_TUI_REPLAY_SPEED: "100"
    }
  })
  await tui.until(drawn, 20_000, "first draw")
  return tui
}

const submit = async (text: string) => {
  await tui!.type(text)
  await tui!.press(key.enter)
}
/** Ctrl+K, the query once its row shows, Enter. */
const palette = async (query: string, row: RegExp) => {
  await tui!.press(key.ctrlK)
  await tui!.until((screen) => screen.includes("esc Back"), 5_000, "search open")
  await tui!.type(query)
  await tui!.until((screen) => row.test(screen), 5_000, `search row ${row}`)
  await tui!.press(key.enter)
}

interface Record {
  readonly type: string
  readonly text?: string
  readonly prompt?: string
  readonly outcome?: { readonly _tag: string; readonly answer?: string }
  readonly tab?: { readonly id: string; readonly status: string }
}

const files = (where: ReturnType<typeof project>): ReadonlyArray<string> => {
  const folder = readdirSync(where.sessions, { withFileTypes: true }).find((entry) => entry.isDirectory())
  if (folder === undefined) return []
  return readdirSync(join(where.sessions, folder.name)).filter((name) => name.endsWith(".jsonl")).map((name) =>
    join(where.sessions, folder.name, name)
  )
}
const records = (file: string): ReadonlyArray<Record> =>
  readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record)

it("Ctrl+K stop and resume settle and restart the named worker; the removed /retry keeps its line", async () => {
  const where = project()
  await start(where, `bun ${join(app, "e2e", "workspace-fixture.tsx")}`)
  await submit("/retry unknown-worker")
  await tui!.until(
    (screen) => screen.includes("Unknown command /retry") && screen.includes("/retry unknown-worker"),
    5_000,
    "removed command"
  )
  await tui!.press("\x15")
  await submit("investigate")
  await tui!.until(
    (screen) => screen.includes("Requested the investigation.") && /Investigation · \d+s/.test(screen),
    10_000,
    "worker running"
  )
  const [file] = files(where)
  expect(file).toBeDefined()
  await palette("stop investigation", /Stop\s+x\s+Investigation/)
  await tui!.until((screen) => screen.includes("Investigation · Stopped"), 5_000, "stopped worker")
  const statuses = () =>
    records(file!).filter((record) => record.type === "tab" && record.tab?.id === "investigation")
      .map((record) => record.tab!.status)
  expect(statuses().at(-1)).toBe("cancelled")
  await palette("resume investigation", /Resume\s+r\s+Investigation/)
  await tui!.until(
    (screen) => /Investigation · \d+s/.test(screen) && !screen.includes("Investigation · Stopped"),
    5_000,
    "retried worker"
  )
  await tui!.until(() => statuses().at(-1) === "running", 5_000, "saved retry")
  expect(statuses()).toContain("cancelled")
  await palette("stop investigation", /Stop\s+x\s+Investigation/)
  await tui!.until((screen) => screen.includes("Investigation · Stopped"), 5_000, "retried worker stopped")
  expect(statuses().filter((status) => status === "cancelled")).toHaveLength(2)
}, 45_000)

it("/resume restores the named conversation; /chat and ? act locally", async () => {
  const where = project()
  await start(where, `bun ${join(app, "src", "main.tsx")} ${where.cwd}`)
  await submit("/name saved route")
  await submit("remember route")
  await tui!.until((screen) => screen.includes("pong") && !screen.includes("esc Interrupt"), 15_000, "first answer")
  const [saved] = files(where)
  expect(saved).toBeDefined()
  await submit("/new")
  await tui!.until((screen) => screen.includes("New conversation started"), 5_000, "new conversation")
  await submit("fresh session")
  await tui!.until(
    (screen) => screen.includes("fresh session") && screen.includes("pong") && !screen.includes("esc Interrupt"),
    15_000,
    "fresh answer"
  )
  expect(files(where)).toHaveLength(2)
  await submit("/resume")
  await tui!.until((screen) => screen.includes("saved route"), 5_000, "saved conversation in picker")
  await tui!.type("saved route")
  await tui!.press(key.enter)
  await tui!.until(
    (screen) => screen.includes("Resumed") && screen.includes("remember route"),
    5_000,
    "restored conversation"
  )

  await submit("/summary")
  await tui!.until((screen) => screen.includes("esc Chat") && screen.includes("Asked:"), 5_000, "summary")
  await tui!.type("i")
  await tui!.until(
    (screen) => screen.includes("Asked: remember route") && !screen.includes("esc Chat"),
    5_000,
    "composer in summary"
  )
  await submit("/chat")
  await tui!.until(
    (screen) => screen.includes("remember route") && !screen.includes("esc Chat"),
    5_000,
    "chat restored"
  )

  await tui!.press("?")
  await tui!.until(
    (screen) => screen.includes("Previous model") && screen.includes("Pick model"),
    5_000,
    "keys in conversation"
  )
  await tui!.press("?")
  await tui!.until((screen) => !screen.includes("Pick model"), 5_000, "keys closed")
  await submit("after route")
  await tui!.until(
    (screen) => screen.includes("after route") && screen.includes("pong") && !screen.includes("esc Interrupt"),
    15_000,
    "second answer"
  )
  const savedRecords = records(saved!)
  expect(
    savedRecords.filter((record) => record.type === "outcome" && record.outcome?._tag === "done")
      .map((record) => record.prompt)
  ).toEqual(["remember route", "after route"])
  expect(savedRecords.some((record) => record.type === "user" && record.text?.startsWith("/"))).toBe(false)
}, 60_000)
