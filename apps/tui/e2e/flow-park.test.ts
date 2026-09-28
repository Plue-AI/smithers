/** A real attended flow parks, stays visible, leaves chat usable, and stops. */
import { Database } from "bun:sqlite"
import { expect, it } from "bun:test"
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { key, Tui } from "./tmux.ts"

const app = resolve(import.meta.dir, "..")
it("shows a real durable park and question without claiming the run is still executing", async () => {
  const root = mkdtempSync(join(tmpdir(), "tui-park-"))
  const project = join(root, "project")
  mkdirSync(join(project, "flows/ask"), { recursive: true })
  writeFileSync(
    join(project, "flows/ask/flow.mdx"),
    "---\ndescription: Ask a question\nmodel: openai:gpt-6-sol\n---\nAsk which branch to use.\n"
  )
  let tui: Tui | undefined
  try {
    tui = await Tui.start({
      cwd: project,
      command: `bun ${join(app, "e2e/real-flows-fixture.tsx")}`,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        SMITHERS_TUI_SESSION_DIR: join(root, "sessions"),
        TUI_FLOW_CELL: "ctx.park(\"waiting-input\", \"Which branch?\")"
      }
    })
    await tui.until((screen) => /↑\S+ ↓\S+/.test(screen), 20_000, "first draw")
    await tui.type("/flow ask")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("⏸ ask"), 30_000, "paused flow tab")
    expect(tui.screen()).not.toContain("ask · running")
    const db = new Database(join(project, ".flows/control.db"), { readonly: true })
    try {
      const events = () =>
        db.query(
          "select event_type, payload_json from flows_journal_events where event_type in ('control.agent.discipline-armed', 'control.run.parked')"
        ).all() as Array<{ event_type: string; payload_json: string }>
      // The control watch merges the execution journal before its mirror has
      // necessarily reached control.db; require the durable mirror as well.
      await tui.until(
        () =>
          events().some((event) =>
            event.event_type === "control.agent.discipline-armed" &&
            JSON.parse(event.payload_json).approvalChannel === true
          ) && events().some((event) => event.event_type === "control.run.parked"),
        5_000,
        "mirrored approval and park receipts"
      )
      expect(events().some((event) => event.event_type === "control.run.parked")).toBe(true)
    } finally {
      db.close()
    }
    await tui.type("still usable")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("Still here."), 10_000, "chat while parked")
    await tui.press(key.ctrlBracket + key.ctrlBracket)
    await tui.until((screen) => screen.includes("Which branch?"), 10_000, "parked question")
    expect(tui.screen()).toContain("r Resume")
    expect(tui.screen()).toContain("x Stop")
    await tui.type("x")
    await tui.until((screen) => screen.includes("■ ask") && screen.includes("Stopped."), 15_000, "cancelled receipt")
    expect(tui.screen()).toContain("r Resume")
    expect(tui.screen()).not.toContain("x Stop")
  } catch (error) {
    if (process.env.TUI_PARK_EVIDENCE_DIR !== undefined) {
      const saved = join(process.env.TUI_PARK_EVIDENCE_DIR, String(Date.now()))
      mkdirSync(saved, { recursive: true })
      writeFileSync(join(saved, "screen.txt"), tui?.screen() ?? "No terminal")
      await tui?.stop()
      tui = undefined
      cpSync(root, join(saved, "state"), { recursive: true })
    }
    throw error
  } finally {
    await tui?.stop()
    rmSync(root, { recursive: true, force: true })
  }
}, 90_000)
