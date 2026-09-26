/**
 * What an organization host is started with, read from flags over the
 * environment over the state directory's `.env` file, and checked before
 * anything opens.
 *
 * The variables are the setup commands' (`setup/settings.ts`), so `init`,
 * `doctor`, and `serve` read one configuration:
 *
 * - `SMITHERS_ORG_ROOT` / `--root`: the directory holding `Org/`;
 * - `SMITHERS_ORG_STATE_DIR` / `--state-dir`: databases, the catalog, and
 *   `.env` (default `~/.smithers/org`);
 * - `SMITHERS_ORG_REPOS` / `--repo`: comma-separated repositories, each
 *   `name=path` or a bare path (see {@link repositoryName});
 *   each repository's environment (its prepared base, network, and checks)
 *   comes from the organization page's `repositories.<name>`;
 * - `SMITHERS_ORG_MAX_CONCURRENT_VMS`: overrides the organization page's
 *   `vm.maxConcurrentVMs`;
 * - `SMITHERS_ORG_CHECKS` / `--check`: newline-separated `name=command`
 *   checks every change runs in a fresh machine;
 * - `SMITHERS_ORG_MAX_ROUNDS` / `--max-rounds`: builder/checker rounds (default 2);
 * - `SMITHERS_ORG_AUTH`: `subscription` (default) or `api-key`, how seats
 *   reach a model (`setup/subscriptions.ts`);
 * - `SMITHERS_SLACK_*`: the one Slack app, as the integrations guide names them.
 */
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"
import type * as Authority from "../../packages/smithers/agent/organization/src/Authority.ts"
import * as Config from "../../packages/smithers/agent/organization/src/Config.ts"
import type * as Gates from "../../packages/smithers/agent/organization/src/Gates.ts"
import type * as Workspace from "../../packages/smithers/agent/organization/src/Workspace.ts"
import {
  absolute,
  describeFailure,
  list,
  loadOrganization,
  nonEmpty,
  stateDirOf,
  withEnvFile
} from "./setup/settings.ts"
import * as Subscriptions from "./setup/subscriptions.ts"

/** The default loopback port of an organization host. */
export const defaultPort = 7433

/** A host's checked configuration. */
export interface Settings {
  readonly root: string
  readonly stateDir: string
  /** Stable per state directory; every machine this installation boots carries it. */
  readonly installation: string
  readonly organization: Config.Organization
  readonly policy: Gates.GatePolicy
  readonly snapshot: Authority.Snapshot
  /** Repository names, as the roster grants them, to host paths. */
  readonly repositories: Readonly<Record<string, string>>
  /** Each configured repository's environment, by name, from the organization page. */
  readonly environments: Readonly<Record<string, Workspace.Environment>>
  readonly checks: ReadonlyArray<Workspace.Check>
  readonly owners: ReadonlyArray<string>
  readonly maxRounds: number
  readonly maxConcurrentVMs: number
  readonly host: string
  readonly port: number
  /** The routines page's routines; none without one. */
  readonly routines: ReadonlyArray<Config.Routine>
}

/** The flags `serve` takes; each overrides its variable. */
export interface Flags {
  readonly root?: string | undefined
  readonly "state-dir"?: string | undefined
  readonly repo?: ReadonlyArray<string> | undefined
  readonly check?: ReadonlyArray<string> | undefined
  readonly "max-rounds"?: string | undefined
  readonly host?: string | undefined
  readonly port?: string | undefined
  readonly "env-file"?: string | undefined
}

/**
 * The name a bare repository path is served under: the `owner/name` of its
 * `origin` remote when it has one, else the directory name. Roster grants
 * name repositories this way; pass `name=path` when they differ.
 */
