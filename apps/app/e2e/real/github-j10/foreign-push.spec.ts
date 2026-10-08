import { journeyActivate, journeyEnter, keyboardInputFor, registerKeyboardJourney } from "../support/keyboard-journey-input"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { test } from "../support"
import { scenario } from "../coverage/types"
import { attachJson, expect, required, runSlash } from "../todo/reference"
import { waitTodo, withJ10Install, type J10Install } from "./install"

// C-J10-03. Production app, HTTP, sync and stack; only GitHub and the model
// provider differ in the composed rehearsal. On the reference install people
// push themselves; the operator records A1/A2/A3 in the evidence file. This
// test never uses a real GitHub credential to write a repository.
const cardOf = (f: J10Install, n: number) => f.read("Owner", `/api/todos/${n}`)
const foreign = (card: any, sha: string) => card.waits.find((wait: any) => wait.kind === "foreign_push" && wait.sha === sha)
const push = async (f: J10Install, branch: string, stage: "A1" | "A2" | "A3"): Promise<string> => {
  if (f.kind === "composed") {
    const host = JSON.parse(readFileSync(required("SMITHERS_J10_COMPOSED_HOST"), "utf8"))
    const response = await fetch(host.push, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ Branch: branch, File: `${stage}.md`, Text: `Laptop ${stage}\n` }) })
    expect(response.ok, await response.clone().text()).toBe(true)
    return (await response.json()).sha
  }
  let sha = ""
  await expect.poll(() => {
    sha = JSON.parse(readFileSync(required("SMITHERS_FOREIGN_PUSH_OPERATOR_EVIDENCE"), "utf8"))[stage] ?? ""
    return sha
  }, { message: `Person pushes ${stage} from the laptop and records its SHA`, timeout: 20 * 60_000 }).toMatch(/^[a-f0-9]{40}$/)
  return sha
}
const waitForeign = async (f: J10Install, n: number, sha: string) => {
  let card: any
  await expect.poll(async () => { card = await cardOf(f, n); return !!foreign(card, sha) }, { timeout: 60_000 }).toBe(true)
  expect(card.state).toBe("needs_you")
  return card
}
const answer = (f: J10Install, actor: "Owner" | "Ben", branch: string, op: string, id: string, revision: string) =>
  f.api(actor, "POST", `/api/branches/${encodeURIComponent(branch)}`, { op, id, revision }, `${op}-${actor}-${id}-${revision}`)
const hold = async (f: J10Install, pr: number, sha: string, ms: number, samples: unknown[]) => {
  for (const until = Date.now() + ms; Date.now() < until;) {
    const pull = await f.github.pull(pr)
    const remote = f.kind === "composed"
      ? JSON.parse(readFileSync(required("SMITHERS_J10_COMPOSED_HOST"), "utf8")).github.git
      : `https://github.com/${f.repo}.git`
    const listing = execFileSync("git", ["ls-remote", remote, `refs/heads/${pull.head.ref}`], { encoding: "utf8", timeout: 30_000 }).trim()
    const head = listing.split(/\s+/)[0]
    expect(head).toBe(pull.head.sha)
    samples.push({ at: new Date().toISOString(), head, listing })
    expect(head, "No publication over a person's unaccepted push").toBe(sha)
    await new Promise(resolve => setTimeout(resolve, 2_000))
  }
}

