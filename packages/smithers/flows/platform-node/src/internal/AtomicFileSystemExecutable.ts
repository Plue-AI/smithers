/**
 * Finds the native filesystem helper embedded in a host, shipped with this package, or built in a
 * source checkout, without accepting an executable from the workspace.
 * @since 1.0.0
 */

import { createHash, randomBytes } from "node:crypto"
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  utimes,
  utimesSync,
  writeFileSync
} from "node:fs"
import { createRequire } from "node:module"
import { homedir, tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { inside, usableExecutable } from "./AtomicFileSystemTransport.ts"

/* v8 ignore next -- the packed CJS consumer uses its loader's __dirname; source tests use the ESM loader */
const moduleDirectory = typeof __dirname === "string" ? __dirname : dirname(fileURLToPath(import.meta.url))

/**
 * The same source module lives one directory deeper after an npm build.
 * @private
 * @since 1.0.0
 */
export const resolvePackageRoot = (directory: string): string => {
  const sourcePackageRoot = resolve(directory, "../..")
  return existsSync(join(sourcePackageRoot, "package.json"))
    ? sourcePackageRoot
    : resolve(directory, "../../..")
}

/**
 * Finds the installed package even when a host bundles this adapter elsewhere.
 * @private
 * @since 1.0.0
 */
export const installedPackageRoot = (modulePath: string, fallback: string): string => {
  try {
    return dirname(createRequire(modulePath).resolve("@smthrs/platform-node/package.json"))
  } catch {
    // A compiled executable has no installed package; its bootstrap supplies
    // the embedded helper. Source-only fixtures retain the directory fallback.
    return fallback
  }
}

/**
 * Package containing the currently loaded helper adapter.
 * @private
 * @since 1.0.0
 */
export const packageRoot = installedPackageRoot(
  join(moduleDirectory, "resolver.cjs"),
  resolvePackageRoot(moduleDirectory)
)

/** Each source's staged copy, and when this process last marked its directory in use. */
const staged = new Map<string, { readonly path: string; touchedAt: number }>()
/**
 * Package roots already staged, and the sources that staging copied. Staging
 * happens once per root per process: a later layer build runs after flows may
 * have planted a helper, so only what existed at the FIRST build is trusted.
 */
const stagedRoots = new Set<string>()
const trusted = new Set<string>()
const installHint = "install @smthrs/platform-node with its native helper, " +
  "run cargo build --locked --release -p smithers-ffi --bin smithers-jj-export in a source checkout, " +
  "or set SMITHERS_WORKSPACE_JJ_EXPORT_BINARY to its absolute path"

const helperName = process.platform === "win32" ? "smithers-jj-export.exe" : "smithers-jj-export"

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex")

/** Creates or adopts the per-user staging directory, refusing links and other owners. */
const privateDirectory = (directory: string): void => {
  try {
    mkdirSync(directory, { mode: 0o700 })
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause
  }
  const info = lstatSync(directory)
  const uid = process.getuid?.()
  if (!info.isDirectory() || (uid !== undefined && info.uid !== uid)) {
    throw new Error(`atomic helper staging directory is not a private directory: ${directory}`)
  }
  chmodSync(directory, 0o700)
}

/**
 * Whether the staged copy is this user's own single-link file holding exactly
 * the helper's bytes. A planted link, even one with the right bytes, is
 * replaced: rename swaps the directory entry, never the linked inode.
 */
const matches = (destination: string, digest: string): boolean => {
  try {
    const info = lstatSync(destination)
    const uid = process.getuid?.()
    if (!info.isFile() || info.nlink !== 1 || (uid !== undefined && info.uid !== uid)) return false
    return sha256(readFileSync(destination)) === digest
  } catch {
    return false
  }
}

/** A staged copy no process has used for this long is removed; use refreshes the directory's time. */
const staleMs = 7 * 24 * 60 * 60 * 1000
const refreshMs = 60 * 60 * 1000

/** Marks a staging directory in use, at most hourly, so no other process prunes it while this one runs. */
const refresh = (copy: { readonly path: string; touchedAt: number }): void => {
  const now = Date.now()
  if (now - copy.touchedAt < refreshMs) return
  copy.touchedAt = now
  // Best effort and off the request path: a failed touch only risks a later re-stage.
  utimes(dirname(copy.path), now / 1000, now / 1000, () => {})
}

/**
 * Removes this user's stale staging directories beside `keep`: other helper
 * builds and the per-process copies earlier versions left behind on a signal.
 */
const prune = (base: string, keep: string): void => {
  const uid = process.getuid?.()
  const now = Date.now()
  let names: Array<string>
  try {
    names = readdirSync(base)
  } catch {
    return
  }
  for (const name of names) {
    if (!name.startsWith(".smthrs-atomic-helper-") || name === keep) continue
    const directory = join(base, name)
    try {
      const info = lstatSync(directory)
      if (!info.isDirectory() || (uid !== undefined && info.uid !== uid)) continue
      if (now - info.mtimeMs > staleMs) rmSync(directory, { recursive: true, force: true })
    } catch {
      // Another process removed or replaced it first.
    }
  }
}

let embeddedHelper: string | undefined

/**
 * Supplies the build's native asset without touching disk during --help.
 * @private
 * @since 1.0.0
 */
export const registerEmbeddedHelper = (source: string): void => {
  embeddedHelper = source
}

/**
 * Pin an install inside the workspace before any flow can modify its bytes.
 * @private
 * @since 1.0.0
 */
export const outsideWorkspace = (
  source: string,
  boundaryRoot: string | undefined,
  bases: ReadonlyArray<string> = [tmpdir(), homedir()]
): string => {
  const cached = staged.get(source)
  if (cached !== undefined) {
    if (existsSync(cached.path)) {
      refresh(cached)
      return usableExecutable(cached.path, boundaryRoot)
    }
    // A newer build's process pruned this copy after a week unused: stage it again.
    staged.delete(source)
  }
  // readFile also supports assets embedded in a Bun executable; copyfile
  // delegates to the OS, which cannot open its virtual /$bunfs path.
  const bytes = readFileSync(source)
  const digest = sha256(bytes)
  for (const [index, base] of bases.entries()) {
    const directory = join(base, `.smthrs-atomic-helper-${digest}`)
    const destination = join(directory, helperName)
    let temporary: string | undefined
    try {
      privateDirectory(directory)
      // Fresh before it is read, so a concurrent prune passes it by.
      const now = new Date()
      utimesSync(directory, now, now)
      if (!matches(destination, digest)) {
        // One copy per user and helper: concurrent processes each write a
        // private temporary file and rename it over the shared name, so a
        // reader only ever sees a complete copy.
        temporary = join(directory, `.${helperName}.${process.pid}.${randomBytes(6).toString("hex")}`)
        writeFileSync(temporary, bytes, { flag: "wx", mode: 0o500 })
        chmodSync(temporary, 0o500)
        renameSync(temporary, destination)
        temporary = undefined
      }
      const executable = usableExecutable(destination, boundaryRoot)
      prune(base, `.smthrs-atomic-helper-${digest}`)
      staged.set(source, { path: executable, touchedAt: now.getTime() })
      return executable
    } catch (cause) {
      if (temporary !== undefined) rmSync(temporary, { force: true })
      if (index === bases.length - 1) throw cause
    }
  }
  throw new Error("no staging location for smithers-jj-export")
}

/** The helper an installed package ships for this platform. */
const packagedHelper = (root: string): string => join(root, "bin", `${process.platform}-${process.arch}`, helperName)

/** Source-checkout builds, when `root` is this package inside a checkout. */
const checkoutHelpers = (root: string): ReadonlyArray<string> => {
  const checkout = resolve(root, "../../../..")
  return existsSync(join(checkout, "pnpm-workspace.yaml"))
    ? [join(checkout, "target/release", helperName), join(checkout, "target/debug", helperName)]
    : []
}

/**
 * Stages the packaged helper and any source-checkout build the first time a
 * host layer over `root` is built in this process, so the bytes later requests
 * execute are the ones present before any flow ran. Later builds stage
 * nothing: a flow of an earlier run may already have planted a helper by then.
 * A flow that rewrites a workspace-local install or build afterwards changes
 * nothing that is executed. A missing or unusable helper is left for the first
 * request to report.
 * @private
 * @since 1.0.0
 */
export const stagePackaged = (root: string): void => {
  if (stagedRoots.has(root)) return
  stagedRoots.add(root)
  const candidate = embeddedHelper ?? packagedHelper(root)
  try {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      outsideWorkspace(candidate, undefined)
      trusted.add(candidate)
    }
  } catch {
    // The request path resolves again and reports the refusal it meets.
  }
  if (embeddedHelper !== undefined) return
  for (const build of checkoutHelpers(root)) {
    try {
      if (existsSync(build)) {
        const executable = usableExecutable(build, undefined)
        outsideWorkspace(executable, undefined)
        trusted.add(executable)
      }
    } catch {
      // As above: the request path reports it.
    }
  }
}

