/** The mock's remaining moments: memory rows, parks and backups in a peek, the cap's Raise, and the POC lane. */
import { expect, it } from "bun:test"
import * as Inbox from "../src/inbox.ts"
import * as Subagents from "../src/subagents.ts"
import * as Tabs from "../src/tabs.ts"
import * as Transcript from "../src/transcript.ts"
import type { Tab } from "../src/workspace.ts"

const now = new Date(2026, 8, 28, 14, 0).getTime()
const tab = (id: string, status: Tab["status"], extra: Partial<Tab> = {}): Tab => ({
  id,
  title: id,
  prompt: id,
  depth: 1,
  seat: "openai:gpt-6-sol",
  file: `/tmp/${id}.jsonl`,
  status,
  startedAt: now - 60_000,
  ...extra
})
const event = (value: object) => value as Parameters<typeof Transcript.apply>[1]

it("writes a row for what entered the window, once per new set, and none for a reading that let nothing in", () => {
  const item = (id: string) => ({ kind: "memory", id, digest: id, p: 0.1 })
  const read = (source: string, kept: ReadonlyArray<string>, withheld: ReadonlyArray<string>) =>
    event({ _tag: "relevance-settled", source, kept: kept.map(item), withheld: withheld.map(item) })
  let transcript = Transcript.empty
  for (
    const each of [
      read("run", ["a"], []),
      read("supervisor", ["b", "c"], ["d"]),
      // The supervisor asks again about the same rows: no new row.
      read("supervisor", ["b", "c"], ["d"]),
      read("supervisor", [], ["d"]),
      read("recall", ["e"], ["f", "g"])
    ]
  ) transcript = Transcript.apply(transcript, each, now)
  expect(transcript.items.filter((each) => each.kind === "note").map((each) => each.text)).toEqual([
    "→ context 1 in · 0 withheld",
    "→ memory 2 in · 1 withheld",
    "→ memory 1 in · 2 withheld"
  ])
})

it("peeks at a park with its reset and count, a backup seat, and a failure with whose fault it is", () => {
  const row = (worker: Tab) => ({
    key: worker.id,
    group: "needs" as const,
    level: 0,
    worker,
    status: worker.status,
    name: "x",
    seat: "sol",
    clock: ""
  })
  expect(
    Inbox.peek(
      row(
        tab("p", "parked", {
          wakeAt: new Date(2026, 8, 28, 14, 5).getTime(),
          parks: 3,
          activeSeat: "openai:gpt-6.1-sol"
        })
      ),
      () => Transcript.empty
    )
  )
    .toEqual(["parked · resets 14:05 · 3/8", "sol → sol"])
  expect(
    Inbox.peek(
      row(
        tab("f", "failed", {
          failure: { headline: "Token budget reached", fault: "infra", line: "200 of 200 tokens used.", actions: [] }
        })
      ),
      () => Transcript.empty
    )
  )
    .toEqual(["Token budget reached · not your fault · infra", "200 of 200 tokens used."])
})

it("offers Raise cap on a worker stopped at its run cap, and nowhere else", () => {
  const capped = tab("c", "failed", {
    failure: { headline: "Token budget reached", fault: "infra", line: "", actions: [] }
  })
  // First, so it fits a narrow card before Resume and Switch model.
  expect(Tabs.actions(capped).map((action) => [action.id, action.keys[0], action.label])[0]).toEqual([
    "raise",
    "a",
    "Raise cap"
  ])
  expect(Tabs.actions(tab("r", "running")).map((action) => action.id)).not.toContain("raise")
})

it("splits a worker's lanes when one of its children is a POC lane", () => {
  const tabs = [
    tab("plan", "running"),
    tab("impl", "running", { parent: "plan" }),
    tab("poc", "running", { parent: "plan", agent: { name: "coding/poc" } }),
    tab("mock", "running", { parent: "poc" })
  ]
  expect(Subagents.lanes(tabs, "plan")).toEqual({ implement: [tabs[0]!, tabs[1]!], poc: [tabs[2]!, tabs[3]!] })
  expect(Subagents.lanes(tabs, "impl")).toBeUndefined()
})
