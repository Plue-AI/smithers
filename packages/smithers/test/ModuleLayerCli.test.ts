/** A file-authored Action layer crosses the actual CLI and durable engine. */
import { execFile } from "node:child_process"
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { describe, expect, it } from "vitest"

const run = promisify(execFile)
const bin = fileURLToPath(new URL("../src/bin.ts", import.meta.url))
const preload = fileURLToPath(new URL("./fixtures/scripted-native-host.ts", import.meta.url))
const fixture = fileURLToPath(new URL("./fixtures/module-layer/flows", import.meta.url))
const nodeModules = fileURLToPath(new URL("../node_modules", import.meta.url))

const recordedResults = (value: unknown): ReadonlyArray<{ value: string; pid: number }> => {
  if (typeof value !== "object" || value === null) return []
  const record = value as Record<string, unknown>
  if (typeof record.value === "string" && typeof record.pid === "number") {
    return [{ value: record.value, pid: record.pid }]
  }
  return Object.values(record).flatMap(recordedResults)
}

describe("a module's exported implementation layer", () => {
  it("starts a real CLI flow, writes via a real child, and reports completed output", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "smithers-cli-module-layer-")))
    try {
      await cp(fixture, join(root, "flows"), { recursive: true })
      await mkdir(join(root, ".flows"))
      await symlink(nodeModules, join(root, "node_modules"), "dir")
      const output = join(root, "result.txt")
      const environment = {
        ...process.env,
        XDG_CONFIG_HOME: join(root, "config"),
        AI_GATEWAY_API_KEY: "",
        SMITHERS_REMOTE: "",
        NODE_OPTIONS: ""
      }
      const command = (arguments_: ReadonlyArray<string>) =>
        run(process.execPath, ["--no-warnings", "--import", preload, bin, ...arguments_], {
          cwd: root,
          env: environment,
          timeout: 120_000,
          maxBuffer: 4 * 1024 * 1024
        }).catch((cause: unknown) => {
          const failure = cause as { message: string; stdout?: string; stderr?: string }
          throw new Error(`${failure.message}\nstdout: ${failure.stdout ?? ""}\nstderr: ${failure.stderr ?? ""}`)
        })
      const started = await command([
        "flow",
        "start",
        "fixture",
        "--data",
        JSON.stringify({ output, value: "child-wrote-this" }),
        "--wait",
        "--json"
      ])
      expect(started.stderr).not.toContain("AnyOf")
      expect(await readFile(output, "utf8")).toBe("child-wrote-this")
      const listed = await command(["runs", "list", "--flow", "fixture", "--json"])
      const page = JSON.parse(listed.stdout) as {
        items: ReadonlyArray<{ runId: string; flowId: string; status: string }>
      }
      expect(page.items).toHaveLength(1)
      expect(page.items[0]).toMatchObject({ flowId: "fixture", status: "completed" })
      const inspected = await command(["runs", "show", page.items[0]!.runId, "--json"])
      const completion = JSON.parse(inspected.stdout) as { status: string }
      expect(completion.status).toBe("completed")
      // The recorded result proves completion came from the subprocess, not
      // merely from accepting the launch or creating its plan.
      const events = await command(["runs", "logs", page.items[0]!.runId, "--format", "jsonl"])
      expect(events.stdout).toContain("control.run.completed")
      const results = events.stdout.trim().split("\n").flatMap((line) => recordedResults(JSON.parse(line)))
      expect(results.length).toBeGreaterThan(0)
      expect(results).toContainEqual({ value: "child-wrote-this", pid: expect.any(Number) })
      expect(
        results.every((result) => Number.isSafeInteger(result.pid) && result.pid > 0 && result.pid !== process.pid)
      )
        .toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 240_000)
})
