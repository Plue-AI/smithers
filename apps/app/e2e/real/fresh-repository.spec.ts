import { execFileSync } from "node:child_process"
import { test } from "./support"
import { scenario } from "./coverage/types"
import { withReference, openTodo, todoCard, expect, attachJson, required } from "./todo/reference"

// Observer on the reference install. The operator connects the literal Node
// or Go scratch fixture and files the TODO; this test never writes to GitHub.
const journey = scenario("journey-fresh-repository", { capabilities: [], coverage: ["host:local", "host:production", "surface:todo", "door:button", "dimension:evidence"] })
test("C-J1-06 undeclared repository reaches Machine ready and checked review", journey, async ({ browser }, info) => {
  test.setTimeout(1_800_000)
  const kind = required("SMITHERS_FRESH_REPOSITORY_KIND")
  expect(["node", "go"]).toContain(kind)
  const argv = kind === "node" ? [["pnpm", "test"], ["pnpm", "lint"]] : [["go", "test", "./..."]]
  const ids = kind === "node" ? ["test", "lint"] : ["test"]
  await withReference(browser, info, async f => {
    const page = f.members.Will.page
    await page.goto("/setup")
    const card = page.getByRole("region", { name: "Set up Smithers", exact: true })
    await expect(card).toBeVisible()
    await expect(card.locator('[data-step="source"]')).toHaveAttribute("data-state", "done", { timeout: 900_000 })
    // A fixture admitted after Machine ready cannot prove the ordering.
    await expect(card.locator('[data-step="machine"]')).not.toHaveAttribute("data-state", "done")
    await info.attach("source-ready", { body: await page.screenshot(), contentType: "image/png" })
    await expect(card.locator('[data-step="machine"]')).toHaveAttribute("data-state", "done", { timeout: 900_000 })
    await expect(card.getByText("Source ready", { exact: true })).toBeVisible()
    await expect(card.getByText("Machine ready", { exact: true })).toBeVisible()
    await info.attach("machine-ready", { body: await page.screenshot(), contentType: "image/png" })
    const rows = f.sql("SELECT key,value FROM install_settings WHERE key='coding.project'")
    // Keep this literal in sync with the persisted contract, not a detector.
    expect(rows).toHaveLength(1)
    const project = rows[0].value
    expect(project.detected.map((c: any) => c.argv)).toEqual(argv)
    expect(project.checks.map((c: any) => c.id)).toEqual(ids)
    expect(project.pages.map((p: any) => p.id)).toEqual(["overview", "architecture"])
    expect(project.seats).toEqual({
      "coding/implement": "auto", "coding/plan": "auto", "coding/poc": "auto", "coding/review": "auto",
      "wiki/reviewer": "auto", "coding/dispatch": "auto", "repository/research": "auto",
      "repository/evaluator": "auto", "repository/author": "auto", "flow/author": "auto"
    })
    await attachJson(info, "flow-config", rows)
    await f.read("Will", "/api/flows")
    // The owner files 'Add a sum(a, b) export with a test' on this install.
    let todo: any
    await expect.poll(async () => {
      const todos = await f.read("Will", "/api/todos")
      todo = todos.find((row: any) => (row.n ?? row.number) === 1)
      return todo?.state
    }, { timeout: 780_000, intervals: [1000, 2000] }).toBe("in_review")
    const checks = todo.evidence.flatMap((attempt: any) => attempt.items).filter((item: any) => item.kind === "check")
    expect(checks.map((c: any) => c.name)).toEqual(ids)
    for (const check of checks) {
      expect(check.state).toBe("passed")
      expect(check.took_s).toBeGreaterThanOrEqual(0)
      expect(check.log_url).toMatch(/^\/api\/todos\/1\/attempts\/1\/logs\//)
      const log = await page.context().request.get(new URL(check.log_url, page.url()).href)
      expect(log.status()).toBe(200)
      await info.attach(`check-${check.name}`, { body: await log.body(), contentType: "text/plain" })
    }
    await openTodo(page, 1)
    for (const id of ids) await expect(todoCard(page, 1)).toContainText(id)
    const pr = await f.github("Will", "GET", `/pulls/${todo.pr.number}`) as any
    expect(pr.base.ref).toBe("main")
    expect(pr.head.ref).toMatch(/^smithers\//)
    const git = required("SMITHERS_JOURNEY_GIT_DIR")
    for (const revision of ["main", pr.head.sha]) {
      const paths = execFileSync("git", ["-C", git, "log", "--format=", "--name-only", revision], { encoding: "utf8" })
      expect(paths.split("\n").filter(p => /^(?:\.smithers|flows)\//.test(p))).toEqual([])
      await info.attach(`git-${revision}`, { body: paths, contentType: "text/plain" })
    }
    await attachJson(info, "todo-evidence", todo)
    await attachJson(info, "pull-request", pr)
  })
})
