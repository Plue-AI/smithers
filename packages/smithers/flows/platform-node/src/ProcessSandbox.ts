/**
 * The one operating-system sandbox every confined process goes through.
 *
 * A caller resolves what a run may touch, a {@link Request}: the network
 * posture, the read and write sets, and optionally which mechanism it wants.
 * This module turns the request into an argv the host enforces, or into an
 * {@link Unenforceable} refusal naming what the host lacks. Two callers share
 * it: the build graph confines every target's tool run under its declared
 * inputs and outputs (`@smthrs/targets/ExecSandbox`), and the Node
 * `ProcessConfinement` confines every approved agent command under the
 * grants in force.
 *
 * Three mechanisms, one contract:
 *
 * - Linux: bubblewrap. An empty root contains only enumerated system/runtime
 *   paths and declared reads and writes. The workspace and root are remounted
 *   read-only after mounting grants. A private tmp supplies HOME. The network
 *   namespace is unshared unless explicitly opened; loopback-only is refused.
 * - macOS: seatbelt (`sandbox-exec`). Host reads are denied except enumerated
 *   system/runtime paths, declared inputs, external reads, writes and private
 *   tmp. Host credential locations are re-closed under broad grants. Writes
 *   and network access are denied except what the request opens.
 * - Docker: `docker run` with a read-only root, declared reads mounted
 *   read-only at their host paths, declared writes read-write, `--network
 *   none` unless the request opens it. The image supplies the toolchain. It is
 *   the path on Windows and on any host without the native mechanism.
 *
 * Every declared confinement is enforced or the caller fails closed. Nothing
 * here logs "unenforced" and carries on; the one caller that may run
 * unconfined when no mechanism exists, `ProcessConfinement`, says so in its
 * own options and never on this module's behalf.
 *
 * @since 1.0.0-rc.1
 */

import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import * as NodeFs from "node:fs"
import * as NodeOs from "node:os"
import * as NodePath from "node:path"

/**
 * The network posture a run is confined to. `"none"` closes IP networking.
 * Build tools retain host Unix sockets by default. Native agent confinement
 * additionally closes host Unix sockets regardless of the IP posture, except
 * macOS's system DNS resolver endpoint when IP networking is open, and
 * refuses all Linux socket creation when IP networking is closed;
 * socketpair remains available for communication inside the process family.
 *
 * @category models
 * @since 1.0.0-rc.1
 */
export type Network = "none" | "loopback" | "open"

/**
 * Which mechanism a request asks for. Absent means the platform's native
 * mechanism: bubblewrap on Linux, seatbelt on macOS.
 *
 * @category models
 * @since 1.0.0-rc.1
 */
export type Selection =
  | { readonly _tag: "bubblewrap" }
  | { readonly _tag: "docker"; readonly image: string }

/**
 * What a caller asks for: the network posture, the mechanism choice, and the
 * read and write sets. Every path is workspace-relative and posix-shaped;
 * a read may name a file or a directory, a write names a directory. A
 * `readOnly` entry re-closes a subtree under a declared write.
 *
 * @category models
 * @since 1.0.0-rc.1
 */
export interface Request {
  readonly network: Network
  /** Whether host Unix sockets are permitted; defaults to true for build tools. */
  readonly unixSockets?: boolean | undefined
  /** Closed-by-default process and IPC policy for untrusted native commands. */
  readonly strict?: boolean | undefined
  readonly mechanism?: Selection | undefined
  readonly reads: ReadonlyArray<string>
  readonly writes: ReadonlyArray<string>
  /**
   * Declared outputs whose leaf is a file rather than a directory. A file
   * cannot be bound writable on its own and does not exist before the tool
   * writes it, so its parent directory becomes the writable bind. Kept apart
   * from `writes` because only the caller knows which of the two a
   * declaration meant: inferring it from the path would hand a not-yet-created
   * `.cargo-home` or `dist.new` its parent, and a parent that is the
   * workspace root opens the whole workspace for the run.
   */
  readonly writeFiles?: ReadonlyArray<string> | undefined
  readonly readOnly?: ReadonlyArray<string> | undefined
  /**
   * Absolute host paths outside the workspace the tool reads: a git
   * submodule's local source repository, for one. Bound read-only where the
   * mechanism would otherwise hide them; a path that does not exist, or that
   * sits inside the workspace, is dropped.
   */
  readonly externalReads?: ReadonlyArray<string> | undefined
}

/**
 * The host facts mechanism selection reads. Injectable so every platform's
 * argv can be tested on every other platform.
 *
 * @category models
 * @since 1.0.0-rc.1
 */
export interface Host {
  readonly platform: NodeJS.Platform
  /** Selected Xcode developer tree on a macOS runner. */
  readonly developerDirectory?: string | undefined
  /** The real host home, used to mask credentials and locate runtime caches. */
  readonly home?: string | undefined
  /** Resolves an executable name on `PATH` to an absolute path, or nothing. */
  readonly executable: (name: string) => string | undefined
  /** Whether a host path exists. */
  readonly exists: (path: string) => boolean
  /** Whether a host path is a directory. */
  readonly isDirectory: (path: string) => boolean
  /** Tests the entry itself, including dangling links; defaults to the real host. */
  readonly isSymbolicLink?: ((path: string) => boolean) | undefined
  /**
   * The names of a directory's direct children, or undefined when the host
   * cannot list it. Optional: a host without it keeps every declared file as
   * its own entry, which is correct and merely long.
   */
  readonly entries?: ((directory: string) => ReadonlyArray<string> | undefined) | undefined
  /**
   * Where a path's bytes actually live once every symbolic link on it is
   * followed, or `undefined` when the host cannot say. Write validation uses
   * the real host when this probe is omitted and refuses unresolved existing
   * paths. Read aliases are only collected when this probe is supplied.
   */
  readonly realpath?: ((path: string) => string | undefined) | undefined
  readonly uid: number | undefined
  readonly gid: number | undefined
}

/**
 * One selected enforcement mechanism.
 *
 * @category models
 * @since 1.0.0-rc.1
 */
export type Mechanism =
  | { readonly _tag: "bubblewrap"; readonly executable: string }
  | { readonly _tag: "seatbelt"; readonly executable: string }
  | { readonly _tag: "docker"; readonly executable: string; readonly image: string }
  | { readonly _tag: "none" }

/**
 * The refusal a host that cannot enforce a declared confinement produces.
 * `mechanism` names what was selected, `missing` what the host lacks.
 *
 * @category models
 * @since 1.0.0-rc.1
 */
