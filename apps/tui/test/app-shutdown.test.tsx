import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setImmediate, setTimeout } from "node:timers/promises"

async function bounded<A>(promise: Promise<A>, ms: number, message: string): Promise<A> {
  const controller = new AbortController()
  try {
    return await Promise.race([
      promise,
      setTimeout(ms, undefined, { signal: controller.signal }).then(() => {
        throw new Error(message)
      })
    ])
  } finally {
    controller.abort()
  }
}

// Component boundary: an owned child mounts the actual native headless App.
// The Host is controlled; real /quit and process.exit run without global mocks.
test("quit cancels owned work once and waits for host disposal before exiting", async () => {
  const root = mkdtempSync(join(tmpdir(), "tui-app-shutdown-"))
  const eventsFile = join(root, "events.jsonl")
  const releaseFile = join(root, "release")
  const peer = join(root, "peer.ts")
  const events = (): string[] =>
    existsSync(eventsFile)
      ? readFileSync(eventsFile, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
      : []
  writeFileSync(
    peer,
    `
await import(${JSON.stringify(import.meta.resolve("../src/native.ts"))})
const { testRender } = await import(${JSON.stringify(import.meta.resolve("@opentui/react/test-utils"))})
import { act, createElement } from ${JSON.stringify(import.meta.resolve("react"))}
import { appendFileSync, existsSync } from "node:fs"
import { setImmediate, setTimeout } from "node:timers/promises"
const { App } = await import(${JSON.stringify(import.meta.resolve("../src/app.tsx"))})
const record = (event) => appendFileSync(${JSON.stringify(eventsFile)}, JSON.stringify(event) + "\\n")
const gate = Promise.withResolvers()
const host = {
  cwd: ${JSON.stringify(root)}, judged: false,
  run: () => { record("run"); return { done: gate.promise, cancel: () => { record("cancel"); gate.resolve({ _tag: "cancelled" }) } } },
  dispose: async () => {
    record("dispose-start")
    await setImmediate()
    record("dispose-pending")
    while (!existsSync(${JSON.stringify(releaseFile)})) await setTimeout(5)
    record("dispose-end")
  }
}
process.on("exit", () => record("exit"))
const setup = await testRender(createElement(App, { host, seat: "replay:test", models: [{ seat: "replay:test", label: "Replay", provider: "Fixture" }], contextWindow: () => 10000 }), { width: 100, height: 30, exitOnCtrlC: false })
await setup.renderOnce()
await act(async () => { await setup.mockInput.typeText("Owned work"); await setup.mockInput.pressKeys(["RETURN"]) })
// A later shutdown signal must not duplicate cancellation or disposal.
await act(async () => { await setup.mockInput.typeText("/quit"); await setup.mockInput.pressKeys(["RETURN"]) })
process.emit("SIGTERM")
`
  )
  const child = spawn(process.execPath, [peer], {
    cwd: root,
    detached: process.platform !== "win32",
    env: { ...process.env, SMITHERS_TUI_SESSION_DIR: join(root, "sessions") },
    stdio: ["ignore", "pipe", "pipe"]
  })
  let stderr = ""
  child.stderr!.on("data", (chunk) => {
    stderr += String(chunk)
  })
  child.stdout!.resume()
  const exited = Promise.withResolvers<{ code: number | null; signal: NodeJS.Signals | null }>()
  child.once("exit", (code, signal) => exited.resolve({ code, signal }))
  child.once("error", (error) => exited.reject(error))
  try {
    const deadline = Date.now() + 10000
    while (
      !events().includes("dispose-pending") && child.exitCode === null && child.signalCode === null &&
      Date.now() < deadline
    ) await setTimeout(5)
    expect(events()).toEqual(["run", "cancel", "dispose-start", "dispose-pending"])
    await setImmediate()
    expect(child.exitCode).toBeNull()
    expect(child.signalCode).toBeNull()
    writeFileSync(releaseFile, "release")
    const result = await bounded(exited.promise, 10000, `App child did not exit: ${stderr}`)
    expect(result).toEqual({ code: 0, signal: null })
    expect(events()).toEqual(["run", "cancel", "dispose-start", "dispose-pending", "dispose-end", "exit"])
  } finally {
    try {
      if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
        try {
          process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGKILL")
        } catch (error) {
          if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error
        }
        await bounded(exited.promise, 5000, "Owned child did not exit after SIGKILL")
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
}, 20000)
