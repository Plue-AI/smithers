import { expect, test } from "bun:test"
import { createExternalSessionSeam } from "./ExternalSessionSeam"

const SESSION = "0199aaaa-1111-7222-8333-444455556666"
const OWNER = { login: "will", name: "William Cory" }
const meta = (release = "0.160.0") => `${JSON.stringify({ timestamp: "2026-10-05T18:00:00.000Z", type: "session_meta", payload: { id: SESSION, cwd: "/repo", cli_version: release } })}\n`
const prompt = (second: number, text: string) => `${JSON.stringify({ timestamp: `2026-10-05T18:00:${String(second).padStart(2, "0")}.000Z`, type: "event_msg",
  payload: { type: "item_completed", turn_id: "t1", item: { type: "UserMessage", content: [{ type: "text", text }] } } })}\n`
const bytes = (text: string) => new TextEncoder().encode(text).length
const until = async (check: () => boolean) => { for (let i = 0; i < 200 && !check(); i++) await Bun.sleep(5) }

/** A host serving `file` as GET /api/external/sessions does, at most `limit` bytes of whole lines a read. */
const host = (file: { text: string }, options: { limit?: number; owner?: unknown } = {}) => {
  const asked: string[] = []
  const http = async (path: string) => {
    asked.push(path)
    const offset = Number(new URL(path, "http://host").searchParams.get("offset"))
    const all = new TextEncoder().encode(file.text)
    const window = all.subarray(offset, offset + (options.limit ?? all.length))
    const end = window.lastIndexOf(10) + 1
    const text = new TextDecoder().decode(window.subarray(0, end))
    return Response.json({ agent: "codex", session_id: SESSION, owner: options.owner ?? OWNER, offset, next: offset + end, text, eof: offset + window.length >= all.length })
  }
  return { asked, http }
}
const texts = (source: { get: () => { entries: ReadonlyArray<{ part: unknown }> } }) =>
  source.get().entries.map(entry => (entry.part as { text?: string }).text)

test("decodes the session's lines in the browser, across chunks, asking only from the last offset", async () => {
  const file = { text: meta() + prompt(1, "one") + prompt(2, "two · naïve") }
  const { asked, http } = host(file, { limit: bytes(meta() + prompt(1, "one")) + 4 })
  const seam = createExternalSessionSeam({ http, pollMs: 10 })
  const source = seam.session("codex", "0199aaaa")
  expect(seam.session("codex", "0199aaaa")).toBe(source)
  expect(asked).toEqual([])
  const stop = source.subscribe(() => {})
  await until(() => source.get().entries.length === 2)
  const first = bytes(meta() + prompt(1, "one"))
  // One read runs on to the end: a chunk that is not the end asks again at once.
  expect(asked.slice(0, 2)).toEqual([`/api/external/sessions?agent=codex&session=0199aaaa&offset=0`, `/api/external/sessions?agent=codex&session=0199aaaa&offset=${first}`])
  expect(source.get()).toMatchObject({ agent: "codex", session: "0199aaaa", owner: OWNER, cwd: "/repo" })
  expect(source.get().entries.map(entry => [entry.origin, entry.agent_kind, entry.read_only, entry.session_id, entry.seq])).toEqual([
    ["external", "codex", true, SESSION, 0], ["external", "codex", true, SESSION, 1]])
  expect(texts(source)).toEqual(["one", "two · naïve"])
  // A line the agent is still writing waits; the next poll reads it once it ends.
  file.text += prompt(3, "three").slice(0, 20)
  await Bun.sleep(30)
  expect(texts(source)).toEqual(["one", "two · naïve"])
  file.text += prompt(3, "three").slice(20)
  await until(() => source.get().entries.length === 3)
  expect(texts(source)).toEqual(["one", "two · naïve", "three"])
  stop()
  const after = asked.length
  await Bun.sleep(40)
  expect(asked.length).toBe(after)
  seam.dispose()
})

