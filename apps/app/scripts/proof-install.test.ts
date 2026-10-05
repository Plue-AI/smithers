import { describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FEATURE_ID, launcherArgs, LOCK_OWNER, parseKeys, ProofLedger, readKeys, redact, releaseLock, takeLock } from "./proof-install"

const gateway = "vck_gateway_0123456789abcdef", cerebras = "csk-cerebras-0123456789", openai = "sk-openai-0123456789abcd"
const scratch = () => mkdtempSync(join(tmpdir(), "proof-install-"))

describe("keys", () => {
  test("reads NAME=value lines with comments, export prefixes and quotes", () => {
    expect(parseKeys(`# proof keys\n\nexport AI_GATEWAY_API_KEY="${gateway}"\nCEREBRAS_API_KEY='${cerebras}'\r\n  OPENAI_API_KEY = ${openai}  \n`))
      .toEqual({ AI_GATEWAY_API_KEY: gateway, CEREBRAS_API_KEY: cerebras, OPENAI_API_KEY: openai })
    // OpenAI is optional; a value may itself hold "=".
    expect(parseKeys(`AI_GATEWAY_API_KEY=${gateway}==\nCEREBRAS_API_KEY=${cerebras}`)).toEqual({ AI_GATEWAY_API_KEY: `${gateway}==`, CEREBRAS_API_KEY: cerebras })
  })
  test("refuses unknown names, repeats, short or spaced values and a missing required key, never echoing a value", () => {
    const cases: Array<[string, RegExp]> = [
      [`AI_GATEWAY_API_KEY=${gateway}`, /no CEREBRAS_API_KEY/],
      [`CEREBRAS_API_KEY=${cerebras}`, /no AI_GATEWAY_API_KEY/],
      [`AI_GATEWAY_API_KEY=${gateway}\nAI_GATEWAY_API_KEY=${gateway}\nCEREBRAS_API_KEY=${cerebras}`, /line 2: AI_GATEWAY_API_KEY appears twice/],
      [`ANTHROPIC_API_KEY=${openai}\nAI_GATEWAY_API_KEY=${gateway}\nCEREBRAS_API_KEY=${cerebras}`, /line 1: expected/],
      [`${gateway}`, /line 1: expected/],
      [`AI_GATEWAY_API_KEY=short\nCEREBRAS_API_KEY=${cerebras}`, /line 1: AI_GATEWAY_API_KEY has no usable value/],
      [`AI_GATEWAY_API_KEY=${gateway} tail\nCEREBRAS_API_KEY=${cerebras}`, /no usable value/],
      [`AI_GATEWAY_API_KEY=""\nCEREBRAS_API_KEY=${cerebras}`, /no usable value/]
    ]
    for (const [text, message] of cases) {
      let error: Error | undefined
      try { parseKeys(text) } catch (caught) { error = caught as Error }
      expect(error?.message).toMatch(message)
      for (const value of [gateway, cerebras, openai, "short"]) expect(error?.message).not.toContain(value)
    }
  })
  test("property: an error never carries any random value it was handed", () => {
    for (let i = 0; i < 300; i++) {
      const value = Array.from({ length: 4 + (i % 40) }, (_, j) => String.fromCharCode(33 + ((i * 31 + j * 7) % 94))).join("")
      const name = ["AI_GATEWAY_API_KEY", "CEREBRAS_API_KEY", "OPENAI_API_KEY", "OTHER_KEY"][i % 4]
      const text = i % 3 === 0 ? `${name}=${value}` : `${name}=${value}\n${name}=${value}`
      try { parseKeys(text) } catch (error) { if (value.length >= 6) expect((error as Error).message).not.toContain(value) }
    }
  })
  test("a keys file others can read is refused", () => {
    const dir = scratch()
    try {
      const path = join(dir, "keys.env")
      writeFileSync(path, `AI_GATEWAY_API_KEY=${gateway}\nCEREBRAS_API_KEY=${cerebras}\n`)
      chmodSync(path, 0o644)
      expect(() => readKeys(path)).toThrow("chmod 600")
      chmodSync(path, 0o600)
      expect(readKeys(path)).toEqual({ AI_GATEWAY_API_KEY: gateway, CEREBRAS_API_KEY: cerebras })
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  test("redact replaces every occurrence of every key, longest first", () => {
    const keys = { AI_GATEWAY_API_KEY: gateway, CEREBRAS_API_KEY: cerebras, OPENAI_API_KEY: `${cerebras}-longer` }
    expect(redact(`a ${gateway} b ${cerebras}-longer c ${cerebras}${gateway}`, keys)).toBe("a <key> b <key> c <key><key>")
    expect(redact("nothing secret", keys)).toBe("nothing secret")
    // A value too short to be a key never rewrites ordinary text.
    expect(redact("the cat", { AI_GATEWAY_API_KEY: "cat" })).toBe("the cat")
  })
})

test("launcher argv names the out dir, the models, the owner and an optional bundle", () => {
  expect(launcherArgs({ out: "/o", models: "real", owner: "maya" })).toEqual(["scripts/run-local-no-github.ts", "--no-browser", "--out=/o", "--models=real", "--owner=maya"])
  expect(launcherArgs({ out: "/o", models: "standin", owner: "maya", bundle: "/b/.native" }).at(-1)).toBe("--bundle=/b/.native")
})

describe("ports lock", () => {
  const lane = "proof-test"
  test("takes a free lock, waits on another holder, and only its holder releases it", async () => {
    const dir = join(scratch(), "ports.lock")
    try {
      await takeLock(dir, { lane, pid: 101 })
      expect(readFileSync(join(dir, "owner"), "utf8")).toMatch(LOCK_OWNER)
      // Another live proof holds it: wait, then give up at the deadline without touching it.
      let clock = 0
      const waits: string[] = []
      await expect(takeLock(dir, { lane, pid: 202, alive: () => true, now: () => clock, sleep: async ms => { clock += ms }, waitMs: 90_000, onWait: owner => waits.push(owner) }))
        .rejects.toThrow("still held: proof proof-test pid 101")
      expect(waits).toHaveLength(3)
      expect(releaseLock(dir, 202)).toBe(false)
      expect(existsSync(dir)).toBe(true)
      expect(releaseLock(dir, 101)).toBe(true)
      expect(existsSync(dir)).toBe(false)
      expect(releaseLock(dir, 101)).toBe(false)
    } finally { rmSync(join(dir, ".."), { recursive: true, force: true }) }
  })
  test("takes over a dead proof holder's lock, never a walk's", async () => {
    const root = scratch(), dir = join(root, "ports.lock")
    try {
      mkdirSync(dir); writeFileSync(join(dir, "owner"), "proof proof-j2 pid 999999 2026-10-05T17:00:00.000Z\n")
      await takeLock(dir, { lane, pid: 303, alive: () => false })
      expect(readFileSync(join(dir, "owner"), "utf8")).toStartWith("proof proof-test pid 303 ")
      releaseLock(dir, 303)
      // A walk's owner line has no proof pid: it is waited for even when no process matches.
      mkdirSync(dir); writeFileSync(join(dir, "owner"), "m4-walk real-GitHub J2 walk started 09:03\n")
      let clock = 0
      await expect(takeLock(dir, { lane, pid: 303, alive: () => false, now: () => clock, sleep: async ms => { clock += ms }, waitMs: 1 }))
        .rejects.toThrow("m4-walk")
      expect(readFileSync(join(dir, "owner"), "utf8")).toStartWith("m4-walk")
      // A lock directory without an owner file (a holder mid-write) is waited for too.
      rmSync(join(dir, "owner"))
      await expect(takeLock(dir, { lane, now: () => clock, sleep: async ms => { clock += ms }, waitMs: 1 })).rejects.toThrow("no owner file")
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  test("two takers race for one lock: exactly one wins each round", async () => {
    const root = scratch(), dir = join(root, "ports.lock")
    try {
      let clock = 0
      const sleep = async (ms: number) => { clock += ms; await new Promise(resolve => setTimeout(resolve, 1)) }
      const order: number[] = []
      const take = async (pid: number) => { await takeLock(dir, { lane, pid, alive: () => true, now: () => clock, sleep, pollMs: 10 }); order.push(pid); await sleep(5); releaseLock(dir, pid) }
      await Promise.all([take(1), take(2), take(3)])
      expect(order.sort()).toEqual([1, 2, 3])
      expect(existsSync(dir)).toBe(false)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})

describe("proof ledger", () => {
  test("ids are feature ids, run once, and a step is blocked by the first need that did not pass", () => {
    const ledger = new ProofLedger()
    for (const bad of ["", "J1-address", "j1_address", "j1--address", "-j1", "j1-", "j1 address"]) expect(() => ledger.begin(bad)).toThrow("not a feature id")
    ledger.begin("j1-address"); ledger.record("j1-address", "passed")
    expect(() => ledger.begin("j1-address")).toThrow("runs twice")
    ledger.begin("j1-github-app"); ledger.record("j1-github-app", "failed")
    ledger.record("j1-sign-in", "blocked")
    expect(ledger.blocker([])).toBeUndefined()
    expect(ledger.blocker(["j1-address"])).toBeUndefined()
    expect(ledger.blocker(["j1-address", "j1-github-app", "j1-sign-in"])).toBe("j1-github-app")
    expect(ledger.blocker(["j1-sign-in"])).toBe("j1-sign-in")
    expect(ledger.blocker(["j1-later"])).toBe("j1-later (not run)")
    expect(ledger.entries).toEqual([["j1-address", "passed"], ["j1-github-app", "failed"], ["j1-sign-in", "blocked"]])
  })
  test("property: FEATURE_ID accepts exactly hyphen-joined lower-case words", () => {
    const alphabet = "ab9-_A ."
    for (let i = 0; i < 2000; i++) {
      let id = ""
      for (let n = i, k = 0; k < 1 + (i % 7); k++, n = Math.floor(n / alphabet.length) + k) id += alphabet[n % alphabet.length]
      const words = id.split("-")
      expect(FEATURE_ID.test(id)).toBe(words.every(word => /^[a-z0-9]+$/.test(word)))
    }
  })
})
