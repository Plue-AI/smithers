import { execFileSync } from "node:child_process"
import { test } from "./support"
import { withReference, createTodo, openTodo, todoCard, expect, attachJson, realApi, required, JourneyUnavailable } from "./todo/reference"

test.use({ realScenario: { id: "journey-todo-evidence", capabilities: [], coverage: ["host:production", "surface:todo", "path:evidence", "path:log-authorization", "door:button"] } })
test("C-J2-04 accepted-generation PR and TODO evidence agree @production", async ({ browser }, info) => {
  test.setTimeout(900_000)
  await withReference(browser, info, async f => {
    const page = f.members.Will.page
    // The database/blob adversarial cases belong to the prerequisite production
    // integration suite named in the check, not a browser's mocked callback.
    let prerequisite: unknown
    try {
      prerequisite = JSON.parse(execFileSync("node", [new URL("../../scripts/verify-journey-evidence.mjs", import.meta.url).pathname], { encoding: "utf8" }))
    } catch (cause) {
      throw new JourneyUnavailable(`Production evidence prerequisite has no authenticated passing CI result for this commit: ${String(cause)}`)
    }
    await attachJson(info, "production-evidence-prerequisite", prerequisite)
    // Install owns this scratch repository; prerequisite owner setup supplies
    // package.json, workflow and branch protection. Read the actual GitHub facts.
    const pkg = await f.github("Will", "GET", "/contents/package.json") as any
    const manifest = JSON.parse(Buffer.from(pkg.content, "base64").toString())
    expect(manifest.scripts.test).toEqual(expect.any(String)); expect(manifest.scripts.lint).toEqual(expect.any(String))
    const workflow = await f.github("Will", "GET", "/contents/.github/workflows/ci.yml") as any
    const yaml = Buffer.from(workflow.content, "base64").toString()
    expect(yaml).toContain("pull_request"); expect(yaml).toContain("pnpm test")
    const protection = await f.github("Will", "GET", "/branches/main/protection") as any
    expect(protection.required_status_checks.contexts).toContain("ci")
    await createTodo(page, "Add `clamp(n, lo, hi)` to `src/math.ts` with tests.")
    let todo: any
    await expect.poll(async () => { todo = await f.read("Will", "/api/todos/1"); return todo.state }, { timeout: 780_000, intervals: [1000, 2000] }).toBe("in_review")
    const pr = await f.github("Will", "GET", `/pulls/${todo.pr.number}`) as any
    let githubChecks: any
    await expect.poll(async () => {
      githubChecks = await f.github("Will", "GET", `/commits/${pr.head.sha}/check-runs`)
      return githubChecks.check_runs.find((c: any) => c.name === "ci")?.status
    }, { timeout: 60_000, intervals: [1000] }).toBe("completed")
    const reported = Date.now()
    await expect.poll(async () => {
      todo = await f.read("Will", "/api/todos/1")
      return todo.evidence.find((e: any) => e.attempt === 1)?.items.find((e: any) => e.kind === "github_check" && e.name === "ci")?.state
    }, { timeout: 60_000, intervals: [500] }).toBe(githubChecks.check_runs.find((c: any) => c.name === "ci").conclusion)
    expect(Date.now() - reported).toBeLessThanOrEqual(60_000)
    const attempt = todo.attempts.find((a: any) => a.number === 1)
    const evidence = todo.evidence.find((e: any) => e.attempt === 1).items as any[]
    expect(evidence.length).toBeGreaterThan(0)
    expect([...new Set(evidence.map(e => e.generation))]).toEqual([attempt.accepted_generation])
    const gitDir = required("SMITHERS_JOURNEY_GIT_DIR")
    const tree = (sha: string) => execFileSync("git", ["-C", gitDir, "rev-parse", `${sha}^{tree}`], { encoding: "utf8" }).trim()
    expect(tree(pr.head.sha)).toBe(tree(attempt.candidate_head))
    const diff = evidence.find(e => e.kind === "diff_stat")
    expect(diff.files).toBeGreaterThan(0); expect(diff.additions).toBeGreaterThan(0); expect(diff.deletions).toBeGreaterThanOrEqual(0)
    expect(pr.body).toContain(String(diff.files)); expect(pr.body).toContain(`+${diff.additions}`); expect(pr.body).toContain(`-${diff.deletions}`)
    const checks = evidence.filter(e => e.kind === "machine_check")
    expect(checks.length).toBeGreaterThanOrEqual(2)
    expect(checks.map(c => c.name)).toEqual(expect.arrayContaining(["test", "lint"]))
    for (const check of checks) {
      expect(check.state).toBe("passed"); expect(check.took_s).toBeGreaterThanOrEqual(0)
      expect(pr.body).toContain(check.name); expect(pr.body).toContain(check.state); expect(pr.body).toContain(String(check.took_s))
    }
    const review = evidence.find(e => e.kind === "review_summary")
    expect(review.text.length).toBeGreaterThan(0); expect(pr.body).toContain(review.text)
    const ci = evidence.find(e => e.kind === "github_check" && e.name === "ci")
    expect(ci.required).toBe(true); expect(ci.head).toBe(pr.head.sha)
    const usage = evidence.find(e => e.kind === "usage"), flow = evidence.find(e => e.kind === "flow_version"), access = evidence.find(e => e.kind === "model_access")
    expect(usage.tokens).toBeGreaterThan(0); expect(usage.time_s).toBeGreaterThan(0); expect(flow.digest).toEqual(expect.any(String))
    expect(["provider", "chatgpt_subscription"]).toContain(access.kind); expect(access.model_id).toEqual(expect.any(String))
    const run = await f.read("Will", `/api/runs/${attempt.run_id}`)
    const proxy = f.sql(`SELECT model_id, model_access FROM model_proxy_usage WHERE run_id = '${String(attempt.run_id).replace(/'/g, "''")}'`)
    expect(proxy.length).toBeGreaterThan(0)
    for (const row of proxy) { expect(row.model_id).toBe(access.model_id); expect(row.model_access).toEqual(run.model_access) }
    expect(run.model_access).toMatchObject({ kind: access.kind, model_id: access.model_id })
    await openTodo(page, 1)
    const card = todoCard(page, 1)
    for (const text of [review.text, "ci", "required", access.model_id, flow.digest, String(usage.tokens), String(usage.time_s)]) await expect(card).toContainText(text)
    await expect(card).not.toContainText("not measured yet")
    for (const check of checks) { await expect(card).toContainText(check.name); await expect(card).toContainText(check.state); await expect(card).toContainText(String(check.took_s)) }
    const log = checks[0]
    expect(log.log_url).toMatch(/^\/api\/todos\/1\/attempts\/1\/logs\/[a-f0-9]+$/)
    const opened = page.waitForResponse(r => new URL(r.url()).pathname === log.log_url)
    await card.getByRole("link").filter({ hasText: new RegExp(log.name) }).click()
    const response = await opened
    expect(response.status()).toBe(200); expect(response.headers()["content-type"]).toContain("text/plain")
    expect(await response.text()).toContain(log.output)
    const unrelated = await realApi(page, page.context().request, "GET", `/api/todos/1/attempts/1/logs/${"f".repeat(64)}`)
    expect(unrelated.status()).toBe(404); expect(await unrelated.json()).toMatchObject({ code: "not_found", class: "user" })
    // Zero retrievals for unrelated/denied reads and stale producers is
    // authenticated above through the production PostgreSQL/blob suite.
    const deniedContext = await browser.newContext()
    try {
      const denied = await deniedContext.request.get(new URL(log.log_url, page.url()).toString())
      expect([401, 403]).toContain(denied.status())
    } finally { await deniedContext.close() }
    const openapi = await f.read("Will", "/api/openapi.json")
    expect(openapi.paths["/api/todos/{n}/attempts/{attempt}/logs/{digest}"].get.responses).toEqual(expect.objectContaining({ "200": expect.anything(), "404": expect.anything() }))
    await attachJson(info, "github-pr-checks", { pr, githubChecks })
    await info.attach("todo-evidence", { body: await page.screenshot(), contentType: "image/png" })
    await info.attach("check-log", { body: await response.text(), contentType: "text/plain" })
  })
})
