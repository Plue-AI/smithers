/**
 * The TUI in a real PTY, driven through tmux: keys in, screen out.
 *
 * Model turns use offline replay seats. Historical traces exercise projections;
 * successful coding cases use current-protocol cells that execute real flows.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import {
  appendFileSync,
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import * as Session from "../src/session.ts"
import { key, Tui } from "./tmux.ts"

let previousSessionDirectory: string | undefined
beforeEach(() => {
  previousSessionDirectory = process.env.SMITHERS_TUI_SESSION_DIR
})
afterEach(() => {
  if (previousSessionDirectory === undefined) delete process.env.SMITHERS_TUI_SESSION_DIR
  else process.env.SMITHERS_TUI_SESSION_DIR = previousSessionDirectory
})

const app = resolve(import.meta.dir, "..")
const fixture = join(app, "test", "fixtures", "fix-add.jsonl")
/** The status bar's token counter: present once the first frame is drawn. */
const drawn = (screen: string) => /↑\S+ ↓\S+/.test(screen)
const idle = (screen: string) => drawn(screen) && !screen.includes("esc Interrupt") && !/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] \d/.test(screen)

/**
 * The one session folder under a session root. The root also holds the
 * process-wide `tui.log` diagnostic file, so the first entry is not always it.
 */
const sessionFolder = (root: string): string => {
  const folders = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory())
  expect(folders).toHaveLength(1)
  return join(root, folders[0]!.name)
}

/** The scrubber's playhead column. */
const knob = (screen: string): number =>
  screen.split("\n").map((line) => [...line].indexOf("●")).find((column) => column >= 0) ?? -1

let tui: Tui | undefined
afterEach(async () => {
  await tui?.stop()
  tui = undefined
})

/**
 * A scratch repository whose `node check.mjs` fails until `add` adds. With
 * `git`, it is committed, so shell calls are captured and can be undone.
 */
const repository = (options: { readonly git?: boolean } = {}) => {
  const directory = mkdtempSync(join(tmpdir(), "tui-repo-"))
  writeFileSync(join(directory, "math.js"), "export const add = (a, b) => a - b\n")
  writeFileSync(
    join(directory, "check.mjs"),
    "import { add } from \"./math.js\"\nif (add(2, 3) !== 5) { console.error(\"add is wrong\"); process.exit(1) }\nconsole.log(\"ok\")\n"
  )
  if (options.git === true) {
    writeFileSync(join(directory, "package.json"), "{\"type\":\"module\"}\n")
    writeFileSync(join(directory, ".gitignore"), "node_modules\n.flows\n.smithers\n")
    for (
      const command of [["init", "-q"], ["add", "-A"], [
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@t",
        "commit",
        "-q",
        "-m",
        "init"
      ]]
    ) {
      if (spawnSync("git", command, { cwd: directory }).status !== 0) throw new Error(`git ${command[0]} failed`)
    }
  }
  return directory
}

const start = async (
  options: {
    readonly holdMs?: number
    readonly args?: string
    readonly cwd?: string
    readonly sessions?: string
    readonly home?: string
    readonly editor?: string
    readonly shellInit?: string
    readonly replay?: string
    readonly cols?: number
    readonly rows?: number
    /** Unset runs the default (every call unasked); approval cases opt in. */
    readonly approve?: "ask" | "all" | "deny"
  } = {}
) => {
  const cwd = options.cwd ?? repository()
  const sessions = options.sessions ?? mkdtempSync(join(tmpdir(), "tui-sessions-"))
  tui = await Tui.start({
    cwd,
    cols: options.cols,
    rows: options.rows,
    command: `bun ${join(app, "src", "main.tsx")} ${cwd} ${options.args ?? ""}`,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: options.home ?? process.env.HOME ?? "",
      SMITHERS_TUI_REPLAY: options.replay ?? fixture,
      SMITHERS_TUI_REPLAY_HOLD_MS: String(options.holdMs ?? 0),
      SMITHERS_TUI_REPLAY_SPEED: "20",
      SMITHERS_TUI_SESSION_DIR: sessions,
      ...(options.editor === undefined ? {} : { VISUAL: options.editor, EDITOR: options.editor }),
      ...(options.shellInit === undefined ? {} : { ENV: options.shellInit }),
      ...(options.approve === undefined ? {} : { SMITHERS_TUI_APPROVE: options.approve })
    }
  })
  await tui.until(drawn, 20_000, "first draw")
  return { tui, cwd, sessions }
}

const replayCells = (cells: ReadonlyArray<string>): string => {
  const replay = join(mkdtempSync(join(tmpdir(), "tui-cell-replay-")), "turn.jsonl")
  writeFileSync(
    replay,
    cells.flatMap((cell) => [
      { at: 0, event: { _tag: "model-requested" } },
      { at: 0, event: { _tag: "model-delta", delta: { type: "text-start", id: "cell" } } },
      {
        at: 0,
        event: { _tag: "model-delta", delta: { type: "text-delta", id: "cell", text: `\`\`\`cell\n${cell}\n\`\`\`` } }
      },
      { at: 0, event: { _tag: "model-delta", delta: { type: "text-end", id: "cell" } } },
      { at: 0, event: { _tag: "model-settled", message: { stopReason: "stop" } } }
    ]).map((record) => JSON.stringify(record)).join("\n")
  )
  return replay
}

/** Keep completion separate from effects so its claims have recorded evidence. */
const codingReplay = (): string =>
  replayCells([
    `const files = await ctx.call("ls", { path: ".", limit: 100 });
const check = await ctx.call("read", { path: "check.mjs" });
const manifest = await ctx.call("read", { path: "package.json" });
const failed = await ctx.call("bash", { mode: "hermetic", command: "node check.mjs", reads: ["."], writes: [], cwd: "." });
if (failed.exitCode !== 1) throw new Error("Expected the initial check to fail");
console.log(JSON.stringify({ files, check, manifest, failed }));`,
    `const math = await ctx.call("read", { path: "math.js" }); console.log(math.content);`,
    `await ctx.call("edit", { path: "math.js", oldString: "a - b", newString: "a + b" });
const checked = await ctx.call("bash", { mode: "hermetic", command: "node check.mjs", reads: ["."], writes: [], cwd: "." });
if (checked.exitCode !== 0 || checked.stdout.trim() !== "ok") throw new Error("Check failed");
console.log(checked.stdout);`,
    `ctx.done("Fixed math.js; node check.mjs prints ok.");`
  ])

/** Visible cell source is never evidence that a turn completed successfully. */
const successfulAnswer = async (
  started: Awaited<ReturnType<typeof start>>,
  expected = "Fixed",
  timeoutMs = 120_000,
  after = 0
) => {
  const outcome = () => {
    const folders = readdirSync(started.sessions, { withFileTypes: true }).filter((entry) => entry.isDirectory())
    if (folders.length !== 1) return undefined
    const folder = join(started.sessions, folders[0]!.name)
    const journal = readdirSync(folder).find((name) => name.endsWith(".jsonl"))
    if (journal === undefined) return undefined
    const file = join(folder, journal)
    const records = Session.load(file)
    const user = records.findLastIndex((record, index) => index >= after && record.type === "user")
    return user < 0 ? undefined : records.slice(user + 1).findLast((record) => record.type === "outcome")
  }
  await started.tui.until(() => outcome() !== undefined, timeoutMs, "persisted turn outcome")
  const receipt = outcome()
  expect(receipt).toMatchObject({ type: "outcome", outcome: { _tag: "done" } })
  expect(receipt?.type === "outcome" ? receipt.outcome.answer : undefined).toContain(expected)
  await started.tui.until(idle, 5_000, "completed turn UI")
  return receipt
}

const persistedReadCalls = (file: string) =>
  Session.load(file).filter((record) =>
    record.type === "event" && record.event._tag === "cell-call-settled" && record.event.flowName === "read"
  )

const persistedReadStarts = (file: string) =>
  Session.load(file).flatMap((record) =>
    record.type === "event" && record.event._tag === "cell-call-started" && record.event.call.flowName === "read"
      ? [record.event.call]
      : []
  )

const readTree = (starts: ReturnType<typeof persistedReadStarts>): string => {
  expect(starts.length).toBeGreaterThan(0)
  for (const call of starts) expect(call.effects.tier).toBe("sealed")
  const trees = starts.map((call) => call.epoch?.tree)
  expect(trees.every((tree) => typeof tree === "string" && tree.length > 0)).toBe(true)
  expect(new Set(trees).size).toBe(1)
  return trees[0]!
}

const expectSameReadKeyMaterial = (
  starts: ReturnType<typeof persistedReadStarts>,
  reference: ReturnType<typeof persistedReadStarts>[number]
) => {
  for (const call of starts) {
    expect(call).toMatchObject({
      input: reference.input,
      effects: reference.effects,
      capabilities: reference.capabilities,
      identity: { declaration: reference.identity.declaration, layers: reference.identity.layers }
    })
  }
}

const expectReadContent = (reads: ReturnType<typeof persistedReadCalls>, content: string) => {
  expect(reads.length).toBeGreaterThan(0)
  for (const read of reads) {
    expect(read).toMatchObject({
      type: "event",
      event: {
        _tag: "cell-call-settled",
        eventType: "flows.harness.cell-call-settled.v1",
        flowName: "read",
        result: { outcome: "success", value: { content } }
      }
    })
  }
}

const readStatusSession = async () => {
  const cwd = repository()
  writeFileSync(join(cwd, "check-status.txt"), "2 checks passed")
  const replay = replayCells([
    `const status = await ctx.call("read", { path: "check-status.txt" }); ctx.done(status.content);`
  ])
  const started = await start({ cwd, replay })
  await started.tui.type("Read the current check status.")
  await started.tui.press(key.enter)
  await successfulAnswer(started, "2 checks passed", 20_000)
  const folder = sessionFolder(started.sessions)
  const file = join(folder, readdirSync(folder).find((name) => name.endsWith(".jsonl"))!)
  const initialReads = persistedReadCalls(file)
  const initialStarts = persistedReadStarts(file)
  expectReadContent(initialReads, "2 checks passed")
  const initialTree = readTree(initialStarts)
  return { started, file, initialReads, initialStarts, initialTree }
}

const expectChangedThenUnchangedRead = async (session: Awaited<ReturnType<typeof readStatusSession>>) => {
  const { started, file, initialReads, initialStarts, initialTree } = session
  const beforeSecondPrompt = Session.load(file).length
  await started.tui.type("Read the current check status again.")
  await started.tui.press(key.enter)
  await successfulAnswer(started, "stop-monitor", 20_000, beforeSecondPrompt)
  const changedReads = persistedReadCalls(file)
  const changedStarts = persistedReadStarts(file)
  expectReadContent(changedReads.slice(initialReads.length), "stop-monitor")
  const secondTurnStarts = changedStarts.slice(initialStarts.length)
  expectSameReadKeyMaterial(secondTurnStarts, initialStarts[0]!)
  const changedTree = readTree(secondTurnStarts)
  expect(changedTree).not.toBe(initialTree)

  const beforeThirdPrompt = Session.load(file).length
  let thirdWaitSettled = false
  const thirdAnswer = successfulAnswer(started, "stop-monitor", 20_000, beforeThirdPrompt).finally(() => {
    thirdWaitSettled = true
  })
  await Bun.sleep(300)
  expect(thirdWaitSettled).toBe(false)
  await started.tui.type("Read the unchanged check status.")
  await started.tui.press(key.enter)
  await thirdAnswer
  expectReadContent(persistedReadCalls(file).slice(changedReads.length), "stop-monitor")
  const thirdTurnStarts = persistedReadStarts(file).slice(changedStarts.length)
  expectSameReadKeyMaterial(thirdTurnStarts, secondTurnStarts[0]!)
  expect(readTree(thirdTurnStarts)).toBe(changedTree)
}

describe("startup", () => {
  for (const stream of ["stdin", "stdout"]) {
    it(`refuses redirected ${stream} while the other stream is a terminal`, async () => {
      const cwd = repository()
      const output = join(cwd, "redirected-output")
      const script = join(cwd, "launch.sh")
      writeFileSync(
        script,
        `bun ${join(app, "src/main.tsx")} ${
          stream === "stdin" ? "< /dev/null" : `> ${output}`
        }\nstatus=$?\nprintf 'child-exit-%s\\n' "$status"\ncat\n`
      )
      tui = await Tui.start({
        cwd,
        command: `sh ${script}`,
        env: { PATH: process.env.PATH ?? "", SMITHERS_TUI_REPLAY: join(app, "test/fixtures/pong.jsonl") }
      })
      const screen = await tui.until((screen) => screen.includes("child-exit-1"), 5_000, "terminal refusal")
      expect(screen).toContain("Interactive mode requires a terminal. Use --print <prompt>.")
      if (stream === "stdout") expect(readFileSync(output, "utf8")).toBe("")
    }, 15_000)
  }
})

describe("composer mode", () => {
  it("keeps typing immediately after clicking back to Chat", async () => {
    const { tui } = await start()
    await tui.press(key.ctrlS)
    await tui.until((screen) => screen.includes("No turns yet"), 5_000, "summary focus")
    const lines = tui.screen().split("\n")
    const row = lines.findIndex((line) => line.includes("Chat"))
    const at = `${lines[row]!.indexOf("Chat") + 1};${row + 1}`
    await tui.press(`\x1b[<0;${at}M\x1b[<0;${at}mkeep-click-draft`)
    await tui.until((screen) => /┃\s+keep-click-draft/.test(screen), 5_000, "mouse handoff keeps complete draft")
  }, 60_000)

  for (const close of [key.ctrlS, key.ctrlC, key.ctrlBracket, "i"]) {
    it(`keeps typing when leaving Summary focus in one burst (${JSON.stringify(close)})`, async () => {
      const { tui } = await start()
      await tui.press(key.ctrlS)
      await tui.until((screen) => screen.includes("No turns yet"), 5_000, "summary focus")
      await tui.press(close + "keep-all-characters")
      await tui.until((screen) => /┃\s+keep-all-characters/.test(screen), 5_000, "complete draft after focus change")
    }, 60_000)
  }

  it("keeps short-terminal input, queue controls, and status visible", async () => {
    const { tui } = await start({ cols: 40, rows: 12, holdMs: 60_000 })
    await tui.press(key.ctrlO)
    await tui.until((screen) => /Keys\s+esc/.test(screen), 5_000, "home help")
    await tui.press(key.ctrlO)
    await tui.until((screen) => !/Keys\s+esc/.test(screen), 5_000, "home help closed")
    await tui.press("\x1b[200~one\ntwo\nthree\nfour\nfive\nsix\x1b[201~")
    await tui.until((screen) => screen.includes("six") && drawn(screen), 5_000, "bounded multiline input")
    await tui.press(key.enter)
    await tui.type("queued one")
    await tui.press("\x1b\r")
    await tui.type("queued two")
    await tui.press("\x1b\r")
    await tui.until(
      (screen) => screen.includes("2 queued:") && screen.includes("alt+up") && drawn(screen),
      5_000,
      "compact queue"
    )
    await tui.press(key.escape)
    await tui.until(
      (screen) => screen.includes("queued two") && drawn(screen) && !screen.includes("2 queued:"),
      5_000,
      "interrupted queue in editor"
    )
  }, 60_000)

  it("names no mode by default and shows shell once the draft starts with !", async () => {
    const { tui } = await start()
    const footer = (screen: string) =>
      screen.split("\n").find((line) => line.includes("replay fix-add.jsonl"))?.replace(/^\s*┃/, "").trim()
    expect(footer(tui.screen())).toBe("replay fix-add.jsonl")
    await tui.type("!")
    const screen = await tui.until((screen) => footer(screen)?.includes("shell") === true, 5_000, "shell mode")
    expect(footer(screen)).toBe("shell  ·  replay fix-add.jsonl")
  }, 60_000)
})

