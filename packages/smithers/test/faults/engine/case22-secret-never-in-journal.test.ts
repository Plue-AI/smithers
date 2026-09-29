/**
 * Case 22 — a credential handed to a run never reaches the journal.
 *
 * The run below is deliberately careless: its action logs the token and returns
 * a string with the token inside it, which is how integrations actually leak.
 * `@smthrs/journal`'s redaction is the thing under test, so the assertion reads
 * the SQLite file directly rather than any API that might redact on the way
 * out — a secret that is committed and merely hidden by a getter is still a
 * durable, broadly readable leak.
 *
 * The case has two halves because a credential can surface in two places.
 *
 * The journal is where the leak would be permanent: every committed row is
 * replayed to sync subscribers and to time travel, so redaction happens on the
 * write path and the first test reads what the write path left behind.
 *
 * The operator's terminal is the other place, and the second test reads the
 * child's whole stdout and stderr. release requirements makes case 22 a required
 * release parity test across the journal *and* the logs. That half was RED at
 * rc.0 and stayed in the matrix as a plain failing test rather than as prose,
 * because a matrix that is green while a live credential reaches the terminal
 * reports a truth the product does not have. The redaction
 * deliverable closed it: `@smthrs/journal` `RedactedLogger` puts every log
 * line through the same rules the journal applies on the write path, and
 * `packages/smithers/src/bin.ts` and `packages/smithers/flows/src/NodeRuntime.ts` install
 * it. The assertion that was failing went green with no change to it, which is
 * what a plain failing test is for, and `e2e-faults` became a required CI job.
 * Two assertions were added afterwards, pinning that redaction rewrites the
 * line rather than swallowing it.
 *
 * The journal is not the only table in the file. A third test scans every
 * column of every table the run wrote and fails on any credential outside
 * `executableColumns`. The columns listed there are executable state that
 * resume decodes and re-enters byte for byte: `flows_runs.state_json` holds the
 * run's payload and result, and `flows_attempts.outcome_json` is the copy an
 * action replays instead of executing again. Redacting either would corrupt the
 * resumed run, so they are kept verbatim, and the run's SQLite file
 * (`.flows/*.db`) holds unredacted run inputs and results. Treat it as a secret
 * store; see `@smthrs/run-store` `docs/concepts/durable-values.md`.
 *
 * All three are required gates now. Neither may be marked `.fails`, skipped,
 * or deleted; `scripts/repo-contract/fault-skips.test.mjs` refuses all three
 * and names this file.
 */
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient"
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { spawn } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, describe, expect, it } from "vitest"

const directory = mkdtempSync(join(tmpdir(), "smithers-e2e-case22-"))
afterAll(() => rmSync(directory, { recursive: true, force: true }))

const runner = fileURLToPath(new URL("./fixtures/secretChild.ts", import.meta.url))
const secret = "sk-live-e2ecase22NEVERLOGTHIS"

const runChild = (filename: string, executionId: string): Promise<{ code: number | null; output: string }> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [runner, filename, executionId, secret], {
      stdio: ["ignore", "pipe", "pipe"]
    })
    let output = ""
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      output += chunk
    })
    child.stderr.on("data", (chunk: string) => {
      output += chunk
    })
    child.once("error", reject)
    child.once("exit", (code) => resolve({ code, output }))
  })

/** Every text column of the journal table, concatenated. */
const journalText = (filename: string): Promise<string> =>
  Effect.runPromise(
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const rows = yield* sql<Record<string, unknown>>`SELECT * FROM flows_journal_events`
      return rows.map((row) => Object.values(row).map((value) => String(value)).join(" ")).join("\n")
    }).pipe(
      Effect.provide(SqliteClient.layer({ filename })),
      Effect.scoped,
      Effect.orDie
    )
  )

/**
 * Columns that resume re-reads byte for byte, so they keep the credential.
 * Every other column of every table must not contain it.
 */
const executableColumns = new Set(["flows_runs.state_json", "flows_attempts.outcome_json"])

/** Every `table.column` of the SQLite file whose text contains `needle`. */
const columnsContaining = (filename: string, needle: string): Promise<ReadonlyArray<string>> =>
  Effect.runPromise(
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const tables = yield* sql<{ name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name
      `
      const hits: Array<string> = []
      for (const { name } of tables) {
        const rows = yield* sql.unsafe<Record<string, unknown>>(`SELECT * FROM "${name.replaceAll("\"", "\"\"")}"`)
        const columns = new Set<string>()
        for (const row of rows) {
          for (const [column, value] of Object.entries(row)) {
            const text = value instanceof Uint8Array ? Buffer.from(value).toString("utf8") : String(value)
            if (text.includes(needle)) columns.add(`${name}.${column}`)
          }
        }
        hits.push(...columns)
      }
      return hits
    }).pipe(
      Effect.provide(SqliteClient.layer({ filename })),
      Effect.scoped,
      Effect.orDie
    )
  )

describe("case22 a secret never reaches the journal", () => {
  it("redacts the credential out of every committed journal row", async () => {
    const filename = join(directory, "journal.sqlite")
    const child = await runChild(filename, "case22-run")
    expect(child.code).toBe(0)
    expect(child.output).toContain("RESULT=ok")

    const committed = await journalText(filename)
    // The run really was recorded, so the absences below are about redaction
    // and not about an empty table.
    expect(committed).toContain("e2e/secret/deploy")
    expect(committed).toContain("succeeded")
    expect(committed).not.toContain(secret)
    // Structurally, by field name: the payload the run was created with.
    expect(committed).toContain("\"apiKey\":\"[REDACTED]\"")
    // And textually, in a value no field name covers: the action returned a
    // string with the credential spliced into it, which is the shape a
    // careless integration actually leaks.
    expect(committed).toContain("token=[REDACTED]")
  }, 120_000)

  it("keeps the credential out of every column except executable state", async () => {
    const filename = join(directory, "tables.sqlite")
    const child = await runChild(filename, "case22-tables")
    expect(child.code).toBe(0)
    expect(child.output).toContain("RESULT=ok")

    const hits = await columnsContaining(filename, secret)
    expect(hits.filter((column) => !executableColumns.has(column))).toEqual([])
    // The allow-list is exact: each entry really holds the credential, so an
    // entry that stops leaking must be removed rather than left as cover.
    expect([...hits].sort()).toEqual([...executableColumns].sort())
  }, 120_000)

  // REQUIRED GATE. Case 22 covers the logs as well
  // as the journal. This was red until the redaction deliverable
  // landed `@smthrs/journal` `RedactedLogger`; before it, `Effect.logInfo`
  // wrote the credential straight to the child's stderr. It reads the real
  // binary's real output, so it is the only thing that proves the layer is
  // actually installed under `NodeRuntime.layerHost` rather than merely
  // exported.
  it("redacts the credential out of the operator's terminal", async () => {
    const filename = join(directory, "terminal.sqlite")
    const child = await runChild(filename, "case22-terminal")
    expect(child.code).toBe(0)
    expect(child.output).toContain("RESULT=ok")

    // The run really did execute, so the absence below is about redaction and
    // not about a child that never got as far as logging.
    expect(child.output).not.toContain(secret)
    // And the line survived: redaction rewrites the credential, it does not
    // swallow the log call, so an operator still sees what the run was doing.
    expect(child.output).toContain("https://example.test/deploy")
    expect(child.output).toContain("[REDACTED_API_KEY]")
  }, 120_000)
})
