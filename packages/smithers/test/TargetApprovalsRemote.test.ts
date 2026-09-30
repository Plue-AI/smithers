/**
 * Build target approvals through a served control plane, end to end: a build
 * leaves a pending revision in the workspace control database, a remote
 * operator lists, denies and grants through `smthrs approvals` against the
 * real `serve` process, and the grant survives that process being killed.
 */
import { spawn, spawnSync } from "node:child_process"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, describe, expect, it } from "vitest"
import * as TargetApprovals from "../src/cli/TargetApprovals.ts"

const scriptedHost = fileURLToPath(new URL("./fixtures/scripted-native-host.ts", import.meta.url))
const executable = fileURLToPath(new URL("../src/bin.ts", import.meta.url))

const roots: Array<string> = []
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

const push = { label: "//images:push", digest: "a".repeat(64) }
const other = { label: "//images:mirror", digest: "b".repeat(64) }

/** A served workspace: its base URL, the operator token it printed, and a hard kill. */
const serve = async (cwd: string, port: number) => {
  const child = spawn(process.execPath, [
    "--no-warnings",
    "--import",
    scriptedHost,
    executable,
    "serve",
    "--port",
    String(port)
  ], {
    cwd,
    env: { ...process.env, HOME: cwd, SMITHERS_REMOTE: "", SMITHERS_TOKEN: "" }
  })
  const exited = new Promise((resolve) => child.once("exit", resolve))
  let banner = ""
  child.stderr.setEncoding("utf8")
  child.stderr.on("data", (chunk: string) => {
    banner += chunk
  })
  const base = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 120_000
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`serve exited early: ${banner}`)
    const token = /approval token\s+([0-9a-f]{64})/.exec(banner)?.[1]
    const ready = token !== undefined && await fetch(`${base}/health`).then((response) => response.ok, () => false)
    if (ready) {
      return {
        base,
        token,
        kill: async () => {
          child.kill("SIGKILL")
          await exited
        }
      }
    }
    if (Date.now() > deadline) throw new Error(`serve never became ready: ${banner}`)
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

/** One `smthrs --json approvals ...` against the served control plane. */
const approvals = (
  cwd: string,
  remote: { readonly base: string; readonly token: string },
  args: ReadonlyArray<string>
) => {
  const result = spawnSync(
    process.execPath,
    ["--no-warnings", "--import", scriptedHost, executable, "--json", "approvals", ...args, "--remote", remote.base],
    {
      cwd,
      encoding: "utf8",
      timeout: 180_000,
      env: { ...process.env, HOME: cwd, SMITHERS_TOKEN: remote.token }
    }
  )
  return {
    status: result.status,
    value: result.stdout.trim() === "" ? undefined : JSON.parse(result.stdout),
    stderr: result.stderr
  }
}

describe("remote build target approvals", { timeout: 480_000 }, () => {
  it("lists, denies and grants through the served control plane, and the grant survives a crash", async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "smithers-target-remote-")))
    roots.push(cwd)
    // What a refused build leaves behind: a pending revision per target.
    expect(await TargetApprovals.store.granted({ root: cwd, ...push })).toBe(false)
    expect(await TargetApprovals.store.granted({ root: cwd, ...other })).toBe(false)
    const port = 42_000 + Math.floor(Math.random() * 8000)

    const first = await serve(cwd, port)
    let listed: ReturnType<typeof approvals>
    try {
      listed = approvals(cwd, first, ["list", "--targets"])
      expect(listed.status, listed.stderr).toBe(0)
      expect(listed.value).toEqual([
        {
          target: push.label,
          revision: push.digest,
          approval: expect.objectContaining({ target: expect.objectContaining({ _tag: "Plan" }) })
        },
        {
          target: other.label,
          revision: other.digest,
          approval: expect.objectContaining({ target: expect.objectContaining({ _tag: "Plan" }) })
        }
      ])

      const mirror = (listed.value as ReadonlyArray<TargetApprovals.PendingTarget>)[1]!
      const denied = approvals(cwd, first, ["deny", JSON.stringify(mirror.approval)])
      expect(denied.status, denied.stderr).toBe(0)

      const wrongRevision = approvals(cwd, first, ["grant", "images:push", "--revision", "c".repeat(64)])
      expect(wrongRevision.status).toBe(1)
      expect(wrongRevision.value).toMatchObject({
        code: "approval_not_found",
        message: `No pending approval for ${push.label} at ${"c".repeat(64)}`
      })

      const granted = approvals(cwd, first, ["grant", "images:push"])
      expect(granted.status, granted.stderr).toBe(0)
      expect(granted.value).toMatchObject({ label: push.label, revision: push.digest, receipt: "Accepted" })

      expect(approvals(cwd, first, ["list", "--targets"]).value).toEqual([])
    } finally {
      await first.kill()
    }

    // The planner reads the same database after the host died.
    expect(await TargetApprovals.store.granted({ root: cwd, ...push })).toBe(true)
    expect(await TargetApprovals.store.granted({ root: cwd, ...other })).toBe(false)

    const second = await serve(cwd, port + 1)
    try {
      expect(approvals(cwd, second, ["list", "--targets"]).value).toEqual([])
      const again = approvals(cwd, second, ["grant", push.label])
      expect(again.status).toBe(1)
      expect(again.value).toMatchObject({
        code: "approval_not_found",
        message: `No pending approval for ${push.label}`
      })
    } finally {
      await second.kill()
    }
  })
})