export interface Unenforceable {
  readonly _tag: "@smthrs/platform-node/SandboxUnenforceable"
  readonly platform: NodeJS.Platform
  readonly mechanism: string
  readonly missing: string
  readonly message: string
}

/**
 * Checks for an {@link Unenforceable} refusal.
 *
 * @category guards
 * @since 1.0.0-rc.1
 */
export const isUnenforceable = (value: unknown): value is Unenforceable =>
  typeof value === "object" && value !== null &&
  (value as { readonly _tag?: unknown })._tag === "@smthrs/platform-node/SandboxUnenforceable"

/**
 * Builds an {@link Unenforceable} refusal.
 *
 * @category constructors
 * @since 1.0.0-rc.1
 */
export const unenforceable = (
  platform: NodeJS.Platform,
  mechanism: string,
  missing: string,
  detail: string
): Unenforceable => ({
  _tag: "@smthrs/platform-node/SandboxUnenforceable",
  platform,
  mechanism,
  missing,
  message: `sandbox: the declared confinement cannot be enforced on this ${platform} host: ${detail}.`
})

/**
 * The resolved confinement one spawn runs under. Every path is absolute and
 * canonical.
 *
 * @category models
 * @since 1.0.0-rc.1
 */
export interface Plan {
  readonly mechanism: Exclude<Mechanism, { readonly _tag: "none" }>
  readonly network: Network
  /** Whether host Unix sockets are permitted; defaults to true for build tools. */
  readonly unixSockets?: boolean | undefined
  /** Closed-by-default process and IPC policy for untrusted native commands. */
  readonly strict?: boolean | undefined
  readonly workspaceRoot: string
  readonly cwd: string
  readonly reads: ReadonlyArray<string>
  /**
   * Paths inside a granted directory that the declaration did not cover,
   * re-closed after the grant. Only a mechanism with deny rules (seatbelt)
   * folds; the others keep every declared file as its own entry.
   */
  readonly readDenies: ReadonlyArray<string>
  readonly writes: ReadonlyArray<string>
  readonly readOnly: ReadonlyArray<string>
  /**
   * Where a declared read's bytes actually live when the path reaches them
   * through a symbolic link that leaves the workspace.
   *
   * Bubblewrap needs them because it replaces `/tmp` with a private tmpfs, so
   * a link into the host's `/tmp` (the scratch tree's `node_modules`, which
   * points back at the real workspace) resolves to nothing inside the sandbox.
   * Binding the real location read-only makes the link resolve to the same
   * bytes the host sees, which is what declaring the read asked for. Docker
   * mounts them for the same reason: the image supplies everything outside
   * the workspace, and these paths are on the host. Seatbelt leaves the host
   * filesystem in place but must grant the resolved spelling too. The
   * request's own `externalReads` land here too.
   */
  readonly externalReads: ReadonlyArray<string>
  /** A host directory the run may scribble in; created by the caller, removed after. */
  readonly tmp: string
  readonly uid: number | undefined
  readonly gid: number | undefined
}

const pathSeparator = (platform: NodeJS.Platform): string => platform === "win32" ? ";" : ":"

/** Ambient host environment for runtime lookup and cache locations. */
const ambientEnvironment = (): Readonly<Record<string, string | undefined>> => process.env

/**
 * The real host: platform, `PATH` lookup, and filesystem probes.
 *
 * @category resolution
 * @since 0.1.0
 */
export const host = (env: Readonly<Record<string, string | undefined>> = ambientEnvironment()): Host => {
  const platform = process.platform
  let developerDirectory = env["DEVELOPER_DIR"]
  if (platform === "darwin" && developerDirectory === undefined) {
    try {
      developerDirectory = execFileSync("/usr/bin/xcode-select", ["-p"], { encoding: "utf8", timeout: 2_000 }).trim()
    } catch {
      // A host without Xcode needs no developer-tree grant.
    }
  }
  const entries = (env["PATH"] ?? "").split(pathSeparator(platform)).filter((entry) => entry !== "")
  const extensions = platform === "win32" ? (env["PATHEXT"] ?? ".EXE;.CMD;.BAT").split(";") : [""]
  return {
    platform,
    developerDirectory,
    home: NodeOs.homedir(),
    executable: (name) => {
      if (NodePath.isAbsolute(name)) return isExecutable(name) ? name : undefined
      for (const entry of entries) {
        for (const extension of extensions) {
          const candidate = NodePath.join(entry, name + extension)
          if (isExecutable(candidate)) return candidate
        }
      }
      return undefined
    },
    exists: (path) => NodeFs.existsSync(path),
    isSymbolicLink,
    isDirectory: (path) => {
      try {
        return NodeFs.statSync(path).isDirectory()
      } catch {
        return false
      }
    },
    entries: (directory) => {
      try {
        return NodeFs.readdirSync(directory)
      } catch {
        return undefined
      }
    },
    realpath: (path) => {
      try {
        return NodeFs.realpathSync(path)
      } catch {
        return undefined
      }
    },
    uid: typeof process.getuid === "function" ? process.getuid() : undefined,
    gid: typeof process.getgid === "function" ? process.getgid() : undefined
  }
}

