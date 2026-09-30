import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, expect, it } from "vitest"

const directories: Array<string> = []
const database = () => {
  const directory = mkdtempSync(join(tmpdir(), "smithers-integrations-control-"))
  directories.push(directory)
  return join(directory, "control.db")
}
const fixture = fileURLToPath(new URL("./fixtures/IntegrationControlRestart.ts", import.meta.url))
const invoke = (operation: string, filename: string) =>
  JSON.parse(execFileSync(process.execPath, [fixture, operation, filename], {
    encoding: "utf8",
    timeout: 30_000
  }))

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

it("composes control, memory, and integration cursors in a fresh database and reopens after process exit", () => {
  const filename = database()
  const written = invoke("fresh", filename)
  expect(written).toMatchObject({
    cursor: "99",
    control: [{ value: 42 }],
    fact: { key: "runbook", value: "preserve control and memory" }
  })
  expect(written.ledger).toEqual(expect.arrayContaining([
    { migration_id: 6001, name: "control_control_tables" },
    { migration_id: 7001, name: "memory_initial" },
    { migration_id: 7002, name: "memory_indexes" },
    { migration_id: 7003, name: "memory_fts_fold" },
    { migration_id: 8001, name: "integrations_integration_cursors" },
    { migration_id: 8002, name: "integrations_integration_records" }
  ]))
  expect(new Set(written.ledger.map((row: { migration_id: number }) => row.migration_id)).size).toBe(
    written.ledger.length
  )
  expect(invoke("read", filename)).toEqual(written)
})

it("adds cursors after a control and memory database already exists without losing earlier records", () => {
  const filename = database()
  const before = invoke("control-first", filename)
  const appended = invoke("append", filename)
  expect(appended).toMatchObject({ cursor: "99", control: before.control, fact: before.fact })
  expect(appended.ledger).toEqual([
    ...before.ledger,
    { migration_id: 8001, name: "integrations_integration_cursors" },
    { migration_id: 8002, name: "integrations_integration_records" }
  ])
  expect(invoke("read", filename)).toEqual(appended)
})
