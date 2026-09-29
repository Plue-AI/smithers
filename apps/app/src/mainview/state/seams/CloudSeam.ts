/*
 * The Smithers Cloud session seam (lane piper step 1b, ADR 0001): the renderer's
 * half of the CLI browser login. The Bun side holds the token (memory + OS
 * keychain) and answers only `{ state, username, expiresAt, scopes? }`; this
 * seam mirrors THAT answer into the `cloudSessions` row. The web Worker
 * serves the same contract from the GitHub session and its Cloud exchange.
 * Only the native host runs the separate sign-in
 * act: POST /api/cloud-auth/start answers the login URL, the native
 * `openExternal` door opens it in the system browser, and the seam polls the
 * session until the callback lands (the Bun side gives up after five
 * minutes). The token never crosses this seam.
 */
import {
  CLOUD_AUTH_SESSION_PATH,
  CLOUD_AUTH_SIGN_OUT_PATH,
  CLOUD_AUTH_START_PATH,
  CloudAuthStartResponseSchema,
  CloudSessionSchema
} from "@smthrs/rpc/CloudTunnel"
import type { SeamContext } from "./SeamContext"

export interface CloudSeam {
  /** Mirror the serving host's session answer into the store (actor: system). */
  readonly loadSession: () => Promise<void>
  /** The cloud.sign-in flow: open the login URL, then wait for the callback. */
  readonly signIn: () => Promise<string | void>
  /** Forget the stored credential (the env override is not sign-out-able). */
  readonly signOut: () => Promise<string | void>
}

export interface CloudSeamDeps {
  /** Invalidate an outstanding read when app identity changes or signs out. */
  readonly sessionEpoch?: () => number
  /** The native system-browser door; absent in a plain browser (window.open falls back). */
  readonly openExternal?: (url: string) => Promise<boolean>
  /** The session poll cadence while the login is out in the browser; tests shorten it. */
  readonly pollMs?: number
  /** The whole wait; production matches the Bun side's five-minute callback timeout. */
  readonly timeoutMs?: number
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export const createCloudSeam = (ctx: SeamContext, deps: CloudSeamDeps = {}): CloudSeam => {
  const pollMs = deps.pollMs ?? 2000
  const timeoutMs = deps.timeoutMs ?? 5 * 60 * 1000
  let readGeneration = 0

  const readSession = async (): Promise<ReturnType<typeof CloudSessionSchema.parse> | null> => {
    let response: Response
    try {
      response = await ctx.http(`${ctx.baseUrl}${CLOUD_AUTH_SESSION_PATH}`)
    } catch {
      return null
    }
    if (!response.ok) return null
    const parsed = CloudSessionSchema.safeParse(await response.json().catch(() => null))
    return parsed.success ? parsed.data : null
  }

  const mirror = (session: { state: "signed-out" | "signing-in" | "signed-in"; username: string | null; expiresAt: string | null; scopes?: "degraded" | undefined }): void => {
    ctx.dispatch({
      type: "cloud.session.loaded",
      actor: "system",
      state: session.state,
      username: session.username,
      expiresAt: session.expiresAt,
      scopes: session.scopes ?? null
    })
  }

  const openLogin = (url: string): void => {
    if (deps.openExternal !== undefined) {
      void deps.openExternal(url)
      return
    }
    if (typeof window !== "undefined") window.open(url, "_blank", "noopener")
  }

  return {
    loadSession: async () => {
      const generation = ++readGeneration
      const epoch = deps.sessionEpoch?.()
      const session = await readSession()
      // The seam discipline: only definitive answers change the record.
      if (session !== null && generation === readGeneration && epoch === deps.sessionEpoch?.()) mirror(session)
    },
    signIn: async () => {
      const current = await readSession()
      if (current?.state === "signed-in") {
        mirror(current)
        return current.username === null
          ? "Already signed in to Smithers Cloud."
          : `Already signed in to Smithers Cloud as ${current.username}.`
      }
      let response: Response
      try {
        response = await ctx.http(`${ctx.baseUrl}${CLOUD_AUTH_START_PATH}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}"
        })
      } catch {
        return "Could not reach the local app to start cloud sign-in."
      }
      if (!response.ok) {
        return `Cloud sign-in is not available here (${response.status}).`
      }
      const started = CloudAuthStartResponseSchema.safeParse(await response.json().catch(() => null))
      if (!started.success) return "The local app answered cloud sign-in with an unreadable payload."
      mirror({ state: "signing-in", username: null, expiresAt: null })
      openLogin(started.data.url)
      const deadline = Date.now() + timeoutMs
      for (;;) {
        await wait(pollMs)
        const session = await readSession()
        if (session?.state === "signed-in") {
          mirror(session)
          return
        }
        if (session?.state === "signed-out" || Date.now() >= deadline) {
          mirror({ state: "signed-out", username: null, expiresAt: null })
          return "Sign-in did not complete — the browser step was closed or timed out. Run /cloud.sign-in to try again."
        }
      }
    },
    signOut: async () => {
      readGeneration += 1
      try {
        const response = await ctx.http(`${ctx.baseUrl}${CLOUD_AUTH_SIGN_OUT_PATH}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}"
        })
        if (!response.ok) return `Cloud sign-out failed (${response.status}).`
      } catch {
        return "Could not reach the local app to sign out."
      }
      mirror({ state: "signed-out", username: null, expiresAt: null })
    }
  }
}
