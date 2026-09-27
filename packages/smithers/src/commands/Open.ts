/**
 * `smthrs open [dir]` and `smthrs .`: open a checkout's repository in the
 * Smithers app (#1964).
 *
 * The checkout's git remote names `owner/repo` (origin first; a jj checkout
 * without a git directory answers `jj git remote list`). The repository page
 * `/<owner>/<repo>` is that repository's workspace chat, whose first message
 * is the repository homepage. The first match wins:
 *
 * 1. macOS with Smithers.app installed: `smithers://open/<owner>/<repo>`
 *    (apps/app/src/bun/DeepLink.ts) through LaunchServices.
 * 2. The smithers checkout itself (its remote names smithersai/smithers and
 *    it carries apps/app): the dev build, `pnpm --dir apps/app dev`, handed
 *    the same link as `SMITHERS_OPEN_URL`, with the terminal inherited. The
 *    remote check keeps `smthrs .` in any other checkout from running that
 *    checkout's package scripts.
 * 3. Otherwise the web page, `https://smithers.sh/<owner>/<repo>`, printed.
 *
 * @since 1.0.0
 */

import { spawn, spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import * as CliError from "../CliError.ts"

/**
 * The Smithers Cloud web origin.
 *
 * @category constants
 * @since 1.0.0
 */
export const webOrigin = "https://smithers.sh"

/**
 * The repository whose checkout runs the app's dev build.
 *
 * @category constants
 * @since 1.0.0
 */
export const smithersRepo = "smithersai/smithers"

const SEGMENT = /^[\w.-]+$/

const segmentOk = (segment: string): boolean => SEGMENT.test(segment) && segment !== "." && segment !== ".."

/**
 * The `owner/repo` a git remote URL names, or null. Accepts scp-like
 * (`git@host:owner/repo.git`), `ssh://`, `git://` and `http(s)://` spellings
 * with exactly two path segments; the host is not interpreted, since
 * a GitHub remote and its Smithers Cloud mirror share the name.
 *
 * @category parsing
 * @since 1.0.0
 */
export const repoFromRemote = (remote: string, allowedHosts?: ReadonlySet<string>): string | null => {
  const trimmed = remote.trim()
  let path: string
  const scp = /^[\w.-]+@[\w.-]+:(?!\/)(.+)$/.exec(trimmed)
  if (scp !== null) {
    if (
      allowedHosts && !allowedHosts.has(trimmed.slice(trimmed.indexOf("@") + 1, trimmed.indexOf(":")).toLowerCase())
    ) return null
    path = scp[1]!
  } else {
    let parsed: URL
    try {
      parsed = new URL(trimmed)
    } catch {
      return null
    }
    if (!["https:", "http:", "ssh:", "git:", "git+ssh:"].includes(parsed.protocol)) return null
    if (allowedHosts && !allowedHosts.has(parsed.hostname.toLowerCase())) return null
    if (parsed.search !== "" || parsed.hash !== "") return null
    path = parsed.pathname
  }
  const segments = path.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/, "").split("/")
  if (segments.length !== 2) return null
  const [owner, repo] = segments as [string, string]
  return segmentOk(owner) && segmentOk(repo) ? `${owner}/${repo}` : null
}

/**
 * The deep link the installed app answers for a repository.
 *
 * @category constructors
 * @since 1.0.0
 */
export const deepLink = (repo: string): string => `smithers://open/${repo}`

/**
 * The repository's page on smithers.sh.
 *
 * @category constructors
 * @since 1.0.0
 */
export const webUrl = (repo: string): string => `${webOrigin}/${repo}`

/**
 * What `open` did.
 *
 * @category models
 * @since 1.0.0
 */
export interface Opened {
  readonly repo: string
  readonly opened: "app" | "dev" | "web"
  readonly url: string
}

/**
 * The host doors `open` uses, injectable so tests never launch anything.
 *
 * @category models
 * @since 1.0.0
 */
export interface Host {
  readonly platform: NodeJS.Platform
  readonly home: string
  readonly exists: (path: string) => boolean
  /** Runs a command to completion and answers its stdout, or null when it failed. */
  readonly read: (command: string, args: ReadonlyArray<string>, cwd: string) => string | null
  /** Runs a command with the terminal inherited and answers its exit status. */
  readonly launch: (
    command: string,
    args: ReadonlyArray<string>,
    options: { readonly cwd: string; readonly env?: Readonly<Record<string, string>> }
  ) => Promise<number>
}

