import { expect, test } from "bun:test"
import type { AgentPort } from "../../runtime/AgentPort"
import { createAppController } from "../../state/AppController"
import { createAppStore } from "../../state/AppStore"
import { memoryStorage } from "../../state/TestFixtures"
import { MAYA } from "../../state/seams/DesignWorld"
import { modelInvocable, nameOf } from "../registry"

const unavailable: AgentPort = { available: false, startTurn: async () => ({ status: "error", message: "unavailable" }), cancelTurn: async () => {}, subscribe: () => () => {} }
const boot = async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = createAppController(store, unavailable, { fetchImpl: async () => new Response("{}", { status: 404 }) })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "maya", admin: false, scopesPlain: null }).isPersisted.promise
  const card = (id: string) => store.collections.cards.get(id)
  const run = (name: string, args?: string) => controller.runCommandForResult(name, args)
  return { store, controller, card, run, design: controller.design }
}
const agent = (controller: Awaited<ReturnType<typeof boot>>["controller"], name: string, args?: string) => controller.commands.executeForAgent({
  name: "commands", arguments: JSON.stringify({ action: "execute", name, args })
})

test("the subject flows register under their Appendix A names, every one model-invocable", async () => {
  const h = await boot()
  try {
    const names = new Set(h.controller.commands.entries().map(nameOf))
    for (const name of ["issue", "issues", "issue.new", "issue.comment", "file", "files", "file.restore", "diff", "pr", "wiki.page"]) {
      expect(names.has(name)).toBe(true)
      expect(modelInvocable(h.controller.commands.entries().find(entry => nameOf(entry) === name)!)).toBe(true)
    }
  } finally { h.controller.dispose() }
})

test("/issue opens the seeded issue's card; an unknown number refuses", async () => {
  const h = await boot()
  try {
    expect((await h.run("issue", "#231")).status).toBe("executed")
    const card = h.card("design:issue:231")
    expect(card?.kind).toBe("issue")
    expect(card?.title).toBe("#231 Password reset emails arrive twice")
    expect(await h.run("issue", "999")).toEqual({ status: "failed", error: "No issue #999" })
    expect((await h.run("issues")).status).toBe("executed")
    expect(h.card("design:issues")?.kind).toBe("issue-list")
    expect(await agent(h.controller, "issue", "212")).toContain("Opened #212")
  } finally { h.controller.dispose() }
})

test("/issue.new writes the next GitHub number; without input it asks with a form", async () => {
  const h = await boot()
  try {
    await h.run("issue.new")
    expect([...h.store.collections.cards.values()].some(card => card.kind === "flow-form")).toBe(true)
    const result = await h.run("issue.new", JSON.stringify({ title: "Invoice totals round wrong", body: "42.004 prints as 42.00" }))
    expect(result).toEqual({ status: "executed", value: "Opened #236 on GitHub" })
    const issue = h.design.world().issues.find(each => each.number === 236)
    expect(issue).toMatchObject({ title: "Invoice totals round wrong", author: MAYA, open: true })
    expect((await h.run("issue.comment", "#231 Both mailers handle password.reset")).status).toBe("executed")
    expect(h.design.world().issues.find(each => each.number === 231)?.comments.at(-1)).toMatchObject({ who: MAYA, text: "Both mailers handle password.reset" })
  } finally { h.controller.dispose() }
})

test("/file finds a file by basename on its branch; /files lists a branch", async () => {
  const h = await boot()
  try {
    expect((await h.run("file", "retry.ts")).status).toBe("executed")
    expect(h.card("design:file:b-retry:src/webhooks/retry.ts")?.kind).toBe("file")
    expect((await h.run("file", JSON.stringify({ path: "src/mail/reset.ts", line: 4 }))).status).toBe("executed")
    expect(h.card("design:file:main:src/mail/reset.ts")?.payload).toMatchObject({ line: 4, ref: "main" })
    expect(await h.run("file", "nope.ts")).toEqual({ status: "failed", error: "No file nope.ts" })
    expect((await h.run("files")).status).toBe("executed")
    expect(h.card("design:files:main")?.kind).toBe("file-list")
    expect((await h.run("files", "retry-webhooks")).status).toBe("executed")
    expect(h.card("design:files:b-retry")).toBeDefined()
  } finally { h.controller.dispose() }
})

test("/diff opens the item's evidence by default, a file's diff by path, a branch's by name", async () => {
  const h = await boot()
  try {
    expect((await h.run("diff")).status).toBe("executed")
    expect(h.card("design:diff:b-stripe")?.title).toBe("Diff · upgrade-stripe")
    expect((await h.run("diff", "retry.ts")).status).toBe("executed")
    expect(h.card("design:diff:b-retry:src/webhooks/retry.ts")?.kind).toBe("diff")
    expect((await h.run("diff", JSON.stringify({ branch: "b-retry", entry: "b-retry-a1" }))).status).toBe("executed")
    expect(h.card("design:diff:b-retry")).toBeDefined()
    expect(await h.run("diff", "nope")).toEqual({ status: "failed", error: "Nothing to diff for nope" })
    expect((await h.run("file.restore", JSON.stringify({ path: "src/webhooks/retry.ts", revision: "before" }))).status).toBe("executed")
  } finally { h.controller.dispose() }
})

test("/pr and /wiki.page open their subjects; an unknown page is created at r1", async () => {
  const h = await boot()
  try {
    expect((await h.run("pr", "#88")).status).toBe("executed")
    expect(h.card("design:pr:88")?.title).toBe("#88 Upgrade the Stripe SDK to v17")
    expect(await h.run("pr", "1")).toEqual({ status: "failed", error: "No pull request #1" })
    expect((await h.run("wiki.page", "Webhook retries")).status).toBe("executed")
    expect(h.card("design:wiki:webhook-retries")?.kind).toBe("world")
    expect((await h.run("wiki.page", "Checkout test race")).status).toBe("executed")
    expect(h.design.row("wiki", "checkout-test-race")).toMatchObject({ title: "Checkout test race", rev: 1, authors: [MAYA] })
    expect(h.card("design:wiki:checkout-test-race")?.title).toBe("Checkout test race")
  } finally { h.controller.dispose() }
})
