import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import type { Signup } from "../state/Signup"
import { initialSignup } from "../state/Signup"
import { createAppStore } from "../state/AppStore"
import { scopedControllers } from "../state/ControllerTestScope"
import { memoryStorage, silentAgent } from "../state/TestFixtures"
import { ControllerContext } from "../ControllerContext"
import type { AppController } from "../state/AppController"
import { SignupCardBody, SignupCards, welcome } from "./SignupCards"

GlobalRegistrator.register()
afterAll(async () => {
  for (let tick = 0; tick < 3; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0))
  await GlobalRegistrator.unregister()
})

const mounted: Array<() => void> = []
afterEach(() => { for (const unmount of mounted.splice(0)) unmount() })

const render = (signup: Signup, repos: ReadonlyArray<{ id: string }> = [], doors = true) => {
  const calls: Array<[string, string | undefined]> = []
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  flushSync(() => { root.render(<SignupCardBody signup={signup} repos={repos} doors={doors} onRunCommand={(name, args) => { calls.push([name, args]) }} />) })
  mounted.push(() => { flushSync(() => root.unmount()); host.remove() })
  const flows = () => [...host.querySelectorAll<HTMLElement>("button[data-flow]")].map(b => [b.textContent?.trim(), b.dataset.flow, b.dataset.flowArgs])
  return { host, calls, flows }
}

