/**
 * The private Cloud Run preview transport. Credentials stay in captured
 * gcloud output and Docker login stdin; subprocess output is never reported.
 * @since 1.0.0
 */

import type * as CloudRun from "@smthrs/targets/CloudRun"
import * as Data from "effect/Data"
import { createHash, randomUUID } from "node:crypto"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import * as DockerExec from "./DockerExec.ts"
import * as ContainedProcess from "./internal/ContainedProcess.ts"
import * as PackageTree from "./PackageTree.ts"

/** A private preview transport refusal or failure.
 * @category errors
 * @since 1.0.0
 */
class PreviewError extends Data.TaggedError("smithers-build/CloudRunPreviewError")<{
  readonly message: string
}> {
  get code(): string {
    return this.message.split(": ")[1] ?? "tool_failed"
  }
}

/** Refuses bytes that cannot be attributed to the commit stamp.
 * @category planning
 * @since 1.0.0
 */
export const requireCleanWorktree = async (root: string): Promise<void> => {
  if ((await PackageTree.runGit(root, ["status", "--porcelain", "--untracked-files=all"])).trim() !== "") {
    throw new PreviewError({
      message: "CloudRun.Preview: dirty_worktree: commit or remove working copy changes before deploying"
    })
  }
}

/** Validated preview declaration.
 * @category models
 * @since 1.0.0
 */
export type Attrs = (typeof CloudRun.PreviewAttrs)["Type"]

/** Resolves tools without executing a probe or admitting public access.
 * @category planning
 * @since 1.0.0
 */
export const tools = (attrs: Attrs, environment: Readonly<Record<string, string | undefined>>) => {
  if (attrs.access === "public") {
    throw new PreviewError({
      message: "CloudRun.Preview: public_access_off: access \"public\" needs the sign-in link; use access \"private\""
    })
  }
  const docker = PackageTree.findOnPath("docker", environment)
  const gcloud = PackageTree.findOnPath("gcloud", environment)
  if (docker === undefined || gcloud === undefined) {
    throw new PreviewError({ message: "CloudRun.Preview: tool_missing: docker and gcloud must be present on PATH" })
  }
  return { docker, gcloud }
}

interface CommandResult {
  readonly stdout: string
  readonly exitCode: number
}

// Keep all output private, including failing children's diagnostics. A child
// can echo stdin or an inherited credential; only the command name and status
// cross the reporter boundary. Bound captures and terminate on cancellation.
const command = async (
  executable: string,
  argv: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
  cwd: string,
  signal: AbortSignal | undefined,
  stdin = ""
): Promise<CommandResult> => {
  let stdout = ""
  try {
    const exitCode = await ContainedProcess.run({
      command: executable,
      args: argv,
      environment,
      cwd,
      signal,
      stdin,
      timeoutMs: 600_000,
      maxOutputBytes: 16 * 1024 * 1024,
      stdout: (text) => {
        stdout += text
      },
      stderr: () => {}
    })
    return { stdout, exitCode }
  } catch (cause) {
    throw new PreviewError({
      message: cause instanceof ContainedProcess.ProcessError && cause.code === "output_limit"
        ? "CloudRun.Preview: tool_failed: subprocess output exceeded limit"
        : "CloudRun.Preview: tool_failed: subprocess unavailable or cancelled"
    })
  }
}

const json = <A>(text: string): A => {
  try {
    return JSON.parse(text) as A
  } catch {
    throw new PreviewError({ message: "CloudRun.Preview: tool_failed: malformed gcloud response" })
  }
}

interface Traffic {
  readonly tag?: string
  readonly revisionName?: string
  readonly url?: string
  readonly percent?: number
  readonly latestRevision?: boolean
}
interface Service {
  readonly metadata?: { readonly resourceVersion?: string }
  readonly spec?: { readonly traffic?: ReadonlyArray<Traffic>; readonly [key: string]: unknown }
  readonly status?: { readonly traffic?: ReadonlyArray<Traffic>; readonly latestReadyRevisionName?: string }
}
interface Revision {
  readonly metadata?: { readonly name?: string; readonly labels?: Readonly<Record<string, string>> }
  readonly status?: { readonly imageDigest?: string }
}

