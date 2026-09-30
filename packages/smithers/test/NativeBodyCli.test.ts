/** A refused native body reaches the operator and cannot admit a plan or run. */
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const executable = fileURLToPath(new URL("../src/bin.ts", import.meta.url))
const scriptedHost = fileURLToPath(new URL("./fixtures/scripted-native-host.ts", import.meta.url))
const source = `import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"
export default Flow.make("native", {
  description: "A native body", capabilities: [],
  effects: { reads: [], writes: [], mode: "hermetic", onConflict: "serialize", tier: "sealed" },
  payload: {}, success: Schema.String, body: () => Node.succeed("ok")
})
`
const count = (cwd: string, file: string, table: string): number => {
  const path = join(cwd, ".flows", file)
  if (!existsSync(path)) return 0
  const database = new DatabaseSync(path, { readOnly: true })
  try {
    return (database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count
  } finally {
    database.close()
  }
}
describe("native body CLI refusal", () => {
  it.each([false, true])("preserves the typed helper remedy with verbose=%s and no admission", (verbose) => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "smithers-native-body-")))
    try {
      mkdirSync(join(cwd, "flows/native"), { recursive: true })
      writeFileSync(join(cwd, "flows/native/flow.ts"), source)
      const missing = join(cwd, "sshpass -p synthetic3196 Authorization Token synthetic3196auth")
      const result = spawnSync(process.execPath, [
        "--no-warnings",
        "--import",
        scriptedHost,
        executable,
        ...(verbose ? ["up", "native", "--json", "--verbose"] : ["flow", "start", "native", "--format", "json"])
      ], {
        cwd,
        encoding: "utf8",
        timeout: 180_000,
        env: {
          HOME: cwd,
          PATH: process.env.PATH,
          TMPDIR: process.env.TMPDIR,
          SMITHERS_WORKSPACE_JJ_EXPORT_BINARY: missing
        }
      })
      expect(result.error, result.stderr).toBeUndefined()
      expect(result.status, result.stdout + result.stderr).toBe(1)
      const message = verbose ? result.stderr : (() => {
        expect(result.stdout, result.stderr).not.toBe("")
        const refusal = JSON.parse(result.stdout) as { code: string; message: string }
        expect(refusal.code, JSON.stringify(refusal)).toBe("InvalidInput")
        return refusal.message
      })()
      expect(message).toContain("Cannot load flow native")
      expect(message).toContain("smithers-jj-export is unusable")
      expect(message).toContain("SMITHERS_WORKSPACE_JJ_EXPORT_BINARY=")
      expect(message).not.toContain("body cannot be read")
      expect(message).toContain("[REDACTED]")
      expect(result.stdout + result.stderr).not.toContain("synthetic3196")
      expect(count(cwd, "control.db", "control_plans")).toBe(0)
      expect(count(cwd, "engine.db", "flows_runs")).toBe(0)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  }, 240_000)
})
