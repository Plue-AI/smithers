import { expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const source = resolve(import.meta.dir, "../src")
const ask = join(source, "ask.ts")

type Options = {
  prompt?: string
  seat?: string
  defaultSeat?: string | null
  expectedSeat?: string
  record?: boolean
  asyncEvents?: boolean
  approval?: string | { error: string }
  budget?: { error: string }
}

function runAsk(
  events: Record<string, unknown>[],
  outcome: Record<string, unknown> = { _tag: "done", answer: "ok" },
  options: Options = {}
) {
  const directory = mkdtempSync(join(tmpdir(), "smithers-ask-test-"))
  const record = join(directory, "events.jsonl")
  const config = {
    prompt: options.prompt ?? "probe",
    seat: options.seat,
    defaultSeat: options.defaultSeat === undefined ? "test:default" : options.defaultSeat,
    expectedSeat: options.expectedSeat ?? options.seat ?? (options.defaultSeat === null
      ? "openai:gpt-6-sol"
      : options.defaultSeat ?? "test:default"),
    record: options.record ?? true,
    asyncEvents: options.asyncEvents ?? false,
    approval: options.approval ?? "all",
    budget: options.budget
  }
  const script = `
    import { mock } from "bun:test"
    const config = ${JSON.stringify(config)}
    mock.module(${JSON.stringify(join(source, "models.ts"))}, () => ({
      detect: async () => ({ environment: {}, defaultSeat: config.defaultSeat })
    }))
    mock.module(${JSON.stringify(join(source, "approvals.ts"))}, () => ({ mode: () => config.approval }))
    mock.module(${JSON.stringify(join(source, "budget.ts"))}, () => ({ policy: () => config.budget }))
    mock.module(${JSON.stringify(join(source, "spend.ts"))}, () => ({ ledger: () => ({}) }))
    mock.module(${JSON.stringify(join(source, "host.ts"))}, () => ({
      make: () => {
        console.error("HOST_MADE")
        return {
        run: ({ prompt, seat, history, onEvent }) => {
          if (prompt !== config.prompt || seat !== config.expectedSeat || history.length !== 0) throw Error("wrong run input: " + JSON.stringify({prompt, seat, history}))
          const done = (async () => {
            for (const event of ${JSON.stringify(events)}) {
              if (config.asyncEvents) await new Promise((resolve) => setTimeout(resolve, 2))
              onEvent(event)
            }
            return ${JSON.stringify(outcome)}
          })()
          return { done }
        },
        dispose: async () => {
          await new Promise((resolve) => setTimeout(resolve, 10))
          console.error("HOST_DISPOSED")
        }
      }}
    }))
    process.argv = ["bun", ${JSON.stringify(ask)}, ...(${
    JSON.stringify(options.prompt === "" ? [] : [config.prompt, ...(config.seat ? [config.seat] : [])])
  })]
    await import(${JSON.stringify(ask)})
  `
  try {
    const result = spawnSync("bun", ["-e", script], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, ...(config.record ? { SMITHERS_TUI_RECORD: record } : {}) },
      timeout: 3_000
    })
    if (result.error) throw Error(`ask child failed: ${result.error.message}\n${result.stderr}`)
    const lines = result.stdout.trimEnd().split("\n").filter(Boolean)
    return {
      ...result,
      output: lines.map((line) => JSON.parse(line) as Record<string, unknown>),
      recordExists: existsSync(record),
      recorded: (existsSync(record) ? readFileSync(record, "utf8").trimEnd().split("\n").filter(Boolean) : []).map((
        line
      ) =>
        JSON.parse(line) as {
          at: number
          event: Record<string, unknown>
        }
      )
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

function resolved(text: string) {
  return {
    _tag: "resolved",
    eventType: "flows.harness.resolved.v1",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      stopReason: "stop"
    }
  }
}

it.each([399, 400, 401])("prints the entire %i-character JSON event line", (length) => {
  const event = resolved("x".repeat(length - JSON.stringify(resolved("")).length))
  expect(JSON.stringify(event).length).toBe(length)
  const result = runAsk([event])
  expect(result.status, result.stderr).toBe(0)
  expect(result.output).toEqual([event, { _tag: "done", answer: "ok" }])
  expect(result.recorded.map(({ event: value }) => value)).toEqual([event])
  expect(result.stderr).toBe("HOST_MADE\nHOST_DISPOSED\n")
})

it("preserves long Unicode and newlines while recording suppressed model deltas", () => {
  const event = resolved("🔎 line one\n第二行\n" + "🌊".repeat(401))
  const delta = { _tag: "model-delta", text: "full private streaming text" }
  const result = runAsk([event, delta])
  expect(result.status, result.stderr).toBe(0)
  expect(result.output).toEqual([event, { _tag: "done", answer: "ok" }])
  expect(result.recorded.map(({ event: value }) => value)).toEqual([event, delta])
  expect(result.recorded.every(({ at }) => Number.isFinite(at))).toBe(true)
  expect(result.stderr).toBe("HOST_MADE\nHOST_DISPOSED\n")
})

it("prints a failed outcome, exits unsuccessfully, and disposes the host", () => {
  const outcome = { _tag: "failed", reason: "model refused" }
  const result = runAsk([], outcome)
  expect(result.status, result.stderr).toBe(1)
  expect(result.output).toEqual([outcome])
  expect(result.stderr).toBe("HOST_MADE\nHOST_DISPOSED\n")
})

it("prints asynchronously arriving events in order without recording when unset", () => {
  const first = resolved("first")
  const second = resolved("second")
  const events = [first, { _tag: "model-delta", text: "draft" }, second]
  const result = runAsk(events, { _tag: "done", answer: "ok" }, { asyncEvents: true, record: false })
  expect(result.status, result.stderr).toBe(0)
  expect(result.output).toEqual([first, second, { _tag: "done", answer: "ok" }])
  expect(result.recordExists).toBe(false)
  expect(result.recorded).toEqual([])
  expect(result.stderr).toBe("HOST_MADE\nHOST_DISPOSED\n")
}, 7_000)

it("requires a prompt before detecting models or creating a host", () => {
  const result = runAsk([], undefined, { prompt: "", record: false })
  expect(result.status).toBe(2)
  expect(result.stdout).toBe("")
  expect(result.stderr).toBe("usage: bun src/ask.ts \"<prompt>\" [seat]\n")
  expect(result.recordExists).toBe(false)
}, 7_000)

it.each([
  { name: "explicit", options: { seat: "test:explicit", defaultSeat: "test:detected" } },
  { name: "detected", options: { defaultSeat: "test:detected" } },
  { name: "fallback", options: { defaultSeat: null } }
])("uses the $name seat", ({ options }) => {
  const result = runAsk([], undefined, options)
  expect(result.status, result.stderr).toBe(0)
  expect(result.output).toEqual([{ _tag: "done", answer: "ok" }])
}, 7_000)

it.each([
  { name: "approval", options: { approval: { error: "approval rejected" } }, error: "approval rejected" },
  { name: "budget", options: { budget: { error: "budget rejected" } }, error: "budget rejected" }
])("rejects an invalid $name before creating a host", ({ options, error }) => {
  const result = runAsk([], undefined, { ...options, record: false })
  expect(result.status).toBe(2)
  expect(result.stdout).toBe("")
  expect(result.stderr).toBe(`${error}\n`)
  expect(result.recordExists).toBe(false)
}, 7_000)
