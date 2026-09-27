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
import { SignupCardBody, SignupCards } from "./SignupCards"

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
        { stage: "account", field: "name", testId: "signup-name", value: "Ada Park " },
        { stage: "account", field: "account", testId: "signup-account", value: "ada park " },
        { stage: "poll", field: "more", testId: "signup-more", value: "ship it " }
      ] as const
      for (const { stage, field, testId, value } of cases) {
        controller.signupChange({ stage, ...(stage === "poll" ? { question: 6 } : {}) })
        project()
        const input = host.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-testid="${testId}"]`)!
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
    expect(host.querySelector("h1")?.textContent?.replace(/\s+/g, " ").trim()).toBe("Automate your codebase today")
    expect(flows()).toEqual([["Continue with GitHub", "auth.sign-in", undefined]])
    expect(host.querySelectorAll("input, form")).toHaveLength(0)
    host.querySelector<HTMLButtonElement>('[data-testid="signup-github"]')!.click()
    expect(calls).toEqual([["auth.sign-in", undefined]])
  })

  test("before identity answers, a first visit paints the title alone: no door, no receipt", () => {
    const { host, flows } = render(initialSignup(), [], false)
    expect(host.querySelector("h1")?.textContent?.replace(/\s+/g, " ").trim()).toBe("Automate your codebase today")
    expect(flows()).toEqual([])
    expect(host.querySelector("form")).toBeNull()
  })

  test("the account step prefills the GitHub login under smithers.sh/ and submits through signup.account", () => {
    const { host, calls } = render({ ...initialSignup(), stage: "account", door: "github", account: "adapark", draft: { account: "adapark", name: "Ada Park" } })
    expect(host.querySelector<HTMLInputElement>('[data-testid="signup-account"]')?.value).toBe("adapark")
    expect(host.querySelector(".signup-prefix")?.textContent).toBe("smithers.sh/")
    expect(host.querySelector(".signup-url")?.getAttribute("data-valid")).toBe("true")
    expect([...host.querySelectorAll(".signup-receipt")].map(r => r.textContent)).toEqual(["Signed in with GitHub"])
    host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
    expect(calls).toEqual([["signup.account", undefined]])
  })

  test("a poll question renders its lettered choices as signup.answer buttons, a letter key answers, and every question offers Skip", () => {
    const { host, flows, calls } = render({ ...initialSignup(), stage: "poll", question: 1 })
    expect(host.querySelector("h2")?.textContent).toBe("What best describes your role?")
    expect(flows().filter(row => row[1] === "signup.answer").map(row => row[2])).toEqual(["Executive/Owner", "Engineering", "Support", "Marketing", "Product & Design", "Sales", "IT", "Other"])
    expect(host.querySelector('[data-testid="signup-skip"]')).not.toBeNull()
    expect(flows().some(row => row[1] === "signup.back")).toBe(true)
    host.querySelector<HTMLElement>(".signup-choice")!.dispatchEvent(new KeyboardEvent("keydown", { key: "b", bubbles: true }))
    expect(calls).toEqual([["signup.answer", "Engineering"]])
  })

  test("the repo question lists the GitHub repositories beside a new repo", () => {
    const { flows } = render({ ...initialSignup(), stage: "poll", question: 5, door: "github" }, [{ id: "adapark/hello-server" }])
    expect(flows().filter(row => row[1] === "signup.repo").map(row => row[2])).toEqual(["adapark/hello-server", "new"])
  })

  test("ready shows the account URL, the giant Start Automating door, and the tutorial slot", () => {
    const { host, flows } = render({ ...initialSignup(), stage: "ready", account: "adapark" })
    expect(host.querySelector(".signup-url-line")?.textContent).toBe("smithers.sh/adapark")
    expect(flows()).toEqual([["Start Automating", "signup.finish", undefined]])
    expect(host.querySelector('[data-testid="signup-video"]')).not.toBeNull()
  })
})

for (const replacement of ["login", "provider"] as const) test(`pending editor DOM belongs to the account across ${replacement} replacement`, async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const identity = (login: string, provider: "github" | "local" = "github") => store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login, provider, allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
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
