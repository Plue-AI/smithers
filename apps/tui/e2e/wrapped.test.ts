/** A wrapped Claude Code worker: its own rows in the tab, t hands the terminal to its TUI, quitting it continues headless. */
import { expect, it } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { key, Tui } from "./tmux.ts"

const app = resolve(import.meta.dir, "..")

it(
  "runs /claude as a worker, takes it over into Claude Code's own TUI, and continues it headless on exit",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "tui-wrapped-"))
    const log = join(root, "argv.log")
    let tui: Tui | undefined
    try {
      tui = await Tui.start({
        cwd: root,
        cols: 110,
        rows: 34,
        command: `bun ${join(app, "e2e", "tabs-fixture.tsx")}`,
        env: {
          PATH: `${join(app, "test", "fixtures", "vendor")}:${process.env.PATH ?? ""}`,
          HOME: process.env.HOME ?? "",
          SMITHERS_TUI_SESSION_DIR: join(root, "s"),
          FAKE_VENDOR_LOG: log,
          FAKE_VENDOR_PAUSE: "3"
        }
      })
      await tui.until((screen) => screen.includes("Ask Smithers"), 20_000, "first draw")
      await tui.type("/claude Refresh the session cookie before retry")
      await tui.press(key.enter)
      await tui.press("\x1b[1;5C") // ctrl+right: Summary
      await tui.press("\x1b[1;5C") // the worker
      await tui.until(
        (screen) => screen.includes("claude · session") && screen.includes("⏺ Read(src/session.ts)"),
        10_000,
        "the worker draws Claude Code's own rows"
      )
      await tui.press("t")
      await tui.until((screen) => /claude session [0-9a-f-]{36}/.test(screen), 10_000, "Claude Code's own TUI")
      await tui.press(key.enter) // quit it
      await tui.until(
        (screen) => screen.includes("⇄ you released") && screen.includes("Refreshed the cookie before retry."),
        20_000,
        "continued headless to the end"
      )
      const argv = readFileSync(log, "utf8").trim().split("\n")
      expect(argv.map((line) => line.includes("-p ") ? "headless" : "tui")).toEqual(["headless", "tui", "headless"])
      expect(argv[2]).toContain("--resume")
    } finally {
      await tui?.stop()
      rmSync(root, { recursive: true, force: true })
    }
  },
  90_000
)
