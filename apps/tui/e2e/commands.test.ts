/** Public commands with durable or external effects, through the real tmux UI. */
import { afterEach, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { key, Tui } from "./tmux.ts"

const app = resolve(import.meta.dir, "..")
let tui: Tui | undefined
afterEach(async () => {
  await tui?.stop()
  tui = undefined
})
const drawn = (screen: string) => /↑\S+ ↓\S+/.test(screen)
const setup = () => {
  const root = mkdtempSync(join(tmpdir(), "tui-commands-"))
  const cwd = join(root, "project"),
    home = join(root, "home"),
    sessions = join(root, "sessions"),
    bin = join(root, "bin")
  for (const path of [cwd, home, bin]) mkdirSync(path)
  return { cwd, home, sessions, bin, replay: join(root, "replay.jsonl") }
}
const reply = (source: string, inputTokens = 128, outputTokens = 32) => [
  { at: 0, event: { _tag: "model-requested" } },
  { at: 1, event: { _tag: "model-delta", delta: { type: "text-start", id: "cell" } } },
  {
    at: 2,
    event: { _tag: "model-delta", delta: { type: "text-delta", id: "cell", text: `\`\`\`cell\n${source}\n\`\`\`` } }
  },
  { at: 3, event: { _tag: "model-delta", delta: { type: "text-end", id: "cell" } } },
  {
    at: 4,
    event: {
      _tag: "model-delta",
      delta: { type: "usage", inputTokens, outputTokens, totalTokens: inputTokens + outputTokens }
    }
  },
  { at: 5, event: { _tag: "model-settled", message: { stopReason: "stop" } } }
]
const replay = (project: ReturnType<typeof setup>, ...replies: Array<ReturnType<typeof reply>>) =>
  writeFileSync(project.replay, replies.flat().map((event) => JSON.stringify(event)).join("\n") + "\n")
interface JournalRecord {
  readonly type: string
  readonly prompt?: string
  readonly outcome?: {
    readonly _tag: string
    readonly answer?: string
    readonly message?: string
    readonly headline?: string
    readonly detail?: string
  }
  readonly event?: { readonly _tag: string }
  readonly name?: string
  readonly dropped?: number
}
const records = (project: ReturnType<typeof setup>): Array<JournalRecord> => {
  if (!existsSync(project.sessions)) return []
  const folder = readdirSync(project.sessions).find((name) => name.includes("--"))
  if (folder === undefined) return []
  const file = readdirSync(join(project.sessions, folder)).find((name) => name.endsWith(".jsonl"))
  if (file === undefined) return []
  return readFileSync(join(project.sessions, folder, file), "utf8").split("\n").filter(Boolean).map((line) =>
    JSON.parse(line) as JournalRecord
  )
}
const untilRecords = async (
  project: ReturnType<typeof setup>,
  predicate: (events: Array<JournalRecord>) => boolean,
  label: string
) => {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const events = records(project)
    if (predicate(events)) return events
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`timed out waiting for ${label}; screen:\n${tui?.screen()}`)
}
const start = async (project: ReturnType<typeof setup>, args = "") => {
  if (!existsSync(project.replay)) replay(project, reply("ctx.done(\"pong\")"))
  tui = await Tui.start({
    cwd: project.cwd,
    command: `bun ${join(app, "src/main.tsx")} ${args}`,
    env: {
      HOME: project.home,
      PATH: `${project.bin}:${process.env.PATH ?? ""}`,
      SMITHERS_TUI_SESSION_DIR: project.sessions,
      SMITHERS_TUI_REPLAY: project.replay,
      SMITHERS_TUI_REPLAY_SPEED: "100"
    }
  })
  await tui.until(drawn, 20_000, "first draw")
  return tui
}
const submit = async (text: string) => {
  await tui!.type(text)
  await tui!.press(key.enter)
}
const answer = async (project: ReturnType<typeof setup>, prompt: string, count: number) => {
  await submit(prompt)
  const events = await untilRecords(
    project,
    (events) => events.filter((event) => event.type === "outcome").length >= count,
    `outcome ${count}`
  )
  const outcome = events.filter((event) => event.type === "outcome")[count - 1]
  expect(outcome).toMatchObject({ prompt, outcome: { _tag: "done", answer: "pong" } })
}

