import { describe, expect, spyOn, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TURN_PATH, TURN_REPLAY_PATH } from "@smthrs/rpc/AgentApiRoutes"
import { AgentTurnJournalDeliverySchema, AgentTurnJournalHeadSchema, AgentTurnJournalReplySchema } from "@smthrs/rpc/AgentTurnJournal"
import { LOCAL_SESSION_HEADER } from "@smthrs/rpc/LocalSession"
import { createAppStore } from "../mainview/state/AppStore"
import { fakeBackend, signedInKeychain } from "./fixtures/FakeBackendTurns"
import { startLocalServer } from "./server"
import type { LocalServer } from "./server"

const journal = { version: 1 as const, legId: "killed-host-leg", token: "synthetic_crash_capability_12345678901234567890" }
const turn = { runId: "killed-host-turn", instructions: "Fixture only.", messages: [{ role: "user", content: "hello" }], journal }
const post = (origin: string, token: string, path: string, body: unknown) => fetch(`${origin}${path}`, {
  method: "POST", headers: { "content-type": "application/json", [LOCAL_SESSION_HEADER]: token }, body: JSON.stringify(body)
})
const nextLine = (stream: ReadableStream<Uint8Array>) => {
  const reader = stream.getReader(), decoder = new TextDecoder()
  let pending = ""
  return async (): Promise<string> => {
    while (true) {
      const newline = pending.indexOf("\n")
      if (newline !== -1) { const line = pending.slice(0, newline); pending = pending.slice(newline + 1); return line }
      const next = await reader.read()
      if (next.done) throw new Error("Crash fixture closed before its expected receipt")
      pending += decoder.decode(next.value, { stream: true })
    }
  }
}

