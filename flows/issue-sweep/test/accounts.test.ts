import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { FlowEngine } from "@smthrs/engine"
import { Action, Interpreter } from "@smthrs/flow"
import { Effect, Exit, Layer, ManagedRuntime, Schema } from "effect"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import {
  capacity,
  coolAccount,
  cooldownMinutes,
  cooledPool,
  liveAccounts,
  makeAccountPicker,
  makeReservations,
  parsePool,
  pickAgent,
  type Pool
} from "../accounts.ts"
import {
  ChoosePlacement,
  Input,
  localLimit,
  makePlacementSlots,
  minFreeBytes,
  placementCapacity,
  PlacementChoice
} from "../flow.ts"

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
  assert.deepEqual(
    capacity(
      {
        codex: parsePool("  codex-1       a@b.c     cooling 60m: usage limit\n"),
        claude: parsePool(claudeStatus.replaceAll("ready", "cooling 5m: rate limit"))
      },
      6,
      4
    ),
    {
      _tag: "Exhausted",
      detail:
        "reset accounts: codex-1 (cooling 60m: usage limit), claude-1 (cooling 5m: rate limit), claude-2 (cooling 99849m: manual), claude-4 (cooling 5m: rate limit), claude-7 (cooling 58m: You've hit your weekly limit · resets Oct 1 at 11pm (America/Los_Angeles)), claude-8 (reserved by Freestyle: run-12)"
    }
  )
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

test("local, VM and Cloud reservations share the actual Codex cap with live rotator jobs", () => {
  const picker = makeReservations(3)
  const pools = { codex: { ...pool("codex-1"), active: { "codex-1": 1 } }, claude: none }
  const local = picker.reserve(pools, 2)!
  const cloud = picker.reserve(pools, 3)!
  assert.equal(local.account, "codex-1")
  assert.equal(cloud.account, "codex-1")
  assert.equal(picker.reserve(pools, 4), undefined)
  assert.equal(picker.reserve(pools, 6), undefined)
  local.release()
  local.release()
  const vm = picker.reserve(pools, 4)!
  assert.equal(vm.account, "codex-1")
  assert.equal(picker.reserve(pools, 8), undefined)
  cloud.release()
  vm.release()
  assert.ok(picker.reserve(pools, 10))
  assert.ok(picker.reserve(pools, 11))
  assert.equal(picker.reserve(pools, 12), undefined)
})

test("account selection rotates concrete accounts and sends either agent to any placement", () => {
  const picker = makeReservations(1)
  const pools = { codex: pool("codex-1", "codex-2"), claude: pool("claude-1") }
  assert.equal(picker.reserve(pools, 0)?.account, "codex-1")
  assert.equal(picker.reserve(pools, 1)?.account, "claude-1")
  assert.deepEqual(picker.reserve(pools, 2)?.agent, "codex")
  assert.equal(picker.reserve(pools, 3), undefined)
  assert.equal(picker.reserve({ codex: none, claude: none }, 4), undefined)
})

test("Claude reservations include live work, fall back when a preferred pool is full, and release once", () => {
  const picker = makeReservations(2)
  const pools = {
    codex: { ...pool("codex-1"), active: { "codex-1": 2 } },
    claude: { ...pool("claude-1", "claude-2"), active: { "claude-1": 1, "claude-2": 2 } }
  }
  const vm = picker.reserve(pools, 2)!
  assert.deepEqual([vm.agent, vm.account], ["claude", "claude-1"])
  assert.equal(picker.reserve(pools, 3), undefined)
  vm.release()
  vm.release()
  const cloud = picker.reserve(pools, 4)!
  assert.equal(cloud.account, "claude-1")
  assert.equal(picker.reserve(pools, 5), undefined)
  cloud.release()
  assert.deepEqual(capacity(pools, 2, 8), { _tag: "Available", slots: 1 })
  assert.equal(
    capacity({ codex: pools.codex, claude: { ...pool("claude-2"), active: { "claude-2": 2 } } }, 2, 8)._tag,
    "Exhausted"
  )
})