const isExecutable = (path: string): boolean => {
  try {
    NodeFs.accessSync(path, NodeFs.constants.X_OK)
    return NodeFs.statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * Selects the mechanism a request runs under on a host.
 *
 * A docker selection is honored when `docker` is on `PATH` and refused
 * otherwise; a bubblewrap selection is refused off Linux. With no selection
 * the platform decides: bubblewrap on Linux, seatbelt on macOS, and a refusal
 * elsewhere, because Windows has no user-level process sandbox and Docker
 * needs an image only the caller can name.
 *
 * @category resolution
 * @since 1.0.0-rc.1
 */
export const select = (
  request: Pick<Request, "network" | "mechanism">,
  hostFacts: Host
): Exclude<Mechanism, { readonly _tag: "none" }> | Unenforceable => {
  const declared = request.mechanism
  const platform = hostFacts.platform
  if (declared !== undefined && declared._tag === "docker") {
    const executable = hostFacts.executable("docker")
    if (executable === undefined) {
      return unenforceable(platform, "docker", "docker", "a docker mechanism is selected but docker is not on PATH")
    }
    return { _tag: "docker", executable, image: declared.image }
  }
  if (declared !== undefined && platform !== "linux") {
    return unenforceable(
      platform,
      "bubblewrap",
      "linux",
      "bubblewrap is selected but runs only on Linux; on macOS the seatbelt mechanism is selected when no mechanism is named"
    )
  }
  if (platform === "linux") {
    const executable = hostFacts.executable("bwrap")
    if (executable === undefined) {
      return unenforceable(platform, "bubblewrap", "bwrap", "bwrap is not on PATH (install the bubblewrap package)")
    }
    if (request.network === "loopback") {
      return unenforceable(
        platform,
        "bubblewrap",
        "network: true",
        "bubblewrap cannot expose only the host loopback interface: sharing that interface also grants full host networking; " +
          "open the whole network to opt into that access"
      )
    }
    return { _tag: "bubblewrap", executable }
  }
  if (platform === "darwin") {
    const executable = hostFacts.executable("/usr/bin/sandbox-exec")
    if (executable === undefined) {
      return unenforceable(platform, "seatbelt", "/usr/bin/sandbox-exec", "/usr/bin/sandbox-exec is missing")
    }
    return { _tag: "seatbelt", executable }
  }
  return unenforceable(
    platform,
    "docker",
    "docker image",
    `${platform} has no process sandbox of its own; select a docker mechanism with an image`
  )
}

const toPosix = (path: string): string => path.split(NodePath.sep).join("/")

/**
 * The path with the symlinks of its existing ancestors resolved. A path that
 * does not exist yet keeps its unresolved tail below the deepest ancestor
 * that does; a path with no existing ancestor is returned as given.
 */
const realized = (path: string): string => {
  let head = path
  const tail: Array<string> = []
  while (head !== NodePath.dirname(head)) {
    try {
      const real = NodeFs.realpathSync(head)
      return tail.length === 0 ? real : NodePath.join(real, ...tail)
    } catch {
      tail.unshift(NodePath.basename(head))
      head = NodePath.dirname(head)
    }
  }
  return path
}

const insideRoot = (root: string, candidate: string): boolean => {
  const relative = NodePath.relative(root, candidate)
  return relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${NodePath.sep}`) && !NodePath.isAbsolute(relative))
}

/** Unlike exists/stat, lstat sees dangling links and does not follow them. */
const isSymbolicLink = (path: string): boolean => {
  try {
    return NodeFs.lstatSync(path).isSymbolicLink()
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false
    throw cause
  }
}

/** Check each component, including existing ancestors of a missing output. */
const safeWrite = (root: string, path: string, hostFacts: Host): boolean => {
  if (!insideRoot(root, path)) return false
  try {
    const realpath = hostFacts.realpath ?? NodeFs.realpathSync
    const link = hostFacts.isSymbolicLink ?? isSymbolicLink
    if (realpath(root) !== root) return false
    let current = root
    for (const component of NodePath.relative(root, path).split(NodePath.sep).filter(Boolean)) {
      current = NodePath.join(current, component)
      if (link(current)) return false
      if (hostFacts.exists(current) && realpath(current) !== current) return false
    }
    return true
  } catch {
    return false
  }
}

const unsafeWrite = (platform: NodeJS.Platform, mechanism: string, path: string): Unenforceable =>
  unenforceable(
    platform,
    mechanism,
    "canonical workspace write path",
    `write path ${path} has a symbolic link, an unresolved ancestor, or leaves the canonical workspace`
  )

/**
 * Rechecks write grants before directory creation and before rendering. Throws
 * an {@link Unenforceable} refusal if a path changed since planning. Callers
 * must keep the workspace stable until the operating system consumes mounts.
 *
 * @category resolution
 * @since 0.1.0
 */
export const validateWrites = (confinement: Plan, hostFacts: Host = host()): void => {
  for (const write of confinement.writes) {
    if (!safeWrite(confinement.workspaceRoot, write, hostFacts)) {
      throw unsafeWrite(hostFacts.platform, confinement.mechanism._tag, write)
    }
  }
}

/**
 * Folds a declared file set into directories plus the entries to re-close.
 *
 * The seatbelt compiler caps one rule's data at 64 KiB, so a workspace with a
 * few thousand declared sources cannot be granted file by file. Deepest
 * first, a directory in which at least as many entries are covered as not is
 * granted whole, and its uncovered entries are listed for a deny rule that
 * follows the grant. The result admits exactly the declared set plus the
 * granted directories' future entries. A directory whose uncovered entry
 * still holds a covered path deeper down is never folded over that entry,
 * the workspace root is never folded, and a host that cannot list a
 * directory leaves its files as they were. Covered means a declared read, a
 * declared write, or the private tmp.
 */
const fold = (
  root: string,
  declared: ReadonlyArray<string>,
  alsoCovered: ReadonlyArray<string>,
  hostFacts: Host
): { readonly reads: ReadonlyArray<string>; readonly denies: ReadonlyArray<string> } => {
  const entries = hostFacts.entries
  if (entries === undefined) return { reads: declared, denies: [] }
  const covered = new Set([...declared, ...alsoCovered])
  const candidates = new Set<string>()
  for (const path of declared) {
    let current = NodePath.dirname(path)
    while (insideRoot(root, current) && current !== root && !candidates.has(current)) {
      candidates.add(current)
      current = NodePath.dirname(current)
    }
  }
  // An undeclared directory on the way down to a covered write or read-only
  // path is not a candidate, so nothing else would stop its parent being
  // folded over it. The deny that follows the grant names the directory, and
  // because later rules win in SBPL it closes reads on the very subtree the
  // plan grants a write to.
  const holdsCovered = new Set<string>()
  for (const path of alsoCovered) {
    let current = NodePath.dirname(path)
    while (insideRoot(root, current) && current !== root && !holdsCovered.has(current)) {
      holdsCovered.add(current)
      current = NodePath.dirname(current)
    }
  }
  const deepestFirst = [...candidates].sort((left, right) => right.length - left.length || (left < right ? -1 : 1))
  const promoted: Array<string> = []
  const denies: Array<string> = []
  for (const directory of deepestFirst) {
    if (covered.has(directory)) continue
    const children = entries(directory)
    if (children === undefined || children.length === 0) continue
    const uncovered: Array<string> = []
    let coveredCount = 0
    let partial = false
    for (const child of children) {
      const path = NodePath.join(directory, child)
      if (covered.has(path)) coveredCount += 1
      else if (candidates.has(path) || holdsCovered.has(path)) partial = true
      else uncovered.push(path)
    }
    if (partial || coveredCount === 0 || coveredCount < uncovered.length) continue
    covered.add(directory)
    promoted.push(directory)
    denies.push(...uncovered)
  }
  return { reads: [...declared, ...promoted], denies }
}

/**
 * Orders paths so that every subtree is contiguous and its root comes first.
 *
 * Comparing on the path plus its separator is what makes that hold: `a/b` and
 * `a/b/c` sort around `a/b.ts`, because `.` precedes `/`, and a plain
 * comparison would then put a sibling between an ancestor and its child.
 */
const bySubtree = (left: string, right: string): number => {
  const leftKey = left + NodePath.sep
  const rightKey = right + NodePath.sep
  return leftKey < rightKey ? -1 : 1
}

/**
 * Drops a path covered by another entry of the same set, keeping the set ordered.
 *
 * One sweep in subtree order carries the shallowest kept ancestor forward,
 * because searching the kept set per path is quadratic in the sibling files a
 * bubblewrap or Docker plan declares one by one.
 */
const collapse = (paths: ReadonlyArray<string>): ReadonlyArray<string> => {
  const unique = [...new Set(paths)]
  const kept = new Set<string>()
  let ancestor: string | undefined
  for (const path of [...unique].sort(bySubtree)) {
    if (ancestor !== undefined && path.startsWith(ancestor + NodePath.sep)) continue
    kept.add(path)
    ancestor = path
  }
  return unique.filter((path) => kept.has(path)).sort((left, right) =>
    left.length - right.length || (left < right ? -1 : 1)
  )
}

/**
 * Resolves a request against a workspace into a {@link Plan}, or refuses.
 *
 * Every relative path is anchored at the canonical workspace root; one that
 * escapes the workspace is dropped, because the sandbox never grants anything
 * outside the tree the key covers. Reads that do not exist are dropped too:
 * bubblewrap cannot bind a missing path, and a declared input that vanished is
 * the executor's measurement failure, not this module's. A write containing
 * any symbolic link below the canonical root is refused, including a missing
 * output below a linked ancestor.
 *
 * @category resolution
 * @since 0.1.0
 */
export const plan = (
  request: Request,
  location: { readonly workspaceRoot: string; readonly cwd: string; readonly tmp: string },
  hostFacts: Host
): Plan | Unenforceable => {
  const selected = select(request, hostFacts)
  if (isUnenforceable(selected)) return selected
  let root: string
  try {
    const canonical = (hostFacts.realpath ?? NodeFs.realpathSync)(location.workspaceRoot)
    if (canonical === undefined) return unsafeWrite(hostFacts.platform, selected._tag, location.workspaceRoot)
    root = canonical
  } catch {
    return unsafeWrite(hostFacts.platform, selected._tag, location.workspaceRoot)
  }
  const anchor = (relative: string): string | undefined => {
    const absolute = NodePath.resolve(root, ...relative.split("/"))
    return insideRoot(root, absolute) ? absolute : undefined
  }
  const declared: Array<string> = []
  // A declared link grants its target as well: native read allowlists and
  // Docker's image filesystem otherwise hide bytes outside the workspace.
  const externalReads: Array<string> = []
  for (const relative of request.reads) {
    const absolute = anchor(relative)
    if (absolute === undefined || !hostFacts.exists(absolute)) continue
    declared.push(absolute)
    const real = hostFacts.realpath?.(absolute)
    if (real !== undefined && real !== absolute && !insideRoot(root, real)) externalReads.push(real)
  }
  for (const path of request.externalReads ?? []) {
    if (!NodePath.isAbsolute(path) || insideRoot(root, path) || !hostFacts.exists(path)) continue
    externalReads.push(hostFacts.realpath?.(path) ?? path)
  }
  // A write names a directory the tool may fill, and is bound as declared
  // whether or not it exists yet: a name is never read as a file, because a
  // dot in `.cargo-home` or `dist.new` would otherwise widen the bind to the
  // parent, and a parent that is the workspace root opens every file in it.
  // A path that is already a file on the host is the one exception, since a
  // file cannot be bound as a writable directory.
  const writes: Array<string> = []
  const add = (absolute: string): Unenforceable | undefined => {
    if (!safeWrite(root, absolute, hostFacts)) return unsafeWrite(hostFacts.platform, selected._tag, absolute)
    writes.push(absolute)
    return undefined
  }
  for (const relative of request.writes) {
    const absolute = anchor(relative)
    if (absolute === undefined) continue
    if (!safeWrite(root, absolute, hostFacts)) return unsafeWrite(hostFacts.platform, selected._tag, absolute)
    const refusal = add(
      hostFacts.exists(absolute) && !hostFacts.isDirectory(absolute) ? NodePath.dirname(absolute) : absolute
    )
    if (refusal !== undefined) return refusal
  }
  // A declared output file opens its parent: a file cannot be bound before it
  // exists, and a tool that writes by rename needs the directory anyway.
  for (const relative of request.writeFiles ?? []) {
    const absolute = anchor(relative)
    if (absolute === undefined) continue
    if (!safeWrite(root, absolute, hostFacts)) return unsafeWrite(hostFacts.platform, selected._tag, absolute)
    const refusal = add(
      hostFacts.exists(absolute) && hostFacts.isDirectory(absolute) ? absolute : NodePath.dirname(absolute)
    )
    if (refusal !== undefined) return refusal
  }
  const readOnly: Array<string> = []
  for (const relative of request.readOnly ?? []) {
    const absolute = anchor(relative)
    if (absolute !== undefined) readOnly.push(absolute)
  }
  const folded = selected._tag === "seatbelt"
    ? fold(root, declared, [...writes, ...readOnly, location.tmp], hostFacts)
    : { reads: declared, denies: [] }
  return {
    mechanism: selected,
    network: request.network,
    unixSockets: request.unixSockets,
    strict: request.strict,
    workspaceRoot: root,
    cwd: location.cwd,
    reads: collapse(folded.reads),
    readDenies: collapse(folded.denies),
    writes: collapse(writes),
    readOnly: collapse(readOnly),
    externalReads: collapse(externalReads),
    tmp: location.tmp,
    uid: hostFacts.uid,
    gid: hostFacts.gid
  }
}

/**
 * Where corepack keeps the package-manager binaries it manages, resolved the
 * way corepack itself resolves it from a host environment.
 *
 * A `pnpm`, `yarn`, or `npm` on `PATH` is often corepack's shim, and the
 * program it execs lives in this directory, not on `PATH`. Redirecting `HOME`
 * and `XDG_CACHE_HOME` to the private tmp moves that directory out from under
 * the shim, which then tries to re-download the package manager from the
 * registry — and a confined run has no network, so every rule that drives the
 * package manager fails with a connect error that names the registry rather
 * than the missing cache.
 */
const corepackHome = (env: Readonly<Record<string, string | undefined>>, home: string): string => {
  const declared = env["COREPACK_HOME"]
  if (declared !== undefined && declared !== "") return declared
  const base = env["XDG_CACHE_HOME"] ?? env["LOCALAPPDATA"] ??
    NodePath.join(home, process.platform === "win32" ? "AppData/Local" : ".cache")
  return NodePath.join(base, "node", "corepack")
}

/**
 * Environment the confined process receives on top of the tool environment:
 * a private temporary directory and home, so nothing a tool caches lands in
 * the real home or the shared temp directory.
 *
 * `COREPACK_HOME` is the one host cache kept: it holds the package-manager
 * program a corepack shim execs, the run may only read it (the mechanisms
 * deny writes outside the workspace), and without it a confined `pnpm` is a
 * shim with nothing to run. A non-default cache location requires an explicit
 * `externalReads` grant; preserving the variable does not grant access.
 *
 * @category rendering
 * @since 0.1.0
 */
export const environment = (
  confinement: Plan,
  hostEnv: Readonly<Record<string, string | undefined>> = ambientEnvironment(),
  hostHome: string = NodeOs.homedir()
): Readonly<Record<string, string>> => {
  const tmp = confinement.mechanism._tag === "seatbelt" ? confinement.tmp : "/tmp"
  const home = NodePath.posix.join(toPosix(tmp), "home")
  return {
    COREPACK_HOME: corepackHome(hostEnv, hostHome),
    HOME: home,
    TMPDIR: tmp,
    TMP: tmp,
    TEMP: tmp,
    XDG_CACHE_HOME: NodePath.posix.join(toPosix(tmp), "cache"),
    XDG_CONFIG_HOME: NodePath.posix.join(toPosix(tmp), "config"),
    XDG_DATA_HOME: NodePath.posix.join(toPosix(tmp), "data"),
    XDG_STATE_HOME: NodePath.posix.join(toPosix(tmp), "state")
  }
}

/** The fixed runtime surface, never the host root, home, PATH, or arbitrary env paths. */
const runtimeReads = (hostFacts: Host): ReadonlyArray<string> => {
  const paths = [
    "/usr",
    "/bin",
    "/sbin",
    "/lib",
    "/lib64",
    "/nix/store",
    "/opt/homebrew",
    "/System/Library",
    "/System/Volumes/Preboot/Cryptexes/OS",
    "/private/var/db/dyld",
    // macOS shell and developer-tool dispatch read these system selectors.
    "/var/select/sh",
    "/private/var/select/sh",
    "/var/select/developer_dir",
    "/private/var/select/developer_dir",
    "/Library/Apple",
    "/Library/Developer",
    "/Applications/Xcode.app/Contents/Developer",
    "/Applications/Xcode.app/Contents/Info.plist",
    "/Applications/Xcode.app/Contents/Frameworks",
    "/Applications/Xcode.app/Contents/SharedFrameworks",
    "/Applications/Xcode.app/Contents/PlugIns",
    "/etc/ld.so.cache",
    "/etc/ld.so.conf",
    "/etc/ld.so.conf.d",
    "/etc/localtime",
    "/etc/ssl",
    "/etc/hosts",
    "/etc/resolv.conf",
    "/etc/nsswitch.conf"
  ]
  const developerDirectory = hostFacts.developerDirectory
  if (
    hostFacts.platform === "darwin" && developerDirectory !== undefined &&
    /^\/Applications\/Xcode[^/]*\.app\/Contents\/Developer$/.test(developerDirectory)
  ) {
    paths.push(developerDirectory)
  }
  if (hostFacts.home !== undefined) paths.push(NodePath.join(hostFacts.home, ".cache/node/corepack"))
  for (const name of ["node", "bun"]) {
    const executable = hostFacts.executable(name)
    if (executable !== undefined) {
      paths.push(executable)
      const real = hostFacts.realpath?.(executable) ?? executable
      paths.push(real)
      // Node distributions keep npm/corepack here; never grant the install
      // prefix itself, which can be the real home for a custom installation.
      paths.push(NodePath.resolve(NodePath.dirname(real), "../lib/node_modules"))
    }
  }
  const present = paths.filter((path) => hostFacts.exists(path))
  return collapse(present.flatMap((path) => [path, hostFacts.realpath?.(path) ?? path]))
}

/** Credentials remain closed even when a workspace or runtime grant contains the home. */
const credentialPaths = (hostFacts: Host): ReadonlyArray<string> => {
  const home = hostFacts.home
  if (home === undefined) return []
  return collapse([
    ".aws",
    ".ssh",
    ".gnupg",
    ".azure",
    ".kube",
    ".docker",
    ".config/gcloud",
    ".config/gh",
    ".npmrc",
    ".netrc",
    ".git-credentials"
  ].flatMap((relative) => {
    const path = NodePath.join(home, relative)
    return [path, hostFacts.realpath?.(path) ?? path]
  }))
}

/**
 * The program a bubblewrap run execs, made reachable inside its empty root.
 *
 * Bubblewrap resolves a bare program name with `execvp` against `PATH` inside
 * the new root, and that root holds only the runtime paths and the declared
 * sets. A package manager installed outside them — pnpm under the
 * `pnpm/action-setup` prefix on a CI runner, a `.bin` link into a
 * `node_modules` tree — is on the host `PATH` and absent from the sandbox, so
 * the run died with `bwrap: execvp pnpm` before the tool started (#3140).
 *
 * A bare name is resolved on the tool's `PATH` (the host's when none is
 * given). A program already inside a granted path is left exactly as spelled,
 * so a multi-call binary keeps the name it dispatches on, and so is one inside
 * the workspace, whose reads only the declaration may open. Otherwise the run
 * execs the program's real file, and the nearest package directory holding it
 * (its `package.json`, at most three levels up, never the home or the root)
 * is bound read-only, because a script like `pnpm.cjs` loads its siblings.
 * With no package directory only the real file is bound. A name that resolves
 * nowhere is left for `execvp` to report.
 */
const launcher = (
  program: string,
  searchPath: string | undefined,
  granted: ReadonlyArray<string>,
  workspaceRoot: string,
  hostFacts: Host
): { readonly program: string; readonly reads: ReadonlyArray<string> } => {
  const unchanged = { program, reads: [] }
  if (program.includes("/") && !NodePath.isAbsolute(program)) return unchanged
  const found = NodePath.isAbsolute(program)
    ? hostFacts.executable(program)
    : searchPath === undefined
    ? hostFacts.executable(program)
    : searchPath.split(":").filter((entry) => NodePath.isAbsolute(entry))
      .map((entry) => hostFacts.executable(NodePath.join(entry, program)))
      .find((candidate) => candidate !== undefined)
  if (found === undefined || granted.some((parent) => insideRoot(parent, found))) return unchanged
  const real = hostFacts.realpath?.(found) ?? found
  if (insideRoot(workspaceRoot, found) || insideRoot(workspaceRoot, real)) return unchanged
  if (granted.some((parent) => insideRoot(parent, real))) return { program: real, reads: [] }
  let directory = NodePath.dirname(real)
  for (let level = 0; level < 3; level++) {
    if (directory === NodePath.dirname(directory) || directory === hostFacts.home) break
    if (hostFacts.exists(NodePath.join(directory, "package.json"))) return { program: real, reads: [directory] }
    directory = NodePath.dirname(directory)
  }
  return { program: real, reads: [real] }
}

/**
 * The bubblewrap argv for a plan.
 *
 * Order matters: bubblewrap applies operations in argument order, so the
 * empty root goes first, runtime paths are bound, the workspace tmpfs shadows
 * any broad runtime grant, declared paths are bound on top, and re-closed
 * subtrees are bound read-only over their writable parents. The tmpfs is
 * remounted read-only last so an undeclared write
 * under the workspace fails with `EROFS` instead of vanishing into the tmpfs.
 *
 * @category rendering
 * @since 0.1.0
 */
export const bubblewrap = (
  confinement: Plan,
  argv: ReadonlyArray<string>,
  hostFacts: Host = host(),
  searchPath?: string | undefined
): ReadonlyArray<string> => {
  if (confinement.mechanism._tag !== "bubblewrap") throw new Error("bubblewrap argv needs a bubblewrap plan")
  validateWrites(confinement, hostFacts)
  const home = "/tmp/home"
  const out: Array<string> = [
    confinement.mechanism.executable,
    "--tmpfs",
    "/"
  ]
  const runtime = runtimeReads(hostFacts)
  for (const read of runtime) out.push("--ro-bind", read, read)
  out.push(
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    "--tmpfs",
    "/tmp",
    "--dir",
    home,
    "--dir",
    "/tmp/cache",
    "--tmpfs",
    confinement.workspaceRoot,
    "--dir",
    confinement.cwd
  )
  // The target of a link that leaves the workspace is bound first, so the
  // link a declared read then binds resolves to the same bytes the host sees
  // even when `/tmp` above the target has just become a private tmpfs.
  for (const real of confinement.externalReads) out.push("--ro-bind", real, real)
  const [program, ...args] = argv
  const launch = program === undefined ? undefined : launcher(
    program,
    searchPath,
    [...runtime, ...confinement.reads, ...confinement.writes, ...confinement.externalReads],
    confinement.workspaceRoot,
    hostFacts
  )
  for (const read of launch?.reads ?? []) out.push("--ro-bind", read, read)
  for (const read of confinement.reads) out.push("--ro-bind", read, read)
  for (const write of confinement.writes) out.push("--bind", write, write)
  for (const closed of confinement.readOnly) {
    if (confinement.writes.some((write) => closed === write || closed.startsWith(write + NodePath.sep))) {
      out.push("--ro-bind-try", closed, closed)
    }
  }
  const granted = [
    ...runtime,
    ...(launch?.reads ?? []),
    ...confinement.reads,
    ...confinement.writes,
    ...confinement.externalReads
  ]
  for (const path of credentialPaths(hostFacts)) {
    if (!hostFacts.exists(path) || !granted.some((parent) => insideRoot(parent, path))) continue
    // An explicit external read can name a credential or a file inside it.
    // Mask first, then restore only those explicit paths below the mask.
    if (confinement.externalReads.some((parent) => insideRoot(parent, path))) continue
    const directory = hostFacts.isDirectory(path)
    if (directory) out.push("--tmpfs", path)
    else out.push("--ro-bind", "/dev/null", path)
    for (const read of confinement.externalReads) {
      if (insideRoot(path, read)) out.push("--ro-bind", read, read)
    }
    if (directory) out.push("--remount-ro", path)
  }
  // `--remount-ro` acts on the mount at that exact path. When the root itself
  // is a declared write (a declared output file at the top level opens its
  // parent), that mount is the writable bind, and remounting it would deny
  // every write the declaration admitted; the tmpfs it replaced needs no
  // re-closing.
  if (!confinement.writes.includes(confinement.workspaceRoot)) out.push("--remount-ro", confinement.workspaceRoot)
  out.push("--remount-ro", "/")
  out.push("--chdir", confinement.cwd, "--unshare-all", "--new-session", "--die-with-parent")
  // Bubblewrap cannot expose only the host loopback interface. Planning
  // refuses that posture on Linux, so only an explicit full-network opening
  // reaches `--share-net` here.
  if (confinement.network === "loopback") {
    throw new Error("bubblewrap cannot render loopback-only networking")
  }
  if (confinement.network === "open") out.push("--share-net")
  out.push("--", ...(launch === undefined ? argv : [launch.program, ...args]))
  return out
}

/** Escapes one string for a seatbelt profile literal. */
const sbpl = (value: string): string => `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`

/** Every directory from the workspace root down to the parent of each path. */
const ancestors = (root: string, paths: ReadonlyArray<string>): ReadonlyArray<string> => {
  const found = new Set<string>([root])
  for (const path of paths) {
    let current = NodePath.dirname(path)
    while (current.length >= root.length && current !== NodePath.dirname(current)) {
      found.add(current)
      if (current === root) break
      current = NodePath.dirname(current)
    }
  }
  return [...found].sort()
}

/**
 * The seatbelt profile for a plan.
 *
 * File reads start closed, then enumerated runtime paths and declared sets
 * are opened. The workspace is re-closed before its grants so a workspace
 * under a runtime root does not inherit the broad runtime grant. Credentials
 * are re-closed before explicit external reads, which can opt into them.
 *
 * @category rendering
 * @since 0.1.0
 */
export const seatbelt = (confinement: Plan, hostFacts: Host = host()): string => {
  if (confinement.mechanism._tag !== "seatbelt") throw new Error("a seatbelt profile needs a seatbelt plan")
  validateWrites(confinement, hostFacts)
  const lines: Array<string> = ["(version 1)", confinement.strict === true ? "(deny default)" : "(allow default)"]
  if (confinement.strict === true) {
    // No Mach lookup, Apple Events or LaunchServices grants: work must stay
    // in descendants inheriting this sandbox, never delegated to a host daemon.
    lines.push(
      "(allow process-exec)",
      "(allow process-fork)",
      "(allow signal (target same-sandbox))",
      "(allow process-info* (target same-sandbox))",
      "(allow sysctl-read (sysctl-name-prefix \"hw.\") (sysctl-name-prefix \"machdep.cpu.\") (sysctl-name \"kern.argmax\") (sysctl-name \"kern.hostname\") (sysctl-name \"kern.maxfilesperproc\") (sysctl-name \"kern.maxproc\") (sysctl-name \"kern.osproductversion\") (sysctl-name \"kern.osrelease\") (sysctl-name \"kern.ostype\") (sysctl-name \"kern.osversion\") (sysctl-name \"kern.secure_kernel\") (sysctl-name \"kern.usrstack64\") (sysctl-name \"kern.version\") (sysctl-name \"sysctl.proc_cputype\") (sysctl-name \"vm.loadavg\"))",
      "(allow mach-host*)"
    )
    if (confinement.network === "open") lines.push("(allow network*)")
  }
  if (confinement.network !== "open") {
    lines.push("(deny network*)")
    if (confinement.unixSockets !== false) lines.push("(allow network* (local unix-socket))")
    if (confinement.network === "loopback") {
      lines.push(
        "(allow network-bind (local ip \"localhost:*\"))",
        "(allow network-inbound (local ip \"localhost:*\"))",
        "(allow network-outbound (remote ip \"localhost:*\"))"
      )
    }
  }
  if (confinement.network === "open" && confinement.unixSockets === false) {
    lines.push("(deny network* (local unix-socket))")
    if (confinement.strict === true) {
      // Darwin resolves DNS through this trusted endpoint. Full IP authority
      // permits DNS only; other host daemons remain closed, including Mach IPC.
      lines.push("(allow network-outbound (literal \"/private/var/run/mDNSResponder\"))")
    }
  }
  const writable = [...confinement.writes, confinement.tmp]
  lines.push(
    "(deny file-write*)",
    `(allow file-write* ${confinement.strict === true ? "(literal \"/dev/null\")" : "(subpath \"/dev\")"} ${
      writable.map((path) => `(subpath ${sbpl(path)})`).join(" ")
    })`
  )
  if (confinement.readOnly.length > 0) {
    lines.push(`(deny file-write* ${confinement.readOnly.map((path) => `(subpath ${sbpl(path)})`).join(" ")})`)
  }
  lines.push(
    "(deny file-read*)",
    confinement.strict === true
      ? "(allow file-read* (literal \"/\") (literal \"/dev/null\") (literal \"/dev/zero\") (literal \"/dev/random\") (literal \"/dev/urandom\"))"
      : "(allow file-read* (literal \"/\") (subpath \"/dev\"))",
    // macOS's system aliases need readlink access before a shell can execute
    // an admitted file through them. Literal grants expose the links only;
    // their target directories still cannot be listed or read wholesale.
    "(allow file-read* (literal \"/tmp\") (literal \"/var\") (literal \"/etc\"))"
  )
  const runtime = runtimeReads(hostFacts)
  if (runtime.length > 0) lines.push(`(allow file-read* ${runtime.map((path) => `(subpath ${sbpl(path)})`).join(" ")})`)
  const readable = [...confinement.reads, ...confinement.writes, confinement.tmp]
  // Node realpath walks every ancestor, including parents outside the
  // workspace. Grant only their metadata, without listing or reading bytes.
  const traversable = ancestors("/", [...runtime, ...readable, ...confinement.externalReads])
    .filter((path) => !insideRoot(confinement.workspaceRoot, path))
  lines.push(`(allow file-read-metadata ${traversable.map((path) => `(literal ${sbpl(path)})`).join(" ")})`)
  const listable = ancestors(
    confinement.workspaceRoot,
    readable.filter((path) => insideRoot(confinement.workspaceRoot, path))
  )
  lines.push(
    `(deny file-read* (subpath ${sbpl(confinement.workspaceRoot)}))`
  )
  if (confinement.strict === true) {
    const metadata = [
      ...new Set([
        ...listable,
        ...ancestors(confinement.workspaceRoot, [confinement.cwd]),
        confinement.cwd
      ])
    ].sort()
    lines.push(`(allow file-read-metadata ${metadata.map((path) => `(literal ${sbpl(path)})`).join(" ")})`)
  } else {
    lines.push(`(allow file-read-metadata (subpath ${sbpl(confinement.workspaceRoot)}))`)
  }
  lines.push(
    `(allow file-read* ${
      [
        ...(confinement.strict === true ? [] : listable.map((path) => `(literal ${sbpl(path)})`)),
        ...readable.map((path) => `(subpath ${sbpl(path)})`)
      ].join(" ")
    })`
  )
  if (confinement.readDenies.length > 0) {
    lines.push(`(deny file-read* ${confinement.readDenies.map((path) => `(subpath ${sbpl(path)})`).join(" ")})`)
  }
  const credentials = credentialPaths(hostFacts)
  if (credentials.length > 0) {
    lines.push(`(deny file-read* ${credentials.map((path) => `(subpath ${sbpl(path)})`).join(" ")})`)
    if (confinement.strict === true) {
      lines.push(`(deny file-write* ${credentials.map((path) => `(subpath ${sbpl(path)})`).join(" ")})`)
    }
  }
  if (confinement.externalReads.length > 0) {
    lines.push(`(allow file-read* ${confinement.externalReads.map((path) => `(subpath ${sbpl(path)})`).join(" ")})`)
  }
  return lines.join("")
}

/**
 * One `key=value` field of a `docker run --mount` value. Docker parses the
 * value as one CSV record, so a field containing a comma, a quote, or a line
 * break is wrapped in quotes with inner quotes doubled; any other field keeps
 * its plain spelling.
 */
const mountField = (key: string, value: string): string => {
  const field = `${key}=${value}`
  return /[",\r\n]/.test(field) ? `"${field.replaceAll("\"", "\"\"")}"` : field
}

