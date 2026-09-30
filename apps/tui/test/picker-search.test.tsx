import { testRender } from "@opentui/react/test-utils"
import { afterEach, beforeEach, expect, test } from "bun:test"
import { Schema } from "effect"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setImmediate, setTimeout as timerPhase } from "node:timers/promises"
import { act, useState } from "react"
import * as Picker from "../src/picker.ts"
import * as Search from "../src/search.ts"
import * as Session from "../src/session.ts"

// Ordinary matching cases use actual rg and filesystem/session adapters.
// They are component evidence, independent of the controlled-process cases.
// These cases require Bun's default serial execution: PATH/session-root ports
// are process-wide, restored in finally. Do not mark them concurrent.
let setup: Awaited<ReturnType<typeof testRender>> | undefined
let state: ReturnType<typeof Picker.useSearch> | undefined
let pickerState: Picker.Picker | undefined
let change: ((picker: Picker.Picker | undefined, cwd?: string) => void) | undefined
let root = ""
let cwd = ""
let originalSessionRoot: string | undefined
let originalPath: string | undefined
const statuses: Array<[string, "danger"]> = []
const drafts: string[] = []
const palette = (query: string): Picker.Picker => ({ kind: "palette", query, selected: 0 })
const Harness = (
  { initial, directory }: { readonly initial: Picker.Picker | undefined; readonly directory: string }
) => {
  const [picker, setPicker] = useState(initial)
  const [folder, setFolder] = useState(directory)
  const [draft, setDraft] = useState("")
  change = (next, nextDirectory) => {
    setPicker(next)
    if (nextDirectory !== undefined) setFolder(nextDirectory)
  }
  pickerState = picker
  state = Picker.useSearch({ picker, setPicker, cwd: folder, setStatus: (text, tone) => statuses.push([text, tone]) })
  return (
    <box>
      <text>{state.search?.status ?? "No search"}</text>
      <input
        focused
        value={draft}
        onInput={(text: string) => {
          drafts.push(text)
          setDraft(text)
        }}
      />
      {state.search?.hits.map((hit) => <text key={`${hit.path}:${hit.line}`}>{hit.path}:{hit.line}</text>)}
    </box>
  )
}
const mount = async (picker: Picker.Picker | undefined) => {
  setup = await testRender(<Harness initial={picker} directory={cwd} />, { width: 60, height: 10 })
  await setup.renderOnce()
}
const update = async (picker: Picker.Picker | undefined, directory?: string) => {
  await act(async () => {
    change!(picker, directory)
  })
  await setup!.renderOnce()
}
const waitFor = async (condition: () => boolean) => {
  const deadline = Date.now() + 5000
  while (!condition() && Date.now() < deadline) {
    await act(async () => {
      await setImmediate()
    })
    await setup!.renderOnce()
  }
  if (!condition()) throw new Error("The public search state did not settle")
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tui-picker-search-"))
  cwd = join(root, "workspace")
  mkdirSync(cwd)
  originalSessionRoot = process.env.SMITHERS_TUI_SESSION_DIR
  originalPath = process.env.PATH
  process.env.SMITHERS_TUI_SESSION_DIR = join(root, "sessions")
})
afterEach(async () => {
  try {
    await act(async () => {
      setup?.renderer.destroy()
    })
    for (const name of readdirSync(root).filter((name) => name.startsWith("started-") && name.endsWith(".json"))) {
      const { pid } = peerReceipt(name.slice(8, -5))
      if (alive(pid)) {
        try {
          process.kill(-pid, "SIGKILL")
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error
        }
        await waitForExit(pid)
      }
    }
  } finally {
    setup = undefined
    state = undefined
    pickerState = undefined
    change = undefined
    statuses.length = 0
    drafts.length = 0
    if (originalSessionRoot === undefined) delete process.env.SMITHERS_TUI_SESSION_DIR
    else process.env.SMITHERS_TUI_SESSION_DIR = originalSessionRoot
    if (originalPath === undefined) delete process.env.PATH
    else process.env.PATH = originalPath
    rmSync(root, { recursive: true, force: true })
  }
})

