/**
 * The machine, as a value.
 *
 * Detection reads three kinds of host fact — a directory listing, a file, and
 * a `--version` probe — and nothing else. Naming them as one injectable
 * interface is what lets the whole detection table be asserted over fixtures
 * instead of over whatever happens to be installed on the developer's laptop.
 *
 * @since 0.1.0
 */

// Type-only: the ids are read as `typeof HARNESS_IDS`, so the built JS
// carries no runtime import of the contract package.
import type { HARNESS_IDS } from "@smthrs/rpc/LocalApp"
import { hostPath } from "./internal/Read.ts"

/**
 * One coding-agent CLI the contract knows about.
 *
 * The ids are `HARNESS_IDS` in `@smthrs/rpc/LocalApp`, which is the wire
 * contract; this package never invents one.
 *
 * @category models
 * @since 0.1.0
 */
export type HarnessId = (typeof HARNESS_IDS)[number]

/**
 * Every host read detection performs.
 *
 * A caller supplies one implementation per runtime: a Bun or Node adapter
 * over `node:fs` and a child process, or a record of fixtures in a test.
 *
 * @category models
 * @since 0.1.0
 */
export interface HarnessHost {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly home: string
  readonly platform: string
  /** Entries of a directory, or [] when it does not exist. */
  readonly listDir: (dir: string) => ReadonlyArray<string>
  /** True for an existing regular file (a symlink to one counts). */
  readonly isFile: (path: string) => boolean
  /** File text, or null when it cannot be read. */
  readonly readText: (path: string) => string | null
  /** `<binary> --version`, or null when it fails or exceeds the host's timeout. */
  readonly version: (binary: string) => Promise<string | null>
}

/**
 * The explicit candidate dirs, in order, before PATH.
 *
 * A Finder launch inherits the launchd PATH, which holds none of the places a
 * developer's CLIs actually live, so the candidate dirs are searched first.
 * `~/.opencode/bin` is where the opencode installer puts its binary; the rest
 * follow the contract.
 * Path formatting follows `host.platform` when supplied; callers omitting it
 * retain the native path convention.
 *
 * @category detection
 * @since 0.1.0
 */
export const harnessCandidateDirs = (
  host: Pick<HarnessHost, "home" | "listDir"> & Partial<Pick<HarnessHost, "platform">>
): ReadonlyArray<string> => {
  const { join } = hostPath(host)
  const nvmRoot = join(host.home, ".nvm", "versions", "node")
  const nvm = [...host.listDir(nvmRoot)]
    .map((entry) => ({ entry, version: NODE_DIR.exec(entry) }))
    .filter((row): row is { entry: string; version: RegExpExecArray } => row.version !== null)
    .sort((left, right) => compareSemver(right.version, left.version))
    .map((row) => join(nvmRoot, row.entry, "bin"))
  return [
    join(host.home, ".local", "bin"),
    join(host.home, ".bun", "bin"),
    // Homebrew and the POSIX local prefix do not exist on Windows.
    ...(host.platform === "win32" ? [] : ["/opt/homebrew/bin", "/usr/local/bin"]),
    ...nvm,
    join(host.home, ".cargo", "bin"),
    join(host.home, ".opencode", "bin")
  ]
}

/** A node version directory: `v24.1.0`, or the same without the `v`. */
const NODE_DIR = /^v?(\d+)\.(\d+)\.(\d+)/

/**
 * Newest first, by the three captured numbers. Both arguments are matches of
 * {@link NODE_DIR}, so there is no "unparseable" case to invent an order for.
 */
const compareSemver = (left: RegExpExecArray, right: RegExpExecArray): number => {
  for (let index = 1; index <= 3; index += 1) {
    const difference = Number(left[index]) - Number(right[index])
    if (difference !== 0) return difference
  }
  return 0
}

/**
 * The first candidate dir, then PATH entry, that holds the binary.
 *
 * A relative PATH entry (`.`, `node_modules/.bin`) is skipped: it resolves
 * against the process cwd, which may be a cloned repository that plants a
 * `claude` for detection to probe and the app to launch.
 *
 * @category detection
 * @since 0.1.0
 */
export const findBinary = (name: string, host: HarnessHost): string | null => {
  const { delimiter, isAbsolute, join } = hostPath(host)
  const windows = host.platform === "win32"
  // Windows environment names are case-insensitive, so a copied env may
  // spell them `Path` or `PathExt`.
  const variable = (key: string): string | undefined =>
    host.env[key] ?? (windows
      ? Object.entries(host.env).find(([candidate, value]) => value !== undefined && candidate.toUpperCase() === key)
        ?.[1]
      : undefined)
  const fromPath = (variable("PATH") ?? "").split(delimiter).filter((dir) => isAbsolute(dir))
  // A Windows command is a file with an executable extension: npm installs
  // `claude.cmd`, native installers `codex.exe`. A bare `claude` beside them
  // is a POSIX shell shim Windows cannot launch.
  const names = windows
    ? (variable("PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";").filter((extension) => extension !== "").map((
      extension
    ) => `${name}${extension.toLowerCase()}`)
    : [name]
  for (const dir of [...harnessCandidateDirs(host), ...fromPath]) {
    for (const file of names) {
      const candidate = join(dir, file)
      if (host.isFile(candidate)) return candidate
    }
  }
  return null
}