describe("which-key", () => {
  /** The popup's title row: `Keys` on the left, `esc` on the right. */
  const popup = (screen: string) => /^\s*Keys\s+esc\s*$/m.test(screen)
  /** The draft: the composer's first non-empty row. */
  const composerLine = (screen: string) =>
    screen.split("\n").filter((line) => /^\s*┃/.test(line)).map((line) => line.replace(/^\s*┃/, "").trim()).find((
      line
    ) => line !== "")

  it("hints the context keys in the footer", async () => {
    const { tui } = await start()
    expect(tui.screen()).toContain("ctrl+k Search  ctrl+s Summary  ctrl+] Next tab  ? Keys")
    await tui.type("!")
    await tui.until((screen) => screen.includes("enter Run command  esc Cancel"), 5_000, "shell hints")
  }, 60_000)

  it("opens from the empty composer, dispatches a listed key, and closes", async () => {
    const { tui } = await start()
    await tui.press("?")
    const shown = await tui.until(popup, 5_000, "which-key popup")
    expect(shown).toMatch(/ctrl\+\]\/ctrl\+right\s+Next tab/)

    // A listed binding is a real dispatch: Ctrl+K opens the palette.
    await tui.press(key.ctrlK)
    await tui.until((screen) => !popup(screen) && screen.includes("Search"), 5_000, "palette from which-key")
    await tui.press(key.escape)
    // A lone ESC and a key read together are Alt+key; wait for the chat footer before the next key.
    await tui.until((screen) => screen.includes("ctrl+] Next tab  ? Keys"), 5_000, "palette closed")

    await tui.press("?")
    await tui.until(popup, 5_000, "which-key reopen")
    await tui.press(key.escape)
    await tui.until((screen) => !popup(screen), 5_000, "which-key close on esc")
    await tui.press("?")
    await tui.until(popup, 5_000, "which-key reopen")
    await tui.press("?")
    const closed = await tui.until((screen) => !popup(screen), 5_000, "which-key close on ?")
    expect(composerLine(closed)).not.toContain("?")
  }, 60_000)

  it.each([[60, 20], [40, 12]])(
    "scrolls complete help at %i by %i without dismissing the popup",
    async (cols, rows) => {
      const { tui } = await start({ cols, rows })
      await tui.press("?")
      await tui.until(popup, 5_000, "short which-key popup")
      let seen = tui.screen()
      for (let page = 0; page < 30; page++) {
        await tui.press("\x1b[6~")
        expect(popup(tui.screen())).toBe(true)
        seen += tui.screen()
      }
      expect(seen.replace(/\s+/g, " ")).toContain("Previous tab")
      expect(seen.replace(/\s+/g, " ")).toContain("Edit prompt")
      expect(seen).toContain("Send")
      for (let page = 0; page < 30; page++) await tui.press("\x1b[5~")
      expect(tui.screen()).toContain("Send")
      await tui.press(key.escape)
      await tui.until((screen) => !popup(screen), 5_000, "help dismissed")
    },
    60_000
  )

  it("keeps help navigable after resize at 80×24", async () => {
    const { tui } = await start({ cols: 60, rows: 20 })
    await tui.press("?")
    await tui.until(popup, 5_000, "help before resize")
    await tui.resize(80, 24)
    const resized = await tui.until(
      (screen) => popup(screen) && screen.split("\n").length === 24 && screen.includes("pgup/pgdn"),
      5_000,
      "help after resize"
    )
    expect(resized).toContain("Send")

    let seen = resized
    for (let page = 0; page < 30; page++) {
      await tui.press("\x1b[6~")
      expect(popup(tui.screen())).toBe(true)
      seen += tui.screen()
    }
    expect(seen.replace(/\s+/g, " ")).toContain("Previous tab")
    expect(seen.replace(/\s+/g, " ")).toContain("Edit prompt")
    await tui.press("\x1b[5~")
    expect(popup(tui.screen())).toBe(true)
    await tui.press(key.escape)
    await tui.until((screen) => !popup(screen), 5_000, "resized help dismissed")
  }, 60_000)

  it("keeps a message that starts with ?", async () => {
    const { tui } = await start()
    await tui.press("?")
    await tui.until(popup, 5_000, "which-key popup")
    await tui.type("why")
    const typed = await tui.until(
      (screen) => !popup(screen) && composerLine(screen)?.startsWith("?why") === true,
      5_000,
      "typed question"
    )
    expect(composerLine(typed)).toStartWith("?why")
    // Mid-draft, ? is text.
    await tui.type("?")
    await tui.until((screen) => composerLine(screen)?.startsWith("?why?") === true, 5_000, "literal ?")
  }, 60_000)
})

describe("ctrl+c and ctrl+d", () => {
  it("clears the editor on the first press and exits on a second within 500ms", async () => {
    const { tui } = await start()
    await tui.type("draft that should go away")
    await tui.until((screen) => screen.includes("draft that should go away"))
    await tui.press(key.ctrlC)
    await tui.until((screen) => !screen.includes("draft that should go away"), 3_000, "cleared editor")
    // Outside the window: a single press only clears.
    await new Promise((resolve) => setTimeout(resolve, 700))
    await tui.press(key.ctrlC)
    await new Promise((resolve) => setTimeout(resolve, 700))
    expect(tui.exited).toBeUndefined()
    await tui.press(key.ctrlC + key.ctrlC)
    expect(await tui.waitForExit()).toEqual({ code: 0 })
  }, 60_000)

  it("exits on ctrl+d only when the editor is empty", async () => {
    const { tui } = await start()
    await tui.type("x")
    await tui.press(key.ctrlD)
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(tui.exited).toBeUndefined()
    await tui.press(key.backspace)
    await tui.press(key.ctrlD)
    expect(await tui.waitForExit()).toEqual({ code: 0 })
  }, 60_000)
})

describe("tabs", () => {
  it("shows the back hint on Ctrl+S Summary and returns to Chat", async () => {
    const { tui } = await start()
    await tui.press(key.ctrlS)
    await tui.until((screen) => screen.includes("esc Chat"), 5_000, "summary back hint")
    await tui.press(key.ctrlS)
    await tui.until(
      (screen) => !screen.includes("esc Chat") && screen.includes("ctrl+k Search"),
      5_000,
      "chat after ctrl+s"
    )
    await tui.press(key.ctrlS)
    await tui.until((screen) => screen.includes("esc Chat"), 5_000, "summary again")
    await tui.press(key.escape)
    await tui.until(
      (screen) => !screen.includes("esc Chat") && screen.includes("ctrl+k Search"),
      5_000,
      "chat after esc"
    )
  }, 60_000)

  it("switches Chat and Summary by clicking a tab title", async () => {
    const { tui } = await start()
    await tui.click("Summary")
    await tui.until((screen) => screen.includes("esc Chat"), 5_000, "summary focused footer")
    await tui.click("Chat")
    await tui.until((screen) => !screen.includes("esc Chat") && screen.includes("ctrl+k Search"), 5_000, "chat footer")
  }, 60_000)

  it("cycles tabs with ctrl+] and ctrl+left", async () => {
    const { tui } = await start()
    await tui.press(key.ctrlBracket)
    await tui.until((screen) => screen.includes("esc Chat"), 5_000, "summary after ctrl+]")
    await tui.press(key.ctrlBracket)
    await tui.until(
      (screen) => !screen.includes("esc Chat") && screen.includes("ctrl+k Search"),
      5_000,
      "chat after ctrl+]"
    )
    await tui.press(key.ctrlLeft)
    await tui.until((screen) => screen.includes("esc Chat"), 5_000, "summary after ctrl+left")
  }, 60_000)

  it("steps once per ctrl+] even when two arrive before the next render", async () => {
    const { tui } = await start()
    // One PTY write: the second ctrl+] is handled before the first one's tab has drawn.
    await tui.press(`${key.ctrlBracket}${key.ctrlBracket}`)
    await tui.press(key.ctrlBracket)
    await tui.until((screen) => screen.includes("esc Chat"), 5_000, "summary after three ctrl+]")
  }, 60_000)
})

describe("esc", () => {
  it("interrupts a running agent turn and returns to idle", async () => {
    const { tui } = await start({ holdMs: 60_000 })
    await tui.type("node check.mjs fails. Fix it and show it passes.")
    await tui.press(key.enter)
    await tui.until(
      (screen) => screen.includes("esc Interrupt") && /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] \d/.test(screen),
      10_000,
      "running turn"
    )
    await tui.press(key.escape)
    const screen = await tui.until((screen) => screen.includes("✗ Stopped") && idle(screen), 5_000, "stopped turn")
    expect(screen).toContain("Ask Smithers to change this repository")
  }, 60_000)

  it("cancels a running shell command", async () => {
    const { tui } = await start()
    await tui.type("!sleep 30")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("Running… (esc to cancel)"), 5_000, "running shell")
    await tui.press(key.escape)
    await tui.until((screen) => screen.includes("(cancelled)"), 5_000, "cancelled shell")
  }, 60_000)

  it("Esc kills a SIGTERM-resistant shell and permits a new session", async () => {
    const { tui } = await start()
    await tui.type("!trap '' TERM; echo resistant-shell-ready; sleep 30")
    await tui.press(key.enter)
    await tui.until(
      (screen) => screen.includes("resistant-shell-ready") && screen.includes("Running… (esc to cancel)"),
      5_000,
      "resistant shell running"
    )
    // Wait for streamed output, rather than the command text, before signalling the group.
    await tui.until(
      (screen) => screen.split("resistant-shell-ready").length >= 3,
      5_000,
      "shell installed its signal handler"
    )
    await tui.press(key.escape)
    await tui.until((screen) => screen.includes("(cancelled)"), 5_000, "resistant shell cancelled")
    await tui.type("/new")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("New conversation started"), 5_000, "new session after cancellation")
  }, 30_000)

  it("quit waits for a resistant shell's process group to stop", async () => {
    const { tui, cwd } = await start()
    let pid: number | undefined
    try {
      await tui.type("!trap '' TERM; echo $$ > shell.pid; sleep 30")
      await tui.press(key.enter)
      await tui.until(() => existsSync(join(cwd, "shell.pid")), 5_000, "shell pid")
      pid = Number(readFileSync(join(cwd, "shell.pid"), "utf8").trim())
      await tui.type("/quit")
      await tui.press(key.enter)
      expect(await tui.waitForExit(5_000)).toEqual({ code: 0 })
      expect(() => process.kill(-pid!, 0)).toThrow()
    } finally {
      if (pid !== undefined) {
        try {
          process.kill(-pid, "SIGKILL")
        } catch {}
      }
    }
  }, 15_000)

  for (const signal of ["SIGTERM", "SIGHUP"] as const) {
    it(`${signal} stops an active shell process group`, async () => {
      const { tui, cwd } = await start()
      let pid: number | undefined
      try {
        await tui.type("!trap '' TERM; echo $$ $PPID > shell.pid; sleep 30")
        await tui.press(key.enter)
        await tui.until(() => existsSync(join(cwd, "shell.pid")), 5_000, "shell parent pid")
        const ids = readFileSync(join(cwd, "shell.pid"), "utf8").trim().split(/\s+/).map(Number)
        pid = ids[0]!
        process.kill(ids[1]!, signal)
        await tui.waitForExit(5_000)
        expect(() => process.kill(-pid!, 0)).toThrow()
      } finally {
        if (pid !== undefined) {
          try {
            process.kill(-pid, "SIGKILL")
          } catch {}
        }
      }
    }, 15_000)
  }

  it("shows a missing external editor failure and preserves the draft", async () => {
    const { tui } = await start({ editor: "/missing-tui-audit-editor" })
    await tui.type("keep my draft")
    await tui.press("\x07")
    const screen = await tui.until(
      (screen) => screen.includes("Editor unavailable") && drawn(screen),
      5_000,
      "editor startup failure"
    )
    expect(screen).toContain("keep my draft")
  }, 15_000)

  it("opens an external editor without running interactive shell startup hooks", async () => {
    const cwd = repository()
    const init = join(cwd, "shell-init")
    writeFileSync(init, "exit 37\n")
    const { tui } = await start({ cwd, shellInit: init, editor: "printf edited-without-startup >" })
    await tui.type("keep draft")
    await tui.press("\x07")
    await tui.until((screen) => screen.includes("edited-without-startup") && drawn(screen), 5_000, "editor completion")
  }, 15_000)

  it.skipIf(Bun.which("vim") === null)(
    "hands the real terminal to Vim and restores its edited Unicode draft",
    async () => {
      const { tui } = await start({ editor: "vim -u NONE -U NONE -i NONE -n" })
      await tui.type("original draft")
      await tui.press("\x07")
      await tui.until((screen) => screen.includes("prompt.md") && !drawn(screen), 5_000, "Vim foreground")
      await tui.press(key.ctrlC)
      await tui.press("gg0Cedited 中文 🦉")
      await tui.press(key.escape)
      await tui.press(":wq" + key.enter)
      const screen = await tui.until(
        (screen) => drawn(screen) && screen.includes("edited 中文 🦉"),
        5_000,
        "edited draft restored"
      )
      expect(screen).not.toContain("original draft")
      await tui.press("\x07")
      await tui.until((screen) => screen.includes("prompt.md") && !drawn(screen), 5_000, "Vim reopened")
      await tui.press(":cq" + key.enter)
      await tui.until((screen) => drawn(screen) && screen.includes("edited 中文 🦉"), 5_000, "cancel preserves draft")
    },
    30_000
  )

  it.skipIf(Bun.which("vim") === null)("cleans up a suspended external editor before restoring the draft", async () => {
    const cwd = repository()
    writeFileSync(join(cwd, "edit-vim.sh"), "echo $$ > vim.pid\nexec vim -u NONE -U NONE -i NONE -n \"$1\"\n")
    const { tui } = await start({ cwd, editor: "sh ./edit-vim.sh" })
    await tui.type("keep draft")
    await tui.press("\x07")
    await tui.until((screen) => screen.includes("prompt.md") && !drawn(screen), 5_000, "Vim foreground")
    const pid = Number(readFileSync(join(cwd, "vim.pid"), "utf8"))
    try {
      await tui.press("\x1a")
      await tui.until((screen) => drawn(screen) && screen.includes("keep draft"), 5_000, "suspended editor released")
      await Bun.sleep(100)
      expect(() => process.kill(pid, 0)).toThrow()
    } finally {
      try {
        process.kill(pid, "SIGKILL")
      } catch {}
    }
  }, 30_000)

  it.skipIf(Bun.which("vim") === null)(
    "adopts terminal resizing while an external editor owns the foreground",
    async () => {
      const { tui } = await start({ cols: 80, rows: 20, editor: "vim -u NONE -U NONE -i NONE -n" })
      await tui.press("\x07")
      await tui.until((screen) => screen.includes("prompt.md") && !drawn(screen), 5_000, "Vim foreground")
      await tui.resize(110, 40)
      await tui.press(":q!" + key.enter)
      await tui.until(
        (screen) => drawn(screen) && /↑\S+ ↓\S+/.test(screen.split("\n")[39] ?? ""),
        5_000,
        "footer at resized bottom"
      )
      await tui.press("\x07")
      await tui.until((screen) => screen.includes("prompt.md") && !drawn(screen), 5_000, "Vim reopened")
      await tui.resize(60, 12)
      await tui.press(":q!" + key.enter)
      await tui.until(
        (screen) => drawn(screen) && /↑\S+ ↓\S+/.test(screen.split("\n")[11] ?? ""),
        5_000,
        "footer after shrinking"
      )
    },
    30_000
  )

  it("termination while an external editor is open stops its child processes", async () => {
    const { tui, cwd } = await start({
      editor: "trap '' TERM HUP; echo $$ $PPID > editor.pid; sleep 30 & echo $! > editor-child.pid; wait; :"
    })
    let ids: Array<number> = []
    try {
      const main = { pid: tui.pid }
      await tui.press("\x07")
      await tui.until(() => existsSync(join(cwd, "editor-child.pid")), 5_000, "editor child")
      const [editor] = readFileSync(join(cwd, "editor.pid"), "utf8").trim().split(/\s+/).map(Number)
      const child = Number(readFileSync(join(cwd, "editor-child.pid"), "utf8").trim())
      ids = [editor!, child]
      process.kill(main.pid, "SIGTERM")
      await tui.waitForExit(5_000)
      for (const id of ids) expect(() => process.kill(id, 0)).toThrow()
    } finally {
      for (const id of ids) {
        try {
          process.kill(id, "SIGKILL")
        } catch {}
      }
    }
  }, 15_000)

  it("puts steered messages back in the editor when it stops the turn", async () => {
    const { tui } = await start({ holdMs: 60_000 })
    await tui.type("first prompt")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("alt+enter to queue"), 10_000, "running turn")
    await tui.type("also check the tests")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("steering"), 5_000, "steer")
    await tui.press(key.escape)
    await tui.until((screen) => screen.includes("Restored 1 queued message") && idle(screen), 5_000, "restored")
    expect(tui.screen()).toMatch(/┃\s+also check the tests/)
  }, 60_000)
})

