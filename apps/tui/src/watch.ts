/**
 * Hot reload for repository flows. Native notifications request an identity
 * scan; reconciliation also observes edits dropped before the watcher is ready.
 * Only a changed tree refreshes the metadata registry, once per burst.
 */
import { createHash } from "node:crypto"
import { type BigIntStats, type FSWatcher, lstatSync, readdirSync, statSync, watch } from "node:fs"
import { lstat, readdir, stat as targetStat } from "node:fs/promises"
import { join } from "node:path"
import * as Failures from "./failures.ts"
import { FlowDiscoveryFailed } from "./flows.ts"
import * as Log from "./log.ts"
import type { Failure as MonitorFailure } from "./monitors.ts"

export interface Watcher {
  readonly dispose: () => void
}

export const debounceMs = 300
/** Match the build watcher's reconciliation cadence; scans never overlap. */
export const reconcileMs = 1000

const missing = (error: unknown) => ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")
const identity = (path: string, stat: BigIntStats) =>
  `${path}\0${stat.mode}\0${stat.size}\0${stat.mtimeNs}\0${stat.ctimeNs}\0${stat.ino}\n`
// Discovery does not enter dependency or hidden directories.
const listed = (entry: string) => entry !== "node_modules" && !entry.startsWith(".")
const physical = (stat: BigIntStats) => `${stat.dev}:${stat.ino}`
// Discovery.scan bounds directory traversal at 32 entry-name segments.
const maximumTraversalDepth = 32
type Snapshot = {
  readonly digest: string
  readonly root: string | undefined
  readonly failures: ReadonlyMap<string, unknown>
}
const sourceFailure: Extract<MonitorFailure, { readonly _tag: "SourceFailed" }> = {
  _tag: "SourceFailed",
  message: "Flow source unavailable"
}

/** Capture before returning the subscription, so immediate caller writes differ. */
const initial = (directory: string): Snapshot => {
  const hash = createHash("sha256")
  const visited = new Set<string>()
  const failures = new Map<string, unknown>()
  let root: string | undefined
  const visit = (path: string, depth = 0): void => {
    try {
      const link = lstatSync(path, { bigint: true })
      if (link.isSymbolicLink()) hash.update(identity(path, link))
      const stat = link.isSymbolicLink() ? statSync(path, { bigint: true }) : link
      hash.update(identity(path, stat))
      if (!stat.isDirectory()) return
      const key = physical(stat)
      if (path === directory) root = key
      if (depth > maximumTraversalDepth || visited.has(key)) return
      visited.add(key)
      for (const entry of readdirSync(path).filter(listed).sort()) visit(join(path, entry), depth + 1)
    } catch (error) {
      if (missing(error)) return
      if (depth === 0) throw error
      failures.set(path, error)
      hash.update(`${path}\0unreadable\0${Failures.identity(error)}\n`)
    }
  }
  visit(directory)
  return { digest: hash.digest("hex"), root, failures }
}

