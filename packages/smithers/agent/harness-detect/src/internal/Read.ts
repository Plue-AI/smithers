/**
 * The host reads the detection table shares.
 *
 * Internal: `./internal/*` is not part of the package's export map.
 *
 * @since 0.1.0
 */

import * as NodePath from "node:path"
import type { HarnessHost } from "../HarnessHost.ts"

/**
 * Path rules for the injected host, with native defaults for legacy directory callers.
 *
 * @category internal
 * @since 0.1.0
 */
export const hostPath = (
  host: { readonly platform?: string | undefined }
): Pick<typeof NodePath, "join" | "resolve" | "sep" | "delimiter"> =>
  host.platform === undefined ? NodePath : host.platform === "win32" ? NodePath.win32 : NodePath.posix

/**
 * A JSON object at `path`, or null when the file is missing, unreadable, or not an object.
 *
 * @category internal
 * @since 0.1.0
 */
export const readJson = (host: HarnessHost, path: string): Record<string, unknown> | null => {
  const text = host.readText(path)
  if (text === null) return null
  try {
    const parsed: unknown = JSON.parse(text)
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/**
 * Any JSON value at `path` — an array of credentials counts — or null.
 *
 * @category internal
 * @since 0.1.0
 */
export const readJsonAny = (host: HarnessHost, path: string): unknown => {
  const text = host.readText(path)
  if (text === null) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

/**
 * A string with something in it; an empty or blank value is not a credential.
 *
 * @category internal
 * @since 0.1.0
 */
export const nonEmptyString = (value: unknown): value is string => typeof value === "string" && value.trim() !== ""

/**
 * True when the JSON value holds at least one non-empty string anywhere below.
 *
 * @category internal
 * @since 0.1.0
 */
export const hasNonEmptyStringDeep = (value: unknown, depth = 0): boolean => {
  if (depth > 8) return false
  if (nonEmptyString(value)) return true
  if (Array.isArray(value)) return value.some((entry) => hasNonEmptyStringDeep(entry, depth + 1))
  if (typeof value === "object" && value !== null) {
    return Object.values(value).some((entry) => hasNonEmptyStringDeep(entry, depth + 1))
  }
  return false
}

/**
 * The first of `names` set to a non-empty value in `env`, as the variable's name.
 *
 * @category internal
 * @since 0.1.0
 */
export const firstEnv = (env: HarnessHost["env"], names: ReadonlyArray<string>): string | undefined =>
  names.find((name) => nonEmptyString(env[name]))

/**
 * A directory an env var may override (`CODEX_HOME`, `CLAUDE_CONFIG_DIR`), else the fallback.
 *
 * @category internal
 * @since 0.1.0
 */
export const envDir = (host: HarnessHost, name: string, fallback: string): string => {
  const value = host.env[name]
  return nonEmptyString(value) ? hostPath(host).resolve(value) : fallback
}

/**
 * `~/x` for a path below home, so a label stays short.
 *
 * @category internal
 * @since 0.1.0
 */
export const tilde = (host: HarnessHost, path: string): string =>
  path.startsWith(`${host.home}${hostPath(host).sep}`) ? `~${path.slice(host.home.length)}` : path
