/** The explicit environments repository processes run with (`runSourceProcess` uses `extendEnv: false`). */

const forwarded = [
  "PATH",
  "HOME",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "NODE_EXTRA_CA_CERTS"
] as const

/** What the host's repository processes receive. */
export interface CheckEnvironment {
  /** The allowlist every repository process (setup, inspection, reproduction, checks) runs with. */
  readonly environment: Readonly<Record<string, string>>
  /** The build-cache read credential; only repository checks add it. */
  readonly cache: Readonly<Record<string, string>>
}

/**
 * Consumes the host's provisioned build-cache read credential, removing it from
 * `environment` so model seats and approved shell tools never inherit it. The
 * credential is read-only (the backend never classifies it as a cache writer),
 * so checks replay the repository's remote target results and never publish.
 * It is given under both declared read names: `SMITHERS_CACHE_TOKEN` (a shared
 * remote) and `SMITHERS_CACHE_READ_TOKEN` (a split remote's read side).
 */
export const consume = (environment: Record<string, string | undefined>): CheckEnvironment => {
  const url = environment.SMITHERS_CACHE_URL
  const token = environment.SMITHERS_CACHE_TOKEN
  delete environment.SMITHERS_CACHE_URL
  delete environment.SMITHERS_CACHE_TOKEN
  const allowed: Record<string, string> = {}
  for (const name of forwarded) {
    const value = environment[name]
    if (value !== undefined) allowed[name] = value
  }
  const cache = url !== undefined && url !== "" && token !== undefined && token !== ""
    ? { SMITHERS_CACHE_URL: url, SMITHERS_CACHE_TOKEN: token, SMITHERS_CACHE_READ_TOKEN: token }
    : {}
  return { environment: allowed, cache }
}

/** Repository checks alone read the build cache; setup, inspection and reproduction do not. */
export const repositoryCheckEnvironment = (options: {
  readonly checkEnvironment?: Readonly<Record<string, string>> | undefined
  readonly cacheEnvironment?: Readonly<Record<string, string>> | undefined
}): Readonly<Record<string, string>> | undefined =>
  options.cacheEnvironment === undefined || Object.keys(options.cacheEnvironment).length === 0
    ? options.checkEnvironment
    : { ...options.checkEnvironment, ...options.cacheEnvironment }
