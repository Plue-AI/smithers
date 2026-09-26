/** What the setup commands share: the checkout they ship in, the environment they read, and loading an organization. */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Effect } from "effect"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseEnv } from "node:util"
import * as Authority from "../../../packages/smithers/agent/organization/src/Authority.ts"
import * as Config from "../../../packages/smithers/agent/organization/src/Config.ts"

/** Where a command writes and which environment it reads. */
export interface Io {
  readonly out: (line: string) => void
  readonly err: (line: string) => void
  readonly env: Readonly<Record<string, string | undefined>>
  readonly cwd: string
}

/** The process's own streams, environment and directory. */
export const processIo = (): Io => ({
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
  env: process.env,
  cwd: process.cwd()
})

/** A setup command a CLI registers by name. `run` resolves the process exit code. */
export interface Command {
  readonly name: string
  readonly usage: string
  readonly run: (argv: ReadonlyArray<string>, io: Io) => Promise<number>
}

/** The public checkout this file ships in: `.node-version` and `target/` live here. */
export const checkoutRoot = fileURLToPath(new URL("../../../", import.meta.url))

/** The example organization `init` copies. Its wiki root holds `Org/`. */
export const exampleRoot = join(checkoutRoot, "packages/smithers/agent/organization/example")

/** The host's state directory: `SMITHERS_ORG_STATE_DIR`, else `~/.smithers/org`. */
export const stateDirOf = (env: Io["env"]): string =>
  nonEmpty(env.SMITHERS_ORG_STATE_DIR) ?? join(homedir(), ".smithers", "org")

/** A comma-separated list with blanks dropped. */
export const list = (value: string | undefined): Array<string> =>
  (value ?? "").split(",").map((item) => item.trim()).filter((item) => item !== "")

export const nonEmpty = (value: string | undefined): string | undefined =>
  value === undefined || value.trim() === "" ? undefined : value

export const absolute = (cwd: string, path: string): string => isAbsolute(path) ? path : resolve(cwd, path)

/**
 * The environment a command sees: the file's variables under the process's,
 * so an exported variable wins as it does with `node --env-file`.
 */
export const withEnvFile = (env: Io["env"], file: string | undefined): Io["env"] => {
  if (file === undefined || !existsSync(file)) return env
  return { ...parseEnv(readFileSync(file, "utf8")), ...env }
}

/** A loaded organization: its configuration pages and the pinned roster, skills and common instructions. */
export interface Organization {
  readonly loaded: Config.Loaded
  readonly snapshot: Authority.Snapshot
}

/** Why an organization did not load, one line per problem, never a configuration value. */
export const describeFailure = (error: unknown): Array<string> => {
  if (error instanceof Config.ConfigError) {
    return [`${error.path}${error.field === undefined ? "" : ` ${error.field}`}: ${error.message}`]
  }
  if (error instanceof Authority.AuthorityError) {
    return error.violations.length === 0
      ? [error.message]
      : error.violations.map((violation) => `${violation.principal}: ${violation.code} ${violation.message}`)
  }
  return [error instanceof Error ? error.message : String(error)]
}

/** Loads `<root>/Org/Organization.md` and everything it names, through the same parsers the host uses. */
export const loadOrganization = async (root: string): Promise<Organization> => {
  const result = await Effect.runPromise(
    Effect.gen(function*() {
      const loaded = yield* Config.load(root)
      const snapshot = yield* Authority.loadSnapshot(root, loaded)
      return { loaded, snapshot }
    }).pipe(Effect.provide(NodeServices.layer), Effect.result)
  )
  // The typed error itself, not a fiber wrapper, so `describeFailure` can read it.
  if (result._tag === "Failure") throw result.failure
  return result.success
}

/** The repository names active roles holding `workspace` are granted, each with those roles. */
export const workspaceGrants = (organization: Organization): Map<string, Array<string>> => {
  const granted = new Map<string, Array<string>>()
  for (const profile of organization.snapshot.roster.profiles.values()) {
    if (profile.status !== "active" || !profile.grants.tools.includes("workspace")) continue
    for (const name of profile.grants.repositories) granted.set(name, [...(granted.get(name) ?? []), profile.id])
  }
  return granted
}