describe("! shell commands", () => {
  it("runs !cmd in the working directory and records it for the agent", async () => {
    const { tui, cwd, sessions } = await start()
    await tui.type("!ls && echo done-$((1+1))")
    await tui.press(key.enter)
    const screen = await tui.until((screen) => screen.includes("done-2"), 10_000, "shell output")
    expect(screen).toContain("$ ls && echo done-$((1+1))")
    expect(screen).toContain("check.mjs")
    const folder = sessionFolder(sessions)
    const [file] = readdirSync(folder)
    const records = readFileSync(join(folder, file!), "utf8").trim().split("\n").map((line) => JSON.parse(line))
    expect(records.at(-1)).toMatchObject({
      type: "shell",
      excluded: false,
      result: { command: "ls && echo done-$((1+1))", exitCode: 0 }
    })
    expect(cwd).toBeTruthy()
  }, 60_000)

  it("shows a nonzero exit and keeps !! out of context", async () => {
    const { tui } = await start()
    await tui.type("!!node check.mjs")
    await tui.press(key.enter)
    const screen = await tui.until((screen) => screen.includes("(exit 1)"), 10_000, "exit status")
    expect(screen).toContain("add is wrong")
  }, 60_000)

  it("reads a shell write on the next replay turn (#1948)", async () => {
    const session = await readStatusSession()
    const { started, file } = session
    await started.tui.type("!printf stop-monitor > check-status.txt")
    await started.tui.press(key.enter)
    await started.tui.until(
      () =>
        Session.load(file).some((record) =>
          record.type === "shell" && record.result.command === "printf stop-monitor > check-status.txt" &&
          record.result.exitCode === 0
        ),
      10_000,
      "persisted shell write"
    )
    expect(readFileSync(join(started.cwd, "check-status.txt"), "utf8")).toBe("stop-monitor")
    await expectChangedThenUnchangedRead(session)
  }, 120_000)
})

describe("turns", () => {
  it("reads an external edit made between replay turns (#1948)", async () => {
    const session = await readStatusSession()
    // Simulate an editor or another worker changing the shared tree while chat is idle.
    writeFileSync(join(session.started.cwd, "check-status.txt"), "stop-monitor")
    await expectChangedThenUnchangedRead(session)
  }, 120_000)

  it("finishes coding with session storage inside the project", async () => {
    const cwd = repository()
    const replay = replayCells([
      "const before = await ctx.call(\"read\", { path: \"math.js\" }); console.log(before.content)",
      "await ctx.call(\"edit\", { path: \"math.js\", oldString: \"a - b\", newString: \"a + b\" }); const checked = await ctx.call(\"bash\", { mode: \"hermetic\", command: \"node check.mjs\", reads: [\".\"], writes: [], cwd: \".\" }); if (checked.exitCode !== 0) throw new Error(\"Check failed\"); console.log(checked.stdout)",
      "ctx.done(\"Fixed math.js; check passed\")"
    ])
    const started = await start({ cwd, replay, sessions: join(cwd, "sessions") })
    const { tui, sessions } = started
    await tui.type("node check.mjs fails. Fix it and show it passes.")
    await tui.press(key.enter)
    await successfulAnswer(started, "Fixed", 20_000)
    const folder = sessionFolder(sessions)
    const file = readdirSync(folder).find((name) => name.endsWith(".jsonl"))!
    const records = Session.load(join(folder, file))
    const outcome = records.findLast((record) => record.type === "outcome")
    expect(outcome?.type === "outcome" && outcome.outcome.answer).not.toContain("frame budget")
    expect(records.filter((record) => record.type === "event" && record.event._tag === "model-requested").length)
      .toBeLessThan(10)
    const mutations = records.flatMap((record) =>
      record.type === "event" && record.event._tag === "mutation-observed" ? [record.event.mutated] : []
    )
    expect(mutations).toEqual([false, true, false])
    expect(readFileSync(join(cwd, "math.js"), "utf8")).toContain("a + b")
    expect(spawnSync("node", ["check.mjs"], { cwd }).status).toBe(0)
  }, 30_000)

  it.each([40, 110])(
    "replays a whole coding turn at %i columns: cells stream, flows run, the answer lands",
    async (cols) => {
      const started = await start({ cols, cwd: repository({ git: true }), replay: codingReplay() })
      const { tui, cwd } = started
      await tui.type("node check.mjs fails. Fix it and show it passes.")
      await tui.press(key.enter)
      await tui.until((screen) => /[▾▸⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] +\d+  /.test(screen), 20_000, "first cell")
      await successfulAnswer(started)
      expect(readFileSync(join(cwd, "math.js"), "utf8")).toContain("a + b")
      const following = await tui.until(
        (screen) => screen.includes("⏸") && knob(screen) > 0,
        5_000,
        "recorded timeline"
      )
      await tui.press("\x14")
      await tui.until((screen) => screen.includes("▶"), 5_000, "timeline paused")
      await tui.press("\x1b[H")
      await tui.until((screen) => knob(screen) < knob(following), 5_000, "first journal position")
      await tui.press("\x1b[F")
      await tui.press("\x13")
      // 40 columns clip the footer hints; Escape clearing these rows proves the panel had focus.
      await tui.until((screen) => /›\s+\d+ /.test(screen), 5_000, "summary keyboard focus")
      await tui.press(key.escape)
      await tui.until(
        (screen) => !/›\s+\d+ /.test(screen) && screen.includes("▶"),
        5_000,
        "summary handles Escape and restores the chat timeline"
      )
      await tui.press(key.escape)
      // Typing right behind Escape reads as alt+key, so wait for the timeline to follow live again.
      await tui.until((screen) => screen.includes("⏸"), 5_000, "timeline follows live")
      await tui.type("keep the composer usable")
      const inspected = await tui.until(
        (screen) => /┃\s+keep the composer usable/.test(screen),
        5_000,
        "chat after inspection"
      )
      if (process.env.STRIP_EVIDENCE_DIR) {
        writeFileSync(join(process.env.STRIP_EVIDENCE_DIR, `terminal-${cols}.txt`), inspected)
        writeFileSync(join(process.env.STRIP_EVIDENCE_DIR, `terminal-${cols}.html`), await tui.html())
      }
    },
    180_000
  )

  it("folds a finished cell's code and what it printed until ctrl+o", async () => {
    const replay = replayCells([
      `const lines = [\n${
        Array.from({ length: 40 }, (_, index) => JSON.stringify(`line ${index}`)).join(",\n")
      }\n];\nconsole.log(lines.map(line => ["output", "to", "a", "specific", "file", line].join(" ")).join("\\n"))`,
      "ctx.done(\"Printed the requested lines.\")"
    ])
    const started = await start({ replay })
    const { tui } = started
    await tui.type("Print the example lines.")
    await tui.press(key.enter)
    await successfulAnswer(started, "Printed")
    const folded = tui.screen()
    expect(folded).toMatch(/… \d+ more lines/)
    expect(folded).toMatch(/printed \d+ lines · ctrl\+o/)
    expect(folded).not.toContain("output to a specific file")
    await tui.press(key.ctrlO)
    await tui.until((screen) => screen.includes("output to a specific file"), 5_000, "expanded output")
    expect(tui.screen()).not.toMatch(/… \d+ more lines/)
  }, 180_000)

  it("settles a turn and keeps working when the session file stops accepting writes", async () => {
    const { tui, sessions, cwd } = await start({
      holdMs: 1_000,
      cwd: repository({ git: true }),
      replay: codingReplay()
    })
    await tui.type("node check.mjs fails. Fix it and show it passes.")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("esc Interrupt"), 10_000, "running turn")
    const folder = sessionFolder(sessions)
    chmodSync(join(folder, readdirSync(folder).find((name) => name.endsWith(".jsonl"))!), 0o444)
    await tui.until((screen) => screen.includes("Conversation not saved: EACCES"), 10_000, "unsaved record")
    // This case deliberately refuses every later journal write, so require the
    // real completed UI state and changed file instead of a persisted outcome.
    await tui.until((screen) => idle(screen) && /●\s+Done/.test(screen), 90_000, "completed unsaved turn")
    expect(readFileSync(join(cwd, "math.js"), "utf8")).toContain("a + b")
    expect(spawnSync("node", ["check.mjs"], { cwd }).status).toBe(0)
    await tui.type("second prompt after the failed write")
    await tui.press(key.enter)
    await tui.until(
      (screen) => screen.includes("esc Interrupt") && screen.includes("second prompt after the failed write"),
      10_000,
      "second turn"
    )
    await tui.press(key.escape)
    await tui.until((screen) => screen.includes("✗ Stopped") && idle(screen), 10_000, "second turn stopped")
  }, 120_000)

  it("recalls the previous prompt with up", async () => {
    const { tui } = await start()
    await tui.type("!echo first")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("$ echo first"))
    await tui.press(key.up)
    await tui.until((screen) => /┃\s+!echo first/.test(screen), 3_000, "recalled prompt")
  }, 60_000)

  it("continues a torn session tail and can reopen the newly saved turn", async () => {
    const first = await start({ replay: join(app, "test/fixtures/pong.jsonl") })
    await first.tui.type("before torn tail")
    await first.tui.press(key.enter)
    await successfulAnswer(first, "pong", 10_000)
    await first.tui.stop()
    process.env.SMITHERS_TUI_SESSION_DIR = first.sessions
    const file = Session.latest(first.cwd)!
    appendFileSync(file, "{\"type\":\"user\",\"at\":2,\"te")
    const second = await start({
      cwd: first.cwd,
      sessions: first.sessions,
      args: "-c",
      replay: join(app, "test/fixtures/pong.jsonl")
    })
    await second.tui.until((screen) => screen.includes("before torn tail"), 5_000, "torn tail ignored")
    const beforeResumedPrompt = Session.load(file).length
    await second.tui.type("after torn tail")
    await second.tui.press(key.enter)
    await successfulAnswer(second, "pong", 10_000, beforeResumedPrompt)
    await second.tui.stop()
    expect(Session.load(file).filter((record) => record.type === "user").map((record) => record.text))
      .toEqual(["before torn tail", "after torn tail"])
    const third = await start({
      cwd: first.cwd,
      sessions: first.sessions,
      args: "-c",
      replay: join(app, "test/fixtures/pong.jsonl")
    })
    await third.tui.until(
      (screen) => screen.includes("before torn tail") && screen.includes("after torn tail"),
      5_000,
      "both turns survive another restart"
    )
    expect(third.tui.screen()).not.toContain("damaged")
  }, 45_000)

  it("saves and resumes a conversation from a deeply nested project", async () => {
    const cwd = join(repository(), "a".repeat(90), "b".repeat(90), "c".repeat(90))
    mkdirSync(cwd, { recursive: true })
    const first = await start({ cwd, replay: join(app, "test/fixtures/pong.jsonl") })
    await first.tui.type("remember this deep project")
    await first.tui.press(key.enter)
    await successfulAnswer(first, "pong", 15_000)
    expect(first.tui.screen()).not.toContain("Conversation not saved")
    process.env.SMITHERS_TUI_SESSION_DIR = first.sessions
    const file = Session.latest(cwd)!
    expect(Session.load(file)).toContainEqual({
      type: "user",
      at: expect.any(Number),
      text: "remember this deep project"
    })
    await first.tui.stop()
    const resumed = await start({
      cwd,
      sessions: first.sessions,
      replay: join(app, "test/fixtures/pong.jsonl"),
      args: "-c"
    })
    await resumed.tui.until(
      (screen) => screen.includes("remember this deep project") && screen.includes("pong"),
      10_000,
      "deep project resumed"
    )
  }, 60_000)

  it("continues the latest session with -c", async () => {
    const first = await start()
    await first.tui.type("!echo remembered-output")
    await first.tui.press(key.enter)
    await first.tui.until((screen) => screen.includes("remembered-output"))
    await first.tui.stop()
    tui = await Tui.start({
      cwd: first.cwd,
      command: `bun ${join(app, "src", "main.tsx")} ${first.cwd} -c`,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        SMITHERS_TUI_REPLAY: fixture,
        SMITHERS_TUI_SESSION_DIR: first.sessions,
        SMITHERS_TUI_APPROVE: "all"
      }
    })
    await tui.until((screen) => screen.includes("remembered-output"), 20_000, "restored transcript")
  }, 90_000)
})

