import { pathRepo } from "../RepoLink"

export interface FrameLocation {
  readonly workspaceId: string
  readonly branchId: string
  readonly frameId: string
}

export interface FrameHistoryPort {
  readonly current: () => FrameLocation | undefined
  readonly push: (location: FrameLocation) => void
  readonly replace: (location: FrameLocation) => void
  readonly back: () => void
  readonly forward: () => void
  readonly subscribe: (listener: (location: FrameLocation | undefined) => void) => () => void
}

const segment = (value: string): string => encodeURIComponent(value)

export const framePath = (location: FrameLocation): string =>
  `/w/${segment(location.workspaceId)}/b/${segment(location.branchId)}/f/${segment(location.frameId)}`

export const parseFramePath = (pathname: string): FrameLocation | undefined => {
  const match = /^\/w\/([^/]+)\/b\/([^/]+)\/f\/([^/]+)\/?$/.exec(pathname)
  if (match === null) return undefined
  try {
    const workspaceId = decodeURIComponent(match[1]!)
    const branchId = decodeURIComponent(match[2]!)
    const frameId = decodeURIComponent(match[3]!)
    if (workspaceId === "" || branchId === "" || frameId === "") return undefined
    return { workspaceId, branchId, frameId }
  } catch {
    return undefined
  }
}

interface BrowserHistoryHost {
  readonly location: { readonly pathname: string; readonly search?: string }
  readonly history: {
    readonly state: unknown
    pushState: (data: unknown, unused: string, url?: string | URL | null) => void
    replaceState: (data: unknown, unused: string, url?: string | URL | null) => void
    back: () => void
    forward: () => void
  }
  addEventListener: (type: "popstate", listener: () => void) => void
  removeEventListener: (type: "popstate", listener: () => void) => void
}

const isLocation = (value: unknown): value is FrameLocation =>
  typeof value === "object" && value !== null &&
  typeof (value as FrameLocation).workspaceId === "string" &&
  typeof (value as FrameLocation).branchId === "string" &&
  typeof (value as FrameLocation).frameId === "string"

/** The frame location a history entry's state carries, or undefined for a foreign or stateless entry. */
const stateLocation = (state: unknown): FrameLocation | undefined => {
  const location: unknown = typeof state === "object" && state !== null ? (state as { readonly location?: unknown }).location : undefined
  return isLocation(location) ? location : undefined
}

/**
 * Browser History is an adapter at the composition root, never React state.
 *
 * Two address-bar modes, chosen once from the entry URL:
 * - Booted from `/` or `/w/...`: every entry's URL is the frame pointer
 *   (`/w/<workspace>/b/<branch>/f/<frame>`) and the location is read back
 *   from the pathname.
 * - Booted from a repository path (`/owner/name`, RepoLink.pathRepo): the
 *   address bar keeps that exact path for the life of the page, so a reload
 *   or a shared link reselects the repository. Frame navigation still pushes
 *   history entries and back/forward still fire popstate; the location
 *   travels in each entry's state instead of its URL.
 * - Mounted with `keepUrl` (AppMount.tsx, the smithers.sh home page): the
 *   entry URL is kept for the life of the page.
 */
export interface BrowserFrameHistoryOptions {
  readonly keepUrl?: boolean
}

export const createBrowserFrameHistory = (
  host: BrowserHistoryHost,
  options: BrowserFrameHistoryOptions = {}
): FrameHistoryPort => {
  const pinned = pathRepo(host.location.pathname) !== null || options.keepUrl === true ? host.location.pathname : undefined
  const current = (): FrameLocation | undefined =>
    pinned === undefined ? parseFramePath(host.location.pathname) : stateLocation(host.history.state)
  // External-session links must survive the initial frame replacement and reload.
  const search = new URLSearchParams(host.location.search)
  const external = new URLSearchParams()
  for (const agent of ["codex", "claude"]) {
    const session = search.get(agent)
    if (session) external.set(agent, session)
  }
  const suffix = external.size === 0 ? "" : `?${external}`
  const url = (location: FrameLocation): string => (pinned === undefined ? framePath(location) : pinned) + suffix
  return {
    current,
    push: (location) => host.history.pushState({ smithersFrame: true, location }, "", url(location)),
    replace: (location) => host.history.replaceState({ smithersFrame: true, location }, "", url(location)),
    back: () => host.history.back(),
    forward: () => host.history.forward(),
    subscribe: (listener) => {
      const onPopState = (): void => listener(current())
      host.addEventListener("popstate", onPopState)
      return () => host.removeEventListener("popstate", onPopState)
    }
  }
}
