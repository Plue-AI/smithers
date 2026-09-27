/**
 * Which tree a sealed reading of the live workspace is keyed on (#1948).
 *
 * The epoch's counters restart with every run, so before the tree entered it
 * a read in a later run keyed the same as one in an earlier run and replayed
 * its answer over an edit made between the two. These cases pin what the
 * controller stamps; `FlowEngineLike` folds the stamp into the sealed key.
 */
import { ModelRequest } from "@smthrs/model"
import { Option } from "effect"
import { describe, expect, it } from "vitest"
import * as CellTurn from "../src/CellTurn.ts"
import { descriptor, emits, pattern, run, window } from "./fixtures/cellTurn.ts"

const state = (session: string) =>
  CellTurn.make({
    session,
    seat: "anthropic:test-model",
    modelParams: ModelRequest.GenerationParams.make(),
    layers: ["layer-a"],
    capabilityEnvelope: [pattern("fs:read:**")],
    placement: Option.none(),
    contextWindow: window,
    maxFrames: 2,
    readOnlyCap: 0,
    approvalChannel: false
  })

const read = `await ctx.call("fs/read", { path: "check-status.txt" }); ctx.done("read")`

const epochs = async (session: string, tree?: string, treeComplete?: boolean) => {
  const { engine } = await run({
    state: state(session),
    flows: [descriptor("fs/read", { capabilities: ["fs:read:**"] })],
    script: [emits(read)],
    calls: [{ _tag: "Success", value: "2 checks passed" }],
    ...(tree === undefined ? {} : { tree }),
    ...(treeComplete === undefined ? {} : { treeComplete })
  })
  return engine.recorder.calls.map((call) => call.epoch)
}

describe("CellTurn live tree epoch", () => {
  it("keys a first read on the tree the run opened on, so a between-run edit is a new question", async () => {
    const before = await epochs("turn-1", "check-status.txt=2 checks passed")
    const after = await epochs("turn-2", "check-status.txt=stop-monitor")

    expect(before).toEqual([{ frames: 0, calls: 0, tree: "check-status.txt=2 checks passed" }])
    expect(after).toEqual([{ frames: 0, calls: 0, tree: "check-status.txt=stop-monitor" }])
  })

  it("keys two runs over one unchanged tree alike, so a sealed reading still replays", async () => {
    expect(await epochs("turn-1", "unchanged")).toEqual(await epochs("turn-2", "unchanged"))
  })

  it("keeps a reading of an unmeasured tree inside its own run", async () => {
    expect(await epochs("turn-1")).toEqual([{ frames: 0, calls: 0, session: "turn-1", frame: 0 }])
    expect(await epochs("turn-2")).toEqual([{ frames: 0, calls: 0, session: "turn-2", frame: 0 }])
  })

  it("keys a read after a different write differently, so one run cannot replay another's pre-edit text (#2175)", async () => {
    const after = async (session: string, command: string) => {
      const { engine } = await run({
        state: state(session),
        flows: [
          descriptor("fs/read", { capabilities: ["fs:read:**"] }),
          descriptor("shell", { capabilities: ["fs:read:**"], tier: "compensable" })
        ],
        script: [
          emits(
            `await ctx.call("shell", { command: ${JSON.stringify(command)} }); ` +
              `await ctx.call("fs/read", { path: "a.py" }); ctx.done("read")`
          )
        ],
        calls: [{ _tag: "Success", value: "" }, { _tag: "Success", value: "text" }],
        tree: "a.py=before"
      })
      return engine.recorder.calls.map((call) => call.epoch)[1]
    }
    const looked = await after("turn-1", "git status")
    const edited = await after("turn-2", "sed -i s/before/after/ a.py")
    expect(looked).toMatchObject({ frames: 0, calls: 1, tree: "a.py=before" })
    expect(edited).not.toEqual(looked)
    // The same write over the same tree is the same question.
    expect(await after("turn-3", "git status")).toEqual(looked)
  })

  it("treats a walk that stopped at its bound as unmeasured", async () => {
    expect(await epochs("turn-1", "prefix", false)).toEqual([{ frames: 0, calls: 0, session: "turn-1", frame: 0 }])
  })
})