describe("completion", () => {
  it("moves through / commands with the arrows and runs the chosen one with enter", async () => {
    const { tui } = await start()
    await tui.type("/")
    await tui.until((screen) => screen.includes("/hotkeys") || screen.includes("/model"), 5_000, "command menu")
    await tui.type("conv")
    await tui.until((screen) => /\/conversation\s+Show the conversation file/.test(screen), 5_000, "filtered menu")
    await tui.press(key.enter)
    await tui.until((screen) => /exchanges · ↑0/.test(screen), 5_000, "session note")
  }, 60_000)

  it("completes an argument: /thinking hi, down, enter picks xhigh", async () => {
    const { tui } = await start()
    await tui.type("/thinking hi")
    await tui.until((screen) => screen.includes("xhigh"), 5_000, "levels")
    await tui.press(key.down)
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("Thinking level: xhigh"), 5_000, "level set")
  }, 60_000)

  it("down and enter in one burst pick the row down moved to", async () => {
    const { tui } = await start()
    await tui.type("/thinking hi")
    await tui.until((screen) => screen.includes("xhigh") && /┃\s+\/thinking hi/.test(screen), 5_000, "levels")
    await tui.press(key.down + key.enter)
    await tui.until((screen) => screen.includes("Thinking level: xhigh"), 5_000, "level set")
  }, 60_000)

  it("inserts an @file mention with tab and leaves the draft unsent", async () => {
    const { tui } = await start()
    await tui.type("look at @chk")
    await tui.until((screen) => screen.includes("check.mjs"), 5_000, "file menu")
    await tui.press(key.tab)
    await tui.until((screen) => /┃\s+look at @check\.mjs/.test(screen), 5_000, "mention")
    await tui.type("please")
    await tui.until((screen) => screen.includes("@check.mjs please"), 5_000, "typing continues")
  }, 60_000)

  it("enter in the burst that finishes a command runs the whole command", async () => {
    const { tui } = await start()
    await tui.type("/summ")
    await tui.until((screen) => /┃\s+\/summ/.test(screen) && screen.includes("/summary"), 5_000, "menu")
    // The rest of the word and Enter arrive before the next render, as they do under load.
    await tui.press("ary" + key.enter)
    await tui.until((screen) => screen.includes("u Undo changes"), 5_000, "summary")
  }, 60_000)

  it("esc closes the menu without clearing the draft", async () => {
    const { tui } = await start()
    await tui.type("/mod")
    await tui.until((screen) => screen.includes("Pick a model"), 5_000, "menu")
    await tui.press(key.escape)
    await tui.until((screen) => !screen.includes("Pick a model") && /┃\s+\/mod/.test(screen), 5_000, "closed menu")
  }, 60_000)
})

describe("search palette", () => {
  it("routes typeahead after Ctrl+L into the model filter and keeps the draft empty", async () => {
    const { tui } = await start()
    await tui.press("\x0c" + "replay-filter")
    await tui.until(
      (screen) => screen.includes("Select model") && screen.includes("replay-filter"),
      5_000,
      "model query"
    )
    await tui.press(key.escape)
    await tui.until((screen) => !screen.includes("Select model"), 5_000, "model picker closed")
    expect(tui.screen()).not.toContain("replay-filter")
  }, 60_000)

  for (const close of [key.ctrlC, key.ctrlK]) {
    it(`keeps typing after closing the palette in one burst (${JSON.stringify(close)})`, async () => {
      const { tui } = await start()
      await tui.press(key.ctrlK)
      await tui.until((screen) => screen.includes("Search") && screen.includes("/model"), 5_000, "palette")
      await tui.press(close + "keep-this-draft")
      await tui.until((screen) => /┃\s+keep-this-draft/.test(screen), 5_000, "complete draft")
    }, 60_000)
  }

  it("keeps typing after choosing a file in one burst", async () => {
    const { tui } = await start()
    await tui.press(key.ctrlK)
    await tui.type("check")
    await tui.until((screen) => screen.includes("check.mjs"), 5_000, "file row")
    await tui.press(key.enter + "keep-this-draft")
    await tui.until((screen) => /┃\s+@check\.mjs keep-this-draft/.test(screen), 5_000, "mention and complete draft")
  }, 60_000)

  it("ctrl+k opens Search without deleting the rest of the line", async () => {
    const { tui } = await start()
    await tui.type("look at ")
    await tui.press(key.ctrlA)
    await tui.press(key.ctrlK)
    await tui.until((screen) => screen.includes("Search") && screen.includes("/model"), 5_000, "palette")
    await tui.press(key.escape)
    await tui.until((screen) => !screen.includes("Pick a model") && /┃\s+look at/.test(screen), 5_000, "draft kept")
  }, 60_000)

  it("enter on a file inserts an @mention after the draft", async () => {
    const { tui } = await start()
    await tui.type("look at ")
    await tui.press(key.ctrlK)
    await tui.until((screen) => screen.includes("Search"), 5_000, "palette")
    await tui.type("check")
    await tui.until((screen) => screen.includes("check.mjs"), 5_000, "file row")
    await tui.press(key.enter)
    await tui.until((screen) => /┃\s+look at @check\.mjs/.test(screen), 5_000, "mention")
  }, 60_000)

  it("text: searches file text with rg and inserts @path:line", async () => {
    const { tui } = await start()
    await tui.press(key.ctrlK)
    await tui.until((screen) => screen.includes("Search"), 5_000, "palette")
    await tui.type("text:a - b")
    await tui.until((screen) => screen.includes("math.js:1"), 10_000, "rg hit")
    await tui.press(key.enter)
    await tui.until((screen) => /┃\s+@math\.js:1/.test(screen), 5_000, "line mention")
  }, 60_000)

  it("runs a command, and ? lists prefixes that switch the mode", async () => {
    const { tui } = await start()
    await tui.press(key.ctrlK)
    await tui.type("/conv")
    await tui.until((screen) => /\/conversation\s+Show the conversation file/.test(screen), 5_000, "command row")
    await tui.press(key.enter)
    await tui.until((screen) => /exchanges · ↑0/.test(screen), 5_000, "session note")
    await tui.press(key.ctrlK)
    await tui.type("?")
    await tui.until(
      (screen) => screen.includes("conversation:") && screen.includes("worker tabs"),
      5_000,
      "prefix list"
    )
    await tui.press(key.enter)
    await tui.type("hotk")
    await tui.until((screen) => /\/hotkeys\s+Show the keys/.test(screen), 5_000, "typed after the prefix")
  }, 60_000)

  it("a picked command keeps the draft out of the way and out of history", async () => {
    const { tui } = await start()
    await tui.type("my precious draft")
    await tui.press(key.ctrlK)
    await tui.type("/conv")
    await tui.until((screen) => /\/conversation\s+Show the conversation file/.test(screen), 5_000, "command row")
    await tui.press(key.enter)
    await tui.until(
      (screen) => /exchanges · ↑0/.test(screen) && /┃\s+my precious draft/.test(screen),
      5_000,
      "draft kept"
    )
    await tui.press(key.ctrlK)
    await tui.type("/name")
    await tui.until((screen) => /\/name\s+<name>/.test(screen), 5_000, "name row")
    await tui.press(key.enter)
    await tui.until((screen) => /┃\s+\/name\s*$/m.test(screen), 5_000, "command in composer")
    await tui.type("kept")
    await tui.press(key.enter)
    await tui.until((screen) => /┃\s+my precious draft/.test(screen), 5_000, "draft restored")
  }, 60_000)

  for (const rows of [8, 12]) {
    it(`keeps search selection and count visible in a 40 by ${rows} terminal`, async () => {
      const cwd = repository()
      writeFileSync(join(cwd, "many.txt"), "small-needle\n".repeat(75))
      const { tui } = await start({ cwd, cols: 40, rows })
      await tui.press(key.ctrlK + "text:small-needle")
      await tui.until((screen) => screen.includes("many.txt:1"), 5_000, "search matches")
      await tui.press(key.down.repeat(30))
      const screen = await tui.until(
        (screen) => screen.includes("31/75") && screen.includes("many.txt:31"),
        5_000,
        "selected row and count"
      )
      expect(screen).toContain("text:small-needle")
      expect(screen).toContain("esc")
    }, 30_000)
  }

  it("text: says when one file reaches the global cap", async () => {
    const cwd = repository()
    writeFileSync(join(cwd, "many.txt"), "repeated\n".repeat(240))
    const { tui } = await start({ cwd })
    await tui.press(key.ctrlK)
    await tui.type("text:repeated")
    await tui.until((screen) => screen.includes("Search · first 200"), 10_000, "cap shown")
  }, 60_000)

  it("typing in the same burst as ctrl+k lands in the search, not the composer", async () => {
    const cwd = repository()
    for (let file = 0; file < 12; file++) {
      writeFileSync(join(cwd, `many${file}.txt`), Array.from({ length: 20 }, () => "repeated").join("\n") + "\n")
    }
    const { tui } = await start({ cwd })
    // One PTY write: every key arrives before the palette has drawn its input.
    await tui.press(`${key.ctrlK}text:repeated`)
    const screen = await tui.until((screen) => screen.includes("Search · first 200"), 10_000, "cap shown")
    expect(screen).not.toMatch(/┃\s+text:repeated/)
  }, 60_000)

  it("conversation: resumes a past conversation", async () => {
    const first = await start()
    await first.tui.type("!echo remembered-output")
    await first.tui.press(key.enter)
    await first.tui.until((screen) => screen.includes("remembered-output"))
    await first.tui.stop()
    tui = await Tui.start({
      cwd: first.cwd,
      command: `bun ${join(app, "src", "main.tsx")} ${first.cwd}`,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        SMITHERS_TUI_REPLAY: fixture,
        SMITHERS_TUI_SESSION_DIR: first.sessions,
        SMITHERS_TUI_APPROVE: "all"
      }
    })
    await tui.until(drawn, 20_000, "first draw")
    await tui.press(key.ctrlK)
    await tui.type("conversation:")
    await tui.until((screen) => /Search[\s\S]*_[0-9a-f]{8}-/.test(screen), 5_000, "session row")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("Resumed") && screen.includes("remembered-output"), 5_000, "resumed")
  }, 90_000)
})

describe("timeline scrubber", () => {
  /** A real worker session: 20 frames, an edit pin, and the verdict. */
  const restored = (cols: number) => {
    const cwd = repository()
    const sessions = mkdtempSync(join(tmpdir(), "tui-sessions-"))
    process.env.SMITHERS_TUI_SESSION_DIR = sessions
    mkdirSync(Session.directory(cwd), { recursive: true })
    writeFileSync(
      join(Session.directory(cwd), "2026-09-23T20-05-36-811Z_timeline.jsonl"),
      readFileSync(join(app, "test", "fixtures", "timeline-worker.jsonl"))
    )
    return start({ cwd, sessions, args: "-c", cols })
  }

  it("a click on a milestone jumps the chat to its numbered step; keys step and esc follows live", async () => {
    const { tui } = await restored(120)
    // The scrubber paints before the composer below it; the composer then
    // pushes it up several rows. Read coordinates only from the settled
    // layout, or the click lands in the chat and nothing pauses.
    const screen = await tui.until(
      (screen) =>
        screen.includes("approvals.ts") && screen.includes("⏸ Pause") &&
        screen.includes("Ask Smithers to change this repository"),
      15_000,
      "settled scrubber"
    )
    const rows = screen.split("\n")
    const row = rows.findIndex((line) => line.includes("approvals.ts") && !line.includes("┃"))
    const column = rows[row]!.indexOf("approvals.ts")
    await tui.press(`\x1b[<0;${column + 2};${row + 1}M\x1b[<0;${column + 2};${row + 1}m`)
    // Step 10 can already be on screen at the live end; the playhead pausing is the jump.
    const jumped = await tui.until(
      (screen) => screen.includes("▶ Live") && /▾ 10\s+patched approvals\.ts/.test(screen),
      5_000,
      "jumped to step 10"
    )
    expect(jumped).toContain("Implementing")
    expect(jumped).toContain("▶ Live")
    await tui.press("\x1b[D")
    await tui.until((screen) => /▾ \s?9\s/.test(screen) || /▾ \s?8\s/.test(screen), 5_000, "previous step")
    await tui.press("]")
    await tui.until((screen) => screen.includes("patched approvals.ts"), 5_000, "next milestone")
    await tui.press(key.escape)
    await tui.until((screen) => screen.includes("⏸ Pause") && screen.includes("Done"), 5_000, "following live")
  }, 60_000)

  it("stays inside a narrow terminal", async () => {
    const { tui } = await restored(40)
    const screen = await tui.until((screen) => screen.includes("⏸") && screen.includes("●"), 15_000, "narrow scrubber")
    for (const line of screen.split("\n")) expect([...line.trimEnd()].length).toBeLessThanOrEqual(40)
  }, 60_000)
})

describe("new session", () => {
  it("starts with no filter, queued follow-up or form left from the last session", async () => {
    const { tui } = await start()
    await tui.type("!echo alpha-row")
    await tui.press(key.enter)
    await tui.until(
      (screen) => screen.includes("alpha-row") && screen.includes("exit 0") || /alpha-row[\s\S]*alpha-row/.test(screen),
      10_000,
      "shell row"
    )
    await tui.type("/grep no-such-text")
    await tui.press(key.enter)
    await tui.until((screen) => !screen.includes("alpha-row"), 5_000, "filtered away")
    await tui.type("/new")
    await tui.press(key.enter)
    await tui.type("!echo beta-row")
    await tui.press(key.enter)
    await tui.until((screen) => /beta-row[\s\S]*beta-row/.test(screen), 10_000, "new session shows its rows")
  }, 60_000)
})

