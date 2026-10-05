/**
 * The built-in source of each pinnable flow this host ships: the version a
 * TODO pins when `main` has no `flows/<name>/flow.ts` (spec §11.1.2). Its
 * content digest is the built-in's Active digest the backend serves
 * (`packages/backend/internal/services/builtin_flows.json`).
 */
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

/** Compiled into the deployed host by `flows/coding/build.mjs`; undefined from source. */
declare const __SMITHERS_BUILTIN_FLOWS__: Readonly<Record<string, string>> | undefined

const sources: Readonly<Record<string, string>> = { todo: "../todo/flow.ts" }

export const builtinFlowSource = (name: string): string | undefined => {
  if (!Object.hasOwn(sources, name)) return undefined
  if (typeof __SMITHERS_BUILTIN_FLOWS__ !== "undefined") {
    return Object.hasOwn(__SMITHERS_BUILTIN_FLOWS__, name) ? __SMITHERS_BUILTIN_FLOWS__[name] : undefined
  }
  try {
    return readFileSync(fileURLToPath(new URL(sources[name]!, import.meta.url)), "utf8")
  } catch {
    return undefined
  }
}
