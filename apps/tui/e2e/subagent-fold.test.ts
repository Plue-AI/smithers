/** Production terminal, restored session files and replayed model: no live provider is required to disclose cards. */
import { expect, it } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import * as Session from "../src/session.ts"
import { key, Tui } from "./tmux.ts"

const app = resolve(import.meta.dir, "..")

for (const control of ["ten", "keyboard", "mouse"] as const) {
  it(
    `restores ${control === "ten" ? 10 : 11} batches and preserves Chat through ${control} activation (#3033)`,
    async () => {
      const root = mkdtempSync(join(tmpdir(), "tui-subagent-fold-"))
      const sessions = join(root, "sessions")
      const replay = join(root, "pong.jsonl")
      writeFileSync(replay, readFileSync(join(app, "test", "fixtures", "pong.jsonl"), "utf8"))
      const previous = process.env.SMITHERS_TUI_SESSION_DIR
      process.env.SMITHERS_TUI_SESSION_DIR = sessions
      let file: string
      try {
        const writer = Session.create(root)
        file = writer.file
        for (let index = 0; index < (control === "ten" ? 10 : 11); index++) {
          writer.append({ type: "note", at: index * 10, text: `request ${index}` })
          const worker = Session.create(root, "worker")
          worker.append({
            type: "outcome",
            at: index * 10 + 2,
            prompt: `work ${index}`,
            outcome: { _tag: "done", answer: `result ${index}` }
          })
          writer.append({
            type: "tab",
            tab: {
              id: `batch-${index}`,
              title: `Batch ${index}`,
              prompt: `work ${index}`,
              seat: "replay:worker",
              file: worker.file,
              status: "done",
              startedAt: index * 10 + 1,
              endedAt: index * 10 + 2,
              depth: 0
            }
          })
        }
      } finally {
        if (previous === undefined) delete process.env.SMITHERS_TUI_SESSION_DIR
        else process.env.SMITHERS_TUI_SESSION_DIR = previous
      }
      const before = readFileSync(file!, "utf8")
      let tui: Tui | undefined
      try {
        tui = await Tui.start({
          cwd: root,
          cols: 110,
          rows: 35,
          command: `bun ${join(app, "src", "main.tsx")} ${root} --continue`,
          env: {
            HOME: root,
            XDG_CONFIG_HOME: root,
            PATH: process.env.PATH ?? "",
            SMITHERS_TUI_SESSION_DIR: sessions,
            SMITHERS_TUI_REPLAY: replay,
            SMITHERS_TUI_REPLAY_SPEED: "100"
          }
        })
        await tui.until(
          (screen) => screen.includes(`Batch ${control === "ten" ? 9 : 10}`),
          25_000,
          "restored latest batch"
        )
        await tui.press(key.tab)
        await tui.press(key.tab)
        const prompt = `chat after ${control}`
        if (control === "ten") {
          await tui.until((screen) => screen.includes("Batch 0"), 5_000, "oldest of ten remains a card")
          expect(tui.screen()).not.toContain("earlier subagent batch")
          await tui.press(key.escape)
          await tui.press(prompt)
        } else {
          await tui.until((screen) => screen.includes("1 earlier subagent batch"), 5_000, "earlier batch focus")
          expect(tui.screen()).not.toContain("Batch 0 finished")
          if (control === "keyboard") {
            // Enter and the complete draft reach the PTY in one write.
            await tui.press(key.enter + prompt)
          } else {
            await tui.click("1 earlier subagent batch")
            await tui.press(prompt)
          }
          await tui.until((screen) => !screen.includes("earlier subagent batch"), 5_000, "expanded cards")
        }
        await tui.until((screen) => screen.includes(prompt), 5_000, "native composer retains complete draft")
        expect(readFileSync(file!, "utf8")).toBe(before)
        await tui.press(key.enter)
        await tui.until(
          () => Session.load(file!).some((record) => record.type === "outcome" && record.prompt === prompt),
          15_000,
          "actual chat completion"
        )
        expect(Session.load(file!).filter((record) => record.type === "user").map((record) => record.text)).toEqual([
          prompt
        ])
        expect(Session.load(file!)).toContainEqual(
          expect.objectContaining({
            type: "outcome",
            prompt,
            outcome: expect.objectContaining({ _tag: "done", answer: "pong" })
          })
        )
      } finally {
        await tui?.stop()
        rmSync(root, { recursive: true, force: true })
      }
    },
    60_000
  )
}