test("cooling filters the selected model and account scope, keeps expired and other-model slots", () => {
  const input = { ...pool("claude-1", "claude-2", "claude-3", "claude-4"), active: { "claude-4": 1 } }
  const selected = cooledPool(
    input,
    {
      cool: {
        "claude-1": { until: 101 },
        "claude-2@opus": { until: 101 },
        "claude-3@opus": { until: 100 },
        "claude-4@sonnet": { until: 500 }
      }
    },
    "opus",
    100
  )
  assert.deepEqual(selected, {
    ready: ["claude-3", "claude-4"],
    unavailable: [{ label: "claude-1", state: "cooling (claude-1)" }, {
      label: "claude-2",
      state: "cooling (claude-2@opus)"
    }],
    active: { "claude-4": 1 }
  })
  assert.deepEqual(input.ready, ["claude-1", "claude-2", "claude-3", "claude-4"], "the status pool is not mutated")
  assert.deepEqual(cooledPool(input, {}, "opus", 100), input)
  assert.deepEqual(
    cooledPool(pool("codex-1"), { cool: { "codex-1@gpt-6.1-sol": { until: 101 } } }, "gpt-6.1-sol", 100).ready,
    []
  )
})

test("malformed selected cooldown state fails closed; unrelated model state does not block the selected model", () => {
  for (
    const state of [
      null,
      [],
      { cool: null },
      { cool: [] },
      { cool: { "claude-1": null } },
      { cool: { "claude-1@opus": {} } },
      { cool: { "claude-1@opus": { until: "101" } } },
      { cool: { "claude-1@opus": { until: Infinity } } }
    ]
  ) {
    assert.throws(() => cooledPool(pool("claude-1"), state, "opus", 100), /invalid account/)
  }
  assert.deepEqual(cooledPool(pool("claude-1"), { cool: { "claude-1@sonnet": null } }, "opus", 100).ready, ["claude-1"])
})

test("rotator accounting discards dead PIDs and refuses malformed state", () => {
  assert.deepEqual(liveAccounts({ active: { "codex-1": [10, 20, 30], "codex-2": [] } }, (pid) => pid !== 20), {
    "codex-1": 2,
    "codex-2": 0
  })
  assert.deepEqual(liveAccounts({}, () => true), {})
  assert.deepEqual(liveAccounts(null, () => true), {})
  assert.throws(() => liveAccounts({ active: [] }, () => true), /invalid active/)
  assert.throws(() => liveAccounts({ active: { a: [-1] } }, () => true), /invalid account jobs/)
  assert.throws(() => liveAccounts({ active: { a: "10" } }, () => true), /invalid account jobs/)
  assert.deepEqual(capacity({ codex: { ...pool("a"), active: { a: 2 } }, claude: none }, 3, 8), {
    _tag: "Available",
    slots: 1
  })
})

test("account scopes release after failure and cancellation, including cancellation while all accounts are full", async () => {
  const pick = makeAccountPicker(1, Effect.succeed({ codex: pool("codex-1"), claude: none }))
  const first = new AbortController()
  let ready!: () => void
  const started = new Promise<void>((resolve) => {
    ready = resolve
  })
  const held = Effect.runPromiseExit(
    Effect.scoped(Effect.gen(function*() {
      yield* pick(2)
      ready()
      yield* Effect.never
    })),
    { signal: first.signal }
  )
  await started
  const second = new AbortController()
  const waiting = Effect.runPromiseExit(Effect.scoped(pick(3)), { signal: second.signal })
  await new Promise<void>((resolve) => setImmediate(resolve))
  second.abort()
  assert.ok(Exit.isFailure(await waiting))
  first.abort()
  assert.ok(Exit.isFailure(await held))
  const failed = await Effect.runPromiseExit(Effect.scoped(Effect.andThen(pick(4), Effect.fail("failure"))))
  assert.ok(Exit.isFailure(failed))
  const next = await Effect.runPromise(Effect.scoped(pick(6)))
  assert.equal(next.account, "codex-1")
  assert.equal((await Effect.runPromise(Effect.scoped(pick(8)))).account, "codex-1")
})

test("a Claude-only ready pool runs remotely and empty pools fail", async () => {
  const pick = makeAccountPicker(1, Effect.succeed({ codex: none, claude: pool("claude-1") }))
  const result = await Effect.runPromise(Effect.scoped(pick(2)))
  assert.equal(result.agent, "claude")
  assert.equal(result.account, "claude-1")
  const empty = makeAccountPicker(1, Effect.succeed({ codex: none, claude: none }))
  const failed = await Effect.runPromiseExit(Effect.scoped(empty(1)))
  assert.ok(Exit.isFailure(failed))
  if (Exit.isFailure(failed)) assert.match(String(failed.cause), /no ready Codex or Claude account/)
})

