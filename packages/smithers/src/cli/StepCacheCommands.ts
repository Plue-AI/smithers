/**
 * Local operator commands for durable step-result heads. The recorded replay
 * ledger is never mutated here.
 * @since 1.0.0
 */

import { Cli, z } from "incur"
import { existsSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import * as NodeControl from "../NodeControl.ts"

interface Row {
  key_digest: string
  result_json: string
  meta_json: string
  created_at_ms: number
  recorded_run_id: string
  recorded_event_seq: number
}

const files = (root: string): Array<string> =>
  [NodeControl.databasePath(root), NodeControl.executionDatabasePath(root)]
    .filter((file) => existsSync(file))

const withCache = <A>(file: string, readonly: boolean, action: (db: DatabaseSync) => A): A => {
  const db = new DatabaseSync(file, { readOnly: readonly })
  try {
    return action(db)
  } finally {
    db.close()
  }
}

const keyIsValid = (key: string): boolean => /^[A-Za-z0-9_-]{1,256}$/.test(key)
const columns = "key_digest, result_json, meta_json, created_at_ms, recorded_run_id, recorded_event_seq"
const present = (db: DatabaseSync): boolean =>
  db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'flows_step_cache'").get() !== undefined

const rootOf = (options: { root?: string | undefined }): string => options.root ?? process.cwd()

/**
 * Construct the local step-cache operator command tree.
 * @category constructors
 * @since 1.0.0
 */
export const createStepCacheCli = () =>
  Cli.create("steps", { description: "Inspect and maintain durable flow step results" })
    .command("ls", {
      description: "List recent step cache heads",
      mcp: { annotations: { readOnlyHint: true } },
      options: z.object({ root: z.string().optional() }),
      run: (c) =>
        files(rootOf(c.options)).flatMap((file) =>
          withCache(file, true, (db) =>
            present(db)
              ? (db.prepare(`SELECT key_digest, created_at_ms, recorded_run_id, recorded_event_seq
              FROM flows_step_cache ORDER BY created_at_ms DESC, key_digest LIMIT 100`).all() as Array<object>)
                .map((row) => ({ database: file, ...row }))
              : [])
        )
    })
    .command("show", {
      description: "Inspect a recorded step result",
      mcp: { annotations: { readOnlyHint: true } },
      args: z.object({ key: z.string() }),
      options: z.object({ root: z.string().optional() }),
      run: (c) => {
        if (!keyIsValid(c.args.key)) return c.error({ code: "invalid_key", message: "Invalid step cache key" })
        return files(rootOf(c.options)).flatMap((file) =>
          withCache(file, true, (db) => {
            if (!present(db)) return []
            const row = db.prepare(`SELECT ${columns} FROM flows_step_cache WHERE key_digest = ?`)
              .get(c.args.key) as Row | undefined
            return row === undefined ? [] : [{
              database: file,
              key: row.key_digest,
              result: JSON.parse(row.result_json) as unknown,
              meta: JSON.parse(row.meta_json) as unknown,
              createdAtMs: row.created_at_ms,
              recordedBy: { runId: row.recorded_run_id, eventSeq: row.recorded_event_seq }
            }]
          })
        )
      }
    })
    .command("evict", {
      description: "Remove a step result only if its provenance matches",
      mcp: { annotations: { readOnlyHint: false } },
      args: z.object({ key: z.string() }),
      options: z.object({ root: z.string().optional(), ifRecordedBy: z.string() }),
      run: (c) => {
        if (!keyIsValid(c.args.key) || !c.options.ifRecordedBy) {
          return c.error({ code: "invalid_provenance", message: "A valid key and --if-recorded-by run are required" })
        }
        return files(rootOf(c.options)).map((file) =>
          withCache(file, false, (db) => ({
            database: file,
            removed: present(db) && db.prepare(
                  "DELETE FROM flows_step_cache WHERE key_digest = ? AND recorded_run_id = ?"
                ).run(c.args.key, c.options.ifRecordedBy).changes > 0
          }))
        )
      }
    })
    .command("sweep", {
      description: "Remove old step cache heads; recorded replay evidence is preserved",
      mcp: { annotations: { readOnlyHint: false } },
      options: z.object({ root: z.string().optional(), olderThan: z.string() }),
      run: (c) => {
        const match = /^(\d+)(s|m|h|d|w)$/.exec(c.options.olderThan)
        const scale: Record<string, number> = { s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 }
        const age = match ? Number(match[1]) * scale[match[2]!]! : NaN
        if (!Number.isSafeInteger(age) || age <= 0) {
          return c.error({ code: "invalid_duration", message: "--older-than must be a positive duration such as 7d" })
        }
        const cutoff = Date.now() - age
        return files(rootOf(c.options)).map((file) =>
          withCache(file, false, (db) => ({
            database: file,
            removed: present(db)
              ? db.prepare("DELETE FROM flows_step_cache WHERE created_at_ms < ?").run(cutoff).changes
              : 0
          }))
        )
      }
    })
