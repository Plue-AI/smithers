/**
 * Shared workspace cache and input models.
 *
 * @since 0.1.0
 */

import type * as Input from "@smthrs/targets/Input"
import * as RemoteCache from "@smthrs/targets/RemoteCache"
import type * as NodeFs from "node:fs"
import * as Fs from "node:fs/promises"
import * as NodePath from "node:path"

/**
 * A file and the digest that contributes to target key material.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type FileDigest = Input.FileDigest

/**
 * One declared matcher after discovery and content measurement.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface ExpandedInput {
  readonly declaration: Input.Declared
  readonly files: ReadonlyArray<FileDigest>
  readonly digest: string
}

/**
 * The only target declaration filename.
 *
 * @category discovery
 * @since 0.1.0
 */
export const declarationFileNames = ["PACKAGE.ts"] as const
/**
 * Which credentials a workspace declared for its remote cache.
 *
 * A remote build cache has untrusted readers and trusted writers: every job
 * pulls, and only a job whose inputs were reviewed may publish. `split` is
 * that posture. `shared` is one credential doing both jobs, which is what a
 * deployment that has not separated its secrets yet has, and it is a tag
 * rather than an absent field so no caller can read the single-credential case
 * as an oversight.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type ResolvedRemoteCacheCredentials =
  | { readonly _tag: "shared"; readonly tokenEnv: string }
  | { readonly _tag: "split"; readonly readTokenEnv: string; readonly writeTokenEnv: string }
  /** Reads use a committed public read token; writes read `writeTokenEnv`. */
  | { readonly _tag: "public"; readonly publicReadToken: string; readonly writeTokenEnv: string }
  /**
   * No declaration: the endpoint was discovered from the Smithers Cloud remote. Reads
   * go out anonymously (a public repository answers them) unless
   * `writeTokenEnv` holds a credential, which then serves both directions.
   */
  | { readonly _tag: "anonymous"; readonly writeTokenEnv: string }

/**
 * The remote-cache settings one command runs under.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface ResolvedRemoteCache {
  readonly endpoint: string
  readonly credentials: ResolvedRemoteCacheCredentials
  /** Present when the endpoint came from the workspace's Smithers Cloud remote, not a declaration. */
  readonly discovered?: DiscoveredSmithersCloudRepository | undefined
}

/**
 * A repository found on a Smithers Cloud remote of the workspace.
 *
 * @category models
 * @since 0.1.0
 */
export interface DiscoveredSmithersCloudRepository {
  readonly repo: string
  readonly host: string
}

/**
 * Every environment variable name a resolved credential reads.
 *
 * Callers withhold these from child processes, so both halves of a split have
 * to be listed. Missing one is how a target got to read the credential it was
 * never meant to hold.
 *
 * @category discovery
 * @since 0.1.0
 * @slop
 */
export const credentialEnvNames = (
  credentials: ResolvedRemoteCacheCredentials
): ReadonlyArray<string> => {
  switch (credentials._tag) {
    case "shared":
      return [credentials.tokenEnv]
    case "split":
      return [credentials.readTokenEnv, credentials.writeTokenEnv]
    case "public":
    case "anonymous":
      return [credentials.writeTokenEnv]
  }
}

/**
 * The host environment a child process may see.
 *
 * Withholds the default cache names and every name the workspace declares for
 * a remote-cache credential. Planning spawns host tools over workspace-controlled
 * input (`forge config`, `go env`, `nix develop`, `docker info`), and a
 * `Repo.Target` spawns this CLI in a child repository that evaluates its own
 * declarations. Every such spawn draws from this record rather than from
 * `process.env`, so a declared token never reaches code it was not meant for.
 *
 * @category discovery
 * @since 0.1.0
 */
export const withheldEnvironment = (
  environment: Readonly<Record<string, string | undefined>>,
  credentials: ResolvedRemoteCacheCredentials | undefined
): Readonly<Record<string, string | undefined>> => {
  const key = (name: string): string => process.platform === "win32" ? name.toUpperCase() : name
  const withheld = new Set(
    [
      "SMITHERS_CACHE_URL",
      "SMITHERS_CACHE_TOKEN",
      ...(credentials === undefined ? [] : credentialEnvNames(credentials))
    ].map(key)
  )
  const scrubbed: Record<string, string | undefined> = {}
  for (const [name, value] of Object.entries(environment)) {
    if (!withheld.has(key(name))) scrubbed[name] = value
  }
  return scrubbed
}

/**
 * A resolved remote cache with the readers that fetch its credentials.
 *
 * The readers are invoked only while an outbound request is being built, so a
 * credential is never held in a field anything can serialize. A shared
 * declaration returns the same value from both.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface RemoteCacheAccess extends ResolvedRemoteCache {
  readonly readToken: () => string | undefined
  readonly writeToken: () => string | undefined
  /**
   * The trust domain this process publishes into, or undefined for the
   * trusted one. Host state: which domain a job runs in is a property of the
   * job, not of the workspace it builds.
   */
  readonly publishNamespace: string | undefined
}

