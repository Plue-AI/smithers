import { afterAll, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ALARM_MARKER_TABLE } from "../../src/MaintenanceExport"
import { recordRetiredAlarm, retiredDurable, RETIRED_MARKER_KEY } from "../../src/RetiredDurableObject"

const temp = mkdtempSync(join(tmpdir(), "retired-entry-"))
afterAll(() => rmSync(temp, { recursive: true, force: true }))
const THIN = new URL("./testdata/retained-alarm-ack.ts", import.meta.url).pathname
const bundle = async (source: string) => {
  const entry = join(temp, `${crypto.randomUUID()}.ts`)
  writeFileSync(entry, source)
  const built = await Bun.build({ entrypoints: [entry], target: "browser", format: "esm", minify: true })
  expect(built.success).toBe(true)
  return built.outputs[0]!.text()
}
const runWorkerd = async (retired: string) => {
  const child = Bun.spawn(["node", new URL("./retired-workerd.mjs", import.meta.url).pathname], { stdin: new Blob([JSON.stringify({ retired })]), stdout: "pipe", stderr: "pipe" })
  const [code, out, log] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  if (code !== 0) console.error(log)
  expect(code).toBe(0)
  return JSON.parse(out) as { objectId: string; keys: string[]; markers: Array<{ key: string; marker: Record<string, unknown> }> }
}

test("retired owner: 410 for requests, a flushed marker then refusal for alarms, never product storage", async () => {
  const db = new Database(":memory:"), sql = { exec: (q: string, ...b: unknown[]) => { const rows = db.query(q).all(...(b as never[])) as Array<Record<string, unknown>>; return { toArray: () => rows } } }
  let synced = 0
  const ctx = { id: { toString: () => "f".repeat(64) }, storage: { sql, sync: async () => { synced++ } } }
  const Retired = retiredDurable("smithers-mvp-web", "TURN_CANCELS"), object = new Retired(ctx)
  expect((await object.fetch()).status).toBe(410)
  await expect(object.alarm({ retryCount: 0 })).rejects.toThrow("authority_retired")
  await expect(object.alarm({ retryCount: 1 })).rejects.toThrow("authority_retired")
  expect(synced).toBe(2)
  const rows = db.query(`SELECT execution_id, marker FROM ${ALARM_MARKER_TABLE}`).all() as Array<{ execution_id: string; marker: string }>
  expect(rows.map(r => r.execution_id)).toEqual([RETIRED_MARKER_KEY])
  expect(JSON.parse(rows[0]!.marker)).toMatchObject({ schema: "smithers-retired-alarm/v1", state: "interrupted-unresolved", worker: "smithers-mvp-web", binding: "TURN_CANCELS",
    objectId: "f".repeat(64), observations: 2, lastRetryCount: 1 })
  const kv = { id: ctx.id, storage: { get sql(): never { throw new Error("SQL is not enabled") } } }
  expect(recordRetiredAlarm(kv as never, "smithers-mvp-web", "TURN_CANCELS", 0, new Date())).toBeNull()
})

test("real workerd: the pre-fix retained class loses a pending alarm; the retired class preserves it", async () => {
  const thin = await runWorkerd(await bundle(`import { TurnCancelRegistry } from ${JSON.stringify(THIN)}\nexport { TurnCancelRegistry }\nexport default { fetch() { return new Response("edge") } }\n`))
  expect(thin.keys).toEqual(["kept"])
  expect(thin.markers).toEqual([]) // the defect: the fired alarm left nothing behind
  const proposed = await runWorkerd(await bundle(`import { retiredDurable } from ${JSON.stringify(new URL("../../src/RetiredDurableObject.ts", import.meta.url).pathname)}\nexport class TurnCancelRegistry extends retiredDurable("smithers-mvp-web", "TURN_CANCELS") {}\nexport default { fetch() { return new Response("edge") } }\n`))
  expect(proposed.keys).toEqual(["kept"]) // product key-value storage untouched and marker-free
  expect(proposed.markers).toEqual([{ key: "retired", marker: expect.objectContaining({ schema: "smithers-retired-alarm/v1", state: "interrupted-unresolved", binding: "TURN_CANCELS", objectId: proposed.objectId }) }])
}, 120_000)
