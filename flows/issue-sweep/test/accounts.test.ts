import assert from "node:assert/strict"
import test from "node:test"
import { capacity, parsePool, pickAgent, type Pool } from "../accounts.ts"

// Verbatim `codex-rr status` and `claude-rr status` output, 2026-09-30.
const codexStatus = `  codex-1       fucory@proton.me         ready
  codex-2       willcory10@gmail.com     ready
> codex-3       willcory10@proton.me     ready
`
const claudeStatus = `drain order: claude-5 > claude-4
  claude-1      fucory@proton.me         ready
  claude-2      willcory10@proton.me     cooling 99849m: manual
> claude-4      will@codeplane.app       ready
  claude-7      willcory10@gmail.com     cooling 58m: You've hit your weekly limit · resets Oct 1 at 11pm (America/Los_Angeles)
  claude-8      will@example.com         reserved by Freestyle: run-12
`
const none: Pool = { ready: [], unavailable: [] }
const pool = (...ready: ReadonlyArray<string>): Pool => ({ ready, unavailable: [] })

test("parsePool reads ready accounts, the next-account marker, and every other state as unavailable", () => {
  assert.deepEqual(parsePool(codexStatus), { ready: ["codex-1", "codex-2", "codex-3"], unavailable: [] })
  assert.deepEqual(parsePool(claudeStatus), {
    ready: ["claude-1", "claude-4"],
    unavailable: [
      { label: "claude-2", state: "cooling 99849m: manual" },
      {
        label: "claude-7",
        state: "cooling 58m: You've hit your weekly limit · resets Oct 1 at 11pm (America/Los_Angeles)"
      },
      { label: "claude-8", state: "reserved by Freestyle: run-12" }
    ]
  })
})

test("parsePool ignores the drain-order header, blank lines and unknown text", () => {
  assert.deepEqual(parsePool("drain order: a > b\n\ncodex-rr: every account is cooling\n"), none)
})

test("capacity gives every ready account the per-account cap, bounded by maxAgents", () => {
  const pools = { codex: pool("codex-1", "codex-2"), claude: pool("claude-1") }
  assert.deepEqual(capacity(pools, 6, 32), { _tag: "Available", slots: 18 })
  assert.deepEqual(capacity(pools, 6, 4), { _tag: "Available", slots: 4 })
  assert.deepEqual(capacity({ codex: none, claude: pool("claude-1") }, 1, 8), { _tag: "Available", slots: 1 })
})

test("capacity is exhausted with every account named when no pool has a ready account", () => {
  assert.deepEqual(capacity({ codex: parsePool("  codex-1       a@b.c     cooling 60m: usage limit\n"), claude: parsePool(claudeStatus.replaceAll("ready", "cooling 5m: rate limit")) }, 6, 4), {
    _tag: "Exhausted",
    detail: "reset accounts: codex-1 (cooling 60m: usage limit), claude-1 (cooling 5m: rate limit), claude-2 (cooling 99849m: manual), claude-4 (cooling 5m: rate limit), claude-7 (cooling 58m: You've hit your weekly limit · resets Oct 1 at 11pm (America/Los_Angeles)), claude-8 (reserved by Freestyle: run-12)"
  })
  assert.deepEqual(capacity({ codex: none, claude: none }, 6, 4), {
    _tag: "Exhausted",
    detail: "reset accounts: no signed-in accounts"
  })
})

test("pickAgent splits issues by parity and moves to the other pool when one is empty", () => {
  const both = { codex: pool("codex-1"), claude: pool("claude-1") }
  assert.equal(pickAgent(3266, both), "codex")
  assert.equal(pickAgent(3265, both), "claude")
  assert.equal(pickAgent(3266, { codex: none, claude: pool("claude-1") }), "claude")
  assert.equal(pickAgent(3265, { codex: pool("codex-1"), claude: none }), "codex")
  assert.equal(pickAgent(3265, { codex: none, claude: none }), undefined)
})
