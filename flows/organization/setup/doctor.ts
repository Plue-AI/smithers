/**
 * `doctor`: one line per prerequisite of a local organization host, each
 * `PASS`, `FAIL` with the command that fixes it, or `SKIP` when it does not
 * apply. Any `FAIL` makes the exit code 1. Secrets are checked by name and
 * never printed.
 */
import { Effect } from "effect"
import { spawnSync } from "node:child_process"
import { accessSync, constants, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { parseArgs } from "node:util"
import * as RequestExecutor from "../../../packages/smithers/agent/model/src/RequestExecutor.ts"
import * as Config from "../../../packages/smithers/agent/organization/src/Config.ts"
import type * as Workspace from "../../../packages/smithers/agent/organization/src/Workspace.ts"
import { installationOf, parseRepository } from "../settings.ts"
import { type BaseCheck, baseLines, installationMachines } from "./base.ts"
import { bootProbe, type Install, locate, msb, type Probe, sdkOf } from "./microsandbox.ts"
import {
  absolute,
  checkoutRoot,
  type Command,
  describeFailure,
  type Io,
  list,
  loadOrganization,
  nonEmpty,
  type Organization,
  stateDirOf,
  withEnvFile,
  workspaceGrants
} from "./settings.ts"
import * as NodeResolve from "./node.ts"
import * as Subscriptions from "./subscriptions.ts"
import { modelSeats, teamChannelScopes } from "./templates.ts"
import { atLeast } from "./version.ts"

export type Status = "pass" | "fail" | "skip"

export interface Line {
  readonly name: string
  readonly status: Status
  readonly detail: string
  /** The command or edit that clears a failure. */
  readonly fix?: string | undefined
}

/** The one `fetch` call shape the Slack checks make. */
export type Fetch = (input: string, init?: RequestInit) => Promise<Response>

export interface DoctorOptions {
  /** The wiki root holding `Org/`. */
  readonly root: string
  /** Repositories as `serve` takes them: `name=path`, or a bare path named by `repositoryName`. */
  readonly repos: ReadonlyArray<string>
  /** What relative repository paths resolve against. Default the process's directory. */
  readonly cwd?: string | undefined
  readonly stateDir: string
  readonly env: Readonly<Record<string, string | undefined>>
  /** The public checkout: `.node-version` and `target/release/`. */
  readonly checkout?: string | undefined
  /** How the host's Node is found; a test replaces it. */
  readonly node?: NodeResolve.System | undefined
  readonly platform?: NodeJS.Platform | undefined
  readonly fetch?: Fetch | undefined
  /** The `jj` executable. Default `jj` on `PATH`. */
  readonly jj?: string | undefined
  /** The Claude Code login's store; the CLI's own by default. */
  readonly claudeCredentials?: Subscriptions.CredentialsReader | undefined
  /** Replaces the Microsandbox lookup; `null` means not installed. */
  readonly install?: Install | null | undefined
  /** Replaces the hypervisor reading. */
  readonly hypervisor?: (() => Line) | undefined
  /** Where a slow step says it started, such as an image pull. */
  readonly progress?: ((line: string) => void) | undefined
  /** Replaces the real boot probe. */
  readonly probe?: ((image: string) => Promise<Probe>) | undefined
  /** Replaces the `base` and `tools` lines of a repository. */
  readonly bases?: ((check: BaseCheck) => Promise<Array<Line>>) | undefined
}

const pass = (name: string, detail: string): Line => ({ name, status: "pass", detail })
const fail = (name: string, detail: string, fix: string): Line => ({ name, status: "fail", detail, fix })
const skip = (name: string, detail: string): Line => ({ name, status: "skip", detail })

export { atLeast }

/** The Node the service would run: found where Node is installed, not only this process's. */
const nodeLine = (checkout: string, env: DoctorOptions["env"], on: NodeResolve.System | undefined): Line => {
  const file = join(checkout, ".node-version")
  if (!existsSync(file)) return fail("node", `${file} is missing`, `git -C ${checkout} status`)
  const wanted = readFileSync(file, "utf8").trim()
  const resolved = NodeResolve.resolve(env, env.HOME ?? homedir(), wanted, on)
  if (resolved._tag === "Found") return pass("node", `v${resolved.node.version} (>= ${wanted}) ${resolved.node.path}`)
  return fail(
    "node",
    resolved.newest === undefined ? `no Node >= ${wanted}` : `v${resolved.newest.version} is older than ${wanted}`,
    resolved.fix
  )
}

const microsandboxLine = (install: Install | undefined): Line => {
  if (install === undefined) {
    return fail("microsandbox", "the microsandbox SDK is not installed", `pnpm -C ${checkoutRoot} install`)
  }
  const version = msb(install, ["--version"])
  return version.status === 0
    ? pass("microsandbox", `SDK ${install.version}, CLI ${version.stdout.trim()}`)
    : fail("microsandbox", `the bundled msb CLI did not run: ${version.stderr.trim().split("\n")[0] ?? ""}`, `pnpm -C ${checkoutRoot} install`)
}

/** The host's hardware virtualization, read the way the microVM tests gate on it. */
export const hypervisorLine = (platform: NodeJS.Platform): Line => {
  if (platform === "darwin") {
    const sysctl = (name: string) => spawnSync("sysctl", ["-n", name], { encoding: "utf8" }).stdout?.trim()
    if (sysctl("kern.hv_support") !== "1") {
      return fail("hypervisor", "kern.hv_support is not 1", "run on Apple silicon macOS with Hypervisor.framework")
    }
    if (sysctl("kern.hv_vmm_present") === "1") {
      return fail("hypervisor", "this Mac is itself a VM", "run on the host, not inside a VM")
    }
    return pass("hypervisor", "kern.hv_support=1")
  }
  if (platform === "linux") {
    try {
      accessSync("/dev/kvm", constants.R_OK | constants.W_OK)
      return pass("hypervisor", "/dev/kvm is usable")
    } catch {
      return fail("hypervisor", "/dev/kvm is not readable and writable", "sudo usermod -aG kvm $USER && newgrp kvm")
    }
  }
  return fail("hypervisor", `microsandbox has no hypervisor on ${platform}`, "run on macOS (Apple silicon) or Linux with KVM")
}

const organizationLine = async (root: string): Promise<[Line, Organization | undefined]> => {
  if (!existsSync(join(root, "Org", "Organization.md"))) {
    return [fail("org", `${join(root, "Org", "Organization.md")} is missing`, `init ${root}`), undefined]
  }
  try {
    const organization = await loadOrganization(root)
    const { snapshot, loaded } = organization
    const current = [...snapshot.roster.profiles.values()].filter((profile) => profile.status !== "retired")
    const hires = current.filter((profile) => profile.kind !== "core").length
    const detail = `${current.length - hires} roles, ${hires === 0 ? "" : `${hires} hired, `}${snapshot.skills.skills.size} skills, ` +
      `${loaded.policy.gates.length} gates (${snapshot.revision.slice(0, 12)})`
    return [pass("org", detail), organization]
  } catch (error) {
    const problems = describeFailure(error)
    return [fail("org", problems.join("; "), `fix ${join(root, "Org")} and rerun doctor`), undefined]
  }
}

const imageLine = (
  install: Install | undefined,
  organization: Organization | undefined,
  progress: (line: string) => void
): [Line, string | undefined] => {
  if (organization === undefined) return [fail("image", "no organization loaded", "fix the org line first"), undefined]
  const image = organization.loaded.organization.vm.image
  const page = "Org/Organization.md"
  if (image === null) return [fail("image", `vm.image is unset in ${page}`, `set vm.image: node:26-bookworm in ${page}`), undefined]
  if (install === undefined) return [fail("image", `${image}: no microsandbox`, "fix the microsandbox line first"), image]
  if (msb(install, ["image", "inspect", image]).status === 0) return [pass("image", `${image} is cached`), image]
  progress(`pulling ${image}…`)
  const pulled = msb(install, ["pull", image], 900_000)
  return pulled.status === 0
    ? [pass("image", `${image} pulled`), image]
    : [fail("image", `${image} is not cached and did not pull`, `${install.cli.join(" ")} pull ${image}`), image]
}

/** The `jj` CLI the host's engine snapshots its execution root with. */
const jjLine = (binary: string): Line => {
  const probed = spawnSync(binary, ["--version"], { encoding: "utf8", timeout: 10_000 })
  return probed.status === 0
    ? pass("jj", probed.stdout.trim())
    : fail("jj", `${binary} --version did not run`, "install jj (https://jj-vcs.github.io/jj/latest/install-and-setup/) onto PATH")
}

const helperLine = (checkout: string, env: DoctorOptions["env"]): Line => {
  const configured = nonEmpty(env.SMITHERS_WORKSPACE_JJ_EXPORT_BINARY)
  const helper = configured ?? join(checkout, "target", "release", "smithers-jj-export")
  const build = `cargo +1.98.0 build --release --locked -p smithers-ffi --bin smithers-jj-export  # in ${checkout}`
  try {
    accessSync(helper, constants.X_OK)
    return statSync(helper).isFile() ? pass("jj-export", helper) : fail("jj-export", `${helper} is not a file`, build)
  } catch {
    return fail("jj-export", `${helper} is missing`, build)
  }
}

const seatsLine = async (
  organization: Organization | undefined,
  env: DoctorOptions["env"],
  credentials: Subscriptions.CredentialsReader | undefined
): Promise<Line> => {
  if (organization === undefined) return fail("seats", "no organization loaded", "fix the org line first")
  const executor = RequestExecutor.RequestExecutor.of({ execute: () => Effect.die("doctor never calls a model") })
  let mode: Subscriptions.Mode
  try {
    mode = Subscriptions.modeOf(env)
  } catch (error) {
    return fail("seats", (error as Error).message, `set ${Subscriptions.modeVariable}=subscription`)
  }
  const resolver = Subscriptions.resolver(env, executor, credentials === undefined ? {} : { credentials })
  const missing: Array<string> = []
  const seats = modelSeats(organization.loaded.organization)
  for (const seat of seats) {
    const refused = await Effect.runPromise(
      resolver.resolve(seat).pipe(Effect.as(undefined), Effect.catch((error) => Effect.succeed(error.message)))
    )
    if (refused !== undefined) missing.push(refused)
  }
  if (missing.length > 0) {
    return fail(
      "seats",
      missing.join("; "),
      mode === "subscription"
        ? "sign in with `codex login` (ChatGPT) and `claude` (Claude), then run doctor again"
        : "add the key to the .env file doctor read"
    )
  }
  if (mode === "api-key") return pass("seats", `${seats.join(", ")} resolve on API keys`)
  const providers = new Set(seats.map(Subscriptions.providerOf))
  const logins = [
    ...(providers.has("openai") ? [`ChatGPT login ${Subscriptions.chatgptLogin(env)}`] : []),
    ...(providers.has("anthropic") ? ["Claude subscription"] : [])
  ]
  return pass("seats", `${seats.join(", ")} resolve on subscriptions${logins.length === 0 ? "" : ` (${logins.join(", ")})`}`)
}

interface SlackAnswer {
  readonly ok: boolean
  readonly error?: string
  readonly team_id?: string
  /** The bot token's scopes, from the `x-oauth-scopes` response header. */
  readonly scopes?: ReadonlyArray<string>
}

const slackCall = async (
  fetcher: Fetch,
  base: string,
  method: string,
  token: string
): Promise<SlackAnswer> => {
  const response = await fetcher(`${base}/${method}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/x-www-form-urlencoded" },
    signal: AbortSignal.timeout(15_000)
  })
  if (!response.ok) return { ok: false, error: `HTTP ${response.status}` }
  const header = response.headers.get("x-oauth-scopes")
  const answer = await response.json() as SlackAnswer
  return header === null ? answer : { ...answer, scopes: header.split(",").map((scope) => scope.trim()).filter((scope) => scope !== "") }
}

const slackLines = async (env: DoctorOptions["env"], fetcher: Fetch): Promise<Array<Line>> => {
  const bot = nonEmpty(env.SMITHERS_SLACK_BOT_TOKEN), app = nonEmpty(env.SMITHERS_SLACK_APP_TOKEN)
  if (bot === undefined && app === undefined) {
    return [skip("slack", "no tokens"), skip("slack socket", "no tokens")]
  }
  const fix = "copy the token from the Slack app settings into the .env file doctor read"
  if (bot === undefined || !bot.startsWith("xoxb-")) {
    return [fail("slack", "SMITHERS_SLACK_BOT_TOKEN is missing or not a bot token (xoxb-)", fix), skip("slack socket", "no bot token")]
  }
  if (app === undefined || !app.startsWith("xapp-")) {
    return [fail("slack", "SMITHERS_SLACK_APP_TOKEN is missing or not an app-level token (xapp-)", fix), skip("slack socket", "no app token")]
  }
  if (list(env.SMITHERS_SLACK_USER_IDS).length === 0 && list(env.SMITHERS_SLACK_CHANNEL_IDS).length === 0) {
    return [fail("slack", "SMITHERS_SLACK_USER_IDS is empty", "set it to your Slack member id (profile > ... > Copy member ID)"), skip("slack socket", "no owner")]
  }
  const teams = list(env.SMITHERS_SLACK_TEAM_IDS)
  const base = (nonEmpty(env.SMITHERS_SLACK_API_BASE_URL) ?? "https://slack.com/api").replace(/\/+$/, "")
  const lines: Array<Line> = []
  try {
    const auth = await slackCall(fetcher, base, "auth.test", bot)
    if (!auth.ok) lines.push(fail("slack", `auth.test: ${auth.error ?? "refused"}`, "reinstall the app and copy the new bot token"))
    else if (auth.team_id === undefined || !teams.includes(auth.team_id)) {
      // The workspace id comes from Slack itself, so the fix is exact.
      const team = auth.team_id ?? "?"
      const detail = teams.length === 0 ? `SMITHERS_SLACK_TEAM_IDS is empty; auth.test team is ${team}` : `auth.test team ${team} is not in SMITHERS_SLACK_TEAM_IDS`
      lines.push(fail("slack", detail, `set SMITHERS_SLACK_TEAM_IDS=${team}`))
    } else {
      lines.push(pass("slack", `auth.test ok (team ${auth.team_id})`))
      // The team channel needs scopes an app installed from an older manifest lacks.
      const missing = auth.scopes === undefined ? [] : teamChannelScopes.filter((scope) => !auth.scopes!.includes(scope))
      lines.push(missing.length === 0
        ? pass("slack team", `#${nonEmpty(env.SMITHERS_SLACK_TEAM_CHANNEL) ?? "smithers-team"}`)
        : fail("slack team", `missing scopes ${missing.join(", ")}; the team channel is the wiki log until then`, "reinstall the app from the updated manifest"))
    }
  } catch (error) {
    lines.push(fail("slack", `auth.test: ${error instanceof Error ? error.message : String(error)}`, "check the network and rerun doctor"))
  }
  try {
    const socket = await slackCall(fetcher, base, "apps.connections.open", app)
    lines.push(socket.ok
      ? pass("slack socket", "apps.connections.open ok")
      : fail("slack socket", `apps.connections.open: ${socket.error ?? "refused"}`, "enable Socket Mode and create an app-level token with connections:write"))
  } catch (error) {
    lines.push(fail("slack socket", `apps.connections.open: ${error instanceof Error ? error.message : String(error)}`, "check the network and rerun doctor"))
  }
  return lines
}