const carriesTraffic = (service: Service, name: string): boolean => {
  const entries = service.status?.traffic ?? []
  return entries.some((entry) =>
    (entry.percent ?? 0) > 0 && (
      entry.revisionName === name ||
      (entry.latestRevision === true && service.status?.latestReadyRevisionName === name) ||
      (entry.revisionName === undefined &&
        (entry.latestRevision !== true || typeof service.status?.latestReadyRevisionName !== "string"))
    )
  )
}

/** A versioned private preview receipt.
 * @category models
 * @since 1.0.0
 */
export interface Receipt {
  readonly version: 1
  readonly label: string
  readonly commit: string
  readonly revision: string
  readonly tag: string
  readonly project: string
  readonly region: string
  readonly service: string
  readonly imageDigest: string
  readonly access: "private"
  readonly expiresAt: string
  readonly open: { readonly command: string; readonly localUrl: "http://preview.localhost:4100" }
  readonly measured: { readonly imageBytes: number; readonly buildSeconds: number; readonly readySeconds: number }
  readonly swept: ReadonlyArray<string>
}

/** Runs preflight, push, reuse/deploy, anonymous probe and expiry cleanup.
 * @category execution
 * @since 1.0.0
 */
export const preview = async (options: {
  readonly attrs: Attrs
  readonly root: string
  readonly packagePath: string
  readonly name: string
  readonly label: string
  readonly archive: string
  readonly commit: string
  readonly buildSeconds: number
  readonly environment: Readonly<Record<string, string | undefined>>
  readonly signal: AbortSignal | undefined
}): Promise<Receipt> => {
  let readyStarted = performance.now()
  let readySeconds = 0
  const attrs = options.attrs
  if (!/^[a-z0-9][a-z0-9_.-]{0,127}$/.test(options.name)) {
    throw new PreviewError({ message: "CloudRun.Preview: invalid_target: target key must be a registry image name" })
  }
  const { docker, gcloud } = tools(attrs, options.environment)
  if (!/^[a-f0-9]{40}$/.test(options.commit)) {
    throw new PreviewError({ message: "CloudRun.Preview: stale_image: run has no valid commit stamp" })
  }
  const image = await DockerExec.readImageArchive(options.archive)
  if ("error" in image) throw new PreviewError({ message: `CloudRun.Preview: stale_image: ${image.error}` })
  if (image.revision !== options.commit) {
    throw new PreviewError({ message: "CloudRun.Preview: stale_image: archive revision differs from run commit" })
  }
  if (image.architecture !== "amd64") {
    throw new PreviewError({ message: "CloudRun.Preview: stale_image: Cloud Run requires an amd64 image" })
  }
  const origin =
    (await PackageTree.runGit(options.root, ["config", "--get", "remote.origin.url"]).catch(() => undefined))?.trim()
  if (origin === undefined || origin === "") {
    throw new PreviewError({ message: "CloudRun.Preview: invalid_target: repository origin required" })
  }
  const normalizedOrigin = origin.replace(/^git\+/, "").replace(/^git@([^:]+):/, "https://$1/")
  let repository: string
  try {
    const url = new URL(normalizedOrigin)
    repository = `${url.hostname.toLowerCase()}/${
      url.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "").toLowerCase()
    }`
  } catch {
    throw new PreviewError({ message: "CloudRun.Preview: invalid_target: repository origin is not a URL" })
  }
  const owner = createHash("sha256").update(
    JSON.stringify([repository, options.label, `${attrs.repository}/${options.name}`])
  ).digest("hex").slice(0, 40)
  const deployment = randomUUID()
  const sha = options.commit.slice(0, 7)
  const tag = `r-${sha}`
  const base = [
    "--region",
    attrs.region,
    "--project",
    attrs.project,
    `--impersonate-service-account=${attrs.deployer}`,
    "--quiet"
  ]
  const cloud = async (
    argv: ReadonlyArray<string>,
    required = true,
    signal: AbortSignal | null | undefined = options.signal
  ) => {
    const result = await command(
      gcloud,
      [...argv, ...base],
      { ...options.environment },
      options.root,
      signal ?? undefined
    )
    if (required && result.exitCode !== 0) {
      throw new PreviewError({
        message: `CloudRun.Preview: tool_failed: gcloud ${argv.slice(0, 3).join(" ")} failed (${result.exitCode})`
      })
    }
    return result
  }
  const auth = await command(
    gcloud,
    ["auth", "print-access-token", `--impersonate-service-account=${attrs.deployer}`],
    { ...options.environment },
    options.root,
    options.signal
  )
  const token = auth.stdout.trim()
  if (auth.exitCode !== 0 || token === "" || /[\r\n]/.test(token)) {
    throw new PreviewError({
      message: "CloudRun.Preview: credentials_missing: Google login or impersonation unavailable"
    })
  }
  const describe = await cloud(["run", "services", "describe", attrs.service, "--format=json"], false)
  if (describe.exitCode !== 0) {
    throw new PreviewError({ message: "CloudRun.Preview: service_missing: bootstrap the service outside Smithers" })
  }
  const serviceDocument = (text: string): Service => {
    const value = json<Service>(text)
    if (value === null || !Array.isArray(value.status?.traffic)) {
      throw new PreviewError({ message: "CloudRun.Preview: tool_failed: service has no traffic receipt" })
    }
    return value
  }
  let service = serviceDocument(describe.stdout)
  const directory = await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-cloud-run-login-"))
  let pushed: { readonly digest: string } | { readonly error: string }
  try {
    await Fs.chmod(directory, 0o700)
    // Docker gets no ambient Cloud SDK credential or login configuration.
    const environment = Object.fromEntries(
      Object.entries(options.environment).filter(([key]) => !key.startsWith("CLOUDSDK_"))
    )
    environment["DOCKER_CONFIG"] = directory
    const login = await command(
      docker,
      ["login", "-u", "oauth2accesstoken", "--password-stdin", `https://${attrs.region}-docker.pkg.dev`],
      environment,
      options.root,
      options.signal,
      `${token}\n`
    )
    if (login.exitCode !== 0) throw new PreviewError({ message: "CloudRun.Preview: tool_failed: docker login failed" })
    const repository = `${attrs.repository}/${options.name}`
    pushed = await DockerExec.pushArchive({
      archive: options.archive,
      docker: [docker],
      repository,
      temporaryDirectory: directory,
      references: [`${repository}:${tag}`],
      run: async (argv) => {
        const result = await command(argv[0]!, argv.slice(1), environment, options.root, options.signal)
        return {
          ok: result.exitCode === 0,
          result,
          error: result.exitCode === 0 ? undefined : "CloudRun.Preview: tool_failed: docker transport failed"
        }
      }
    })
    if ("error" in pushed) throw new PreviewError({ message: pushed.error.replaceAll(token, "[credential]") })
  } finally {
    await Fs.rm(directory, { recursive: true, force: true })
  }
  const expires = Math.floor(Date.now() / 1000) +
    Number((attrs.expires ?? "72h").slice(0, -1)) * ((attrs.expires ?? "72h").endsWith("m") ? 60 : 3600)
  let expiresAt = expires
  let traffic = service.status?.traffic?.find((entry) => entry.tag === tag)
  let reused = false
  if (traffic?.revisionName !== undefined) {
    const revision = json<Revision>(
      (await cloud(["run", "revisions", "describe", traffic.revisionName, "--format=json"])).stdout
    )
    if (revision.metadata?.labels?.["smthrs-owner"] !== owner) {
      throw new PreviewError({ message: "CloudRun.Preview: invalid_target: preview tag belongs to another owner" })
    }
    reused = revision.status?.imageDigest === pushed.digest ||
      revision.status?.imageDigest?.endsWith(`@${pushed.digest}`) === true
    reused = reused && !carriesTraffic(service, traffic.revisionName)
    if (reused) {
      const prior = Number(revision.metadata?.labels?.["smthrs-expires"])
      if (
        !Number.isSafeInteger(prior) || prior <= Math.floor(Date.now() / 1000) ||
        prior > Math.floor(Date.now() / 1000) + 168 * 3600
      ) reused = false
      else expiresAt = prior
    }
  }
  // Replace preserves the observed resourceVersion: the API refuses a stale
  // document rather than applying a tag decision made about another writer.
  const mutateTags = async (
    decide: (current: Service) => ReadonlyArray<Traffic> | undefined,
    signal: AbortSignal | null | undefined = options.signal
  ) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = serviceDocument(
        (await cloud(["run", "services", "describe", attrs.service, "--format=json"], true, signal)).stdout
      )
      const traffic = decide(current)
      if (traffic === undefined) return current
      if (!current.metadata?.resourceVersion || current.spec === undefined) {
        throw new PreviewError({ message: "CloudRun.Preview: tool_failed: service has no concurrency version" })
      }
      const directory = await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-cloud-run-service-"))
      try {
        const file = Path.join(directory, "service.json")
        const { status: _status, ...document } = current
        await Fs.writeFile(file, JSON.stringify({ ...document, spec: { ...current.spec, traffic } }), { mode: 0o600 })
        const result = await cloud(["run", "services", "replace", file, "--format=json"], false, signal)
        if (result.exitCode === 0) return current
      } finally {
        await Fs.rm(directory, { recursive: true, force: true })
      }
    }
    throw new PreviewError({ message: "CloudRun.Preview: tool_failed: concurrent service update" })
  }
  const remove = async (name: string, signal: AbortSignal | null | undefined = options.signal) => {
    let safe = false
    await mutateTags((current) => {
      safe = !carriesTraffic(current, name)
      if (!safe) return undefined
      const entries: ReadonlyArray<Traffic> = (current.spec?.traffic ?? current.status?.traffic ?? []).map((
        { url: _url, ...entry }
      ) => entry)
      if (!entries.some((entry) => entry.revisionName === name && entry.tag !== undefined)) return undefined
      return entries.flatMap((entry) => {
        if (entry.revisionName !== name || entry.tag === undefined) return [entry]
        const { tag: _tag, url: _url, ...rest } = entry
        return (rest.percent ?? 0) > 0 ? [rest] : []
      })
    }, signal)
    if (!safe) return false
    await cloud(["run", "revisions", "delete", name], true, signal)
    return true
  }
  let revision: string | undefined
  let mutationStarted = false
  try {
    if (!reused) {
      const env = Object.entries(attrs.env ?? {})
      // gcloud's dictionary syntax permits a custom delimiter; choose one absent
      // from every value so commas and equals signs survive without shell parsing.
      let delimiter = "|"
      while (env.some(([key, value]) => `${key}=${value}`.includes(delimiter))) delimiter += "|"
      readyStarted = performance.now()
      mutationStarted = true
      await cloud([
        "run",
        "deploy",
        attrs.service,
        "--image",
        `${attrs.repository}/${options.name}@${pushed.digest}`,
        "--no-traffic",
        "--no-allow-unauthenticated",
        "--service-account",
        attrs.serviceAccount,
        "--execution-environment",
        "gen2",
        "--no-cpu-throttling",
        "--max-instances",
        "1",
        "--memory",
        "4Gi",
        "--cpu",
        "2",
        "--timeout",
        "3600",
        "--startup-probe",
        "httpGet.path=/readyz",
        "--labels",
        `smthrs-expires=${expires},smthrs-commit=${sha},smthrs-deployment=${deployment},smthrs-owner=${owner}`,
        ...(env.length === 0
          ? ["--clear-env-vars"]
          : ["--set-env-vars", `^${delimiter}^${env.map(([key, value]) => `${key}=${value}`).join(delimiter)}`])
      ])
      const rows = json<ReadonlyArray<Revision>>(
        (await cloud(["run", "revisions", "list", "--service", attrs.service, "--format=json"])).stdout
      )
      const owned = rows.filter((row) =>
        row.metadata?.labels?.["smthrs-owner"] === owner && row.metadata?.labels?.["smthrs-deployment"] === deployment
      )
      if (owned.length !== 1 || owned[0]?.metadata?.name === undefined) {
        throw new PreviewError({ message: "CloudRun.Preview: tool_failed: deployment identity missing" })
      }
      const ownedName = owned[0].metadata.name
      revision = ownedName
      await mutateTags((current) => {
        const entries: ReadonlyArray<Traffic> = (current.spec?.traffic ?? current.status?.traffic ?? []).map((
          { url: _url, ...entry }
        ) => entry)
        const existing = entries.find((entry) => entry.tag === tag)
        // A tag that moved since preflight belongs to the concurrent writer.
        if (
          existing !== undefined && existing.revisionName !== traffic?.revisionName &&
          existing.revisionName !== ownedName
        ) {
          throw new PreviewError({
            message: "CloudRun.Preview: invalid_target: preview tag moved to another deployment"
          })
        }
        return [
          ...entries.flatMap((entry) => {
            const { url: _url, ...writable } = entry
            if (entry.tag !== tag) return [writable]
            const { tag: _tag, ...allocation } = writable
            return (allocation.percent ?? 0) > 0 ? [allocation] : []
          }),
          { tag, revisionName: ownedName, percent: 0 }
        ]
      })
      service = serviceDocument((await cloud(["run", "services", "describe", attrs.service, "--format=json"])).stdout)
      traffic = service.status?.traffic?.find((entry) => entry.tag === tag)
    } else {
      readyStarted = performance.now()
      const expected = traffic?.revisionName
      service = serviceDocument((await cloud(["run", "services", "describe", attrs.service, "--format=json"])).stdout)
      traffic = service.status?.traffic?.find((entry) => entry.tag === tag)
      if (traffic?.revisionName !== expected) {
        throw new PreviewError({ message: "CloudRun.Preview: invalid_target: preview tag moved to another deployment" })
      }
    }
    revision = traffic?.revisionName
    if (revision === undefined) {
      throw new PreviewError({ message: "CloudRun.Preview: tool_failed: preview revision missing" })
    }
    readySeconds = (performance.now() - readyStarted) / 1000
    const actual = json<Revision>((await cloud(["run", "revisions", "describe", revision, "--format=json"])).stdout)
    if (
      actual.metadata?.labels?.["smthrs-owner"] !== owner ||
      (!reused && actual.metadata?.labels?.["smthrs-deployment"] !== deployment) ||
      !(actual.status?.imageDigest === pushed.digest || actual.status?.imageDigest?.endsWith(`@${pushed.digest}`))
    ) {
      throw new PreviewError({ message: "CloudRun.Preview: invalid_target: preview revision identity differs" })
    }
    let privateSurface = false
    try {
      if (traffic?.url !== undefined) {
        const response = await fetch(traffic.url, {
          redirect: "manual",
          signal: AbortSignal.any([
            AbortSignal.timeout(30_000),
            ...(options.signal === undefined ? [] : [options.signal])
          ])
        })
        privateSurface = response.status === 401 || response.status === 403
        await response.body?.cancel()
      }
    } catch { /* Missing or unreachable private proof fails closed. */ }
    if (!privateSurface || revision === undefined) {
      throw new PreviewError({ message: "CloudRun.Preview: public_surface: anonymous probe did not refuse access" })
    }
  } catch (cause) {
    let cleanupFailed = false
    const cleanupSignal = AbortSignal.timeout(30_000)
    try {
      // An uncertain deploy is identified by its unique mutation label, never
      // by a tag or expiry alone. Reuse cleanup also requires stable ownership.
      const rows = json<ReadonlyArray<Revision>>(
        (await cloud(
          [
            "run",
            "revisions",
            "list",
            "--service",
            attrs.service,
            "--format=json"
          ],
          true,
          cleanupSignal
        )).stdout
      )
      if (!Array.isArray(rows)) {
        throw new PreviewError({ message: "CloudRun.Preview: cleanup_failed: invalid revision list" })
      }
      const owned = rows.filter((row) =>
        row.metadata?.labels?.["smthrs-owner"] === owner && (
          mutationStarted ? row.metadata?.labels?.["smthrs-deployment"] === deployment : row.metadata?.name === revision
        )
      )
      if (owned.length === 0) cleanupFailed = true
      for (const row of owned) {
        const name = row.metadata?.name
        if (name === undefined || carriesTraffic(service, name)) {
          cleanupFailed = true
          continue
        }
        try {
          if (!await remove(name, cleanupSignal)) cleanupFailed = true
        } catch {
          cleanupFailed = true
        }
      }
    } catch {
      cleanupFailed = true
    }
    throw new PreviewError({
      message: `${cause instanceof Error ? cause.message : "CloudRun.Preview: tool_failed"}${
        cleanupFailed ? "; cleanup failed" : ""
      }`
    })
  }
  const revisions = json<ReadonlyArray<Revision>>(
    (await cloud(["run", "revisions", "list", "--service", attrs.service, "--format=json"])).stdout
  )
  if (!Array.isArray(revisions)) {
    throw new PreviewError({ message: "CloudRun.Preview: tool_failed: malformed revision list" })
  }
  service = serviceDocument((await cloud(["run", "services", "describe", attrs.service, "--format=json"])).stdout)
  const swept: Array<string> = []
  for (const row of revisions) {
    const name = row.metadata?.name
    const labels = row.metadata?.labels
    const expiration = Number(labels?.["smthrs-expires"])
    if (
      name === undefined || name === revision || labels?.["smthrs-owner"] !== owner ||
      !/^[a-f0-9]{7}$/.test(labels?.["smthrs-commit"] ?? "") ||
      !/^\d+$/.test(labels?.["smthrs-expires"] ?? "") || !Number.isSafeInteger(expiration) ||
      expiration > Math.floor(Date.now() / 1000) || carriesTraffic(service, name)
    ) continue
    if (!await remove(name)) continue
    swept.push(name)
  }
  const finalService = serviceDocument(
    (await cloud(["run", "services", "describe", attrs.service, "--format=json"])).stdout
  )
  if (finalService.status?.traffic?.find((entry) => entry.tag === tag)?.revisionName !== revision) {
    throw new PreviewError({ message: "CloudRun.Preview: invalid_target: preview tag moved to another deployment" })
  }
  const receipt: Receipt = {
    version: 1,
    label: options.label,
    commit: options.commit,
    revision: sha,
    tag,
    project: attrs.project,
    region: attrs.region,
    service: attrs.service,
    imageDigest: pushed.digest,
    access: "private",
    expiresAt: new Date(expiresAt * 1000).toISOString().replace(".000Z", "Z"),
    open: {
      command:
        `gcloud run services proxy ${attrs.service} --tag ${tag} --region ${attrs.region} --project ${attrs.project} --port 4100`,
      localUrl: "http://preview.localhost:4100"
    },
    measured: {
      imageBytes: (await Fs.stat(options.archive)).size,
      buildSeconds: options.buildSeconds,
      readySeconds
    },
    swept
  }
  const destination = Path.join(options.root, options.packagePath, "cloud-run-preview")
  await Fs.mkdir(destination, { recursive: true })
  await Fs.writeFile(Path.join(destination, `${options.name}.json`), `${JSON.stringify(receipt, null, 2)}\n`, {
    mode: 0o600
  })
  return receipt
}
