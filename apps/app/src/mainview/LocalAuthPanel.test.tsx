import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, expect, test } from "bun:test"
import { act } from "react"
import { flushSync } from "react-dom"
import { createRoot, type Root } from "react-dom/client"
import { LOCAL_AUTH_FAILURES, LocalAuthPanel } from "./LocalAuthPanel"
import type { LocalAuthController, LocalAuthSnapshot } from "./state/LocalAuth"

GlobalRegistrator.register()
const roots = new Set<Root>()

afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await GlobalRegistrator.unregister()
})

afterEach(() => {
  flushSync(() => {
    for (const root of roots) root.unmount()
  })
  roots.clear()
  document.body.textContent = ""
})

test("owner setup hands credentials off without retaining either secret", async () => {
  const submitted: Array<{ username: string; password: string; bootstrapToken?: string }> = []
  const snapshot: LocalAuthSnapshot = {
    open: true,
    pending: false,
    status: { enabled: true, initialized: false },
    error: null
  }
  const auth: LocalAuthController = {
    requiresBootstrapTokenInput: true,
    subscribe: () => () => {},
    snapshot: () => snapshot,
    open: () => {},
    close: () => {},
    submit: async (input) => { submitted.push(input) },
    dispose: () => {}
  }
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  roots.add(root)
  flushSync(() => root.render(<LocalAuthPanel auth={auth} />))

  const username = host.querySelector<HTMLInputElement>('input[name="username"]')!
  const password = host.querySelector<HTMLInputElement>('input[name="password"]')!
  const bootstrap = host.querySelector<HTMLInputElement>('input[name="bootstrapToken"]')!
  username.value = "owner"
  password.value = "strong password"
  bootstrap.value = "bootstrap secret"
  await act(async () => {
    host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
    await Promise.resolve()
  })

  expect(submitted).toEqual([{
    username: "owner",
    password: "strong password",
    bootstrapToken: "bootstrap secret"
  }])
  expect(password.value).toBe("")
  expect(bootstrap.value).toBe("")
})

test("native owner setup does not ask for the handed-off bootstrap token", () => {
  const snapshot: LocalAuthSnapshot = {
    open: true,
    pending: false,
    status: { enabled: true, initialized: false },
    error: null
  }
  const auth: LocalAuthController = {
    requiresBootstrapTokenInput: false,
    subscribe: () => () => {},
    snapshot: () => snapshot,
    open: () => {},
    close: () => {},
    submit: async () => {},
    dispose: () => {}
  }
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  roots.add(root)
  flushSync(() => root.render(<LocalAuthPanel auth={auth} />))
  expect(host.querySelector('input[name="bootstrapToken"]')).toBeNull()
})

test("Escape closes owner sign-in and restores the sign-in door", () => {
  let closed = 0
  const trigger = document.createElement("button")
  trigger.dataset.testid = "login-github"
  document.body.append(trigger)
  const snapshot: LocalAuthSnapshot = {
    open: true,
    pending: true,
    status: { enabled: true, initialized: true },
    error: null
  }
  const auth: LocalAuthController = {
    requiresBootstrapTokenInput: true,
    subscribe: () => () => {},
    snapshot: () => snapshot,
    open: () => {},
    close: () => { closed += 1 },
    submit: async () => {},
    dispose: () => {}
  }
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  roots.add(root)
  flushSync(() => root.render(<LocalAuthPanel auth={auth} />))

  host.querySelector('[role="dialog"]')!.dispatchEvent(new KeyboardEvent("keydown", {
    key: "Escape",
    bubbles: true,
    cancelable: true
  }))

  expect(closed).toBe(1)
  expect(document.activeElement).toBe(trigger)
})

