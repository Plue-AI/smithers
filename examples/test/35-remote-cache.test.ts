import { afterAll, expect, it } from "@effect/vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { main, maxEntryBytes, startSharedTier } from "../src/35-remote-cache.ts"

const directory = mkdtempSync(join(tmpdir(), "flows-remote-cache-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

const files = (name: string) => ({
  first: join(directory, `${name}-a.sqlite`),
  second: join(directory, `${name}-b.sqlite`)
})

it("replays a second engine's step from the shared action cache", async () => {
  const summary = await main(files("shared"))
  expect(summary.results).toEqual(["dist/server.js?target=server", "dist/server.js?target=server"])
  // The second engine's database has never seen this step, so the only way it
  // answered without running the body is the shared tier.
  expect(summary.executions).toBe(1)
  expect(summary.acWrites).toBeGreaterThan(0)
  expect(summary.acReads).toBeGreaterThan(0)
  expect(summary.unpublished).toEqual([])
}, 60_000)

it("keeps both runs successful and journals the refusal when publication fails", async () => {
  const summary = await main({ ...files("refused"), refusePublish: true })
  expect(summary.results).toEqual(["dist/server.js?target=server", "dist/server.js?target=server"])
  // Nothing was shareable, so each engine did its own work — and neither run
  // failed because an accelerator was unreachable.
  expect(summary.executions).toBe(2)
  expect(summary.acWrites).toBe(0)
  expect(summary.unpublished).toEqual(["remote-a", "remote-b"])
}, 60_000)

it("answers 400 to a malformed key and 413 to an oversized entry without crashing", async () => {
  const tier = await startSharedTier(false)
  try {
    const malformed = await fetch(`${tier.url}/ac/%E0%A4%A`)
    expect(malformed.status).toBe(400)
    const oversized = await fetch(`${tier.url}/ac/big`, {
      method: "PUT",
      body: new Uint8Array(maxEntryBytes + 1)
    }).then((response) => response.status, () => 413)
    expect(oversized).toBe(413)
    expect(tier.writes()).toBe(0)
    // The tier still serves after both refusals.
    expect((await fetch(`${tier.url}/ac/big`)).status).toBe(404)
    expect((await fetch(`${tier.url}/ac/ok`, { method: "PUT", body: "{}" })).status).toBe(201)
    expect(await (await fetch(`${tier.url}/ac/ok`)).text()).toBe("{}")
  } finally {
    await tier.close()
  }
})
