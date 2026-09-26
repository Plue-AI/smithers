import { traceFromJournal } from "@smthrs/gateway/RunTrace"
import type { AgentEvent } from "@smthrs/harness/AgentEvent"
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import * as Activity from "../src/activity.ts"
import * as Scrubber from "../src/scrubber.ts"
import * as Session from "../src/session.ts"
import * as Transcript from "../src/transcript.ts"

const events = readFileSync(new URL("./fixtures/fix-add.jsonl", import.meta.url), "utf8").trim().split("\n")
  .map((line) => JSON.parse(line) as { event: AgentEvent; at: number })
const replay = () => events.reduce((state, { event, at }) => Transcript.apply(state, event, at), Transcript.empty)

describe("the shared terminal monitor", () => {
  test("a real recorded session keeps phases, edit pins, call outcomes, and completion", () => {
    const activity = replay().activity!
    const model = Activity.model(activity)
    expect(activity.status).toBe("completed")
    expect(model.bands.some((band) => band.phase === "implementing")).toBe(true)
    expect(model.bands.some((band) => band.phase === "researching")).toBe(true)
    expect(model.milestones.some((pin) => pin.label === "math.js")).toBe(true)
    expect(activity.records.some((record) =>
      record.kind === "control.agent.cell-call-settled" &&
      (record.payload as { value?: { exitCode?: number } }).value?.exitCode === 1
    )).toBe(true)
    expect(activity.records.every((record) => record.kind !== "control.agent.model-delta")).toBe(true)
  })

  test("session restore reconstructs the same timeline from durable events", () => {
    const records: Session.Record[] = events.map((row) => ({ type: "event", ...row }))
    const restored = Session.restore(records)
    expect(Activity.model(restored.transcript.activity!)).toEqual(Activity.model(replay().activity!))
  })

  test("every event is reachable, and a new turn cannot retain the previous verdict", () => {
    const transcript = replay(), activity = transcript.activity!
    const first = activity.records[0]!.sequence!, last = activity.records.at(-1)!.sequence!
    expect(Scrubber.key(activity, undefined, "home")).toBe(first)
    expect(Scrubber.key(activity, first, "home")).toBe(first)
    expect(Scrubber.key(activity, last, "right")).toBe(last)
    expect(Scrubber.key(activity, last, "escape")).toBeUndefined()
    const next = Transcript.user(transcript, "next request", false, 100)
    expect(next.activity).toEqual(Activity.empty)
    expect(Transcript.user(transcript, "steer", true, 100).activity).toBe(activity)
  })

  test("failure and cancellation retain their real endpoints", () => {
    const failed = Activity.finish(Activity.empty, "failed", 100, "broken")
    const stopped = Activity.finish(Activity.empty, "cancelled", 200, "Stopped")
    expect(Activity.model(failed).root.status).toBe("failed")
    expect(Activity.model(stopped).root.status).toBe("cancelled")
    expect(Activity.finish(failed, "failed", 300, "broken")).toBe(failed)
  })
})

/** A recorded session's events: `{ event, at }` rows, or the `event` records of a session file. */
const recorded = (name: string): ReadonlyArray<{ event: AgentEvent; at: number }> =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8").trim().split("\n")
    .map((line) => JSON.parse(line) as { type?: string; event?: AgentEvent; at: number })
    .flatMap((row) =>
      row.event === undefined || (row.type !== undefined && row.type !== "event")
        ? []
        : [{ event: row.event, at: row.at }]
    )

describe("the incremental monitor trace", () => {
  test.each(["fix-add.jsonl", "timeline-worker.jsonl"])(
    "%s: the trace after every event equals a refold of the journal so far",
    (name) => {
      let transcript = Transcript.empty
      let checked = 0
      for (const { event, at } of recorded(name)) {
        transcript = Transcript.apply(transcript, event, at)
        const activity = transcript.activity
        if (activity === undefined) continue
        expect(Activity.model(activity)).toEqual(
          traceFromJournal({ runId: "terminal", flowId: "chat", status: activity.status }, activity.records)
        )
        checked += 1
      }
      expect(checked).toBeGreaterThan(100)
    },
    // A refold of every prefix is quadratic by design; it is the reference.
    120_000
  )

  test("an earlier activity of the same turn still reads its own prefix", () => {
    const rows = recorded("fix-add.jsonl")
    let transcript = Transcript.empty
    const snapshots: Array<Activity.Activity> = []
    for (const { event, at } of rows) {
      transcript = Transcript.apply(transcript, event, at)
      if (transcript.activity !== undefined) snapshots.push(transcript.activity)
    }
    const middle = snapshots[Math.floor(snapshots.length / 2)]!
    Activity.model(snapshots.at(-1)!)
    expect(Activity.model(middle)).toEqual(
      traceFromJournal({ runId: "terminal", flowId: "chat", status: middle.status }, middle.records)
    )
  })
})