describe("native HTTP journal survives an actual killed writer", () => {
  test("SIGKILL after durable acceptance but before inference expires the orphan without starting a second producer", async () => {
    const root = await mkdtemp(join(tmpdir(), "smithers-killed-before-inference-"))
    await writeFile(join(root, "index.html"), "<!doctype html><title>Crash fixture</title>")
    let calls = 0
    const model = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: fakeBackend(() => {
      calls++
      return new Response("unexpected inference", { status: 500 })
    }) })
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/NativeTurnJournalCrashHost.ts"), root,
      `http://127.0.0.1:${model.port}`, "before-inference"], { stdout: "pipe", stderr: "pipe" })
    const stderr = new Response(child.stderr).text()
    const receipt = nextLine(child.stdout)
    let reopened: LocalServer | undefined
    let restoreClock: (() => void) | undefined
    try {
      const ready = JSON.parse(await receipt()) as { type: string; origin: string; token: string }
      expect(ready.type).toBe("ready")
      // The callback blocks the child event loop, so the POST cannot return.
      void post(ready.origin, ready.token, TURN_PATH, turn).catch(() => undefined)
      expect(JSON.parse(await receipt())).toEqual({ type: "boundary" })
      child.kill("SIGKILL")
      await child.exited
      expect(child.signalCode).toBe("SIGKILL")
      expect(await stderr).toBe("")
      expect(calls).toBe(0)

      const db = new Database(join(root, "state", "chat-journal", "turns.sqlite"), { readonly: true })
      const row = db.query<{ value: string }, [string]>("SELECT value FROM turn_storage WHERE key = ?").get("turn-journal:v1:head")
      db.close()
      const head = AgentTurnJournalHeadSchema.parse(JSON.parse(row?.value ?? "null"))
      expect(head.acceptance.runId).toBe(turn.runId)
      expect(head.acceptance.legId).toBe(journal.legId)
      expect(head.cursor.batch).toBe(0)
      expect(head.terminal).toBe(false)

      reopened = await startLocalServer({ port: 0, distDir: root, home: root, stateDir: join(root, "state"),
        cloudMode: "hybrid", cloudApi: `http://127.0.0.1:${model.port}`, cloudKeychain: signedInKeychain(), identityUpstream: null,
        log: () => {} })
      expect((await post(reopened.origin, ready.token, TURN_REPLAY_PATH, { runId: turn.runId, journal })).status).toBe(401)
      const initial = await post(reopened.origin, reopened.sessionToken, TURN_REPLAY_PATH, { runId: turn.runId, journal })
      expect(initial.status).toBe(200)
      const firstPage = AgentTurnJournalReplySchema.parse(await initial.json())
      if (firstPage.status !== "ok") throw new Error("Expected the accepted orphan")
      expect(firstPage.terminal).toBe(false)
      expect(firstPage.batches).toEqual([])
      expect(firstPage.head).toEqual(head.cursor)

      const clock = spyOn(Date, "now").mockImplementation(() => head.acceptance.acceptedAt + 15 * 60 * 1000 + 1)
      restoreClock = () => clock.mockRestore()
      const expired = await post(reopened.origin, reopened.sessionToken, TURN_REPLAY_PATH, { runId: turn.runId, journal })
      expect(expired.status).toBe(200)
      const finalPage = AgentTurnJournalReplySchema.parse(await expired.json())
      if (finalPage.status !== "ok") throw new Error("Expected a terminal replay")
      expect(finalPage.terminal).toBe(true)
      expect(finalPage.batches).toHaveLength(1)
      const done = finalPage.batches[0]?.frames[0]
      if (done?.type !== "done") throw new Error("Expected a recorded terminal failure")
      if (typeof done.error !== "string") throw new Error("Expected a terminal error message")
      expect(done.error.length).toBeGreaterThan(0)
      const duplicate = await post(reopened.origin, reopened.sessionToken, TURN_PATH, turn)
      expect(duplicate.status).toBe(200)
      expect(await duplicate.json()).toEqual({ status: "existing", cursor: finalPage.head, terminal: true })
      expect(calls).toBe(0)
    } finally {
      restoreClock?.()
      child.kill("SIGKILL")
      await child.exited
      await reopened?.stop()
      await model.stop(true)
      await rm(root, { recursive: true, force: true })
    }
  }, 20_000)

  for (const boundary of ["acceptance", "batch"] as const) test(`SIGKILL after committed ${boundary} preserves the prefix and never replaces inference`, async () => {
    const root = await mkdtemp(join(tmpdir(), "smithers-killed-turn-"))
    await writeFile(join(root, "index.html"), "<!doctype html><title>Crash fixture</title>")
    let calls = 0
    const frames = Array.from({ length: 64 }, (_, index) => ({ runId: turn.runId, type: "delta", kind: "text", text: `part-${index};` }))
    const model = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, fetch: fakeBackend(() => {
      calls++
      return new Response(new ReadableStream<Uint8Array>({ start(controller) {
        if (boundary === "batch") controller.enqueue(new TextEncoder().encode(frames.map(frame => JSON.stringify(frame)).join("\n") + "\n"))
        // Remain live: there is deliberately no terminal frame or clean EOF.
      } }))
    }) })
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/NativeTurnJournalCrashHost.ts"), root,
      `http://127.0.0.1:${model.port}`, boundary], { stdout: "pipe", stderr: "pipe" })
    const stderr = new Response(child.stderr).text()
    const receipt = nextLine(child.stdout)
    const bytes = new Map<string, string>()
    const store = await createAppStore({ kind: "localStorage", storage: {
      getItem: key => bytes.get(key) ?? null,
      setItem: (key, value) => { bytes.set(key, value) },
      removeItem: key => { bytes.delete(key) }
    } })
    let reopened: LocalServer | undefined
    let response: Response | undefined
    try {
      const ready = JSON.parse(await receipt()) as { type: string; origin: string; token: string }
      expect(ready.type).toBe("ready")
      await store.dispatch({ type: "http.turn.started", actor: "user", turnId: turn.runId, attemptId: "attempt", text: "hello", retry: false, journal }).isPersisted.promise
      response = await post(ready.origin, ready.token, TURN_PATH, turn)
      expect(response.status).toBe(200)
      const visible = nextLine(response.body!)
      const accepted = AgentTurnJournalDeliverySchema.parse(JSON.parse(await visible()))
      if (accepted.type !== "accepted") throw new Error("Expected acceptance before any output")
      await store.dispatch({ type: "http.leg.accepted", actor: "system", attemptId: "attempt", legId: journal.legId, cursor: accepted.cursor }).isPersisted.promise
      const cut = JSON.parse(await receipt()) as { type: string; delivery: unknown }
      expect(cut.type).toBe("boundary")
      const committed = AgentTurnJournalDeliverySchema.parse(cut.delivery)
      expect(committed.type).toBe(boundary === "acceptance" ? "accepted" : "batch")
      // The owned child is killed while its gate still holds any output batch.
      child.kill("SIGKILL")
      await child.exited
      expect(child.signalCode).toBe("SIGKILL")
      await expect(visible()).rejects.toThrow()
      expect(await stderr).toBe("")
      expect(calls).toBe(1)
      expect(store.collections.httpTurnLegs.get(journal.legId)?.cursor).toEqual(accepted.cursor)

      reopened = await startLocalServer({ port: 0, distDir: root, home: root, stateDir: join(root, "state"),
        cloudMode: "hybrid", cloudApi: `http://127.0.0.1:${model.port}`, cloudKeychain: signedInKeychain(), identityUpstream: null,
        log: () => {} })
      expect((await post(reopened.origin, ready.token, TURN_REPLAY_PATH, { runId: turn.runId, journal })).status).toBe(401)
      const replay = await post(reopened.origin, reopened.sessionToken, TURN_REPLAY_PATH, { runId: turn.runId, journal, after: accepted.cursor })
      expect(replay.status).toBe(200)
      const page = AgentTurnJournalReplySchema.parse(await replay.json())
      if (page.status !== "ok") throw new Error("Expected verified committed replay")
      expect(page.terminal).toBe(false) // Before deadline, replay does not infer producer death.
      expect(page.more).toBe(false)
      expect(page.batches).toEqual(committed.type === "batch" ? [committed.batch] : [])
      expect(page.head).toEqual(committed.cursor)
      for (const batch of page.batches) await store.dispatch({ type: "http.turn.batch.received", actor: "system", attemptId: "attempt", legId: journal.legId, batch }).isPersisted.promise
      expect(store.collections.httpTurnLegs.get(journal.legId)?.cursor).toEqual(page.head)
      const answer = store.collections.messages.get(`message-${turn.runId}-smithers`)?.text ?? ""
      expect(answer).toBe(boundary === "batch" ? frames.map(frame => frame.text).join("") : "")
      // A repeated delivery is a no-op in the actual frontend projector.
      for (const batch of page.batches) await store.dispatch({ type: "http.turn.batch.received", actor: "system", attemptId: "attempt", legId: journal.legId, batch }).isPersisted.promise
      expect(store.collections.messages.get(`message-${turn.runId}-smithers`)?.text ?? "").toBe(answer)
      expect((await store.verifyState()).valid).toBe(true)
      const duplicate = await post(reopened.origin, reopened.sessionToken, TURN_PATH, turn)
      expect(duplicate.status).toBe(200)
      expect(await duplicate.json()).toEqual({ status: "existing", cursor: page.head, terminal: false })
      expect((await post(reopened.origin, reopened.sessionToken, TURN_PATH, { ...turn, instructions: "replacement inference" })).status).toBe(409)
      expect(calls).toBe(1)
      const caughtUp = await post(reopened.origin, reopened.sessionToken, TURN_REPLAY_PATH, { runId: turn.runId, journal, after: page.head })
      expect(await caughtUp.json()).toMatchObject({ status: "ok", batches: [], next: page.head, terminal: false, more: false })
    } finally {
      child.kill("SIGKILL")
      await child.exited
      await response?.body?.cancel().catch(() => {})
      await reopened?.stop()
      await store.dispose?.()
      await model.stop(true)
      await rm(root, { recursive: true, force: true })
    }
  }, 20_000)
})
