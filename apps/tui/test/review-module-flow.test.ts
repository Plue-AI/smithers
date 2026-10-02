/** Actual /flow review launch through the TUI's shared control/catalog port. */
import { expect, it } from "bun:test"
import { spawnSync, execFileSync } from "node:child_process"
import { cpSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
it("discovers, plans, starts and observes ordinary review with shared host services", () => {
 const root = realpathSync(mkdtempSync(join(tmpdir(), "tui-review-flow-")))
 const workspace = resolve(import.meta.dir, "../../..")
 try {
  cpSync(join(workspace, "flows/review"), join(root, "flows/review"), { recursive: true })
  symlinkSync(join(workspace, "flows/node_modules"), join(root, "node_modules"), "dir")
  const git = (args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" })
  git(["init"]); git(["config", "user.email", "review@example.com"]); git(["config", "user.name", "Review"])
  writeFileSync(join(root, ".gitignore"), "node_modules\n.flows/\nconfig/\nsessions/\n.smithers/\n"); writeFileSync(join(root, "file.ts"), "export const n = 1;\n"); git(["add", "file.ts", ".gitignore", "flows"]); git(["-c", "commit.gpgsign=false", "commit", "-m", "base"])
  writeFileSync(join(root, "file.ts"), "export const n = 2;\n")
  const script = `
   import assert from "node:assert/strict"
   import { readFileSync } from "node:fs"
   import { mock } from "bun:test"
   import * as ScriptedJudge from "@smthrs/agent/ScriptedJudge"
   const nodeControl = await import("@smthrs/cli/NodeControl")
   mock.module("@smthrs/cli/NodeControl", () => ({ ...nodeControl, layerSeatEvaluator: () => ScriptedJudge.layerAll }))
   const [FlowControl, Host] = await Promise.all([import(${JSON.stringify(join(workspace, "apps/tui/src/flow-control.ts"))}), import(${JSON.stringify(join(workspace, "apps/tui/src/host.ts"))})])
   const cwd = ${JSON.stringify(root)}
   const host = Host.make({ cwd, environment: {}, approvals: "all", judge: ScriptedJudge.layerAll })
   const port = FlowControl.make({ cwd, environment: {}, approvals: host.approvals })
   try {
    const listed = await port.discover()
    assert(listed.some(flow => flow.name === "review" && flow.kind === "module"))
    await port.warm()
    const runId = await port.start(await port.plan("review", { repo: cwd, runReview: false, narrate: false, verify: false }))
    const result = await port.watch(runId, () => {}).done
    assert.equal(result.kind, "done", JSON.stringify(result))
    const answer = JSON.parse(result.answer)
    assert.equal(answer.review.status, "skipped")
    assert.equal(answer.ui.kind, "html")
    assert(answer.ui.html.includes("file.ts"))
    const disk = readFileSync(answer.walkthrough.artifactPath, "utf8")
    assert.equal(disk, answer.ui.html)
    console.log("REVIEW_SHARED_HOST_RECEIPT " + JSON.stringify({ runId, status: answer.review.status, ui: answer.ui.kind }))
   } finally { await port.dispose(); await host.dispose() }
  `
  const result = spawnSync(process.execPath, ["-e", script], { cwd: root, env: { SMITHERS_WORKSPACE_JJ_EXPORT_BINARY: process.env.SMITHERS_WORKSPACE_JJ_EXPORT_BINARY, HOME: process.env.HOME, USER: process.env.USER, PATH: process.env.PATH, XDG_CONFIG_HOME: join(root, "config"), SMITHERS_TUI_SESSION_DIR: join(root, "sessions"), SMITHERS_REMOTE: "", AI_GATEWAY_API_KEY: "" }, encoding: "utf8", timeout: 240000, maxBuffer: 4 * 1024 * 1024 })
  expect({ status: result.status, error: result.error?.message, stderr: result.stderr, stdout: result.stdout }).toMatchObject({ status: 0 })
  expect(result.stdout).toContain("REVIEW_SHARED_HOST_RECEIPT ")
 } finally { rmSync(root, { recursive: true, force: true }) }
}, 270000)
