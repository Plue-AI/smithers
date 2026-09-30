/** File-flow payload failures are refused before durable plan or run admission. */
import { execFile } from "node:child_process"
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { expect, it } from "vitest"

const execute = promisify(execFile)
const bin = fileURLToPath(new URL("../src/bin.ts", import.meta.url))
const modules = fileURLToPath(new URL("../node_modules", import.meta.url))

it("rejects invalid file-flow payloads before creating plans or runs and accepts valid input", async () => {
  const root = await mkdtemp(join(tmpdir(), "smithers-file-input-cli-"))
  try {
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
    const command = async (args: ReadonlyArray<string>) => {
      const result = await execute(process.execPath, ["--no-warnings", bin, ...args, "--root", root, "--json"], {
        cwd: root,
        env: {
          PATH: process.env["PATH"],
          HOME: join(root, "home"),
          XDG_CONFIG_HOME: join(root, "config"),
          SMITHERS_WORKSPACE_JJ_EXPORT_BINARY: process.env["SMITHERS_WORKSPACE_JJ_EXPORT_BINARY"]
        },
        timeout: 60_000
      }).then(
        (result) => ({ ...result, code: 0 }),
        (error) => ({ stdout: error.stdout, stderr: error.stderr, code: error.code })
      )
      return { ...result, json: JSON.parse(result.stdout) }
    }
    const catalogShown = await command(["flow", "show", "echo"])
    const catalogListed = await command(["flow", "list"])
    expect(catalogShown.code, catalogShown.stdout + catalogShown.stderr).toBe(0)
    expect(catalogListed.code, catalogListed.stdout + catalogListed.stderr).toBe(0)
    await expect(access(join(root, "module-evaluated.txt"))).rejects.toThrow()
    for (const input of [{}, { value: 42 }, { value: null }, { value: false }, { value: ["hello"] }]) {
      for (const verb of ["plan", "start"]) {
        const result = await command(["flow", verb, "echo", "--data", JSON.stringify(input)])
        expect(result.code, result.stdout).not.toBe(0)
        expect(result.json, `${verb} ${JSON.stringify(input)}: ${result.stdout} ${result.stderr}`).toMatchObject({
          code: "InvalidInput"
        })
        expect(result.json.message).toContain("value")
        expect(result.stdout).not.toContain("\"planId\"")
        expect(result.stdout).not.toContain("\"runId\"")
      }
    }
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
    const refined = await command(["flow", "show", "echo"])
    expect(refined.code, refined.stdout + refined.stderr).toBe(0)
    expect(refined.json.inputSchema).toBeUndefined()
    await expect(access(join(root, "module-evaluated.txt"))).rejects.toThrow()
    for (const verb of ["plan", "start"]) {
      const refused = await command(["flow", verb, "echo", "--data", "{\"value\":\"x\"}"])
      expect(refused.code, refused.stdout + refused.stderr).not.toBe(0)
      expect(refused.json).toMatchObject({ code: "InvalidInput" })
      expect(refused.json.message).toContain("value")
      expect(refused.stdout).not.toMatch(/"(?:planId|runId)"/u)
    }
    await writeFile(file, original)
    const listed = await command(["runs", "list"])
    expect(listed.json.items).toEqual([])
    const db = new DatabaseSync(join(root, ".flows", "control.db"), { readOnly: true })
    try {
      expect(db.prepare("SELECT COUNT(*) AS count FROM control_plans").get()).toEqual({ count: 0 })
    } finally {
      db.close()
    }
    const planned = await command(["flow", "plan", "echo", "--data", "{\"value\":\"\"}"])
    expect(planned.code, planned.stdout).toBe(0)
    expect(planned.json).toMatchObject({ flowId: "echo", inputSummary: "{\"value\":\"\"}" })
    expect(planned.json.nodes.length).toBeGreaterThan(0)
    await expect(access(join(root, "executed.txt"))).rejects.toThrow()
    const started = await command(["flow", "start", "echo", "--data", "{\"value\":\"valid\"}", "--wait"])
    expect(started.code, started.stdout).toBe(0)
    expect(started.json).toMatchObject({ _tag: "Accepted", runId: expect.any(String) })
    const shown = await command(["runs", "show", started.json.runId])
    expect(shown.json).toMatchObject({ status: "completed" })
    expect(shown.json.diagnosis.nativeResolution.result.text).toBe("valid")
    await expect(access(join(root, "executed.txt"))).resolves.toBeUndefined()
    for (
      const [verb, flow] of [
        ["show", catalogShown.json],
        ["list", catalogListed.json.items.find((item: { flowId: string }) => item.flowId === "echo")]
      ]
    ) {
      expect.soft(flow, `flow ${verb} input metadata`).toMatchObject({
        flowId: "echo",
        inputSchema: { schema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } }
      })
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 120_000)
