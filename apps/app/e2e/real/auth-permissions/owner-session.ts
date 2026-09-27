import { createHash } from "node:crypto"
import type { Cookie } from "@playwright/test"

export type OwnerSessionScope = {
  readonly appOrigin: string
  readonly apiOrigin: string
  readonly username: string
  readonly password: string
  readonly bootstrapToken: string
}

const scopeKey = (scope: OwnerSessionScope): string => createHash("sha256").update(JSON.stringify([
  new URL(scope.appOrigin).origin, new URL(scope.apiOrigin).origin,
  scope.username, scope.password, scope.bootstrapToken
])).digest("hex")

/** Worker-local, server-issued cookies only. No browser storage or credentials go to disk.
 * Callers must verify GET /api/user before remembering and after restoring. */
export class OwnerSessionCookies {
  private readonly saved = new Map<string, Cookie[]>()

  read(scope: OwnerSessionScope): Cookie[] {
    return structuredClone(this.saved.get(scopeKey(scope)) ?? [])
  }

  remember(scope: OwnerSessionScope, cookies: Cookie[]): void {
    this.saved.set(scopeKey(scope), structuredClone(cookies))
  }

  forget(scope: OwnerSessionScope): void {
    this.saved.delete(scopeKey(scope))
  }
}

type AuthResponse = { readonly status: number; readonly retryAfter: string | null }
type RetryClock = { readonly now: () => number; readonly wait: (ms: number) => Promise<void> }
const clock: RetryClock = { now: Date.now, wait: ms => new Promise(resolve => setTimeout(resolve, ms)) }

/** A rejected credential request has no effect. Honor the server's retry boundary,
 * including concurrent workers, without retrying invalid credentials or transient errors. */
export const withOwnerAuthRetry = async <T extends AuthResponse>(send: () => Promise<T>, timer: RetryClock = clock): Promise<T> => {
  const deadline = timer.now() + 60_000
  for (let attempt = 0; ; attempt++) {
    const response = await send()
    if (response.status !== 429 || response.retryAfter === null || attempt >= 5) return response
    const value = response.retryAfter.trim()
    const delay = /^\d+(?:\.\d+)?$/.test(value) ? Number(value) * 1_000 : Date.parse(value) - timer.now()
    if (!Number.isFinite(delay) || delay < 0 || timer.now() + Math.max(1, delay) > deadline) return response
    await timer.wait(Math.max(1, delay))
  }
}