describe("fork", () => {
  it("forks before a picked message, puts it back in the editor, and keeps the original", async () => {
    const cwd = repository()
    const sessions = mkdtempSync(join(tmpdir(), "tui-sessions-"))
    process.env.SMITHERS_TUI_SESSION_DIR = sessions
    const source = Session.create(cwd)
    const exchange = (at: number, text: string, answer: string) => {
      source.append({ type: "user", at, text })
      const message = { role: "assistant", content: [{ type: "text", text: answer }] }
      source.append({ type: "event", at: at + 1, event: { _tag: "resolved", message } } as unknown as Session.Record)
      source.append({ type: "outcome", at: at + 1, prompt: text, outcome: { _tag: "done", answer } })
    }
    exchange(1, "first question", "A1")
    exchange(3, "second question", "A2")
    const before = readFileSync(source.file, "utf8")
    const { tui } = await start({ cwd, sessions, args: "-c" })
    await tui.until((screen) => screen.includes("A2"), 10_000, "restored session")
    await tui.type("/fork")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("Fork from message"), 5_000, "fork dialog")
    await tui.type("second")
    await tui.press(key.enter)
    await tui.until(
      (screen) => /┃\s+second question/.test(screen) && screen.includes("Forked to a new conversation"),
      5_000,
      "forked"
    )
    expect(tui.screen()).not.toContain("A2")
    expect(tui.screen()).toContain("A1")
    const listed = Session.list(cwd)
    expect(listed).toHaveLength(2)
    expect(readFileSync(source.file, "utf8")).toBe(before)
    const forked = listed.find((each) => each.file !== source.file)!
    expect(Session.load(forked.file)[0]).toMatchObject({ type: "session", parent: source.file })
  }, 60_000)

  it("refuses while a turn runs", async () => {
    const { tui } = await start({ holdMs: 60_000 })
    await tui.type("node check.mjs fails. Fix it and show it passes.")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("esc Interrupt"), 20_000, "turn running")
    await tui.type("/fork")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("Stop running work first"), 5_000, "refusal")
    expect(tui.screen()).not.toContain("Fork from message")
  }, 60_000)

  it("refuses while a shell command runs", async () => {
    const { tui } = await start()
    await tui.type("!sleep 30")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("Running… (esc to cancel)"), 5_000, "running shell")
    await tui.type("/fork")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("Stop running work first"), 5_000, "refusal")
    expect(tui.screen()).not.toContain("Fork from message")
  }, 60_000)

  it("refuses while a worker runs", async () => {
    tui = await Tui.start({
      cwd: repository(),
      command: `bun ${join(app, "e2e", "workspace-fixture.tsx")}`,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        SMITHERS_TUI_SESSION_DIR: mkdtempSync(join(tmpdir(), "tui-background-"))
      }
    })
    await tui.until(drawn, 20_000, "first draw")
    await tui.type("investigate")
    await tui.press(key.enter)
    await tui.until(
      (screen) => /Investigation · \d+s/.test(screen) && !screen.includes("esc Interrupt"),
      5_000,
      "worker"
    )
    await tui.type("/fork")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("Stop running work first"), 5_000, "refusal")
    expect(tui.screen()).not.toContain("Fork from message")
  }, 60_000)

  it("has nothing to fork in a fresh session", async () => {
    const { tui } = await start()
    await tui.type("/fork")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("No messages to fork from"), 5_000, "empty")
  }, 60_000)
})

describe("model dialog", () => {
  it("chooses the latest picker row and filter when keys arrive in one burst", async () => {
    const { tui } = await start({ home: mkdtempSync(join(tmpdir(), "tui-theme-home-")) })
    await tui.type("/theme")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("Select theme"), 5_000, "theme picker")
    await tui.press(key.down + key.enter)
    await tui.until((screen) => !screen.includes("Select theme"), 5_000, "selected theme")
    await tui.type("/theme")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("Select theme"), 5_000, "reopened picker")
    expect(tui.screen()).toMatch(/●\s+blue/)
    await tui.press("green" + key.enter)
    await tui.until((screen) => !screen.includes("Select theme"), 5_000, "filtered theme")
    await tui.type("/theme")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("Select theme"), 5_000, "final picker")
    expect(tui.screen()).toMatch(/●\s+green/)
  }, 60_000)

  it("filters as you type and picks with enter", async () => {
    const { tui } = await start()
    await tui.type("/model")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("Select model"), 5_000, "dialog")
    await tui.type("zzzz-none")
    await tui.until((screen) => screen.includes("No model matches \"zzzz-none\""), 5_000, "empty filter")
    await tui.press(key.escape)
    await tui.until((screen) => !screen.includes("Select model"), 5_000, "closed dialog")
  }, 60_000)
})

describe("runtime views", () => {
  it(
    "navigates summary rows with hjkl/arrows, expands code, toggles the real diff, and returns focus to chat",
    async () => {
      const started = await start({ cwd: repository({ git: true }), replay: codingReplay() })
      const { tui } = started
      await tui.type("node check.mjs fails. Fix it and show it passes.")
      await tui.press(key.enter)
      await successfulAnswer(started)
      await tui.type("/summary")
      await tui.press(key.enter)
      await tui.until((screen) => screen.includes("enter Expand row") && screen.includes("Asked:"), 5_000, "summary")
      await tui.type("jl")
      await tui.until(
        (screen) => screen.includes("ctx.call(\"ls\"") && /› .*Ran node check\.mjs \(exit 1\)/.test(screen),
        5_000,
        "expanded first cell"
      )
      await tui.type("hj")
      await tui.until((screen) => /› .*Read math\.js/.test(screen), 5_000, "read row")
      await tui.type("j")
      await tui.until((screen) => /› .*Updated math\.js/.test(screen), 5_000, "edit row")
      await tui.type("d")
      const diff = await tui.until(
        (screen) => screen.includes("math.js") && screen.includes("a + b") && screen.includes("a - b"),
        5_000,
        "real edit diff"
      )
      expect(diff).toContain("Updated math.js")
      await tui.type("v")
      await tui.until((screen) => screen.includes("a + b") && screen.includes("a - b"), 5_000, "split diff")
      await tui.press(key.up)
      await tui.until((screen) => screen.includes("No recorded changes."), 5_000, "previous turn")
      await tui.press(key.escape)
      await tui.type("a new question")
      await tui.until((screen) => /┃\s+a new question/.test(screen), 5_000, "usable composer")
    },
    180_000
  )

  /** Runs the coding turn in a git repository and selects the `Updated math.js` row in the Summary. */
  const editRow = async (options: { readonly sessions?: string } = {}) => {
    const started = await start({ cwd: repository({ git: true }), replay: codingReplay(), ...options })
    await started.tui.type("node check.mjs fails. Fix it and show it passes.")
    await started.tui.press(key.enter)
    await successfulAnswer(started)
    await started.tui.type("/summary")
    await started.tui.press(key.enter)
    await started.tui.until(
      (screen) => screen.includes("u Undo changes") && screen.includes("Asked:"),
      5_000,
      "summary"
    )
    for (let step = 0; step < 8 && !/› .*Updated math\.js/.test(started.tui.screen()); step++) {
      await started.tui.type("j")
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
    await started.tui.until((screen) => /› .*Updated math\.js/.test(screen), 5_000, "edit row")
    return started
  }

  it("u on the edit row confirms, restores math.js, and tells the transcript", async () => {
    const { tui, cwd } = await editRow()
    expect(readFileSync(join(cwd, "math.js"), "utf8")).toContain("a + b")
    await tui.type("u")
    await tui.until((screen) => screen.includes("Undo math.js?"), 5_000, "confirm")
    await tui.press(key.enter)
    await tui.until(
      (screen) => readFileSync(join(cwd, "math.js"), "utf8").includes("a - b") && screen.includes("Undid math.js"),
      10_000,
      "undone"
    )
    await tui.until((screen) => /› .*Undone: Updated math\.js/.test(screen), 5_000, "undone row")
    await tui.press(key.escape)
    await tui.until(
      (screen) => screen.includes("Undid math.js") && !screen.includes("u Undo changes"),
      5_000,
      "chat note"
    )
    await tui.type("still usable")
    await tui.until((screen) => /┃\s+still usable/.test(screen), 5_000, "usable composer")
  }, 180_000)

  it("u refuses when math.js changed since, and changes nothing", async () => {
    const { tui, cwd } = await editRow()
    writeFileSync(join(cwd, "math.js"), "export const add = (a, b) => b + a\n")
    await tui.type("u")
    await tui.until((screen) => screen.includes("Undo math.js?"), 5_000, "confirm")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("changed since: math.js"), 10_000, "conflict")
    expect(readFileSync(join(cwd, "math.js"), "utf8")).toBe("export const add = (a, b) => b + a\n")
  }, 180_000)

  it("esc in the undo dialog changes nothing", async () => {
    const { tui, cwd } = await editRow()
    await tui.type("u")
    await tui.until((screen) => screen.includes("Undo math.js?"), 5_000, "confirm")
    await tui.press(key.escape)
    await tui.until((screen) => !screen.includes("Undo math.js?"), 5_000, "closed")
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(readFileSync(join(cwd, "math.js"), "utf8")).toContain("a + b")
    expect(tui.screen()).not.toContain("Undid")
  }, 180_000)

  it("u refuses while a turn runs, and the composer stays usable", async () => {
    const { tui } = await start({ holdMs: 60_000 })
    await tui.type("node check.mjs fails. Fix it and show it passes.")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("esc Interrupt"), 10_000, "running turn")
    await tui.press(key.ctrlS)
    await tui.until((screen) => screen.includes("u Undo changes"), 5_000, "summary")
    await tui.type("u")
    await tui.until((screen) => screen.includes("Stop running work first"), 5_000, "busy")
    await tui.press(key.escape)
    await tui.type("still usable")
    await tui.until((screen) => /┃\s+still usable/.test(screen), 5_000, "usable composer")
  }, 60_000)

  it("keeps the undo across a restart", async () => {
    const first = await editRow()
    await first.tui.type("u")
    await first.tui.until((screen) => screen.includes("Undo math.js?"), 5_000, "confirm")
    await first.tui.press(key.enter)
    await first.tui.until((screen) => screen.includes("Undid math.js"), 10_000, "undone")
    await first.tui.stop()
    tui = await Tui.start({
      cwd: first.cwd,
      command: `bun ${join(app, "src", "main.tsx")} ${first.cwd} -c`,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        SMITHERS_TUI_REPLAY: fixture,
        SMITHERS_TUI_SESSION_DIR: first.sessions,
        SMITHERS_TUI_APPROVE: "all"
      }
    })
    await tui.until((screen) => screen.includes("Undid math.js"), 20_000, "restored note")
    await tui.type("/summary")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("Undone: Updated math.js"), 5_000, "restored row")
    for (let step = 0; step < 8 && !/› .*Undone: Updated math\.js/.test(tui.screen()); step++) {
      await tui.type("j")
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
    await tui.until((screen) => /› .*Undone: Updated math\.js/.test(screen), 5_000, "undone row")
    await tui.type("u")
    await tui.until((screen) => screen.includes("Already undone"), 5_000, "already undone")
  }, 180_000)

  it("u in a worker tab undoes the worker's edit and records it in the worker file", async () => {
    const cwd = repository()
    const sessions = mkdtempSync(join(tmpdir(), "tui-worker-undo-"))
    tui = await Tui.start({
      cwd,
      command: `bun ${join(app, "e2e", "workspace-fixture.tsx")}`,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", SMITHERS_TUI_SESSION_DIR: sessions }
    })
    await tui.until(drawn, 20_000, "first draw")
    await tui.type("delegate fix")
    await tui.press(key.enter)
    await tui.until(
      (screen) => screen.includes("Fixer finished") && /Done \d+s · worker/.test(screen),
      10_000,
      "worker done"
    )
    expect(readFileSync(join(cwd, "math.js"), "utf8")).toContain("a + b")
    await tui.press(key.ctrlK)
    await tui.type("tab:fix")
    await tui.until((screen) => screen.includes("Search") && /Fixer\s+done/.test(screen), 5_000, "tab row")
    await tui.press(key.enter)
    await tui.until(
      (screen) =>
        screen.includes("esc Chat") && screen.includes("u Undo changes") && screen.includes("Subagent · Fixer"),
      5_000,
      "worker tab"
    )
    // j picks the edit cell; u undoes that row, not the whole worker.
    for (let step = 0; step < 8 && !/› .*ctx\.call\("edit"\)/.test(tui.screen()); step++) {
      await tui.type("j")
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
    await tui.until((screen) => /› .*ctx\.call\("edit"\)/.test(screen), 5_000, "edit row")
    await tui.type("u")
    await tui.until((screen) => screen.includes("Undo math.js?"), 5_000, "confirm")
    await tui.press(key.enter)
    await tui.until(
      (screen) => readFileSync(join(cwd, "math.js"), "utf8").includes("a - b") && screen.includes("Undid math.js"),
      10_000,
      "undone"
    )
    const folder = sessionFolder(sessions)
    const lines = (file: string) => readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line))
    const chat = lines(join(folder, readdirSync(folder).find((name) => name.endsWith(".jsonl"))!))
    expect(chat.filter((record) => record.type === "undo")).toMatchObject([{ tab: "fixer", paths: ["math.js"] }])
    const worker = lines(join(folder, "workers", readdirSync(join(folder, "workers"))[0]!))
    expect(worker.filter((record) => record.type === "undo")).toMatchObject([{ paths: ["math.js"] }])
    await tui.type("u")
    await tui.until((screen) => screen.includes("Already undone"), 5_000, "already undone")
  }, 60_000)

  it(
    "estimates a new worker from the finished one, shows it on the tab, and a coordinator turn answers ETA through tab.eta",
    async () => {
      const cwd = repository()
      const sessions = mkdtempSync(join(tmpdir(), "tui-estimate-"))
      tui = await Tui.start({
        cwd,
        command: `bun ${join(app, "e2e", "workspace-fixture.tsx")}`,
        env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", SMITHERS_TUI_SESSION_DIR: sessions }
      })
      await tui.until(drawn, 20_000, "first draw")
      await tui.type("delegate fix")
      await tui.press(key.enter)
      await tui.until(
        (screen) => screen.includes("Fixer finished") && /Done \d+s · worker/.test(screen),
        10_000,
        "worker done"
      )
      await tui.type("investigate")
      await tui.press(key.enter)
      // The only history is a worker that took milliseconds, so the new one is soon past its estimate.
      await tui.until((screen) => /Investigation[^\n]* late/.test(screen), 10_000, "estimate on the tab")
      await tui.type("what is the ETA on all tasks")
      await tui.press(key.enter)
      await tui.until((screen) => screen.includes("ETA investigation:running:class"), 30_000, "tab.eta answer")
      const folder = sessionFolder(sessions)
      const ledger = readFileSync(join(folder, "evals", "estimates.jsonl"), "utf8").trim().split("\n")
        .map((line) => JSON.parse(line))
      expect(ledger.filter((entry) => entry.type === "observation" && entry.observation.kind === "delegate"))
        .toHaveLength(1)
      expect(ledger.filter((entry) => entry.type === "prediction" && entry.prediction.kind === "delegate"))
        .toMatchObject([{ prediction: { method: "class", subject: "Investigation\nInvestigate the failing check." } }])
      // Chat turns are measured too: every settled turn is on record.
      expect(ledger.filter((entry) => entry.type === "observation" && entry.observation.kind === "turn").length)
        .toBeGreaterThanOrEqual(2)
    },
    60_000
  )

  it("undo refuses while a project flow is active", async () => {
    const cwd = repository()
    tui = await Tui.start({
      cwd,
      command: `bun ${join(app, "e2e", "workspace-fixture.tsx")}`,
      env: { PATH: process.env.PATH!, HOME: process.env.HOME!, SMITHERS_TUI_SESSION_DIR: join(cwd, "sessions") }
    })
    await tui.until(drawn, 20_000)
    await tui.type("delegate fix")
    await tui.press(key.enter)
    await tui.until((screen) =>
      screen.includes("Requested the fix.") && screen.includes("Fixer finished") && /Done \d+s · worker/.test(screen)
    )
    await tui.type("/flow review title=x")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("review · running"))
    await tui.type("/tabs")
    await tui.press(key.enter)
    await tui.until(
      (screen) => screen.includes("esc Chat") && screen.includes("u Undo changes"),
      5_000,
      "worker footer"
    )
    await tui.press("u")
    const screen = await tui.until((screen) =>
      screen.includes("Stop running work first") || screen.includes("Undo math.js?")
    )
    expect(screen).toContain("Stop running work first")
    expect(screen).not.toContain("Undo math.js?")
    expect(readFileSync(join(cwd, "math.js"), "utf8")).toContain("a + b")
  }, 60_000)

  it("undo refuses a FIFO and leaves chat usable", async () => {
    const { tui, cwd } = await editRow()
    rmSync(join(cwd, "math.js"))
    if (spawnSync("mkfifo", [join(cwd, "math.js")]).status !== 0) throw new Error("mkfifo failed")
    await tui.type("u")
    await tui.until((screen) => screen.includes("Undo math.js?"), 5_000, "confirm")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("changed since: math.js"), 5_000, "undo settled")
    await tui.press(key.escape)
    await tui.type("/new")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("New conversation started"), 5_000, "new session")
  }, 60_000)

  it("/new is refused while an undo is pending and starts a session once it settles", async () => {
    const cwd = repository()
    const sessions = mkdtempSync(join(tmpdir(), "tui-undo-hold-"))
    const gate = join(sessions, "release-undo")
    tui = await Tui.start({
      cwd,
      command: `bun ${join(app, "e2e", "undo-hold-fixture.ts")}`,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        SMITHERS_TUI_SESSION_DIR: sessions,
        SMITHERS_TUI_UNDO_HOLD: gate
      }
    })
    await tui.until(drawn, 20_000, "first draw")
    await tui.type("delegate fix")
    await tui.press(key.enter)
    await tui.until(
      (screen) => screen.includes("Fixer finished") && /Done \d+s · worker/.test(screen),
      10_000,
      "worker done"
    )
    await tui.press(key.ctrlK)
    await tui.type("tab:fix")
    await tui.until((screen) => screen.includes("Search") && /Fixer\s+done/.test(screen), 5_000, "tab row")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("u Undo changes") && screen.includes("Fixer"), 5_000, "worker tab")
    for (let step = 0; step < 8 && !/› .*ctx\.call\("edit"\)/.test(tui.screen()); step++) {
      await tui.type("j")
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
    await tui.until((screen) => /› .*ctx\.call\("edit"\)/.test(screen), 5_000, "edit row")
    await tui.type("u")
    await tui.until((screen) => screen.includes("Undo math.js?"), 5_000, "confirm")
    await tui.press(key.enter)
    await tui.until(() => existsSync(`${gate}.held`), 5_000, "undo held")
    await tui.press(key.escape)
    await tui.type("/new")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("Stop running work first"), 5_000, "refused")
    expect(tui.screen()).not.toContain("New conversation started")
    expect(readdirSync(sessions, { withFileTypes: true }).filter((entry) => entry.isDirectory())).toHaveLength(1)
    expect(readFileSync(join(cwd, "math.js"), "utf8")).toContain("a + b")
    writeFileSync(gate, "")
    await tui.until(
      (screen) => readFileSync(join(cwd, "math.js"), "utf8").includes("a - b") && screen.includes("Undid math.js"),
      10_000,
      "undone"
    )
    await tui.type("/new")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("New conversation started"), 5_000, "new session")
  }, 60_000)

  it("renders agent-authored UI from a real cell and restores it after restart", async () => {
    const cwd = repository()
    const sessions = mkdtempSync(join(tmpdir(), "tui-panels-"))
    const recording = join(sessions, "ui-reply.jsonl")
    const panel = {
      id: "checks",
      title: "Checks",
      summary: "The addition check passed.",
      rows: [{
        id: "addition",
        label: "Checked addition",
        status: "done",
        details: [{ kind: "code", language: "javascript", code: "assert(add(2, 3) === 5)" }]
      }]
    }
    const reply = `\`\`\`javascript\nconst shown = await ctx.call("ui.publish", ${
      JSON.stringify(panel)
    }); if (shown.ok === false) throw new Error(JSON.stringify(shown)); ctx.done("Published the checks view.")\n\`\`\``
    writeFileSync(
      recording,
      [
        { at: 1, event: { _tag: "model-requested" } },
        { at: 2, event: { _tag: "model-delta", delta: { type: "text-delta", id: "reply", text: reply } } },
        { at: 3, event: { _tag: "model-settled", message: { stopReason: "stop" } } }
      ].map((record) => JSON.stringify(record)).join("\n")
    )
    const launch = async (resume: boolean) => {
      tui = await Tui.start({
        cwd,
        command: `bun ${join(app, "src", "main.tsx")} ${cwd} ${resume ? "-c" : ""}`,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          SMITHERS_TUI_APPROVE: "all",
          SMITHERS_TUI_REPLAY: recording,
          SMITHERS_TUI_SESSION_DIR: sessions
        }
      })
      await tui.until(drawn, 20_000, "first draw")
      return tui
    }
    const first = await launch(false)
    await first.type("Build a checks view")
    await first.press(key.enter)
    await first.until(
      (screen) => idle(screen) && screen.includes("Published the checks view."),
      30_000,
      "runtime UI published"
    )
    await first.type("/ui")
    await first.press(key.enter)
    await first.until(
      (screen) => screen.includes("The addition check passed.") && screen.includes("Checked addition"),
      5_000,
      "custom view"
    )
    await first.type("l")
    await first.until((screen) => screen.includes("assert(add(2, 3) === 5)"), 5_000, "custom code")
    await first.stop()
    const resumed = await launch(true)
    await resumed.type("/ui")
    await resumed.press(key.enter)
    await resumed.until((screen) => screen.includes("The addition check passed."), 5_000, "persisted custom view")
  }, 90_000)
})