const repoLines = (entries: ReadonlyArray<string>, cwd: string, organization: Organization | undefined): Array<Line> => {
  const granted = organization === undefined ? new Map<string, Array<string>>() : workspaceGrants(organization)
  const suggested = granted.size === 1 ? [...granted.keys()][0]! : "<name>"
  if (entries.length === 0) {
    return [fail("repo", "no repository configured", `set SMITHERS_ORG_REPOS=${suggested}=<path> in the .env file, or pass --repo`)]
  }
  return entries.map((entry) => {
    const [name, repo] = parseRepository(cwd, entry)
    const top = spawnSync("git", ["-C", repo, "rev-parse", "--show-toplevel"], { encoding: "utf8" })
    if (top.status !== 0) return fail("repo", `${repo} is not a git repository`, `git -C ${repo} init, or fix SMITHERS_ORG_REPOS`)
    const head = spawnSync("git", ["-C", repo, "rev-parse", "--verify", "--quiet", "HEAD"], { encoding: "utf8" })
    if (head.status !== 0) return fail("repo", `${repo} has no commit`, `git -C ${repo} commit --allow-empty -m init`)
    // A name no workspace role is granted blocks every delivery at assignment.
    const roles = granted.get(name)
    if (organization !== undefined && roles === undefined) {
      return fail(
        "repo",
        `${name} (${repo}) is granted to no active role holding workspace`,
        granted.size === 0
          ? `grant ${name} to a role with workspace in Org/Roles`
          : `set SMITHERS_ORG_REPOS=${suggested}=${repo}${granted.size > 1 ? ` (granted: ${[...granted.keys()].join(", ")})` : ""}`
      )
    }
    return pass("repo", `${name} = ${repo} @ ${head.stdout.trim().slice(0, 12)}${roles === undefined ? "" : ` (${roles.join(", ")})`}`)
  })
}

