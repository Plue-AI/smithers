/**
 * The Node a host runs on: the first executable at least `.node-version`,
 * looked for where Node is installed rather than where this process came
 * from, so `install-service` pins a Node that outlives the shell it ran in.
 *
 * Order: `SMITHERS_ORG_NODE`; `PATH`; fnm, Volta and nvm installations
 * (newest first); Homebrew. An fnm per-shell link on `PATH` is followed to its
 * installation, which stays when the shell ends.
 */
import { spawnSync } from "node:child_process"
import { existsSync, readdirSync, realpathSync } from "node:fs"
import { delimiter, join } from "node:path"
import { atLeast } from "./version.ts"

/** One Node executable and the version it reports. */
export interface Found {
  readonly path: string
  readonly version: string
}

/** What resolution found: the Node to use, or the one-line command that installs one. */
export type Resolution =
  | { readonly _tag: "Found"; readonly node: Found }
  | { readonly _tag: "Missing"; readonly newest: Found | undefined; readonly fix: string }

/** How resolution reaches the machine; a test replaces it. */
export interface System {
  readonly exists: (path: string) => boolean
  readonly list: (directory: string) => ReadonlyArray<string>
  readonly version: (node: string) => string | undefined
  readonly real: (path: string) => string
  /** Homebrew's Node locations, newest formula first. */
  readonly homebrew: ReadonlyArray<string>
}

export const system: System = {
  exists: existsSync,
  list: (directory) => {
    try {
      return readdirSync(directory)
    } catch {
      return []
    }
  },
  version: (node) => {
    const result = spawnSync(node, ["--version"], { encoding: "utf8", timeout: 10_000 })
    const text = result.status === 0 ? result.stdout.trim() : ""
    return /^v\d+\.\d+\.\d+/.test(text) ? text.slice(1) : undefined
  },
  real: realpathSync,
  homebrew: [
    "/opt/homebrew/opt/node@26/bin/node",
    "/opt/homebrew/bin/node",
    "/usr/local/opt/node@26/bin/node",
    "/usr/local/bin/node"
  ]
}

const newestFirst = (names: ReadonlyArray<string>) =>
  names.filter((name) => /^v?\d+\.\d+\.\d+$/.test(name)).sort((left, right) =>
    atLeast(left, right) ? (atLeast(right, left) ? 0 : -1) : 1
  )

/** fnm, Volta and nvm installation directories under `home`, by the managers' own variables. */
const managers = (env: Readonly<Record<string, string | undefined>>, home: string) => ({
  fnm: [env.FNM_DIR, join(home, ".local/share/fnm"), join(home, "Library/Application Support/fnm")]
    .filter((dir): dir is string => dir !== undefined && dir !== ""),
  volta: env.VOLTA_HOME ?? join(home, ".volta"),
  nvm: env.NVM_DIR ?? join(home, ".nvm")
})

/** Every Node executable to try, in order, each once. */
export const candidates = (
  env: Readonly<Record<string, string | undefined>>,
  home: string,
  on: System = system
): ReadonlyArray<string> => {
  const found: Array<string> = []
  const add = (path: string) => {
    if (on.exists(path) && !found.includes(path)) found.push(path)
  }
  if ((env.SMITHERS_ORG_NODE ?? "") !== "") add(env.SMITHERS_ORG_NODE!)
  for (const directory of (env.PATH ?? "").split(delimiter)) {
    if (directory === "") continue
    const node = join(directory, "node")
    if (!on.exists(node)) continue
    add(node.includes("fnm_multishells") ? on.real(node) : node)
  }
  const { fnm, nvm, volta } = managers(env, home)
  for (const dir of fnm) {
    for (const name of newestFirst(on.list(join(dir, "node-versions")))) {
      add(join(dir, "node-versions", name, "installation/bin/node"))
    }
  }
  for (const name of newestFirst(on.list(join(volta, "tools/image/node")))) {
    add(join(volta, "tools/image/node", name, "bin/node"))
  }
  for (const name of newestFirst(on.list(join(nvm, "versions/node")))) add(join(nvm, "versions/node", name, "bin/node"))
  for (const path of on.homebrew) add(path)
  return found
}

/** The one command that installs Node `wanted` with a manager this machine has. */
export const installFix = (
  env: Readonly<Record<string, string | undefined>>,
  home: string,
  wanted: string,
  on: System = system
): string => {
  const { fnm, nvm, volta } = managers(env, home)
  if (fnm.some((dir) => on.exists(dir))) return `fnm install ${wanted}`
  if (on.exists(volta)) return `volta install node@${wanted}`
  if (on.exists(nvm)) return `nvm install ${wanted}`
  if (on.exists("/opt/homebrew/bin/brew") || on.exists("/usr/local/bin/brew")) return "brew install node"
  return `curl -fsSL https://fnm.vercel.app/install | bash && fnm install ${wanted}`
}

/** The first Node at least `wanted`, or the command that installs one. */
export const resolve = (
  env: Readonly<Record<string, string | undefined>>,
  home: string,
  wanted: string,
  on: System = system
): Resolution => {
  let newest: Found | undefined
  for (const path of candidates(env, home, on)) {
    const version = on.version(path)
    if (version === undefined) continue
    if (atLeast(version, wanted)) return { _tag: "Found", node: { path, version } }
    if (newest === undefined || atLeast(version, newest.version)) newest = { path, version }
  }
  return { _tag: "Missing", newest, fix: installFix(env, home, wanted, on) }
}