test("C-J10-03 foreign pushes hold publication and bind Bring in and Discard to the displayed wait", scenario("journey-github-foreign-push", {
  capabilities: [], coverage: ["host:local", "host:production", "door:button", "action:branch.bring-in", "action:branch.discard-foreign", "path:success", "path:permission", "path:error", "surface:todo", "evidence:database-readback", "dimension:github", "dimension:keyboard"],
  description: "Outside pushes are held, stale answers refuse, Bring in preserves ancestry, and Discard keeps commits."
}), async ({ browser }, info) => {
  test.setTimeout(60 * 60_000)
  await withJ10Install(browser, info, async f => {
    const filed = await f.api("Owner", "POST", "/api/todos", { title: "Retry webhooks", prompt: f.prompt("retry-webhooks.md", "Retry failed webhook deliveries."), acceptance: [], place: { mode: "append" } }, "foreign-push-todo")
    expect(filed.status).toBe(202)
    const n: number = filed.body.n
    const before = await waitTodo(f, n, "in_review", undefined, 15 * 60_000)
    const pr = before.pr.number
    const branch = (await f.github.pull(pr)).head.ref
    const page = f.members.Owner.page
    const keys = keyboardInputFor(page) ?? registerKeyboardJourney(page, f.origin)
    await keys.ready()
    try {
      await runSlash(page, `/todo T${n}`)
      const view = page.getByRole("article", { name: `TODO T${n}`, exact: true }).last()
      const samples: unknown[] = []
      // A real planning question stays independent of the outside-push wait.
      const asked = await f.api("Owner", "POST", `/api/todos/${n}`, { steer: `${f.kind === "composed" ? "[ASK] " : ""}Before editing, ask me which greeting to use.` }, "foreign-question-steer")
      expect(asked.status).toBe(202)
      let question: any
      await expect.poll(async () => { question = (await cardOf(f, n)).waits.find((wait: any) => wait.kind === "question"); return !!question }, { timeout: f.kind === "composed" ? 5 * 60_000 : 15 * 60_000 }).toBe(true)
      const a1 = await push(f, branch, "A1")
      const first = await waitForeign(f, n, a1)
      const w1 = foreign(first, a1)
      await expect(page.locator(`[data-notice="toast-todo.needs-you.${n}.${w1.id}"]`)).toBeVisible()
      await info.attach("foreign-push-toast", { body: await page.screenshot(), contentType: "image/png" })
      expect(first.waits.map((wait: any) => wait.kind).sort()).toEqual(["foreign_push", "question"])
      expect(first.waits.find((wait: any) => wait.id === question.id)).toEqual(question)
      expect(w1.by.login).toBe(f.members.Ben.login)
      await expect(view).toContainText(`pushed to \`${branch}\` on GitHub`)
      await expect(view.locator(`a[href="https://github.com/${f.repo}/commit/${a1}"]`)).toBeVisible()
      await expect(view.getByRole("button", { name: "Bring in", exact: true })).toBeVisible()
      // Wrong wait identity and revision do not settle the wait or launch checks.
      for (const [id, revision] of [["wrong-wait", a1], [question.id, a1], [w1.id, before.pr.head]]) {
        const refused = await answer(f, "Owner", branch, "bring-in", id, revision)
        expect(refused.status).toBe(409)
        expect(refused.body.class).toBe("conflict")
        expect((await cardOf(f, n)).waits).toEqual(first.waits)
      }
      await f.api("Owner", "POST", `/api/todos/${n}`, { steer: "Add a log line on each retry." }, "foreign-held-steer")
      await hold(f, pr, a1, f.kind === "composed" ? 10_000 : 10 * 60_000, samples)
      await journeyActivate(view.getByRole("button", { name: "Bring in", exact: true }))
      await journeyActivate(page.getByRole("button", { name: "Confirm: bring in this outside push", exact: true }).last())
      await expect.poll(async () => !!foreign(await cardOf(f, n), a1), { timeout: 15 * 60_000 }).toBe(false)
      const independent = await cardOf(f, n)
      expect(independent.waits).toEqual([question])
      await journeyEnter(view.getByRole("textbox"), "Hello from the retry worker")
      await journeyActivate(view.getByRole("button", { name: "Answer", exact: true }))
      try {
        await waitTodo(f, n, "in_review", async card => card.pr.head !== before.pr.head && (await cardOf(f, n)).waits.length === 0, 15 * 60_000)
      } catch (error) {
        await attachJson(info, "failed-run-receipts", f.sql("SELECT id, terminal_receipt FROM product_job_requests WHERE terminal_receipt IS NOT NULL"))
        throw error
      }
      const brought = await cardOf(f, n)
      expect(brought.pr.number).toBe(pr)
      expect(await f.github.contains(a1, brought.pr.head), "Bring in's verified head descends from the person's push").toBe(true)
      expect((await f.github.commit(brought.pr.head)).paths).toContain("A1.md")
      expect(await f.github.file(brought.pr.head, "A1.md")).toBe(await f.github.file(a1, "A1.md"))
      if (f.kind === "composed") expect(await f.github.file(brought.pr.head, "A1.md")).toBe("Laptop A1\n")
      const activity = f.sql(`SELECT data FROM product_job_events WHERE event_type='todo.foreign_brought-in' AND data->>'n'='${n}'`)
      expect(activity).toHaveLength(1)
      expect(activity[0].data.pusher.login).toBe(f.members.Ben.login)
      expect(activity[0].data.actor.login).toBe(f.members.Ben.login)

      const steering = await f.api("Owner", "POST", `/api/todos/${n}`, { steer: "Also log the attempt number." }, "foreign-working-steer")
      expect(steering.status).toBe(202)
      await expect.poll(async () => (await cardOf(f, n)).state, { timeout: 5 * 60_000, intervals: [100] }).toBe("working")
      const a2 = await push(f, branch, "A2")
      const second = await waitForeign(f, n, a2)
      const w2 = foreign(second, a2)
      const denied = await answer(f, "Ben", branch, "discard-foreign", w2.id, a2)
      expect(denied.status).toBe(403)
      expect(denied.body.class).toBe("permission")
      // Wait for a real verified candidate before measuring the publication hold.
      await expect.poll(() => f.sql(`SELECT candidate_verified FROM mythical_items WHERE number=${n}`)[0]?.candidate_verified, { timeout: 15 * 60_000 }).toBe(true)
      await hold(f, pr, a2, f.kind === "composed" ? 10_000 : 5 * 60_000, samples)
      const a3 = await push(f, branch, "A3")
      const third = await waitForeign(f, n, a3)
      const w3 = foreign(third, a3)
      const stale = await answer(f, "Owner", branch, "discard-foreign", w2.id, a2)
      expect(stale.status).toBe(409)
      expect(stale.body.class).toBe("conflict")
      expect((await cardOf(f, n)).waits).toEqual(third.waits)
      await expect(view).toContainText(a3.slice(0, 7))
      await journeyActivate(view.getByRole("button", { name: "Discard", exact: true }))
      await journeyActivate(page.getByRole("button", { name: "Confirm: discard this outside push", exact: true }).last())
      await expect.poll(async () => !!foreign(await cardOf(f, n), a3)).toBe(false)
      const discarded = await waitTodo(f, n, "in_review", card => card.pr.head !== brought.pr.head, 15 * 60_000)
      expect(await f.github.file(discarded.pr.head, "A1.md")).toBe(await f.github.file(a1, "A1.md"))
      expect(await f.github.contains(a2, discarded.pr.head)).toBe(false)
      expect(await f.github.contains(a3, discarded.pr.head)).toBe(false)
      const events = await f.read("Owner", `/api/todos/${n}/events`)
      expect(JSON.stringify(events)).toContain(`refs/smithers/kept/${a3}`)
      const kept = f.kind === "composed"
        ? execFileSync("/usr/bin/git", ["--git-dir", JSON.parse(readFileSync(required("SMITHERS_J10_COMPOSED_HOST"), "utf8")).kept, "for-each-ref", "--format=%(refname) %(objectname)", "refs/smithers/kept/"], { encoding: "utf8" })
        : readFileSync(required("SMITHERS_FOREIGN_PUSH_KEPT_REFS"), "utf8")
      for (const sha of [a2, a3]) expect(kept).toContain(`refs/smithers/kept/${sha} ${sha}`)
      await info.attach("kept-refs", { body: kept, contentType: "text/plain" })
      await attachJson(info, "foreign-push-evidence", { a1, a2, a3, waits: [w1, w2, w3], samples, activity, before, brought, discarded, events })
      await info.attach("foreign-push-card", { body: await page.screenshot(), contentType: "image/png" })
      keys.finish()
    } finally {
      await attachJson(info, "foreign-push-keyboard", keys.snapshot())
    }
  })
})
