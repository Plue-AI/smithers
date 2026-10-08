import { readFileSync } from "node:fs"
import { test, command } from "./support"
import { scenario } from "./coverage/types"
import { attachJson, expect, runSlash } from "./todo/reference"
import { withJ10Install } from "./github-j10/install"

// C-J7-02's prepared install: T1 reviewed, T2 working after a steer with
// a verified PR, T3 queued. SQL observes only; all
// mutations enter the real app, terminal and command dispatcher. The supplied
// install must use githubfake: this automation never writes a real repository.
test("C-J7-02 fork, confirm Add to stack, and Drop preserve the fork", scenario("journey-fork-add-to-stack", {
  capabilities: [], coverage: ["host:local", "action:branch.fork", "action:branch.add-to-stack", "action:todo.drop", "door:button", "path:success", "evidence:database-readback"]
}), async ({ browser }, info) => {
  test.setTimeout(20 * 60_000)
  await withJ10Install(browser, info, async f => {
    expect(f.kind, "Use a prepared install backed by githubfake").toBe("composed")
    const page = f.members.Ben.page
    page.setDefaultTimeout(30_000)
    const host = JSON.parse(readFileSync(process.env.SMITHERS_J10_COMPOSED_HOST!, "utf8"))
    const fake = async (path: string) => {
      const response = await fetch(`${host.github.url}/repos/${f.repo}${path}`)
      expect(response.ok).toBe(true)
      return response.json()
    }
    const todos = await f.read("Ben", "/api/todos")
    expect(todos.map((v: any) => [v.n, v.state])).toEqual([[1, "in_review"], [2, "working"], [3, "queued"]])
    const second = todos[1]
    const prefixHead = f.sql("SELECT candidate_head FROM mythical_items WHERE number=1")[0].candidate_head
    expect(prefixHead).toMatch(/^[0-9a-f]{40}$/)
    const original = f.sql("SELECT id,request_run_id,attempt,workspace_id,candidate_head,candidate_base,base_commit FROM mythical_items WHERE number=2")[0]
    expect(second.pr.head).toMatch(/^[0-9a-f]{40}$/)
    const runBefore = f.sql("SELECT id,state,owner_generation FROM flow_runtime_host_bindings WHERE workspace_id=(SELECT workspace_id::uuid FROM mythical_items WHERE number=2)")
    const requests: unknown[] = []
    page.on("request", request => {
      if (request.method() === "POST" && new URL(request.url()).pathname.startsWith("/api/branches")) requests.push({ path: new URL(request.url()).pathname, body: request.postDataJSON() })
    })
    await runSlash(page, "/todo T2")
    const forked = page.waitForResponse(r => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/branches")
    await page.getByRole("button", { name: "Fork", exact: true }).last().press("Enter")
    const response = await forked
    expect(response.status()).toBe(201)
    expect(response.request().postDataJSON()).toEqual({ from: "T2" })
    const scratch = await response.json()
    await attachJson(info, "scratch-before", { scratch, original, prefixHead, runBefore })
    expect(scratch.kind).toBe("scratch")
    expect(scratch.name).toMatch(/^scratch\/ben\//)
    expect(scratch.forked_from).toMatchObject({ item: 2, base: prefixHead })
    expect(scratch.forked_from.commit).toMatch(/^[0-9a-f]{40}$/)
    expect((await f.read("Ben", "/api/todos/2")).state).toBe("working")
    expect(f.sql("SELECT id,request_run_id,attempt,workspace_id,candidate_head,candidate_base,base_commit FROM mythical_items WHERE number=2")[0]).toEqual(original)
    expect(f.sql("SELECT id,state,owner_generation FROM flow_runtime_host_bindings WHERE workspace_id=(SELECT workspace_id::uuid FROM mythical_items WHERE number=2)")).toEqual(runBefore)
    await runSlash(page, `/branch ${scratch.name}`)
    let output = "", closed = false
    page.on("websocket", socket => {
      if (!socket.url().includes("/terminal")) return
      socket.on("framereceived", frame => { output += typeof frame.payload === "string" ? frame.payload : frame.payload.toString("utf8") })
      socket.on("close", () => { closed = true })
    })
    const opening = page.waitForResponse(r => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/terminals")
    await page.locator('[data-flow="terminal"]').last().press("Enter")
    const opened = await opening
    await attachJson(info, "terminal-open", { status: opened.status(), body: await opened.json() })
    expect(opened.status(), "C-J7-02 requires the installed microVM member terminal").toBe(202)
    const terminal = page.locator(".terminal-view").last()
    await terminal.locator(".xterm-helper-textarea").focus()
    await page.keyboard.type("mkdir -p src; printf 'export const backoff = 2\\n' >> src/retry.ts; jj commit -m 'try exponential backoff' && printf 'J7_COMMITTED\\n'")
    await page.keyboard.press("Enter")
    await expect.poll(() => output, { timeout: 60_000 }).toMatch(/\r?\nJ7_COMMITTED\r?\n/)
    const branches = await fake("/branches")
    expect(branches.some((branch: any) => branch.name.startsWith("scratch/"))).toBe(false)
    await attachJson(info, "github-branches", branches)
    // The real app agent must request the consequential command; the private
    // Confirm card's person press, not the model response, creates the TODO.
    await command(page, `Run /branch.add-to-stack ${scratch.name}`)
    const confirm = page.locator('[data-kind="confirm"]').getByRole("button", { name: "Add to stack", exact: true }).last()
    await expect(confirm).toBeVisible({ timeout: 120_000 })
    expect((await f.read("Ben", "/api/todos")).map((v: any) => v.n)).toEqual([1, 2, 3])
    const adopted = page.waitForResponse(r => r.request().method() === "POST" && /\/confirmations\/[^/]+\/approve$/.test(new URL(r.url()).pathname))
    await confirm.press("Enter")
    expect((await adopted).status()).toBe(202)
    await expect.poll(async () => (await f.read("Ben", "/api/todos")).map((v: any) => v.n), { timeout: 120_000 }).toEqual([1, 2, 4, 3])
    const fourth = await f.read("Ben", "/api/todos/4")
    expect(fourth.branch.id).toBe(scratch.machine.id)
    expect(fourth.pr?.number ?? 0).toBe(0)
    const seed = f.sql("SELECT checks->'seed' AS seed FROM mythical_items WHERE number=4")[0].seed
    expect(seed.diff).toContain("export const backoff = 2")
    expect(seed.diff).toContain("source.md")
    expect(seed.base).toBe(prefixHead)
    expect(closed).toBe(false)
    await runSlash(page, "/todo.drop T2")
    await page.getByRole("button", { name: "Drop", exact: true }).last().press("Enter")
    await expect.poll(async () => (await f.read("Ben", "/api/todos/2")).state, { timeout: 180_000 }).toBe("dropped")
    expect((await f.github.pull(second.pr.number)).state).toBe("closed")
    const comments = await fake(`/issues/${second.pr.number}/comments`)
    expect(comments.some((comment: any) => comment.body.includes("Dropped in Smithers by @ben"))).toBe(true)
    await expect.poll(async () => (await f.read("Ben", "/api/todos")).filter((v: any) => v.state !== "dropped").map((v: any) => v.n)).toEqual([1, 4, 3])
    const after = f.sql("SELECT checks->'seed' AS seed FROM mythical_items WHERE number=4")[0].seed
    expect(after.diff).toContain("export const backoff = 2")
    expect(after.diff).toContain("source.md")
    expect(after.base).toBe(prefixHead)
    expect(closed).toBe(false)
    await expect(page.getByRole("button", { name: "Replace T2", exact: true })).toHaveCount(0)
    await expect.poll(async () => (await f.read("Ben", "/api/todos/4")).state, { timeout: 120_000 }).toBe("working")
    await attachJson(info, "dispatch", requests)
    await attachJson(info, "fork-and-adoption", { scratch, fourth, seed, after })
    await attachJson(info, "activity", f.sql("SELECT event_type,data FROM product_job_events WHERE event_type IN ('branch.forked','branch.added-to-stack','todo.drop-requested','todo.dropped') ORDER BY sequence"))
  })
})