describe("the signup cards", () => {
  test("typing every signup field retains its latest text while command persistence is blocked", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const pending: Array<Promise<unknown>> = []
    const controller = scopedControllers()({
      ...store,
      dispatch: transition => {
        const transaction = store.dispatch(transition)
        if (transition.type !== "command.intent.accepted") return transaction
        return new Proxy(transaction, { get: (target, property, receiver) => property === "isPersisted"
          ? { ...target.isPersisted, promise: target.isPersisted.promise.then(() => held) }
          : Reflect.get(target, property, receiver) })
      }
    }, silentAgent)
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    const project = () => flushSync(() => root.render(<SignupCardBody signup={store.session().signup ?? initialSignup()} repos={[]} onRunCommand={(name, args) => {
      pending.push(controller.commands.run(name, args))
    }} />))
    const subscription = store.collections.sessions.subscribeChanges(project)
    try {
      const cases = [
        { field: "name", testId: "signup-name", value: "Ada Park " },
        { field: "account", testId: "signup-account", value: "ada park " }
      ] as const
      controller.signupChange({ stage: "account" })
      for (const { field, testId, value } of cases) {
        project()
        const input = host.querySelector<HTMLInputElement>(`[data-testid="${testId}"]`)!
        input.focus()
        for (let index = 1; index <= value.length; index++) {
          input.value = value.slice(0, index)
          input.dispatchEvent(new Event("input", { bubbles: true }))
          project() // A stale session projection must not restore an old value.
          expect(input.value).toBe(value.slice(0, index))
        }
        expect(store.session().signup?.draft[field]).not.toBe(value)
      }
      release()
      await Promise.all(pending)
      await store.settled?.()
      for (const { field, value } of cases) expect(store.session().signup?.draft[field]).toBe(value)
    } finally {
      release()
      subscription.unsubscribe()
      flushSync(() => root.unmount())
      host.remove()
      await Promise.resolve(controller.dispose()).catch(() => {})
      await Promise.resolve(store.dispose?.()).catch(() => {})
    }
  })

  test("the first card carries the title and offers the GitHub door alone, through auth.sign-in", () => {
    const { host, flows, calls } = render(initialSignup())
    expect(host.querySelector("h1")?.textContent?.replace(/\s+/g, " ").trim()).toBe("Automate maintaining your codebase")
    expect(flows()).toEqual([["Continue with GitHub", "auth.sign-in", undefined]])
    expect(host.querySelectorAll("input, form")).toHaveLength(0)
    host.querySelector<HTMLButtonElement>('[data-testid="signup-github"]')!.click()
    expect(calls).toEqual([["auth.sign-in", undefined]])
  })

  test("before identity answers, a first visit paints the title alone: no door, no receipt", () => {
    const { host, flows } = render(initialSignup(), [], false)
    expect(host.querySelector("h1")?.textContent?.replace(/\s+/g, " ").trim()).toBe("Automate maintaining your codebase")
    expect(flows()).toEqual([])
    expect(host.querySelector("form")).toBeNull()
    expect(host.querySelector('nav[aria-label="Legal"]')).toBeNull()
    expect(host.querySelectorAll("a")).toHaveLength(0)
  })

  test("sign-in offers focusable legal links after GitHub without leaving signup", () => {
    const { host, calls } = render(initialSignup())
    const legal = host.querySelector<HTMLElement>('nav[aria-label="Legal"]')
    expect(legal).not.toBeNull()
    const github = host.querySelector<HTMLButtonElement>('[data-testid="signup-github"]')!
    const links = [...legal!.querySelectorAll<HTMLAnchorElement>("a")]
    expect(links.map(link => [link.textContent, link.getAttribute("href")])).toEqual([
      ["Terms", "https://smithers.sh/terms/"],
      ["Privacy", "https://smithers.sh/privacy/"]
    ])
    expect([...host.querySelectorAll("button, a")]).toEqual([github, ...links])
    for (const link of links) {
      expect(link.tabIndex).toBe(0)
      expect(link.getAttribute("target")).toBe("_blank")
      expect(link.rel.split(/\s+/).sort()).toEqual(["noopener", "noreferrer"])
      link.focus()
      expect(document.activeElement).toBe(link)
      // Native navigation belongs to the browser; prevent it in this DOM-only test.
      link.addEventListener("click", event => event.preventDefault(), { once: true })
      link.click()
      expect(host.querySelector('[data-testid="signup"]')?.getAttribute("data-stage")).toBe("sign-in")
      expect(host.querySelector('[data-testid="signup-github"]')).toBe(github)
      expect(calls).toEqual([])
    }
  })

  for (const stage of ["account", "poll", "ready", "done"] as const) {
    test(`${stage} does not repeat the sign-in legal links`, () => {
      const { host } = render({ ...initialSignup(), stage, door: "github" })
      expect(host.querySelector('nav[aria-label="Legal"]')).toBeNull()
      expect(host.querySelectorAll("a")).toHaveLength(0)
    })
  }

  test("the account step shows only itself, with the GitHub name and login prefilled, and submits through signup.account", () => {
    const { host, calls } = render({ ...initialSignup(), stage: "account", door: "github", account: "adapark", draft: { account: "adapark", name: "Ada Park" } })
    expect(host.querySelector<HTMLInputElement>('[data-testid="signup-name"]')?.value).toBe("Ada Park")
    expect(host.querySelector<HTMLInputElement>('[data-testid="signup-account"]')?.value).toBe("adapark")
    expect(host.querySelector(".signup-prefix")?.textContent).toBe("smithers.sh/")
    expect(host.querySelector(".signup-url")?.getAttribute("data-valid")).toBe("true")
    // No receipt of the sign-in before it: the signup holds this one card.
    expect([...host.querySelector('[data-testid="signup"]')!.children].map(child => child.getAttribute("aria-label"))).toEqual(["Finish creating your account"])
    expect(host.textContent).not.toContain("GitHub")
    host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
    expect(calls).toEqual([["signup.account", undefined]])
  })

  test("the poll is the repository question alone: the GitHub repositories, a new repo and Skip, with no progress, Back or earlier steps", () => {
    const { host, flows, calls } = render({ ...initialSignup(), stage: "poll", door: "github", name: "Ada Park", account: "adapark" }, [{ id: "adapark/hello-server" }])
    expect([...host.querySelector('[data-testid="signup"]')!.children].map(child => child.getAttribute("data-question"))).toEqual(["repo"])
    const card = host.querySelector('[data-testid="signup-question"]')!
    expect([...card.children].map(child => child.tagName.toLowerCase())).toEqual(["h2", "div", "div"])
    expect(card.querySelector("h2")?.textContent).toBe("Do you have a repo you would like to connect?")
    expect(flows()).toEqual([
      ["adapark/hello-server", "signup.repo", "adapark/hello-server"],
      ["+ Try Smithers on a new repo", "signup.repo", "new"],
      ["Skip", "signup.next", undefined]
    ])
    expect(host.textContent).not.toContain("smithers.sh/adapark")
    host.querySelector<HTMLButtonElement>('[data-testid="signup-skip"]')!.click()
    expect(calls).toEqual([["signup.next", undefined]])
  })

  test.each([4, 6])("a row saved at seven-question index %i opens the repository question", question => {
    const { host, flows } = render({ ...initialSignup(), stage: "poll", question, answers: { size: "2–10" } })
    expect(host.querySelector('[data-testid="signup-question"]')?.getAttribute("data-question")).toBe("repo")
    expect(flows().map(row => row[1])).toEqual(["signup.repo", "signup.next"])
  })

  test("ready greets the person, shows the account URL and the giant Start Automating door, and nothing it cannot play", () => {
    const { host, flows } = render({ ...initialSignup(), stage: "ready", door: "github", repo: "new", answers: { repo: "new" }, account: "adapark", name: "  Ada  Park " })
    expect([...host.querySelector('[data-testid="signup"]')!.children].map(child => child.getAttribute("aria-label"))).toEqual(["Welcome"])
    expect(host.querySelector("h2")?.textContent).toBe("Welcome, Ada")
    expect(host.querySelector(".signup-url-line")?.textContent).toBe("smithers.sh/adapark")
    expect(flows()).toEqual([["Start Automating", "signup.finish", undefined]])
    expect(host.querySelector("video, [data-testid=\"signup-video\"]")).toBeNull()
  })

  test("welcome uses the first word of the name, and stands alone without one", () => {
    expect(welcome("Ada Park")).toBe("Welcome, Ada")
    expect(welcome("Prince")).toBe("Welcome, Prince")
    expect(welcome("   ")).toBe("Welcome")
    expect(welcome(undefined)).toBe("Welcome")
  })
})