const bindMount = (path: string, readonly: boolean): string =>
  ["type=bind", mountField("src", path), mountField("dst", toPosix(path)), ...(readonly ? ["readonly"] : [])].join(",")

/**
 * The `docker run` argv for a plan. Paths keep their host spelling inside the
 * container so an argv that names workspace paths works unchanged; the image
 * supplies everything outside the workspace.
 *
 * @category rendering
 * @since 0.1.0
 */
export const docker = (
  confinement: Plan,
  argv: ReadonlyArray<string>,
  env: Readonly<Record<string, string>>,
  hostFacts: Host = host(),
  containerName: string = `smithers-${randomUUID()}`
): ReadonlyArray<string> => {
  if (confinement.mechanism._tag !== "docker") throw new Error("docker argv needs a docker plan")
  validateWrites(confinement, hostFacts)
  const out: Array<string> = [
    confinement.mechanism.executable,
    "run",
    "--rm",
    "--init",
    "--name",
    containerName,
    "--read-only",
    "--tmpfs",
    "/tmp:rw,exec",
    "--network",
    confinement.network === "open" ? "bridge" : "none",
    "--workdir",
    toPosix(confinement.cwd)
  ]
  if (confinement.uid !== undefined && confinement.gid !== undefined) {
    out.push("--user", `${confinement.uid}:${confinement.gid}`)
  }
  for (const real of confinement.externalReads) out.push("--mount", bindMount(real, true))
  for (const read of confinement.reads) out.push("--mount", bindMount(read, true))
  for (const write of confinement.writes) out.push("--mount", bindMount(write, false))
  for (const closed of confinement.readOnly) {
    if (confinement.writes.some((write) => closed === write || closed.startsWith(write + NodePath.sep))) {
      out.push("--mount", bindMount(closed, true))
    }
  }
  for (const [name, value] of Object.entries(env).sort(([left], [right]) => (left < right ? -1 : 1))) {
    if (name === "PATH" || name === "HOME") continue
    out.push("--env", `${name}=${value}`)
  }
  out.push("--env", "HOME=/tmp/home", confinement.mechanism.image, ...argv)
  return out
}

