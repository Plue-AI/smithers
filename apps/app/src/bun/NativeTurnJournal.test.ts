import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TURN_PATH, TURN_REPLAY_PATH, TURN_RETIRE_PATH, TURN_ERASE_PATH } from "@smthrs/rpc/AgentApiRoutes"
import { AgentTurnJournalDeliverySchema, agentTurnJournalDigestInput } from "@smthrs/rpc/AgentTurnJournal"
import type { AgentTurnCursor } from "@smthrs/rpc/AgentTurnJournal"
import { LOCAL_SESSION_HEADER } from "@smthrs/rpc/LocalSession"
import { fakeBackend, signedInKeychain } from "./fixtures/FakeBackendTurns"
import { startLocalServer } from "./server"
import type { LocalServer } from "./server"

const journal = { version: 1 as const, legId: "native-leg", token: "native_private_capability_12345678901234567890" }
const turn = { runId: "native-turn", instructions: "Briefly.", messages: [{ role: "user", content: "hello" }], journal }
const access = { runId: turn.runId, journal }
const post = (host: LocalServer, path: string, body: unknown, token = host.sessionToken) => fetch(`${host.origin}${path}`, {
  method: "POST", headers: { "content-type": "application/json", [LOCAL_SESSION_HEADER]: token }, body: JSON.stringify(body)
})
const fixture = async (upstream: () => Response) => {
  const root = await mkdtemp(join(tmpdir(), "smithers-native-journal-"))
  await writeFile(join(root, "index.html"), "<!doctype html><title>Test</title>")
  let calls = 0
  const model = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: fakeBackend(() => { calls++; return upstream() }) })
  const hosts: LocalServer[] = []
  const boot = async (persist = true) => {
    const host = await startLocalServer({
      port: 0, distDir: root, home: root, ...(persist ? { stateDir: join(root, "state") } : {}),
      cloudMode: "hybrid", cloudApi: `http://127.0.0.1:${model.port}`, cloudKeychain: signedInKeychain(), identityUpstream: null,
      log: () => {}
    })
    hosts.push(host)
    return host
  }
  return { root, boot, calls: () => calls, close: async () => {
    await Promise.all(hosts.map(host => host.stop()))
    await model.stop(true)
    await rm(root, { force: true, recursive: true })
  } }
}
const readOutput = async (response: Response) => {
  expect(response.status).toBe(200)
  const lines = (await response.text()).trim().split("\n").map(line => AgentTurnJournalDeliverySchema.parse(JSON.parse(line)))
  return lines.flatMap(line => line.type === "batch" ? line.batch.frames : [])
}