/**
 * The process host.
 *
 * @category constructors
 * @since 1.0.0
 */
export const processHost = (environment: Readonly<Record<string, string | undefined>>): Host => ({
  platform: process.platform,
  home: homedir(),
  exists: existsSync,
  read: (command, args, cwd) => {
    const result = spawnSync(command, [...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
    return result.status === 0 ? result.stdout : null
  },
  launch: (command, args, options) =>
    new Promise((resolvePromise, reject) => {
      const child = spawn(command, [...args], {
        cwd: options.cwd,
        env: { ...environment, ...options.env },
        stdio: "inherit"
      })
      child.once("error", reject)
      child.once("exit", (code) => resolvePromise(code ?? 1))
    })
})

const firstRemote = (host: Host, directory: string): string | null => {
  const origin = host.read("git", ["remote", "get-url", "origin"], directory)?.trim()
  if (origin) return origin
  const listed = host.read("git", ["remote", "-v"], directory) || host.read("jj", ["git", "remote", "list"], directory)
  for (const line of (listed ?? "").split("\n")) {
    const [name, url] = line.trim().split(/\s+/)
    if (name === "origin" && url !== undefined) return url
  }
  const first = (listed ?? "").split("\n").map((line) => line.trim().split(/\s+/)[1]).find((url) => url !== undefined)
  return first ?? null
}

/**
 * The repository a checkout's remote names.
 *
 * @category constructors
 * @since 1.0.0
 */
export const resolveRepo = (host: Host, directory: string, allowedHosts?: ReadonlySet<string>): string => {
  if (allowedHosts) {
    const remotes = [
      host.read("jj", ["git", "remote", "list"], directory),
      host.read("git", ["remote", "-v"], directory)
    ]
      .flatMap((output) => (output ?? "").split("\n").map((line) => line.trim().split(/\s+/)))
      .sort(([a], [b]) => Number(b === "origin") - Number(a === "origin"))
    for (const [, remote] of remotes) {
      const repo = remote && repoFromRemote(remote, allowedHosts)
      if (repo) return repo
    }
    throw new CliError.UsageError({ message: "Could not determine repository. Use --repo OWNER/REPO." })
  }
  const remote = firstRemote(host, directory)
  if (remote === null) {
    throw new CliError.UsageError({ message: `${directory} has no git remote naming owner/repo.` })
  }
  const repo = repoFromRemote(remote)
  if (repo === null) throw new CliError.UsageError({ message: `The remote ${remote} does not name owner/repo.` })
  return repo
}

/** The installed bundle, by path: a dev build registered under the same identifier must not answer. */
const installedApp = (host: Host): string | undefined =>
  host.platform === "darwin"
    ? [join("/Applications", "Smithers.app"), join(host.home, "Applications", "Smithers.app")].find(host.exists)
    : undefined

/** The checkout root when it is the smithers repository, whose app the dev build runs. */
const smithersCheckout = (host: Host, directory: string, repo: string): string | null => {
  if (repo.toLowerCase() !== smithersRepo) return null
  const root = host.read("git", ["rev-parse", "--show-toplevel"], directory)?.trim() ||
    host.read("jj", ["root"], directory)?.trim()
  return root && host.exists(join(root, "apps", "app", "electrobun.config.ts")) ? root : null
}

/**
 * Opens the checkout's repository in the app, the dev build, or prints the web page.
 *
 * @category constructors
 * @since 1.0.0
 */
export const open = async (host: Host, directory: string | undefined): Promise<Opened> => {
  const cwd = resolve(directory ?? ".")
  if (!host.exists(cwd)) throw new CliError.UsageError({ message: `${cwd} does not exist.` })
  const repo = resolveRepo(host, cwd)
  const link = deepLink(repo)
  const app = installedApp(host)
  if (app !== undefined) {
    const status = await host.launch("open", ["-a", app, link], { cwd })
    if (status === 0) return { repo, opened: "app", url: link }
  }
  const checkout = smithersCheckout(host, cwd, repo)
  if (checkout !== null) {
    const status = await host.launch("pnpm", ["--dir", join(checkout, "apps", "app"), "dev"], {
      cwd: checkout,
      env: { SMITHERS_OPEN_URL: link }
    })
    if (status !== 0) throw new CliError.UnsupportedError({ message: `The dev build exited with status ${status}.` })
    return { repo, opened: "dev", url: link }
  }
  return { repo, opened: "web", url: webUrl(repo) }
}
