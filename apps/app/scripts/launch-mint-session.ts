/*
 * Wave 6: mint a Playwright storage state holding a REAL signed-in session,
 * through the identity worker's TEST-MODE GitHub OAuth flow (the dev stack
 * points identity at the stub GitHub double, so the callback seals a session
 * cookie for the fixture user without a browser). This is the
 * SMITHERS_MVP_STORAGE_STATE the launch checklist's receipt documents.
 *
 *   bun scripts/launch-mint-session.ts <identity-base-url> <app-origin> <out-path>
 *
 * Example:
 *   bun scripts/launch-mint-session.ts http://127.0.0.1:8861 http://localhost:8788 /tmp/mvp-storage-state.json
 */
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

export interface SessionCookie {
  name: string
  value: string
  maxAge: string | undefined
  httpOnly: boolean
  strict: boolean
}

/** Parses the session cookie out of a Set-Cookie header; null when there is no `name=value` pair. */
export const parseSessionCookie = (setCookie: string): SessionCookie | null => {
  const match = /^([^=]+)=([^;]*)/.exec(setCookie)
  if (match === null) return null
  const [, name, value] = match
  return {
    name: name as string,
    value: value as string,
    maxAge: /max-age=(\d+)/i.exec(setCookie)?.[1],
    httpOnly: /httponly/i.test(setCookie),
    strict: /samesite=strict/i.test(setCookie)
  }
}

/**
 * The storage state holds a live session cookie, so it is written owner-only —
 * the documented output path is a predictable /tmp name.
 */
export const writeStorageState = (outPath: string, storageState: unknown): void => {
  // Replace atomically: mode on writeFileSync only applies to new files,
  // and opening the destination directly would follow a preexisting symlink.
  const staging = mkdtempSync(join(dirname(outPath), ".mint-session-"))
  try {
    const path = join(staging, "state.json")
    writeFileSync(path, `${JSON.stringify(storageState, null, 2)}\n`, { mode: 0o600, flag: "wx" })
    renameSync(path, outPath)
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

export const main = async (
  [identityBase, appOrigin, outPath]: string[],
  fetchImpl: typeof fetch = fetch
): Promise<number> => {
  if (identityBase === undefined || appOrigin === undefined || outPath === undefined) {
    console.error("usage: bun scripts/launch-mint-session.ts <identity-base-url> <app-origin> <out-path>")
    return 2
  }

  const appUrl = new URL(appOrigin)

  const start = await fetchImpl(`${identityBase}/api/auth/github/start`, { redirect: "manual" })
  const location = start.headers.get("location")
  if (start.status !== 302 || location === null) {
    console.error(`OAuth start answered ${start.status} with no redirect — is identity in TEST MODE?`)
    return 1
  }
  const state = new URL(location).searchParams.get("state")
  if (state === null) {
    console.error(`OAuth start redirect carried no state param: ${location}`)
    return 1
  }

  const callback = await fetchImpl(
    `${identityBase}/api/auth/github/callback?code=launch-mint&state=${encodeURIComponent(state)}`,
    { redirect: "manual" }
  )
  const setCookie = callback.headers.get("set-cookie")
  if (callback.status !== 302 || setCookie === null) {
    console.error(`OAuth callback answered ${callback.status} with no session cookie`)
    return 1
  }
  const cookie = parseSessionCookie(setCookie)
  if (cookie === null) {
    // Never quote the header: it carries the session cookie.
    console.error("unparseable set-cookie header from OAuth callback")
    return 1
  }

  const storageState = {
    cookies: [
      {
        name: cookie.name,
        value: cookie.value,
        domain: appUrl.hostname,
        path: "/",
        expires: cookie.maxAge === undefined ? -1 : Math.floor(Date.now() / 1000) + Number(cookie.maxAge),
        httpOnly: cookie.httpOnly,
        secure: false,
        sameSite: cookie.strict ? "Strict" : "Lax"
      }
    ],
    origins: []
  }
  writeStorageState(outPath, storageState)

  // Prove the minted session against the real user route before declaring it.
  const proof = await fetchImpl(`${identityBase}/api/user`, {
    headers: { cookie: `${cookie.name}=${cookie.value}` }
  })
  const session = (await proof.json()) as { login?: string; allowlisted?: boolean; admin?: boolean }
  console.log(
    `minted session cookie '${cookie.name}' for ${appUrl.hostname} -> ${outPath}\n` +
      `session proof: HTTP ${proof.status} ${JSON.stringify(session)}`
  )
  if (session.login === undefined) {
    console.error("the minted cookie did not validate — refusing to call this a session")
    return 1
  }
  return 0
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)))
}