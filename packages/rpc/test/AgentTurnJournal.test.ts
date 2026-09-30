import { describe, expect, test } from "vitest"
import { AgentTurnBatchRejected, agentTurnJournalDigestInput, projectAgentTurnBatch } from "../src/AgentTurnJournal.ts"
import type { AgentTurnBatch, AgentTurnJournalHead } from "../src/AgentTurnJournal.ts"

/*
 * The durable chat journal's admission rule: a batch is accepted only when it
 * extends the committed prefix exactly. Each guard clause gets one batch that
 * breaks it and nothing else.
 */

const hash = (digit: string): string => digit.repeat(64)

const head: AgentTurnJournalHead = {
  version: 1,
  acceptance: {
    version: 1,
    runId: "run-1",
    legId: "leg-1",
    ownerHash: hash("1"),
    accessHash: hash("2"),
    requestHash: hash("3"),
    writerHash: hash("4"),
    acceptedAt: 0,
    hash: hash("5")
  },
  cursor: { version: 1, runId: "run-1", legId: "leg-1", batch: 0, position: 0, hash: hash("6") },
  bytes: 0,
  terminal: false,
  hash: hash("7")
}

const delta = (text: string) => ({ runId: "run-1", type: "delta" as const, kind: "text" as const, text })

const batch: AgentTurnBatch = {
  version: 1,
  runId: "run-1",
  legId: "leg-1",
  batch: 1,
  from: 1,
  previousHash: hash("6"),
  frames: [delta("a"), delta("b")],
  hash: hash("8")
}

const refused = (previous: AgentTurnJournalHead, next: AgentTurnBatch) => () => projectAgentTurnBatch(previous, next)

describe("projectAgentTurnBatch", () => {
  test("a batch that extends the prefix advances the cursor, counts its bytes and stays open", () => {
    const projected = projectAgentTurnBatch(head, batch)
    expect(projected.cursor).toEqual({ ...head.cursor, batch: 1, position: 2, hash: hash("8") })
    expect(projected.bytes).toBeGreaterThan(0)
    expect(projected.terminal).toBe(false)
    expect(projected.acceptance).toBe(head.acceptance)
  })

  test("a done frame last closes the journal", () => {
    const closing = { ...batch, frames: [delta("a"), { runId: "run-1", type: "done" as const }] }
    expect(projectAgentTurnBatch(head, closing).terminal).toBe(true)
  })

  test("refuses a batch number that skips or repeats", () => {
    expect(refused(head, { ...batch, batch: 2 })).toThrow(AgentTurnBatchRejected)
    expect(refused({ ...head, cursor: { ...head.cursor, batch: 1 } }, batch)).toThrow(AgentTurnBatchRejected)
  })

  test("refuses a batch whose first position is not the next one", () => {
    expect(refused(head, { ...batch, from: 2 })).toThrow(AgentTurnBatchRejected)
  })

  test("refuses a batch linked to a different previous hash", () => {
    expect(refused(head, { ...batch, previousHash: hash("9") })).toThrow(AgentTurnBatchRejected)
  })

  test("refuses a batch for another run or another leg", () => {
    expect(refused(head, { ...batch, runId: "run-2" })).toThrow(AgentTurnBatchRejected)
    expect(refused(head, { ...batch, legId: "leg-2" })).toThrow(AgentTurnBatchRejected)
  })

  test("refuses a frame that names another run", () => {
    expect(refused(head, { ...batch, frames: [delta("a"), { ...delta("b"), runId: "run-2" }] })).toThrow(
      AgentTurnBatchRejected
    )
  })

  test("refuses a done frame anywhere but last", () => {
    expect(refused(head, { ...batch, frames: [{ runId: "run-1", type: "done" }, delta("a")] })).toThrow(
      AgentTurnBatchRejected
    )
  })

  test("a refusal is the tagged AgentTurnBatchRejected with its fixed sentence", () => {
    expect(refused(head, { ...batch, batch: 2 })).toThrowError(
      expect.objectContaining({
        _tag: "AgentTurnBatchRejected",
        name: "AgentTurnBatchRejected",
        message: "The turn batch does not extend its accepted prefix."
      })
    )
  })

  test("refuses any batch after the terminal head", () => {
    expect(refused({ ...head, terminal: true }, batch)).toThrow(AgentTurnBatchRejected)
  })
})

describe("agentTurnJournalDigestInput", () => {
  /* Persisted hashes are computed over this exact string; changing it orphans every stored journal. */
  test("pins the v1 domain separation and canonical key order", () => {
    expect(agentTurnJournalDigestInput("batch", { b: 1, a: "x" })).toBe(
      "smithers-agent-turn/batch/v1:{\"a\":\"x\",\"b\":1}"
    )
    expect(agentTurnJournalDigestInput("access", "token")).toBe("smithers-agent-turn/access/v1:\"token\"")
  })
})