test("placement uses local slots first, independent Cloud cap, and replenishes the host first", () => {
  const slots = makePlacementSlots()
  const input = { repo: "o/r", placement: "vm" as const, maxAgents: 2, cloudAgents: 2 }
  const a = slots.reserve(input, minFreeBytes)!
  const b = slots.reserve(input, minFreeBytes)!
  const c = slots.reserve(input, minFreeBytes)!
  const d = slots.reserve(input, minFreeBytes)!
  assert.deepEqual([a, b, c, d].map((s) => s.placement), ["vm", "vm", "cloud", "cloud"])
  assert.equal(slots.reserve(input, minFreeBytes), undefined)
  a.release()
  a.release()
  const e = slots.reserve(input, minFreeBytes)!
  assert.equal(e.placement, "vm")
  assert.equal(slots.reserve(input, minFreeBytes), undefined)
  c.release()
  assert.equal(slots.reserve(input, minFreeBytes)?.placement, "cloud")
})

test("Cloud is disabled by default; VM capacity is capped at 24 and falls to Cloud under disk pressure", () => {
  const slots = makePlacementSlots()
  const local = { repo: "o/r", maxAgents: 1 }
  assert.equal(slots.reserve(local, 0)?.placement, "local")
  assert.equal(slots.reserve(local, 0), undefined)
  const vm = { repo: "o/r", placement: "vm" as const, maxAgents: 32, cloudAgents: 3 }
  assert.equal(localLimit(vm, minFreeBytes), 24)
  assert.equal(localLimit(vm, minFreeBytes - 1), 0)
  const pressure = makePlacementSlots()
  assert.deepEqual(Array.from({ length: 3 }, () => pressure.reserve(vm, minFreeBytes - 1)?.placement), [
    "cloud",
    "cloud",
    "cloud"
  ])
  assert.equal(pressure.reserve(vm, minFreeBytes - 1), undefined)
  assert.equal(makePlacementSlots().reserve({ ...vm, cloudAgents: 0 }, minFreeBytes - 1), undefined)
  const defaults = makePlacementSlots()
  assert.deepEqual(Array.from({ length: 4 }, () => defaults.reserve({ repo: "o/r" }, 0)?.placement), [
    "local",
    "local",
    "local",
    "local"
  ])
  assert.equal(defaults.reserve({ repo: "o/r" }, 0), undefined)
})

test("total sweep capacity allows overflow beyond 32 and keeps every placement bounded by both account pools", () => {
  const pools = { codex: pool("a", "b", "c", "d", "e", "f", "g", "h", "i", "j"), claude: pool("k", "l") }
  assert.deepEqual(
    placementCapacity({ repo: "o/r", placement: "vm", maxAgents: 32, cloudAgents: 40 }, pools, 6, minFreeBytes),
    {
      _tag: "Available",
      slots: 64
    }
  )
  assert.deepEqual(
    placementCapacity(
      { repo: "o/r", maxAgents: 1, cloudAgents: 40 },
      { codex: pool("a"), claude: pool("b", "c") },
      2,
      0
    ),
    {
      _tag: "Available",
      slots: 6
    }
  )
  assert.deepEqual(
    placementCapacity({ repo: "o/r", placement: "vm", maxAgents: 32, cloudAgents: 40 }, pools, 6, minFreeBytes - 1),
    {
      _tag: "Available",
      slots: 40
    }
  )
  assert.deepEqual(
    placementCapacity({ repo: "o/r", maxAgents: 2, cloudAgents: 40 }, { codex: none, claude: pool("a") }, 6, 0),
    {
      _tag: "Available",
      slots: 6
    }
  )
  assert.equal(placementCapacity({ repo: "o/r" }, { codex: none, claude: none }, 6, 0)._tag, "Exhausted")
})

test("Claude-only VM and Cloud capacity is real headroom after live jobs, including disk-pressure fallback", () => {
  const pools = { codex: none, claude: { ...pool("claude-1", "claude-2"), active: { "claude-1": 5, "claude-2": 3 } } }
  assert.deepEqual(
    placementCapacity({ repo: "o/r", placement: "vm", maxAgents: 24, cloudAgents: 8 }, pools, 6, minFreeBytes),
    {
      _tag: "Available",
      slots: 4
    }
  )
  assert.deepEqual(
    placementCapacity({ repo: "o/r", placement: "vm", maxAgents: 24, cloudAgents: 2 }, pools, 6, minFreeBytes - 1),
    {
      _tag: "Available",
      slots: 2
    }
  )
  assert.deepEqual(placementCapacity({ repo: "o/r", placement: "local", maxAgents: 2, cloudAgents: 0 }, pools, 6, 0), {
    _tag: "Available",
    slots: 2
  })
})