/**
 * Wraps a tool argv in the plan's mechanism and reports the environment the
 * wrapper needs the child to carry. Docker runs also return the unique
 * container name the caller must forcibly remove when the client scope closes.
 *
 * @category rendering
 * @since 0.1.0
 */
export const wrap = (
  confinement: Plan,
  argv: ReadonlyArray<string>,
  env: Readonly<Record<string, string>>,
  hostFacts: Host = host()
): {
  readonly argv: ReadonlyArray<string>
  readonly env: Readonly<Record<string, string>>
  readonly containerName?: string
} => {
  const extra = environment(confinement)
  switch (confinement.mechanism._tag) {
    case "bubblewrap":
      return { argv: bubblewrap(confinement, argv, hostFacts, env["PATH"]), env: extra }
    case "seatbelt": {
      const profile = seatbelt(confinement, hostFacts)
      return { argv: [confinement.mechanism.executable, "-p", profile, ...argv], env: extra }
    }
    case "docker": {
      const containerName = `smithers-${randomUUID()}`
      return { argv: docker(confinement, argv, { ...env, ...extra }, hostFacts, containerName), env: {}, containerName }
    }
  }
}

/**
 * Each pattern names the path a tool complained about and whether the text
 * proves the denied operation was a write. A confined process never sees an
 * undeclared path: seatbelt answers EPERM, bubblewrap answers ENOENT because
 * the path was never mounted, and dash spells that "Directory nonexistent".
 */
