/** Real product HTTP/PG consumer driven only by TestAdminGrantAppHTTPPostgres. */
import type { FetchLike } from "@smthrs/rpc/NativeAgent"
import assert from "node:assert/strict"
import { createAppStore } from "../src/mainview/state/AppStore"
import { createAuthBillingController } from "../src/mainview/state/controller/auth-billing"
import type { SelectedBackendIdentity } from "../src/mainview/state/controller/auth-billing"
import { createControllerContext } from "../src/mainview/state/controller/context"
import { createFailureController } from "../src/mainview/state/controller/failures"
import { memoryStorage, silentAgent, waitFor } from "../src/mainview/state/TestFixtures"

const origin = process.env.SMITHERS_ADMIN_GRANT_TEST_ORIGIN
const token = process.env.SMITHERS_ADMIN_GRANT_TEST_TOKEN
assert.ok(origin && token, "Must be run by the real PostgreSQL/HTTP fixture")
const storage = memoryStorage()
const fetchWithAuth: FetchLike = (input, init) =>
  fetch(input, {
    ...init,
    headers: { ...Object.fromEntries(new Headers(init?.headers)), authorization: `Bearer ${token}` }
  })
const selected: SelectedBackendIdentity = {
  signInPath: "/sign-in",
  current: async () => {
    const response = await fetchWithAuth(`${origin}/api/user`)
    assert.equal(response.status, 200)
    const profile = await response.json() as { username: string; is_admin: boolean }
    assert.equal(profile.is_admin, true)
    return { username: profile.username, admin: profile.is_admin, scopes: null }
  }
}
const page = new AbortController()
const first = await createAppStore({ kind: "localStorage", storage })
const firstCtx = createControllerContext(first, silentAgent, {
  baseUrl: origin,
  toastDebounceMs: 0,
  fetchImpl: (input, init) =>
    fetchWithAuth(input, { ...init, signal: AbortSignal.any([page.signal, ...(init?.signal ? [init.signal] : [])]) })
})
firstCtx.withToast = createFailureController(firstCtx).withToast
const before = createAuthBillingController(firstCtx, first.nextOrdinal, selected)
await before.loadSession()
before.adminGrant(25, "app-grant-recipient")
const card = [...first.collections.cards.values()].find((card) => card.kind === "grant-confirm")
assert.ok(card)
assert.equal(await before.adminGrantConfirm(card.id), undefined)
await waitFor(() =>
  [...first.collections.toasts.values()].some((toast) => toast.key === "admin.grant" && toast.status === "running")
)
assert.equal(first.collections.cards.get(card.id)?.status, "active")
const pending = await (await fetch(`${origin}/__grant_state`)).json() as { posted: number; grants: number }
assert.deepEqual(pending, { posted: 1, grants: 0 }, "Approval acknowledged while the real write is held")
await first.dispatch({ type: "composer.changed", actor: "user", draft: "Still chatting" }).isPersisted.promise
assert.equal(first.session().draft, "Still chatting")
// Release the database write but retain its HTTP response, then model page reload.
await fetch(`${origin}/__grant_release`, { method: "POST" })
await firstCtx.dispose()
page.abort()
await first.dispose?.()
const reopened = await createAppStore({ kind: "localStorage", storage })
assert.equal(reopened.collections.cards.get(card.id)?.status, "active")
const afterCtx = createControllerContext(reopened, silentAgent, {
  baseUrl: origin,
  toastDebounceMs: 0,
  fetchImpl: fetchWithAuth
})
afterCtx.withToast = createFailureController(afterCtx).withToast
const after = createAuthBillingController(afterCtx, reopened.nextOrdinal, selected)
await after.loadSession()
await waitFor(() => reopened.collections.cards.get(card.id)?.status === "acted")
const granted = reopened.collections.cards.get(card.id)
assert.equal(granted?.kind, "grant-confirm")
if (granted?.kind !== "grant-confirm") throw Error("Grant card was lost")
assert.equal(granted.payload.phase, "granted")
assert.match(granted.payload.grantId ?? "", /^credit-grant:[1-9][0-9]*$/)
assert.equal(await after.adminGrantConfirm(card.id), "That grant was already posted.")
await afterCtx.dispose()
await reopened.dispose?.()
process.stdout.write(
  JSON.stringify({
    acknowledgedBeforeHTTP: true,
    chatUsable: true,
    reloadRecovered: true,
    operationKey: card.id,
    grantId: granted.payload.grantId
  }) + "\n"
)
