/**
 * One `smthrs serve` process per gateway case, and the plumbing every case
 * repeats.
 *
 * Each case gets its own project root and its own server so that a case that
 * kills the process, floods the journal, or is refused at the door cannot
 * change what the next case sees.
 *
 * @since 1.0.0
 */
import type { Control } from "@smthrs/control"
import * as Effect from "effect/Effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type ClientOptions, controlClient, type ServeProcess, startServe } from "./serveProcess.ts"

/**
 * A served control plane plus the project root it was pointed at, both owned
 * by one case.
 *
 * @since 1.0.0
 * @category models
 */
export interface ServedSuite {
  readonly start: () => Promise<void>
  readonly stop: () => Promise<void>
  readonly server: () => ServeProcess
  /** Runs an effect through a fresh remote client with a valid credential. */
  readonly remote: <A, E>(body: Effect.Effect<A, E, Control.Control>) => Promise<A>
  /** Runs an effect through a client built with explicit options. */
  readonly remoteWith: <A, E>(
    options: Omit<ClientOptions, "url">,
    body: Effect.Effect<A, E, Control.Control>
  ) => Promise<A>
}

/**
 * Creates the per-case fixture. Call `start` in `beforeAll` and `stop` in
 * `afterAll`.
 *
 * @since 1.0.0
 * @category constructors
 */
export const servedSuite = (label: string): ServedSuite => {
  let directory: string | undefined
  let server: ServeProcess | undefined

  const current = (): ServeProcess => {
    if (server === undefined) throw new Error(`${label}: smthrs serve has not been started`)
    return server
  }

  const runWith = <A, E>(
    options: Omit<ClientOptions, "url">,
    body: Effect.Effect<A, E, Control.Control>
  ): Promise<A> =>
    Effect.runPromise(
      body.pipe(
        Effect.provide(controlClient({ ...options, url: current().url }).layer),
        Effect.scoped
      )
    )

  return {
    start: async () => {
      directory = mkdtempSync(join(tmpdir(), `smithers-e2e-${label}-`))
      server = await startServe(directory)
    },
    stop: async () => {
      await server?.stop()
      server = undefined
      if (directory !== undefined) rmSync(directory, { recursive: true, force: true })
      directory = undefined
    },
    server: current,
    remote: (body) => runWith({ credential: current().token }, body),
    remoteWith: runWith
  }
}
