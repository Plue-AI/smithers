/**
 * The environment contract of the `smthrs` command line.
 *
 * rc.0 reads a small, closed set of `SMITHERS_*` names.
 *
 * Names outside {@link names} are not read by rc.0. In particular the 0.x
 * `SMITHERS_HOME`, `SMITHERS_TOKEN`, and `SMITHERS_WORKFLOW_*` families are
 * gone: `~/.smithers` is not a runtime input, and
 * `SMITHERS_TOKEN` belongs to a different product's CLI.
 *
 * @since 1.0.0
 */

/**
 * A canonical environment name read by the CLI.
 *
 * @category models
 * @since 1.0.0
 */
export interface Name {
  readonly name: string
  readonly purpose: string
}

const entry = (suffix: string, purpose: string): Name => ({ name: `SMITHERS_${suffix}`, purpose })

/**
 * Every environment variable rc.0 reads.
 *
 * @category constants
 * @since 1.0.0
 */
export const names: ReadonlyArray<Name> = [
  entry("AUDIENCE", "Consumer override: auto, human, or agent; presentation only, never authority"),
  entry("REMOTE", "Control-plane base URL; the environment form of --remote"),
  entry("API_KEY", "Bearer credential; the environment form of --credential"),
  entry("CREDENTIAL_KEY", "Base64 32-byte host encryption key for stored credentials"),
  entry("CACHE_URL", "Remote target-cache endpoint captured before workspace evaluation"),
  entry("CACHE_TOKEN", "Remote target-cache credential, removed from declaration environments"),
  entry("CACHE_NAMESPACE", "Target-cache trust domain for result publication"),
  entry("MCP_CONFIG", "Path to the --mcp-config server array"),
  entry("OPENAI_AUTH", "`api-key` or `chatgpt`, selecting how openai seats authenticate"),
  entry("TEST_COMMAND", "The command the `test` flow runs"),
  entry("TEST_CONTAINER", "The container the `test` flow runs in"),
  entry("TEST_CWD", "The repository's path inside that container"),
  entry("TEST_TIMEOUT_MS", "Wall-clock budget for one `test` invocation"),
  entry("BASH_CONTAINER", "The one container `bash` may reach; host commands and host file flows are refused"),
  entry("ASKS", "`park` (the default) or `refuse`: whether an in-run `ask` waits for an operator or fails at once"),
  entry("BACKEND", "Database backend: `sqlite` or `postgres`"),
  entry("MEMORY_DB", "Path of a separate SQLite file for the memory store, shared across runs that name it"),
  entry("SUPERVISOR_STANCE", "`careful` (the default) or `paranoid`, the static stance a judged run is taught"),
  entry("BUG_ENDPOINT", "Where `smthrs bug` posts its report"),
  entry("JJ_PATH", "Explicit path to the jj binary"),
  entry("DETACHED_ADMISSION_TIMEOUT_MS", "How long `up -d` waits for the detached run's admission line"),
  entry("INSIDE_RUN", "Set on an agent process by the engine; keeps its 0.x meaning"),
  entry("RUN_ID", "The run an agent process belongs to; keeps its 0.x meaning")
]

/**
 * The environment shape this module reads. `process.env` satisfies it.
 *
 * @category models
 * @since 1.0.0
 */
export type Source = Readonly<Record<string, string | undefined>>

/**
 * Reads the directory the process was started in by deliberate host choice.
 *
 * Using this gives up the project root resolved for an invocation. It belongs
 * only in explicit process-backed service defaults; project operations take
 * their configured root as an argument.
 *
 * @category getters
 * @since 1.0.0
 */
export const ambientWorkingDirectory = (): string => process.cwd()

/**
 * Reads one canonical name.
 *
 * An empty value is treated exactly like an unset one, the convention every
 * credential variable in this CLI already follows: an exported-but-blank
 * variable is how a shell spells "not configured".
 *
 * @category getters
 * @since 1.0.0
 */
export const read = (environment: Source, name: string): string | undefined => {
  const direct = environment[name]
  return direct === undefined || direct === "" ? undefined : direct
}

/**
 * Reads one canonical name as a positive integer, ignoring anything else.
 *
 * @category getters
 * @since 1.0.0
 */
export const readInteger = (environment: Source, name: string): number | undefined => {
  const raw = read(environment, name)
  if (raw === undefined) return undefined
  // The whole value has to be digits. `Number.parseInt` stops at the first
  // character it cannot read, so it answered 30 for `30abc` and for `30s`,
  // which is the opposite of the "ignore anything else" this function
  // promises: a typo silently became a plausible-looking budget.
  if (!/^\d+$/.test(raw)) return undefined
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

/**
 * The database-backend refusal sentence.
 *
 * The contract fixes the whole sentence, so this is a constant rather than a
 * template. An interpolated value cannot be asserted verbatim, and the two
 * clauses an interpolated version drops are the ones an operator needs: which
 * backends are unavailable, and what to do next. Repeating the value they
 * typed is neither.
 *
 * @category constants
 * @since 1.0.0
 */
export const unsupportedBackendMessage: string =
  "unsupported_database: choose sqlite or postgres. PostgreSQL requires SMITHERS_POSTGRES_URL or DATABASE_URL. See https://smithers.sh/migration/1.0#databases."

/**
 * The database-backend refusal.
 *
 * `sqlite`, `postgres`, and an unset value are supported; every other
 * value names a backend that does not ship, and saying so is the whole
 * contract — a silent fallback to SQLite would run a project's flows against
 * a database it did not ask for.
 *
 * @category getters
 * @since 1.0.0
 */
export const unsupportedBackend = (value: string | undefined): string | undefined =>
  value === undefined || value === "" || (value === "sqlite" || value === "postgres")
    ? undefined
    : unsupportedBackendMessage
