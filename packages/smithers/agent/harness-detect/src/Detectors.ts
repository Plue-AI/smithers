/**
 * The detection table: one row per harness id, in contract order.
 *
 * A dependency-free port of the DETECTORS table in the 0.x
 * `apps/cli/src/agent-detection.js` and the identity readers in
 * `agent-commands/accountIdentity.js`. Every row states three things: the
 * binary name to look for, the argv that launches the CLI interactively, and
 * the sign-in signal read off this user's own files and environment.
 *
 * Nothing here spawns anything. A row's `signal` is a pure function of a
 * {@link HarnessHost}, which is why the table can be asserted without a
 * machine's installs.
 *
 * @since 0.1.0
 */

import type { HarnessModelSpec } from "@smthrs/rpc/AgentRoles"
import type { Harness } from "@smthrs/rpc/LocalApp"
import type { HarnessHost, HarnessId } from "./HarnessHost.ts"
import {
  envDir,
  firstEnv,
  hasNonEmptyStringDeep,
  hostPath,
  nonEmptyString,
  readJson,
  readJsonAny,
  tilde
} from "./internal/Read.ts"

/**
 * A JWT's payload, decoded without verification.
 *
 * The vendor CLI wrote the token into a file only this user can read, and the
 * claims only label the account for the human. Never returns the token
 * itself, and never throws.
 *
 * @category detection
 * @since 0.1.0
 */
