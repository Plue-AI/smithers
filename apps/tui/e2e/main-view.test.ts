import { expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { key, Tui } from "./tmux.ts"

for (const [cols, rows] of [[160, 50], [100, 40], [80, 30]] as const) {
  it(`renders a bound main tree and keeps typing at ${cols}x${rows}`, async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tui-main-"))
    const tui = await Tui.start({
      command: `${Bun.which("bun")!} ${join(import.meta.dir, "main-view-fixture.tsx")}`,
      cwd,
      rows,
      cols
    })
    try {
      await tui.until((screen) => screen.includes("Ask Smithers"))
      await tui.type("review this repo")
      await tui.press(key.enter)
      await tui.until(
        (screen) => screen.includes("Agent package") && screen.includes("TUI app") && screen.includes("Chat"),
        15_000
      )
      await tui.type("follow up")
      const screen = await tui.until((screen) => screen.includes("follow up"))
      const lines = screen.split("\n")
      const header = lines.find((line) =>
        /\bChat {2,}(?:‹ \d+ +)?(?:\S )?(?:Chat|Summary|Recursive review|Agent package|TUI app)\b/.test(line)
      )
      expect(header, screen).toBeDefined()
      expect(lines.some((line) => line.includes("Recursive review"))).toBe(true)
      expect(lines.some((line) => line.includes("Agent package"))).toBe(true)
      if (cols === 160) {
        expect(lines.some((line) => line.includes("Recursive review") && line.includes("Chat"))).toBe(true)
      }
      expect(screen).not.toContain("Tree: Recursive review")
      expect(screen).not.toContain("Recursive reviewRecursive review")
      const html = join(cwd, "main-view.html")
      const png = join(cwd, "main-view.png")
      const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
      if (existsSync(chrome)) {
        writeFileSync(html, await tui.html())
        const result = spawnSync(chrome, [
          "--headless",
          "--disable-gpu",
          "--no-sandbox",
          `--window-size=2100,1000`,
          `--screenshot=${png}`,
          `file://${html}`
        ], { encoding: "utf8" })
        expect(result.status).toBe(0)
      }
      await tui.press(key.ctrlBackslash)
      await tui.until((screen) => screen.includes("Chat") && !screen.includes("Review in progress."))
      await tui.type("again")
      await tui.press(key.enter)
      await tui.until((screen) => screen.includes("again"))
      expect(tui.screen()).not.toContain("Review in progress.")
    } finally {
      await tui.stop()
    }
  }, 60_000)
}