test.each(
  [
    ["text:a.b", ["literal.txt"]],
    ["text:/a.b/", ["literal.txt", "regex.txt"]]
  ] as const
)("real rg query %s preserves literal versus regex matching", async (query, paths) => {
  writeFileSync(join(cwd, "literal.txt"), "a.b\n")
  writeFileSync(join(cwd, "regex.txt"), "axb\n")
  await mount(palette(query))
  await waitFor(() => state?.search?.status === "done")
  expect(state?.search?.hits.map((hit) => hit.path).sort()).toEqual([...paths])
  expect(state?.search?.query).toBe(query.slice(5))
  expect(state?.search?.truncated).toBe(false)
  expect(statuses).toEqual([])
  expect(setup!.captureCharFrame()).toContain("literal.txt:1")
})

test("a settled empty search stays distinct from no search and the next query recovers", async () => {
  writeFileSync(join(cwd, "answer.txt"), "needle\n")
  await mount(palette("text:absent"))
  await waitFor(() => state?.search?.status === "done")
  expect(state?.search?.hits).toEqual([])
  expect(state?.search?.truncated).toBe(false)
  await update(palette("text:needle"))
  await waitFor(() => state?.search?.status === "done" && state.search.query === "needle")
  expect(state?.search?.hits).toEqual([{ path: "answer.txt", line: 1, text: "needle" }])
  expect(statuses).toEqual([])
})

test("real rg caps a dense result and preserves an honest truncated receipt", async () => {
  writeFileSync(join(cwd, "many.txt"), "needle\n".repeat(201))
  await mount(palette("text:needle"))
  await waitFor(() => state?.search?.status === "done")
  expect(state?.search?.truncated).toBe(true)
  expect(state?.search?.hits).toHaveLength(200)
  expect(state?.search?.hits[0]).toEqual({ path: "many.txt", line: 1, text: "needle" })
  expect(state?.search?.hits[199]).toEqual({ path: "many.txt", line: 200, text: "needle" })
})

test("invalid real regex reports a danger status once and a valid query recovers", async () => {
  writeFileSync(join(cwd, "answer.txt"), "needle\n")
  await mount(palette("text:/[/"))
  await waitFor(() => statuses.length === 1)
  expect(statuses).toEqual([["Bad pattern: unclosed character class", "danger"]])
  expect(state?.search).toBeUndefined()
  await update(palette("text:needle"))
  await waitFor(() => state?.search?.status === "done")
  expect(state?.search?.hits).toEqual([{ path: "answer.txt", line: 1, text: "needle" }])
  expect(statuses).toHaveLength(1)
})

test("a too-short query has no search; leaving the palette cancels its debounce while chat remains usable", async () => {
  writeFileSync(join(cwd, "answer.txt"), "needle\n")
  await mount(palette("text:n"))
  await timerPhase(200)
  expect(state?.search).toBeUndefined()
  await update(palette("text:needle"))
  await update(undefined)
  await act(async () => {
    await setup!.mockInput.typeText("chat")
  })
  await timerPhase(200)
  expect(state?.search).toBeUndefined()
  expect(drafts).toEqual(["c", "ch", "cha", "chat"])
  expect(statuses).toEqual([])
})