test("the sweep payload accepts independent Cloud cap and refuses negatives and non-integers", () => {
  assert.equal(Schema.decodeUnknownSync(Input)({ repo: "o/r", maxAgents: 32, cloudAgents: 100 }).cloudAgents, 100)
  assert.equal(Schema.decodeUnknownSync(Input)({ repo: "o/r", cloudAgents: 0 }).cloudAgents, 0)
  for (const cloudAgents of [-1, 0.5, "2"]) {
    assert.throws(() => Schema.decodeUnknownSync(Input)({ repo: "o/r", cloudAgents }))
  }
})

test("direct account runs retain quota and login cooling without mistaking successful reports for failures", () => {
  assert.equal(cooldownMinutes("", "You've hit your weekly limit", 1), 60)
  assert.equal(cooldownMinutes("", "refresh token expired", 1), 1440)
  assert.equal(cooldownMinutes("out of usage credits", "", 1), 180)
  assert.equal(cooldownMinutes("Fixed the usage limit bug", "", 0), undefined)
  assert.equal(cooldownMinutes("", "rate limit", -1), undefined)
  assert.equal(cooldownMinutes("", "test failed", 1), undefined)
  assert.equal(cooldownMinutes("", "rate limit\n" + "ordinary line\n".repeat(9), 1), undefined)
})

test("direct run cooling invokes the rotator with the exhausted model key, and auth/usage cooling with the account", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "issue-sweep-claude-cool-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const log = join(root, "calls.jsonl")
  for (const name of ["claude-rr", "codex-rr"]) {
    writeFileSync(
      join(root, name),
      `#!${process.execPath}\n` +
        `import{appendFileSync}from'node:fs';appendFileSync(${JSON.stringify(log)},JSON.stringify([${
          JSON.stringify(name)
        },...process.argv.slice(2)])+'\\n');\n`,
      { mode: 0o700 }
    )
  }
  const previous = process.env.PATH
  process.env.PATH = `${root}:${previous ?? ""}`
  t.after(() => {
    if (previous === undefined) delete process.env.PATH
    else process.env.PATH = previous
  })
  await Effect.runPromise(coolAccount("claude", "claude-5", "out of usage credits", "", 1))
  await Effect.runPromise(coolAccount("codex", "codex-1", "switch to another model", "", 1))
  await Effect.runPromise(coolAccount("claude", "claude-5", "", "rate limit", 1))
  await Effect.runPromise(coolAccount("claude", "claude-5", "", "refresh token expired", 1))
  await Effect.runPromise(coolAccount("claude", "claude-5", "Fixed out of usage credits", "", 0))
  assert.deepEqual(readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line)), [
    ["claude-rr", "cool", "claude-5@opus", "180"],
    ["codex-rr", "cool", "codex-1@gpt-6.1-sol", "180"],
    ["claude-rr", "cool", "claude-5", "60"],
    ["claude-rr", "cool", "claude-5", "1440"]
  ])
})

test("a resumed child keeps its journaled Cloud placement even when a local slot becomes free", async (t) => {
  let candidate: "cloud" | "local" = "cloud"
  let choices = 0
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      Interpreter.layer(PlacementChoice),
      ChoosePlacement.toLayer(() =>
        Effect.sync(() => {
          choices++
          return candidate
        })
      )
    ).pipe(
      Layer.provideMerge(Action.layerImplementations),
      Layer.provideMerge(FlowEngine.layerMemory),
      Layer.provideMerge(NodeCrypto.layer)
    )
  )
  t.after(() => runtime.dispose())
  const input = { executionId: "issue-sweep/7/attempt-1" }
  const id = { executionId: `${input.executionId}/placement` }
  assert.equal(await runtime.runPromise(PlacementChoice.execute(input, id)), "cloud")
  candidate = "local"
  const resumed = await runtime.runPromise(PlacementChoice.execute(input, id))
  assert.equal(resumed, "cloud")
  assert.equal(choices, 1)
  const slots = makePlacementSlots()
  const config = { repo: "o/r", maxAgents: 1, cloudAgents: 1 }
  const tentative = slots.reserve(config, 0)!
  assert.equal(tentative.placement, "local")
  tentative.release()
  const saved = slots.reserve(config, 0, resumed)!
  assert.equal(saved.placement, "cloud")
  assert.equal(slots.reserve(config, 0)?.placement, "local")
  assert.equal(slots.reserve(config, 0, resumed), undefined)
  saved.release()
  assert.equal(
    await runtime.runPromise(PlacementChoice.execute({ executionId: "issue-sweep/8/attempt-1" }, {
      executionId: "issue-sweep/8/attempt-1/placement"
    })),
    "local"
  )
  assert.equal(choices, 2)
})
