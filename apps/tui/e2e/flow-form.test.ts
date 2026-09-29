/** A large real flow schema must not push the composer and footer off-screen. */
import { expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { key, Tui } from "./tmux.ts"

const app = resolve(import.meta.dir, "..")
for (const [cols, rows, burst] of [[60, 20, false], [40, 12, false], [40, 12, true]] as const) {
  it(`keeps twelve form fields reachable at ${cols} by ${rows} (${burst ? "burst" : "paced"})`, async () => {
    const root = mkdtempSync(join(tmpdir(), "tui-form-"))
    const project = join(root, "project")
    mkdirSync(join(project, "flows/many"), { recursive: true })
    symlinkSync(join(app, "node_modules"), join(project, "node_modules"), "dir")
    const fields = Array.from({ length: 12 }, (_, index) => `field${index + 1}: Schema.String`).join(", ")
    writeFileSync(
      join(project, "flows/many/flow.ts"),
      `
    import { Flow } from "@smthrs/flow"
    import { Node } from "@smthrs/plan"
    import { Schema } from "effect"
    export default Flow.make("many", {
      description: "Many fields", capabilities: [],
      effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "sealed" },
      payload: { ${fields} }, success: Schema.String,
      body: (input) => Node.succeed(Object.values(input).join(","))
    })
  `
    )
    let tui: Tui | undefined
    try {
      tui = await Tui.start({
        cwd: project,
        cols,
        rows,
        command: `bun ${join(app, "e2e/real-flows-fixture.tsx")}`,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          SMITHERS_TUI_SESSION_DIR: join(root, "sessions")
        }
      })
      const status = (screen: string) => /↑\S+ ↓\S+/.test(screen)
      await tui.until(status, 20_000, "first draw")
      await tui.type("/flow many")
      await tui.press(key.enter)
      await tui.until((screen) => screen.includes("Field1") && status(screen), 15_000, "bounded form")
      await tui.press(key.enter)
      await tui.until((screen) => screen.includes("Needs:") && status(screen), 5_000, "visible validation")
      if (burst) await tui.press(Array.from({ length: 12 }, (_, index) => `v${index + 1}`).join("\t"))
      else {for (let index = 1; index <= 12; index++) {
          await tui.type(`v${index}`)
          expect(tui.screen()).toContain(`Field${index}`)
          expect(status(tui.screen())).toBe(true)
          if (index < 12) await tui.press("\t")
        }}
      expect(tui.screen()).toContain("12/12")
      await tui.press(key.enter)
      await tui.until((screen) => screen.includes("✓ many"), 15_000, "all fields submitted")
      const sessions = join(root, "sessions")
      const files = readdirSync(sessions, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      const records = files.flatMap((entry) =>
        readFileSync(join(entry.parentPath, entry.name), "utf8").trim().split("\n").filter(Boolean).map((line) =>
          JSON.parse(line)
        )
      )
      const completed = records.filter((record) => record.type === "flow" && record.run.status === "done").at(-1)
      expect(completed?.run.answer).toBe(Array.from({ length: 12 }, (_, index) => `v${index + 1}`).join(","))
      await tui.type("hello")
      await tui.press(key.enter)
      await tui.until((screen) => screen.includes("Still here.") && status(screen), 5_000, "chat after form")
    } finally {
      await tui?.stop()
      rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)
}

it("lists a flow waiting for its form under Needs you; enter opens it", async () => {
  const root = mkdtempSync(join(tmpdir(), "tui-form-"))
  const project = join(root, "project")
  mkdirSync(join(project, "flows/greet"), { recursive: true })
  symlinkSync(join(app, "node_modules"), join(project, "node_modules"), "dir")
  writeFileSync(
    join(project, "flows/greet/flow.ts"),
    `
    import { Flow } from "@smthrs/flow"
    import { Node } from "@smthrs/plan"
    import { Schema } from "effect"
    export default Flow.make("greet", {
      description: "Greets", capabilities: [],
      effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "sealed" },
      payload: { name: Schema.String }, success: Schema.String,
      body: (input) => Node.succeed("hi " + input.name)
    })
  `
  )
  let tui: Tui | undefined
  try {
    tui = await Tui.start({
      cwd: project,
      cols: 100,
      rows: 24,
      command: `bun ${join(app, "e2e/real-flows-fixture.tsx")}`,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", SMITHERS_TUI_SESSION_DIR: join(root, "s") }
    })
    await tui.until((screen) => /↑\S+ ↓\S+/.test(screen), 20_000, "first draw")
    await tui.type("/flow greet")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("Name"), 15_000, "form")
    await tui.press(key.escape)
    await tui.press(key.ctrlS)
    await tui.until((screen) => screen.includes("Needs you 1") && screen.includes("greet"), 5_000, "needs you")
    await tui.press("j")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("Needs: "), 5_000, "flow tab")
  } finally {
    await tui?.stop()
    rmSync(root, { recursive: true, force: true })
  }
}, 60_000)
