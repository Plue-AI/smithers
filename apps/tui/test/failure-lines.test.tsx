import { testRender } from "@opentui/react/test-utils"
import { afterEach, describe, expect, it } from "bun:test"
import { act } from "react"
import * as Failures from "../src/failures.ts"
import type * as Transcript from "../src/transcript.ts"
import * as View from "../src/view.tsx"

let setup: Awaited<ReturnType<typeof testRender>> | undefined
afterEach(async () => {
  await act(async () => {
    setup?.renderer.destroy()
    setup = undefined
  })
})

const RAW = "TypeError: ECONNRESET at socket.ts:42"

const cell = (change: Partial<Extract<Transcript.Item, { kind: "cell" }>>): Transcript.Item => ({
  kind: "cell",
  id: "c1",
  index: 1,
  prose: "Reading the config",
  source: "",
  status: "failed",
  printed: "",
  startedAt: 0,
  endedAt: 1_000,
  calls: [],
  ...change
})

const frame = async (item: Transcript.Item, expanded: boolean, chat?: boolean): Promise<string> => {
  setup = await testRender(
    <View.Entry item={item} now={1_000} tick="." expanded={expanded} {...(chat === undefined ? {} : { chat })} />,
    {
      width: 100,
      height: 14
    }
  )
  await setup.renderOnce()
  const text = setup.captureCharFrame()
  await act(async () => {
    setup?.renderer.destroy()
    setup = undefined
  })
  return text
}

describe("a failed step", () => {
  it("shows one sentence and keeps what it threw behind ctrl+o", async () => {
    const collapsed = await frame(cell({ error: RAW }), false)
    expect(collapsed).toContain("This step failed. · ctrl+o")
    expect(collapsed).not.toContain("ECONNRESET")
    const expanded = await frame(cell({ error: RAW }), true)
    expect(expanded).toContain("This step failed.")
    expect(expanded).toContain(RAW)
  })

  it("hides a rejected step until ctrl+o, which words it by its code", async () => {
    const collapsed = await frame(cell({ status: "rejected", error: "compile_failed" }), false)
    expect(collapsed.trim()).toBe("")
    const expanded = await frame(cell({ status: "rejected", error: "compile_failed" }), true)
    expect(expanded).toContain("This step's code did not compile.")
    expect(expanded).toContain("compile_failed")
  })
})

describe("a failed call", () => {
  const failed = (change: Partial<Transcript.Call>): Transcript.Item =>
    cell({
      status: "done",
      calls: [{
        flow: "read",
        subject: "config.json",
        status: "failed",
        message: `${RAW}\n    at read (fs.ts:9)`,
        verb: { pending: "reading", success: "read", failure: "failed to read" },
        startedAt: 0,
        endedAt: 500,
        ...change
      }]
    })

  it("shows one sentence and reveals the whole raw message under ctrl+o", async () => {
    const collapsed = await frame(failed({}), false)
    expect(collapsed).toContain("This action failed. · ctrl+o")
    expect(collapsed).not.toContain("ECONNRESET")
    const expanded = await frame(failed({}), true)
    expect(expanded).toContain(RAW)
    expect(expanded).toContain("at read (fs.ts:9)")
  })

  it("says a denial is the person's own and shows no raw prefix", async () => {
    const denied = failed({ denied: true, message: "Denied: read config.json" })
    const collapsed = await frame(denied, false)
    expect(collapsed).toContain("Not approved.")
    expect(collapsed).not.toContain("ctrl+o")
    expect(collapsed).not.toContain("Denied:")
  })
})

describe("a failed read in Chat", () => {
  const read = (change: Partial<Transcript.Call>): Transcript.Call => ({
    flow: "read",
    subject: "src/math.js",
    status: "failed",
    message: "File not found: src/math.js. The working directory holds: math.js, check.mjs.",
    verb: { pending: "reading", success: "read", failure: "failed to read" },
    startedAt: 0,
    endedAt: 500,
    ...change
  })
  const { message: _message, ...readOk } = read({ status: "ok", subject: "math.js" })
  const rows = (text: string) => text.split("\n").map((row) => row.trim()).filter((row) => row !== "")

  it("is one faint row with its reason, and the step it failed stays under ctrl+o", async () => {
    const item = cell({ error: "TypeError: undefined is not an object", calls: [read({})] })
    expect(rows(await frame(item, false, true))).toEqual(["✗ failed to read src/math.js · no such file"])
    const expanded = await frame(item, true, true)
    expect(expanded).toContain("This step failed.")
    expect(expanded).toContain("TypeError: undefined is not an object")
  })

  it("keeps the failure of a step that only read under ctrl+o", async () => {
    const item = cell({ error: "TypeError: cannot read property 'message' of undefined", calls: [readOk] })
    expect(rows(await frame(item, false, true))).toEqual(["→ read math.js"])
    expect(await frame(item, true, true)).toContain("This step failed.")
  })

  it("names a refusal, and keeps every other row of the step", async () => {
    const item = cell({
      status: "done",
      calls: [
        read({ subject: "../secret.txt", message: "../secret.txt: outside this repository" }),
        readOk,
        read({
          flow: "grep",
          subject: "price",
          message: "src/loop: too many symlinks",
          verb: { pending: "searching", success: "searched", failure: "failed to search" }
        })
      ]
    })
    expect(rows(await frame(item, false, true))).toEqual([
      "✗ failed to read ../secret.txt · outside this repository",
      "→ read math.js",
      "✗ failed to search price · too many symlinks"
    ])
  })

  it("leaves a worker's failed read and Chat's other failed calls as they were", async () => {
    const worker = await frame(cell({ status: "done", calls: [read({})] }), false)
    expect(worker).toContain("This action failed. · ctrl+o")
    const shell = await frame(
      cell({ status: "done", calls: [read({ flow: "bash", subject: "node check.mjs", message: RAW })] }),
      false,
      true
    )
    expect(shell).toContain("This action failed. · ctrl+o")
    const ran = await frame(
      cell({ error: RAW, calls: [readOk, { ...readOk, flow: "bash", subject: "node check.mjs" }] }),
      false,
      true
    )
    expect(ran).toContain("This step failed. · ctrl+o")
  })
})

describe("step and call copy", () => {
  it("covers every rejection code with a sentence that is not the code", () => {
    const codes = [
      "no_cell",
      "output_truncated",
      "imports_forbidden",
      "compile_failed",
      "invalid_transition",
      "unsupported_language",
      "limit_exceeded",
      "stalled"
    ] as const
    const sentences = new Set<string>()
    for (const code of codes) {
      const failure = Failures.cellFailure("rejected", code)
      expect(failure).toMatchObject({ tag: code, detail: code, actions: [] })
      expect(failure.fault).not.toBe("user")
      expect(failure.sentence).toMatch(/^[A-Z][^_]*\.$/)
      sentences.add(failure.sentence)
    }
    expect(sentences.size).toBe(codes.length)
  })

  it("treats an unknown rejection code as an unknown failure with the code as detail", () => {
    expect(Failures.cellFailure("rejected", "brand_new_code")).toEqual({
      fault: "dependency",
      sentence: "This step failed.",
      actions: [],
      tag: null,
      detail: "brand_new_code"
    })
  })
})
