import { machineReadableRefusal } from "@smthrs/rpc/UpstreamProse"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import { ServerConfig } from "./Config"
import { fetchCloudToken } from "./cloudToken"
import { readRefusalDetail } from "./Http"
import type { Transport } from "./Http"

/*
 * Who pays for one model call. Owner ruling 2026-09-23: no BYOK; Smithers
 * picks the model, runs it on a platform key, and charges the account's
 * credit balance. A signed-in caller's call therefore goes through Smithers
 * Cloud's metered model proxy (`POST /api/model/{provider}/{path}`) with the
 * account's own Cloud token: Plue reserves credit, forwards with its platform
 * key, reads usage and debits, and refuses a spent balance with 402
 * `out_of_credit`. A signed-out visitor's call keeps the deployment key.
 *
 * The payer is ambient (a Reference defaulting to the visitor) so the two
 * model clients (`jevEvaluate`, `cerebrasChat`) read it and every route that
 * knows the session provides it once.
 */

export interface ModelPayerShape {
  /** The validated login whose credit pays, or undefined for a visitor on the deployment key. */
  readonly login: string | undefined
}

export const ModelPayer = Context.Reference<ModelPayerShape>("smithers-server/ModelPayer", {
  defaultValue: () => ({ login: undefined })
})

/** Run `work` with `login`'s credit paying for every model call inside it. */
export const paidBy = (login: string | undefined) =>
<A, E, R>(work: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> => Effect.provideService(work, ModelPayer, { login })

/** The provider origins the proxy fronts, by the segment Plue names them with. */
const PROVIDER_ORIGINS = {
  cerebras: "https://api.cerebras.ai",
  vercel: "https://ai-gateway.vercel.sh"
} as const

export type ModelRoute =
  | { readonly ok: true; readonly url: string; readonly authorization: string; readonly metered: boolean }
  | { readonly ok: false; readonly message: string }

/**
 * Where one call to `platformUrl` goes and with which bearer. A visitor gets
 * the platform URL and the deployment key; a login gets the proxy URL and its
 * Cloud token. A URL under no proxied origin is refused rather than sent with
 * a key it was not pinned to.
 */
export const modelRoute = (
  platformUrl: string,
  platformKey: Redacted.Redacted<string> | undefined
): Effect.Effect<ModelRoute, never, Transport | ServerConfig> =>
  Effect.gen(function*() {
    const payer = yield* ModelPayer
    const provider = (Object.keys(PROVIDER_ORIGINS) as Array<keyof typeof PROVIDER_ORIGINS>)
      .find((name) => platformUrl.startsWith(`${PROVIDER_ORIGINS[name]}/`))
    if (provider === undefined) return { ok: false, message: "The model address has no metered route." } as const
    if (payer.login === undefined) {
      if (platformKey === undefined) return { ok: false, message: "The deployment's model key is unset." } as const
      return { ok: true, url: platformUrl, authorization: `Bearer ${Redacted.value(platformKey)}`, metered: false } as const
    }
    const token = yield* fetchCloudToken(payer.login)
    if (token.status !== "ok") return { ok: false, message: token.detail } as const
    const config = yield* ServerConfig
    const path = platformUrl.slice(PROVIDER_ORIGINS[provider].length)
    return {
      ok: true,
      url: `${config.cloudApiBaseUrl.replace(/\/+$/, "")}/api/model/${provider}${path}`,
      authorization: `Bearer ${token.token}`,
      metered: true
    } as const
  })

/** Plue's refusal code for a spent model credit. */
export const OUT_OF_CREDIT = "out_of_credit"

/**
 * Whether a refused metered response is Plue's out-of-credit verdict. Reads
 * (and so consumes) the body; the code comes off the wire, never the prose.
 */
export const isOutOfCredit = (response: Response): Effect.Effect<boolean> =>
  Effect.map(readRefusalDetail(response), (body) => machineReadableRefusal(body).code === OUT_OF_CREDIT)
