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
    const form = await tui.until((screen) => screen.includes("> Session cookie"), 5_000, "answer form")
    expect(form).toContain("remote workspace?")
    expect(form).toContain("enter Answer  esc Back")
    await tui.press(key.down)
    await tui.until((screen) => screen.includes("> Bearer header"), 5_000, "chosen")
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
    // The selected ask's card shows its choices; only the form puts a cursor on one.
    await tui.until((screen) => screen.includes("1 Session cookie  2 Bearer"), 5_000, "card")
    expect(tui.screen()).not.toContain("> Session cookie")
    await tui.press("a")
    await tui.until((screen) => screen.includes("> Session cookie"), 5_000, "form")
    await tui.press(key.down)
    await tui.until((screen) => screen.includes("> Bearer header"), 5_000, "chosen")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("Done 1") && !screen.includes("Needs you"), 5_000, "answered")
    // The peek shows the worker's last step: it finished with the answer.
    await tui.press(" ")
    await tui.until((screen) => screen.includes("Using: Bearer header"), 5_000, "the worker finished with the answer")
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
    // A capped worker failed: it waits under the closed Failed group, not Needs you.
    await tui.until((screen) => screen.includes("Failed 1 ›") && !screen.includes("Needs you"), 5_000, "capped")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("flaky seat queue"), 5_000, "failed open")
    await tui.press(key.down)
    await tui.press("a")
    await tui.until(
      (screen) => screen.includes("200 of 200 tokens used") && /Cap\s+200/.test(screen),
      5_000,
      "cap form"
    )
    await tui.press("\x1b[C") // right: twice the cap
    await tui.until((screen) => /Cap\s+200\s+400/.test(screen), 5_000, "cap choices")
    // The form shows every option; its chosen option is bold (#3045).
    const deadline = Date.now() + 5_000
    let selected = ""
    while (Date.now() < deadline) {
      selected = [...(await tui.html()).matchAll(/<span style="[^"]*font-weight:700;[^"]*">([^<]*)<\/span>/g)]
        .map((match) => match[1]).join("")
      if (selected.includes(" 400 ")) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    expect(selected).toContain(" 400 ")
    await tui.press(key.enter)
    await tui.until(
      (screen) => screen.includes("Done 1") && !screen.includes("Failed"),
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