export const repositoryName = (path: string): string => {
  try {
    const url = execFileSync("git", ["-C", path, "remote", "get-url", "origin"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim()
    const match = /[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/.exec(url)
    if (match !== null) return match[1]!
  } catch {
    // No origin: the directory name.
  }
  return basename(path)
}

/** `name=path` or a bare path, as `[name, absolute path]`. */
export const parseRepository = (cwd: string, entry: string): readonly [string, string] => {
  const separator = entry.indexOf("=")
  if (separator > 0) return [entry.slice(0, separator), absolute(cwd, entry.slice(separator + 1))]
  const path = absolute(cwd, entry)
  return [repositoryName(path), path]
}

/** `name=command`, run as `sh -c command` in the workspace root. */
export const parseCheck = (entry: string): Workspace.Check => {
  const separator = entry.indexOf("=")
  if (separator <= 0 || entry.slice(separator + 1).trim() === "") {
    throw new Error(`a check is name=command, not ${JSON.stringify(entry)}`)
  }
  return { name: entry.slice(0, separator).trim(), argv: ["sh", "-c", entry.slice(separator + 1).trim()] }
}

const positive = (name: string, value: string | undefined, fallback: number, max: number): number => {
  if (value === undefined || value.trim() === "") return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) {
    throw new Error(`${name} must be an integer from 1 to ${max}`)
  }
  return parsed
}

/** The installation id of a state directory, created on first use. */
export const installationOf = (stateDir: string): string => {
  const file = join(stateDir, "installation")
  if (existsSync(file)) return readFileSync(file, "utf8").trim()
  const id = `smithers-org-${randomUUID()}`
  writeFileSync(file, `${id}\n`, { mode: 0o600, flag: "wx" })
  return id
}

/** The environment `serve` reads: the state directory's `.env` under the process's variables. */
export const environmentOf = (
  flags: Pick<Flags, "state-dir" | "env-file">,
  env: Readonly<Record<string, string | undefined>>,
  cwd: string
) => {
  const stateDir = absolute(cwd, nonEmpty(flags["state-dir"]) ?? stateDirOf(env))
  return withEnvFile(env, absolute(cwd, flags["env-file"] ?? join(stateDir, ".env")))
}

/** Reads and checks everything `serve` needs. Throws a message naming the setting at fault. */
export const resolve = async (
  flags: Flags,
  env: Readonly<Record<string, string | undefined>>,
  cwd: string
): Promise<Settings> => {
  const stateDir = absolute(cwd, nonEmpty(flags["state-dir"]) ?? stateDirOf(env))
  Subscriptions.modeOf(env)
  const root = absolute(cwd, nonEmpty(flags.root) ?? nonEmpty(env.SMITHERS_ORG_ROOT) ?? cwd)
  if (!existsSync(join(root, Config.defaultOrganizationFile))) {
    throw new Error(`${root} holds no ${Config.defaultOrganizationFile}; pass --root or set SMITHERS_ORG_ROOT`)
  }
  const entries = flags.repo !== undefined && flags.repo.length > 0 ? flags.repo : list(env.SMITHERS_ORG_REPOS)
  if (entries.length === 0) {
    throw new Error("no repository configured; pass --repo <name=path> or set SMITHERS_ORG_REPOS")
  }
  const repositories: Record<string, string> = {}
  for (const entry of entries) {
    const [name, path] = parseRepository(cwd, entry)
    if (Object.hasOwn(repositories, name)) throw new Error(`repository ${name} is configured twice`)
    if (!existsSync(join(path, ".git"))) throw new Error(`repository ${name} at ${path} is not a git checkout`)
    repositories[name] = path
  }
  const checks = (flags.check !== undefined && flags.check.length > 0
    ? flags.check
    : (env.SMITHERS_ORG_CHECKS ?? "").split("\n").filter((entry) => entry.trim() !== "")).map(parseCheck)
  const loaded = await loadOrganization(root).catch((error: unknown) => {
    throw new Error(
      `the organization at ${root} does not load:\n${describeFailure(error).map((line) => `  ${line}`).join("\n")}`
    )
  })
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const organization = loaded.loaded.organization
  const environments = Object.fromEntries(
    Object.entries(organization.repositories ?? {})
      .filter(([name]) => Object.hasOwn(repositories, name))
      .map(([name, entry]) => [name, Config.environmentOf(entry)])
  )
  const port = positive("--port", flags.port, defaultPort, 65_535)
  return {
    root,
    stateDir,
    installation: installationOf(stateDir),
    organization,
    policy: loaded.loaded.policy,
    snapshot: loaded.snapshot,
    repositories,
    environments,
    checks,
    owners: list(env.SMITHERS_SLACK_USER_IDS),
    maxRounds: positive("--max-rounds", flags["max-rounds"] ?? env.SMITHERS_ORG_MAX_ROUNDS, 2, 5),
    maxConcurrentVMs: positive(
      "SMITHERS_ORG_MAX_CONCURRENT_VMS",
      env.SMITHERS_ORG_MAX_CONCURRENT_VMS,
      organization.vm.maxConcurrentVMs,
      64
    ),
    host: flags.host ?? "127.0.0.1",
    port,
    routines: loaded.loaded.routines?.routines ?? []
  }
}
