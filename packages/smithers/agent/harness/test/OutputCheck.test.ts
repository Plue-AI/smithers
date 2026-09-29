/**
 * A completion whose output does not fit the host's declared shape goes back
 * to the session that wrote it, so the correction keeps the realm and what the
 * cell printed instead of re-running the work in a fresh session.
 */
import { ModelRequest } from "@smthrs/model"
import { Effect, Option } from "effect"
import { describe, expect, it } from "vitest"
import * as CellTurn from "../src/CellTurn.ts"
import { emits, of, pattern, run, window } from "./fixtures/cellTurn.ts"

const state = (maxFrames: number) =>
  CellTurn.make({
    session: "session-1",
    seat: "anthropic:test-model",
    modelParams: ModelRequest.GenerationParams.make(),
    layers: ["layer-a"],
    capabilityEnvelope: ["fs:read:**"].map(pattern),
    placement: Option.none(),
    contextWindow: window,
    maxFrames,
    repeatCap: 0,
    unmovedCap: 0,
    narrowingCap: 0,
    unresolvedCap: 0,
    claimCap: 0
  })

/** Accepts `{"ok":true}` and refuses everything else, recording each question. */
const shape = (cap: number, asked: Array<readonly [string, number]>): CellTurn.OutputCheck => ({
  cap,
  check: (output, corrected) =>
    Effect.sync(() => {
      asked.push([output, corrected])
      return output === "{\"ok\":true}" ? undefined : `Refused: ${output}`
    })
})

const answer = (events: Awaited<ReturnType<typeof run>>["events"]) =>
  of(events, "resolved")[0]?.message.content.map((part) => part.type === "text" ? part.text : "").join("")

describe("CellTurn output check", () => {
  it("hands a refused completion back to the same session with what its cell printed", async () => {
    const asked: Array<readonly [string, number]> = []
    const { events, model } = await run({
      state: state(3),
      script: [
        `const kept = "bound-7f3a"; console.log("printed-7f3a"); ctx.done("not the shape")`,
        `ctx.done({ ok: kept === "bound-7f3a" })`
      ].map(emits),
      output: shape(2, asked)
    })

    expect(answer(events)).toBe("{\"ok\":true}")
    expect(asked).toEqual([["not the shape", 0], ["{\"ok\":true}", 1]])
    expect(of(events, "output-demanded")).toEqual([
      expect.objectContaining({ note: "Refused: not the shape", nextFrame: 1 })
    ])
    const second = JSON.stringify(model.recorder.requests[1]?.messages)
    expect(second).toContain("printed-7f3a")
    expect(second).toContain("Refused: not the shape")
  })

  it("lets a completion stand once the cap is spent", async () => {
    const asked: Array<readonly [string, number]> = []
    const { events } = await run({
      state: state(5),
      script: [`ctx.done("first miss")`, `ctx.done("second miss")`].map(emits),
      output: shape(1, asked)
    })

    expect(asked).toEqual([["first miss", 0]])
    expect(of(events, "output-demanded")).toHaveLength(1)
    expect(answer(events)).toBe("second miss")
  })

  it("asks nothing when no frame is left to answer in", async () => {
    const asked: Array<readonly [string, number]> = []
    const { events } = await run({
      state: state(1),
      script: [emits(`ctx.done("only frame")`)],
      output: shape(3, asked)
    })

    expect(asked).toEqual([])
    expect(of(events, "output-demanded")).toEqual([])
    expect(answer(events)).toBe("only frame")
  })

  it("replays the recorded verdict rather than checking again", async () => {
    const records = new Map<string, unknown>()
    const script = [`ctx.done("not the shape")`, `ctx.done({ ok: true })`].map(emits)
    const first: Array<readonly [string, number]> = []
    const original = await run({ state: state(3), script, output: shape(2, first), records })
    const second: Array<readonly [string, number]> = []
    const replay = await run({
      state: state(3),
      script,
      // A host that would now accept anything: the recorded refusal decides.
      output: { cap: 2, check: (output, corrected) => Effect.sync(() => void second.push([output, corrected])) },
      records
    })

    expect(first).toHaveLength(2)
    expect(second).toEqual([])
    expect(of(replay.events, "output-demanded")).toEqual(of(original.events, "output-demanded"))
    expect(answer(replay.events)).toBe("{\"ok\":true}")
  })
})
