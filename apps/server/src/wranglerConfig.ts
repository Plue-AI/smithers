import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

/*
 * The checked-in wrangler config, read so the tests (src/workerIdentity.test.ts,
 * src/staticRedirects.test.ts) and the deploy preflight
 * (scripts/adopt-durable-objects.ts) can hold what `wrangler deploy` reads to
 * src/workerIdentity.ts. wrangler.jsonc carries full-line `//` comments and
 * nothing else JSON cannot parse, so the reader strips those lines and parses
 * the rest; a comment style this cannot handle fails loudly in JSON.parse
 * instead of reading as an empty config.
 *
 * Nothing in the Worker imports this module: it is a test seam, not runtime.
 */
export interface WranglerConfig {
  readonly name: string
  readonly main: string
  readonly compatibility_date: string
  readonly compatibility_flags: ReadonlyArray<string>
  readonly routes: ReadonlyArray<{ readonly pattern: string; readonly custom_domain?: boolean; readonly zone_id?: string }>
  readonly assets: {
    readonly directory: string
    readonly binding: string
    readonly not_found_handling: string
    readonly run_worker_first: ReadonlyArray<string>
  }
  readonly durable_objects: {
    readonly bindings: ReadonlyArray<{ readonly name: string; readonly class_name: string }>
  }
  readonly migrations: ReadonlyArray<{ readonly tag: string; readonly new_sqlite_classes: ReadonlyArray<string> }>
  readonly vars: Readonly<Record<string, string>>
  readonly observability?: { readonly enabled: boolean }
}

export const WRANGLER_CONFIG_PATH = fileURLToPath(new URL("../wrangler.jsonc", import.meta.url))

export const parseWranglerConfig = (source: string): WranglerConfig =>
  JSON.parse(source.replace(/^\s*\/\/.*$/gm, "")) as WranglerConfig

export const readWranglerConfig = (): WranglerConfig => parseWranglerConfig(readFileSync(WRANGLER_CONFIG_PATH, "utf8"))
