/** A worker stopped at its run cap says so in its toast with Raise cap, which opens the cap form. */
import { it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { key, Tui } from "./tmux.ts"

const app = resolve(import.meta.dir, "..")

it("offers Raise cap on a capped worker's toast, and the button opens its cap form", async () => {
  const root = mkdtempSync(join(tmpdir(), "tui-moments-"))
  let tui: Tui | undefined
  try {
    tui = await Tui.start({
      cwd: root,
      cols: 110,
      rows: 30,
      command: `bun ${join(app, "e2e", "tabs-fixture.tsx")}`,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", SMITHERS_TUI_SESSION_DIR: join(root, "s") }
    })
    await tui.until((screen) => screen.includes("Ask Smithers"), 20_000, "first draw")
    await tui.type("cap")
    await tui.press(key.enter)
    await tui.until(
      (screen) => screen.includes("flaky seat queue") && screen.includes("Raise cap"),
      10_000,
      "the toast"
    )
    await tui.click("Raise cap")
    await tui.until(
      (screen) => /Cap\s+200/.test(screen) && screen.includes("200 of 200 tokens used"),
      5_000,
      "the cap form"
    )
    await tui.press(key.ctrlS)
    await tui.until((screen) => screen.includes("Needs you 1"), 5_000, "overview")
    await tui.press(" ")
    // The peek names the outcome and its cause (tabs.ts outcome).
    await tui.until(
      (screen) => screen.includes("failed: Token budget reached"),
      5_000,
      "the outcome in the peek"
    )
  } finally {
    await tui?.stop()
    rmSync(root, { recursive: true, force: true })
  }
}, 60_000)
