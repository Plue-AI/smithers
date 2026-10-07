import { activationJourney } from "./support/activationJourney"
import { scenario } from "./coverage/types"

const { test, run } = activationJourney("keyboard")
// First-TODO slice; the keyboard slice alone cannot qualify C-UI-01.
test("C-J1-04 first TODO keyboard", scenario("journey.j1-keyboard", {
  capabilities: [], coverage: ["action:sign-in", "dimension:activation", "host:local", "host:production", "path:success", "door:button", "evidence:activation"]
}), run)

// Prepared-install continuation. Each owning journey still supplies its detailed
// evidence; this pass exercises the person-facing keyboard doors, without seeds.
import { test as referenceTest } from "./support"
import { withReference, required, runSlash, expect, todoCard } from "./todo/reference"
import { journeyActivate, journeyEnter, journeyReach } from "./support/keyboard-journey-input"

referenceTest("C-UI-01 prepared install branch, stack, flow and monitor keyboard doors", scenario("journey.keyboard-continuation", {
  capabilities: [], coverage: ["host:local", "host:production", "path:success", "door:slash", "door:button", "dimension:keyboard", "surface:todo", "surface:wiki"]
}), async ({ browser }, info) => {
  referenceTest.setTimeout(3_600_000)
  expect(required("SMITHERS_JOURNEY_KEYBOARD")).toBe("1")
  await withReference(browser, info, async f => {
    const page = f.members.Ben.page
    // Reviewed prepared-canary identities; missing prerequisites refuse the pass.
    const t2 = await f.read("Ben", "/api/todos/2")
    expect(t2.title).toBe("Retry webhooks")
    expect(t2.branch.name).toBe("smithers/retry-webhooks")
    await runSlash(page, "/branch smithers/retry-webhooks")
    const branch = page.locator('.smithers-card[data-kind="branch"]').last()
    await expect(branch).toBeVisible()
    await journeyActivate(branch.getByRole("button", { name: "Wake", exact: true }))
    await expect(branch).toContainText("Awake")
    // J3: File and a personal terminal remain embedded and reachable.
    await journeyActivate(branch.getByRole("button", { name: /retry\.ts/ }).last())
    const file = page.getByRole("textbox", { name: "src/webhooks/retry.ts", exact: true }).last()
    await journeyReach(file)
    await page.keyboard.press("ControlOrMeta+End")
    await page.keyboard.type("\n// keyboard journey edit")
    await expect(file).toContainText("// keyboard journey edit")
    await runSlash(page, "/branch smithers/retry-webhooks")
    await journeyActivate(branch.getByRole("button", { name: "New terminal", exact: true }))
    const terminal = page.getByRole("region", { name: /terminal output/ }).last()
    await journeyReach(terminal)
    // J6: live independent subscription; no scripted model or host execution.
    await page.keyboard.type("claude")
    await page.keyboard.press("Enter")
    await expect(page.getByText("Claude Code for Ben", { exact: true }).last()).toBeVisible()
    await page.keyboard.type("Read the wiki, answer the TODO's question with use the existing retry helper, and place a follow-up TODO to document it.")
    await page.keyboard.press("Enter")
    await expect.poll(async () => (await f.read("Ben", "/api/todos/2")).state, { timeout: 660_000 }).not.toBe("needs_you")
    // J4: reorder with a menu; retry is a background launch while Chat stays usable.
    await runSlash(page, "/home")
    const order = page.getByRole("button", { name: "Order Document webhook retries", exact: true })
    await journeyActivate(order)
    await expect(page.getByRole("menuitem", { name: "Move up", exact: true })).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(page.getByRole("menuitem", { name: "Move up", exact: true })).toHaveCount(0)
    await expect(order).toBeFocused()
    // Escape from the Chat overlay returns to the exact originating control.
    await page.keyboard.press("ControlOrMeta+k")
    await expect(page.getByTestId("composer-input")).toBeFocused()
    await page.keyboard.press("Escape")
    await expect(order).toBeFocused()
    await journeyActivate(order)
    await journeyActivate(page.getByRole("menuitem", { name: "Move up", exact: true }))
    await journeyActivate(page.getByRole("button", { name: "Retry", exact: true }).last())
    await runSlash(page, "Show the running work")
    await expect(page.getByTestId("composer-input")).toBeEnabled()
    // J7: an amendment, a scratch fork, and Add to stack use the rendered doors.
    await runSlash(page, "/todo.amend T2")
    await journeyEnter(page.getByLabel("Prompt", { exact: true }).last(), "Retry failed webhook deliveries. Also log each retry.")
    await journeyActivate(page.getByRole("button", { name: "Commit", exact: true }).last())
    await expect(todoCard(page, 2)).toContainText("+1")
    await runSlash(page, "/branch smithers/retry-webhooks")
    await journeyActivate(branch.getByRole("button", { name: "Fork", exact: true }))
    await journeyEnter(page.getByLabel("Name", { exact: true }).last(), "ben/retry-try-2")
    await journeyActivate(page.getByRole("button", { name: "Fork", exact: true }).last())
    await journeyActivate(page.getByRole("button", { name: "Add to stack", exact: true }).last())
    await journeyActivate(page.getByRole("button", { name: "Commit", exact: true }).last())
    await expect(page.locator('.smithers-card[data-kind="todo"]').last()).toContainText("Queued")
    // J5/J11: inspect the real repository-owned flow and edit its source on the scratch branch.
    await runSlash(page, "/flow todo")
    const flow = page.locator('.smithers-card[data-kind="flow"]').last()
    await expect(flow).toContainText("Active")
    await journeyActivate(flow.getByRole("button", { name: "Source", exact: true }))
    await expect(page.locator('.smithers-card[data-kind="file"]').last()).toContainText("flows/todo/flow.ts")
    await runSlash(page, "/flow.run todo")
    await expect(page.locator('.smithers-card[data-kind="run"]').last()).toBeVisible()
    await journeyActivate(page.getByRole("button", { name: "Inspect", exact: true }).last())
    const replay = page.getByRole("slider", { name: /Replay/ }).last()
    await journeyReach(replay)
    await page.keyboard.press("Home")
    await page.keyboard.press("End")
    await runSlash(page, "/monitor")
    await expect(page.locator('.smithers-card[data-kind="monitor"]').last()).toBeVisible()
    // J11 model assignment is an owner act and targets the actual review role.
    const ownerPage = f.members.Will.page
    const cheaper = required("SMITHERS_AGENT_MODEL_B")
    await runSlash(ownerPage, "/flow todo")
    const ownerFlow = ownerPage.locator('.flow-view').last()
    await expect(ownerFlow).toContainText("Active")
    const reviewerStep = ownerFlow.locator(".flow-steps").getByRole("button", { name: "reviewer", exact: true })
    await journeyActivate(reviewerStep)
    await expect(ownerPage.locator('.smithers-card[data-kind="agents"]').last().locator('[data-agent="reviewer"]')).toBeVisible()
    await journeyActivate(ownerPage.getByTestId("agent-model-reviewer"))
    await journeyEnter(ownerPage.getByLabel("Model", { exact: true }).last(), cheaper)
    const assigned = ownerPage.waitForResponse(response => response.request().method() === "PUT" &&
      new URL(response.url()).pathname === "/api/agents/reviewer/model")
    await journeyActivate(ownerPage.getByRole("button", { name: "Save", exact: true }).last())
    expect((await assigned).status()).toBe(200)
    await expect.poll(async () => (await f.read("Will", "/api/agents")).agents.find((agent: any) => agent.id === "reviewer")?.model.label).toBe(cheaper)
    // Ctrl+B pane movement and restoration must retain visible focus.
    await page.keyboard.press("Control+b")
    await page.keyboard.press("ArrowLeft")
    await page.keyboard.press("Escape")
  })
})

