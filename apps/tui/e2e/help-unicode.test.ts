/** Help focus transitions must preserve Unicode text from one terminal write. */
import { expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import * as Session from "../src/session.ts"
import { key, Tui } from "./tmux.ts"

const app = resolve(import.meta.dir, "..")

it.each(["?😀", "?😀e\u0301👨‍👩‍👧‍👦", "😀e\u0301👨‍👩‍👧‍👦"])("persists Unicode %s from one PTY burst", async (text) => {
  const root = mkdtempSync(join(tmpdir(), "tui-help-unicode-"))
  const project = join(root, "project")
  const sessions = join(root, "sessions")
  mkdirSync(project)
  let tui: Tui | undefined
  const prompts = () =>
    readdirSync(sessions, { recursive: true })
      .filter((path) => String(path).endsWith(".jsonl"))
      .flatMap((path) => Session.load(join(sessions, String(path))))
      .flatMap((record) => record.type === "user" ? [record.text] : [])
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
    await tui.press(text)
    await tui.press(key.enter)
    await tui.until(() => prompts().length === 1, 5_000, "question persisted")
    expect(prompts()).toEqual([text])
  } finally {
    await tui?.stop()
    rmSync(root, { recursive: true, force: true })
  }
}, 45_000)