/**
 * The hosts whose remotes identify a Smithers Cloud repository. `SMITHERS_CLOUD_HOSTS`
 * (comma separated) adds a self-hosted deployment's hosts.
 *
 * @category discovery
 * @since 0.1.0
 */
export const defaultSmithersCloudHosts: ReadonlyArray<string> = [
  "jjhub.tech",
  "api.jjhub.tech",
  "ssh.jjhub.tech",
  "git.jjhub.tech"
]

const maximumGitConfigBytes = 256 * 1024
const remoteSection = /^\s*\[remote\s+"([^"]+)"\]\s*$/
const urlLine = /^\s*url\s*=\s*(.+?)\s*$/
const scpLike = /^(?:[^@\s]+@)?([^:/\s]+):([^\s]+)$/

const smithersCloudHostsOf = (environment: Readonly<Record<string, string | undefined>>): ReadonlySet<string> => {
  const extra = (environment["SMITHERS_CLOUD_HOSTS"] ?? "").split(",").map((host) => host.trim().toLowerCase()).filter(
    (host) => host !== ""
  )
  return new Set([...defaultSmithersCloudHosts, ...extra])
}

/**
 * The cache endpoint of a repository on Smithers Cloud. `SMITHERS_CLOUD_API_URL`
 * overrides the API base for a self-hosted deployment.
 *
 * @category discovery
 * @since 0.1.0
 */
export const smithersCloudCacheEndpoint = (
  repo: string,
  environment: Readonly<Record<string, string | undefined>>
): string => {
  const base = RemoteCache.normalizeEndpoint(
    environment["SMITHERS_CLOUD_API_URL"] ?? RemoteCache.defaultSmithersCloudApiBase
  )
  const [owner, name] = repo.split("/") as [string, string]
  return `${base}/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/build-cache`
}

/**
 * Parses one remote URL into `owner/name` when its host is a Smithers Cloud host.
 *
 * @category discovery
 * @since 0.1.0
 */
export const parseSmithersCloudRemote = (
  url: string,
  hosts: ReadonlySet<string> = new Set(defaultSmithersCloudHosts)
): DiscoveredSmithersCloudRepository | undefined => {
  const trimmed = url.trim()
  let host = ""
  let path = ""
  try {
    const parsed = new URL(trimmed)
    host = parsed.hostname.toLowerCase()
    path = parsed.pathname
  } catch {
    // Not a URL at all, so the SCP-style fallback below is the only reading.
  }
  // A userless SCP remote such as `jjhub.tech:alice/repo.git` is a URL to the
  // WHATWG parser: the host becomes an opaque scheme and the hostname is empty.
  // The fallback therefore reruns on an empty host, not only on a parse failure.
  if (host === "") {
    const match = scpLike.exec(trimmed)
    if (match === null) return undefined
    host = match[1]!.toLowerCase()
    path = match[2]!
  }
  if (!hosts.has(host)) return undefined
  const segments = path.replace(/^\/+/, "").replace(/\.git$/, "").replace(/\/+$/, "").split("/")
  if (segments.length !== 2 || segments[0] === "" || segments[1] === "") return undefined
  return { repo: `${segments[0]}/${segments[1]}`, host }
}

