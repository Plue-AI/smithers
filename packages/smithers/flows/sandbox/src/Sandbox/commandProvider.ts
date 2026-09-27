/**
 * Projects the sandbox lifecycle onto the spawner-level provider contract.
 *
 * @since 0.1.0
 */

import * as Effect from "effect/Effect"
import type { Provider as RemoteProvider } from "../RemoteChildProcessSpawner/Provider.ts"
import { ProviderError } from "../RemoteChildProcessSpawner/ProviderError.ts"
import type { Provider } from "./Provider.ts"
import type { Session } from "./Session.ts"

/**
 * What the projected provider declares beyond `open` and `spawn`.
 *
 * `RemoteChildProcessSpawner` and the conformance suite decide statically —
 * from the presence of `kill` and `ping` on the provider value — whether a
 * capability exists, but a lifecycle provider only learns what its session
 * can do after `acquire`. The caller closes that gap by declaring what its
 * sessions provide; a declared capability the acquired session turns out to
 * lack fails honestly instead of pretending.
 *
 * @category models
 * @since 0.1.0
 */
export interface CommandProviderOptions {
  /** The session key `open` acquires. */
  readonly session: string
  /** Capabilities the acquired sessions are declared to have. */
  readonly provides?: {
    readonly kill?: boolean | undefined
    readonly ping?: boolean | undefined
  } | undefined
}

const noSession = (operation: string): ProviderError =>
  new ProviderError({
    code: "unavailable",
    message: `the sandbox session is not open, so it cannot ${operation}`
  })

const undeclared = (operation: string): ProviderError =>
  new ProviderError({
    code: "unavailable",
    message: `the acquired sandbox session does not provide ${operation}, though the provider declared it`
  })

/**
 * Adapts a sandbox provider to `RemoteChildProcessSpawner.Provider`.
 *
 * `open` acquires the machine through the lifecycle contract — create or
 * reattach, teardown as a finalizer of the opening scope — and `spawn`
 * reaches whichever session is currently held. Everything already built on
 * the spawner-level contract (`RemoteChildProcessSpawner.layer`,
 * `SandboxHealth.make`, `SandboxSupervision`, `ProviderConformance`)
 * therefore composes with a lifecycle provider unchanged, and supervision's
 * retire-and-reopen cycle provisions a fresh machine each generation.
 *
 * The held session is cleared only by its own finalizer's identity check, so
 * a stale generation closing late cannot null out the session a newer `open`
 * installed.
 *
 * @category constructors
 * @since 0.1.0
 */
export const commandProvider = (
  provider: Provider,
  options: CommandProviderOptions
): RemoteProvider => {
  // A generation wrapper, not the session itself: a provider is free to hand
  // the same session object to every acquire (a reattaching machine does), so
  // the held slot must be cleared by the generation that installed it, never
  // by session identity.
  let live: { readonly session: Session } | undefined
  const spawn: RemoteProvider["spawn"] = (command, spawnOptions) =>
    Effect.suspend(() =>
      live === undefined ? Effect.fail(noSession("spawn a command")) : live.session.spawn(command, spawnOptions)
    )
  const kill: RemoteProvider["kill"] = options.provides?.kill === true
    ? (process, signal) =>
      Effect.suspend(() => {
        if (live === undefined) return Effect.fail(noSession("signal a command"))
        const deliver = live.session.kill
        return deliver === undefined ? Effect.fail(undeclared("kill")) : deliver(process, signal)
      })
    : undefined
  const ping: RemoteProvider["ping"] = options.provides?.ping === true
    ? Effect.suspend(() => {
      if (live === undefined) return Effect.fail(noSession("answer a ping"))
      return live.session.ping ?? Effect.fail(undeclared("ping"))
    })
    : undefined
  return {
    session: options.session,
    // Unconditional, unlike `kill` and `ping`: the session contract obliges
    // every provider to deliver `options.stdin`, so this is an obligation
    // being restated rather than a capability being declared, and it must not
    // become another `options.provides` flag. Leaving it unset made the
    // adapter refuse every input-fed command with `BadArgument` — the exact
    // silent input loss the flag exists to prevent, inverted.
    stdin: true,
    open: (session) =>
      Effect.gen(function*() {
        const acquired = yield* provider.acquire(session)
        const generation = { session: acquired }
        live = generation
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (live === generation) live = undefined
          })
        )
      }),
    spawn,
    kill,
    ping
  }
}
