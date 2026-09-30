import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { resolveApplicationTarget } from "@smthrs/rpc/ApplicationTarget"
import { cloudCapabilities } from "@smthrs/rpc/HostCapabilities"
import { createAppStore } from "../state/AppStore"
import { scopedControllers } from "../state/ControllerTestScope"
import { memoryStorage, unavailableAgent } from "../state/TestFixtures"
import { AccountCardBody } from "./AccountCard"

GlobalRegistrator.register()
afterAll(async () => { await GlobalRegistrator.unregister() })
const createController = scopedControllers()

for (const provider of ["local", "github"] as const) {
  test(`${provider} selected account reports only its provider and survives reload`, async () => {
    const storage = memoryStorage()
    const store = await createAppStore({ kind: "localStorage", storage })
    const paths: string[] = []
    const controller = createController(store, unavailableAgent, {
      ...(provider === "local" ? {
        applicationTarget: resolveApplicationTarget({ apiVersion: 1, mode: "web-selfhost", apiOrigin: "", auth: { kind: "session" }, cors: "same-origin", developerExternal: false }, "https://owner.test"),
        localIdentity: {
          status: async () => ({ enabled: true, initialized: true }),
          login: async ({ username }: { username: string }) => ({ user: { id: 1, username } }),
          bootstrap: async ({ username }: { username: string }) => ({ user: { id: 1, username } })
        }
      } : { bootstrap: { apiVersion: 1, host: "cloud", version: "test", buildSha: "test", capabilities: cloudCapabilities({ identity: true, cloud: true, agent: true, checkout: true, terminal: false }), authFlow: "redirect", sandbox: null } }),
      fetchImpl: async input => {
        const path = new URL(String(input), "https://owner.test").pathname
        paths.push(path)
        return path === "/api/auth/scopes"
          ? Response.json({ scopes: [{ scope: "contents:read", plain: "Read repository files" }] })
          : new Response(null, { status: 404 })
      }
    })
    await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "owner", allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
    const result = await controller.showAccount()
    await store.settled?.()
    expect(paths).toEqual([])
    expect(result).toEqual({ value: "account: @owner; access allowed; 0 box(es) listed" })
    const restored = await createAppStore({ kind: "localStorage", storage })
    try {
      const card = restored.collections.cards.get("account")!
      if (card.kind !== "account") throw new Error("Missing account card")
      expect(card.payload).toMatchObject({ provider, login: "owner" })
      expect(card.payload.refresh).toBeUndefined()
      const html = renderToStaticMarkup(<AccountCardBody card={card} onRunCommand={() => {}} />)
      expect(html.includes("GitHub")).toBe(provider === "github")
      expect(html.includes("read:user")).toBe(provider === "github")
      expect(html).toContain('data-flow="auth.sign-out"')
    } finally { await restored.dispose?.() }
  })
}

test("legacy account cards without provider evidence do not claim GitHub authorization", () => {
  const html = renderToStaticMarkup(<AccountCardBody card={{ id: "account", kind: "account", title: "Account", status: "active", createdAt: 1, ordinal: 1,
    payload: { login: "owner", allowlisted: true, accessRequested: false, scopes: [], boxes: [] } }} onRunCommand={() => {}} />)
  expect(html).not.toContain("GitHub")
  expect(html).not.toContain("read:user")
  expect(html).toContain("owner")
})

test("failed permissions keep a keyboard Retry door on the Account card", () => {
  const html = renderToStaticMarkup(<AccountCardBody card={{ id: "account", kind: "account", title: "Account", status: "error", createdAt: 1, ordinal: 1,
    payload: { login: "owner", provider: "github", allowlisted: true, accessRequested: false, scopes: [], boxes: [],
      refresh: { id: "read", state: "failed", error: "Permissions could not be loaded (HTTP 500)." } } }} onRunCommand={() => {}} />)
  expect(html).toMatch(/role="alert"[^>]*data-fault="infra"[^>]*data-failure="AccountPermissionsFailed"/)
  expect(html).toContain("<p>Smithers could not load your permissions. Not your fault.</p>")
  expect(html).toContain('<details><summary>Details</summary><pre tabindex="0" role="region" aria-label="Failure details">Permissions could not be loaded (HTTP 500).</pre></details>')
  expect(html.slice(0, html.indexOf("<details>"))).not.toContain("HTTP 500")
  expect(html).toMatch(/<button[^>]*data-flow="account.show"[^>]*>Retry<\/button>/)
})
