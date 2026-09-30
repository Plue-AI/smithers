/** Color screenshots of contributed UI: `bun e2e/extensions-shots.ts [out dir]` (default ~/Desktop/tui-custom-ui). */
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { claim } from "../test/scratch.ts"
import { key, Tui } from "./tmux.ts"

const out = resolve(process.argv[2] ?? join(homedir(), "Desktop", "tui-custom-ui"))
mkdirSync(out, { recursive: true })
// Scratch repos, session folders, Chrome profiles and daemons go when the script exits.
claim()
const app = resolve(import.meta.dir, "..")
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
const shoot = async (tui: Tui, name: string) => {
  const html = join(out, `${name}.html`)
  writeFileSync(html, await tui.html())
  spawnSync(chrome, [
    "--headless=new",
    `--user-data-dir=${mkdtempSync(join(tmpdir(), "chrome-"))}`,
    `--screenshot=${join(out, `${name}.png`)}`,
    `--window-size=${tui.cols * 8 + 40},${tui.rows * 17 + 24}`,
    `file://${html}`
  ], { timeout: 15_000 })
}
const reviewFlow = [
  "---",
  "description: Reviews the uncommitted change and returns a verdict.",
  "metadata:",
  "  tui:",
  "    keys:",
  "      - key: alt+z",
  "        label: Review",
  "        action: { kind: flow, flow: review }",
  "    status: true",
  "    card: true",
  "---",
  "Review the uncommitted change.",
  ""
].join("\n")
const cwd = mkdtempSync(join(tmpdir(), "tui-extensions-shots-"))
mkdirSync(join(cwd, "flows", "review"), { recursive: true })
const mdx = join(cwd, "flows", "review", "flow.mdx")
writeFileSync(mdx, reviewFlow)
const tui = await Tui.start({
  cwd,
  command: `bun ${join(app, "e2e", "extensions-fixture.tsx")}`,
  cols: 110,
  rows: 32,
  env: {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    SMITHERS_TUI_SESSION_DIR: mkdtempSync(join(tmpdir(), "tui-extensions-shots-sessions-")),
    SMITHERS_WORKSPACE_JJ_EXPORT_BINARY: process.env.SMITHERS_WORKSPACE_JJ_EXPORT_BINARY ??
      join(homedir(), "smithers", "target", "release", "smithers-jj-export")
  }
})
try {
  await tui.until((screen) => screen.includes("alt+z Review"), 30_000, "contributed key hint")
  await shoot(tui, "after-hints")
  await tui.type("?")
  await tui.until((screen) => screen.includes("review") && screen.includes("Keys"), 5_000, "key popup")
  await shoot(tui, "after-key-popup")
  await tui.press(key.escape)
  await tui.type("plan release")
  await tui.press(key.enter)
  await tui.until(
    (screen) => screen.includes("Release plan · Two steps left.") && screen.includes("CI ✓"),
    5_000,
    "card"
  )
  await shoot(tui, "after-card")
  await tui.press("\x1bz")
  await tui.until((screen) => /◌ review · \d+m?s/.test(screen), 5_000, "run card")
  await shoot(tui, "after-key-run")
  await tui.type("finish")
  await tui.press(key.enter)
  await tui.until((screen) => screen.includes("→ Approved."), 5_000, "settled")
  await shoot(tui, "after-settled")
  writeFileSync(mdx, readFileSync(mdx, "utf8").replace("key: alt+z", "key: ctrl+c"))
  await tui.until((screen) => screen.includes("✗ 1 extension"), 5_000, "problem")
  await shoot(tui, "after-problem")
  await tui.click("✗ 1 extension")
  await tui.until((screen) => screen.includes("built-in Clear key"), 5_000, "problem view")
  await shoot(tui, "after-problem-view")
} finally {
  await tui.stop()
}
console.log(out)
