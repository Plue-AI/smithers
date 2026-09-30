/**
 * A ✓ has one meaning (#F02): a command's row carries its exit status, a run
 * ends in one outcome word, a stop is never a failure, and a run no judge
 * could check is done, unchecked.
 */
import { rgbToHex } from "@opentui/core"
import { testRender } from "@opentui/react/test-utils"
import * as CompletionClaim from "@smthrs/harness/CompletionClaim"
import { EvaluatorError } from "@smthrs/model/Evaluator"
import * as FailureCopy from "@smthrs/model/FailureCopy"
import * as SubagentCard from "@smthrs/rpc/SubagentCard"
import { afterEach, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { act } from "react"
import * as Failures from "../src/failures.ts"
import { uncheckedAnswer } from "../src/host.ts"
import * as Session from "../src/session.ts"
import * as Subagents from "../src/subagents.ts"
import * as Summary from "../src/summary.ts"
import * as Tabs from "../src/tabs.ts"
import { color } from "../src/theme.ts"
import * as Transcript from "../src/transcript.ts"
import * as View from "../src/view.tsx"
import type { Tab } from "../src/workspace.ts"

let setup: Awaited<ReturnType<typeof testRender>> | undefined
afterEach(async () => {
  await act(async () => {
    setup?.renderer.destroy()
    setup = undefined
  })
})

const frame = async (item: Transcript.Item, width = 100): Promise<string> => {
  setup = await testRender(<View.Entry item={item} now={1_000} tick="." expanded={false} />, { width, height: 14 })
  await setup.renderOnce()
  const text = setup.captureCharFrame()
  await act(async () => {
    setup?.renderer.destroy()
    setup = undefined
  })
  return text
}

/** Non-empty rows without the transcript's left bar. */
const lines = (text: string): ReadonlyArray<string> =>
  text.split("\n").map((line) => line.replace(/^┃ /, "").trimEnd()).filter((line) => line.trim() !== "")

const cell = (calls: ReadonlyArray<Transcript.Call>): Transcript.Item => ({
  kind: "cell",
  id: "c1",
  index: 1,
  prose: "",
  source: "",
  status: "done",
  printed: "",
  startedAt: 0,
  endedAt: 1_000,
  calls
})
const call = (change: Partial<Transcript.Call>): Transcript.Call => ({
  flow: "bash",
  subject: "node check.mjs",
  status: "ok",
  startedAt: 0,
  endedAt: 100,
  ...change
})

describe("a command's row", () => {
  it("reads ✗ and its exit status when the command exited nonzero, though the call succeeded", async () => {
    const rows = lines(await frame(cell([call({ exit: 1 })])))
    expect(rows.find((row) => row.includes("node check.mjs"))).toMatch(/^✗ node check\.mjs {2}exit 1 +100ms$/)
  })

  it("reads ✓ and exit 0 only for a command that passed", async () => {
    const rows = lines(await frame(cell([call({ exit: 0 })])))
    expect(rows.find((row) => row.includes("node check.mjs"))).toMatch(/^✓ node check\.mjs {2}exit 0 +100ms$/)
  })

  it("reads ✗ for a call that failed, and keeps a read's own icon while it succeeds", async () => {
    const rows = lines(
      await frame(cell([
        call({ flow: "read", subject: "math.js" }),
        call({ flow: "read", subject: "gone.js", status: "failed" })
      ]))
    )
    expect(rows.some((row) => /^→ read math\.js/.test(row))).toBe(true)
    expect(rows.some((row) => /^✗ read gone\.js/.test(row))).toBe(true)
  })

  it("marks a settled edit ✓ with its line counts", async () => {
    const edit = call({
      flow: "edit",
      subject: "math.js",
      verb: { pending: "editing", success: "edited", failure: "failed to edit" },
      change: { path: "math.js", removed: "a - b", added: "a + b", line: 1 }
    })
    const rows = lines(await frame(cell([edit])))
    expect(rows.find((row) => row.includes("math.js"))).toMatch(/^✓ edited math\.js {2}\+1 −1 +100ms$/)
  })

  it("keeps a zero exit status the harness reported, from the recorded fix-add run", () => {
    const records = readFileSync(join(import.meta.dir, "fixtures/fix-add.jsonl"), "utf8").trim().split("\n")
      .map((line) => ({ type: "event" as const, ...JSON.parse(line) }))
    const commands = Session.restore(records).transcript.items
      .flatMap((item) => item.kind === "cell" ? item.calls : [])
      .filter((each) => each.flow === "bash")
      .map((each) => [each.subject, each.exit])
    expect(commands[0]).toEqual(["node check.mjs", 1])
    expect(commands).toContainEqual(["node check.mjs", 0])
  })
})

describe("a run's ending in its transcript", () => {
  it("says stopped, not a red failure", async () => {
    const stopped = Transcript.stopped(Transcript.empty, 5)
    expect(stopped.activity?.status).toBe("cancelled")
    const text = await frame(stopped.items.at(-1)!)
    expect(lines(text)).toEqual(["■ stopped"])
  })

  it("settles a call the stop interrupted as stopped: ■ in faint, never ✗ or red", async () => {
    const identity = { session: "s", frame: 0, cell: "c", ordinal: 0, declaration: "d", layers: [] }
    const events = [
      { _tag: "cell-produced", cell: { language: "javascript", text: "await ctx.call(\"read\", {})" } },
      { _tag: "cell-call-started", call: { flowName: "read", input: { path: "src/auth.ts" }, identity } }
    ] as unknown as ReadonlyArray<Parameters<typeof Transcript.apply>[1]>
    const open = events.reduce((state, event, index) => Transcript.apply(state, event, index), Transcript.empty)
    const cellOf = (transcript: Transcript.Transcript) =>
      transcript.items.find((item): item is Extract<Transcript.Item, { kind: "cell" }> => item.kind === "cell")!

    const stopped = cellOf(Transcript.stopped(open, 5))
    expect(stopped.status).toBe("stopped")
    expect(stopped.calls.map((each) => each.status)).toEqual(["stopped"])
    // A failure still fails what it interrupted.
    const failed = cellOf(Transcript.failure(open, "Model call failed", 5))
    expect(failed.status).toBe("failed")
    expect(failed.calls.map((each) => each.status)).toEqual(["failed"])

    setup = await testRender(<View.Entry item={stopped} now={1_000} tick="." expanded={false} />, {
      width: 100,
      height: 14
    })
    await setup.renderOnce()
    const row = lines(setup.captureCharFrame()).find((each) => each.includes("src/auth.ts"))!
    expect(row).toMatch(/^■ \S+ src\/auth\.ts/)
    const spans = setup.captureSpans().lines.flatMap((line) => line.spans)
    expect(spans.filter((span) => span.text.includes("■")).map((span) => rgbToHex(span.fg))).toEqual([color.faint])
    for (const span of spans) expect(rgbToHex(span.fg)).not.toBe(color.danger)

    // The worker card's row and the summary say the same.
    const card = SubagentCard.describe(Subagents.entry(stopped.calls[0]!))
    expect(card).toMatchObject({ mark: "■", state: "stopped" })
    expect(card.text).toMatch(/ src\/auth\.ts$/)
    expect(Summary.panel(Transcript.stopped(open, 5)).rows[0]).toMatchObject({ status: "cancelled" })
  })

  it("says failed and its cause", async () => {
    const failed = Transcript.failure(Transcript.empty, "Model call failed", 5)
    expect(failed.activity?.status).toBe("failed")
    expect(lines(await frame(failed.items.at(-1)!))).toEqual(["✗ failed: Model call failed"])
  })

  it("keeps a background alert's own words", async () => {
    const alert = Transcript.alert(Transcript.empty, "watch: source unreadable", 5)
    expect(lines(await frame(alert.items.at(-1)!))).toEqual(["✗ watch: source unreadable"])
  })

  it("settles an unchecked run as done with its answer", () => {
    const open = Transcript.apply(
      Transcript.empty,
      { _tag: "model-delta", delta: { type: "text-delta", text: "```js\nx\n```" } } as never,
      1
    )
    const done = Transcript.unchecked(open, "Fixed the failing test.", 9)
    expect(done.activity?.status).toBe("completed")
    expect(done.items.at(-1)).toMatchObject({ kind: "answer", text: "Fixed the failing test." })
    expect(done.items.some((item) => item.kind === "error")).toBe(false)
    expect(done.items.find((item) => item.kind === "cell")).toMatchObject({ status: "done" })
  })

  it("restores the same endings from a session file", () => {
    const restored = (outcome: Session.Record) => Session.restore([outcome]).transcript.items.at(-1)
    expect(restored({ type: "outcome", at: 1, prompt: "p", outcome: { _tag: "cancelled" } }))
      .toMatchObject({ kind: "error", stopped: true })
    expect(
      restored({ type: "outcome", at: 1, prompt: "p", outcome: { _tag: "done", answer: "Fixed.", unchecked: true } })
    ).toMatchObject({ kind: "answer", text: "Fixed." })
    expect(
      Session.restore([{ type: "outcome", at: 1, prompt: "p", outcome: { _tag: "done", answer: "Fixed." } }])
        .transcript.items
    ).toEqual([])
  })
})

describe("one outcome word per run", () => {
  const tab = (status: Tab["status"], extra: Partial<Tab> = {}) => ({ status, ...extra })
  it("reads working, done, done · unchecked, failed: cause and stopped", () => {
    expect(Tabs.outcome(tab("running"))).toBe("working")
    expect(Tabs.outcome(tab("queued"))).toBe("working")
    expect(Tabs.outcome(tab("done"))).toBe("done")
    expect(Tabs.outcome(tab("done", { unchecked: true }))).toBe("done · unchecked")
    expect(Tabs.outcome(tab("cancelled"))).toBe("stopped")
    expect(
      Tabs.outcome(tab("failed", { failure: { headline: "Model call failed", fault: "bug", line: "", actions: [] } }))
    ).toBe("failed: Model call failed")
    expect(Tabs.outcome(tab("failed"))).toBe("failed: Worker stopped unexpectedly")
  })

  it("draws a stopped worker ■, never the ● of done work", () => {
    expect(Tabs.style("cancelled", 0).glyph).toBe("■")
    expect(Tabs.style("done", 0).glyph).toBe("●")
  })
})

describe("a completion no judge could check", () => {
  const claim = "Fixed src/cart.js; npm test passes 3 of 3."
  // The harness's own refusal, so a change to its wording cannot pass here and fail live.
  const unjudged = CompletionClaim.unjudged("unconfigured", "AI_GATEWAY_API_KEY is not set.", `${claim}\n`)

  it("keeps the answer the harness refused", () => {
    expect(uncheckedAnswer(unjudged)).toBe(claim)
    expect(uncheckedAnswer({ _tag: "Wrapped", cause: unjudged })).toBe(claim)
  })

  it("leaves every other failure failed", () => {
    const unproven = CompletionClaim.unproven({ complete: 0.1, overclaims: 0.9, invented: 0.95 }, true, claim)
    expect(unproven.message).toContain(claim)
    expect(uncheckedAnswer(unproven)).toBeUndefined()
    expect(uncheckedAnswer({ _tag: unjudged._tag, code: unjudged.code, message: "no quoted completion" }))
      .toBeUndefined()
    expect(uncheckedAnswer(new Error("boom"))).toBeUndefined()
    expect(uncheckedAnswer(undefined)).toBeUndefined()
    const cycle: { _tag: string; cause?: unknown } = { _tag: "Loop" }
    cycle.cause = cycle
    expect(uncheckedAnswer(cycle)).toBeUndefined()
  })
})

const workerFailure = (error: unknown) => Failures.onCard(error, FailureCopy.describe(error))

describe("a worker's result card", () => {
  it("never teaches setup: a judge's or seat's instructions stay in details", () => {
    const judge = new EvaluatorError({
      code: "unconfigured",
      message: "AI_GATEWAY_API_KEY is not set. Luna is not opted in."
    })
    const card = workerFailure(judge)
    expect(card.line).toBe("The worker stopped before finishing.")
    expect(card.line).not.toMatch(/AI_GATEWAY_API_KEY|SMITHERS_|login|opt in/)
    const unresolved = {
      _tag: "@smthrs/agent/Seat/SeatUnresolved",
      seat: "anthropic:claude-opus",
      message: "Set ANTHROPIC_API_KEY or run claude login."
    }
    expect(workerFailure(unresolved)).toMatchObject({
      headline: "Model sign-in required",
      line: "The worker stopped before finishing."
    })
    const unrouted = { _tag: "@smthrs/agent/Seat/SeatUnrouted", reason: "unconfigured", message: "Set SMITHERS_SEAT." }
    expect(workerFailure(unrouted).line).toBe("The worker stopped before finishing.")
  })

  it("keeps a failure's own sentence when it teaches nothing", () => {
    expect(
      workerFailure({ _tag: "@smthrs/agent/Seat/SeatUnrouted", reason: "no_candidates", message: "" }).line
    ).toBe("No model is set up to route to.")
    expect(workerFailure(new Error("boom")).line).toBe("The worker stopped before finishing.")
  })
})
