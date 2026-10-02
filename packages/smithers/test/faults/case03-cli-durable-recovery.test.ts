/** Real CLI + real engine/store; model and completion-evaluator HTTP responses are recorded. */
import { isAlive } from "@smthrs/testing/Faults"
import { spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"

const executable = fileURLToPath(new URL("../../src/bin.ts", import.meta.url))
const preload = new URL("./fixtures/recorded-provider.mjs", import.meta.url).href

const recover = async (mode: "approval" | "timer" | "checkpoint") => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `smithers-cli-${mode}-recovery-`)))
  const recording = join(root, "recording")
  mkdirSync(recording)
  const environment: NodeJS.ProcessEnv = {}
  for (const key of ["PATH", "TMPDIR", "SystemRoot", "WINDIR", "SMITHERS_WORKSPACE_JJ_EXPORT_BINARY"]) {
    if (process.env[key] !== undefined) environment[key] = process.env[key]
  }
  Object.assign(environment, {
    NODE_OPTIONS: `--import=${preload}`,
    SMITHERS_TEST_RECORDING: recording,
    // Completion judgments run only on subscription seats (ade54a831f), so the
    // agent and its judge share the ChatGPT seat behind the recorded model proxy.
    SMITHERS_OPENAI_AUTH: "chatgpt",
    SMITHERS_MODEL_PROXY_URL: "https://model-proxy.recorded.invalid",
    OPENAI_API_KEY: "recorded-fixture-not-a-real-key"
  })
  const invoke = (...args: Array<string>) => {
    const result = spawnSync(process.execPath, [executable, ...args, "--json"], {
      cwd: root,
      env: environment,
      encoding: "utf8",
      timeout: 45_000,
      maxBuffer: 2 * 1024 * 1024
    })
    expect(result.error, `${args[0]}: ${result.stderr}`).toBeUndefined()
    return result
  }
  const json = (...args: Array<string>) => {
    const result = invoke(...args)
    expect(result.status, `${args.join(" ")}: ${result.stderr}\n${result.stdout}`).toBe(0)
    return JSON.parse(result.stdout)
  }
  const records = (): Array<{ pid: number; ppid?: number; event: string; verb?: string; code?: number }> => {
    const path = join(recording, "processes.jsonl")
    return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : []
  }
  let detachedPid: number | undefined
  let detachedStopped = false
  try {
    expect(spawnSync("git", ["init", "--quiet"], { cwd: root }).status).toBe(0)
    writeFileSync(join(root, ".gitignore"), ".flows/\nrecording/\n")
    if (mode === "checkpoint") {
      expect(spawnSync("git", ["config", "user.name", "Recorded Test"], { cwd: root }).status).toBe(0)
      expect(spawnSync("git", ["config", "user.email", "recorded@example.invalid"], { cwd: root }).status).toBe(0)
      writeFileSync(join(root, "ledger.txt"), "committed baseline\n")
      expect(spawnSync("git", ["add", "ledger.txt"], { cwd: root }).status).toBe(0)
      expect(spawnSync("git", ["commit", "--quiet", "-m", "baseline"], { cwd: root }).status).toBe(0)
      // Capture an uncommitted tracked change, not just HEAD. A replacement
      // process must recover this exact tree without recapturing the live one.
      writeFileSync(join(root, "ledger.txt"), "pinned working tree\n")
    }
    mkdirSync(join(root, "flows", "recovery"), { recursive: true })
    writeFileSync(
      join(root, "flows", "recovery", "flow.mdx"),
      [
        "---",
        "name: recovery",
        "description: Exercises a recorded cell and durable recovery.",
        "model: openai:gpt-4o-mini",
        mode === "checkpoint" ? "capabilities: [\"fs:read:/**\"]" : "capabilities: []",
        "---",
        "Perform the recorded recovery exercise."
      ].join("\n")
    )
    writeFileSync(
      join(recording, "cell.txt"),
      (mode === "checkpoint"
        ? [
          "const cp = await ctx.checkpoint()",
          "await ctx.call(\"ask\", { question: \"Read the saved tree after restart?\", options: [\"yes\", \"no\"] })",
          "const pinned = await ctx.call(\"read\", { path: \"ledger.txt\" }, { at: cp })",
          "const live = await ctx.call(\"read\", { path: \"ledger.txt\" })",
          "ctx.done({ pinned: pinned.content, live: live.content })"
        ]
        : mode === "approval"
        ? [
          "const decision = await ctx.call(\"ask\", { question: \"Resume this recorded run?\", options: [\"yes\", \"no\"] })",
          "ctx.done({ approved: decision.approved })"
        ]
        : [
          // Above the real agent's 60-second in-memory wait threshold.
          "await ctx.call(\"wait\", { seconds: 65, reason: \"CLI durable timer recovery\" })",
          "ctx.done(\"awake\")"
        ]).join("\n")
    )
    const launched = invoke("up", "recovery", "-d")
    expect(launched.status, launched.stderr).toBe(0)
    const receipt = JSON.parse(launched.stdout)
    expect(receipt).toMatchObject({ detached: true, runId: expect.stringMatching(/^run-/) })
    detachedPid = records().find((entry) => entry.ppid === launched.pid && entry.verb === "run")?.pid
    expect(detachedPid).toBeDefined()

    const engineRow = () => {
      const database = new DatabaseSync(join(root, ".flows", "engine.db"), { readOnly: true })
      try {
        return database.prepare(
          "SELECT status, waiting_reason, cancel_requested_at_ms FROM flows_runs WHERE run_id = ?"
        )
          .get(receipt.runId)
      } finally {
        database.close()
      }
    }
    const waitFor = async (predicate: () => boolean, description: string | (() => string), timeoutMs = 45_000) => {
      const deadline = Date.now() + timeoutMs
      while (!predicate()) {
        if (Date.now() >= deadline) {
          throw new Error(
            `${typeof description === "string" ? description : description()}: ${readFileSync(receipt.logFile, "utf8")}`
          )
        }
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    }
    if (mode !== "timer") {
      await waitFor(
        () => records().some((entry) => entry.pid === detachedPid && entry.event === "exit"),
        "Detached approval process did not exit"
      )
      expect(
        records().find((entry) => entry.pid === detachedPid && entry.event === "exit")?.code,
        readFileSync(receipt.logFile, "utf8")
      ).toBe(3)
      await waitFor(() => !isAlive(detachedPid!), "Detached approval process remains alive")
      detachedStopped = true
    } else {
      // A timer intentionally keeps the CLI alive, unlike an approval. Crash
      // the real process only once the actual engine wait is committed. The
      // live CLI keeps polling its parked run, and each poll re-drives it, so
      // the park is read again with the process stopped: a kill that lands
      // mid-poll would leave the run claimed rather than parked.
      const parked = () => engineRow()?.waiting_reason === "timer" && engineRow()?.status === "suspended"
      await waitFor(
        () => {
          if (!parked()) return false
          process.kill(detachedPid!, "SIGSTOP")
          if (parked()) return true
          process.kill(detachedPid!, "SIGCONT")
          return false
        },
        () =>
          `Agent did not persist a timer park; row=${JSON.stringify(engineRow())}; processes=${
            JSON.stringify(records())
          }`,
        45_000
      )
      expect(isAlive(detachedPid!)).toBe(true)
      process.kill(detachedPid!, "SIGKILL")
      await waitFor(() => !isAlive(detachedPid!), "Killed timer process remains alive")
      detachedStopped = true
    }
    expect(engineRow()).toMatchObject({
      status: "suspended",
      waiting_reason: mode === "timer" ? "timer" : "approval",
      cancel_requested_at_ms: null
    })
    let checkpoint: { id: string; ref: string } | undefined
    if (mode !== "timer") {
      const events = json("logs", receipt.runId)
      if (mode === "checkpoint") {
        const minted = events.filter((event: { kind: string }) => event.kind === "control.agent.checkpoint-minted")
        expect(minted).toHaveLength(1)
        checkpoint = minted[0].payload
        expect(checkpoint).toMatchObject({ id: expect.any(String), ref: expect.stringMatching(/^[a-f0-9]{40,64}$/) })
        const snapshot = spawnSync("git", ["show", `${checkpoint!.ref}:ledger.txt`], {
          cwd: root,
          encoding: "utf8"
        })
        expect(snapshot.status, snapshot.stderr).toBe(0)
        expect(snapshot.stdout).toBe("pinned working tree\n")
        // The original CLI is confirmed dead above. Only the live file moves;
        // no journal, checkpoint, approval, or engine state is manufactured.
        writeFileSync(join(root, "ledger.txt"), "live tree after restart\n")
      }
      const requested = events.filter((event: { kind: string }) => event.kind === "control.approval.requested")
      expect(requested).toHaveLength(1)
      const approval = requested[0].payload.payload
      expect(approval.target).toMatchObject({ _tag: "Node", runId: receipt.runId })
      json("approve", JSON.stringify(approval))
    } else {
      const clocks = () => {
        const database = new DatabaseSync(join(root, ".flows", "engine.db"), { readOnly: true })
        try {
          return database.prepare(
            "SELECT due_at_ms, completed_at_ms FROM flows_clock_deadlines WHERE execution_id = ?"
          ).all(receipt.runId)
        } finally {
          database.close()
        }
      }
      const pending = clocks()
      expect(pending).toHaveLength(1)
      expect(pending[0]?.completed_at_ms).toBeNull()
      const dueAt = Number(pending[0]?.due_at_ms)
      expect(dueAt).toBeGreaterThan(Date.now())
      expect(dueAt - Date.now()).toBeLessThanOrEqual(65_000)
      // Let the original persisted deadline pass with no executor alive.
      // Never edit a clock row or simulate completion through SQL.
      while (Date.now() <= dueAt) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(500, dueAt - Date.now() + 1)))
      }
      expect(clocks()).toEqual(pending)
      expect(json("run", "--resume", receipt.runId)).toMatchObject({ _tag: "Accepted", runId: receipt.runId })
      expect(clocks()).toEqual([{ due_at_ms: dueAt, completed_at_ms: expect.any(Number) }])
      expect(Number(clocks()[0]?.completed_at_ms)).toBeGreaterThanOrEqual(dueAt)
    }
    expect(engineRow()).toMatchObject({ status: "completed", waiting_reason: null, cancel_requested_at_ms: null })
    expect(json("run", "--resume", receipt.runId)).toMatchObject({ _tag: "Terminal", status: "completed" })
    expect(readFileSync(join(recording, "requests.jsonl"), "utf8").trim().split("\n")).toHaveLength(1)
    expect(
      readFileSync(join(recording, "evaluations.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line))
    )
      .toEqual([{
        pid: expect.any(Number),
        questions: { complete: "boolean", overclaims: "boolean", invented: "boolean" }
      }])
    const settled = json("logs", receipt.runId)
    const resolved = settled.filter((event: { kind: string }) => event.kind === "control.agent.resolved")
    expect(resolved).toHaveLength(1)
    if (mode === "checkpoint") {
      // Read pages contain whole lines without a final separator; JSON output
      // is canonicalized, so compare decoded values rather than key order.
      expect(JSON.parse(resolved[0].payload.text)).toEqual({
        pinned: "pinned working tree",
        live: "live tree after restart"
      })
      expect(settled.filter((event: { kind: string }) => event.kind === "control.agent.checkpoint-minted"))
        .toMatchObject([{ payload: checkpoint }])
      expect(readFileSync(join(root, "ledger.txt"), "utf8")).toBe("live tree after restart\n")
      expect(existsSync(join(root, ".flows-checkpoints", checkpoint!.id))).toBe(false)
      const worktrees = spawnSync("git", ["worktree", "list", "--porcelain"], { cwd: root, encoding: "utf8" })
      expect(worktrees.status, worktrees.stderr).toBe(0)
      expect(worktrees.stdout).not.toContain(".flows-checkpoints")
    } else {
      expect(resolved).toMatchObject([{ payload: { text: mode === "approval" ? "{\"approved\":true}" : "awake" } }])
    }
    expect(settled.filter((event: { kind: string }) => event.kind === "control.run.completed")).toHaveLength(1)
    expect(settled.some((event: { kind: string }) => event.kind === "control.run.cancelled")).toBe(false)
  } finally {
    // Only a process spawned by this fixture is eligible for cleanup.
    if (
      detachedPid !== undefined && !detachedStopped &&
      !records().some((entry) => entry.pid === detachedPid && entry.event === "exit")
    ) {
      try {
        process.kill(detachedPid, "SIGKILL")
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
      }
    }
    if (process.env.FAULT_3367_RECEIPTS) {
      mkdirSync(process.env.FAULT_3367_RECEIPTS, { recursive: true })
      cpSync(root, join(process.env.FAULT_3367_RECEIPTS, basename(root)), { recursive: true })
    }
    rmSync(root, { recursive: true, force: true })
  }
}