test("sign-in traps Tab in both directions, including while all inputs are disabled", () => {
  for (const pending of [false, true]) {
    const snapshot: LocalAuthSnapshot = { open: true, pending, status: { enabled: true, initialized: true }, error: null }
    const auth: LocalAuthController = { requiresBootstrapTokenInput: false, subscribe: () => () => {}, snapshot: () => snapshot, open: () => {}, close: () => {}, submit: async () => {}, dispose: () => {} }
    const host = document.createElement("div"); document.body.append(host)
    const root = createRoot(host); roots.add(root)
    flushSync(() => root.render(<><button>Outside</button><LocalAuthPanel auth={auth} /></>))
    const dialog = host.querySelector<HTMLElement>('[role="dialog"]')!
    const controls = [...dialog.querySelectorAll<HTMLElement>("input:not(:disabled), button:not(:disabled)")]
    const first = controls[0] ?? dialog, last = controls.at(-1) ?? dialog
    for (const [from, to, shiftKey] of [[first, last, true], [last, first, false]] as const) {
      from.focus()
      const event = new KeyboardEvent("keydown", { key: "Tab", shiftKey, bubbles: true, cancelable: true })
      from.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(true)
      expect(document.activeElement).toBe(to)
    }
  }
})

const mountPanel = (snapshot: LocalAuthSnapshot, open: () => void = () => {}): HTMLElement => {
  const auth: LocalAuthController = { requiresBootstrapTokenInput: false, subscribe: () => () => {}, snapshot: () => snapshot, open, close: () => {}, submit: async () => {}, dispose: () => {} }
  const host = document.createElement("div"); document.body.append(host)
  const root = createRoot(host); roots.add(root)
  flushSync(() => root.render(<LocalAuthPanel auth={auth} />))
  return host
}
const noticeParts = (host: HTMLElement) => {
  const notice = host.querySelector<HTMLElement>('[data-testid="local-auth-failure"]')!
  return { notice, sentence: notice.querySelector(":scope > p")?.textContent ?? "", detail: notice.querySelector("details pre")?.textContent }
}

test("a status read that fails says sign-in is unreachable, keeps the message in Details, and Retry reads again", () => {
  let opened = 0
  const raw = "ApplicationClientError: transport: Failed to fetch http://127.0.0.1:4920/api/local-auth/status"
  const host = mountPanel({ open: true, pending: false, status: null, error: raw }, () => { opened += 1 })
  const { notice, sentence, detail } = noticeParts(host)
  expect(notice.dataset.failure).toBe("LocalAuth.status")
  expect(notice.dataset.fault).toBe("infra")
  expect(sentence).toBe(LOCAL_AUTH_FAILURES.status.sentence)
  expect(sentence).not.toContain("Failed to fetch")
  expect(detail).toBe(raw)
  expect(host.textContent).not.toContain("Loading…")
  const retry = notice.querySelector<HTMLButtonElement>("button")!
  expect(retry.textContent).toBe("Retry")
  retry.click()
  expect(opened).toBe(1)
})

test("a refused sign-in asks the person to check what they entered and never shows the server's words outside Details", () => {
  const raw = "401 invalid_credentials: bcrypt mismatch for owner"
  const host = mountPanel({ open: true, pending: false, status: { enabled: true, initialized: true }, error: raw })
  const { notice, sentence, detail } = noticeParts(host)
  expect(notice.dataset.failure).toBe("LocalAuth.submit")
  expect(notice.dataset.fault).toBe("user")
  expect(sentence).toBe(LOCAL_AUTH_FAILURES.submit.sentence)
  expect(sentence).not.toContain("Not your fault")
  expect(sentence).not.toContain("401")
  expect(detail).toBe(raw)
  // The Details disclosure joins the dialog's Tab cycle.
  expect([...host.querySelectorAll('[role="dialog"] summary')].length).toBe(1)
})

test("sign-in turned off on the host is its own sentence, not a sign-in mistake", () => {
  const host = mountPanel({ open: true, pending: false, status: { enabled: false, initialized: false }, error: "Local sign-in is unavailable." })
  const { notice, sentence } = noticeParts(host)
  expect(notice.dataset.failure).toBe("LocalAuth.unavailable")
  expect(sentence).toBe(LOCAL_AUTH_FAILURES.unavailable.sentence)
  expect(sentence).not.toBe(LOCAL_AUTH_FAILURES.submit.sentence)
})

test("while the status loads with no error there is no failure notice", () => {
  const host = mountPanel({ open: true, pending: true, status: null, error: null })
  expect(host.querySelector('[data-testid="local-auth-failure"]')).toBeNull()
  expect(host.textContent).toContain("Loading…")
})