/** Calls `refresh` once per burst of changes under `<cwd>/flows`, including its creation. */
export const flows = (cwd: string, refresh: () => void, debounce = debounceMs): Watcher => {
  const directory = join(cwd, "flows")
  let timer: ReturnType<typeof setTimeout> | undefined
  let tree: FSWatcher | undefined
  let parent: FSWatcher | undefined
  let closed = false
  let scanning = false
  let again = false
  let baseline: Snapshot | undefined
  let attached: string | undefined
  let scanFailure: string | undefined
  let watchFailure: string | undefined
  let partialFailures = new Set<string>()
  const announce = (failure: FlowDiscoveryFailed | typeof sourceFailure) => {
    if (closed) return
    const message = Failures.line("flow", failure)
    // Startup effects install the terminal's log subscriber later in this turn.
    queueMicrotask(() => {
      if (!closed) Log.alert("flow.watch", message)
    })
  }
  const report = (cause: unknown) => announce(new FlowDiscoveryFailed(cause))
  const observerFailed = (cause: unknown) => {
    if (closed) return
    Log.write("flow.watch", cause)
    announce(sourceFailure)
  }
  const partial = (observed: Snapshot) => {
    const failures = new Set<string>()
    let fresh = false
    for (const [path, cause] of observed.failures) {
      const key = `${path}\0${Failures.identity(cause)}`
      failures.add(key)
      if (partialFailures.has(key)) continue
      Log.write("flow.watch.entry", cause)
      fresh = true
    }
    partialFailures = failures
    if (fresh) announce(sourceFailure)
  }
  const changed = () => {
    if (closed) return
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      if (!closed) refresh()
    }, debounce)
  }
  const open = (root: string | undefined) => {
    if (closed || attached === root) return
    tree?.close()
    tree = undefined
    attached = undefined
    if (root === undefined) return
    try {
      const watched = watch(directory, { recursive: true }, reconcile)
      tree = watched
      attached = root
      watchFailure = undefined
      watched.on("error", (error) => {
        if (closed || tree !== watched) return
        watched.close()
        tree = undefined
        attached = undefined
        if (!missing(error)) observerFailed(error)
        reconcile()
      })
    } catch (error) {
      const key = Failures.identity(error)
      if (!missing(error) && key !== watchFailure) observerFailed(error)
      watchFailure = key
    }
  }
  const snapshot = async (): Promise<Snapshot | undefined> => {
    const hash = createHash("sha256")
    const visited = new Set<string>()
    const failures = new Map<string, unknown>()
    let root: string | undefined
    const visit = async (path: string, depth = 0): Promise<void> => {
      if (closed) return
      try {
        const link = await lstat(path, { bigint: true })
        if (closed) return
        if (link.isSymbolicLink()) hash.update(identity(path, link))
        const stat = link.isSymbolicLink() ? await targetStat(path, { bigint: true }) : link
        if (closed) return
        hash.update(identity(path, stat))
        if (!stat.isDirectory()) return
        const key = physical(stat)
        if (path === directory) root = key
        if (depth > maximumTraversalDepth || visited.has(key)) return
        visited.add(key)
        const entries = await readdir(path)
        for (const entry of entries.filter(listed).sort()) {
          if (closed) return
          await visit(join(path, entry), depth + 1)
        }
      } catch (error) {
        if (missing(error)) return
        if (depth === 0) throw error
        failures.set(path, error)
        hash.update(`${path}\0unreadable\0${Failures.identity(error)}\n`)
      }
    }
    await visit(directory)
    return closed ? undefined : { digest: hash.digest("hex"), root, failures }
  }
  const reconcile = () => {
    if (closed) return
    if (scanning) {
      again = true
      return
    }
    scanning = true
    void snapshot().then((observed) => {
      if (closed || observed === undefined) return
      scanFailure = undefined
      partial(observed)
      open(observed.root)
      if (observed.digest !== baseline?.digest) changed()
      baseline = observed
    }).catch((error: unknown) => {
      const key = Failures.identity(error)
      if (key !== scanFailure) report(error)
      scanFailure = key
    }).finally(() => {
      scanning = false
      if (again) {
        again = false
        reconcile()
      }
    })
  }
  try {
    const observed = initial(directory)
    baseline = observed
    queueMicrotask(() => {
      if (!closed) partial(observed)
    })
  } catch (error) {
    scanFailure = Failures.identity(error)
    queueMicrotask(() => report(error))
  }
  try {
    // `flows/` itself appearing or disappearing.
    parent = watch(cwd, (_, name) => {
      if (name === "flows") reconcile()
    })
    parent.on("error", (error) => {
      parent?.close()
      parent = undefined
      if (!missing(error)) observerFailed(error)
    })
  } catch (error) {
    if (!missing(error)) observerFailed(error)
  }
  open(baseline?.root)
  const interval = setInterval(reconcile, reconcileMs)
  return {
    dispose: () => {
      closed = true
      clearInterval(interval)
      if (timer !== undefined) clearTimeout(timer)
      tree?.close()
      parent?.close()
    }
  }
}