test("a read missing its owner, or answering another agent, session or offset, stops the import with nothing shown", async () => {
  const cases: Array<[string, (body: Record<string, unknown>) => Record<string, unknown>]> = [
    ["no owner", ({ owner: _, ...body }) => body],
    ["another agent", body => ({ ...body, agent: "claude-code" })],
    ["another session", body => ({ ...body, session_id: "0299aaaa" })],
    ["another offset", body => ({ ...body, offset: 7 })],
    ["next before offset", body => ({ ...body, next: -1 })],
    ["text without bytes", body => ({ ...body, next: 0 })]
  ]
  for (const [name, forge] of cases) {
    const asked: string[] = []
    const source = createExternalSessionSeam({ pollMs: 10, http: async path => {
      asked.push(path)
      const offset = Number(new URL(path, "http://host").searchParams.get("offset"))
      const text = meta() + prompt(1, "forged")
      return Response.json(forge({ agent: "codex", session_id: SESSION, owner: OWNER, offset, next: offset + bytes(text), text, eof: true }))
    } }).session("codex", SESSION)
    source.subscribe(() => {})
    await until(() => source.get().error !== undefined)
    expect(source.get(), name).toMatchObject({ entries: [], error: "The Codex session arrived without its source metadata, so it is not shown." })
    await Bun.sleep(40)
    expect(asked, name).toHaveLength(1)
  }
})

test("a transcript the decoder refuses keeps what came before and says where it stopped", async () => {
  const broken = createExternalSessionSeam({ http: host({ text: `${meta()}${prompt(1, "kept")}{not json\n${prompt(2, "never")}` }).http }).session("codex", SESSION)
  broken.subscribe(() => {})
  await until(() => broken.get().error !== undefined)
  expect(texts(broken)).toEqual(["kept"])
  expect(broken.get().error).toBe("Codex rollout line 3 is not a JSON record.")
  const old = createExternalSessionSeam({ http: host({ text: meta("0.120.0") + prompt(1, "never read") }).http }).session("codex", SESSION)
  old.subscribe(() => {})
  await until(() => old.get().error !== undefined)
  expect(old.get()).toMatchObject({ entries: [], error: "Codex 0.120.0 wrote this rollout; supported: 0.159, 0.160." })
  const headless = createExternalSessionSeam({ http: host({ text: prompt(1, "before its session") }).http }).session("codex", SESSION)
  headless.subscribe(() => {})
  await until(() => headless.get().error !== undefined)
  expect(headless.get()).toMatchObject({ entries: [], error: "Codex rollout line 1 comes before its session record." })
})

test("each host's refusal is the error, in its words; a host without the route says so", async () => {
  for (const body of [{ class: "user", code: "source_not_found", message: "No Codex session ffff on this machine." },
    { error: { code: "source_not_found", message: "No Codex session ffff on this machine." }, status: "error", code: "source_not_found", message: "No Codex session ffff on this machine." }]) {
    const source = createExternalSessionSeam({ http: async () => Response.json(body, { status: 404 }) }).session("codex", "ffff")
    source.subscribe(() => {})
    await until(() => source.get().error !== undefined)
    expect(source.get().error).toBe("No Codex session ffff on this machine.")
  }
  const missing = createExternalSessionSeam({ http: async () => new Response("<html>", { status: 404 }) }).session("codex", "0199")
  missing.subscribe(() => {})
  await until(() => missing.get().error !== undefined)
  expect(missing.get().error).toBe("This host does not serve Codex sessions (404).")
})

test("the live topic reads appended lines at once; the poll waits while the topic serves", async () => {
  const file = { text: meta() + prompt(1, "one") }
  const { asked, http } = host(file)
  const topics = new Map<string, () => void>()
  let serving = true
  const live = {
    subscribe: (topic: string, listener: () => void) => { topics.set(topic, listener); return () => { topics.delete(topic) } },
    getSnapshot: (topic: string) => serving ? { topic, cursor: 1, data: { session_id: SESSION, size: bytes(file.text) } } : { topic, error: "unsupported" }
  }
  const seam = createExternalSessionSeam({ http, live, pollMs: 20 })
  const stop = seam.session("codex", "0199aaaa").subscribe(() => {})
  const source = seam.session("codex", "0199aaaa")
  await until(() => source.get().entries.length === 1)
  expect([...topics.keys()]).toEqual(["external:codex:0199aaaa"])
  file.text += prompt(2, "two")
  await Bun.sleep(60)
  // The topic serves, so no poll read it.
  expect(texts(source)).toEqual(["one"])
  const before = asked.length
  topics.get("external:codex:0199aaaa")!()
  await until(() => source.get().entries.length === 2)
  expect(asked.length).toBe(before + 1)
  // A host whose topic is refused (the test host answers 501 for /api/live) is polled.
  serving = false
  file.text += prompt(3, "three")
  await until(() => source.get().entries.length === 3)
  expect(texts(source)).toEqual(["one", "two", "three"])
  stop()
  expect(topics.size).toBe(0)
  seam.dispose()
})

