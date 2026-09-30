/**
 * `smthrs token mint`: a scoped, expiring gateway token signed under
 * `SMITHERS_TOKEN`.
 *
 * The gateway verifies the token with the same credential it serves under
 * (`@smthrs/control` `ScopedToken`), so minting needs no running gateway and
 * stores nothing. The verb runs on the host that holds the credential; it is
 * never offered over MCP, where a connected client could otherwise turn the
 * host's credential into tokens of its own.
 *
 * @since 1.0.0
 */

import * as ScopedToken from "@smthrs/control/ScopedToken"
import { Effect } from "effect"
import { Cli, z } from "incur"
import type * as Bridge from "../cli/ControlBridge.ts"
import * as CliError from "../CliError.ts"
import { duration } from "../Gc.ts"
import * as Presentation from "./Presentation.ts"

/**
 * What `token mint` reports: the token, when it stops working, and the exact
 * grant it carries.
 *
 * @category models
 * @since 1.0.0
 */
export interface MintedToken {
  readonly token: string
  readonly expiresAt: string
  readonly scopes: ReadonlyArray<ScopedToken.Scope>
  readonly procedures: ReadonlyArray<string>
  readonly runId?: string | undefined
  readonly flowId?: string | undefined
}

/**
 * Mints one token from the environment's `SMITHERS_TOKEN`.
 *
 * @category constructors
 * @since 1.0.0
 */
export const mint = (
  options: {
    readonly scope: ReadonlyArray<ScopedToken.Scope>
    readonly ttl: string
    readonly run?: string | undefined
    readonly flow?: string | undefined
  },
  environment: Record<string, string | undefined>
): Effect.Effect<MintedToken, CliError.UsageError> =>
  Effect.gen(function*() {
    const key = environment["SMITHERS_TOKEN"]?.trim()
    if (key === undefined || key.length === 0) {
      return yield* new CliError.UsageError({ message: "Set SMITHERS_TOKEN to the gateway credential to mint from" })
    }
    const ttlMillis = duration(options.ttl)
    if (ttlMillis === undefined) {
      return yield* new CliError.UsageError({
        message: `--ttl must be a positive duration such as 30s, 15m, 1h, or 2d, not ${options.ttl}`
      })
    }
    const minted = yield* ScopedToken.mint({
      key,
      scopes: options.scope,
      ttlMillis,
      runId: options.run,
      flowId: options.flow
    })
    return {
      token: minted.token,
      expiresAt: new Date(minted.claims.exp).toISOString(),
      scopes: [...new Set(options.scope)],
      procedures: minted.claims.procedures,
      ...(minted.claims.runId === undefined ? {} : { runId: minted.claims.runId }),
      ...(minted.claims.flowId === undefined ? {} : { flowId: minted.claims.flowId })
    }
  })

/**
 * Builds the `token` command group.
 *
 * @category constructors
 * @since 1.0.0
 */
export const createTokenCli = (config: Bridge.Runtime = {}) =>
  Cli.create("token", { description: "Mint scoped, expiring gateway tokens from SMITHERS_TOKEN" })
    .command("mint", {
      description: "Mint a token limited to the named scopes, an optional run or flow, and a lifetime",
      mcp: false,
      options: z.object({
        scope: z.array(z.enum(ScopedToken.scopeNames as [ScopedToken.Scope, ...Array<ScopedToken.Scope>])).min(1)
          .describe("Repeatable: read:runs, write:runs, or approve:runs"),
        ttl: z.string().default("1h").describe("Lifetime such as 30s, 15m, 1h, or 2d"),
        run: z.string().optional().describe("Confine every call to this run id"),
        flow: z.string().optional().describe("Confine every call to this flow id")
      }),
      run: (context) =>
        Presentation.guard(
          context,
          () => Effect.runPromise(mint(context.options, config.environment ?? process.env)),
          { render: (minted) => ({ human: minted.token }) }
        )
    })
