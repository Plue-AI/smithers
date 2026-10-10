/** A real attended flow parks, stays visible, leaves chat usable, and stops. */
import { Database } from "bun:sqlite"
import { expect, it } from "bun:test"
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { drawn, key, Tui } from "./tmux.ts"

const app = resolve(import.meta.dir, "..")
it("shows a real durable park and question without claiming the run is still executing", async () => {
  const root = mkdtempSync(join(tmpdir(), "tui-park-"))
  const project = join(root, "project")
  mkdirSync(join(project, "flows/ask"), { recursive: true })
  writeFileSync(
    join(project, "flows/ask/flow.mdx"),
    // A declared key runs the flow on the control plane; `/flow` would run it as an agent (d6300e6f9b).
    "---\ndescription: Ask a question\nmodel: openai:gpt-6-sol\nmetadata:\n  tui:\n    keys:\n      - key: alt+k\n        label: Ask\n        action: { kind: flow, flow: ask }\n---\nAsk which branch to use.\n"
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
    await tui.until(drawn, 20_000, "first draw")
    await tui.until((screen) => screen.includes("alt+k Ask"), 10_000, "declared key hint")
    await tui.press("\x1bk")
    // A parked run's card holds still with a stopped clock (634d03f97b); a running one spins.
    await tui.until((screen) => /● ask · \d/.test(screen), 30_000, "parked run card")
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
      expect(tui.screen()).toMatch(/● ask · \d/)
      expect(tui.screen()).not.toMatch(/[◐◓◑◒] ask · /)
    } finally {
      db.close()
    }
    await tui.type("still usable")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("Still here."), 10_000, "chat while parked")
    await tui.press(key.ctrlBracket + key.ctrlBracket)
    await tui.until((screen) => screen.includes("Which branch?"), 10_000, "parked question")
    // A parked flow tab offers Continue and Stop (cf8d2e702e); Stop is alt+x beside the composer (573ce2ed81).
    expect(tui.screen()).toContain("⏸ ask")
    expect(tui.screen()).toContain("c Continue")
    expect(tui.screen()).toContain("alt+x Stop")
    await tui.type("x")
    await tui.until(
      (screen) => screen.includes("■ ask") && screen.includes("stopped"),
      15_000,
      "cancelled receipt"
    )
    expect(tui.screen()).toContain("alt+r Resume")
    expect(tui.screen()).not.toContain("alt+x Stop")
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