it(
  "keeps chat and navigation usable through an unresolved worker, deduplicates its tab, and settles its toast on cancellation",
  async () => {
    const cwd = repository()
    const sessions = mkdtempSync(join(tmpdir(), "tui-background-"))
    tui = await Tui.start({
      cwd,
      command: `bun ${join(app, "e2e", "workspace-fixture.tsx")}`,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", SMITHERS_TUI_SESSION_DIR: sessions }
    })
    await tui.until(drawn, 20_000, "first draw")
    await tui.type("investigate")
    await tui.press(key.enter)
    await tui.until(
      (screen) => screen.includes("Requested the investigation.") && /Investigation · \d+s/.test(screen),
      5_000,
      "worker still running after chat acknowledges"
    )
    await tui.type("hello")
    await tui.press(key.enter)
    await tui.until(
      (screen) => screen.includes("Still here.") && /Investigation · \d+s/.test(screen),
      5_000,
      "second chat turn during background work"
    )
    await tui.until(
      (screen) => screen.includes("Running 1 subagent") && /▌. Investigation/.test(screen),
      5_000,
      "the worker's card in the chat"
    )
    await tui.type("/filter")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("Filter chat") && screen.includes("Show all"), 5_000, "filter dialog")
    // The first kind is Messages.
    await tui.press(key.down)
    await tui.press(key.enter)
    await tui.press(key.escape)
    await tui.until(
      (screen) =>
        screen.includes("filtered") && screen.includes("Still here.") && !screen.includes("investigate") &&
        /▌. Investigation/.test(screen),
      5_000,
      "messages hidden by the filter, the card kept"
    )
    await tui.type("/filter")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("Filter chat"), 5_000, "filter dialog again")
    await tui.press(key.enter)
    await tui.press(key.escape)
    await tui.until(
      (screen) => !screen.includes("filtered") && screen.includes("investigate"),
      5_000,
      "show all restores the messages"
    )
    const folder = sessionFolder(sessions)
    const records = readFileSync(join(folder, readdirSync(folder).find((name) => name.endsWith(".jsonl"))!), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line))
    const requests = records.filter((record) => record.type === "tab" && record.tab.status === "requested")
    // Describing a pending request may append a newer version of the same
    // tab. Deduplication promises one worker identity and one execution file.
    expect([...new Set(requests.map((record) => record.tab.id))]).toEqual(["investigation"])
    expect(new Set(requests.map((record) => record.tab.file)).size).toBe(1)
    expect(readdirSync(join(folder, "workers"))).toHaveLength(1)
    await tui.press(key.ctrlK)
    await tui.type("tab:inv")
    await tui.until((screen) => screen.includes("Search") && /Investigation\s+running/.test(screen), 5_000, "tab row")
    await tui.press(key.enter)
    await tui.until(
      (screen) => screen.includes("x Stop") && /Investigation · \d+s/.test(screen),
      5_000,
      "inspect running worker"
    )
    await tui.type("x")
    await tui.until(
      (screen) => screen.includes("Investigation · Stopped") && screen.includes("r Resume"),
      5_000,
      "actual worker settlement"
    )
    await tui.press(key.escape)
    await tui.until(
      (screen) => screen.includes("Still here.") && !screen.includes("r Resume"),
      5_000,
      "escape returns to chat"
    )
    await tui.type("still usable")
    await tui.until((screen) => /┃\s+still usable/.test(screen), 5_000, "composer after cancellation")
  },
  60_000
)

describe("worker tabs", () => {
  const launch = async () => {
    tui = await Tui.start({
      cwd: repository(),
      command: `bun ${join(app, "e2e", "workspace-fixture.tsx")}`,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        SMITHERS_TUI_SESSION_DIR: mkdtempSync(join(tmpdir(), "tui-tabs-"))
      }
    })
    await tui.until(drawn, 20_000, "first draw")
    await tui.type("investigate")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("Requested the investigation."), 5_000, "acknowledged")
    await tui.click("Investigation")
    await tui.until((screen) => screen.includes("x Stop") && screen.includes("s Steer"), 5_000, "worker tab by click")
    return tui
  }

  it("heads a running worker with its status, model and clock, and renders its transcript", async () => {
    const tui = await launch()
    await tui.until(
      (screen) =>
        screen.includes("worker ·") && /\d+\.\ds/.test(screen) && screen.includes("Investigate the failing check."),
      5_000,
      "header and transcript"
    )
  }, 60_000)

  it("steers a running worker from its tab and goes back to the chat from its breadcrumb", async () => {
    const tui = await launch()
    await tui.type("s")
    await tui.until((screen) => screen.includes("steer ↳ Investigation"), 5_000, "steer composer")
    await tui.type("also check the docs")
    await tui.press(key.enter)
    await tui.until(
      (screen) => screen.includes("also check the docs") && screen.includes("steering"),
      5_000,
      "steer in the worker transcript"
    )
    // Steering ends with the tab it started in.
    await tui.press("\x1b[1;5D")
    await tui.until((screen) => !screen.includes("steer ↳"), 5_000, "steering ends on leaving")
    await tui.press("\x1b[1;5C")
    await tui.until(
      (screen) => screen.includes("s Steer") && !screen.includes("steer ↳"),
      5_000,
      "back without steering"
    )
    await tui.until((screen) => screen.includes("Subagent · Investigation"), 5_000, "breadcrumb")
    await tui.click("Back (ctrl+y)")
    await tui.until(
      (screen) => screen.includes("Requested the investigation.") && !screen.includes("Back (ctrl+y)"),
      5_000,
      "chat"
    )
  }, 60_000)

  it("goes back with ctrl+y, opens a card from the chat with enter, and shows it in the Summary overview", async () => {
    const tui = await launch()
    await tui.press("\x19")
    await tui.until(
      (screen) => screen.includes("Requested the investigation.") && !screen.includes("Back (ctrl+y)"),
      5_000,
      "ctrl+y to the chat"
    )
    await tui.press(key.tab)
    await tui.until((screen) => screen.includes("[x Stop]") && screen.includes("enter Open"), 5_000, "focused card")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("Subagent · Investigation"), 5_000, "enter opens the worker")
    await tui.press("\x19")
    await tui.press(key.ctrlS)
    await tui.until(
      (screen) => screen.includes("tree") && /Chat/.test(screen) && screen.includes("tab Pane"),
      5_000,
      "overview"
    )
    await tui.press(key.tab)
    await tui.until((screen) => screen.includes("[x Stop]"), 5_000, "the branch's focused card")
    await tui.press(key.escape)
    await tui.until((screen) => screen.includes("Requested the investigation."), 5_000, "esc closes")
  }, 60_000)

  for (const action of ["s"]) {
    it(`keeps typeahead after the worker's ${action} focus action`, async () => {
      const tui = await launch()
      await tui.press(action + "keep-this-worker-draft")
      await tui.until(
        (screen) => /┃\s+keep-this-worker-draft/.test(screen),
        5_000,
        "worker action keeps complete draft"
      )
      expect(tui.screen().includes("steer ↳ Investigation")).toBe(action === "s")
    }, 60_000)
  }
})

