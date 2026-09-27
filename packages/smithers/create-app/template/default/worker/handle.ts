/**
 * The Worker's routes, kept apart from the WebAssembly import only workerd can
 * load, so a test drives them in Node with the Node QuickJS build.
 *
 * `/api/routes` reports what the router found, which is the cheapest way to
 * confirm a deploy is serving the app you think it is. `/api/turn` runs one
 * chat turn and streams it back as `TurnFrame` NDJSON. Everything else is
 * served from the assets bucket.
 */
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
  /** The Vercel AI Gateway key the completion judge runs on. */
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
