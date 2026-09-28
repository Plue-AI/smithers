/** Help focus transitions must preserve Unicode text from one terminal write. */
import { expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import * as Session from "../src/session.ts"
import { key, Tui } from "./tmux.ts"

const app = resolve(import.meta.dir, "..")

const left = "\x1b[D"
const shiftLeft = "\x1b[1;2D"
const cases = [
  { action: "ASCII selection replacement", initial: "abc", edit: left + shiftLeft + "z", expected: "azc" },
  { action: "middle insertion", edit: left + "!", expected: "😀e\u0301!x" },
  { action: "backspace", edit: key.backspace + key.backspace, expected: "😀" },
  { action: "forward delete", edit: left + left + "\x1b[3~", expected: "😀x" },
  { action: "selection replacement", edit: left + shiftLeft + "a\u0308", expected: "😀a\u0308x" }
].flatMap((item) => [false, true].map((help) => ({ ...item, help }))).concat([
  {
    action: "combining-only backspace",
    initial: "\u0301\u0327",
    edit: key.backspace + "kept",
    expected: "kept",
    help: false
  },
  { action: "combining-only delete", initial: "\u0301\u0327", edit: "\x1b[3~kept", expected: "kept", help: false }
])

for (const { action, initial, edit, expected, help } of cases) {
  it(`native PTY ${help ? "help" : "direct"} ${action}`, async () => {
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
      await tui.press((help ? "?" : "") + (initial ?? "😀e\u0301x") + edit)
      const final = (help ? "?" : "") + expected
      await tui.until(
        (screen) => screen.normalize("NFC").includes(final.normalize("NFC")),
        5_000,
        "edited Unicode draft"
      )
      await tui.press(key.enter)
      await tui.until(() => prompts().length === 1, 5_000, "question persisted")
      expect(prompts()).toEqual([final])
    } finally {
      await tui?.stop()
      rmSync(root, { recursive: true, force: true })
    }
  }, 45_000)
}
