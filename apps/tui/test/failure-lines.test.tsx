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

const frame = async (item: Transcript.Item, expanded: boolean): Promise<string> => {
  setup = await testRender(<View.Entry item={item} now={1_000} tick="." expanded={expanded} />, {
    width: 100,
    height: 14
  })
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
