import type { FetchLike } from "@smthrs/rpc/NativeAgent"
import { resolveApplicationTarget } from "@smthrs/rpc/ApplicationTarget"
import { createApplicationClient } from "./ApplicationClient"
import type { ApplicationClient } from "./ApplicationClient"
import { loadApplicationTarget, SAME_ORIGIN_SESSION_TARGET } from "./ApplicationTargetRuntime"
import { createAppFetch } from "./LocalSession"
import { selectedBackendTarget, selectedBackendToken } from "./BackendTargetSelection"

export const DEVELOPER_API_TOKEN_KEY = "smithers.developer-api-token"

const developerToken = (): string | undefined => {
  try {
    return globalThis.sessionStorage?.getItem(DEVELOPER_API_TOKEN_KEY) ?? undefined
  } catch {
    return undefined
  }
}

let clientRead: Promise<ApplicationClient> | undefined

/** One runtime-selected transport, shared by preload, bootstrap, and controllers. */
export const loadRuntimeApplicationClient = (): Promise<ApplicationClient> => {
  if (clientRead !== undefined) return clientRead
  const selected = selectedBackendTarget(location.origin)
  clientRead = loadApplicationTarget({
    native: async () => selected
  }).then((target) =>
    createApplicationClient(target, {
      fetchImpl: createAppFetch(),
      token: selected === undefined
        ? developerToken : () => selectedBackendToken(target, location.origin)
    })
  )
  void clientRead.catch(() => {
    clientRead = undefined
  })
  return clientRead
}

/** Async adapter for startup services that are created before target resolution settles. */
export const runtimeApplicationFetch: FetchLike = async (input, init) =>
  (await loadRuntimeApplicationClient()).fetch(input, init)

/** A failed target lookup is itself reportable on a web page's same-origin sink. */
export const runtimeClientErrorFetch: FetchLike = async (input, init) => {
  let client: ApplicationClient
  try {
    client = await loadRuntimeApplicationClient()
  } catch (error) {
    // The target is unknown. Never guess a native/external backend or attach a
    // bearer token; a hosted web page can still report to its serving origin.
    if (typeof location === "undefined" || !/^https?:$/.test(location.protocol)) throw error
    const sameOrigin = resolveApplicationTarget(SAME_ORIGIN_SESSION_TARGET, location.origin)
    return createApplicationClient(sameOrigin, { fetchImpl: createAppFetch() }).fetch(input, init)
  }
  // If a selected target lacks its token or refuses the POST, fail closed.
  // Reporting must never downgrade an authenticated external target to cookies.
  return client.fetch(input, init)
}