export const decodeJwtClaims = (token: unknown): Record<string, unknown> | null => {
  if (typeof token !== "string") return null
  const payload = token.split(".")[1]
  if (payload === undefined || payload === "") return null
  try {
    const parsed: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/**
 * Sign-in state and account, before the binary is considered.
 *
 * @category models
 * @since 0.1.0
 */
export interface Signal {
  readonly status: Exclude<Harness["status"], "unavailable">
  readonly account: Harness["account"]
}

const binaryOnly: Signal = { status: "binary-only", account: null }

/**
 * The Kimi model OpenCode's "Kimi For Coding" provider serves
 * (`opencode models kimi-for-coding`).
 *
 * @category constants
 * @since 0.1.0
 */
export const OPENCODE_KIMI_MODEL = "kimi-for-coding/k3"

/**
 * The Cerebras model OpenCode serves for the fast-ui role
 * (`opencode models cerebras`).
 *
 * @category constants
 * @since 0.1.0
 */
export const OPENCODE_CEREBRAS_MODEL = "cerebras/qwen-3.8-27b"

const apiKey = (name: string): Signal => ({ status: "api-key", account: { label: name } })

/**
 * How a harness takes a model on its command line (docs/workbench-lanes/
 * custom-agents.md): the flag before the model id, the model ids the app has
 * verified for it, and — where the binary has one — the argv that prints one
 * model per line. Every entry is read off the installed binary's own
 * `--help` (2026-09-03); a harness whose help names no model flag has no
 * entry and never runs as a custom agent (NO INVENTION).
 *
 * @category models
 * @since 0.1.0
 */
export interface HarnessModels {
  readonly flag: ReadonlyArray<string>
  readonly suggestions: ReadonlyArray<string>
  /** argv[0] is the binary name; the output is one model id per line. */
  readonly list?: ReadonlyArray<string>
  /** The provider API-key variables the `list` probe needs; no other probe gets a key. */
  readonly listCredentials?: ReadonlyArray<string>
}

/**
 * One row of the detection table.
 *
 * @category models
 * @since 0.1.0
 */
export interface Detector {
  readonly id: HarnessId
  readonly displayName: string
  readonly binary: string
  readonly launch: ReadonlyArray<string>
  readonly models?: HarnessModels
  readonly signal: (host: HarnessHost) => Signal
}

/**
 * Every harness the contract knows, in `HARNESS_IDS` order.
 *
 * @category detection
 * @since 0.1.0
 */
export const DETECTORS: ReadonlyArray<Detector> = [
  {
    id: "claude",
    displayName: "Claude Code",
    binary: "claude",
    launch: ["claude"],
    /* `claude --help`: "--model <model> … an alias for the latest model (e.g. 'fable', 'opus', or 'sonnet') or a model's full name (e.g. 'claude-fable-5')". */
    models: { flag: ["--model"], suggestions: ["claude-fable-5", "fable", "opus", "sonnet"] },
    signal: (host) => {
      const { join } = hostPath(host)
      const configDir = envDir(host, "CLAUDE_CONFIG_DIR", join(host.home, ".claude"))
      // With CLAUDE_CONFIG_DIR set, Claude Code keeps `.claude.json` inside
      // that directory rather than in home.
      const state = (nonEmptyString(host.env.CLAUDE_CONFIG_DIR)
        ? readJson(host, join(configDir, ".claude.json"))
        : null) ?? readJson(host, join(host.home, ".claude.json"))
      const oauth = state?.oauthAccount
      if (typeof oauth === "object" && oauth !== null) {
        const { emailAddress, organizationName } = oauth as Record<string, unknown>
        return {
          status: "signed-in",
          account: {
            ...(nonEmptyString(emailAddress) ? { email: emailAddress } : {}),
            ...(nonEmptyString(organizationName) ? { label: organizationName } : {})
          }
        }
      }
      if (host.isFile(join(configDir, ".credentials.json"))) return { status: "signed-in", account: null }
      const key = firstEnv(host.env, ["ANTHROPIC_API_KEY"])
      return key === undefined ? binaryOnly : apiKey(key)
    }
  },
  {
    id: "codex",
    displayName: "Codex",
    binary: "codex",
    launch: ["codex"],
    /* `codex --help`: "-m, --model <MODEL>"; the ids are the seats apps/tui/src/models.ts routes Codex to. */
    models: { flag: ["-m"], suggestions: ["gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna"] },
    signal: (host) => {
      const { join } = hostPath(host)
      const auth = readJson(host, join(envDir(host, "CODEX_HOME", join(host.home, ".codex")), "auth.json"))
      const tokens = auth?.tokens
      if (typeof tokens === "object" && tokens !== null) {
        const { id_token, access_token } = tokens as Record<string, unknown>
        const claims = decodeJwtClaims(id_token)
        const email = claims?.email
        if (nonEmptyString(email)) return { status: "signed-in", account: { email } }
        if (nonEmptyString(id_token) || nonEmptyString(access_token)) return { status: "signed-in", account: null }
      }
      if (nonEmptyString(auth?.OPENAI_API_KEY)) {
        return { status: "api-key", account: { label: "auth.json OPENAI_API_KEY" } }
      }
      const key = firstEnv(host.env, ["OPENAI_API_KEY"])
      return key === undefined ? binaryOnly : apiKey(key)
    }
  },
  {
    id: "gemini",
    displayName: "Gemini",
    binary: "gemini",
    launch: ["gemini"],
    /* `gemini --help`: "-m, --model  Model [string]"; it names no ids, so the field is free text. */
    models: { flag: ["--model"], suggestions: [] },
    signal: (host) => {
      const { join } = hostPath(host)
      const root = envDir(host, "GEMINI_DIR", join(host.home, ".gemini"))
      if (host.isFile(join(root, "oauth_creds.json"))) {
        const accounts = readJson(host, join(root, "google_accounts.json"))
        const active = accounts?.active
        return { status: "signed-in", account: nonEmptyString(active) ? { email: active } : null }
      }
      const key = firstEnv(host.env, ["GEMINI_API_KEY", "GOOGLE_API_KEY"])
      return key === undefined ? binaryOnly : apiKey(key)
    }
  },
  {
    id: "kimi",
    displayName: "Kimi",
    binary: "kimi",
    launch: ["kimi"],
    /* `kimi --help`: "--model -m TEXT  LLM model to use"; it names no ids. */
    models: { flag: ["--model"], suggestions: [] },
    signal: (host) => {
      const { join } = hostPath(host)
      const share = envDir(host, "KIMI_SHARE_DIR", join(host.home, ".kimi"))
      if (host.isFile(join(share, "credentials", "kimi-code.json"))) {
        return { status: "signed-in", account: { label: "kimi-code" } }
      }
      return binaryOnly
    }
  },
  {
    id: "opencode",
    displayName: "OpenCode",
    binary: "opencode",
    launch: ["opencode"],
    /* `opencode --model provider/model`; `opencode models` prints every provider/model it can serve, one per line. */
    models: {
      flag: ["--model"],
      suggestions: [OPENCODE_KIMI_MODEL, OPENCODE_CEREBRAS_MODEL],
      list: ["opencode", "models"],
      // `opencode models` lists a provider only when its credential is present.
      listCredentials: [
        "OPENCODE_API_KEY",
        "ANTHROPIC_API_KEY",
        "OPENAI_API_KEY",
        "GEMINI_API_KEY",
        "GOOGLE_API_KEY",
        "KIMI_API_KEY",
        "CEREBRAS_API_KEY",
        "OPENROUTER_API_KEY"
      ]
    },
    signal: (host) => {
      const { join } = hostPath(host)
      const auth = readJson(host, join(host.home, ".local", "share", "opencode", "auth.json"))
      const providers = auth === null ? [] : Object.keys(auth).filter((id) => hasNonEmptyStringDeep(auth[id]))
      if (providers.length > 0) return { status: "signed-in", account: { label: providers.join(", ") } }
      const key = firstEnv(host.env, [
        "OPENCODE_API_KEY",
        "ANTHROPIC_API_KEY",
        "OPENAI_API_KEY",
        "GEMINI_API_KEY",
        "GOOGLE_API_KEY",
        "KIMI_API_KEY"
      ])
      return key === undefined ? binaryOnly : apiKey(key)
    }
  },
  /*
   * OpenCode on the Kimi credential. `opencode providers list` (1.18.22)
   * names the provider "Kimi For Coding", read from KIMI_API_KEY, and
   * `opencode models kimi-for-coding` lists k3 as its model; `-m` takes
   * provider/model. Same binary as `opencode`, so an absent binary reads
   * unavailable exactly like the plain entry, and a present binary with no
   * Kimi credential is binary-only rather than a launch that fails inside.
   */
  {
    id: "opencode-kimi",
    displayName: "OpenCode · Kimi",
    binary: "opencode",
    launch: ["opencode", "--model", OPENCODE_KIMI_MODEL],
    models: {
      flag: ["--model"],
      suggestions: [OPENCODE_KIMI_MODEL],
      list: ["opencode", "models", "kimi-for-coding"],
      listCredentials: ["KIMI_API_KEY"]
    },
    signal: (host) => {
      const { join } = hostPath(host)
      const auth = readJson(host, join(host.home, ".local", "share", "opencode", "auth.json"))
      if (auth !== null && hasNonEmptyStringDeep(auth["kimi-for-coding"])) {
        return { status: "signed-in", account: { label: "kimi-for-coding" } }
      }
      const key = firstEnv(host.env, ["KIMI_API_KEY"])
      return key === undefined ? binaryOnly : apiKey(key)
    }
  },
  /*
   * OpenCode on the Cerebras credential (the "fast-ui" role): `opencode
   * providers list` (1.18.22) names "Cerebras", read from CEREBRAS_API_KEY,
   * and `opencode models cerebras` lists qwen-3.8-27b and gpt-oss-120b.
   */
  {
    id: "opencode-cerebras",
    displayName: "OpenCode · Cerebras",
    binary: "opencode",
    launch: ["opencode", "--model", OPENCODE_CEREBRAS_MODEL],
    models: {
      flag: ["--model"],
      suggestions: [OPENCODE_CEREBRAS_MODEL, "cerebras/gpt-oss-120b"],
      list: ["opencode", "models", "cerebras"],
      listCredentials: ["CEREBRAS_API_KEY"]
    },
    signal: (host) => {
      const { join } = hostPath(host)
      const auth = readJson(host, join(host.home, ".local", "share", "opencode", "auth.json"))
      if (auth !== null && hasNonEmptyStringDeep(auth["cerebras"])) {
        return { status: "signed-in", account: { label: "cerebras" } }
      }
      const key = firstEnv(host.env, ["CEREBRAS_API_KEY"])
      return key === undefined ? binaryOnly : apiKey(key)
    }
  },
  {
    id: "crush",
    displayName: "Crush",
    binary: "crush",
    launch: ["crush"],
    signal: (host) => {
      const { join } = hostPath(host)
      const key = firstEnv(host.env, ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY"])
      if (key !== undefined) return apiKey(key)
      const configs = [
        join(host.home, ".local", "share", "crush", "providers.json"),
        join(host.home, ".config", "crush", "crush.json")
      ]
      const found = configs.find((path) => hasNonEmptyStringDeep(readJsonAny(host, path)))
      return found === undefined ? binaryOnly : { status: "signed-in", account: { label: tilde(host, found) } }
    }
  },
  {
    id: "amp",
    displayName: "Amp",
    binary: "amp",
    launch: ["amp"],
    signal: (host) => {
      const { join } = hostPath(host)
      const key = firstEnv(host.env, ["AMP_API_KEY"])
      if (key !== undefined) return apiKey(key)
      const secrets = join(host.home, ".config", "amp", "secrets.json")
      return hasNonEmptyStringDeep(readJsonAny(host, secrets))
        ? { status: "signed-in", account: { label: tilde(host, secrets) } }
        : binaryOnly
    }
  },
  {
    id: "cursor-agent",
    displayName: "Cursor Agent",
    binary: "cursor-agent",
    launch: ["cursor-agent"],
    /* `cursor-agent --help`: "--model <model>  Model to use (e.g., gpt-5, sonnet-4, sonnet-4-thinking)". */
    models: { flag: ["--model"], suggestions: ["gpt-5", "sonnet-4", "sonnet-4-thinking"] },
    signal: (host) => {
      const { join } = hostPath(host)
      const key = firstEnv(host.env, ["CURSOR_API_KEY"])
      if (key !== undefined) return apiKey(key)
      const auth = host.platform === "darwin"
        ? join(host.home, ".cursor", "auth.json")
        : join(envDir(host, "XDG_CONFIG_HOME", join(host.home, ".config")), "cursor", "auth.json")
      return hasNonEmptyStringDeep(readJsonAny(host, auth))
        ? { status: "signed-in", account: { label: tilde(host, auth) } }
        : binaryOnly
    }
  },
  {
    id: "hermes",
    displayName: "Hermes",
    binary: "hermes",
    launch: ["hermes"],
    /* `hermes --help`: "-m MODEL, --model MODEL  Model override for this invocation (e.g. anthropic/claude-sonnet-4.6)"; `hermes model` is an interactive picker, not a list. */
    models: { flag: ["--model"], suggestions: ["anthropic/claude-sonnet-4.6"] },
    signal: (host) => {
      const { join } = hostPath(host)
      const auth = join(host.home, ".hermes", "auth.json")
      if (hasNonEmptyStringDeep(readJsonAny(host, auth))) {
        return { status: "signed-in", account: { label: tilde(host, auth) } }
      }
      const config = join(host.home, ".hermes", "config.yaml")
      return host.isFile(config) ? { status: "signed-in", account: { label: tilde(host, config) } } : binaryOnly
    }
  },
  {
    id: "pi",
    displayName: "Pi",
    binary: "pi",
    launch: ["pi"],
    signal: (host) => {
      const { join } = hostPath(host)
      const auth = join(host.home, ".pi", "agent", "auth.json")
      return hasNonEmptyStringDeep(readJsonAny(host, auth))
        ? { status: "signed-in", account: { label: tilde(host, auth) } }
        : binaryOnly
    }
  }
]

/**
 * The model table for one harness id, or undefined when its help names no
 * model flag the app verified.
 *
 * @category detection
 * @since 0.1.0
 */
export const harnessModels = (id: string): HarnessModels | undefined =>
  DETECTORS.find((detector) => detector.id === id)?.models

/**
 * What launching a role on this harness needs: the binary name and its
 * model flag.
 *
 * @category detection
 * @since 0.1.0
 */
export const harnessModelSpec = (id: string): HarnessModelSpec | undefined => {
  const detector = DETECTORS.find((candidate) => candidate.id === id)
  return detector?.models === undefined ? undefined : { binary: detector.binary, flag: detector.models.flag }
}
