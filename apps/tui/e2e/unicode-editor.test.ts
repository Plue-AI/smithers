/** Native cursor columns must never be used as JS string indices (#1996). */
import { expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import * as Session from "../src/session.ts"
import { key, Tui } from "./tmux.ts"

const app = resolve(import.meta.dir, "..")
it("completes after Japanese/emoji and inserts palette mentions before an intact suffix", async () => {
  const root = mkdtempSync(join(tmpdir(), "tui-unicode-"))
  const project = join(root, "project")
  const sessions = join(root, "sessions")
  mkdirSync(project)
  writeFileSync(join(project, "日本語😀.txt"), "hello unicode\n")
  let tui: Tui | undefined
  const prompts = () => {
    const file = readdirSync(sessions, { recursive: true }).find((path) => String(path).endsWith(".jsonl"))
    return file === undefined
      ? []
      : Session.load(join(sessions, String(file))).flatMap((record) => record.type === "user" ? [record.text] : [])
  }
  try {
    tui = await Tui.start({
      cwd: project,
      command: `bun ${join(app, "src/main.tsx")} ${project}`,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        SMITHERS_TUI_REPLAY: join(app, "test/fixtures/pong.jsonl"),
        SMITHERS_TUI_SESSION_DIR: sessions
      }
    })
    await tui.until((screen) => /↑\S+ ↓\S+/.test(screen), 20_000, "first draw")
    await tui.type("先頭 😀 @日本")
    await tui.until((screen) => screen.includes("日本語") && screen.includes(".txt"), 5_000, "Unicode completion")
    await tui.press(key.tab)
    await tui.type("END")
    await tui.press(key.enter)
    await tui.until(() => prompts().length === 1, 5_000, "completed prompt persisted")
    expect(prompts()[0]).toBe("先頭 😀 @日本語😀.txt END")
    await tui.until((screen) => !screen.includes("esc Interrupt") && /pong/i.test(screen), 10_000, "first turn done")

    await tui.type("日本語😀 suffix")
    await tui.press(key.ctrlA)
    await tui.press("\x1b[C".repeat(4))
    await tui.press(key.ctrlK)
    await tui.type("日本")
    await tui.until((screen) => screen.includes("日本語") && screen.includes(".txt"), 5_000, "palette Unicode file")
    await tui.press(key.enter)
    await tui.type("MARK")
    await tui.press(key.enter)
    await tui.until(() => prompts().length === 2, 5_000, "palette prompt persisted")
    expect(prompts()[1]).toBe("日本語😀 @日本語😀.txt MARKsuffix")
  } finally {
    await tui?.stop()
    rmSync(root, { recursive: true, force: true })
  }
}, 45_000)
