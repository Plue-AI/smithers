import { afterAll, expect, it } from "bun:test"
import * as Effect from "effect/Effect"
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Spend from "../src/spend.ts"

const roots: Array<string> = []
afterAll(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })))
const fresh = () => {
  const root = mkdtempSync(join(tmpdir(), "tui-spend-"))
  roots.push(root)
  return join(root, "spend")
}
const today = () => new Date().toISOString().slice(0, 10)

it("sums a UTC day across runs and survives a new ledger over the same directory", async () => {
  const root = fresh()
  const first = Spend.ledger(root)
  await Effect.runPromise(first.record({ day: today(), runId: "a", stepKey: "1", spent: 600 }))
  await Effect.runPromise(
    first.record({ day: today(), runId: "a", stepKey: "2", spent: 10, costUsd: 0.5, costSource: "estimated" })
  )
  await Effect.runPromise(first.record({ day: today(), runId: "b", stepKey: "1", spent: 400 }))
  await Effect.runPromise(first.record({ day: "2020-01-01", runId: "old", stepKey: "1", spent: 9 }))
  const second = Spend.ledger(root)
  expect(await Effect.runPromise(second.total(today()))).toBe(1010)
  expect(await Effect.runPromise(second.total("2020-01-01"))).toBe(9)
  expect(await Effect.runPromise(second.total("2019-01-01"))).toBe(0)
  expect([...(await Effect.runPromise(second.run("a")))]).toEqual([["1", { spent: 600 }], ["2", {
    spent: 10,
    costUsd: 0.5
  }]])
})

it("counts a retried record once, and tolerates only a torn final line", async () => {
  const root = fresh()
  const ledger = Spend.ledger(root)
  const entry = { day: today(), runId: "a", stepKey: "1", spent: 5 }
  await Effect.runPromise(ledger.record(entry))
  await Effect.runPromise(ledger.record(entry))
  expect(await Effect.runPromise(ledger.total(today()))).toBe(5)
  appendFileSync(join(root, `${today()}.jsonl`), "{\"day\":")
  expect(await Effect.runPromise(ledger.total(today()))).toBe(5)
  appendFileSync(join(root, `${today()}.jsonl`), "\n{\"day\":\n")
  const failure = await Effect.runPromise(Effect.flip(ledger.total(today())))
  expect(failure).toBeInstanceOf(Error)
})

it("refuses a line that is not a spend record instead of counting zero", async () => {
  const root = fresh()
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, `${today()}.jsonl`), "{\"day\":1}\n")
  await Effect.runPromise(Effect.flip(Spend.ledger(root).total(today())))
  expect(readFileSync(join(root, `${today()}.jsonl`), "utf8")).toBe("{\"day\":1}\n")
})

it.each(["-1", "\"0.5\"", "null"])("refuses a spend record whose USD is %s", async (cost) => {
  const root = fresh()
  mkdirSync(root, { recursive: true })
  writeFileSync(
    join(root, `${today()}.jsonl`),
    `{"day":"${today()}","runId":"a","stepKey":"1","spent":5,"costUsd":${cost}}\n`
  )
  await Effect.runPromise(Effect.flip(Spend.ledger(root).run("a")))
})

it("keeps its directory under the session directory override", () => {
  const before = process.env.SMITHERS_TUI_SESSION_DIR
  process.env.SMITHERS_TUI_SESSION_DIR = "/tmp/x"
  try {
    expect(Spend.directory()).toBe("/tmp/x/spend")
  } finally {
    if (before === undefined) delete process.env.SMITHERS_TUI_SESSION_DIR
    else process.env.SMITHERS_TUI_SESSION_DIR = before
  }
})
