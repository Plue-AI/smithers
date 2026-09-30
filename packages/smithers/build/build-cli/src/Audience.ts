/**
 * Side-effect-free consumer detection and terminal presentation policy.
 * Detection is a UX hint, never an authentication or approval boundary.
 * @since 1.0.0
 */

/**
 * Explicit consumer selection, independent of output encoding.
 * @category models
 * @since 1.0.0
 */
export type Mode = "auto" | "human" | "agent"

/**
 * Inputs are injectable so tests and embedded CLIs never change process globals.
 * @category models
 * @since 1.0.0
 */
export interface Options {
  readonly env?: Readonly<Record<string, string | undefined>> | undefined
  readonly stdin?: boolean | undefined
  readonly stdout?: boolean | undefined
  readonly stderr?: boolean | undefined
  readonly audience?: Mode | undefined
  readonly mcp?: boolean | undefined
  readonly formatExplicit?: boolean | undefined
  readonly silent?: boolean | undefined
  readonly verbose?: boolean | undefined
}

/**
 * One policy for results, progress, and prompting; evidence never contains env values.
 * @category models
 * @since 1.0.0
 */
export interface Policy {
  readonly audience: "human" | "agent"
  readonly source: "mcp" | "override" | "harness" | "ci" | "terminal" | "pipe"
  readonly harnesses: ReadonlyArray<string>
  readonly structured: boolean
  readonly progress: "silent" | "plain" | "live"
  readonly interactive: boolean
}

/**
 * Audited shell markers, not installed applications, credentials, or config paths.
 * See docs/reference/agent-detection.md for evidence and unsupported harnesses.
 * @category models
 * @since 1.0.0
 */
export interface Marker {
  readonly harness: string
  readonly variable: string
  readonly equals?: string | undefined
}

/**
 * Extend this registry only with a verified child-process marker and a source.
 * @category constants
 * @since 1.0.0
 */
export const markers: ReadonlyArray<Marker> = [
  { harness: "claude-code", variable: "CLAUDECODE", equals: "1" },
  { harness: "opencode", variable: "OPENCODE", equals: "1" },
  { harness: "codex", variable: "CODEX_THREAD_ID" },
  { harness: "codex", variable: "CODEX_SESSION_ID" },
  { harness: "codex", variable: "CODEX_CI", equals: "1" },
  { harness: "gemini-cli", variable: "GEMINI_CLI", equals: "1" },
  { harness: "cursor", variable: "CURSOR_AGENT" },
  { harness: "copilot-cli", variable: "COPILOT_CLI", equals: "1" },
  { harness: "cline", variable: "CLINE_ACTIVE", equals: "true" },
  { harness: "roo-code", variable: "ROO_ACTIVE", equals: "true" },
  { harness: "qwen-code", variable: "QWEN_CODE", equals: "1" },
  { harness: "pi", variable: "PI_SESSION_ID" },
  { harness: "openclaw", variable: "OPENCLAW_SHELL", equals: "exec" },
  { harness: "goose", variable: "GOOSE_TERMINAL", equals: "1" },
  { harness: "goose", variable: "AGENT", equals: "goose" },
  { harness: "amp", variable: "AGENT", equals: "amp" },
  { harness: "amp", variable: "AMP_CURRENT_THREAD_ID" },
  { harness: "smithers", variable: "SMITHERS_INSIDE_RUN" }
]

const present = (value: string | undefined): boolean => value !== undefined && value.trim() !== ""
const enabled = (value: string | undefined): boolean => present(value) && !/^(?:0|false|no|off)$/i.test(value!.trim())
const mode = (value: string | undefined): Mode | undefined => {
  if (value === undefined || value.trim() === "") return undefined
  if (value === "auto" || value === "human" || value === "agent") return value
  throw new Error("SMITHERS_AUDIENCE must be auto, human, or agent")
}

/**
 * MCP wins; explicit selection wins over harnesses; CI and pipes are conservative fallbacks.
 * Human redirected stdout remains structured while stderr can still show live progress.
 * @category selection
 * @since 1.0.0
 */
