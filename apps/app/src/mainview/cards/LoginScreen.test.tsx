import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import { LoginScreen } from "./LoginScreen"

GlobalRegistrator.register()
afterAll(async () => {
  for (let tick = 0; tick < 3; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0))
  await GlobalRegistrator.unregister()
})

const mounted: Array<() => void> = []
afterEach(() => { for (const unmount of mounted.splice(0)) unmount() })

const render = () => {
  const calls: Array<[string, string | undefined]> = []
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  flushSync(() => { root.render(<LoginScreen onRunCommand={(name, args) => { calls.push([name, args]) }} />) })
  mounted.push(() => { flushSync(() => root.unmount()); host.remove() })
  const flows = () => [...host.querySelectorAll<HTMLElement>("[data-flow]")].map(el => [el.tagName.toLowerCase(), el.dataset.flow, el.dataset.flowArgs])
  return { host, calls, flows }
}

/* The login screen (Will, 2026-10-03): the mark and the welcome over two doors, GitHub and an email address. */
describe("the login screen", () => {
  test("the welcome over the GitHub door and the email door, and nothing else", () => {
    const { host, flows } = render()
    expect(host.querySelector("h1")?.textContent).toBe("Welcome to Smithers")
    expect(host.querySelector(".login-logo pre")?.textContent?.split("\n")).toHaveLength(6)
    expect(flows()).toEqual([["button", "sign-in", undefined], ["form", "auth.email", undefined]])
    expect([...host.querySelectorAll("button")].map(button => button.textContent)).toEqual(["Continue with GitHub", "Continue"])
    const email = host.querySelector<HTMLInputElement>('[data-testid="login-email"]')!
    expect([email.type, email.required, email.getAttribute("aria-label"), email.placeholder]).toEqual(["email", true, "Email address", "Email address"])
    expect(host.querySelector('[role="separator"]')?.textContent).toBe("or")
    // No sentence beside a button, no second account door, no links (MINIMAL TEXT; the legal links left with #3435).
    expect(host.querySelectorAll("a, p")).toHaveLength(0)
    for (const absent of ["Sign up", "Google", "Log in", "account"]) expect(host.textContent).not.toContain(absent)
  })

  test("the GitHub door runs sign-in; the email form runs auth.email with the trimmed address, and a blank address runs nothing", () => {
    const { host, calls } = render()
    host.querySelector<HTMLButtonElement>('[data-testid="login-github"]')!.click()
    expect(calls).toEqual([["sign-in", undefined]])
    const form = host.querySelector<HTMLFormElement>("form")!
    const email = host.querySelector<HTMLInputElement>('[data-testid="login-email"]')!
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
    expect(calls).toEqual([["sign-in", undefined]])
    email.value = " ada@example.com "
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
    expect(calls).toEqual([["sign-in", undefined], ["auth.email", "ada@example.com"]])
  })

  test("every door is a keyboard path, in reading order: GitHub, the address, Continue", () => {
    const { host } = render()
    const controls = [...host.querySelectorAll<HTMLElement>("button, input")]
    expect(controls.map(control => control.dataset.testid)).toEqual(["login-github", "login-email", "login-email-continue"])
    for (const control of controls) {
      expect(control.tabIndex).toBe(0)
      control.focus()
      expect(document.activeElement).toBe(control)
    }
    expect(host.querySelector('[data-testid="login-email-continue"]')?.getAttribute("type")).toBe("submit")
  })
})