it("recovers a real agent approval after the detached CLI process exits", () => recover("approval"), 180_000)
it("resumes a real agent timer after its deadline passes without a CLI process", () => recover("timer"), 180_000)
it("reads a pinned working tree through a real agent cell after CLI restart", () => recover("checkpoint"), 180_000)

it("blocks unrecorded provider requests in the child-process fixture", () => {
  const recording = realpathSync(mkdtempSync(join(tmpdir(), "smithers-recording-network-")))
  try {
    const script = [
      `import { Agent } from ${JSON.stringify(import.meta.resolve("@effect/platform-node/Undici"))}`,
      "import assert from \"node:assert/strict\"",
      "const agent = new Agent()",
      "try {",
      "  for (const origin of [\"https://model-proxy.recorded.invalid\", \"https://api.openai.com\", \"https://unexpected.invalid\"]) {",
      "    await assert.rejects(agent.request({ origin, path: \"/unrecorded\", method: \"GET\" }),",
      "      { code: \"UND_MOCK_ERR_MOCK_NOT_MATCHED\" })",
      "  }",
      "  await assert.rejects(fetch(\"https://api.openai.com\"), /Unexpected fetch/)",
      "} finally { await agent.close() }"
    ].join("\n")
    const result = spawnSync(process.execPath, ["--import", preload, "--input-type=module", "--eval", script], {
      env: { SMITHERS_TEST_RECORDING: recording },
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 64 * 1024
    })
    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr).toBe(0)
    expect(existsSync(join(recording, "requests.jsonl"))).toBe(false)
    expect(existsSync(join(recording, "evaluations.jsonl"))).toBe(false)
  } finally {
    rmSync(recording, { recursive: true, force: true })
  }
})