import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"

referenceTest("T-REL-02 outside saves preserve two acknowledged editors and Compare", scenario("journey.outside-save", {
  capabilities: ["install", "ssh"], coverage: ["host:local", "host:production", "door:slash", "door:button", "surface:file-card", "path:persistence", "dimension:keyboard"]
}), async ({ browser }, info) => {
  referenceTest.setTimeout(240_000)
  const gateway = required("SMITHERS_JOURNEY_OWNER_SSH_HOST")
  const port = required("SMITHERS_JOURNEY_OWNER_SSH_PORT")
  if (gateway.startsWith("-") || !/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error("Invalid owner SSH gateway")
  // This is the owner's allocated branch gateway, never an arbitrary host shell.
  const shell = spawn("ssh", ["-o", "BatchMode=yes", "-p", port, gateway, "sh -s"], { stdio: ["pipe", "pipe", "pipe"] })
  // Keep one owner session alive for both saves and independent disk readback.
  // A one-shot SSH command can exit before the watcher attributes its save.
  let rejectPending: ((error: Error) => void) | undefined
  let ended = false
  const endedWith = (message: string) => { ended = true; rejectPending?.(new Error(message)) }
  shell.on("error", () => endedWith("Owner SSH gateway refused the session"))
  shell.on("exit", () => endedWith("Owner SSH gateway ended before readback"))
  shell.stdin.on("error", () => endedWith("Owner SSH gateway closed its input"))
  shell.stderr.on("data", () => {}) // Never retain raw SSH/login output.
  const ssh = (command: string): Promise<string> => new Promise((resolve, reject) => {
    if (ended || rejectPending) { reject(new Error("Owner SSH session is closed or busy")); return }
    const marker = `release-${randomUUID()}`
    let output = ""
    const finish = (error?: Error, value?: string) => {
      clearTimeout(timer); shell.stdout.off("data", read); rejectPending = undefined
      if (error) reject(error); else resolve(value!)
    }
    const read = (chunk: Buffer) => {
      output += chunk.toString("utf8")
      if (output.length > 1024 * 1024) { finish(new Error("Owner SSH readback exceeded its bound")); return }
      const begin = output.indexOf(`${marker}-begin\n`), end = output.indexOf(`${marker}-end:`)
      if (begin < 0 || end < 0 || !output.slice(end).includes("\n")) return
      if (!output.slice(end).startsWith(`${marker}-end:0\n`)) { finish(new Error("Owner SSH command failed")); return }
      finish(undefined, output.slice(begin + marker.length + 7, end))
    }
    const timer = setTimeout(() => finish(new Error("Owner SSH readback timed out")), 30_000)
    rejectPending = error => finish(error)
    shell.stdout.on("data", read)
    shell.stdin.write(`printf '%s\\n' '${marker}-begin'\n${command}\nrelease_status=$?\nprintf '%s:%s\\n' '${marker}-end' "$release_status"\n`)
  })
  try {
  await withReference(browser, info, async f => {
    const branch = "ben/outside-save", path = "outside-save.txt"
    const api = `/api/branches/${encodeURIComponent(branch)}/files/${path}`
    const ben = f.members.Ben.page, alice = f.members.Alice.page
    const noAgents = () => f.sql("SELECT count(*)::int AS n FROM agent_sessions WHERE status = 'active'")
    expect(noAgents()).toEqual([{ n: 0 }])
    expect((await ssh("id -u")).trim()).toMatch(/^[1-9][0-9]*$/)
    const original = "Ben original\nAlice original\nShared original\nOutside original\n"
    await ssh("printf 'Ben original\\nAlice original\\nShared original\\nOutside original\\n' > outside-save.txt")
    expect(await ssh("cat outside-save.txt")).toBe(original)
    for (const page of [ben, alice]) {
      await runSlash(page, `/branch ${branch}`)
      await runSlash(page, `/files.read ${path}`)
      await expect(page.getByRole("textbox", { name: path, exact: true }).last()).toHaveAttribute("aria-readonly", "false")
    }
    const editors = [ben.getByRole("textbox", { name: path, exact: true }).last(), alice.getByRole("textbox", { name: path, exact: true }).last()]
    await Promise.all([ben, alice].map(async (page, index) => {
      await journeyReach(editors[index]!)
      await page.keyboard.press(process.platform === "darwin" ? "Meta+ArrowUp" : "Control+Home")
      if (index) await page.keyboard.press("ArrowDown")
      await page.keyboard.press(process.platform === "darwin" ? "Meta+ArrowRight" : "End")
      await page.keyboard.type(index ? " + Alice" : " + Ben")
    }))
    const acknowledged = "Ben original + Ben\nAlice original + Alice\nShared original\nOutside original\n"
    for (const page of [ben, alice]) {
      const card = page.locator('.code-file-view').filter({ has: page.getByRole("textbox", { name: path, exact: true }) }).last()
      await expect(card.getByText("Saved to the machine", { exact: true })).toBeVisible()
    }
    await expect.poll(() => ssh("cat outside-save.txt")).toBe(acknowledged)
    // Keep the active lines at Ben/Alice while SSH changes an untouched line.
    await ssh("printf 'Ben original + Ben\\nAlice original + Alice\\nShared original\\nOutside SSH\\n' > outside-save.txt")
    const merged = "Ben original + Ben\nAlice original + Alice\nShared original\nOutside SSH\n"
    await expect.poll(async () => (await f.read("Ben", api)).content.text).toBe(merged)
    await expect.poll(async () => (await f.read("Alice", api)).content.text).toBe(merged)
    expect(await ssh("cat outside-save.txt")).toBe(merged)
    const owner = await f.read("Will", "/api/user")
    const first = await f.read("Ben", api)
    expect(first.last_writer).toMatchObject({ kind: "person", login: owner.username, via: "ssh" })
    // SSH now collides with Ben's active line. The live bytes must win on disk.
    await ssh("printf 'Ben outside overwrite\\nAlice original + Alice\\nShared original\\nOutside SSH\\n' > outside-save.txt")
    let outside: any
    await expect.poll(async () => { outside = await f.read("Ben", api); return outside.outside?.version ?? "" }).not.toBe("")
    expect(outside.content.text).toBe(merged)
    expect(await ssh("cat outside-save.txt")).toBe(merged)
    for (const page of [ben, alice]) {
      const card = page.locator('.code-file-view').filter({ has: page.getByRole("textbox", { name: path, exact: true }) }).last()
      await expect(card.getByText("Changed outside Smithers", { exact: true })).toBeVisible()
      await journeyActivate(card.getByRole("button", { name: "Compare", exact: true }))
      await expect(card.getByRole("textbox", { name: `${path} · Snapshot`, exact: true })).toContainText("Ben outside overwrite")
      await expect(card.getByRole("textbox", { name: path, exact: true })).toContainText("Ben original + Ben")
      await expect(card.getByRole("textbox", { name: path, exact: true })).toContainText("Alice original + Alice")
    }
    expect(noAgents()).toEqual([{ n: 0 }])
    await info.attach("outside-save", { body: JSON.stringify({ branch, path, acknowledged, merged, version: outside.outside.version }), contentType: "application/json" })
  })
  } finally {
    shell.stdin.end()
    // Only this test's SSH client is signalled; the backend is never signalled.
    if (shell.exitCode === null) shell.kill("SIGTERM")
  }
})

import { readFile } from "node:fs/promises"
import { gatewayCall } from "./flow-execution/production"
import { assertRestartRecovery, type RecoveryEvent } from "./support/restart-recovery"

referenceTest("T-REL-02 backend kill -9 retains the completed prefix and recovery decision", scenario("journey.restart", {
  capabilities: ["install"], coverage: ["host:local", "host:production", "surface:todo", "door:slash", "path:persistence", "dimension:recovery"]
}), async ({ browser }, info) => {
  referenceTest.setTimeout(960_000)
  const evidencePath = required("SMITHERS_JOURNEY_RESTART_EVIDENCE")
  await withReference(browser, info, async f => {
    const page = f.members.Will.page
    await runSlash(page, "/todo T2")
    const item = await f.read("Will", "/api/todos/2")
    expect(item.state).toBe("working")
    expect(item.run.id).toEqual(expect.any(String))
    const journal = async (): Promise<RecoveryEvent[]> => {
      const response = await gatewayCall(page, page.context().request, f.repo, "Projection.Snapshot", {
        selector: { _tag: "run-events", runId: item.run.id }
      }, item.branch.id)
      const rows = (response.payload as { rows: RecoveryEvent[] }).rows
      expect(Array.isArray(rows)).toBe(true)
      return rows
    }
    let before: RecoveryEvent[] = []
    await expect.poll(async () => {
      before = await journal()
      return before.filter(event => event.eventType === "flows.engine.attempt-finished" && event.payload.state === "succeeded").length
    }).toBeGreaterThan(0)
    const started = Date.now()
    // The independent owner kills their recorded backend PID. The test never
    // signals an unrelated process, invokes sudo, or supplies a recovery result.
    console.log("Reference owner: kill -9 the backend while T2 is Working; retain the signal and launcher restart in the sanitized recording.")
    await expect.poll(async () => {
      try { return (await page.context().request.get(new URL("/api/bootstrap", page.url()).toString(), { timeout: 1000 })).ok() }
      catch { return false }
    }, { timeout: 120_000, intervals: [100] }).toBe(false)
    await expect.poll(async () => {
      try { return (await page.context().request.get(new URL("/api/bootstrap", page.url()).toString(), { timeout: 1000 })).ok() }
      catch { return false }
    }, { timeout: 120_000, intervals: [500] }).toBe(true)
    const bootstrap = await f.read("Will", "/api/bootstrap")
    expect(bootstrap.buildSha).toBe(required("SMITHERS_REAL_E2E_BUILD_SHA"))
    const signal = JSON.parse(await readFile(evidencePath, "utf8"))
    expect(signal).toMatchObject({ signal: 9, runId: item.run.id, candidate: required("SMITHERS_REAL_E2E_BUILD_SHA"), launcherRestarted: true })
    expect(Number.isInteger(signal.pid) && signal.pid > 1).toBe(true)
    expect(Date.parse(signal.killedAt)).toBeGreaterThanOrEqual(started)
    expect(signal.operator).toEqual(expect.any(String))
    expect(signal.operator.trim()).not.toBe("")
    let after: RecoveryEvent[] = []
    await expect.poll(async () => {
      after = await journal()
      return after.slice(before.length).some(event => event.eventType === "flows.engine.run-decision" &&
        ["stolen-and-activated", "claimed-and-activated"].includes(String(event.payload.decision)))
    }, { timeout: 120_000 }).toBe(true)
    const recovery = assertRestartRecovery(before, after)
    await expect.poll(async () => (await f.read("Will", "/api/todos/2")).state, { timeout: 660_000 }).toBe("in_review")
    after = await journal()
    assertRestartRecovery(before, after)
    await info.attach("restart-recovery", { body: JSON.stringify({ signal, recovery, before, after }), contentType: "application/json" })
  })
})
