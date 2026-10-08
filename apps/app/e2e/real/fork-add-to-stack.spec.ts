import { execFileSync } from "node:child_process"
import { test } from "./support"
import { scenario } from "./coverage/types"
import { withReference, required, runSlash, expect, attachJson, openTodo, todoCard, realApi } from "./todo/reference"
import { counterIdentity, maximumTickGap, observedTickInterval } from "./support/fork-continuity"
import { journeyActivate, journeyTerminalInput } from "./support/keyboard-journey-input"

// C-J7-02, including the production T-STK-05 Drop/capture boundary.
// Provision T1 In review, T2 Working after a steer,
// T3 Queued and Ben's real delegated token. Never seed/mutate install SQL.
// The source guest has a running counter writing epoch seconds to .tick;
// SMITHERS_FORK_COUNTER_PID identifies that process. SSH observes it only.
// Its uncommitted src/fork-uncommitted.ts contains the literal canary below.
// SMITHERS_FORK_MIRROR_MAIN_HEAD is independently observed from the installed
// mirror before this journey; keep main fixed until the final fork observation.
const source = (command: string): string => {
  const host = required("SMITHERS_FORK_SOURCE_SSH_HOST")
  const port = required("SMITHERS_FORK_SOURCE_SSH_PORT")
  if (host.startsWith("-") || !/^\d+$/.test(port)) throw new Error("Invalid source SSH endpoint")
  return execFileSync("ssh", ["-o", "BatchMode=yes", "-p", port, host, command], {
    encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024
  })
}
const continuity = () => {
  const pid = required("SMITHERS_FORK_COUNTER_PID")
  if (!/^[1-9]\d*$/.test(pid)) throw new Error("Invalid counter PID")
  return { boot: source("cat /proc/sys/kernel/random/boot_id").trim(),
    process: counterIdentity(source(`cat /proc/${pid}/stat`), pid),
    ticks: source("cat .tick").trim().split(/\s+/).map(Number) }
}