const readRemoteUrls = async (
  path: string
): Promise<ReadonlyArray<{ readonly name: string; readonly url: string }>> => {
  let stats: NodeFs.Stats
  try {
    stats = await Fs.lstat(path)
  } catch {
    return []
  }
  if (!stats.isFile() || stats.size > maximumGitConfigBytes) return []
  let text: string
  try {
    text = await Fs.readFile(path, "utf8")
  } catch {
    return []
  }
  const remotes: Array<{ readonly name: string; readonly url: string }> = []
  let current: string | undefined
  for (const line of text.split(/\r?\n/)) {
    const section = remoteSection.exec(line)
    if (section !== null) {
      current = section[1]
      continue
    }
    if (/^\s*\[/.test(line)) {
      current = undefined
      continue
    }
    const url = urlLine.exec(line)
    if (current !== undefined && url !== null) remotes.push({ name: current, url: url[1]! })
  }
  return remotes
}

/** Upper bound for a `.git` gitdir pointer file or a `commondir` file. */
const maximumGitPointerBytes = 4096

/** Reads one small regular (non-symlink) pointer file, trimmed; undefined otherwise. */
const readGitPointer = async (path: string): Promise<string | undefined> => {
  try {
    const stats = await Fs.lstat(path)
    if (!stats.isFile() || stats.size > maximumGitPointerBytes) return undefined
    const text = (await Fs.readFile(path, "utf8")).trim()
    return text === "" || text.includes("\n") ? undefined : text
  } catch {
    return undefined
  }
}

/**
 * The Git config holding a checkout's remotes. An ordinary checkout keeps it
 * at `.git/config`. A linked worktree's `.git` is a `gitdir: <path>` file; its
 * remotes live in the common directory its `commondir` file names (or in the
 * gitdir itself when there is none).
 */
const gitConfigPath = async (root: string): Promise<string> => {
  const dotGit = NodePath.join(root, ".git")
  const pointer = await readGitPointer(dotGit)
  const match = pointer === undefined ? null : /^gitdir:\s*(.+)$/.exec(pointer)
  if (match === null) return NodePath.join(dotGit, "config")
  const gitDirectory = NodePath.resolve(root, match[1]!)
  const common = await readGitPointer(NodePath.join(gitDirectory, "commondir"))
  return NodePath.join(common === undefined ? gitDirectory : NodePath.resolve(gitDirectory, common), "config")
}

/**
 * Finds the Smithers Cloud repository a workspace's `origin` (or any) remote points
 * at, reading the colocated Git config first (`.git/config`, or a linked
 * worktree's common-directory config) and the jj git backend's config second.
 * Never spawns git or jj.
 *
 * @category discovery
 * @since 0.1.0
 */
export const discoverSmithersCloudRepository = async (
  root: string,
  environment: Readonly<Record<string, string | undefined>>
): Promise<DiscoveredSmithersCloudRepository | undefined> => {
  const hosts = smithersCloudHostsOf(environment)
  for (const path of [await gitConfigPath(root), NodePath.join(root, ".jj/repo/store/git/config")]) {
    const remotes = await readRemoteUrls(path)
    const ordered = [...remotes.filter((r) => r.name === "origin"), ...remotes.filter((r) => r.name !== "origin")]
    for (const remote of ordered) {
      const found = parseSmithersCloudRemote(remote.url, hosts)
      if (found !== undefined) return found
    }
  }
  return undefined
}

/**
 * Validates the `SMITHERS_CACHE_URL` override.
 *
 * A declaration must be HTTPS. The process override may also be plain HTTP
 * on loopback, which is how a cache running on the same host (the self-hosted
 * module, or a local API) is reached; `Cache.ts` admits exactly the same set,
 * so the override cannot pass discovery and then be refused when the store
 * opens.
 *
 * @category discovery
 * @since 0.1.0
 */
export const normalizeOverrideEndpoint = (value: string): string => {
  let parsed: URL
  try {
    parsed = new URL(value.trim())
  } catch {
    return RemoteCache.normalizeEndpoint(value)
  }
  const loopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]"
  if (parsed.protocol !== "http:" || !loopback) return RemoteCache.normalizeEndpoint(value)
  if (parsed.username !== "" || parsed.password !== "") {
    throw new Error("remote cache endpoint must not contain credentials")
  }
  if (parsed.search !== "" || parsed.hash !== "") {
    throw new Error("remote cache endpoint must not contain a query or fragment")
  }
  return parsed.href.replace(/\/+$/, "")
}

/**
 * Resolves a remote cache from an already-read declaration.
 *
 * Workspace execution reads its declaration from WORKSPACE.ts; target
 * mode reads the same declaration out of `WORKSPACE.ts`'s `S.Cache({ remote })`
 * field, which `WorkspaceDeclaration.CacheDeclaration` schema-validates as a
 * real `RemoteCache`. Both then need the identical endpoint-override and
 * credential-name precedence, so it lives here rather than being reimplemented
 * once per mode.
 *
 * @category discovery
 * @since 0.1.0
 */
export const remoteCacheOf = (
  declaration: RemoteCache.RemoteCache | undefined,
  endpointOverride?: string | undefined
): ResolvedRemoteCache | undefined => {
  const credentials = (): ResolvedRemoteCacheCredentials => {
    const read = declaration?.token.env ?? RemoteCache.defaultTokenEnv
    const write = declaration?.write?.env
    if (declaration?.publicReadToken !== undefined) {
      return {
        _tag: "public",
        publicReadToken: declaration.publicReadToken,
        writeTokenEnv: RemoteCache.normalizeTokenEnv(write ?? read)
      }
    }
    // The endpoint may be overridden per host; which credentials the workspace
    // declared may not, so the split survives an override.
    return write === undefined
      ? { _tag: "shared", tokenEnv: RemoteCache.normalizeTokenEnv(read) }
      : {
        _tag: "split",
        readTokenEnv: RemoteCache.normalizeTokenEnv(read),
        writeTokenEnv: RemoteCache.normalizeTokenEnv(write)
      }
  }
  const override = endpointOverride?.trim()
  if (override !== undefined && override !== "") {
    return { endpoint: normalizeOverrideEndpoint(override), credentials: credentials() }
  }
  if (declaration === undefined) return undefined
  return { endpoint: RemoteCache.normalizeEndpoint(declaration.endpoint), credentials: credentials() }
}