it("names, compacts, and resumes a conversation through the startup picker", async () => {
  const project = setup()
  await start(project)
  await submit("/compact")
  await tui!.until((screen) => screen.includes("Nothing to compact"))
  await submit("/name tmux conversation")
  await answer(project, "first message", 1)
  await answer(project, "second message", 2)
  await submit("/compact")
  await tui!.until((screen) => screen.includes("Dropped the 1 oldest context entries"))
  await submit("/conversation")
  await tui!.until((screen) => screen.includes("1 exchanges"))
  const events = records(project)
  expect(events.some((event) => event.type === "name" && event.name === "tmux conversation")).toBe(true)
  expect(events.some((event) => event.type === "compact" && event.dropped === 1)).toBe(true)
  await tui!.stop()
  await start(project, "-r")
  await tui!.until((screen) => screen.includes("tmux conversation"))
  await tui!.press(key.enter)
  await tui!.until((screen) => screen.includes("Resumed") && screen.includes("second message"))
  await submit("/conversation")
  await tui!.until((screen) => screen.includes("1 exchanges"))
  await submit("/exit")
  expect((await tui!.waitForExit()).code).toBe(0)
}, 45_000)

it("copies the last answer and reports a failed clipboard without losing the conversation", async () => {
  const project = setup()
  const output = join(project.cwd, "clipboard.txt")
  const commands = process.platform === "darwin" ? ["pbcopy"] : ["wl-copy", "xclip", "xsel"]
  for (const command of commands) {
    const file = join(project.bin, command)
    writeFileSync(file, `#!/bin/sh\ncat > '${output}'\n`)
    chmodSync(file, 0o755)
  }
  await start(project)
  await submit("/copy")
  await tui!.until((screen) => screen.includes("No answer to copy"))
  await answer(project, "ping", 1)
  await submit("/copy")
  await tui!.until((screen) => screen.includes("Copied the last answer"))
  expect(readFileSync(output, "utf8").toLowerCase()).toContain("pong")
  for (const command of commands) writeFileSync(join(project.bin, command), "#!/bin/sh\nexit 1\n")
  await submit("/copy")
  await tui!.until((screen) => screen.includes("Copy failed"))
  expect(tui!.screen()).toContain("pong")
  writeFileSync(output, "")
  for (const command of commands) writeFileSync(join(project.bin, command), `#!/bin/sh\ncat > '${output}'\n`)
  await submit("/copy")
  await tui!.until((screen) => screen.includes("Copied the last answer"))
  expect(readFileSync(output, "utf8")).toBe("pong")
  await tui!.press("draft survives")
  expect(tui!.screen()).toContain("draft survives")
}, 30_000)

it("enforces the requested token ceiling before the next cell and leaves chat usable", async () => {
  const project = setup()
  replay(project, reply("const spent = 1", 500, 100), reply("ctx.done(\"budget breach\")"))
  await start(project, "--budget-tokens 1000")
  await submit("ping")
  const screen = await tui!.until(
    (screen) =>
      screen.includes("Token budget reached") && screen.includes("600 of 1000 tokens used.") &&
      !screen.includes("esc Interrupt"),
    15_000,
    "budget refusal"
  )
  expect(screen).not.toContain("budget breach")
  const events = await untilRecords(
    project,
    (events) => events.some((event) => event.type === "outcome"),
    "budget outcome"
  )
  expect(events.filter((event) => event.type === "event" && event.event?._tag === "cell-settled")).toHaveLength(1)
  expect(events.filter((event) => event.type === "outcome")[0]?.outcome).toMatchObject({
    _tag: "failed",
    message: "Token budget reached",
    headline: "Token budget reached\n600 of 1000 tokens used.",
    detail: expect.stringContaining("600 of its 1000 approved tokens")
  })
  await tui!.press("still usable")
  expect(tui!.screen()).toContain("still usable")
  await tui!.stop()
  await start(project, "-c --budget-tokens 1000")
  const restored = await tui!.until(
    (screen) => screen.includes("Token budget reached") && screen.includes("600 of 1000 tokens used."),
    10_000,
    "restored budget failure"
  )
  expect(restored).not.toContain("budget breach")
}, 30_000)

it("print mode reports the token ceiling and usage without printing an answer", () => {
  const project = setup()
  replay(project, reply("const spent = 1", 500, 100), reply("ctx.done(\"budget breach\")"))
  const result = spawnSync("bun", [join(app, "src/main.tsx"), "-p", "ping", "--budget-tokens", "1000"], {
    cwd: project.cwd,
    env: {
      HOME: project.home,
      PATH: `${project.bin}:${process.env.PATH ?? ""}`,
      SMITHERS_TUI_SESSION_DIR: project.sessions,
      SMITHERS_TUI_REPLAY: project.replay,
      SMITHERS_TUI_REPLAY_SPEED: "100"
    },
    encoding: "utf8",
    timeout: 20_000
  })
  expect(result.error).toBeUndefined()
  expect(result.status).toBe(1)
  expect(result.stdout).toBe("")
  expect(result.stderr.trim()).toBe("Token budget reached\n600 of 1000 tokens used.")
}, 30_000)