export const resolve = (options: Options = {}): Policy => {
  const env = options.env ?? process.env
  const stdin = options.stdin ?? process.stdin.isTTY === true
  const stdout = options.stdout ?? process.stdout.isTTY === true
  const stderr = options.stderr ?? process.stderr.isTTY === true
  const harnesses = [
    ...new Set(
      markers.filter((marker) =>
        marker.equals === undefined ? enabled(env[marker.variable]) : env[marker.variable] === marker.equals
      ).map((marker) => marker.harness)
    )
  ]
  const override = options.audience !== undefined && options.audience !== "auto"
    ? options.audience
    : mode(env["SMITHERS_AUDIENCE"])
  const ci = enabled(env["CI"]) || enabled(env["CONTINUOUS_INTEGRATION"]) || enabled(env["BUILD_NUMBER"]) ||
    enabled(env["GITHUB_ACTIONS"]) || enabled(env["TF_BUILD"])
  const terminal = stderr && (stdin || stdout)
  const source: Policy["source"] = options.mcp ? "mcp" : override === "human" || override === "agent" ?
    "override" :
    harnesses.length > 0
    ? "harness"
    : ci
    ? "ci"
    : terminal
    ? "terminal"
    : "pipe"
  const audience = source === "override" ? override as "human" | "agent" : source === "terminal" ? "human" : "agent"
  const animation = stderr && env["TERM"] !== "dumb" && !ci
  const suppressed = options.silent === true || (audience === "agent" && options.verbose !== true) ||
    options.mcp === true
  return {
    audience,
    source,
    harnesses,
    structured: audience === "agent" || options.formatExplicit === true || !stdout,
    progress: suppressed ? "silent" : audience === "human" && animation ? "live" : "plain",
    interactive: audience === "human" && stdin && animation && !suppressed
  }
}

/**
 * Resolve executable presentation flags without loading a command or touching project files.
 * Incur/Effect still own flag validation. Tokens after -- are application arguments.
 * @category parsing
 * @since 1.0.0
 */
export const fromArguments = (argv: ReadonlyArray<string>, options: Options = {}): Policy => {
  const args = argv.slice(0, argv.indexOf("--") < 0 ? argv.length : argv.indexOf("--"))
  let audience = options.audience
  let silent = options.silent
  let verbose = options.verbose
  let formatExplicit = options.formatExplicit
  let mcp = options.mcp
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg === "--audience" || arg.startsWith("--audience=")) {
      const value = arg === "--audience" ? args[++index] : arg.slice(11)
      if (value === "auto" || value === "human" || value === "agent") audience = value
    }
    if (arg === "--silent" || arg === "--silent=true" || arg === "--quiet") silent = true
    if (arg === "--no-silent" || arg === "--silent=false") silent = false
    if (arg === "--verbose" || arg === "--verbose=true") verbose = true
    if (arg === "--mcp" && options.mcp === undefined) mcp = true
    if (arg === "--json" || arg === "--format" || arg.startsWith("--format=")) formatExplicit = true
  }
  return resolve({ ...options, audience, silent, verbose, formatExplicit, mcp })
}

/**
 * Incur currently derives its agent bit from stdout TTY; select its structured
 * renderer explicitly for harness-owned PTYs, without monkey-patching streams.
 * @category parsing
 * @since 1.0.0
 */
export const incurArguments = (argv: ReadonlyArray<string>, policy: Policy): Array<string> => {
  const fence = argv.indexOf("--")
  const args = fence < 0 ? argv : argv.slice(0, fence)
  if (
    !policy.structured ||
    args.some((arg) =>
      ["--json", "--format", "--mcp", "--help", "-h", "--version", "--schema", "--llms", "--llms-full"].includes(arg) ||
      arg.startsWith("--format=")
    )
  ) return [...argv]
  // Explicit toon is buffered by Incur for generators. Log pulls/follows must
  // remain incremental even when a harness allocated a pseudo-terminal.
  const logs = args.some((arg, index) => arg === "runs" && args[index + 1] === "logs")
  return ["--format", logs ? "jsonl" : "toon", ...argv]
}