const networkText = (network: Workspace.Network): string =>
  network === "none" ? "offline" : network === "all" ? "full network" : network.join(" ")

/**
 * One line per configured repository the organization page gives an
 * environment: its prepare key paths must exist at `HEAD`. A repository
 * without an environment prints nothing.
 */
export const environmentLines = (
  entries: ReadonlyArray<string>,
  cwd: string,
  organization: Organization | undefined
): Array<Line> => {
  const declared = organization?.loaded.organization.repositories ?? {}
  return entries.flatMap((entry) => {
    const [name, repo] = parseRepository(cwd, entry)
    if (!Object.hasOwn(declared, name)) return []
    const environment = declared[name]!
    const missing = (environment.prepare?.key ?? []).filter((path) =>
      spawnSync("git", ["-C", repo, "cat-file", "-e", `HEAD:${path}`], { stdio: "ignore" }).status !== 0
    )
    if (missing.length > 0) {
      return [fail("env", `${name}: ${missing.join(", ")} not at HEAD`, `fix repositories.${name}.prepare.key in Org/Organization.md`)]
    }
    const prepare = environment.prepare === undefined ? "no prepare" : `prepare ${networkText(environment.prepare.network)}`
    const checks = environment.checks?.length ?? 0
    return [pass("env", `${name}: ${prepare}; builders ${networkText(environment.network ?? "none")}; ${checks} check${checks === 1 ? "" : "s"}`)]
  })
}