describe("flows", () => {
  const ctrlRight = "\x1b[1;5C"
  const open = async () => {
    const cwd = repository()
    const sessions = mkdtempSync(join(tmpdir(), "tui-flows-"))
    tui = await Tui.start({
      cwd,
      command: `bun ${join(app, "e2e", "workspace-fixture.tsx")}`,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", SMITHERS_TUI_SESSION_DIR: sessions }
    })
    await tui.until(drawn, 20_000, "first draw")
    return { tui, sessions }
  }

  it("runs a flow from /flows through its form without blocking chat", async () => {
    const { tui } = await open()
    await tui.type("/flows")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("Review a change"), 5_000, "flows dialog")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("Title"), 5_000, "form field")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("Needs: Title"), 5_000, "missing field")
    await tui.type("x")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("review · running"), 5_000, "running toast")
    await tui.type("hello")
    await tui.until((screen) => /┃\s+hello/.test(screen), 5_000, "composer usable while the flow runs")
    await tui.press(ctrlRight)
    await tui.press(ctrlRight)
    await tui.until((screen) => !screen.includes("r Resume") && screen.includes("x Stop"), 5_000, "flow tab footer")
    await tui.type("x")
    await tui.until(
      (screen) => screen.includes("review · cancelled") && screen.includes("■ review"),
      5_000,
      "settled from the watch"
    )
  }, 60_000)

  it("a flow form yields to chat: Esc and Ctrl+Right close it and the run stays parked", async () => {
    const { tui } = await open()
    await tui.type("/flow review")
    await tui.press(key.enter)
    await tui.until((screen) => /┃\s+Title/.test(screen), 5_000, "form")
    await tui.press(key.escape)
    await tui.type("hello")
    await tui.until((screen) => /┃\s+hello/.test(screen), 5_000, "composer after Esc")
    await tui.press(key.ctrlC)
    await tui.press(ctrlRight)
    await tui.press(ctrlRight)
    await tui.until((screen) => !screen.includes("r Resume") && screen.includes("x Stop"), 5_000, "flow tab footer")
    await tui.type("a")
    await tui.until((screen) => /┃\s+Title/.test(screen), 5_000, "form reopened")
    await tui.press(ctrlRight)
    await tui.type("again")
    await tui.until((screen) => /┃\s+again/.test(screen), 5_000, "composer after Ctrl+Right")
    expect(tui.screen()).not.toContain("cancelled")
    expect(tui.screen()).toContain("◌ review")
  }, 60_000)

  it("keeps typeahead when a flow tab reopens its input form", async () => {
    const { tui } = await open()
    await tui.type("/flow review")
    await tui.press(key.enter)
    await tui.until((screen) => /┃\s+Title/.test(screen), 5_000, "form")
    await tui.press(key.escape)
    await tui.press(ctrlRight + ctrlRight)
    await tui.until((screen) => !screen.includes("r Resume") && screen.includes("x Stop"), 5_000, "flow tab")
    await tui.press("a" + "all-form-characters")
    await tui.until((screen) => screen.includes("all-form-characters"), 5_000, "complete form field")
  }, 60_000)

  it("a run parked on its form never blocks /new", async () => {
    const { tui } = await open()
    await tui.type("/flow review")
    await tui.press(key.enter)
    await tui.until((screen) => /┃\s+Title/.test(screen), 5_000, "form")
    await tui.press(key.escape)
    await tui.until((screen) => screen.includes("◌ review · input"), 5_000, "parked toast")
    await tui.type("/new")
    await tui.press(key.enter)
    const screen = await tui.until(
      (screen) => screen.includes("New conversation started") || screen.includes("Stop running work first"),
      5_000,
      "new session"
    )
    expect(screen).toContain("New conversation started")
  }, 60_000)

  it("/smithers opens a Smithers tab that closes once the user moves on", async () => {
    const { tui } = await open()
    const tabBar = (screen: string) => screen.split("\n").find((line) => /Chat\s+Summary/.test(line)) ?? ""
    expect(tabBar(tui.screen())).not.toContain("Smithers")
    await tui.type("/smithers")
    await tui.press(key.enter)
    await tui.until(
      (screen) => tabBar(screen).includes("Smithers") && screen.includes("1 flows · 0 active"),
      5_000,
      "smithers tab"
    )
    await tui.press(key.ctrlBracket)
    const chat = await tui.until((screen) => !screen.includes("1 flows · 0 active"), 5_000, "chat after ctrl+]")
    expect(tabBar(chat)).not.toContain("Smithers")
  }, 30_000)

  it("offers the directory's flows in the / menu", async () => {
    const { tui } = await open()
    await tui.type("/rev")
    await tui.until(
      (screen) => screen.includes("/flow review") && screen.includes("Review a change"),
      5_000,
      "flow in menu"
    )
  }, 30_000)
})

describe("custom agents", () => {
  /** A scratch repository holding the example agent, `examples/custom-agent/flows/review/flow.mdx`. */
  const withAgent = () => {
    const cwd = repository()
    cpSync(join(app, "examples", "custom-agent", "flows"), join(cwd, "flows"), { recursive: true })
    return cwd
  }

  it("/agent review x opens a review tab and the composer still takes input", async () => {
    const { tui } = await start({ cwd: withAgent(), holdMs: 2_000 })
    await tui.type("/agent review look at math.js")
    await tui.press(key.escape)
    await tui.press(key.enter)
    await tui.until((screen) => /review: look at math\.js replay/.test(screen), 20_000, "agent tab")
    await tui.type("still here")
    await tui.until((screen) => /┃\s+still here/.test(screen), 5_000, "composer usable while the agent runs")
    // The toast follows the run until it really stops; x in the tab asks it to.
    await tui.until((screen) => /review: look at math\.js · \d+s/.test(screen), 5_000, "running toast")
    await tui.press(key.ctrlBracket)
    await tui.press(key.ctrlBracket)
    await tui.until((screen) => screen.includes("x Stop"), 5_000, "agent tab")
    await tui.type("x")
    await tui.until(
      (screen) => screen.includes("✗ Stopped") && screen.includes("r Resume") && !screen.includes("x Stop"),
      20_000,
      "stopped from the real outcome"
    )
  }, 120_000)

  it("/agent lists agents with their seat; choosing one puts its prompt field in the composer", async () => {
    const { tui } = await start({ cwd: withAgent() })
    await tui.type("/agent")
    await tui.press(key.escape)
    await tui.press(key.enter)
    await tui.until(
      (screen) => screen.includes("Agents") && /review\s+GPT-6 Sol\s+Reviews the uncommitted/.test(screen),
      20_000,
      "agents dialog"
    )
    await tui.press(key.enter)
    await tui.until((screen) => /┃\s+\/agent review\s*$/m.test(screen), 5_000, "prompt prefilled")
  }, 60_000)

  it("refuses an unknown agent with one line and keeps chat usable", async () => {
    const { tui } = await start({ cwd: withAgent() })
    // The first listing settles in the background; after it, the refusal is synchronous.
    await Bun.sleep(1_500)
    await tui.type("/agent nobody do it")
    await tui.press(key.escape)
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("No agent named nobody"), 10_000, "typed refusal")
  }, 60_000)
})

describe("approvals", () => {
  it("project flows use approval rows without blocking the composer", async () => {
    const cwd = repository()
    const folder = join(cwd, "flows", "consequential")
    mkdirSync(folder, { recursive: true })
    writeFileSync(
      join(folder, "flow.ts"),
      readFileSync(join(app, "test", "fixtures", "flows-project", "flows", "consequential", "flow.ts"))
    )
    symlinkSync(join(app, "..", "..", "node_modules"), join(cwd, "node_modules"))
    const started = await start({ cwd, approve: "ask" })
    await started.tui.type("/flow consequential")
    await started.tui.press(key.enter)
    const asked = (screen: string) => screen.includes("fs:write:/**") && screen.includes("n deny")
    const launched = await started.tui.until(
      (screen) => asked(screen) || screen.includes("✗ consequential"),
      30_000,
      "approval row"
    )
    if (!asked(launched)) {
      // A launch failure never asks; its reason is on the flow's tab.
      await started.tui.click("✗ consequential")
      throw new Error(
        `consequential failed before asking:\n${await started.tui.until(
          (screen) => screen.includes("· failed"),
          5_000,
          "flow tab"
        )}`
      )
    }
    await started.tui.type("draft")
    await started.tui.until((screen) => /┃\s+draft/.test(screen) && !screen.includes("n deny"))
    await started.tui.press(key.ctrlC)
    await started.tui.until((screen) => screen.includes("n deny"))
    await started.tui.press("n")
    await started.tui.until((screen) => screen.includes("consequential · failed") && !screen.includes("n deny"))
    const sessions = sessionFolder(started.sessions)
    const records = Session.load(join(sessions, readdirSync(sessions).find((name) => name.endsWith(".jsonl"))!))
    expect(records.filter((record) => record.type === "flow").every((record) => record.run.runId === undefined)).toBe(
      true
    )
  }, 60_000)

  it("advertised approval keys work with Summary focus", async () => {
    const cwd = repository()
    tui = await Tui.start({
      cwd,
      command: `bun ${join(app, "e2e", "approval-fixture.tsx")}`,
      env: { PATH: process.env.PATH!, HOME: process.env.HOME!, SMITHERS_TUI_SESSION_DIR: join(cwd, "sessions") }
    })
    await tui.until(drawn, 20_000)
    await tui.type("run")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("? bash true") && screen.includes("n deny"))
    await tui.press(key.ctrlS)
    // The approval owns the keys, so the footer advertises it over the panel.
    await tui.until((screen) => screen.includes("Asked: run") && screen.includes("n Deny"))
    await tui.press("n")
    await Bun.sleep(600)
    expect(tui.screen()).not.toContain("? bash true")
    const folder = sessionFolder(join(cwd, "sessions"))
    const file = join(folder, readdirSync(folder).find((name) => name.endsWith(".jsonl"))!)
    const outcome = Session.load(file).findLast((record) => record.type === "outcome")
    expect(outcome).toMatchObject({ type: "outcome", outcome: { answer: "Choice: deny" } })
  }, 60_000)

  it(
    "a focused panel's a sends its action to the agent as text, never granting an approval or running a shell",
    async () => {
      const cwd = repository()
      tui = await Tui.start({
        cwd,
        command: `bun ${join(app, "e2e", "panel-action-fixture.tsx")}`,
        env: { PATH: process.env.PATH!, HOME: process.env.HOME!, SMITHERS_TUI_SESSION_DIR: join(cwd, "sessions") }
      })
      await tui.until(drawn, 20_000)
      await tui.type("publish")
      await tui.press(key.enter)
      await tui.until((screen) => screen.includes("Actions") && screen.includes("n deny"), 10_000, "panel and approval")
      for (let index = 0; index < 4 && !tui.screen().includes("One action."); index++) {
        await tui.press("\x1b[1;5C")
        await Bun.sleep(200)
      }
      await tui.until(
        (screen) => screen.includes("One action.") && screen.includes("n deny") && !screen.includes("a all bash"),
        5_000,
        "panel focused"
      )
      await Bun.sleep(600)
      await tui.press("a")
      await tui.until((screen) => screen.includes("a all bash"), 5_000, "panel released")
      for (let index = 0; index < 4 && !tui.screen().includes("steering"); index++) {
        await tui.press("\x1b[1;5D")
        await Bun.sleep(200)
      }
      await tui.until(
        (screen) => /┃\s+!touch pwned/.test(screen) && screen.includes("steering"),
        5_000,
        "action sent as a message"
      )
      await Bun.sleep(500)
      expect(readFileSync(join(cwd, "host.log"), "utf8")).not.toContain("reply")
      expect(existsSync(join(cwd, "pwned"))).toBe(false)
    },
    60_000
  )

  const prompt = "node check.mjs fails. Fix it and show it passes."
  const asking = /\? (bash|edit|write|apply_patch) .*y allow/

  /** Answers every approval with `answer` until the turn is idle. */
  const answerAll = async (tui: Tui, answer: (screen: string) => string) => {
    // A denied replay keeps issuing recorded calls until its frame budget ends.
    for (let index = 0; index < 200; index++) {
      const screen = await tui.until((screen) => asking.test(screen) || idle(screen), 120_000, "approval or idle")
      if (!asking.test(screen)) return screen
      const shown = screen.match(asking)![0]
      await tui.press(answer(screen))
      // Wait for the answered row to leave, or a pressed key would land in
      // the editor. A new request can read the same, so this only bounds it.
      await tui.until((screen) => screen.match(asking)?.[0] !== shown, 2_000, "answered row").catch(() => undefined)
    }
    throw new Error(`too many approvals; screen:\n${tui.screen()}`)
  }

  it("asks before a consequential call; y lets it run", async () => {
    const { tui, cwd } = await start({ approve: "ask" })
    await tui.type(prompt)
    await tui.press(key.enter)
    await tui.until((screen) => asking.test(screen), 60_000, "first approval")
    expect(readFileSync(join(cwd, "math.js"), "utf8")).toContain("a - b")
    // `a` on the first bash covers the rest of them for the session.
    let always = false
    await answerAll(tui, (screen) => {
      if (!always && /\? bash .*a all bash/.test(screen)) {
        always = true
        return "a"
      }
      return "y"
    })
    expect(always).toBe(true)
    expect(readFileSync(join(cwd, "math.js"), "utf8")).toContain("a + b")
  }, 240_000)

  it("n denies: nothing changes and the call shows denied", async () => {
    const { tui, cwd, sessions } = await start({ approve: "ask" })
    await tui.type(prompt)
    await tui.press(key.enter)
    await tui.until((screen) => asking.test(screen), 60_000, "first approval")
    await tui.press("n")
    const folder = sessionFolder(sessions)
    const file = join(folder, readdirSync(folder).find((name) => name.endsWith(".jsonl"))!)
    await tui.until(
      () =>
        Session.load(file).some((record) =>
          record.type === "event" && record.event._tag === "cell-call-settled" &&
          record.event.result.code === "capability_refused" && record.event.result.message?.startsWith("Denied:")
        ),
      10_000,
      "denial receipt"
    )
    // The recording repeats after a refusal. Stop once the real denial is durable.
    await tui.press(key.escape)
    const screen = await tui.until(idle, 10_000, "stopped replay")
    expect(screen).not.toMatch(/┃[ \t]+n[ \t]*$/m)
    expect(readFileSync(join(cwd, "math.js"), "utf8")).toBe("export const add = (a, b) => a - b\n")
    await tui.press(key.ctrlO)
    await tui.until((screen) => screen.includes("Denied"), 10_000, "denied call")
  }, 90_000)

  it("never eats typing, and answers once the editor is empty", async () => {
    const { tui } = await start({ approve: "ask" })
    await tui.type(prompt)
    await tui.press(key.enter)
    await tui.until((screen) => asking.test(screen), 60_000, "first approval")
    const before = tui.screen().match(asking)![0]
    await tui.type("hy")
    const typed = await tui.until((screen) => /┃\s+hy/.test(screen), 5_000, "typed draft")
    expect(typed).not.toMatch(asking)
    expect(typed).toContain("? bash")
    await tui.press(key.ctrlC)
    const ready = await tui.until(
      (screen) => !/┃\s+hy/.test(screen) && asking.test(screen),
      5_000,
      "cleared draft and armed approval"
    )
    expect(ready.match(asking)?.[0]).toBe(before)
    await tui.press("y")
    await tui.until((screen) => screen.match(asking)?.[0] !== before, 30_000, "answered")
  }, 120_000)

  it("keeps chat usable while a request waits, and esc drops it", async () => {
    const { tui } = await start({ approve: "ask" })
    await tui.type(prompt)
    await tui.press(key.enter)
    await tui.until((screen) => asking.test(screen), 60_000, "first approval")
    await tui.type("later")
    await tui.press("\x1b\r")
    await tui.until((screen) => screen.includes("Follow-up: later"), 5_000, "queued")
    // The first `a` after sending is text, even though the approval waited
    // long enough to arm before the editor was cleared.
    await tui.type("and also")
    const typed = await tui.until((screen) => /┃\s+and also/.test(screen), 5_000, "next draft")
    expect(typed).toContain("? bash")
    expect(typed).not.toMatch(asking)
    await tui.press(key.escape)
    await tui.until((screen) => !asking.test(screen) && idle(screen), 5_000, "dropped approval")
  }, 120_000)

  it("print mode never hangs: it runs every call by default and denies when told", () => {
    const run = (approve: string | undefined, args: ReadonlyArray<string> = []) => {
      const cwd = repository()
      const env: Record<string, string> = {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        SMITHERS_TUI_REPLAY: fixture,
        SMITHERS_TUI_REPLAY_SPEED: "20",
        SMITHERS_TUI_SESSION_DIR: mkdtempSync(join(tmpdir(), "tui-sessions-"))
      }
      if (approve !== undefined) env.SMITHERS_TUI_APPROVE = approve
      const started = Date.now()
      const result = spawnSync("bun", [join(app, "src", "main.tsx"), cwd, "-p", prompt, ...args], {
        env,
        encoding: "utf8",
        // The replay seat keeps replaying after a denial until the 40-frame
        // budget ends the run: about 80 s at speed 20. A hang never ends.
        timeout: 150_000
      })
      return { ...result, ms: Date.now() - started, math: readFileSync(join(cwd, "math.js"), "utf8") }
    }
    const allowed = run(undefined)
    expect(allowed.signal).toBeNull()
    expect(allowed.stderr).not.toMatch(/denied (bash|edit)/)
    expect(allowed.math).toContain("a + b")
    const denied = run(undefined, ["--approve", "deny"])
    expect(denied.signal).toBeNull()
    expect(denied.stderr).toMatch(/denied (bash|edit)/)
    expect(denied.math).toContain("a - b")
    const refused = run("ask")
    expect(refused.status).toBe(1)
    expect(refused.stderr).toContain("SMITHERS_TUI_APPROVE=ask needs the interactive TUI")
    expect(refused.ms).toBeLessThan(10_000)
  }, 400_000)
})