/**
 * Whether a flow confined to `boundaryRoot` could have supplied what
 * `candidate` runs: the name itself lies inside the workspace (so a flow could
 * have replaced it with a link to any host binary), its directory resolves
 * inside it, or the file it resolves to does.
 */
const workspaceSupplied = (candidate: string, source: string, boundaryRoot: string): boolean =>
  inside(boundaryRoot, resolve(candidate)) ||
  inside(boundaryRoot, join(realpathSync.native(dirname(candidate)), basename(candidate))) ||
  inside(boundaryRoot, realpathSync.native(source))

/**
 * Copies `source` to a private directory only when the workspace cannot have
 * supplied its bytes: neither `candidate` nor what it resolves to lies inside
 * the confined workspace, or `source` was staged at the first host build,
 * before any flow ran. A helper, or a link to one, that appeared inside the
 * workspace later is exactly what a flow would plant.
 */
const pinned = (candidate: string, source: string, boundaryRoot: string | undefined): string => {
  if (boundaryRoot !== undefined && !trusted.has(source) && workspaceSupplied(candidate, source, boundaryRoot)) {
    throw new Error(
      `atomic helper executable must live outside the confined workspace: ${candidate} ` +
        "was not present when the host was built"
    )
  }
  return outsideWorkspace(source, boundaryRoot)
}

