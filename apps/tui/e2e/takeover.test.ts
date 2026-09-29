/** `t` takes over a running worker: each frame waits for the person's message; ctrl+y releases it to run on. */
import { expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { key, Tui } from "./tmux.ts"

const app = resolve(import.meta.dir, "..")

it("takes over a worker with t, drives a frame from the composer, and releases it with ctrl+y", async () => {
  const root = mkdtempSync(join(tmpdir(), "tui-take-"))
  let tui: Tui | undefined
  try {
    tui = await Tui.start({
      cwd: root,
      cols: 110,
      rows: 34,
      command: `bun ${join(app, "e2e", "tabs-fixture.tsx")}`,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", SMITHERS_TUI_SESSION_DIR: join(root, "s") }
    })
    await tui.until((screen) => screen.includes("Ask Smithers"), 20_000, "first draw")
    await tui.type("drive")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("Requested one worker."), 5_000, "delegated")
    await tui.press("\x1b[1;5C") // ctrl+right: Summary
    await tui.press("\x1b[1;5C") // the worker
    await tui.until(
      (screen) => screen.includes("Subagent · implement/session") && screen.includes("t Take over"),
      5_000,
      "worker tab"
    )
    await tui.press("t")
    await tui.until(
      (screen) => screen.includes("⇄ you drive") && screen.includes("Release (ctrl+y)") && screen.includes("⇄ driving"),
      5_000,
      "driving"
    )
    // A command stays a command while driving; only plain text goes to the worker.
    await tui.type("/hotkeys")
    await tui.press(key.enter)
    await tui.type("use the session cookie")
    await tui.press(key.enter)
    await tui.until(
      (screen) => /Frame \d: use the session cookie/.test(screen),
      15_000,
      "the frame ran with the message"
    )
    expect(tui.screen()).not.toMatch(/Frame \d: \/hotkeys/)
    await tui.press("\x19") // ctrl+y: release
    await tui.until(
      (screen) => screen.includes("⇄ you released") && screen.includes("Back (ctrl+y)"),
      5_000,
      "released"
    )
    await tui.until((screen) => screen.includes("Frame 4"), 15_000, "ran on to the end")
  } finally {
    await tui?.stop()
    rmSync(root, { recursive: true, force: true })
  }
}, 90_000)

it("takes over a worker with t from the Summary overview, where it waits under Needs you", async () => {
  const root = mkdtempSync(join(tmpdir(), "tui-take-"))
  let tui: Tui | undefined
  try {
    tui = await Tui.start({
      cwd: root,
      cols: 110,
      rows: 34,
      command: `bun ${join(app, "e2e", "tabs-fixture.tsx")}`,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", SMITHERS_TUI_SESSION_DIR: join(root, "s") }
    })
    await tui.until((screen) => screen.includes("Ask Smithers"), 20_000, "first draw")
    await tui.type("drive")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("Requested one worker."), 5_000, "delegated")
    await tui.press(key.ctrlS)
    await tui.until((screen) => screen.includes("Working 1"), 5_000, "overview")
    await tui.press("t")
    await tui.until((screen) => screen.includes("⇄ you drive"), 5_000, "taken over from the overview")
    await tui.click("Summary")
    await tui.until(
      (screen) => screen.includes("Needs you 1") && screen.includes("⇄ implement/session"),
      10_000,
      "waits for you"
    )
  } finally {
    await tui?.stop()
    rmSync(root, { recursive: true, force: true })
  }
}, 90_000)