describe("native durable chat over the actual authenticated local router", () => {
  test("a pinned SQLite reader keeps erasure pending until retained WAL bytes are removed", async () => {
    const privateMarker = "private-native-wal-retirement-fixture"
    const f = await fixture(() => new Response([
      { type: "delta", kind: "text", text: privateMarker }, { type: "done", reason: "stop" }
    ].map(frame => JSON.stringify(frame)).join("\n")))
    let observer: Database | undefined
    try {
      const host = await f.boot()
      await readOutput(await post(host, TURN_PATH, turn))
      const path = join(f.root, "state/chat-journal/turns.sqlite")
      observer = new Database(path, { readonly: true })
      observer.exec("BEGIN")
      observer.query("SELECT * FROM turn_storage").all()
      const retirementProof = createHash("sha256").update(agentTurnJournalDigestInput("access", journal.token)).digest("hex")
      const erasure = { runId: turn.runId, legId: journal.legId, retirementProof }
      const pending = await post(host, TURN_ERASE_PATH, erasure)
      expect(pending.status).toBe(503)
      expect(await pending.json()).toMatchObject({ status: "error", code: "storage_failed" })
      expect((await readFile(`${path}-wal`)).includes(Buffer.from(privateMarker))).toBe(true)
      expect((await post(host, TURN_REPLAY_PATH, access)).status).toBe(410)
      observer.exec("ROLLBACK")
      observer.close()
      observer = undefined
      const complete = await post(host, TURN_ERASE_PATH, erasure)
      expect(complete.status).toBe(200)
      expect(await complete.json()).toEqual({ status: "retired" })
      expect((await readFile(`${path}-wal`)).byteLength).toBe(0)
      expect((await readFile(path)).includes(Buffer.from(privateMarker))).toBe(false)
      expect((await post(host, TURN_PATH, turn)).status).toBe(410)
      expect(f.calls()).toBe(1)
    } finally {
      observer?.exec("ROLLBACK")
      observer?.close()
      await f.close()
    }
  })
  test("delete-only erasure before acceptance survives restart and cannot be undone by a delayed request", async () => {
    const f = await fixture(() => new Response('"unused"'))
    try {
      const first = await f.boot()
      const retirementProof = createHash("sha256").update(agentTurnJournalDigestInput("access", journal.token)).digest("hex")
      expect((await post(first, TURN_ERASE_PATH, { runId: turn.runId, legId: journal.legId, retirementProof })).status).toBe(200)
      await first.stop()
      const second = await f.boot()
      expect((await post(second, TURN_PATH, turn)).status).toBe(410)
      expect(f.calls()).toBe(0)
    } finally { await f.close() }
  })
  test("file SQLite survives host restart and replays >1000 frames without inference; erasure prevents reuse", async () => {
    const wire = [...Array.from({ length: 1005 }, (_, index) => ({ type: "delta", kind: "text", text: `private-native-${index}` })), { type: "done", reason: "stop" }]
    const f = await fixture(() => new Response(wire.map(frame => JSON.stringify(frame)).join("\n")))
    try {
      const first = await f.boot()
      const live = await readOutput(await post(first, TURN_PATH, turn))
      expect(live.length).toBe(1006)
      expect(f.calls()).toBe(1)
      const competing = await f.boot()
      expect((await post(competing, TURN_REPLAY_PATH, access)).status).toBe(503)
      await competing.stop()
      await first.stop()
      const second = await f.boot()
      const staleSession = await post(second, TURN_REPLAY_PATH, access, first.sessionToken)
      expect(staleSession.status).toBe(401)
      expect((await post(second, TURN_REPLAY_PATH, { ...access, journal: { ...journal, token: "wrong_private_capability_12345678901234567890" } })).status).toBe(403)
      const replay: unknown[] = []
      let after: AgentTurnCursor | null = null
      let more = true
      while (more) {
        const response = await post(second, TURN_REPLAY_PATH, { ...access, after })
        expect(response.status).toBe(200)
        const page = await response.json() as any
        replay.push(...page.batches.flatMap((batch: any) => batch.frames))
        after = page.next
        more = page.more
      }
      expect(replay).toEqual(live)
      expect(await (await post(second, TURN_PATH, turn)).json()).toMatchObject({ status: "existing", terminal: true })
      expect(f.calls()).toBe(1)
      expect((await post(second, TURN_RETIRE_PATH, access)).status).toBe(200)
      expect((await post(second, TURN_REPLAY_PATH, access)).status).toBe(410)
      await second.stop()
      const third = await f.boot()
      expect((await post(third, TURN_PATH, turn)).status).toBe(410)
      expect(f.calls()).toBe(1)
      await third.stop()
      const db = new Database(join(f.root, "state/chat-journal/turns.sqlite"), { readonly: true })
      try {
        const rows = db.query<{ value: string }, []>("SELECT value FROM turn_storage").all()
        expect(rows).toHaveLength(1)
        expect(rows[0]!.value).not.toContain("private-native")
        expect(rows[0]!.value).toContain('"retired":true')
      } finally { db.close() }
    } finally { await f.close() }
  }, 20_000)

  test("shutdown records interruption before closing storage and restart never takes over the producer", async () => {
    const f = await fixture(() => new Response(new ReadableStream<Uint8Array>({ start(controller) {
      for (let index = 0; index < 64; index++) controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ type: "delta", kind: "text", text: `partial-${index}` })}\n`))
    } })))
    try {
      const first = await f.boot()
      const response = await post(first, TURN_PATH, turn)
      const reader = response.body!.getReader()
      // Drain through the committed partial batch before closing the host.
      let text = ""
      while (!text.includes('"type":"batch"')) text += new TextDecoder().decode((await reader.read()).value)
      await first.stop()
      await reader.cancel().catch(() => {})
      const second = await f.boot()
      const page = await (await post(second, TURN_REPLAY_PATH, access)).json() as any
      expect(page.terminal).toBe(true)
      expect(page.batches.flatMap((batch: any) => batch.frames).at(-1)).toMatchObject({ type: "done", error: expect.stringContaining("ended before") })
      expect(await (await post(second, TURN_PATH, turn)).json()).toMatchObject({ status: "existing", terminal: true })
      expect(f.calls()).toBe(1)
    } finally { await f.close() }
  }, 20_000)

  test("missing persistent storage refuses before invoking the model", async () => {
    const f = await fixture(() => new Response('"unused"'))
    try {
      const host = await f.boot(false)
      expect((await post(host, TURN_PATH, turn)).status).toBe(503)
      expect(f.calls()).toBe(0)
    } finally { await f.close() }
  })
})
