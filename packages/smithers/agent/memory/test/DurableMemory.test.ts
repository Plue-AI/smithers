import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"

it("retains facts, notes, messages, and FTS after the writing process exits", () => {
  const root = mkdtempSync(join(tmpdir(), "smithers-memory-restart-"))
  const filename = join(root, "memory.db")
  const fixture = fileURLToPath(new URL("./fixtures/DurableMemory.ts", import.meta.url))
  const invoke = (operation: string) =>
    JSON.parse(execFileSync(process.execPath, [fixture, operation, filename], {
      encoding: "utf8",
      timeout: 20_000
    }))
  try {
    const written = invoke("write")
    const reopened = invoke("read")
    expect(reopened).toEqual(written)
    expect(reopened.fact).toMatchObject({
      key: "runbook",
      value: "restore the primary",
      provenance: { runId: "first-process" }
    })
    expect(reopened.notes.map((note: { id: string }) => note.id)).toEqual(["release-note"])
    expect(reopened.messages.map((message: { id: string }) => message.id)).toEqual(["first"])
    expect(reopened.matches).toEqual(["runbook"])
    const db = new DatabaseSync(filename, { readOnly: true })
    try {
      expect(db.prepare("SELECT migration_id, name FROM flows_migrations ORDER BY migration_id").all()).toEqual([
        { migration_id: 7001, name: "memory_initial" },
        { migration_id: 7002, name: "memory_indexes" },
        { migration_id: 7003, name: "memory_fts_fold" }
      ])
    } finally {
      db.close()
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
