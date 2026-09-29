import { Data } from "effect"
import type { LocalIdentityStatus } from "@smthrs/rpc/ApplicationAuth"
import { ApplicationClientError, type LocalIdentityClient } from "../runtime/ApplicationClient"
import { presentAppFailure } from "./controller/AppFailure"
import { refusalLine } from "@smthrs/rpc/RefusalCopy"

export interface LocalAuthSnapshot {
  readonly open: boolean
  readonly pending: boolean
  readonly status: LocalIdentityStatus | null
  readonly error: string | null
}

export interface LocalAuthController {
  readonly requiresBootstrapTokenInput: boolean
  readonly subscribe: (listener: () => void) => () => void
  readonly snapshot: () => LocalAuthSnapshot
  readonly open: () => void
  readonly close: () => void
  readonly submit: (input: {
    readonly username: string
    readonly password: string
    readonly bootstrapToken?: string
  }) => Promise<void>
  readonly dispose: () => void
}

/** Thrown when the owner submits setup without a bootstrap token; its message is authored copy. */
class BootstrapTokenMissing extends Data.TaggedError("BootstrapTokenMissing")<{ readonly sentence: string }> {
  constructor(sentence: string) { super({ sentence }) }
  /** The sentence is also the error's message, for diagnostics and thrown-value checks. */
  override get message(): string { return this.sentence }
}

/*
 * A refusal the local server answered keeps its own words when the person
 * can act on them (a wrong password says so; `refusalLine`). Anything else, including a request that never reached the server,
 * gets a product sentence; its raw text is never shown.
 */
const messageOf = (error: unknown): string =>
  error instanceof BootstrapTokenMissing ? error.sentence
    : error instanceof ApplicationClientError && error.status !== null ? refusalLine(error.refusal, "Local sign-in could not finish.")
    : presentAppFailure(error, () => {}, { fault: "bug", sentence: "Local sign-in could not finish. Try again.", actions: ["retry"] }).sentence

/** Ephemeral credential UI state. Usernames may be reflected; secrets never enter the app store. */
export const createLocalAuthController = (
  client: LocalIdentityClient,
  authenticated: () => Promise<void>,
  bootstrapToken?: () => Promise<string | undefined>
): LocalAuthController => {
  const listeners = new Set<() => void>()
  let current: LocalAuthSnapshot = { open: false, pending: false, status: null, error: null }
  let operation: AbortController | undefined
  let generation = 0

  const publish = (next: LocalAuthSnapshot): void => {
    current = next
    for (const listener of listeners) listener()
  }
  const start = (): { readonly signal: AbortSignal; readonly generation: number } => {
    operation?.abort()
    operation = new AbortController()
    generation += 1
    return { signal: operation.signal, generation }
  }
  const isCurrent = (candidate: number): boolean => candidate === generation && operation?.signal.aborted !== true

  const refresh = async (): Promise<void> => {
    const read = start()
    publish({ ...current, pending: true, error: null })
    try {
      const status = await client.status(read.signal)
      if (!isCurrent(read.generation)) return
      publish({ ...current, pending: false, status, error: status.enabled ? null : "Local sign-in is unavailable." })
    } catch (error) {
      if (!isCurrent(read.generation)) return
      publish({ ...current, pending: false, status: null, error: messageOf(error) })
    }
  }

  const open = (): void => {
    if (current.open) {
      if (!current.pending && current.status === null) void refresh()
      return
    }
    publish({ ...current, open: true, error: null })
    void refresh()
  }
  const close = (): void => {
    operation?.abort()
    generation += 1
    publish({ ...current, open: false, pending: false, error: null })
  }
  const submit: LocalAuthController["submit"] = async (input) => {
    const status = current.status
    if (status === null || !status.enabled || current.pending) return
    const request = start()
    publish({ ...current, pending: true, error: null })
    try {
      if (status.initialized) {
        await client.login({ username: input.username, password: input.password }, request.signal)
      } else {
        const token = input.bootstrapToken?.trim() || (await bootstrapToken?.())?.trim()
        if (token === undefined || token === "") throw new BootstrapTokenMissing("Bootstrap token is required.")
        if (!isCurrent(request.generation)) return
        await client.bootstrap({
          username: input.username,
          password: input.password,
          bootstrapToken: token
        }, request.signal)
      }
      if (!isCurrent(request.generation)) return
      await authenticated()
      if (!isCurrent(request.generation)) return
      publish({ open: false, pending: false, status: { ...status, initialized: true, username: input.username }, error: null })
    } catch (error) {
      if (!isCurrent(request.generation)) return
      publish({ ...current, pending: false, error: messageOf(error) })
    }
  }
  const dispose = (): void => {
    operation?.abort()
    generation += 1
    listeners.clear()
  }

  return {
    requiresBootstrapTokenInput: bootstrapToken === undefined,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    snapshot: () => current,
    open,
    close,
    submit,
    dispose
  }
}