describe("transcript scrolling", () => {
  /** An SGR mouse report: button code, 1-based column and row, press or release. */
  const mouse = (button: number, column: number, row: number, release = false) =>
    `\x1b[<${button};${column};${row}${release ? "m" : "M"}`
  const fill = async (tui: Tui) => {
    for (const block of ["b1", "b2", "b3"]) {
      await tui.type(`!seq -f '${block}-%g' 1 40`)
      await tui.press(key.enter)
      await tui.until((screen) => screen.includes(`${block}-40`), 10_000, `${block} output`)
    }
    expect(tui.screen()).not.toContain("b2-24")
  }

  it("scrolls up under the mouse wheel", async () => {
    const { tui } = await start()
    await fill(tui)
    for (let tick = 0; tick < 12; tick++) await tui.press(mouse(64, 20, 10))
    await tui.until((screen) => screen.includes("b2-24") && !screen.includes("b3-40"), 5_000, "scrolled transcript")
  }, 60_000)

  it("scrolls up while a selection is dragged above the transcript", async () => {
    const { tui } = await start()
    await fill(tui)
    await tui.press(mouse(0, 5, 14))
    await tui.press(mouse(32, 5, 8))
    await tui.press(mouse(32, 5, 1))
    await tui.until((screen) => screen.includes("$ seq -f 'b1-%g' 1 40"), 5_000, "autoscrolled transcript")
    await tui.press(mouse(0, 5, 1, true))
  }, 60_000)
})

describe("monitors", () => {
  for (const action of ["stop the shell watch", "/quit", "/new"]) {
    it(`${action} cancels an in-flight monitor shell`, async () => {
      const cwd = repository()
      tui = await Tui.start({
        cwd,
        command: `bun ${join(app, "e2e", "monitor-fixture.tsx")}`,
        env: { PATH: process.env.PATH!, HOME: process.env.HOME!, SMITHERS_TUI_SESSION_DIR: join(cwd, "sessions") }
      })
      let pid: number | undefined
      try {
        await tui.until(drawn, 20_000, "first draw")
        await tui.type("watch a slow shell")
        await tui.press(key.enter)
        await tui.until(() => existsSync(join(cwd, "monitor.pid")), 5_000, "monitor shell running")
        pid = Number(readFileSync(join(cwd, "monitor.pid"), "utf8").trim())
        await tui.type(action)
        await tui.press(key.enter)
        if (action === "/quit") await tui.waitForExit(5_000)
        else {await tui.until(
            () => {
              try {
                process.kill(-pid!, 0)
                return false
              } catch {
                return true
              }
            },
            5_000,
            "monitor shell stopped"
          )}
        expect(() => process.kill(-pid!, 0)).toThrow()
      } finally {
        if (pid !== undefined) {
          try {
            process.kill(-pid, "SIGKILL")
          } catch {}
        }
      }
    }, 30_000)
  }

  const update = "CI: Build failed on main."
  const watch = async (notable: boolean) => {
    const cwd = repository()
    const sessions = join(cwd, "sessions")
    tui = await Tui.start({
      cwd,
      command: `bun ${join(app, "e2e", "monitor-fixture.tsx")}`,
      env: {
        PATH: process.env.PATH!,
        HOME: process.env.HOME!,
        SMITHERS_TUI_SESSION_DIR: sessions,
        MONITOR_NOTABLE: notable ? "1" : "0"
      }
    })
    await tui.until(drawn, 20_000, "first draw")
    await tui.type("watch the build")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("Watching the build."), 10_000, "acknowledgement")
    const log = join(cwd, "judged.log")
    const judged = () => {
      try {
        return readFileSync(log, "utf8").trim().split("\n").map((line) =>
          JSON.parse(line) as { verdict: boolean; done: boolean }
        )
      } catch {
        return []
      }
    }
    for (let attempt = 0; attempt < 200 && !judged().some((entry) => entry.done); attempt++) await Bun.sleep(50)
    expect(judged().some((entry) => entry.done)).toBe(true)
    const folder = sessionFolder(sessions)
    const file = join(folder, readdirSync(folder).find((name) => name.endsWith(".jsonl"))!)
    const updates = () => Session.load(file).filter((record) => record.type === "monitor-update")
    return { tui, judged, updates }
  }

  it("delivers a notable change as one toast and one chat row", async () => {
    const { tui, updates } = await watch(true)
    const screen = await tui.until((screen) => screen.includes(update), 10_000, "monitor update")
    // Once in the toast, once as the chat row.
    expect(screen.split(update).length - 1).toBe(2)
    await Bun.sleep(3_000)
    expect(updates()).toEqual([
      expect.objectContaining({ type: "monitor-update", id: "ci", text: "Build failed on main." })
    ])
    expect(tui.screen().split(update).length - 1).toBeLessThanOrEqual(2)
  }, 60_000)

  it("delivers nothing when Jev calls the change routine", async () => {
    const { tui, judged, updates } = await watch(false)
    // The monitors plugin shows the active monitor in the footer.
    await tui.until((screen) => screen.includes("◉ CI"), 5_000, "monitor status item")
    await Bun.sleep(3_000)
    expect(judged().every((entry) => !entry.verdict)).toBe(true)
    expect(tui.screen()).not.toContain("Build failed on main.")
    expect(updates()).toEqual([])
  }, 60_000)
})

describe("extensions", () => {
  const altR = "\x1br"
  /** A repository flow whose `metadata.tui` key requests a durable run of itself. */
  const reviewFlow = [
    "---",
    "description: Reviews the uncommitted change and returns a verdict.",
    "metadata:",
    "  tui:",
    "    keys:",
    "      - key: alt+r",
    "        label: Review",
    "        action: { kind: flow, flow: review }",
    "    status: true",
    "    card: true",
    "---",
    "Review the uncommitted change.",
    ""
  ].join("\n")

  /** A repository holding `reviewFlow`, read by the real registry. */
  const open = async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tui-extensions-"))
    mkdirSync(join(cwd, "flows", "review"), { recursive: true })
    const mdx = join(cwd, "flows", "review", "flow.mdx")
    writeFileSync(mdx, reviewFlow)
    tui = await Tui.start({
      cwd,
      cols: 120,
      command: `bun ${join(app, "e2e", "extensions-fixture.tsx")}`,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        SMITHERS_TUI_SESSION_DIR: mkdtempSync(join(tmpdir(), "tui-extensions-sessions-")),
        SMITHERS_WORKSPACE_JJ_EXPORT_BINARY: process.env.SMITHERS_WORKSPACE_JJ_EXPORT_BINARY ??
          join(process.env.HOME ?? "", "smithers", "target", "release", "smithers-jj-export")
      }
    })
    await tui.until(drawn, 20_000, "first draw")
    return { tui, mdx }
  }

  it(
    "a metadata.tui key requests the flow; card, status and toast settle only with the run; chat stays usable",
    async () => {
      const { tui } = await open()
      await tui.until((screen) => screen.includes("alt+r Review"), 10_000, "contributed key hint")
      await tui.press(altR)
      await tui.until(
        (screen) => screen.includes("◌ review") && screen.includes("review · Running."),
        5_000,
        "tab and card"
      )
      await tui.until((screen) => screen.includes("review · running"), 5_000, "running toast")
      await tui.until((screen) => /◌ review\s+↑/.test(screen), 5_000, "status item")
      // Chat answers while the run is unresolved.
      await tui.type("hello")
      await tui.press(key.enter)
      await tui.until((screen) => screen.includes("Still here."), 5_000, "chat answered while the run runs")
      expect(tui.screen()).toContain("review · running")
      await tui.type("finish")
      await tui.press(key.enter)
      await tui.until(
        (screen) => screen.includes("review · done") && screen.includes("review · Approved."),
        5_000,
        "settled"
      )
      await tui.until((screen) => /✓ review\s+↑/.test(screen), 5_000, "settled status item")
    },
    60_000
  )

  it("a cell's card and status item show in place, and a row action runs from its view", async () => {
    const { tui } = await open()
    await tui.type("plan release")
    await tui.press(key.enter)
    await tui.until(
      (screen) => screen.includes("Release plan · Two steps left.") && screen.includes("✓ Changelog"),
      5_000,
      "card"
    )
    await tui.until((screen) => screen.includes("CI ✓"), 5_000, "status item")
    await tui.click("Release plan")
    await tui.until((screen) => screen.includes("3 ▸ Publish"), 5_000, "card view")
    await tui.press(key.down)
    await tui.press(key.down)
    await tui.until((screen) => screen.includes("a Publish"), 5_000, "the row's action")
    await tui.type("a")
    await tui.until((screen) => screen.includes("review · running"), 5_000, "row action requested the flow")
  }, 60_000)

  it("tab focuses the newest card from an empty composer and enter opens its view", async () => {
    const { tui } = await open()
    await tui.type("plan release")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("Release plan · Two steps left."), 5_000, "card")
    await tui.press(key.tab)
    await tui.until((screen) => screen.includes("enter Open") && screen.includes("esc Composer"), 5_000, "card focused")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("3 ▸ Publish") && screen.includes("esc Chat"), 5_000, "card view")
    await tui.press(key.escape)
    await tui.until((screen) => screen.includes("ctrl+k Search"), 5_000, "back in chat")
    await tui.press(key.tab)
    await tui.until((screen) => screen.includes("enter Open"), 5_000, "focused again")
    await tui.press(key.escape)
    await tui.until(
      (screen) => screen.includes("ctrl+k Search") && !screen.includes("enter Open"),
      5_000,
      "composer again"
    )
  }, 60_000)

  it("a metadata.tui key on a markdown flow starts a real durable run that settles", async () => {
    // The real Flows.Port: registry discovery, the control plane's plan, approval, launch and watch.
    const cwd = mkdtempSync(join(tmpdir(), "tui-extensions-real-"))
    mkdirSync(join(cwd, "flows", "ping"), { recursive: true })
    writeFileSync(
      join(cwd, "flows", "ping", "flow.mdx"),
      [
        "---",
        "description: Answers Pong.",
        "model: openai:gpt-6-sol",
        "metadata:",
        "  tui:",
        "    keys:",
        "      - key: alt+p",
        "        label: Ping",
        "        action: { kind: flow, flow: ping }",
        "    status: true",
        "---",
        "Answer Pong.",
        ""
      ].join("\n")
    )
    tui = await Tui.start({
      cwd,
      cols: 120,
      command: `bun ${join(app, "e2e", "real-flows-fixture.tsx")}`,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        SMITHERS_TUI_SESSION_DIR: mkdtempSync(join(tmpdir(), "tui-extensions-sessions-")),
        SMITHERS_WORKSPACE_JJ_EXPORT_BINARY: process.env.SMITHERS_WORKSPACE_JJ_EXPORT_BINARY ??
          join(process.env.HOME ?? "", "smithers", "target", "release", "smithers-jj-export")
      }
    })
    await tui.until(drawn, 20_000, "first draw")
    await tui.until((screen) => screen.includes("alt+p Ping"), 20_000, "contributed key hint")
    await tui.press("\x1bp")
    await tui.until((screen) => screen.includes("ping · running"), 20_000, "running toast")
    await tui.until(
      (screen) => screen.includes("ping · done") && /✓ ping\s+↑/.test(screen),
      90_000,
      "settled from the real run"
    )
  }, 150_000)

  it("hot-reloads an edited flow.mdx and lists a colliding key as a problem", async () => {
    const { tui, mdx } = await open()
    await tui.until((screen) => screen.includes("alt+r Review"), 10_000, "contributed key hint")
    writeFileSync(mdx, readFileSync(mdx, "utf8").replace("label: Review", "label: Recheck"))
    await tui.until((screen) => screen.includes("alt+r Recheck"), 5_000, "reloaded label")
    writeFileSync(mdx, readFileSync(mdx, "utf8").replace("key: alt+r", "key: ctrl+c"))
    await tui.until((screen) => screen.includes("✗ 1 extension"), 5_000, "problem status item")
    expect(tui.screen()).not.toContain("Recheck")
    await tui.click("✗ 1 extension")
    await tui.until((screen) => screen.includes("review: ctrl+c is the built-in Clear key"), 5_000, "problem view")
  }, 60_000)
})