const denialPatterns: ReadonlyArray<{ readonly pattern: RegExp; readonly write: boolean }> = [
  { pattern: /\b(?:EACCES|EPERM|ENOENT)\b[^'"\n]*['"]([^'"\n]+)['"]/g, write: false },
  { pattern: /\bEROFS\b[^'"\n]*['"]([^'"\n]+)['"]/g, write: true },
  {
    pattern:
      /(?:^|[\s:])((?:\/|\.{0,2}\/?)[^\s:'"]+): (?:Operation not permitted|Permission denied|No such file or directory|Directory nonexistent|Not a directory)/gm,
    write: false
  },
  { pattern: /(?:^|[\s:])((?:\/|\.{0,2}\/?)[^\s:'"]+): Read-only file system/gm, write: true },
  {
    pattern:
      /(?:Operation not permitted|Permission denied|No such file or directory|Directory nonexistent)[^\n]*?[:\s]['"]?((?:\/|[A-Za-z]:\\)[^'"\s:]+)/g,
    write: false
  },
  { pattern: /Read-only file system[^\n]*?[:\s]['"]?((?:\/|[A-Za-z]:\\)[^'"\s:]+)/g, write: true },
  {
    pattern: /cannot (?:create|write|touch|mkdir|remove) (?:directory )?['"]?((?:\/|[A-Za-z]:\\|\.{0,2}\/?)[^'":\s]+)/g,
    write: true
  },
  { pattern: /cannot (?:open|access|stat|read) ['"]?((?:\/|[A-Za-z]:\\|\.{0,2}\/?)[^'":\s]+)/g, write: false }
]

/**
 * Names, from a failed tool's own output, the paths it touched outside the
 * declared set. The sandbox denies at the kernel, so the only witness is the
 * tool's error text; this reads it back and says which side of the boundary
 * each path fell on.
 *
 * @category diagnostics
 * @since 0.1.0
 */
export const diagnose = (confinement: Plan, text: string): string | undefined => {
  // Path → whether the text proved the denied operation was a write.
  const named = new Map<string, boolean>()
  for (const { pattern, write } of denialPatterns) {
    for (const match of text.matchAll(pattern)) {
      const raw = match[1]!
      const absolute = NodePath.isAbsolute(raw) ? raw : NodePath.resolve(confinement.cwd, raw)
      if (insideRoot(confinement.workspaceRoot, absolute)) named.set(absolute, (named.get(absolute) ?? false) || write)
      if (named.size >= 5) break
    }
    if (named.size >= 5) break
  }
  if (named.size === 0) return undefined
  const covered = (path: string, set: ReadonlyArray<string>): boolean =>
    set.some((entry) => entry === path || path.startsWith(entry + NodePath.sep))
  const lines = [...named.entries()].sort(([left], [right]) => (left < right ? -1 : 1)).map(([path, write]) => {
    const relative = toPosix(NodePath.relative(confinement.workspaceRoot, path))
    // A path that lexically sits in the workspace can still leave it through
    // a symlink in an existing ancestor; the declaration covers the tree, not
    // wherever a link points.
    const real = realized(path)
    const escapes = !insideRoot(confinement.workspaceRoot, real)
    const readable = !escapes && (covered(path, confinement.reads) || covered(path, confinement.writes))
    const writable = !escapes && covered(path, confinement.writes) && !covered(path, confinement.readOnly)
    if (escapes) {
      return `sandbox: ${relative} resolves to ${real}, outside the declared ${write ? "write" : "read"} set`
    }
    if (write) {
      return writable
        ? `sandbox: ${relative} was denied inside the declared set`
        : `sandbox: ${relative} is outside the declared write set`
    }
    if (!readable) return `sandbox: ${relative} is outside the declared read set`
    if (!writable) return `sandbox: ${relative} is outside the declared write set`
    return `sandbox: ${relative} was denied inside the declared set`
  })
  return `${lines.join("\n")}\nsandbox: ${confinement.mechanism._tag}, network ${confinement.network}, ` +
    `${confinement.reads.length} read path(s), ${confinement.writes.length} write path(s)`
}