test("conversation listing is saved once per palette opening and a new opening reads fresh sessions", async () => {
  const first = Session.create(cwd)
  first.append({ type: "user", text: "First request", at: 100 })
  await mount(palette("conversation:First"))
  await waitFor(() => pickerState?.kind === "palette" && pickerState.sessions !== undefined)
  if (pickerState?.kind !== "palette") throw new Error("Expected the open palette")
  expect(pickerState.sessions?.map((session) => ({ file: session.file, firstPrompt: session.firstPrompt }))).toEqual([{
    file: first.file,
    firstPrompt: "First request"
  }])
  const second = Session.create(cwd)
  second.append({ type: "user", text: "Second request", at: 200 })
  const savedSessions = pickerState.sessions
  await update({ ...pickerState, query: "conversation:Second" })
  expect(pickerState?.kind === "palette" ? pickerState.sessions : undefined).toBe(savedSessions)
  await update(undefined)
  await update(palette("conversation:Second"))
  await waitFor(() => pickerState?.kind === "palette" && pickerState.sessions?.length === 2)
  expect(pickerState?.kind === "palette" ? pickerState.sessions?.map((session) => session.file).sort() : []).toEqual(
    [first.file, second.file].sort()
  )
})

test("a real non-directory session location fails visibly and saves an empty listing instead of rereading forever", async () => {
  mkdirSync(join(root, "sessions"))
  writeFileSync(Session.directory(cwd), "not a directory")
  await mount(palette("conversation:First"))
  await waitFor(() => statuses.length === 1)
  expect(statuses[0]?.[1]).toBe("danger")
  expect(statuses[0]?.[0]).toBe("Saved conversations could not be listed. Details: /conversation")
  expect(pickerState?.kind === "palette" ? pickerState.sessions : undefined).toEqual([])
  await act(async () => {
    await setImmediate()
  })
  expect(statuses).toHaveLength(1)
})

// A fixture-owned rg peer is an explicit process boundary double. It admits
// the real CLI args and stalls until released; cancellation must kill it.
const PeerReceipt = Schema.Struct({ pid: Schema.Int, query: Schema.String, args: Schema.Array(Schema.String) })
const peerReceipt = (query: string) =>
  Schema.decodeUnknownSync(PeerReceipt)(JSON.parse(readFileSync(join(root, `started-${query}.json`), "utf8")))
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false
    throw error
  }
}
const waitForExit = async (pid: number) => {
  const deadline = Date.now() + 5000
  while (alive(pid) && Date.now() < deadline) await setImmediate()
  if (alive(pid)) throw new Error(`Owned rg peer ${pid} did not exit`)
}
const controlledPeer = () => {
  const bin = join(root, "bin")
  mkdirSync(bin)
  const executable = join(bin, "rg")
  writeFileSync(
    executable,
    `#!${process.execPath}
import { existsSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
const root = ${JSON.stringify(root)}
const args = process.argv.slice(2)
const query = args[args.indexOf("-e") + 1]
writeFileSync(join(root, "started-" + query + ".tmp"), JSON.stringify({ pid: process.pid, query, args }))
renameSync(join(root, "started-" + query + ".tmp"), join(root, "started-" + query + ".json"))
const timer = setInterval(() => {
  if (!existsSync(join(root, "release-" + query))) return
  clearInterval(timer)
  console.log(JSON.stringify({ type: "match", data: { path: { text: query + ".txt" }, lines: { text: "answer\\n" }, line_number: 1 } }))
}, 10)
`
  )
  chmodSync(executable, 0o700)
  process.env.PATH = `${bin}:${originalPath ?? ""}`
}

test.each(["query", "category", "close"] as const)(
  "controlled peer: %s change cancels an unresolved search and retains chat responsiveness",
  async (kind) => {
    controlledPeer()
    await mount(palette("text:alpha"))
    await waitFor(() => state?.search?.status === "running" && existsSync(join(root, "started-alpha.json")))
    const first = peerReceipt("alpha")
    expect(first.args).toEqual(["--json", "--smart-case", "-F", "-e", "alpha", "--", "."])
    expect(alive(first.pid)).toBe(true)
    expect(existsSync(join(root, "release-alpha"))).toBe(false)
    await act(async () => {
      await setup!.mockInput.typeText("ask")
    })
    expect(drafts).toEqual(["a", "as", "ask"])
    expect(state?.search?.status).toBe("running")
    await update(kind === "query" ? palette("text:beta") : kind === "category" ? palette("tab:worker") : undefined)
    await waitForExit(first.pid)
    expect(alive(first.pid)).toBe(false)
    if (kind === "query") {
      await waitFor(() => existsSync(join(root, "started-beta.json")) && state?.search?.query === "beta")
      writeFileSync(join(root, "release-beta"), "release")
      await waitFor(() => state?.search?.status === "done")
      expect(state?.search?.hits).toEqual([{ path: "beta.txt", line: 1, text: "answer" }])
    } else expect(state?.search).toBeUndefined()
    expect(statuses).toEqual([])
  }
)

