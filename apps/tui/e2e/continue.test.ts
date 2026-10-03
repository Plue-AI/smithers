import { expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { key, Tui } from "./tmux.ts"

const fixture = join(resolve(import.meta.dir, ".."), "e2e", "continue-fixture.tsx")

for (const status of ["done", "failed", "stopped"] as const) {
  it(`continues a ${status} worker from its tab and keeps chat usable`, async () => {
    const root = mkdtempSync(join(tmpdir(), "tui-continue-"))
    let tui: Tui | undefined
    try {
      tui = await Tui.start({
        cwd: root,
        cols: 110,
        rows: 34,
        command: `bun ${fixture}`,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          SMITHERS_TUI_SESSION_DIR: join(root, "sessions")
        }
      })
      await tui.until((screen) => screen.includes("Ask Smithers"), 20_000, "first draw")
      await tui.type(`start ${status}`)
      await tui.press(key.enter)
      await tui.until((screen) => screen.includes("Review ·"), 5_000, "worker card")
      await tui.click("Review")
      await tui.until((screen) => screen.includes("Subagent · Review"), 5_000, "worker tab")
      if (status === "stopped") {
        await tui.press("x")
        await tui.until((screen) => screen.includes("Stopped"), 5_000, "worker stopped")
      } else if (status === "failed") {
        await tui.until((screen) => screen.includes("Worker stopped unexpectedly"), 5_000, "worker failed")
      } else {
        await tui.until((screen) => screen.includes("Initial answer"), 5_000, "worker finished")
      }
      await tui.until((screen) => screen.includes("Continue Review"), 5_000, "continuation placeholder")
      await tui.press("i")
      await tui.type("check another case")
      await tui.until((screen) => /┃\s+check another case/.test(screen), 5_000, "continuation draft")
      await tui.press(key.enter)
      const continued = await tui.until(
        (screen) => screen.includes("Continued: check another case"),
        5_000,
        "same worker continued"
      )
      expect(continued).toContain("Subagent · Review")
      expect(continued).not.toContain("Chat handled: check another case")
      await tui.type("/chat")
      await tui.press(key.enter)
      await tui.until(
        (screen) => screen.includes("Review ·") && !screen.includes("Back (ctrl+y)"),
        5_000,
        "chat tab"
      )
      await tui.type("chat check")
      await tui.press(key.enter)
      await tui.until((screen) => screen.includes("Chat handled: chat check"), 5_000, "chat still works")
    } finally {
      await tui?.stop()
      rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)
}
