/** An approved, self-contained module executes its measured closure in a real CLI host. */
import { execFile, spawn } from "node:child_process"
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
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

  it.each(["pinned", "missing-manifest", "lockfile", "adopt"] as const)(
    "resumes after SIGKILL with execution authority (%s)",
    async (mode) => {
      await withHost(async (root, command) => {
        await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n")
        await writeFile(join(root, "pause"), "")
        const child = spawn(process.execPath, [
          "--no-warnings",
          "--import",
          preload,
          bin,
          "flow",
          "start",
          "snapshot",
          "--data",
          JSON.stringify({ root, edit: true, park: false, early: false, concurrent: false }),
          "--wait",
          "--json"
        ], {
          cwd: root,
          env: {
            ...process.env,
            XDG_CONFIG_HOME: join(root, "config"),
            AI_GATEWAY_API_KEY: "",
            SMITHERS_REMOTE: "",
            NODE_OPTIONS: ""
          },
          stdio: ["ignore", "pipe", "pipe"]
        })
        let startupOutput = ""
        child.stdout?.on("data", (chunk) => {
          startupOutput += String(chunk)
        })
        child.stderr?.on("data", (chunk) => {
          startupOutput += String(chunk)
        })
        const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()))
        try {
          for (let attempt = 0;; attempt++) {
            try {
              await readFile(join(root, "second-started"))
              break
            } catch {
              if (child.exitCode !== null || child.signalCode !== null || attempt === 2_400) {
                throw new Error(`second child never reached its durable blocked attempt: ${startupOutput}`)
              }
              await new Promise((resolve) => setTimeout(resolve, 50))
            }
          }
          child.kill("SIGKILL")
          await exited
          expect(await readFile(join(root, "observed-1"), "utf8"))
            .toBe("approved-entry/approved-helper/approved-layer/1")
          await expect(readFile(join(root, "observed-2"))).rejects.toMatchObject({ code: "ENOENT" })
          if (mode === "missing-manifest") {
            await rm(join(root, ".flows", "executions"), { recursive: true, force: true })
          }
          if (mode === "lockfile") await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n# changed\n")
          await rm(join(root, "pause"))
          const arguments_ = ["runs", "resume", "run-1", ...(mode === "adopt" ? ["--allow-code-drift"] : []), "--json"]
          const deadline = Date.now() + 60_000
          let resumed = await command(arguments_)
          while (resumed.code === 1 && JSON.parse(resumed.stdout).code === "ClaimLost" && Date.now() < deadline) {
            // SIGKILL does not expire the durable lease. The fresh host must
            // wait for its real stale cutoff without performing child effects.
            await expect(readFile(join(root, "observed-2"))).rejects.toMatchObject({ code: "ENOENT" })
            await new Promise((resolve) => setTimeout(resolve, 1_000))
            resumed = await command(arguments_)
          }
          if (mode === "missing-manifest" || mode === "lockfile") {
            expect(resumed.code, JSON.stringify(resumed)).toBe(1)
            expect(JSON.parse(resumed.stdout)).toMatchObject({ code: "CodeDrift" })
            await expect(readFile(join(root, "observed-2"))).rejects.toMatchObject({ code: "ENOENT" })
          } else {
            expect(resumed.code, JSON.stringify(resumed)).toBe(0)
            expect(resumed.stdout).not.toContain("CodeDrift")
            for (const index of [2, 3]) {
              expect(await readFile(join(root, `observed-${index}`), "utf8"))
                .toBe(
                  `${mode === "adopt" ? "unapproved" : "approved"}-entry/${
                    mode === "adopt" ? "unapproved" : "approved"
                  }-helper/${mode === "adopt" ? "unapproved" : "approved"}-layer/${index}`
                )
            }
            expect(controlRows(root)[0]?.status).toBe("completed")
          }
        } finally {
          child.kill("SIGKILL")
          await exited
        }
      })
    },
    240_000
  )
  it("refuses adoption while another run uses the same flow and preserves its pinned implementation", async () => {
    await withHost(async (root, command) => {
      await writeFile(join(root, "pause"), "")
      const launch = () => {
        const child = spawn(process.execPath, [
          "--no-warnings",
          "--import",
          preload,
          bin,
          "flow",
          "start",
          "snapshot",
          "--data",
          JSON.stringify({ root, edit: false, park: false, early: false, concurrent: false }),
          "--wait",
          "--json"
        ], {
          cwd: root,
          env: {
            ...process.env,
            XDG_CONFIG_HOME: join(root, "config"),
            AI_GATEWAY_API_KEY: "",
            SMITHERS_REMOTE: "",
            NODE_OPTIONS: ""
          },
          stdio: ["ignore", "pipe", "pipe"]
        })
        let output = ""
        child.stdout.on("data", (chunk) => {
          output += String(chunk)
        })
        child.stderr.on("data", (chunk) => {
          output += String(chunk)
        })
        const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()))
        return { child, exited, output: () => output }
      }
      const children: Array<ReturnType<typeof launch>> = []
      try {
        for (const count of [1, 2]) {
          await rm(join(root, "second-started"), { force: true })
          const active = launch()
          children.push(active)
          for (let attempt = 0;; attempt++) {
            try {
              await readFile(join(root, "second-started"))
              break
            } catch {
              if (active.child.exitCode !== null || active.child.signalCode !== null || attempt === 2_400) {
                throw new Error(`run ${count} never blocked: ${active.output()}`)
              }
              await new Promise((resolve) => setTimeout(resolve, 50))
            }
          }
          expect(controlRows(root)).toHaveLength(count)
        }
        // Unchanged adoption must keep the other registered implementation.
        const unchanged = await command(["runs", "resume", "run-1", "--allow-code-drift", "--json"])
        expect(JSON.parse(unchanged.stdout).code).toBe("ClaimLost")
        children[0]!.child.kill("SIGKILL")
        await children[0]!.exited
        for (const file of ["flow.ts", "helper.ts", "layer.ts"]) {
          const filename = join(root, "flows", "snapshot", file)
          await writeFile(filename, (await readFile(filename, "utf8")).replaceAll("approved-", "unapproved-"))
        }
        const adoptionArguments = ["runs", "resume", "run-1", "--allow-code-drift", "--json"]
        const adoptionDeadline = Date.now() + 60_000
        let refused = await command(adoptionArguments)
        while (refused.code === 1 && JSON.parse(refused.stdout).code === "ClaimLost" && Date.now() < adoptionDeadline) {
          expect(children[1]!.child.exitCode).toBeNull()
          await expect(readFile(join(root, "observed-2"))).rejects.toMatchObject({ code: "ENOENT" })
          await new Promise((resolve) => setTimeout(resolve, 1_000))
          refused = await command(adoptionArguments)
        }
        expect(refused.code, JSON.stringify(refused)).toBe(1)
        expect(JSON.parse(refused.stdout)).toMatchObject({ code: "CodeDrift" })
        expect(children[1]!.child.exitCode).toBeNull()
        await expect(readFile(join(root, "observed-2"))).rejects.toMatchObject({ code: "ENOENT" })
        children[1]!.child.kill("SIGKILL")
        await children[1]!.exited
        await rm(join(root, "pause"))
        const deadline = Date.now() + 60_000
        let resumed = await command(["runs", "resume", "run-2", "--json"])
        while (resumed.code === 1 && JSON.parse(resumed.stdout).code === "ClaimLost" && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 1_000))
          resumed = await command(["runs", "resume", "run-2", "--json"])
        }
        expect(resumed.code, JSON.stringify(resumed)).toBe(0)
        for (const index of [2, 3]) {
          expect(await readFile(join(root, `observed-${index}`), "utf8"))
            .toBe(`approved-entry/approved-helper/approved-layer/${index}`)
        }
        expect(controlRows(root).find((row) => row.run_id === "run-2")?.status).toBe("completed")
      } finally {
        for (const active of children) active.child.kill("SIGKILL")
        await Promise.all(children.map((active) => active.exited))
      }
    })
  }, 360_000)
})