test("controlled peer: unmount kills the pending process without publishing a failure", async () => {
  controlledPeer()
  await mount(palette("text:alpha"))
  await waitFor(() => state?.search?.status === "running" && existsSync(join(root, "started-alpha.json")))
  const { pid } = peerReceipt("alpha")
  await act(async () => {
    setup!.renderer.destroy()
  })
  setup = undefined
  await waitForExit(pid)
  expect(alive(pid)).toBe(false)
  expect(statuses).toEqual([])
})

test("missing rg reports the exact refusal and recovery uses the restored real PATH", async () => {
  process.env.PATH = join(root, "missing-bin")
  await mount(palette("text:needle"))
  await waitFor(() => statuses.length === 1)
  expect(statuses).toEqual([["rg not found", "danger"]])
  expect(state?.search).toBeUndefined()
  process.env.PATH = originalPath
  writeFileSync(join(cwd, "answer.txt"), "needle\n")
  await update(palette("text:answer"))
  await update(palette("text:needle"))
  await waitFor(() => state?.search?.status === "done")
  expect(state?.search?.hits).toEqual([{ path: "answer.txt", line: 1, text: "needle" }])
  expect(statuses).toHaveLength(1)
})

test("a non-directory search location reports the actual process admission error and changing directories recovers", async () => {
  const workspace = cwd
  const invalidDirectory = join(root, "regular-file")
  writeFileSync(invalidDirectory, "not a directory")
  cwd = invalidDirectory
  await mount(palette("text:needle"))
  await waitFor(() => statuses.length === 1)
  expect(statuses).toHaveLength(1)
  expect(statuses[0]?.[1]).toBe("danger")
  expect(statuses[0]?.[0]).toStartWith("rg:")
  expect(statuses[0]?.[0]).toContain("ENOTDIR")
  expect(state?.search).toBeUndefined()
  writeFileSync(join(workspace, "answer.txt"), "needle\n")
  await update(palette("text:needle"), workspace)
  await waitFor(() => state?.search?.status === "done")
  expect(state?.search?.hits).toEqual([{ path: "answer.txt", line: 1, text: "needle" }])
  expect(statuses).toHaveLength(1)
})

test("public Search.run turns synchronous process admission refusal into its typed failed outcome", async () => {
  const invalidDirectory = join(root, "regular-file")
  writeFileSync(invalidDirectory, "not a directory")
  let operation: ReturnType<typeof Search.run> | undefined
  let thrown: unknown
  try {
    operation = Search.run({ cwd: invalidDirectory, query: "needle" })
  } catch (error) {
    thrown = error
  }
  expect(thrown).toBeUndefined()
  if (operation === undefined) throw new Error("Expected the public search operation")
  const admitted = operation
  expect(() => {
    admitted.cancel()
    admitted.cancel()
  }).not.toThrow()
  const outcome = await admitted.done
  expect(outcome).toMatchObject({ _tag: "failed", reason: "rg-error" })
  if (outcome._tag !== "failed") throw new Error("Expected a search refusal")
  expect(outcome.message).toContain("ENOTDIR")
  expect(() => admitted.cancel()).not.toThrow()
  expect(await admitted.done).toBe(outcome)
})
