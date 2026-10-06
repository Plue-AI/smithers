import * as Effect from "effect/Effect"
import { runRequest } from "./Boundary"
import { handleDocsRedirect } from "./docsRedirect"
import type { DocsRedirectEnv } from "./docsRedirect"
import { TransportLive } from "./Http"

// The smithers-docs-redirect entry (wrangler.docs-redirect.jsonc). workerd
// rejects a main module whose named exports are not handlers, so the logic
// and its constants live in src/docsRedirect.ts and this file exports only the handler.
export default {
  fetch: (request: Request, env: DocsRedirectEnv): Promise<Response> =>
    runRequest(handleDocsRedirect(request, env).pipe(Effect.provide(TransportLive)), request.signal)
}
