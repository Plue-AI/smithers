/*
 * Test fixture: send a Worker request as one signed-in login. Every
 * model-spending route fails closed on a deployment without an identity seam
 * (requireTurnSession), so a test of what happens after the gate runs through
 * this session. The identity answer wraps whatever fetch the test installed
 * for the length of the call: the test's own upstream mock still receives
 * every other subrequest and never sees the validate. Nothing in the Worker
 * imports this.
 */

const SIGNED_IN_IDENTITY_URL = "https://identity.signed-in.test"
const SIGNED_IN_LOGIN = "signed-in"
const SIGNED_IN_COOKIE = "smithers_session=signed-in"

type WorkerFetch<Env, Ctx> = (request: Request, env: Env, ctx?: Ctx) => Promise<Response>

/** The env with the signed-in identity seam configured. */
const signedInEnv = <Env extends object>(env: Env): Env & { readonly IDENTITY_UPSTREAM_URL: string } => ({
  ...env,
  IDENTITY_UPSTREAM_URL: SIGNED_IN_IDENTITY_URL
})

/** The request with the signed-in session cookie. */
const signedInRequest = (request: Request): Request => {
  const headers = new Headers(request.headers)
  headers.set("cookie", SIGNED_IN_COOKIE)
  // Hand the body stream over unread: a test of the body cap watches it.
  return new Request(request.url, { method: request.method, headers, body: request.body, duplex: "half" } as RequestInit)
}

const requestUrl = (input: RequestInfo | URL): string =>
  typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url

/** Run `fetchWorker` on the request as the signed-in login under the signed-in identity seam. */
export const asSignedIn = <Env extends object, Ctx>(fetchWorker: WorkerFetch<Env, Ctx>) =>
  (request: Request, env: Env, ctx?: Ctx): Promise<Response> => {
    const sent = signedInRequest(request)
    const configured = signedInEnv(env)
    const inner = globalThis.fetch
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
      requestUrl(input) === `${SIGNED_IN_IDENTITY_URL}/api/identity/validate`
        ? Promise.resolve(Response.json({ login: SIGNED_IN_LOGIN, admin: false, scopes: [] }))
        : inner(input, init)) as typeof fetch
    return fetchWorker(sent, configured, ctx).finally(() => {
      globalThis.fetch = inner
    })
  }