/**
 * Select only trusted package or checkout locations; never consult PATH or cwd.
 * @private
 * @since 1.0.0
 */
export const resolveDefaultExecutable = (
  root: string,
  boundaryRoot: string | undefined,
  fallback = "/usr/local/bin/smithers-jj-export"
): string => {
  if (embeddedHelper !== undefined) return outsideWorkspace(embeddedHelper, boundaryRoot)
  const candidates = [packagedHelper(root), ...checkoutHelpers(root), fallback]
  for (const [index, candidate] of candidates.entries()) {
    if (!existsSync(candidate)) continue
    if (index === 0) {
      if (!statSync(candidate).isFile()) throw new Error(`packaged atomic helper is not a regular file: ${candidate}`)
      // npm/pnpm tarballs may store package files without executable bits.
      return pinned(candidate, candidate, boundaryRoot)
    }
    const executable = usableExecutable(candidate, undefined)
    return boundaryRoot !== undefined && workspaceSupplied(candidate, executable, boundaryRoot)
      ? pinned(candidate, executable, boundaryRoot)
      : executable
  }
  throw new Error(`smithers-jj-export is missing; ${installHint} (searched ${candidates.join(", ")})`)
}

/**
 * The helper `SMITHERS_WORKSPACE_JJ_EXPORT_BINARY` names, refused with the same
 * install hint as a missing one.
 * @private
 * @since 1.0.0
 */
export const resolveConfiguredExecutable = (configured: string, boundaryRoot: string | undefined): string => {
  try {
    return usableExecutable(configured, boundaryRoot)
  } catch (cause) {
    // `usableExecutable` and the node:fs calls it makes throw only Error objects.
    const reason = (cause as Error).message
    throw new Error(
      `smithers-jj-export is unusable at SMITHERS_WORKSPACE_JJ_EXPORT_BINARY=${configured}: ${reason}; ${installHint}`
    )
  }
}
