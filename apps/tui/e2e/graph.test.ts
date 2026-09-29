/** `g` in the Summary overview draws the selected row's run forest; `g` again returns to the list. */
import { it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { key, Tui } from "./tmux.ts"

const app = resolve(import.meta.dir, "..")

it("draws a worker and the agent it spawned as boxes joined by an edge, and toggles back", async () => {
  const root = mkdtempSync(join(tmpdir(), "tui-graph-"))
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
    await tui.type("delegate")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("Requested three workers."), 5_000, "delegated")
    await tui.press(key.ctrlS)
    await tui.until((screen) => screen.includes("Working"), 5_000, "overview")
    // j moves the selection while the graph shows it: stop at the audit worker, which spawned "Check the refresh path".
    await tui.press("g")
    const forest = (screen: string) => /│ . Audit auth/.test(screen) && /▶│ . Check the refresh/.test(screen)
    for (let step = 0; step < 8 && !forest(tui.screen()); step++) {
      await tui.press("j")
      await new Promise((done) => setTimeout(done, 200))
    }
    await tui.until((screen) => screen.includes("graph") && forest(screen), 5_000, "the forest as boxes")
    await tui.press("g")
    await tui.until((screen) => screen.includes("Working") && screen.includes("tree"), 5_000, "back to the list")
  } finally {
    await tui?.stop()
    rmSync(root, { recursive: true, force: true })
  }
}, 60_000)
