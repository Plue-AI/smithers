/** A crash after an unkeyed effect refuses repetition with its original reason. */
import { Control } from "@smthrs/control"
import { Effect } from "effect"
import { spawn } from "node:child_process"
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"
import { host, source } from "./fixtures/native-control-peer-recovery.ts"

const fixture = fileURLToPath(new URL("./fixtures/native-control-peer-recovery.ts", import.meta.url))
const exists = (file: string) => access(file).then(() => true, () => false)
const poll = async (predicate: () => boolean | Promise<boolean>, label: string) => {
  const deadline = Date.now() + 30_000
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}
const readRows = (root: string) => {
  const db = new DatabaseSync(join(root, ".flows", "engine.db"), { readOnly: true })
  try {
    return db.prepare("SELECT run_id, status, state_json FROM flows_runs").all() as Array<{
      run_id: string
      status: string
      state_json: string
    }>
  } finally {
    db.close()
  }
}

it.each(["Unknown", "Never"] as const)(
  "retains the unkeyed retry refusal after a host dies (error schema %s)",
  async (errorSchema) => {
    const root = await mkdtemp(join(tmpdir(), "smithers-unsafe-retry-"))
    await mkdir(join(root, "flows", "peer"), { recursive: true })
    await symlink(resolve("node_modules"), join(root, "node_modules"), "dir")
    await writeFile(
      join(root, "flows", "peer", "flow.ts"),
      source(root, false).replaceAll("error: Schema.Unknown", `error: Schema.${errorSchema}`)
    )
    const original = spawn(process.execPath, ["--experimental-strip-types", fixture, "peer-original", root], {
      stdio: ["ignore", "ignore", "pipe"]
    })
    let stderr = ""
    original.stderr?.on("data", (chunk) => {
      stderr += String(chunk)
    })
    const exited = new Promise<void>((resolve) => original.on("exit", () => resolve()))
    try {
      await poll(async () => {
        if (original.exitCode !== null || original.signalCode !== null) throw new Error(`Host exited: ${stderr}`)
        return await exists(join(root, `entered-${original.pid}`)) && await exists(join(root, "run-id"))
      }, "original action started")
      const runId = await readFile(join(root, "run-id"), "utf8")
      expect((await readFile(join(root, "attempts.txt"), "utf8")).trim()).toBe(String(original.pid))
      original.kill("SIGKILL")
      await exited
      // Expire actual dead-owner leases; no release state or result is invented.
      for (const name of ["control", "engine"]) {
        const db = new DatabaseSync(join(root, ".flows", `${name}.db`))
        try {
          db.prepare("UPDATE flows_runs SET heartbeat_at_ms = ? WHERE status = 'running'").run(Date.now() - 60_000)
          db.prepare("UPDATE flows_consensus_leases SET heartbeat_at_ms = ? WHERE owner_host_id IS NOT NULL").run(
            Date.now() - 60_000
          )
        } finally {
          db.close()
        }
      }
      await writeFile(join(root, "release"), "an unsafe retry would finish")
      await Effect.runPromise(
        Effect.gen(function*() {
          yield* Control.Control
          yield* Effect.promise(() =>
            poll(
              () => readRows(root).some((row) => row.run_id !== runId && row.status === "failed"),
              "native child refused retry"
            )
          )
          const child = readRows(root).find((row) => row.run_id !== runId)!
          const result = JSON.parse(child.state_json).result
          expect(result._tag).toBe("Complete")
          expect(result.exit._tag).toBe("Failure")
          expect(result.exit.cause).toEqual([{
            _tag: "Die",
            defect: {
              _tag: "@smthrs/flow/IrreversibleRetryRequiresIdempotencyKey",
              code: "irreversible_retry_requires_idempotency_key",
              actionName: "peer/Probe",
              attempt: 1
            }
          }])
          expect(JSON.stringify(result)).not.toContain("SchemaError")
          expect(yield* Effect.promise(() => readFile(join(root, "attempts.txt"), "utf8"))).toBe(`${original.pid}\n`)
        }).pipe(Effect.provide(host(root)), Effect.scoped)
      )
      // A fresh observer must see the same durable refusal, not just a live exception.
      const child = readRows(root).find((row) => row.run_id !== runId)!
      expect(child.state_json).toContain("irreversible_retry_requires_idempotency_key")
    } finally {
      original.kill("SIGKILL")
      await exited
      await rm(root, { recursive: true, force: true, maxRetries: 5 })
    }
  },
  90_000
)
