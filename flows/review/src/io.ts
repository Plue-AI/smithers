/** Scoped adapter for retained asynchronous review algorithms. Every operation uses caller-owned guarded services. */
import { Effect, type FileSystem } from "effect"
import type * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"
import { AsyncLocalStorage } from "node:async_hooks"

export interface Io {
  readonly fs: FileSystem.FileSystem
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]
  readonly signal: AbortSignal
}
const active = new AsyncLocalStorage<Io>()
/** No native or ambient fallback: the ordinary flow host must provide the platform. */
export const io = (): Io => {
  const value = active.getStore()
  if (value === undefined) throw new Error("Review requires the flow host filesystem and process services")
  return value
}
/** Retain the action's cancellation signal and host services through Promise helpers. */
export const withIo = <A>(host: Io, operation: () => Promise<A>): Promise<A> => active.run(host, operation)
/** Execute one host operation using the owning action's cancellation signal. */
export const runIo = <A, E>(operation: Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(operation, { signal: io().signal })
