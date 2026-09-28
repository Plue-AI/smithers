/**
 * The Worker's routes, kept apart from the WebAssembly import only workerd can
 * load, so a test drives them in Node with the Node QuickJS build.
 *
 * `/api/routes` reports what the router found, which is the cheapest way to
 * confirm a deploy is serving the app you think it is. `/api/turn` runs one
 * chat turn and streams it back as `TurnFrame` NDJSON, for a request carrying
 * `Authorization: Bearer <APP_API_TOKEN>`: every turn spends the seat's model
 * key. Everything else is served from the assets bucket.
 */
import { authorized } from "@smthrs/create-app/http"
import { type TurnHost, type TurnRoute, turnResponse } from "@smthrs/create-app/worker"
import type * as QuickJSSandbox from "@smthrs/harness/QuickJSSandbox"
import type * as Layer from "effect/Layer"
import { flows, paneNames } from "../routes.gen.ts"
import { turnSource, ui } from "../tools/ui.ts"

export interface Env {
  readonly ASSETS: { readonly fetch: (request: Request) => Promise<Response> }
  readonly APP_NAME: string
  /** Credential for an `anthropic:<model>` seat. */
  readonly ANTHROPIC_API_KEY?: string
  /** Credential for an `openai:<model>` seat. */
  readonly OPENAI_API_KEY?: string
  /** The bearer token `/api/turn` requires. Unset, every turn is refused. */
  readonly APP_API_TOKEN?: string | undefined
  /** `1` admits turns without a token when none is set. Local development only. */
  readonly APP_API_OPEN?: string | undefined
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

/** What a test replaces: the seat resolver or the judge. */
export type HostOverrides = Partial<Pick<TurnHost, "seats" | "evaluator">>

export const handle = async (
  request: Request,
  env: Env,
  sandboxVariant: Layer.Layer<QuickJSSandbox.Variant>,
  overrides: HostOverrides = {}
): Promise<Response> => {
  const url = new URL(request.url)

  if (url.pathname === "/api/routes") {
    return json({
      app: env.APP_NAME,
      panes: paneNames,
      flows: flows.map((flow) => ({ id: flow.id, file: flow.file }))
    })
  }

  if (url.pathname === "/api/turn") {
    return turnResponse(request, {
      flows: flows as unknown as ReadonlyArray<TurnRoute>,
      env: {
        ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
        OPENAI_API_KEY: env.OPENAI_API_KEY,
      },
      sandboxVariant,
      authorize: (request) => authorized(request, env.APP_API_TOKEN, env.APP_API_OPEN),
      // Each turn gets its own `ui` source, so the cards it paints stream back
      // on this response rather than into the test sink TOOLS.ts binds.
      tools: (route, cards) => ({
        ...route.tools,
        sources: route.tools.sources.map((source) => source === ui ? turnSource(cards, paneNames) : source)
      }),
      ...overrides
    })
  }

  return env.ASSETS.fetch(request)
}
