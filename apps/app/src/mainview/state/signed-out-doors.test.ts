import { expect, test } from "bun:test"
import type { AppBootstrap } from "@smthrs/rpc/AppBootstrap"
import { cloudCapabilities } from "@smthrs/rpc/HostCapabilities"
import { createAppStore } from "./AppStore"
import { scopedControllers } from "./ControllerTestScope"
import { memoryStorage, settle, unavailableAgent } from "./TestFixtures"

const createAppController = scopedControllers()
const WEB: AppBootstrap = { apiVersion: 1, host: "cloud", version: "test", buildSha: "test",
  capabilities: cloudCapabilities({ identity: true, cloud: true, agent: true, checkout: true, terminal: false }),
  authFlow: "redirect", sandbox: null }
const setup = async (fetchImpl?: import("./AppController").AppServices["fetchImpl"]) => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const redirects: string[] = []
  const requests: string[] = []
  const controller = createAppController(store, unavailableAgent, {
    bootstrap: WEB,
    openExternal: async url => { redirects.push(url); return true },
    fetchImpl: async (input, init) => {
      requests.push(String(input))
      return fetchImpl ? fetchImpl(input, init) : Response.json({ message: "Unexpected request" }, { status: 404 })
    },
  })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-out", login: null, admin: false, scopesPlain: null }).isPersisted.promise
  await store.dispatch({ type: "repositories.loaded", actor: "system", repositories: [{ id: "smithersai/smithers", org: "smithersai", name: "smithers", ownerKind: "user", head: null }] }).isPersisted.promise
  await store.dispatch({ type: "repo.selected", actor: "user", id: "smithersai/smithers" }).isPersisted.promise
  await settle()
  requests.length = 0
  return { store, controller, redirects, requests }
}

// A repository read parks on repo-read, which an advertised public repository can satisfy; everything else on signed-in.
for (const [name, args, requirement] of [["flow.run", "review smithersai/smithers", "signed-in"], ["secrets.list", undefined, "signed-in"], ["issues.view", "3", "repo-read"]] as const) {
  test(`${name} signed out parks silently with one sign-in prompt across repeated clicks, without starting OAuth`, async () => {
    const { controller, store, requests, redirects } = await setup()
    controller.runCommand(name, args)
    await settle()
    expect([...store.collections.messages.values()].filter(message => message.action?.flow === "auth.sign-in").sort((a, b) => a.ordinal - b.ordinal)).toHaveLength(1)
    expect(store.session().pendingCommand).toMatchObject({ name, args: args ?? null, requirement })
    expect(requests).toEqual([])
    expect(redirects).toEqual([])
    const toasts = [...store.collections.toasts.values()]
    expect(toasts).toEqual([])
    controller.runCommand(name, args)
    await settle()
    // The repeat parks again but does not pile a second identical step under the first.
    expect([...store.collections.messages.values()].filter(message => message.action?.flow === "auth.sign-in").sort((a, b) => a.ordinal - b.ordinal)).toHaveLength(1)
    const events = [...store.collections.transitions.values()]
    expect(events.filter(record => record.type === "command.deferred")).toHaveLength(2)
    expect(events.filter(record => record.type.startsWith("toast."))).toEqual([])
  })
}

for (const source of ["issues", "github", "prs"] as const) {
  test(`${source} 401 renders a prompt, never an empty list or refusal toast`, async () => {
    const { controller, store, redirects } = await setup(async input => {
      if (source === "github" && !String(input).includes("github-repos")) return Response.json([])
      return Response.json({ message: "Sign in to read this repository" }, { status: 401 })
    })
    controller.runCommand(source === "prs" ? "prs.list" : "issues.list")
    await settle()
    expect([...store.collections.messages.values()].filter(message => message.action?.flow === "auth.sign-in").sort((a, b) => a.ordinal - b.ordinal)).toHaveLength(1)
    expect([...store.collections.cards.values()].filter(card => card.kind === "issue-list" || card.kind === "pr-list")).toEqual([])
    expect([...store.collections.toasts.values()]).toEqual([])
    expect(redirects).toEqual([])
  })
}


