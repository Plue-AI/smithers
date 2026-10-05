import { readFileSync } from "node:fs"
import { test } from "./support"
import { withReference, seedIssueSeven, openTodo, todoCard, home, runSlash, realApi, expect, attachJson, required, JourneyUnavailable } from "./todo/reference"

// The reference host's outbound HTTP recorder supplies append-only JSONL
// {method,path,body,at}; it must observe the App's transport, not browser traffic.
// No recorder means zero merge calls cannot be proved: refuse rather than skip.
test.use({ realScenario: { id: "journey-todo-merge", capabilities: [], coverage: ["host:production", "surface:todo", "surface:confirm", "door:button", "door:agent", "path:merge", "path:learning"] } })
test("C-J2-05 squash merge, fixes-only closure and stage-3 learning @production", async ({ browser }, info) => {
  test.setTimeout(960_000)
  const stage = process.env.SMITHERS_JOURNEY_STAGE ?? "S1"
  if (!["S1", "S2", "S3"].includes(stage)) throw new JourneyUnavailable("SMITHERS_JOURNEY_STAGE must be S1, S2 or S3")
  const auditPath = required("SMITHERS_JOURNEY_GITHUB_AUDIT_LOG")
  const audit = () => readFileSync(auditPath, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line))
  audit()
  await withReference(browser, info, async f => {
    const page = f.members.Will.page
    const merges = () => audit().filter(r => r.method === "PUT" && r.path.startsWith(`/repos/${f.repo}/pulls/`) && r.path.endsWith("/merge"))
    const session = await f.read("Will", "/api/session")
    expect(session.credential.kind).toBe("session")
    expect(session.credential.id).toBeTruthy()
    await f.github("Will", "PATCH", "", { allow_squash_merge: true })
    await f.github("Will", "PUT", "/branches/main/protection", {
      required_status_checks: { strict: false, contexts: ["canary/required"] },
      enforce_admins: true, required_pull_request_reviews: null, restrictions: null
    })
    const protection = await f.github("Will", "GET", "/branches/main/protection") as any
    expect(protection.required_status_checks.contexts).toEqual(["canary/required"])
    expect(protection.required_pull_request_reviews ?? null).toBeNull()
    await attachJson(info, "branch-protection", protection)
    await seedIssueSeven(f)
    expect((await f.github("Ben", "POST", "/issues", { title: "Document retries", body: "Add a retry example." }) as any).number).toBe(8)
    for (const [number, fixes] of [[7, true], [8, false]] as const) {
      await runSlash(page, `/issue ${number}`)
      await page.getByRole("button", { name: "Make TODO", exact: true }).click()
      // DraftView uses the mounted draft kind (06efaa113d); preserve all field assertions.
      const draft = page.locator('.smithers-card[data-kind="draft"]').last()
      await draft.getByLabel("Fixes", { exact: true }).setChecked(fixes)
      await draft.getByRole("button", { name: "Commit", exact: true }).click()
    }
    const initialTodos = await f.read("Will", "/api/todos")
    expect(initialTodos.map((t: any) => t.number)).toEqual([1, 2])
    const events = (id: string) => f.sql(`SELECT * FROM product_job_events WHERE mythical_item_id = '${id.replace(/'/g, "''")}' ORDER BY id`)
    const land = (id: string) => f.sql(`SELECT checks->'land' AS land FROM mythical_items WHERE id = '${id.replace(/'/g, "''")}'`)[0].land
    const status = async (sha: string, state: "pending" | "success") => {
      await f.github("Will", "POST", `/statuses/${sha}`, { context: "canary/required", state, description: `Required ${state}` })
      await f.github("Will", "POST", `/statuses/${sha}`, { context: "canary/optional", state: "failure", description: "Optional intentionally failed" })
    }
    const delegated = async (n: number, sha: string) => {
      // A real owner-scoped delegated credential requests confirmation; never
      // impersonate a person or manufacture the confirmation in the browser.
      const response = await page.context().request.post(new URL(`/api/todos/${n}/merge`, page.url()).toString(), {
        headers: { Authorization: `Bearer ${required("SMITHERS_JOURNEY_DELEGATED_TOKEN")}` }, data: { reviewed_head_sha: sha }
      })
      expect(response.status()).toBe(202)
      const body = await response.json()
      expect(body.confirmation_id).toBeTruthy()
      const card = page.locator('.smithers-card[data-kind="confirm"]').filter({ hasText: `T${n}` }).last()
      await expect(card).toBeVisible()
      return card
    }
    let secondBeforeMerge: any
    await expect.poll(async () => {
      const todos = await f.read("Will", "/api/todos")
      secondBeforeMerge = todos.find((t: any) => t.number === 2)
      return todos.map((t: any) => t.state)
    }, { timeout: 660_000, intervals: [1000, 2000] }).toEqual(["in_review", "in_review"])
    const secondOldHead = (await f.github("Will", "GET", `/pulls/${secondBeforeMerge.pr.number}`) as any).head.sha
    await status(secondOldHead, "success")
    let firstReviewedRevisions: unknown
    for (const n of [1, 2]) {
      let todo: any
      await expect.poll(async () => { todo = await f.read("Will", `/api/todos/${n}`); return todo.state }, { timeout: 660_000, intervals: [1000, 2000] }).toBe("in_review")
      if (n === 2) await expect.poll(async () => {
        todo = await f.read("Will", "/api/todos/2")
        const current = await f.github("Will", "GET", `/pulls/${todo.pr.number}`) as any
        return todo.state === "in_review" && current.head.sha !== secondOldHead
      }, { timeout: 660_000, intervals: [1000, 2000] }).toBe(true)
      if (n === 1) firstReviewedRevisions = todo.revisions
      const prPath = `/pulls/${todo.pr.number}`
      const reviewed = await f.github("Will", "GET", prPath) as any
      const sha = reviewed.head.sha
      if (n === 2) {
        expect(sha).not.toBe(secondOldHead)
        expect((await f.github("Will", "GET", `/commits/${sha}/status`) as any).statuses
          .filter((s: any) => s.context === "canary/required")).toEqual([])
      }
      const base = (await f.github("Will", "GET", "/commits/main") as any).sha
      await openTodo(page, n)
      const card = todoCard(page, n)
      await expect(card).toContainText(todo.evidence.find((e: any) => e.items.some((i: any) => i.kind === "review_summary")).items.find((i: any) => i.kind === "review_summary").text)
      await status(sha, "pending")
      await expect.poll(async () => (await f.read("Will", `/api/todos/${n}`)).merge_block?.reason, { timeout: 60_000 }).toBe("checks")
      const beforeCalls = merges().length
      for (const surface of [card, await delegated(n, sha)]) {
        await expect(surface).toContainText(/canary\/required.*required|required.*canary\/required/is)
        await expect(surface).toContainText(/canary\/optional.*optional|optional.*canary\/optional/is)
        await expect(surface).toContainText(/canary\/required.*pending|pending.*canary\/required/is)
        // The spec renders a reason instead of an enabled Merge when held.
        const action = surface.getByRole("button", { name: /^(Merge|Confirm|Approve)$/ })
        if (await action.count()) await expect(action).toBeDisabled()
      }
      const refused = await realApi(page, page.context().request, "POST", `/api/todos/${n}/merge`, { reviewed_head_sha: sha })
      expect(refused.status()).toBe(409)
      expect(await refused.json()).toMatchObject({ code: "checks", class: "conflict" })
      const recorded = audit()
      if (!recorded.some(r => r.method === "GET" && r.path === `/repos/${f.repo}${prPath}`))
        throw new JourneyUnavailable("Reference HTTP recorder did not observe the App readiness read; zero merge calls are unproven")
      expect(merges()).toHaveLength(beforeCalls)
      expect(land(todo.id) ?? null).toBeNull()
      await status(sha, "success") // same SHA; optional remains failed
      await expect.poll(async () => (await f.read("Will", `/api/todos/${n}`)).merge_block ?? null, { timeout: 60_000 }).toBeNull()
      const surface = n === 1 ? card : page.locator('.smithers-card[data-kind="confirm"]').filter({ hasText: "T2" }).last()
      await expect(surface).toContainText(/canary\/optional.*optional|optional.*canary\/optional/is)
      const uiFrames: unknown[] = []
      const uiFailures: string[] = []
      const binding = `journeyMergeFrame${n}`
      await page.exposeBinding(binding, async (_source, frame: { at: number; text: string }) => {
        uiFrames.push(frame)
        if (!/\bMerged\b/.test(frame.text)) return
        const remote = await f.github("Will", "GET", prPath) as any
        const main = await f.github("Will", "GET", "/commits?sha=main&per_page=3") as any[]
        if (!remote.merged || !main.some(c => c.sha === remote.merge_commit_sha))
          uiFailures.push(`Merged frame at ${frame.at} before GitHub merge/main containment`)
      })
      await card.evaluate((element, name) => {
        const pending: Promise<unknown>[] = []
        let previous = ""
        const capture = () => {
          const text = (element as HTMLElement).innerText
          if (text === previous) return
          previous = text
          pending.push((window as any)[name]({ at: Date.now(), text }))
        }
        const observer = new MutationObserver(capture)
        observer.observe(element, { subtree: true, childList: true, characterData: true, attributes: true })
        capture()
        ;(window as any)[`${name}Stop`] = async () => { capture(); observer.disconnect(); await Promise.all(pending) }
      }, binding)
      const request = page.waitForRequest(r => r.method() === "POST" && (new URL(r.url()).pathname === `/api/todos/${n}/merge` || new URL(r.url()).pathname.includes("/approve")))
      await surface.getByRole("button", { name: /^(Merge|Confirm|Approve)$/ }).click()
      const sent = await request
      if (n === 1) expect(sent.postDataJSON().reviewed_head_sha).toBe(sha)
      let merged: any, commits: any[], observedAt = 0
      const frames: unknown[] = []
      await expect.poll(async () => {
        // Read projection first, then independent remote facts: an early merged
        // observation cannot be excused by a preceding stale GitHub response.
        const state = await f.read("Will", `/api/todos/${n}`)
        const visible = await card.innerText()
        merged = await f.github("Will", "GET", prPath)
        commits = await f.github("Will", "GET", "/commits?sha=main&per_page=3") as any[]
        const contained = merged.merged && commits.some(c => c.sha === merged.merge_commit_sha)
        frames.push({ at: Date.now(), state: state.state, visible, merged: merged.merged, contained })
        if (state.state === "merged" || /\bMerged\b/.test(visible)) expect(contained).toBe(true)
        if (contained && !observedAt) observedAt = Date.now()
        return contained
      }, { timeout: 60_000, intervals: [100] }).toBe(true)
      await expect(card).toContainText("Merged", { timeout: Math.max(1, 60_000 - (Date.now() - observedAt)) })
      await page.evaluate(async name => { await (window as any)[`${name}Stop`]() }, binding)
      expect(uiFailures).toEqual([])
      expect((await f.read("Will", `/api/todos/${n}`)).state).toBe("merged")
      const commit = await f.github("Will", "GET", `/git/commits/${merged.merge_commit_sha}`) as any
      const head = await f.github("Will", "GET", `/git/commits/${sha}`) as any
      expect(commit.parents.map((p: any) => p.sha)).toEqual([base])
      expect(commit.tree.sha).toBe(head.tree.sha)
      expect(commits![0].sha).toBe(commit.sha)
      expect(commits![1].sha).toBe(base)
      const calls = merges().slice(beforeCalls)
      expect(calls).toHaveLength(1)
      expect(calls[0].body).toMatchObject({ sha, merge_method: "squash" })
      expect(land(todo.id)).toMatchObject({ by: "Will", credential_id: session.credential.id, head: sha })
      const issue = await f.github("Will", "GET", `/issues/${n + 6}`) as any
      if (n === 1) {
        await expect.poll(async () => (await f.github("Will", "GET", "/issues/7") as any).state, { timeout: 60_000 }).toBe("closed")
        const timeline = await f.github("Will", "GET", "/issues/7/timeline") as any[]
        expect(timeline.filter(e => e.event === "closed").at(-1).performed_via_github_app).toBeTruthy()
        const comments = await f.github("Will", "GET", "/issues/7/comments") as any[]
        expect(comments.some(c => c.performed_via_github_app && c.user.type === "Bot" && c.body.includes(merged.html_url))).toBe(true)
      } else expect(issue.state).toBe("open")
      await attachJson(info, `T${n}-merge`, { merged, issue: await f.github("Will", "GET", `/issues/${n + 6}`), frames, uiFrames, calls, land: land(todo.id), events: events(todo.id), commits: commits! })
      await info.attach(`T${n}-main-log`, { body: commits!.map(c => `${c.sha.slice(0, 7)} ${c.commit.message.split("\n")[0]}`).join("\n"), contentType: "text/plain" })
    }
    // T2 rebased after T1: its checks above were set on its new reviewed head,
    // rather than borrowing the old head's statuses.
    expect((await f.github("Will", "GET", "/issues/8") as any).state).toBe("open")
    if (stage === "S3") {
      const before = await f.read("Will", "/api/todos/1")
      let learning: any
      await expect.poll(async () => {
        const runs = await f.read("Will", "/api/runs")
        learning = runs.find((r: any) => r.flow === "learning" && r.input.todo === before.id)
        return learning?.state
      }, { timeout: 120_000 }).toBe("completed")
      await runSlash(page, "/home")
      await expect(home(page)).toContainText(learning.id)
      expect((await f.read("Will", "/api/todos")).map((t: any) => t.number)).toEqual([1, 2])
      await openTodo(page, 1)
      const after = await f.read("Will", "/api/todos/1")
      expect(after.state).toBe("merged"); expect(after.revisions).toEqual(firstReviewedRevisions)
      expect(after.lessons).toBeGreaterThanOrEqual(1)
      const receipt = todoCard(page, 1).getByRole("button", { name: `${after.lessons} lessons`, exact: true })
      await receipt.click()
      await expect(page.locator('[data-subject="wiki"], .smithers-card[data-kind="proposal"]').last()).toBeVisible()
      expect(events(before.id).filter(e => e.run_id === learning.id && (e.state || e.revision))).toEqual([])
      await attachJson(info, "learning-run-and-events", { learning, events: events(before.id), todo: after })
      await info.attach("learning-receipt", { body: await page.screenshot(), contentType: "image/png" })
    }
  })
})
