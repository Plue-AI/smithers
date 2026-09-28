/**
 * What a version or model probe may read, and how its output is read back.
 *
 * The spawning itself belongs to the runtime adapter that implements
 * {@link HarnessHost.version}; these are the two decisions that must be the
 * same wherever it runs — the environment a probe child is allowed to see,
 * and the version string parsed out of whatever banner the CLI prints.
 *
 * @since 0.1.0
 */

import * as NodePath from "node:path"
import { harnessModels } from "./Detectors.ts"

/**
 * How long one `--version` may take before it is reported as null.
 *
 * @category constants
 * @since 0.1.0
 */
export const VERSION_TIMEOUT_MS = 3000

/**
 * The longest version string a probe may put in a Harness row.
 *
 * @category constants
 * @since 0.1.0
 */
export const VERSION_MAX_LENGTH = 64

/** ANSI CSI and OSC sequences, then any remaining C0/C1 control or bidi override. */
// eslint-disable-next-line no-control-regex -- control characters are exactly what this strips.
const ESCAPE_SEQUENCE = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g
// eslint-disable-next-line no-control-regex -- control characters are exactly what this strips.
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g

/**
 * The version out of a CLI's banner: "2.1.247 (Claude Code)" -> "2.1.247";
 * "crush version v0.1.11" -> "0.1.11"; else the first non-empty line.
 *
 * The probed binary may be hostile, so the result carries no control
 * character or escape sequence and is at most {@link VERSION_MAX_LENGTH}
 * characters.
 *
 * @category probe
 * @since 0.1.0
 */
export const parseVersionLine = (output: string): string | null => {
  const firstLine = output.split("\n")
    .map((line) => line.replace(ESCAPE_SEQUENCE, "").replace(CONTROL, "").trim())
    .find((line) => line !== "")
  if (firstLine === undefined) return null
  const match = /\d+\.\d+(?:\.\d+)?[0-9A-Za-z.+-]*/.exec(firstLine)
  return (match === null ? firstLine : match[0]).slice(0, VERSION_MAX_LENGTH)
}

/**
 * The environment every probe child gets: these keys and nothing else, so a
 * session token (SMITHERS_CLOUD_TOKEN, GITHUB_TOKEN) or a provider API key
 * never reaches a CLI that only reports its version. A model-list probe adds
 * its harness's `listCredentials` through {@link modelProbeEnv}.
 *
 * @category constants
 * @since 0.1.0
 */
export const PROBE_ENV_KEYS = [
  // Resolving the binary, its interpreter (`#!/usr/bin/env node`) and its own config.
  "HOME",
  "PATH",
  "TMPDIR",
  // Output encoding.
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  // Where opencode keeps its config, auth.json and model cache.
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
  "OPENCODE_CONFIG"
] as const

const copyKeys = (
  env: Record<string, string>,
  source: Readonly<Record<string, string | undefined>>,
  keys: ReadonlyArray<string>
): Record<string, string> => {
  for (const key of keys) {
    const value = source[key]
    if (value !== undefined && value !== "") env[key] = value
  }
  return env
}

/**
 * The version-probe child environment: {@link PROBE_ENV_KEYS} from `source`,
 * plus `NO_COLOR`. `PATH` keeps only absolute entries, so a probed script's
 * `#!/usr/bin/env node` cannot resolve an interpreter out of the cwd.
 *
 * @category probe
 * @since 0.1.0
 */
export const probeEnv = (source: Readonly<Record<string, string | undefined>>): Record<string, string> => {
  const env = copyKeys({ NO_COLOR: "1" }, source, PROBE_ENV_KEYS)
  if (env.PATH !== undefined) {
    const path = env.PATH.split(NodePath.delimiter).filter((dir) => NodePath.isAbsolute(dir)).join(NodePath.delimiter)
    if (path === "") delete env.PATH
    else env.PATH = path
  }
  return env
}

/**
 * The model-list probe child environment for one harness id: {@link probeEnv}
 * plus only the provider keys that harness's model listing reads. A harness
 * with no model listing gets no key.
 *
 * @category probe
 * @since 0.1.0
 */
export const modelProbeEnv = (
  id: string,
  source: Readonly<Record<string, string | undefined>>
): Record<string, string> => copyKeys(probeEnv(source), source, harnessModels(id)?.listCredentials ?? [])
