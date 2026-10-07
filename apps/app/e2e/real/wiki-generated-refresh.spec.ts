import { test } from "./support"
import { scenario } from "./coverage/types"
import { withReference, home, runSlash, expect, attachJson } from "./todo/reference"

// Operator merges T1/T2/T3 and arms the test-build fault hook before T2/T3.
// All observations and Retry/Dismiss use the real install. No API interception,
// database mutation, or GitHub write is performed by this observer.
const journey = scenario("journey-wiki-generated-refresh", { capabilities: [], coverage: ["host:local", "host:production", "surface:wiki", "surface:home", "door:button", "path:success", "path:error"] })
test("C-J8-06 merge refresh, shared retry and durable dismissal", journey, async ({ browser }, info) => {
  test.setTimeout(1_800_000)
  await withReference(browser, info, async f => {
    const owner = f.members.Will.page
    const member = f.members.Ben.page
    const wiki = () => f.sql("SELECT generation,state,run_id,commit_id,published_commit,pages,receipt FROM mythical_wikis")[0]
    const initial = wiki()
    expect(initial.published_commit).toMatch(/^[0-9a-f]{40}$/)
    expect(initial.pages.map((p: any) => p.id)).toEqual(["overview", "architecture", "package-api", "package-web"])
    await attachJson(info, "initial-pages", initial)
    for (const page of [owner, member]) await runSlash(page, "/stack")
    const merged = async (n: number) => {
      let todo: any
      await expect.poll(async () => {
        todo = await f.read("Will", `/api/todos/${n}`)
        return todo.state
      }, { timeout: 600_000, intervals: [500, 1000] }).toBe("merged")
      const pr = await f.github("Ben", "GET", `/pulls/${todo.pr.number}`) as any
      expect(pr.merged).toBe(true)
      expect(pr.merge_commit_sha).toMatch(/^[0-9a-f]{40}$/)
      return pr.merge_commit_sha as string
    }
    const visible = async (state: "running" | "failed") => {
      for (const page of [owner, member]) {
        await expect(home(page)).toContainText("Refresh wiki", { timeout: 60_000 })
        if (state === "failed") {
          await expect(home(page).getByRole("button", { name: "Retry", exact: true })).toBeVisible()
          await expect(home(page).getByRole("button", { name: "Dismiss", exact: true })).toBeVisible()
        }
        await expect(page.getByTestId("composer-input")).toBeEditable()
      }
    }
    const published = async (commit: string, symbol: string) => {
      await expect.poll(() => wiki().published_commit, { timeout: 180_000, intervals: [500, 1000] }).toBe(commit)
      const row = wiki()
      const api = row.pages.find((p: any) => p.id === "package-api")
      expect(api.revision).toBeGreaterThan(initial.pages.find((p: any) => p.id === "package-api").revision)
      expect(api.body).toContain(symbol)
      await runSlash(owner, "/wiki.page generated-package-api")
      await expect(owner.getByText(symbol, { exact: false }).last()).toBeVisible()
      await owner.getByRole("button", { name: /History/ }).last().click()
      await expect(owner.getByText("Smithers", { exact: true }).last()).toBeVisible()
      await attachJson(info, `published-${symbol}`, row)
      return row
    }
    const m1 = await merged(1)
    await visible("running")
    await published(m1, "healthCheck")
    const m2 = await merged(2)
    await expect.poll(() => wiki().state, { timeout: 180_000 }).toBe("failed")
    await visible("failed")
    const failed = wiki()
    const failedRun = await f.read("Ben", `/api/runs/${failed.run_id}`)
    await home(member).getByRole("button", { name: "Retry", exact: true }).click()
    await expect.poll(() => wiki().run_id, { timeout: 60_000 }).not.toBe(failed.run_id)
    const retried = await f.read("Ben", `/api/runs/${wiki().run_id}`)
    expect(failedRun.flow_version).toBeTruthy()
    expect(failedRun.input).toBeDefined()
    expect(retried.flow_version).toEqual(failedRun.flow_version)
    expect(retried.input).toEqual(failedRun.input)
    await published(m2, "readyCheck")
    await merged(3)
    await expect.poll(() => wiki().state, { timeout: 180_000 }).toBe("failed")
    await visible("failed")
    const dismissed = wiki().run_id
    await home(owner).getByRole("button", { name: "Dismiss", exact: true }).click()
    for (const page of [owner, member]) {
      await page.reload()
      await runSlash(page, "/stack")
      await expect(home(page)).not.toContainText("Refresh wiki")
    }
    const records = f.sql(`SELECT id,dismissed_by FROM workflow_runs WHERE id='${String(dismissed).replace(/'/g, "''")}'`)
    expect(records).toHaveLength(1)
    expect(records[0].dismissed_by).toBeTruthy()
    await attachJson(info, "dismissal", records)
    await f.read("Will", `/api/runs/${dismissed}`)
  })
})