for (const replacement of ["login", "provider"] as const) test(`pending editor DOM belongs to the account across ${replacement} replacement`, async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const identity = (login: string, provider: "github" | "local" = "github") => store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login, provider, admin: false, scopesPlain: null }).isPersisted.promise
  const host = document.createElement("div"), root = createRoot(host)
  document.body.append(host)
  const controller = { store, bootstrap: { host: "cloud" }, identityProvider: "github", repositoryApp: null, runCommand: () => true } as unknown as AppController
  const project = () => flushSync(() => root.render(<ControllerContext value={controller}><SignupCards /></ControllerContext>))
  const input = () => host.querySelector<HTMLInputElement>('[data-testid="signup-name"]')!
  try {
    await identity("old-owner", replacement === "provider" ? "local" : "github")
    project(); await new Promise(resolve => setTimeout(resolve, 20))
    const original = input()
    original.focus(); original.value = "PRIVATE-PENDING-NAME"; original.dispatchEvent(new Event("input", { bubbles: true }))
    await identity("old-owner", replacement === "provider" ? "local" : "github")
    project(); await new Promise(resolve => setTimeout(resolve, 20))
    expect(input()).toBe(original)
    expect(input().value).toBe("PRIVATE-PENDING-NAME")
    const nextLogin = replacement === "provider" ? "old-owner" : "new-owner"
    await identity(nextLogin)
    project(); await new Promise(resolve => setTimeout(resolve, 20))
    expect(input().value).toBe("")
    expect(input()).not.toBe(original)
    expect(host.querySelector<HTMLInputElement>('[data-testid="signup-account"]')?.value).toBe(nextLogin)
  } finally { flushSync(() => root.unmount()); host.remove(); await store.dispose?.() }
})
