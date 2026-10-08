/** File-flow payload failures are refused before durable plan or run admission. */
import { execFile } from "node:child_process"
import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

const execute = promisify(execFile)
const bin = fileURLToPath(new URL("../src/bin.ts", import.meta.url))
const preload = fileURLToPath(new URL("./fixtures/scripted-native-host.ts", import.meta.url))
const modules = fileURLToPath(new URL("../node_modules", import.meta.url))

describe("file-flow payload admission", () => {
  let root: string
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "smithers-file-input-cli-")))
    await mkdir(join(root, "flows", "echo"), { recursive: true })
    await symlink(modules, join(root, "node_modules"), "dir")
    await writeFile(
      join(root, "flows", "echo", "flow.ts"),
      `
import { Action, Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Effect, Schema } from "effect"
import { writeFileSync } from "node:fs"
writeFileSync(${JSON.stringify(join(root, "module-evaluated.txt"))}, "loaded")
const Echo = Action.make("echo/Value", { implementationVersion: "echo/v1", payload: { value: Schema.String }, success: Schema.String })
export const layer = Echo.toLayer(({ value }) => Effect.sync(() => {
  writeFileSync(${JSON.stringify(join(root, "executed.txt"))}, value)
  return value
}), { implementationVersion: "echo/v1" })
export default Flow.make("echo", {
  description: "Echo a string offline", capabilities: ["fs:write:**"],
  effects: { reads: [], writes: ["executed.txt"], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  payload: { value: Schema.String }, success: Schema.String,
  body: Node.capture({ action: Echo.name, implementationVersion: "echo/v1" }, ({ value }) => Echo.call({ value }))
})
`
    )
  }, 30_000)
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const command = async (args: ReadonlyArray<string>) => {
    const result = await execute(process.execPath, [
      "--no-warnings",
      "--import",
      preload,
      bin,
      ...args,
      "--root",
      root,
      "--json"
    ], {
      cwd: root,
      env: {
        PATH: process.env["PATH"],
        NODE_COMPILE_CACHE: process.env["NODE_COMPILE_CACHE"],
        HOME: join(root, "home"),
        XDG_CONFIG_HOME: join(root, "config"),
        SMITHERS_WORKSPACE_JJ_EXPORT_BINARY: process.env["SMITHERS_WORKSPACE_JJ_EXPORT_BINARY"],
        SMITHERS_FFI_LIBRARY_PATH: process.env["SMITHERS_FFI_LIBRARY_PATH"],
        SMITHERS_BACKEND: "sqlite"
      },
      timeout: 60_000
    }).then(
      (result) => ({ ...result, code: 0 }),
      (error) => ({ stdout: error.stdout, stderr: error.stderr, code: error.code })
    )
    return { ...result, json: result.stdout.trim() === "" ? undefined : JSON.parse(result.stdout) }
  }
  it("lists the input schema without evaluating the module", async () => {
    // Local authoring uses the project catalog; install flow commands use the backend.
    const catalogListed = await command(["ls"])
    expect(catalogListed.code, catalogListed.stdout + catalogListed.stderr).toBe(0)
    await expect(access(join(root, "module-evaluated.txt"))).rejects.toThrow()
    expect(catalogListed.json.items.find((item: { flowId: string }) => item.flowId === "echo")).toMatchObject({
      flowId: "echo",
      inputSchema: { schema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } }
    })
  }, 60_000)

  it.each([{}, { value: 42 }, { value: null }, { value: false }, { value: ["hello"] }])(
    "refuses invalid input %j before plan or run admission", async (input) => {
      for (const verb of ["plan", "start"]) {
        const result = await command([
          ...(verb === "plan" ? ["plan"] : ["flow", "start"]),
          "echo",
          "--data",
          JSON.stringify(input)
        ])
        expect(result.code, result.stdout).not.toBe(0)
        if (verb === "plan") {
          // Retained local planning prints typed failures on stderr.
          expect(result.stdout).toBe("")
          expect(result.stderr).toContain("InvalidInput:")
          expect(result.stderr).toContain("[\"value\"]")
        } else {
          expect(result.json, result.stderr).toMatchObject({ code: "InvalidInput" })
          expect(result.json.message).toContain("value")
        }
        expect(result.stdout).not.toContain("\"planId\"")
        expect(result.stdout).not.toContain("\"runId\"")
      }
      await expectNoAdmission()
    }, 60_000)

  it("enforces refined input without executing it during discovery", async () => {
    const file = join(root, "flows", "echo", "flow.ts")
    const original = await readFile(file, "utf8")
    await writeFile(
      file,
      original.replace(
        "payload: { value: Schema.String }, success: Schema.String,",
        "payload: { value: Schema.String.check(Schema.isMinLength(3)) }, success: Schema.String,"
      )
    )
    await rm(join(root, "module-evaluated.txt"), { force: true })
    const refined = await command(["ls"])
    expect(refined.code, refined.stdout + refined.stderr).toBe(0)
    expect(refined.json.items.find((item: { flowId: string }) => item.flowId === "echo")).toBeDefined()
    expect(refined.json.items.find((item: { flowId: string }) => item.flowId === "echo").inputSchema).toBeUndefined()
    await expect(access(join(root, "module-evaluated.txt"))).rejects.toThrow()
    for (const verb of ["plan", "start"]) {
      const refused = await command([
        ...(verb === "plan" ? ["plan"] : ["flow", "start"]),
        "echo",
        "--data",
        "{\"value\":\"x\"}"
      ])
      expect(refused.code, refused.stdout + refused.stderr).not.toBe(0)
      if (verb === "plan") {
        expect(refused.stdout).toBe("")
        expect(refused.stderr).toContain("InvalidInput:")
        expect(refused.stderr).toContain("[\"value\"]")
      } else {
        expect(refused.json, refused.stderr).toMatchObject({ code: "InvalidInput" })
        expect(refused.json.message).toContain("value")
      }
      expect(refused.stdout).not.toMatch(/"(?:planId|runId)"/u)
    }
    await writeFile(file, original)
    await expectNoAdmission()
  }, 60_000)

  const expectNoAdmission = async () => {
    const listed = await command(["ps"])
    expect(listed.json.items).toEqual([])
    const db = new DatabaseSync(join(root, ".flows", "control.db"), { readOnly: true })
    try {
      expect(db.prepare("SELECT COUNT(*) AS count FROM control_plans").get()).toEqual({ count: 0 })
    } finally {
      db.close()
    }
  }

  it("plans and executes valid input through the CLI", async () => {
    await expectNoAdmission()
    const planned = await command(["plan", "echo", "--data", "{\"value\":\"\"}"])
    expect(planned.code, planned.stdout).toBe(0)
    expect(planned.json).toMatchObject({ flowId: "echo", inputSummary: "{\"value\":\"\"}" })
    expect(planned.json.nodes.length).toBeGreaterThan(0)
    await expect(access(join(root, "executed.txt"))).rejects.toThrow()
    const started = await command(["flow", "start", "echo", "--data", "{\"value\":\"valid\"}", "--wait"])
    expect(started.code, started.stdout).toBe(0)
    expect(started.json).toMatchObject({ _tag: "Accepted", runId: expect.any(String) })
    const shown = await command(["status", started.json.runId])
    expect(shown.json).toMatchObject({
      _tag: "runs",
      items: [{ runId: started.json.runId, flowId: "echo", status: "completed" }]
    })
    expect(await readFile(join(root, "executed.txt"), "utf8")).toBe("valid")
  }, 120_000)
})
