/** File-flow payload failures are refused before durable plan or run admission. */
import { execFile } from "node:child_process"
import { access, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
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
    await writeFile(join(root, "flows", "echo", "flow.ts"), `
import { Action, Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Effect, Schema } from "effect"
import { writeFileSync } from "node:fs"
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
`)
    const command = async (args: ReadonlyArray<string>) => {
      const result = await execute(process.execPath, ["--no-warnings", bin, ...args, "--root", root, "--json"], {
        cwd: root,
        env: { PATH: process.env["PATH"], HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "config") },
        timeout: 60_000
      }).then((result) => ({ ...result, code: 0 }), (error) => ({ stdout: error.stdout, stderr: error.stderr, code: error.code }))
      return { ...result, json: JSON.parse(result.stdout) }
    }
    for (const input of [{}, { value: 42 }, { value: null }, { value: false }, { value: ["hello"] }]) {
      for (const verb of ["plan", "start"]) {
        const result = await command(["flow", verb, "echo", "--data", JSON.stringify(input)])
        expect(result.code, result.stdout).not.toBe(0)
        expect(result.json, `${verb} ${JSON.stringify(input)}: ${result.stdout} ${result.stderr}`).toMatchObject({ code: "InvalidInput" })
        expect(result.json.message).toContain("value")
        expect(result.stdout).not.toContain('"planId"')
        expect(result.stdout).not.toContain('"runId"')
      }
    }
    const listed = await command(["runs", "list"])
    expect(listed.json.items).toEqual([])
    const db = new DatabaseSync(join(root, ".flows", "control.db"), { readOnly: true })
    try {
      expect(db.prepare("SELECT COUNT(*) AS count FROM control_plans").get()).toEqual({ count: 0 })
    } finally {
      db.close()
    }
    const planned = await command(["flow", "plan", "echo", "--data", '{"value":""}'])
    expect(planned.code, planned.stdout).toBe(0)
    expect(planned.json).toMatchObject({ flowId: "echo", inputSummary: '{"value":""}' })
    expect(planned.json.nodes.length).toBeGreaterThan(0)
    await expect(access(join(root, "executed.txt"))).rejects.toThrow()
    const started = await command(["flow", "start", "echo", "--data", '{"value":"valid"}', "--wait"])
    expect(started.code, started.stdout).toBe(0)
    expect(started.json).toMatchObject({ _tag: "Accepted", runId: expect.any(String) })
    const shown = await command(["runs", "show", started.json.runId])
    expect(shown.json).toMatchObject({ status: "completed" })
    expect(shown.json.diagnosis.nativeResolution.result.text).toBe("valid")
    await expect(access(join(root, "executed.txt"))).resolves.toBeUndefined()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 120_000)