const stateLine = (stateDir: string): Line => {
  const fix = `mkdir -p ${stateDir} && chmod 700 ${stateDir}`
  try {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 })
    const probe = join(stateDir, `.doctor-${process.pid}`)
    writeFileSync(probe, "")
    rmSync(probe)
    const mode = statSync(stateDir).mode & 0o777
    return mode & 0o077
      ? fail("state", `${stateDir} is readable by others (${mode.toString(8)})`, `chmod 700 ${stateDir}`)
      : pass("state", `${stateDir} is writable`)
  } catch (error) {
    return fail("state", `${stateDir}: ${error instanceof Error ? error.message : String(error)}`, fix)
  }
}

/** Every check, in order. Never throws for a failed prerequisite; that is a `fail` line. */
export const doctor = async (options: DoctorOptions): Promise<Array<Line>> => {
  const checkout = options.checkout ?? checkoutRoot
  const install = options.install === undefined ? locate() : options.install ?? undefined
  const lines: Array<Line> = [nodeLine(checkout, options.env, options.node)]
  const sandbox = microsandboxLine(install)
  lines.push(sandbox)
  const hypervisor = (options.hypervisor ?? (() => hypervisorLine(options.platform ?? process.platform)))()
  lines.push(hypervisor)
  const [org, organization] = await organizationLine(options.root)
  lines.push(org)
  const [image, reference] = imageLine(sandbox.status === "pass" ? install : undefined, organization, options.progress ?? (() => {}))
  lines.push(image)
  const blocked = [sandbox, hypervisor, image].find((line) => line.status !== "pass")
  if (blocked !== undefined || reference === undefined) {
    lines.push(fail("boot", `not attempted: ${blocked?.name ?? "image"} failed`, `fix the ${blocked?.name ?? "image"} line first`))
  } else {
    const probed = await (options.probe ?? (async (image: string) => bootProbe(await sdkOf(install!), image)))(reference)
    lines.push(probed.ok ? pass("boot", probed.detail) : fail("boot", probed.detail, `${install!.cli.join(" ")} doctor`))
  }
  lines.push(jjLine(options.jj ?? "jj"))
  lines.push(helperLine(checkout, options.env))
  lines.push(await seatsLine(organization, options.env, options.claudeCredentials))
  lines.push(...await slackLines(options.env, options.fetch ?? fetch))
  lines.push(...repoLines(options.repos, options.cwd ?? process.cwd(), organization))
  const environments = environmentLines(options.repos, options.cwd ?? process.cwd(), organization)
  lines.push(...environments)
  // Each repository whose environment line passed: the commit its next task
  // starts from, and its prepared base's tools, in a microVM when one boots.
  const declared = organization?.loaded.organization.repositories ?? {}
  const vm = organization?.loaded.organization.vm
  const booted = lines.find((line) => line.name === "boot")?.status === "pass"
  for (const entry of options.repos) {
    const [name, repo] = parseRepository(options.cwd ?? process.cwd(), entry)
    if (!Object.hasOwn(declared, name)) continue
    if (environments.find((line) => line.detail.startsWith(`${name}:`))?.status !== "pass") continue
    const environment = Config.environmentOf(declared[name]!)
    // Machines only for a base that declares tools, and only on a host that boots.
    const machines = booted && vm !== undefined && install !== undefined && reference !== undefined &&
        (environment.prepare?.tools?.length ?? 0) > 0
      ? installationMachines({
        sdk: await sdkOf(install),
        image: reference,
        cpus: vm.cpus,
        memoryMib: vm.memoryMib,
        diskMib: vm.diskMib,
        installation: installationOf(options.stateDir)
      })
      : undefined
    options.progress?.(`checking ${name}'s base…`)
    lines.push(...await (options.bases ?? baseLines)({
      name,
      repo,
      environment,
      machines,
      key: `doctor-${process.pid}/${name}`
    }))
  }
  lines.push(stateLine(options.stateDir))
  return lines
}

