/**
 * The Worker's bindings, as `wrangler.jsonc` declares them.
 *
 * Every value the Worker reads from the platform is named here. Nothing else
 * in `worker/` touches `globalThis` for configuration, so a missing binding is
 * a type error at the call site rather than an `undefined` at request time.
 */
import type { AppSession } from "./AppSession.ts"

export interface Env {
  /** The built SPA in `dist/client`. Serves every path the API does not claim. */
  readonly ASSETS: Fetcher
  /** One Durable Object per chat session: messages, cards, saved flows. */
  readonly SESSIONS: DurableObjectNamespace<AppSession>
  /**
   * Provider credentials for the agent seat. A seat resolves against the
   * binding for the provider it names (`seatsFromEnv` in
   * `@smthrs/create-app/worker`), so a deployment only sets the one its
   * AGENT.ts seats use. `wrangler secret put`.
   */
  readonly ANTHROPIC_API_KEY?: string
  readonly OPENAI_API_KEY?: string
  /** The Vercel AI Gateway key the completion judge runs on. Every turn needs it. */
  /** Upstream JSON-RPC the Tevm fork reads state from. A turn is refused without it. */
  readonly TEVM_FORK_RPC_URL?: string
  /**
   * The shared credential every `/api/*` route but `GET /api/health` requires.
   *
   * Missing or empty refuses requests unless APP_API_OPEN=1. Set the secret
   * before deploy with `wrangler secret put APP_API_TOKEN`. See `guard.ts`.
   */
  readonly APP_API_TOKEN?: string
  /** Local-only opt-in to requests without a token. Never configure on deploy. */
  readonly APP_API_OPEN?: string
  /** The app name from `PACKAGE.ts`, echoed by `GET /api/health`. */
  readonly APP_NAME: string
}