test("C-J7-02: real Fork, private Confirm, Drop and retained source bytes", scenario("fork-add-to-stack", {
  capabilities: ["install", "ssh"], coverage: ["host:local", "host:production", "door:button", "door:slash", "door:agent",
    "action:branch.fork", "action:branch.add-to-stack", "action:todo.drop", "path:success", "path:permission", "path:persistence",
    "evidence:fork-source-continuity", "evidence:retained-source-bytes"]
}), async ({ browser }, info) => {
  test.setTimeout(20 * 60_000)
  await withReference(browser, info, async f => {
    const page = f.members.Ben.page
    const mainHead = required("SMITHERS_FORK_MIRROR_MAIN_HEAD")
    expect(mainHead).toMatch(/^[0-9a-f]{40}$/)
    const member = await f.read("Ben", "/api/user")
    expect(member.username).toBe("ben")
    const stack = await f.read("Ben", "/api/todos")
    expect(stack.map((item: any) => [item.n, item.state])).toEqual([[1, "in_review"], [2, "working"], [3, "queued"]])
    const [verified] = f.sql("SELECT number,COALESCE(NULLIF(candidate_base,''),base_commit) AS candidate_base FROM mythical_items WHERE number=2 AND repository_id=(SELECT repository_id FROM mythical_stacks WHERE state='active')")
    expect(verified.candidate_base).toMatch(/^[0-9a-f]{40}$/)
    const [prefix] = f.sql("SELECT candidate_head FROM mythical_items WHERE number=1 AND repository_id=(SELECT repository_id FROM mythical_stacks WHERE state='active')")
    expect(prefix.candidate_head).toMatch(/^[0-9a-f]{40}$/)
    expect(verified.candidate_base).toBe(prefix.candidate_head)
    // Literal expected canary bytes come from the qualification operator, not
    // the production implementation or a spec parser. Retain actual bytes too.
    required("SMITHERS_FORK_VERIFIED_RETRY_BYTES")
    const expected = process.env.SMITHERS_FORK_VERIFIED_RETRY_BYTES!
    const bytes = source("cat src/retry.ts")
    await info.attach("verified-retry-source", { body: bytes, contentType: "text/plain" })
    expect(bytes).toBe(expected)
    expect(source("cat src/fork-uncommitted.ts")).toBe("export const uncapturedForkCanary = true;\n")
    const before = continuity()
    expect(before.boot).toMatch(/^[0-9a-f-]{36}$/)
    maximumTickGap(before.ticks)
    const original = await f.read("Ben", "/api/todos/2")
    await attachJson(info, "fork-source-before", { verified, before, original, stack })
    await openTodo(page, 2)
    const forkResponse = page.waitForResponse(r => new URL(r.url()).pathname === "/api/branches" && r.request().method() === "POST")
    await journeyActivate(todoCard(page, 2).getByRole("button", { name: "Fork", exact: true }))
    const forked = await forkResponse
    expect(forked.status()).toBe(201)
    expect(forked.request().postDataJSON()).toEqual({ from: "T2" })
    const receipt = await forked.json()
    const branch = receipt.name as string
    expect(branch).toMatch(/^scratch\/ben\//)
    const path = `/api/branches/${encodeURIComponent(branch)}`
    const scratch = await f.read("Ben", path)
    expect(scratch.kind).toBe("scratch")
    expect(scratch.forked_from).toMatchObject({ item: 2, base: verified.candidate_base })
    expect(scratch.forked_from.commit).toMatch(/^[0-9a-f]{40}$/)
    const captures = f.sql("SELECT data FROM product_job_events WHERE event_type='branch.captured' AND principal_id='branch:'||(SELECT workspace_id FROM mythical_items WHERE number=2 AND repository_id=(SELECT repository_id FROM mythical_stacks WHERE state='active'))")
    expect(captures.some(row => row.data.applied && row.data.head === scratch.forked_from.commit)).toBe(true)
    await expect.poll(() => continuity().ticks.length).toBeGreaterThan(before.ticks.length + 1)
    const after = continuity()
    expect(after.boot).toBe(before.boot)
    expect(after.process).toBe(before.process)
    const ticks = observedTickInterval(before.ticks, after.ticks)
    expect(ticks.length).toBeGreaterThan(1)
    expect(ticks.every(Number.isFinite)).toBe(true)
    expect(maximumTickGap(ticks)).toBeLessThanOrEqual(1)
    const current = await f.read("Ben", "/api/todos/2")
    expect(current.state).toBe("working")
    expect(current.run.id).toBe(original.run.id)
    expect(current.run.attempt).toBe(original.run.attempt)
    const file = await f.read("Ben", `${path}/files/src/retry.ts`)
    expect(file.content).toEqual({ kind: "text", text: expected })
    const uncaptured = await realApi(page, page.context().request, "GET", `${path}/files/src/fork-uncommitted.ts`)
    // The composed S2 capture contract includes uncommitted source edits.
    expect(uncaptured.status()).toBe(200)
    expect((await uncaptured.json()).content).toEqual({ kind: "text", text: "export const uncapturedForkCanary = true;\n" })
    await attachJson(info, "fork-source-after", { scratch, before, after, current, file,
      dispatch: { method: forked.request().method(), path: "/api/branches", payload: forked.request().postDataJSON(), status: forked.status() } })
    const githubBranches = await f.github("Ben", "GET", "/branches?per_page=100") as Array<{ name: string }>
    expect(githubBranches.some(row => row.name.startsWith("scratch/"))).toBe(false)
    await runSlash(page, `/branch ${branch}`)
    await expect(page.locator('[data-flow="branch.add-to-stack"]').last()).toBeVisible()
    await expect(page.getByRole("button", { name: "Replace T2", exact: true })).toHaveCount(0)
    const terminalResponse = page.waitForResponse(r => new URL(r.url()).pathname === "/api/terminals" && r.request().method() === "POST")
    await journeyActivate(page.locator('[data-flow="terminal"]').last())
    const opened = await terminalResponse
    await attachJson(info, "fork-terminal-launch", { status: opened.status(), body: await opened.text() })
    expect(opened.status(), "The installed microVM must admit the member terminal").toBe(202)
    const terminal = page.locator('.xterm-helper-textarea').last()
    await expect(terminal).toBeAttached()
    await journeyTerminalInput(page.locator(".terminal-view").last())
    const edit = "export const forkBackoff = 2;\n"
    await page.keyboard.type("printf 'export const forkBackoff = 2;\\n' >> src/retry.ts && jj commit -m 'try exponential backoff' && printf '\\nFORK_EDIT_%s\\n' COMMITTED")
    await page.keyboard.press("Enter")
    await expect(page.locator(".xterm-rows").last().getByText("FORK_EDIT_COMMITTED", { exact: true })).toBeVisible()
    // Keep a second edit uncommitted: Add must capture the awake guest's
    // working copy as well as the revision committed through the terminal.
    const awakeEdit = "export const forkAwakeCapture = true;\n"
    await page.keyboard.type("printf 'export const forkAwakeCapture = true;\\n' >> src/retry.ts && printf '\\nFORK_AWAKE_%s\\n' READY")
    await page.keyboard.press("Enter")
    await expect(page.locator(".xterm-rows").last().getByText("FORK_AWAKE_READY", { exact: true })).toBeVisible()
    const scratchBytes = await f.read("Ben", `${path}/files/src/retry.ts`)
    await attachJson(info, "scratch-before-add-source", scratchBytes)
    expect(scratchBytes.content).toEqual({ kind: "text", text: expected + edit + awakeEdit })
    await info.attach("scratch-edit-source", { body: edit, contentType: "text/plain" })
    await info.attach("scratch-uncommitted-source", { body: awakeEdit, contentType: "text/plain" })
    // The real delegated catalog HTTP door persists the private card. A model
    // answer or an in-memory app confirmation is not server admission evidence.
    const requestAdd = () => page.context().request.post(new URL(`${path}/add-to-stack`, required("SMITHERS_REAL_BASE_URL")).toString(), {
      headers: { Authorization: `Bearer ${required("SMITHERS_FORK_BEN_DELEGATED_TOKEN")}`, "Content-Type": "application/json",
        "Idempotency-Key": `fork-add-${scratch.machine.id}` }, data: { text: "Keep retry fork" }
    })
    const pending = await requestAdd()
    expect(pending.status()).toBe(202)
    const ask = await pending.json()
    expect(ask.state).toBe("pending")
    expect(ask.confirmation).toMatch(/^[0-9a-f-]{36}$/)
    const approvals = () => f.sql(`SELECT id,state,kind,command,subject,revision,member_id,decided_by FROM approvals WHERE id='${ask.confirmation}'`)
    expect(approvals()).toMatchObject([{ id: ask.confirmation, state: "pending", kind: "one_click", command: "branch.add-to-stack", member_id: member.id, decided_by: null }])
    expect((await f.read("Ben", "/api/todos")).map((item: any) => item.n)).toEqual([1, 2, 3])
    await attachJson(info, "fork-add-pending", { ask, approvals: approvals(), scratch, githubBranches })
    // Reconnect/retry must retain one private request, and an agent cannot
    // turn its own delegated request into the person's approval.
    const repeated = await requestAdd()
    const repeatedBody = await repeated.json()
    await attachJson(info, "fork-add-repeated-request", { status: repeated.status(), body: repeatedBody })
    expect(repeated.status()).toBe(202)
    expect(repeatedBody).toMatchObject({ confirmation: ask.confirmation, state: "pending" })
    const denied = await page.context().request.post(new URL(`/api/confirmations/${ask.confirmation}/approve`, required("SMITHERS_REAL_BASE_URL")).toString(), {
      headers: { Authorization: `Bearer ${required("SMITHERS_FORK_BEN_DELEGATED_TOKEN")}`, "Content-Type": "application/json" }, data: {}
    })
    const deniedBody = await denied.json()
    await attachJson(info, "fork-add-delegated-approval-refused", { status: denied.status(), body: deniedBody })
    expect(denied.status()).toBe(403)
    expect(deniedBody).toMatchObject({ class: "permission", code: "permission" })
    expect(approvals()).toMatchObject([{ state: "pending", decided_by: null }])
    expect((await f.read("Ben", "/api/todos")).map((item: any) => item.n)).toEqual([1, 2, 3])
    const card = page.locator(`[data-message-id="confirmation:${ask.confirmation}"]`)
    await expect(card).toBeVisible()
    await expect(f.members.Alice.page.locator(`[data-message-id="confirmation:${ask.confirmation}"]`)).toHaveCount(0)
    const approved = page.waitForResponse(r => new URL(r.url()).pathname === `/api/confirmations/${ask.confirmation}/approve`)
    await journeyActivate(card.getByRole("button", { name: /^Add to stack/ }))
    const approval = await approved
    expect(approval.status()).toBe(202)
    expect(approval.request().headers().authorization).toBeUndefined()
    expect(approvals()).toMatchObject([{ state: "approved", decided_by: member.id }])
    await expect.poll(async () => (await f.read("Ben", "/api/todos")).map((item: any) => item.n)).toEqual([1, 2, 4, 3])
    const added = await f.read("Ben", "/api/todos/4")
    expect(added.pr).toBeFalsy()
    const itemBranch = await f.read("Ben", `/api/branches/${encodeURIComponent(added.branch.name)}`)
    expect(itemBranch.kind).toBe("item")
    expect(itemBranch.machine.id).toBe(scratch.machine.id)
    expect(added.branch.id).toBe(scratch.machine.id)
    const [seed] = f.sql("SELECT workspace_id,checks,revisions FROM mythical_items WHERE number=4 AND repository_id=(SELECT repository_id FROM mythical_stacks WHERE state='active')")
    expect(seed.workspace_id).toBe(scratch.machine.id)
    expect(seed.checks.seed.base).toBe(verified.candidate_base)
    const retained = await f.read("Ben", `/api/branches/${encodeURIComponent(added.branch.name)}/files/src/retry.ts`)
    await attachJson(info, "adopted-retry-source", retained)
    expect(retained.content).toEqual({ kind: "text", text: expected + edit + awakeEdit })
    expect(seed.checks.seed.diff).toContain("+export const forkBackoff = 2;")
    expect(seed.checks.seed.diff).toContain("+export const forkAwakeCapture = true;")
    await expect(terminal).toBeAttached()
    await journeyTerminalInput(page.locator(".terminal-view").last())
    await page.keyboard.type("printf '\\nFORK_TERMINAL_%s\\n' RETAINED")
    await page.keyboard.press("Enter")
    await expect(page.locator(".xterm-rows").last().getByText("FORK_TERMINAL_RETAINED", { exact: true })).toBeVisible()
    const afterAdd = continuity()
    expect(afterAdd.boot).toBe(before.boot)
    expect(afterAdd.process).toBe(before.process)
    const addTicks = observedTickInterval(before.ticks, afterAdd.ticks)
    expect(addTicks.every(Number.isFinite)).toBe(true)
    expect(maximumTickGap(addTicks)).toBeLessThanOrEqual(1)
    const events = f.sql("SELECT event_type,data FROM product_job_events WHERE event_type IN ('branch.forked','branch.added-to-stack') ORDER BY sequence")
      .filter(row => row.data.workspace === scratch.machine.id)
    for (const kind of ["branch.forked", "branch.added-to-stack"]) {
      const matching = events.filter(row => row.event_type === kind)
      expect(matching).toHaveLength(1)
      expect(matching[0].data.actor).toMatchObject({ kind: "system", login: "smithers" })
      expect(matching[0].data.for.login).toBe("ben")
    }
    // Read all tracked fixture bytes through the production File surface.
    const itemPath = `/api/branches/${encodeURIComponent(added.branch.name)}`
    const tree = async () => {
      const files: Record<string, unknown> = Object.create(null)
      const visit = async (directory: string) => {
        const entries = await f.read("Ben", `${itemPath}/files?path=${encodeURIComponent(directory)}`)
        for (const entry of entries) {
          if ([".git", ".jj"].includes(entry.name)) continue
          if (["dir", "tree"].includes(entry.type)) await visit(entry.path)
          else {
            const file = await f.read("Ben", `${itemPath}/files/${entry.path.split("/").map(encodeURIComponent).join("/")}`)
            expect(file.digest).toMatch(/^[0-9a-f]{64}$/)
            files[entry.path] = { content: file.content, digest: file.digest }
          }
        }
      }
      await visit("")
      return files
    }
    const beforeDrop = await tree()
    expect(beforeDrop["src/retry.ts"]).toMatchObject({ content: { kind: "text", text: expected + edit + awakeEdit } })
    // Persist the evidence before Drop: a refusal or timeout must retain the
    // successful Fork/Add observations and the bytes it was meant to preserve.
    await attachJson(info, "fork-add-before-drop", { beforeDrop, seed, itemBranch, approvals: approvals(), events, afterAdd })
    // The main source has no item or machine to capture. Compare its retained
    // revision with an operator's independent mirror observation, never with
    // another field returned by the Fork implementation itself.
    const mainResponse = page.waitForResponse(r => new URL(r.url()).pathname === "/api/branches" && r.request().method() === "POST")
    await runSlash(page, '/branch.fork {"from":"main","name":"main-revision-proof"}')
    const mainForked = await mainResponse
    const mainReceipt = await mainForked.json()
    await attachJson(info, "main-fork-dispatch", { expectedMirrorHead: mainHead, status: mainForked.status(),
      payload: mainForked.request().postDataJSON(), receipt: mainReceipt })
    expect(mainForked.status()).toBe(201)
    expect(mainForked.request().postDataJSON()).toEqual({ from: "main", name: "main-revision-proof" })
    const mainScratch = await f.read("Ben", `/api/branches/${encodeURIComponent(mainReceipt.name)}`)
    expect(mainScratch.kind).toBe("scratch")
    expect(mainScratch.forked_from).toMatchObject({ kind: "main", ref: "main", commit: mainHead, base: mainHead })
    expect(mainScratch.forked_from.item).toBeUndefined()
    expect((await f.read("Ben", "/api/todos")).map((item: any) => item.n)).toEqual([1, 2, 4, 3])
    const finalGithubBranches = await f.github("Ben", "GET", "/branches?per_page=100") as Array<{ name: string }>
    expect(finalGithubBranches.some(row => row.name.startsWith("scratch/"))).toBe(false)
    expect(original.pr.number).toBeGreaterThan(0)
    await runSlash(page, "/todo.drop T2")
    const dropResponse = page.waitForResponse(r => new URL(r.url()).pathname === "/api/todos/2" && r.request().method() === "POST")
    await journeyActivate(page.getByRole("button", { name: "Confirm: drop this TODO", exact: true }).last())
    const dropping = await dropResponse
    await attachJson(info, "fork-drop-response", { status: dropping.status(), body: await dropping.text(),
      payload: dropping.request().postDataJSON() })
    expect(dropping.status()).toBe(202)
    expect(dropping.request().postDataJSON()).toMatchObject({ op: "drop" })
    await expect.poll(async () => (await f.read("Ben", "/api/todos/2")).state, { timeout: 120_000 }).toBe("dropped")
    await expect.poll(async () => (await f.read("Ben", "/api/todos")).map((item: any) => item.n)).toEqual([1, 4, 3])
    await expect.poll(async () => ((await f.github("Ben", "GET", `/pulls/${original.pr.number}`)) as { state: string }).state).toBe("closed")
    const closedPR = await f.github("Ben", "GET", `/pulls/${original.pr.number}`) as { state: string; merged: boolean }
    expect(closedPR.merged).toBe(false)
    const comments = await f.github("Ben", "GET", `/issues/${original.pr.number}/comments?per_page=100`) as Array<{ body: string }>
    expect(comments.filter(row => row.body === "Dropped in Smithers by @ben")).toHaveLength(1)
    await expect.poll(async () => (await f.read("Ben", "/api/todos/4")).state, { timeout: 120_000 }).toBe("working")
    const afterDrop = await tree()
    expect(afterDrop).toEqual(beforeDrop)
    const foldedDiff = await f.read("Ben", `${itemPath}/diff`)
    expect(foldedDiff.files.map((file: any) => file.path)).toContain("src/retry.ts")
    expect(JSON.stringify(foldedDiff)).toContain("export const forkBackoff = 2;")
    expect(JSON.stringify(foldedDiff)).toContain("export const forkAwakeCapture = true;")
    await attachJson(info, "drop-retained-tree", { beforeDrop, afterDrop, foldedDiff, closedPR, comments })
    await page.reload()
    await runSlash(page, "/branch T4")
    await expect(page.getByText(added.branch.name, { exact: true }).last()).toBeVisible()
    await attachJson(info, "fork-add-source-continuity", { verified, before, after, afterAdd, scratch, itemBranch, ask, approvals: approvals(), forkDispatch: { method: forked.request().method(), path: "/api/branches", payload: forked.request().postDataJSON(), status: forked.status() }, seed, events, githubBranches })
  })
})
