/** Color screenshots of the tab strip, worker view and sidebar: `bun e2e/shots.ts <out dir>`. */
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { claim } from "../test/scratch.ts"
import { key, Tui } from "./zmux.ts"

const out = resolve(process.argv[2] ?? join(tmpdir(), "tui-shots"))
mkdirSync(out, { recursive: true })
// Scratch repos, session folders, Chrome profiles and daemons go when the script exits.
claim()
const app = resolve(import.meta.dir, "..")
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
/** Each capture is taken now and rendered once the TUIs stop, so Chrome never stalls a live session. */
const captures: Array<{ readonly name: string; readonly html: string; readonly cols: number; readonly rows: number }> =
  []
const shoot = (tui: Tui, name: string) => captures.push({ name, html: tui.html(), cols: tui.cols, rows: tui.rows })
const render = () => {
  for (const capture of captures) {
    const html = join(out, `${capture.name}.html`)
    writeFileSync(html, capture.html)
    spawnSync(chrome, [
      "--headless=new",
      `--user-data-dir=${mkdtempSync(join(tmpdir(), "chrome-"))}`,
      `--screenshot=${join(out, `${capture.name}.png`)}`,
      `--window-size=${capture.cols * 8 + 40},${capture.rows * 17 + 24}`,
      `file://${html}`
    ], { timeout: 180_000 })
  }
}
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))
for (const cols of [120, 84]) {
  const tui = await Tui.start({
    cwd: mkdtempSync(join(tmpdir(), "tui-shots-repo-")),
    command: `bun ${join(app, "e2e", "tabs-fixture.tsx")}`,
    cols,
    rows: 34,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      SMITHERS_TUI_SESSION_DIR: mkdtempSync(join(tmpdir(), "tui-shots-"))
    }
  })
  try {
    await tui.until((screen) => screen.includes("Ask Smithers"), 20_000, "first draw")
    await tui.type("delegate")
    await tui.press(key.enter)
    await sleep(1500)
    await tui.type("more")
    await tui.press(key.enter)
    await sleep(1500)
    shoot(tui, `${cols}-chat`)
    await tui.press("\x1b[1;5C") // ctrl+right: Summary
    await sleep(300)
    await tui.press("\x1b[1;5C") // first worker
    await sleep(800)
    shoot(tui, `${cols}-worker-running`)
    await tui.type("s")
    await sleep(300)
    await tui.type("also check the refresh path")
    await tui.press(key.enter)
    await sleep(500)
    shoot(tui, `${cols}-worker-steer`)
    await tui.press(key.escape)
    await sleep(200)
    for (let step = 0; step < 2; step++) {
      await tui.press("\x1b[1;5C")
      await sleep(300)
    }
    await sleep(500)
    shoot(tui, `${cols}-worker-failed`)
    await tui.press("\x1b[1;5C")
    await sleep(800)
    shoot(tui, `${cols}-worker-overflow`)
  } finally {
    await tui.stop()
  }
}
render()
console.log(out)
