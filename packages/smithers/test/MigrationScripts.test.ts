/** Migrated script bytes cross a real shell and the public bin before SQL assertions. */
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import { rewriteManifest } from "@smthrs/migrate/flow/Archive"
import { Effect } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { spawn } from "node:child_process"
import { cp, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"

const roots: Array<string> = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const executable = fileURLToPath(new URL("../src/bin.ts", import.meta.url))
const fixture = fileURLToPath(new URL("../migrate/test/fixtures/jsx-single.migrated", import.meta.url))

const execute = (root: string, command: string, input: string) =>
  new Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string }>((resolve, reject) => {
    // Supply the executable lookup and an explicit offline completion judge;
    // command parsing, control, approval and persistence still run as shipped.
    const child = spawn("/bin/sh", [
      "-c",
      "smthrs() { \"$MIGRATION_NODE\" --import \"$MIGRATION_JUDGE\" \"$MIGRATION_BIN\" \"$@\"; }\n" + command
    ], {
      cwd: root,
      env: {
        // Deliberate allowlist: a developer's ambient model credentials,
        // NODE_OPTIONS or remote configuration must not enter this bin test.
        PATH: process.env.PATH,
        TMPDIR: process.env.TMPDIR,
        LANG: "C.UTF-8",
        MIGRATION_NODE: process.execPath,
        MIGRATION_BIN: executable,
        MIGRATION_JUDGE: new URL("./fixtures/scripted-native-host.ts", import.meta.url).href,
        INPUT: input,
        SMITHERS_REMOTE: "",
        SMITHERS_TOKEN: "",
        SMITHERS_BACKEND: "sqlite",
        SMITHERS_WORKSPACE_JJ_EXPORT_BINARY: process.env.SMITHERS_WORKSPACE_JJ_EXPORT_BINARY,
        SMITHERS_AUDIENCE: "human",
        SMITHERS_INSIDE_RUN: "",
        SMITHERS_LIVE_MODEL_TESTS: "0"
      },
      detached: true
    })
    let stdout = ""
    let stderr = ""
    const stop = () => {
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL")
        } catch { /* Already closed. */ }
      }
    }
    const timer = setTimeout(stop, 90_000)
    child.stdout.on("data", (data) => {
      stdout += data
      if (stdout.length > 524_288) stop()
    })
    child.stderr.on("data", (data) => {
      stderr += data
      if (stderr.length > 524_288) stop()
    })
    child.once("error", (cause) => {
      clearTimeout(timer)
      reject(cause)
    })
    child.once("close", (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal, stdout, stderr })
    })
    child.stdin.end()
  })

describe.skipIf(process.platform === "win32")("migrated scripts through the public CLI", { timeout: 120_000 }, () => {
  it.each([
    { old: "smithers up simple-workflow.jsx --input \"$INPUT\"", detached: false },
    { old: "bunx smthrs up .smithers/workflows/simple-workflow.tsx --input='{}' -d", detached: true },
    { old: "smithers workflow run simple-workflow.jsx -d '{\"topic\":\"legacy data alias\"}'", detached: false }
  ])("admits the right flow/input and execution mode for $old", async ({ detached, old }) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "smithers-migrated-cli-")))
    roots.push(root)
    await cp(fixture, root, { recursive: true })
    const input = JSON.stringify({ topic: "quotes ' and Unicode 😀; smithers up must stay data" })
    const original = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
      scripts: Record<string, string>
    }
    const expectedInput = old.includes("='{}'")
      ? {}
      : old.includes("legacy data alias")
      ? { topic: "legacy data alias" }
      : JSON.parse(input)
    original.scripts = { start: `${old} --json --quiet` }
    const migrated = rewriteManifest(JSON.stringify(original), { remove: [], add: [] })
    expect(migrated.scripts[0]?.unsupported).toBeUndefined()
    await writeFile(join(root, "package.json"), migrated.text)
    const result = await execute(root, migrated.scripts[0]!.after, input)
    // This existing module fixture has no CLI executor. An attached start must
    // report that precise post-admission condition, not a parser/route failure.
    // Detached start succeeds once the child proves durable admission. Neither
    // case is evidence that the separate module-execution bridge is complete.
    expect({ code: result.code, signal: result.signal }, result.stdout + result.stderr)
      .toEqual({ code: detached ? 0 : 1, signal: null })
    const receipt = JSON.parse(result.stdout) as { runId: string; detached?: boolean; logFile?: string }
    if (detached) expect(receipt.runId).toMatch(/^run-/)
    else {
      expect(receipt).toMatchObject({ code: "UnsupportedError" })
      expect(result.stdout).toContain("no executor took it")
    }
    expect(receipt.detached === true).toBe(detached)
    if (detached) expect(receipt.logFile).toBe(join(root, ".flows", "logs", `${receipt.runId}.log`))

    // Detached admission does not join the child process. Its SQLite stores
    // can still be opening or closing when this reader starts. Use the same
    // read-only adapter and bounded open-lock
    // handling as the host, rather than a raw zero-wait schema read.
    const { rows, runs } = await Effect.runPromise(
      Effect.gen(function*() {
        const sql = yield* SqlClient.SqlClient
        return {
          rows: yield* sql`SELECT card_json, decoded_input_json FROM control_plans`,
          runs: yield* sql`SELECT run_id FROM control_runs`
        }
      }).pipe(Effect.provide(NodeDatabase.layer({
        filename: join(root, ".flows", "control.db"),
        sqlite: { readonly: true }
      })))
    )
    expect(rows).toHaveLength(1)
    expect(JSON.parse(String(rows[0]!.decoded_input_json))).toEqual(expectedInput)
    expect(JSON.parse(String(rows[0]!.card_json)).flowId).toBe("simple-workflow")
    expect(runs).toHaveLength(1)
    expect(String(runs[0]!.run_id)).toMatch(/^run-/)
    if (detached) expect(runs[0]!.run_id).toBe(receipt.runId)
    else expect(result.stdout).toContain(String(runs[0]!.run_id))
  })
})
