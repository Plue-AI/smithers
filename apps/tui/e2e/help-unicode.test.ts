/** Help focus transitions must preserve Unicode text from one terminal write. */
import { expect, it } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import * as Session from "../src/session.ts"
import { key, Tui } from "./tmux.ts"

const app = resolve(import.meta.dir, "..")

/** The one prompt the TUI persists after `text` arrives in one PTY write and Enter. */
const persisted = async (text: string): Promise<string> => {
  const root = mkdtempSync(join(tmpdir(), "tui-help-unicode-"))
  const project = join(root, "project")
  const sessions = join(root, "sessions")
  mkdirSync(project)
  let tui: Tui | undefined
  // The TUI creates the session directory with its first record, so it can
  // be missing while the prompt is still being submitted.
  const prompts = () =>
    (existsSync(sessions) ? readdirSync(sessions, { recursive: true }) : [])
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
    return prompts()[0]!
  } finally {
    await tui?.stop()
    rmSync(root, { recursive: true, force: true })
  }
}

it.each(["?😀"])("persists Unicode %s from one PTY burst", async (text) => {
  expect(await persisted(text)).toBe(text)
}, 45_000)

// OpenTUI's native edit buffer puts later text in front of a combining mark
// that arrives on its own (#2403, present in the installed @opentui/core
// 0.5.11). These expectations pin the defect exactly: when an OpenTUI release
// fixes it they fail, and each expectation must become its input. Today the
// mark lands after the family emoji instead of on the "e".
it.each([
  ["?😀e\u0301👨‍👩‍👧‍👦", "?😀e👨‍👩‍👧‍👦\u0301"],
  ["😀e\u0301👨‍👩‍👧‍👦", "😀e👨‍👩‍👧‍👦\u0301"]
])("persists Unicode %s from one PTY burst as the #2403 reordering", async (text, wrong) => {
  expect(await persisted(text)).toBe(wrong)
}, 45_000)
