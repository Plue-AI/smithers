/** Actual discovery, preparation failure and recovery in the public terminal. */
import { afterEach, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import * as Session from "../src/session.ts"
import { key, Tui } from "./tmux.ts"

const app = resolve(import.meta.dir, "..")
let tui: Tui | undefined
afterEach(async () => {
  await tui?.stop()
  tui = undefined
})

it("an invalid agent effort fails before execution, exposes its refusal, and retries the repaired file", async () => {
  const root = mkdtempSync(join(tmpdir(), "tui-agent-prepare-"))
  const cwd = join(root, "project")
  const home = join(root, "home")
  const sessions = join(root, "sessions")
  const directory = join(cwd, "flows", "review")
  mkdirSync(directory, { recursive: true })
  mkdirSync(home)
  const source = join(directory, "flow.mdx")
  const markdown = (effort: string) =>
    `---\ndescription: Review one file\nmodel: sol\neffort: ${effort}\n---\nReview the named file only.\n`
  writeFileSync(source, markdown("impossible"))
  tui = await Tui.start({
    cwd,
    command: `bun ${join(app, "src", "main.tsx")} ${cwd}`,
    env: {
      HOME: home,
      PATH: process.env.PATH ?? "",
      SMITHERS_TUI_SESSION_DIR: sessions,
      SMITHERS_TUI_REPLAY: join(app, "test", "fixtures", "pong.jsonl"),
      SMITHERS_TUI_REPLAY_SPEED: "100"
    }
  })
  await tui.until((screen) => /↑\S+ ↓\S+/.test(screen), 20_000, "first draw")
  const submit = async (text: string) => {
    await tui!.type(text)
    await tui!.press(key.escape)
    await tui!.press(key.enter)
  }
  const parentRecords = () => {
    const folder = readdirSync(sessions, { withFileTypes: true }).find((entry) => entry.isDirectory())!
    return readdirSync(join(sessions, folder.name)).filter((name) => name.endsWith(".jsonl"))
      .flatMap((name) => Session.load(join(sessions, folder.name, name)))
  }
  const tab = () => parentRecords().filter((record) => record.type === "tab").at(-1)?.tab

  await submit("/agent")
  await tui.until((screen) => screen.includes("Agents") && screen.includes("Review one file"), 10_000, "discovered")
  await tui.press(key.escape)
  await tui.until((screen) => !screen.includes("Agents"), 5_000, "picker closed")
  await submit("/agent review Check one file")
  await tui.until(() => tab()?.status === "failed", 10_000, "preparation failed")
  const failed = tab()!
  expect(failed).toMatchObject({ code: "unknown_effort", message: "Unknown effort impossible", status: "failed" })
  const firstBytes = readFileSync(failed.file, "utf8")
  expect(Session.load(failed.file).filter((record) => record.type === "event")).toEqual([])
  expect(Session.load(failed.file).filter((record) => record.type === "outcome")).toMatchObject([
    { prompt: "Check one file", outcome: { _tag: "failed", message: "Unknown effort impossible" } }
  ])
  await submit("/tabs")
  await tui.until((screen) => screen.includes("Back (ctrl+y)") && screen.includes("Resume"), 5_000, "failed worker")
  await tui.press("\x0f")
  await tui.until((screen) => screen.includes("Unknown effort impossible"), 5_000, "expanded refusal")
  await tui.press("\x19")
  await tui.type("Chat remains usable")
  await tui.until((screen) => screen.includes("Chat remains usable"), 5_000, "usable draft")
  await tui.press("\x15")
  writeFileSync(source, markdown("high"))
  await submit(`/retry ${failed.id}`)
  await tui.until(() => tab()?.status === "done", 20_000, "repaired agent completed")
  const repaired = tab()!
  expect(repaired.id).toBe(failed.id)
  expect(repaired.file).not.toBe(failed.file)
  expect(Session.load(repaired.file)[0]).toMatchObject({ type: "session", parent: failed.file })
  expect(Session.load(repaired.file).filter((record) => record.type === "outcome")).toMatchObject([
    { prompt: "Check one file", outcome: { _tag: "done", answer: "pong" } }
  ])
  expect(readFileSync(failed.file, "utf8")).toBe(firstBytes)
  await tui.until((screen) => screen.includes("review: Check one file finished"), 5_000, "visible settlement")
}, 60_000)