test("gates never copy a registry summary; a named launch keeps its repository", async () => {
  const { controller, store } = await setup()
  await controller.commands.run("secrets.list")
  let prompts = [...store.collections.messages.values()].filter(message => message.action?.flow === "auth.sign-in").sort((a, b) => a.ordinal - b.ordinal)
  expect(prompts.at(-1)?.text).toBe("Sign in with GitHub to continue.")
  await controller.commands.runForAgent("flow.run", "unpublished smithersai/smithers")
  prompts = [...store.collections.messages.values()].filter(message => message.action?.flow === "auth.sign-in").sort((a, b) => a.ordinal - b.ordinal)
  expect(prompts.at(-1)?.text).toBe("Sign in with GitHub to run unpublished on smithersai/smithers.")
})

test("a repository launch names its human summary and repository for both actors", async () => {
  for (const actor of ["user", "agent"] as const) {
    const { controller, store } = await setup()
    await store.dispatch({ type: "repository-flows.loaded", actor: "system", repo: "smithersai/smithers", flows: [
      { id: "internal-review-42", summary: "Review the changes", description: "Review", featured: true, model: null, modelInvocable: true }
    ] }).isPersisted.promise
    if (actor === "agent") await controller.commands.runForAgent("flow.run", "internal-review-42 smithersai/smithers")
    else await controller.commands.run("flow.run", "internal-review-42 smithersai/smithers")
    const prompt = [...store.collections.messages.values()].find(message => message.action?.flow === "auth.sign-in")
    expect(prompt?.text).toBe("Sign in with GitHub to review the changes on smithersai/smithers.")
    expect(prompt?.text).not.toContain("internal-review-42")
  }
})

/* A repository read parks on repo-read, not signed-in, behind the same short step. */
for (const [name, args] of [["issues.view", "3"], ["issues.comment", "3 Looks right to me"]] as const) {
  test(`${name} signed out on a private repository parks behind the short sign-in line`, async () => {
    const { controller, store } = await setup()
    await controller.commands.run(name, args)
    await settle()
    const prompts = [...store.collections.messages.values()].filter(message => message.action?.flow === "auth.sign-in").sort((a, b) => a.ordinal - b.ordinal)
    expect(prompts.at(-1)?.text).toBe("Sign in with GitHub to continue.")
    expect([...store.collections.cards.values()].filter(card => card.kind === "issue")).toEqual([])

  })
}

/*
 * #2285: the chrome doors a signed-out visitor presses in turn. Each renders
 * the one GitHub sign-in step (not an instruction to type /cloud.sign-in, not
 * the flow's internal description), Flows opens no empty pane, no refusal
 * toast fires, and the repeats leave one step, not a pile.
 */
test("signed-out chrome doors share one short GitHub sign-in step", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = createAppController(store, unavailableAgent, {
    bootstrap: WEB,
    fetchImpl: async () => Response.json({ message: "Unexpected request" }, { status: 404 })
  })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-out", login: null, admin: false, scopesPlain: null }).isPersisted.promise
  await settle()
  const doors = ["triggers.list", "flow.list", "secrets.list", "history.show"]
  for (const door of doors) expect(controller.commands.find(door)).toBeDefined()
  for (const door of doors) {
    controller.runCommand(door)
    await settle()
    expect(store.session().surface).not.toBe("flows")
  }
  const prompts = [...store.collections.messages.values()].filter(message => message.action?.flow === "auth.sign-in")
  expect(prompts.map(message => [message.text, message.action?.label])).toEqual([["Sign in with GitHub to continue.", "Sign in with GitHub"]])
  expect([...store.collections.messages.values()].some(message => message.text.includes("/cloud.sign-in"))).toBe(false)
  expect([...store.collections.toasts.values()]).toEqual([])
})
