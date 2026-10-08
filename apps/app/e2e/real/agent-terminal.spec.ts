import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { stripVTControlCharacters } from "node:util"
import { test } from "./support"
import { SOCKET_TICKET_PATH } from "@smthrs/rpc/ApplicationAuth"
import { scenario } from "./coverage/types"
import { command } from "./support/test"
import { gatewayCall } from "./flow-execution/production"
import { createTodo, expect, attachJson, required } from "./todo/reference"
import { withJ10Install } from "./github-j10/install"

// C-J3-10 uses the installed TODO dispatcher and its bound Bash. The scratch
// repository must have the fixture below as its test script. No route, model
// tool, terminal transport, participant, or output is replaced by this test.
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}

test("C-J3-10 TODO Bash streams through the agent's read-only Terminal card", scenario("journey.agent-terminal", {
  capabilities: ["install"],
  coverage: ["host:production", "host:local", "action:terminal.watch", "door:slash", "path:success", "path:permission", "evidence:agent-terminal"]
}), async ({ browser }, info) => {
  test.setTimeout(900_000)
  const fixture = readFileSync(resolve(info.config.rootDir, "fixtures/agent-terminal.mjs"), "utf8")
  // Reuse the composed install's production router and GitHub fake. This also
  // runs on the native host, with its real microVM; no live GitHub writes.
  const descriptor = JSON.parse(readFileSync(required("SMITHERS_J10_COMPOSED_HOST"), "utf8"))
  const github = new URL(descriptor.github.url)
  expect(github.protocol).toBe("http:")
  expect(["127.0.0.1", "[::1]"]).toContain(github.hostname)
  expect(descriptor.commit).toBe(required("SMITHERS_REAL_E2E_BUILD_SHA"))
  await withJ10Install(browser, info, async f => {
    const { page, context } = f.members.Ben
    expect(f.kind).toBe("composed")
    const main = await f.github.main()
    const pkg = JSON.parse(await f.github.file(main, "package.json"))
    expect(pkg.scripts.test).toBe("node agent-terminal-fixture.mjs")
    expect(await f.github.file(main, "agent-terminal-fixture.mjs")).toBe(fixture)
    const frames: { at: number; bytes: string }[] = []
    let socketURL = ""
    page.on("websocket", socket => {
      if (!socket.url().includes("/terminal") || socketURL) return
      socketURL = socket.url()
      socket.on("framereceived", frame => {
        // Binary frames are PTY bytes. JSON control messages are not output.
        if (typeof frame.payload !== "string") frames.push({ at: Date.now(), bytes: frame.payload.toString("utf8") })
      })
    })
    const output = () => frames.map(frame => frame.bytes).join("")
    await createTodo(page, "Run the following checks with your bash tool, without editing package.json: first `sleep 20`, then `pnpm test`, then `printf AGENT_TERMINAL_SECOND`. Report the literal exit statuses. The failing test is intentional; do not repair it or rerun it. Keep this TODO unmerged.")
    let binding: { workspace_id: string; request_run_id: string } | undefined
    await expect.poll(() => {
      const rows = f.sql("SELECT workspace_id, request_run_id FROM mythical_items WHERE number=1")
      binding = rows[0]
      return Boolean(binding?.workspace_id && binding?.request_run_id)
    }, { timeout: 180_000 }).toBe(true)
    await command(page, "/branch T1")
    const branch = page.locator(".branch-view").last()
    await expect(branch).toBeVisible()
    await branch.getByRole("tab", { name: /Terminals/ }).click()
    const terminalRow = branch.locator(".branch-list li").filter({ has: page.locator('[title*="Coding agent"]') })
    await expect(terminalRow).toHaveCount(1, { timeout: 180_000 })
    const terminal = terminalRow.getByRole("button").first()
    await expect(terminal).toBeVisible({ timeout: 180_000 })
    const title = await terminal.innerText()
    await terminal.press("Enter")
    const card = page.locator(".terminal-view").last()
    await expect(card.locator(".terminal-person")).toHaveAttribute("title", /Coding agent for Ben/)
    await expect(card.locator(".terminal-output > div")).toHaveAttribute("inert")
    await expect(card.getByText("Watching", { exact: true })).toBeVisible()
    await expect.poll(() => socketURL).not.toBe("")
    const sessionURL = new URL(socketURL)
    // Measure only fresh traffic: the first check must start after attachment,
    // otherwise replay could incorrectly pass the one-second streaming check.
    expect(output()).not.toContain("pnpm test")
    await expect.poll(output, { timeout: 180_000, intervals: [25] }).toContain("AGENT_TERMINAL_FIRST")
    let commands = ""
    const commandFrame = frames.find(frame => {
      commands += frame.bytes
      return commands.includes("pnpm test")
    })
    expect(commandFrame, "literal command must be streamed before its output").toBeDefined()
    let accumulated = ""
    const firstLine = frames.find(frame => {
      accumulated += frame.bytes
      return accumulated.includes("AGENT_TERMINAL_FIRST")
    })
    expect(firstLine).toBeDefined()
    expect(firstLine!.at).toBeGreaterThanOrEqual(commandFrame!.at)
    expect(firstLine!.at - commandFrame!.at).toBeLessThanOrEqual(1000)
    expect(output()).not.toContain("AGENT_TERMINAL_LAST")

    const dropped = async () => {
      const response = await f.members.Owner.context.request.get(new URL("/api/install/metrics", page.url()).href)
      expect(response.status()).toBe(200)
      const match = (await response.text()).match(/^smithers_terminal_input_dropped_total(?:\{[^\n]*\})?\s+(\d+)/m)
      expect(match).not.toBeNull()
      return Number(match![1])
    }
    const before = await dropped()
    const ticket = await context.request.post(new URL(SOCKET_TICKET_PATH, page.url()).href, {
      headers: { Origin: new URL(page.url()).origin }
    })
    expect(ticket.ok()).toBe(true)
    const attackURL = new URL(sessionURL)
    attackURL.searchParams.set("ticket", (await ticket.json()).ticket)
    await page.evaluate(async url => {
      await new Promise<void>((resolve, reject) => {
        const socket = new WebSocket(url, "terminal")
        const timer = setTimeout(() => { socket.close(); reject(new Error("watcher attachment timed out")) }, 5000)
        socket.onerror = () => { clearTimeout(timer); reject(new Error("watcher attachment refused")) }
        socket.onopen = () => {
          socket.send(new TextEncoder().encode("echo AGENT_TERMINAL_INJECTED\n"))
          setTimeout(() => { clearTimeout(timer); socket.close(); resolve() }, 250)
        }
      })
    }, attackURL.href)
    await expect.poll(dropped).toBeGreaterThanOrEqual(before + 1)
    await expect.poll(output, { timeout: 60_000 }).toContain("AGENT_TERMINAL_LAST")
    await expect.poll(output, { timeout: 180_000 }).toContain("AGENT_TERMINAL_SECOND")
    expect(output()).not.toContain("AGENT_TERMINAL_INJECTED")
    // output() reads only the first UI socket: the second command above must
    // arrive there, even if another session or the raw watcher was opened.
    await command(page, "/branch T1")
    const repeatedBranch = page.locator(".branch-view").last()
    await repeatedBranch.getByRole("tab", { name: /Terminals/ }).click()
    await expect(repeatedBranch.getByRole("button", { name: title, exact: true })).toHaveCount(1)

    let result: Record<string, unknown> | undefined
    await expect.poll(async () => {
      const answer = await gatewayCall(page, context.request, f.repo, "Projection.Snapshot", {
        selector: { _tag: "run-events", runId: binding!.request_run_id }
      }, binding!.workspace_id)
      const encoded = record(answer.payload).rows
      expect(Array.isArray(encoded)).toBe(true)
      const rows = (encoded as Record<string, unknown>[]).map(row => {
        const payload = record(row.payload)
        if (row.kind !== "control.engine.event" || payload.eventType !== "flows.harness.call-fact.v1") return row
        const fact = record(payload.payload)
        expect(payload.version).toBe(1)
        expect(fact.version).toBe(1)
        expect(["invoked", "settled"]).toContain(fact.phase)
        return { ...row, kind: fact.phase === "invoked" ? "control.agent.cell-call-started" : "control.agent.cell-call-settled", payload: fact }
      })
      const starts = (rows as Record<string, unknown>[]).filter(row => row.kind === "control.agent.cell-call-started")
      const started = starts.find(row => record(record(row.payload).input).command === "pnpm test")
      if (!started) return false
      const callId = record(started.payload).callId
      expect(typeof callId).toBe("string")
      const settled = (rows as Record<string, unknown>[]).find(row =>
        row.kind === "control.agent.cell-call-settled" && record(row.payload).callId === callId)
      if (!settled) return false
      expect(record(settled.payload).outcome).toBe("success")
      result = record(record(settled.payload).value)
      const second = starts.find(row => record(record(row.payload).input).command === "printf AGENT_TERMINAL_SECOND")
      if (!second) return false
      const secondId = record(second.payload).callId
      expect(typeof secondId).toBe("string")
      const secondResult = rows.find(row => row.kind === "control.agent.cell-call-settled" && record(row.payload).callId === secondId)
      if (!secondResult) return false
      expect(record(secondResult.payload).value).toMatchObject({ exitCode: 0, stdout: "AGENT_TERMINAL_SECOND", stderr: "" })
      return true
    }, { timeout: 180_000 }).toBe(true)
    expect(result).toMatchObject({ exitCode: 7, stderr: "", stdoutTruncated: false, stderrTruncated: false })
    expect(result!.stdout).toEqual(expect.stringContaining("AGENT_TERMINAL_UID=19999\nAGENT_TERMINAL_FIRST\n"))
    expect(String(result!.stdout)).toContain("AGENT_TERMINAL_LAST")
    expect(result!.stdout).not.toContain("\x1b")
    // Use an independent ANSI oracle, never the production capture parser.
    const plain = stripVTControlCharacters(output()).replaceAll("\r\n", "\n")
    expect(plain).toContain(String(result!.stdout))
    await attachJson(info, "agent-terminal-tool-result", result)
    await attachJson(info, "agent-terminal-stream", frames)
    await attachJson(info, "agent-terminal-session", { path: sessionURL.pathname, ...binding, dropped: await dropped() - before })
  })
})
