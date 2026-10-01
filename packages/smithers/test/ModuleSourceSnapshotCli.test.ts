/** An approved, self-contained module executes its measured closure in a real CLI host. */
import { execFile } from "node:child_process"
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { describe, expect, it } from "vitest"

const run = promisify(execFile)
const bin = fileURLToPath(new URL("../src/bin.ts", import.meta.url))
const preload = fileURLToPath(new URL("./fixtures/scripted-native-host.ts", import.meta.url))
const fixture = fileURLToPath(new URL("./fixtures/module-snapshot/flows", import.meta.url))
const nodeModules = fileURLToPath(new URL("../node_modules", import.meta.url))

type Result = { readonly stdout: string; readonly stderr: string; readonly code: number }
type Command = (args: ReadonlyArray<string>) => Promise<Result>
const withHost = async (test: (root: string, command: Command) => Promise<void>) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "smithers-cli-module-snapshot-")))
  try {
    await cp(fixture, join(root, "flows"), { recursive: true })
    await mkdir(join(root, ".flows"))
    await symlink(nodeModules, join(root, "node_modules"), "dir")
    const command: Command = (args) =>
      run(process.execPath, ["--no-warnings", "--import", preload, bin, ...args], {
        cwd: root,
        env: {
          ...process.env,
          XDG_CONFIG_HOME: join(root, "config"),
          AI_GATEWAY_API_KEY: "",
          SMITHERS_REMOTE: "",
          NODE_OPTIONS: ""
        },
        timeout: 120_000,
        maxBuffer: 4 * 1024 * 1024
      }).then(({ stdout, stderr }) => ({ stdout, stderr, code: 0 })).catch((cause: unknown) => {
        const failure = cause as { code?: unknown; stdout?: string; stderr?: string }
        if (typeof failure.code !== "number") throw cause
        return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? "", code: failure.code }
      })
    await test(root, command)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const controlRows = (root: string) => {
  const database = new DatabaseSync(join(root, ".flows", "control.db"), { readOnly: true })
  try {
    return database.prepare(
      "SELECT runs.run_id, runs.status, runs.state_json FROM control_runs AS indexed JOIN flows_runs AS runs ON indexed.run_id = runs.run_id ORDER BY runs.run_id"
    ).all()
  } finally {
    database.close()
  }
}

describe("the approved module source snapshot", () => {
  it.each([
    { edit: false, early: false, concurrent: false },
    { edit: true, early: false, concurrent: false },
    { edit: false, early: true, concurrent: false },
    { edit: false, early: true, concurrent: true }
  ])(
    "retains entry, helper, and implementation-layer bytes ($edit/$early/$concurrent)",
    async ({ edit, early, concurrent }) => {
      await withHost(async (root, command) => {
        const started = await command([
          "flow",
          "start",
          "snapshot",
          "--data",
          JSON.stringify({ root, edit, early, concurrent, park: false }),
          "--wait",
          "--json"
        ])
        expect(started, JSON.stringify(started)).toMatchObject({ code: 0 })
        expect(started.stderr).not.toContain("body_unavailable")
        expect(await readFile(join(root, "root-started"), "utf8")).toBe("approved-root")
        for (const index of [1, 2, 3]) {
          expect(await readFile(join(root, `observed-${index}`), "utf8"))
            .toBe(`approved-entry/approved-helper/approved-layer/${index}`)
        }
        for (const file of ["flow.ts", "helper.ts", "layer.ts"]) {
          expect(await readFile(join(root, "flows", "snapshot", file), "utf8"))
            .toContain(edit || early ? "unapproved-" : "approved-")
        }
        const listed = JSON.parse((await command(["runs", "list", "--flow", "snapshot", "--json"])).stdout) as {
          items: ReadonlyArray<{ runId: string; status: string }>
        }
        expect(listed.items).toHaveLength(1)
        expect(listed.items[0]!.status).toBe("completed")
        expect(controlRows(root)).toEqual([{
          run_id: listed.items[0]!.runId,
          status: "completed",
          state_json: expect.any(String)
        }])
        const logs = await command(["runs", "logs", listed.items[0]!.runId, "--format", "jsonl"])
        expect(logs.stdout).toContain("control.run.completed")
        expect(logs.stdout).not.toContain("control.run.failed")
        expect(logs.stdout).not.toContain("unapproved-entry/unapproved-helper/unapproved-layer")
      })
    },
    240_000
  )

  it("a restarted host refuses changed source and keeps the approved run parked without child effects", async () => {
    await withHost(async (root, command) => {
      const started = await command([
        "flow",
        "start",
        "snapshot",
        "--data",
        JSON.stringify({ root, edit: true, park: true, early: false, concurrent: false }),
        "--detached",
        "--json"
      ])
      expect(started, JSON.stringify(started)).toMatchObject({ code: 0 })
      for (let attempt = 0; controlRows(root)[0]?.status !== "suspended"; attempt++) {
        if (attempt === 300) throw new Error(`run did not park: ${JSON.stringify(controlRows(root))}`)
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      const before = controlRows(root)
      expect(before).toEqual([{ run_id: "run-1", status: "suspended", state_json: expect.any(String) }])
      try {
        const resumed = await command(["runs", "resume", "run-1", "--json"])
        expect(resumed.code).toBe(1)
        expect(JSON.parse(resumed.stdout)).toMatchObject({
          code: "CodeDrift",
          message: expect.stringContaining("--allow-code-drift")
        })
        expect(controlRows(root)).toEqual(before)
        expect(await readFile(join(root, "observed-1"), "utf8"))
          .toBe("approved-entry/approved-helper/approved-layer/1")
        await expect(readFile(join(root, "observed-2"), "utf8")).rejects.toMatchObject({ code: "ENOENT" })
        await expect(readFile(join(root, "observed-3"), "utf8")).rejects.toMatchObject({ code: "ENOENT" })
      } finally {
        expect((await command(["runs", "cancel", "run-1", "--json"])).code).toBe(130)
      }
    })
  }, 240_000)
})
