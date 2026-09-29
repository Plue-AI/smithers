/** The real TUI port composes a file module's action layer with its native host. */
import { expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

it("warms, starts and watches an exported action layer using real filesystem and process services", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tui-module-layer-")))
  const source = resolve(import.meta.dir, "../src")
  const fixture = resolve(import.meta.dir, "../../../packages/smithers/test/fixtures/module-layer/flows")
  try {
    cpSync(fixture, join(root, "flows"), { recursive: true })
    symlinkSync(resolve(import.meta.dir, "../node_modules"), join(root, "node_modules"), "dir")
    const output = join(root, "result.txt")
    // Isolate the only mock from other Bun suites. This explicit offline judge
    // prevents provider/account calls; registry, control, engine and host services stay real.
    const script = `
      import assert from "node:assert/strict"
      import { existsSync, readFileSync } from "node:fs"
      import { mock } from "bun:test"
      import * as ScriptedJudge from "@smthrs/agent/ScriptedJudge"
      import { Schema } from "effect"
      const nodeControl = await import("@smthrs/cli/NodeControl")
      mock.module("@smthrs/cli/NodeControl", () => ({
        ...nodeControl,
        layerSeatEvaluator: () => ScriptedJudge.layerAll
      }))
      const [FlowControl, Host] = await Promise.all([
        import(${JSON.stringify(join(source, "flow-control.ts"))}),
        import(${JSON.stringify(join(source, "host.ts"))})
      ])
      const cwd = ${JSON.stringify(root)}
      const output = ${JSON.stringify(output)}
      const host = Host.make({ cwd, environment: {}, approvals: "all", judge: ScriptedJudge.layerAll })
      const port = FlowControl.make({ cwd, environment: {}, approvals: host.approvals })
      try {
        const listed = await port.discover()
        assert.equal(listed.length, 1)
        assert.equal(listed[0].name, "fixture")
        assert.equal(listed[0].kind, "module")
        assert.equal(existsSync(output), false)
        await port.warm()
        const input = await port.input("fixture")
        assert(input !== undefined)
        assert.equal(Schema.is(input)({ output, value: "child-wrote-this" }), true)
        assert.equal(Schema.is(input)({ value: "child-wrote-this" }), false)
        assert.equal(existsSync(output), false)
        const runId = await port.start(await port.plan("fixture", { output, value: "child-wrote-this" }))
        assert.equal(typeof runId, "string")
        const observed = []
        const settled = await port.watch(runId, (event) => observed.push(event.kind)).done
        assert.equal(settled.kind, "done", JSON.stringify(settled))
        const answer = JSON.parse(settled.answer)
        assert.equal(answer.value, "child-wrote-this")
        assert(Number.isSafeInteger(answer.pid) && answer.pid > 0)
        assert.notEqual(answer.pid, process.pid)
        assert.equal(readFileSync(output, "utf8"), "child-wrote-this")
        assert(observed.includes("control.run.completed"))
        const events = await port.events(runId)
        assert(events.some((event) => event.kind === "control.run.completed"))
        assert(JSON.stringify(events).includes("child-wrote-this"))
        assert.deepEqual(await port.resume(runId), settled)
        console.log("MODULE_LAYER_RECEIPT " + JSON.stringify({ runId, answer, observed }))
      } finally {
        await port.dispose()
        await host.dispose()
      }
    `
    const result = spawnSync(process.execPath, ["-e", script], {
      cwd: resolve(import.meta.dir, ".."),
      env: {
        PATH: process.env.PATH,
        XDG_CONFIG_HOME: join(root, "config"),
        SMITHERS_TUI_SESSION_DIR: join(root, "sessions"),
        AI_GATEWAY_API_KEY: "",
        SMITHERS_REMOTE: ""
      },
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024
    })
    expect({ status: result.status, error: result.error?.message, stderr: result.stderr, stdout: result.stdout })
      .toMatchObject({ status: 0 })
    expect(result.stdout).toContain("MODULE_LAYER_RECEIPT ")
    expect(existsSync(output)).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 150_000)