/** One printed line per check; a failure's fix on the line below it. */
export const render = (lines: ReadonlyArray<Line>): Array<string> => {
  const width = Math.max(...lines.map((line) => line.name.length))
  return lines.flatMap((line) => [
    `${line.status.toUpperCase().padEnd(4)}  ${line.name.padEnd(width)}  ${line.detail}`,
    ...(line.fix === undefined ? [] : [`${" ".repeat(width + 8)}fix: ${line.fix}`])
  ])
}

export const usage = "doctor [--root <dir>] [--repo <name=path>]... [--state-dir <dir>] [--env-file <file>]"

export const command: Command = {
  name: "doctor",
  usage,
  run: async (argv: ReadonlyArray<string>, io: Io) => {
    const parsed = parseArgs({
      args: [...argv],
      options: {
        root: { type: "string" },
        repo: { type: "string", multiple: true },
        "state-dir": { type: "string" },
        "env-file": { type: "string" }
      }
    })
    const values = parsed.values
    // The .env lives in the state directory, outside any repository.
    const initialState = nonEmpty(values["state-dir"]) ?? stateDirOf(io.env)
    const envFile = absolute(io.cwd, values["env-file"] ?? join(absolute(io.cwd, initialState), ".env"))
    const env = withEnvFile(io.env, envFile)
    const root = absolute(io.cwd, nonEmpty(values.root) ?? nonEmpty(env.SMITHERS_ORG_ROOT) ?? io.cwd)
    const repos = values.repo ?? list(env.SMITHERS_ORG_REPOS)
    const stateDir = absolute(io.cwd, nonEmpty(values["state-dir"]) ?? stateDirOf(env))
    io.out(`env    ${existsSync(envFile) ? envFile : `${envFile} (absent)`}`)
    io.out(`root   ${root}`)
    const lines = await doctor({ root, repos, cwd: io.cwd, stateDir, env, progress: io.out })
    for (const line of render(lines)) io.out(line)
    return lines.some((line) => line.status === "fail") ? 1 : 0
  }
}
