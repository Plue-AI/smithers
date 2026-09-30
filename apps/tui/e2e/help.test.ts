/** `ctx.help()`: a top-level worker's ask reaches the person, who answers it from the Summary overview. */
import { expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { key, Tui } from "./tmux.ts"

const app = resolve(import.meta.dir, "..")

it.each([24, 12])("answers a wrapped question with keyboard choices at 80x%i", async (rows) => {
  const root = mkdtempSync(join(tmpdir(), "tui-help-wrapped-"))
  let tui: Tui | undefined
  try {
    tui = await Tui.start({
      cwd: root,
      cols: 80,
      rows,
      command: `bun ${join(app, "e2e", "tabs-fixture.tsx")}`,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        SMITHERS_TUI_SESSION_DIR: join(root, "s"),
        SMITHERS_TUI_ASK_QUESTION:
          "Before implementing authentication, should the request carry the existing session cookie, or should it carry a bearer header for the remote workspace?"
      }
    })
    await tui.until((screen) => screen.includes("Ask Smithers"), 20_000, "first draw")
    await tui.type("help")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("Requested one worker."), 5_000, "delegated")
    await tui.press(key.ctrlS)
    await tui.until((screen) => screen.includes("Needs you 1"), 5_000, "needs you")
    await tui.press("a")
    const form = await tui.until((screen) => /Answer\s+Session cookie/.test(screen), 5_000, "answer form")
    expect(form).toContain("remote workspace?")
    await tui.press("\x1b[C")
    await tui.until((screen) => /Answer\s+Bearer header/.test(screen), 5_000, "chosen")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("Done 1") && !screen.includes("Needs you"), 5_000, "answered")
  } finally {
    await tui?.stop()
    rmSync(root, { recursive: true, force: true })
  }
}, 60_000)

it("answers a worker's ask with a from the overview, and the worker finishes with the answer", async () => {
  const root = mkdtempSync(join(tmpdir(), "tui-help-"))
  let tui: Tui | undefined
  try {
    tui = await Tui.start({
      cwd: root,
      cols: 110,
      rows: 30,
      command: `bun ${join(app, "e2e", "tabs-fixture.tsx")}`,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", SMITHERS_TUI_SESSION_DIR: join(root, "s") }
    })
    await tui.until((screen) => screen.includes("Ask Smithers"), 20_000, "first draw")
    await tui.type("help")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("Requested one worker."), 5_000, "delegated")
    await tui.press(key.ctrlS)
    await tui.until(
      (screen) => screen.includes("Needs you 1") && screen.includes("◆ implement/api"),
      5_000,
      "needs you"
    )
    // The status line already names the question: only the peek lists the options, and only the form an Answer field.
    expect(tui.screen()).not.toContain("Session cookie · Bearer header")
    await tui.press(" ")
    await tui.until((screen) => screen.includes("Session cookie · Bearer header"), 5_000, "peek")
    expect(tui.screen()).not.toMatch(/Answer\s+Session cookie/)
    await tui.press("a")
    await tui.until((screen) => /Answer\s+Session cookie/.test(screen), 5_000, "form")
    await tui.press("\x1b[C") // right: the next option
    await tui.until((screen) => /Answer\s+Bearer header/.test(screen), 5_000, "chosen")
    await tui.press(key.enter)
    await tui.until(
      (screen) => screen.includes("Done 1") && !screen.includes("Needs you") && screen.includes("Using: Bearer header"),
      5_000,
      "the worker finished with the answer"
    )
  } finally {
    await tui?.stop()
    rmSync(root, { recursive: true, force: true })
  }
}, 60_000)

it("raises a capped worker's token cap with a from the overview, and it resumes", async () => {
  const root = mkdtempSync(join(tmpdir(), "tui-cap-"))
  let tui: Tui | undefined
  try {
    tui = await Tui.start({
      cwd: root,
      cols: 110,
      rows: 30,
      command: `bun ${join(app, "e2e", "tabs-fixture.tsx")}`,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", SMITHERS_TUI_SESSION_DIR: join(root, "s") }
    })
    await tui.until((screen) => screen.includes("Ask Smithers"), 20_000, "first draw")
    await tui.type("cap")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("Requested one worker."), 5_000, "delegated")
    await tui.press(key.ctrlS)
    await tui.until((screen) => screen.includes("Needs you 1") && screen.includes("flaky seat queue"), 5_000, "capped")
    await tui.press("a")
    await tui.until(
      (screen) => screen.includes("200 of 200 tokens used") && /Cap\s+200/.test(screen),
      5_000,
      "cap form"
    )
    await tui.press("\x1b[C") // right: twice the cap
    await tui.until((screen) => /Cap\s+400/.test(screen), 5_000, "chosen")
    await tui.press(key.enter)
    await tui.until(
      (screen) => screen.includes("Done 1") && !screen.includes("Needs you"),
      5_000,
      "resumed under the raised cap"
    )
    await tui.press(" ")
    await tui.until((screen) => screen.includes("Resumed under 400 tokens."), 5_000, "the new cap reached the run")
  } finally {
    await tui?.stop()
    rmSync(root, { recursive: true, force: true })
  }
}, 60_000)
