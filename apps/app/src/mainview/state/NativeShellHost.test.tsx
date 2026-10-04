import { GlobalRegistrator } from "@happy-dom/global-registrator"
import type { AppBootstrap } from "@smthrs/rpc/AppBootstrap"
import { nativeShell } from "@smthrs/rpc/AppBootstrap"
import { resolveApplicationTarget } from "@smthrs/rpc/ApplicationTarget"
import { cloudCapabilities } from "@smthrs/rpc/HostCapabilities"
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import App from "../App"
import { ControllerTestProvider } from "../ControllerContext"
import type { AppController as AppControllerType, AppServices } from "./AppController"
import { createAppStore } from "./AppStore"
import { scopedControllers } from "./ControllerTestScope"
import { identityProviderFor } from "./IdentityProvider"
import { memoryStorage, settled, silentAgent } from "./TestFixtures"

/*
 * Self-host is the same web app as Cloud (#2228). The self-hosted backend's
 * bootstrap is a web host with owner credentials, and nothing in the app reads
 * `host` to decide whether it is inside the desktop shell: the shell reports
 * `native.shell` on its own relay, and only that row opens native-shell UI —
 * the ungated opening, the "native Smithers app" identity, the shell's mode.
 */

const createAppController = scopedControllers()

GlobalRegistrator.register({ url: "https://smithers.example/" })
afterAll(async () => {
  for (let tick = 0; tick < 3; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0))
  await GlobalRegistrator.unregister()
})

const mounted: Array<() => void> = []
afterEach(() => { while (mounted.length > 0) mounted.pop()?.() })

const mount = (controller: AppControllerType): { readonly host: HTMLElement; readonly markup: () => string } => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  flushSync(() => root.render(<ControllerTestProvider controller={controller}><App /></ControllerTestProvider>))
  mounted.push(() => { flushSync(() => root.unmount()); host.remove() })
  return { host, markup: () => host.innerHTML }
}

/** What `packages/backend/internal/compose/bootstrap.go` answers for the single-owner topology. */
const SELF_HOST: AppBootstrap = {
  apiVersion: 1,
  host: "cloud",
  version: "dev",
  buildSha: "abcdef0",
  capabilities: ["identity", "cloud", "cloud.terminal"],
  authFlow: "credentials",
  sandbox: { platform: "darwin", mode: "trusted-only" }
}

/** GitHub redirect bootstrap; the hosted Worker's handoff variants are covered below too. */
const WORKER: AppBootstrap = {
  apiVersion: 1, host: "cloud", version: "test", buildSha: "cloud",
  capabilities: cloudCapabilities({ identity: true, cloud: true, agent: true, checkout: false, terminal: false }),
  authFlow: "redirect", sandbox: null
}

/** The page's target on a self-hosted origin: the Go webapp handler's `web-selfhost` meta, also the default a bare page resolves. */
const webSelfhost = resolveApplicationTarget({ apiVersion: 1, mode: "web-selfhost", apiOrigin: "", auth: { kind: "session" }, cors: "same-origin", developerExternal: false }, "https://smithers.example")

/** The owner-backend seams a browser holds (runtime/ApplicationClient.ts), signed out. */
const ownerSeams = (bootstrap: AppBootstrap): AppServices => ({
  bootstrap,
  applicationTarget: webSelfhost,
  applicationIdentity: { current: async () => null },
  cloudSocketUrl: () => undefined,
  cloudLspSocketUrl: () => undefined
})

const openSignedOut = async (bootstrap: AppBootstrap) => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = createAppController(store, silentAgent, ownerSeams(bootstrap))
  await controller.loadSession()
  await settled()
  return controller
}

describe("a self-host bootstrap never enables native-shell UI", () => {
  test("the sign-in door is the owner's credentials on every web origin that has them, and GitHub only behind the redirect", () => {
    expect(nativeShell(SELF_HOST)).toBe(false)
    expect(identityProviderFor(ownerSeams(SELF_HOST))).toBe("github")
    // The Worker's page resolves the same default owner target; its redirect is what makes it the hosted GitHub session.
    expect(identityProviderFor({ ...ownerSeams(WORKER),})).toBe("github")
    expect(identityProviderFor(ownerSeams(WORKER))).toBe("github")
  })

  test("signed out, GitHub is the one sign-in door", async () => {
    const controller = await openSignedOut(SELF_HOST)
    expect(controller.identityProvider).toBe("github")
    const { host, markup } = mount(controller)
    const door = host.querySelector<HTMLElement>('[data-flow="sign-in"]')
    expect(door?.textContent).toBe("Sign in with GitHub")
    expect(door?.dataset.flow).toBe("sign-in")
    expect(markup()).toContain("Sign in with GitHub")
    expect(host.querySelector('[data-testid="signup"]')).toBeNull()
  })
})

for (const authFlow of ["redirect", "native-handoff", "both"] as const) test(`the GitHub ${authFlow} cookie session reads the selected backend identity without opening retired signup`, async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  let identityReads = 0
  const requests: string[] = []
  const controller = createAppController(store, silentAgent, {
    ...ownerSeams({ ...WORKER, authFlow }),
    applicationIdentity: { current: async () => {
      identityReads++
      return { username: "github-owner", displayName: "Grace Owner", admin: false, scopes: null }
    } },
    fetchImpl: async (url) => { requests.push(String(url)); return new Response("{}", { status: 404 }) }
  })
  await controller.loadSession()
  await settled()
  expect(identityReads).toBeGreaterThan(0)
  expect(requests.some(url => url.includes("/api/user"))).toBe(true)
  expect(requests.some(url => url.includes("/api/auth/session"))).toBe(false)
  expect(controller.identityProvider).toBe("github")
  expect(store.collections.identitySessions.get("identity")).toMatchObject({ state: "signed-in", login: "github-owner", provider: "github" })
  const { host } = mount(controller)
  expect(host.querySelector('[data-testid="signup"]')).toBeNull()
  expect(store.session().signup).toBeUndefined()
})
