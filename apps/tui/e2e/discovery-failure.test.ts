/**
 * A flow discovery failure is announced once, not re-posted by every session's
 * controller over that session's acknowledgment (#2083). The test breaks and
 * repairs the project's flows directory.
 */
import { afterEach, expect, it } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { key, Tui } from "./tmux.ts"

const app = resolve(import.meta.dir, "..")
const pong = join(app, "test", "fixtures", "pong.jsonl")
const failure = "Flows could not be listed"
const drawn = (screen: string) => /↑\S+ ↓\S+/.test(screen)
let tui: Tui | undefined
afterEach(async () => {
  await tui?.stop()
  tui = undefined
})

const start = async () => {
  const root = mkdtempSync(join(tmpdir(), "tui-discovery-"))
  const where = {
    cwd: join(root, "project"),
    sessions: join(root, "sessions"),
    flows: join(root, "project", "flows"),
    /** The working flows directory, moved into place to recover. */
    working: join(root, "project", "flows.working")
  }
  mkdirSync(where.cwd)
  mkdirSync(join(root, "home"))
  writeFileSync(join(where.cwd, "math.js"), "export const add = (a, b) => a - b\n")
  mkdirSync(join(where.working, "greet"), { recursive: true })
  symlinkSync(join(app, "node_modules"), join(where.cwd, "node_modules"), "dir")
  writeFileSync(
    join(where.working, "greet", "flow.ts"),
    `import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"
export default Flow.make("greet", {
  description: "Greets once", capabilities: [],
  effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "sealed" },
  payload: {}, success: Schema.String,
  body: () => Node.succeed("hi")
})
`
  )
  // A symlink to itself: listing cannot access the source root until the test replaces it.
  symlinkSync("flows", where.flows)
  tui = await Tui.start({
    cwd: where.cwd,
    command: `bun ${join(app, "src", "main.tsx")} ${where.cwd}`,
    env: {
      HOME: join(root, "home"),
      PATH: process.env.PATH ?? "",
      SMITHERS_TUI_SESSION_DIR: where.sessions,
      SMITHERS_TUI_REPLAY: pong,
      SMITHERS_TUI_REPLAY_SPEED: "100"
    }
  })
  await tui.until(drawn, 20_000, "first draw")
  await tui.until((screen) => screen.includes(failure), 20_000, "discovery failure")
  return where
}

/** Discovery failures the log recorded; each controller's listing adds one. */
const failures = (sessions: string): number => {
  const log = join(sessions, "tui.log")
  return existsSync(log)
    ? readFileSync(log, "utf8").split("\n").filter((line) => line.includes("flow.discovery")).length
    : 0
}

const submit = async (text: string) => {
  await tui!.type(text)
  await tui!.press(key.enter)
}

/** Runs `act`, waits until the next session's own listing failed, and returns the screen a moment later. */
const afterListing = async (sessions: string, act: () => Promise<void>, acknowledged: string) => {
  const before = failures(sessions)
  await act()
  await tui!.until((screen) => screen.includes(acknowledged), 5_000, acknowledged)
  await tui!.until(() => failures(sessions) > before, 20_000, "the next session's listing")
  await new Promise((resolve) => setTimeout(resolve, 500))
  return tui!.screen()
}

it("keeps New and Resumed acknowledgments over an unchanged discovery failure", async () => {
  const where = await start()
  await submit("/name saved route")
  await submit("remember route")
  await tui!.until((screen) => screen.includes("pong") && !screen.includes("esc Interrupt"), 15_000, "first answer")

  let screen = await afterListing(where.sessions, () => submit("/new"), "New conversation started")
  expect(screen).toContain("New conversation started")
  expect(screen).not.toContain(failure)

  screen = await afterListing(where.sessions, async () => {
    await submit("/resume")
    await tui!.until((text) => text.includes("saved route"), 5_000, "picker")
    await tui!.type("saved route")
    await tui!.press(key.enter)
  }, "Resumed")
  expect(screen).toContain("Resumed")
  expect(screen).not.toContain(failure)
}, 120_000)

it("announces a changed failure before any recovery", async () => {
  const where = await start()
  const screen = await afterListing(where.sessions, () => submit("/new"), "New conversation started")
  expect(screen).not.toContain(failure)
  // Not a directory: a different failure than the inaccessible one.
  rmSync(where.flows)
  writeFileSync(where.flows, "not a directory")
  await submit("/new")
  await tui!.until((text) => text.includes(failure), 20_000, "changed failure")
}, 90_000)

it("announces the same failure again after a successful listing", async () => {
  const where = await start()
  rmSync(where.flows)
  renameSync(where.working, where.flows)
  await submit("/new")
  await tui!.until((screen) => screen.includes("New conversation started"), 5_000, "new conversation")
  await tui!.type("/flow ")
  await tui!.until((screen) => screen.includes("Greets once"), 20_000, "a successful listing")
  await tui!.press(key.escape)
  await tui!.press(key.backspace.repeat(6))
  renameSync(where.flows, where.working)
  symlinkSync("flows", where.flows)
  await submit("/new")
  await tui!.until((screen) => screen.includes(failure), 20_000, "failure after recovery")
}, 90_000)
