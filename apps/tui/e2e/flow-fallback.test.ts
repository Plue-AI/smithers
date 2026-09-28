/** Real frontmatter discovery, HTTP refusal, fallback, and durable completion. */
import { expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { key, Tui } from "./tmux.ts"

it("runs the next declared model after context overflow", async () => {
  const root = mkdtempSync(join(tmpdir(), "tui-fallback-"))
  const project = join(root, "project")
  mkdirSync(join(project, "flows/fallback"), { recursive: true })
  writeFileSync(
    join(project, "flows/fallback/flow.mdx"),
    "---\ndescription: Test fallback\nmodel: [openai:first, openai:second]\n---\nAnswer Pong.\n"
  )
  const log = join(root, "requests.log")
  let tui: Tui | undefined
  try {
    tui = await Tui.start({
      cwd: project,
      command: `bun ${resolve(import.meta.dir, "real-flows-fixture.tsx")}`,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        SMITHERS_TUI_SESSION_DIR: join(root, "sessions"),
        TUI_MODEL_LOG: log,
        TUI_REFUSED_MODEL: "first",
        TUI_REFUSAL: "overflow"
      }
    })
    await tui.until((screen) => /↑\S+ ↓\S+/.test(screen), 20_000, "first draw")
    await tui.type("/flow fallback")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("fallback · done"), 30_000, "fallback completion")
    const requests = readFileSync(log, "utf8").trim().split("\n")
    expect(requests.slice(0, 2)).toEqual(["first", "second"])
    await tui.press(key.ctrlBracket + key.ctrlBracket)
    await tui.until((screen) => screen.includes("Pong."), 5_000, "fallback answer")
    expect(tui.screen()).not.toContain("Failed.")
  } finally {
    await tui?.stop()
    rmSync(root, { recursive: true, force: true })
  }
}, 60_000)
