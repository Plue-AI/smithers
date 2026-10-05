import { expect, test } from "bun:test"
import { createExternalSessionSeam } from "./ExternalSessionSeam"

const SESSION = "0199aaaa-1111-7222-8333-444455556666"
const entry = (seq: number, text: string) => ({ origin: "external", agent_kind: "codex", format_version: "codex-rollout/0.160", session_id: SESSION,
  source_id: `${SESSION}:${seq + 2}`, read_only: true, seq, at: 1_000 + seq, turn_id: "t1", role: "user", part: { type: "prompt", text } })
const body = (entries: unknown[], next: number, extra: Record<string, unknown> = {}) =>
  ({ session_id: SESSION, format_version: "codex-rollout/0.160", cwd: "/repo", owner: { login: "will", name: "William Cory" }, entries, next, ...extra })
const until = async (check: () => boolean) => { for (let i = 0; i < 200 && !check(); i++) await Bun.sleep(5) }

/** A host double that answers each read from a queue and records what was asked. */
const host = (answers: Array<{ status?: number; json: unknown }>) => {
  const asked: string[] = []
  const http = async (path: string) => {
    asked.push(path)
    const answer = answers.shift() ?? { json: body([], 2) }
    return new Response(JSON.stringify(answer.json), { status: answer.status ?? 200 })
  }
  return { asked, http }
}

test("reads while subscribed, asks only for what is new, and appends it", async () => {
  const { asked, http } = host([{ json: body([entry(0, "one"), entry(1, "two")], 2) }, { json: body([entry(2, "three")], 3) }])
  const seam = createExternalSessionSeam({ http, pollMs: 10 })
  const source = seam.session("0199aaaa")
  expect(seam.session("0199aaaa")).toBe(source)
  expect(asked).toEqual([])
  const stop = source.subscribe(() => {})
  await until(() => source.get().entries.length === 3)
  expect(asked.slice(0, 2)).toEqual(["/api/external/codex?session=0199aaaa&since=0", "/api/external/codex?session=0199aaaa&since=2"])
  expect(source.get()).toMatchObject({ session: "0199aaaa", owner: { login: "will", name: "William Cory" }, cwd: "/repo" })
  expect(source.get().entries.map(each => each.part)).toEqual([{ type: "prompt", text: "one" }, { type: "prompt", text: "two" }, { type: "prompt", text: "three" }])
  stop()
  const after = asked.length
  await Bun.sleep(40)
  expect(asked.length).toBe(after)
  seam.dispose()
})

test("an entry without its read-only mark stops the import with a visible error and nothing undecoded", async () => {
  const { asked, http } = host([{ json: body([{ ...entry(0, "forged"), read_only: false }], 1) }])
  const source = createExternalSessionSeam({ http, pollMs: 10 }).session(SESSION)
  source.subscribe(() => {})
  await until(() => source.get().error !== undefined)
  expect(source.get()).toMatchObject({ entries: [], error: "The Codex session arrived without its source metadata, so it is not shown." })
  await Bun.sleep(40)
  expect(asked).toHaveLength(1)
})

test("the host's refusal is the error, in its words", async () => {
  const { http } = host([{ status: 404, json: { error: { code: "source_not_found", message: "No Codex session ffff on this machine." } } }])
  const source = createExternalSessionSeam({ http }).session("ffff")
  source.subscribe(() => {})
  await until(() => source.get().error !== undefined)
  expect(source.get().error).toBe("No Codex session ffff on this machine.")
})

test("a host without the route says so; a decode error keeps what arrived", async () => {
  const missing = createExternalSessionSeam({ http: async () => new Response("<html>", { status: 404 }) }).session("0199")
  missing.subscribe(() => {})
  await until(() => missing.get().error !== undefined)
  expect(missing.get().error).toBe("This host does not serve Codex sessions (404).")
  const { http } = host([{ json: body([entry(0, "kept")], 1, { error: { code: "malformed_record", message: "Codex rollout line 3 is not a JSON record." } }) }])
  const broken = createExternalSessionSeam({ http }).session(SESSION)
  broken.subscribe(() => {})
  await until(() => broken.get().error !== undefined)
  expect(broken.get()).toMatchObject({ entries: [{ part: { text: "kept" } }], error: "Codex rollout line 3 is not a JSON record." })
})

test("an unreachable host keeps what arrived and tries again", async () => {
  let calls = 0
  const source = createExternalSessionSeam({ pollMs: 10, http: async () => {
    calls++
    if (calls === 1) throw new TypeError("offline")
    return new Response(JSON.stringify(body([entry(0, "back")], 1)))
  } }).session(SESSION)
  source.subscribe(() => {})
  await until(() => source.get().entries.length === 1)
  expect(source.get().error).toBeUndefined()
  expect(calls).toBeGreaterThan(1)
})