test("reads asked for while one runs run once after it, never twice over the same lines", async () => {
  const file = { text: meta() + prompt(1, "one") }
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const { asked, http } = host(file)
  const topics: Array<() => void> = []
  const seam = createExternalSessionSeam({ pollMs: 1_000, live: { subscribe: (_, listener) => { topics.push(listener); return () => {} }, getSnapshot: () => undefined },
    http: async path => { if (asked.length === 0) await gate; return http(path) } })
  const source = seam.session("codex", SESSION)
  source.subscribe(() => {})
  topics[0]!(); topics[0]!(); topics[0]!()
  file.text += prompt(2, "two")
  release()
  await until(() => source.get().entries.length === 2)
  await Bun.sleep(20)
  expect(texts(source)).toEqual(["one", "two"])
  expect(asked).toHaveLength(2)
  seam.dispose()
})

test("an unreachable host keeps what arrived and tries again", async () => {
  let calls = 0
  const { http } = host({ text: meta() + prompt(1, "back") })
  const source = createExternalSessionSeam({ pollMs: 10, http: async path => {
    calls++
    if (calls === 1) throw new TypeError("offline")
    return http(path)
  } }).session("codex", SESSION)
  source.subscribe(() => {})
  await until(() => source.get().entries.length === 1)
  expect(source.get().error).toBeUndefined()
  expect(calls).toBeGreaterThan(1)
})

const CLAUDE = "5b2c9e10-4d3a-4f6e-9a1b-7c8d9e0f1a2b"
const claudeRow = (n: number, row: Record<string, unknown>) => `${JSON.stringify({ parentUuid: null, isSidechain: false, uuid: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  timestamp: `2026-10-05T18:00:${String(n).padStart(2, "0")}.000Z`, userType: "external", entrypoint: "cli", cwd: "/Users/ben/repo", sessionId: CLAUDE, version: "2.1.277", ...row })}\n`

test("a Claude Code session decodes with the same seam: a tool call shows once its result arrives", async () => {
  const file = { text: claudeRow(1, { type: "user", promptId: "p1", message: { role: "user", content: "Make the reset link expire after 30 minutes" }, origin: { kind: "human" } }) +
    claudeRow(2, { type: "assistant", message: { role: "assistant", stop_reason: "tool_use", content: [{ type: "text", text: "Running the tests." },
      { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "pnpm test reset-token" } }] } }) }
  const asked: string[] = []
  const seam = createExternalSessionSeam({ pollMs: 10, http: async path => {
    asked.push(path)
    const offset = Number(new URL(path, "http://host").searchParams.get("offset"))
    const all = new TextEncoder().encode(file.text)
    const text = new TextDecoder().decode(all.subarray(offset))
    return Response.json({ agent: "claude-code", session_id: CLAUDE, owner: { login: "ben", name: "Ben Ito" }, offset, next: all.length, text, eof: true })
  } })
  const source = seam.session("claude-code", "5b2c")
  expect(seam.session("codex", "5b2c")).not.toBe(source)
  source.subscribe(() => {})
  await until(() => source.get().entries.length === 2)
  expect(asked[0]).toBe("/api/external/sessions?agent=claude-code&session=5b2c&offset=0")
  expect(source.get().entries.map(entry => [entry.agent_kind, entry.format_version, entry.role, entry.part.type])).toEqual([
    ["claude-code", "claude-code/2.1", "user", "prompt"], ["claude-code", "claude-code/2.1", "assistant", "text"]])
  file.text += claudeRow(3, { type: "user", promptId: "p1", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "Exit code 1\nFAIL reset-token", is_error: true }] } })
  await until(() => source.get().entries.length === 3)
  expect(source.get().entries[2]!.part).toMatchObject({ type: "tool", command: "pnpm test reset-token", status: "error", exit_code: 1 })
  expect(source.get()).toMatchObject({ agent: "claude-code", owner: { login: "ben" } })
  expect(source.get().error).toBeUndefined()
  seam.dispose()
})
