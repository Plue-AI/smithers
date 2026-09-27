import { expect, test } from "bun:test"
import { createAppStore } from "./AppStore"
import { scopedControllers } from "./ControllerTestScope"
import { memoryStorage, settle, unavailableAgent } from "./TestFixtures"

const createAppController = scopedControllers()
const setup = async (fetchImpl?: import("./AppController").AppServices["fetchImpl"]) => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const redirects: string[] = []
  const requests: string[] = []
  const controller = createAppController(store, unavailableAgent, {
    openExternal: async url => { redirects.push(url); return true },
    fetchImpl: async (input, init) => {
      requests.push(String(input))
      return fetchImpl ? fetchImpl(input, init) : Response.json({ message: "Unexpected request" }, { status: 404 })
    },
  })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-out", login: null, allowlisted: false, admin: false, scopesPlain: null }).isPersisted.promise
  await store.dispatch({ type: "repositories.loaded", actor: "system", repositories: [{ id: "smithersai/smithers", org: "smithersai", name: "smithers", ownerKind: "user", head: null }] }).isPersisted.promise
  await store.dispatch({ type: "repo.selected", actor: "user", id: "smithersai/smithers" }).isPersisted.promise
  await settle()
  requests.length = 0
  return { store, controller, redirects, requests }
}

// A repository read parks on repo-read, which an advertised public repository can satisfy; everything else on signed-in.
for (const [name, args, requirement] of [["flow.run", "review smithersai/smithers", "signed-in"], ["secrets.list", undefined, "signed-in"], ["issues.view", "3", "repo-read"]] as const) {
  test(`${name} signed out parks silently with exactly one sign-in prompt per click, without starting OAuth`, async () => {
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
    expect([...store.collections.messages.values()].filter(message => message.action?.flow === "auth.sign-in").sort((a, b) => a.ordinal - b.ordinal)).toHaveLength(2)
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


test("gates name the requested flow summary, with a plain fallback", async () => {
  const { controller, store } = await setup()
  await controller.commands.run("secrets.list")
  let prompts = [...store.collections.messages.values()].filter(message => message.action?.flow === "auth.sign-in").sort((a, b) => a.ordinal - b.ordinal)
  const summary = controller.commands.find("secrets.list")!.metadata.summary
  expect(prompts.at(-1)?.text).toBe(`Sign in with GitHub to ${summary[0]!.toLowerCase()}${summary.slice(1).replace(/[.!?]$/, "")}.`)
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

/*
 * A repository read parks on repo-read, not signed-in; the gate must still
 * name the flow the user asked for, never the generic fallback.
 */
for (const [name, args] of [["issues.view", "3"], ["issues.comment", "3 Looks right to me"]] as const) {
  test(`${name} signed out on a private repository names its own summary in the sign-in line`, async () => {
    const { controller, store } = await setup()
    await controller.commands.run(name, args)
    await settle()
    const prompts = [...store.collections.messages.values()].filter(message => message.action?.flow === "auth.sign-in").sort((a, b) => a.ordinal - b.ordinal)
    const summary = controller.commands.find(name)!.metadata.summary
    expect(prompts.at(-1)?.text).toBe(`Sign in with GitHub to ${summary[0]!.toLowerCase()}${summary.slice(1).replace(/[.!?]$/, "")}.`)
    expect([...store.collections.cards.values()].filter(card => card.kind === "issue")).toEqual([])

  })
}
