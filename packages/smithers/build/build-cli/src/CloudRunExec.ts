/**
 * The private Cloud Run preview transport. Credentials stay in captured
 * gcloud output and Docker login stdin; subprocess output is never reported.
 * @since 1.0.0
 */

import type * as CloudRun from "@smthrs/targets/CloudRun"
import * as Data from "effect/Data"
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
}> {}

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

/** A versioned receipt consumed by the preview flow.
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
  const started = performance.now()
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
  const auth = await command(
    gcloud,
    ["auth", "print-access-token", `--impersonate-service-account=${attrs.deployer}`],
    { ...options.environment },
    options.root,
    options.signal
  )
  const token = auth.stdout.trim()
  if (auth.exitCode !== 0 || token === "" || /[\r\n]/.test(token)) {
    throw new PreviewError({ message: "CloudRun.Preview: tool_failed: token acquisition failed" })
  }
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
  const expires = Math.floor(Date.now() / 1000) + Number((attrs.expires ?? "72h").slice(0, -1)) * 3600
  let expiresAt = expires
  let traffic = service.status?.traffic?.find((entry) => entry.tag === tag)
  let reused = false
  if (traffic?.revisionName !== undefined) {
    const revision = json<Revision>(
      (await cloud(["run", "revisions", "describe", traffic.revisionName, "--format=json"])).stdout
    )
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
  if (!reused) {
    const env = Object.entries(attrs.env ?? {})
    // gcloud's dictionary syntax permits a custom delimiter; choose one absent
    // from every value so commas and equals signs survive without shell parsing.
    let delimiter = "|"
    while (env.some(([key, value]) => `${key}=${value}`.includes(delimiter))) delimiter += "|"
    await cloud([
      "run",
      "deploy",
      attrs.service,
      "--image",
      `${attrs.repository}/${options.name}@${pushed.digest}`,
      "--tag",
      tag,
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
      `smthrs-expires=${expires},smthrs-commit=${sha}`,
      "--set-env-vars",
      env.length === 0 ? "" : `^${delimiter}^${env.map(([key, value]) => `${key}=${value}`).join(delimiter)}`
    ])
    service = serviceDocument((await cloud(["run", "services", "describe", attrs.service, "--format=json"])).stdout)
    traffic = service.status?.traffic?.find((entry) => entry.tag === tag)
  }
  const revision = traffic?.revisionName
  const remove = async (
    tags: ReadonlyArray<string>,
    name: string,
    signal: AbortSignal | null | undefined = options.signal
  ) => {
    if (tags.length > 0) {
      await cloud(["run", "services", "update-traffic", attrs.service, "--remove-tags", tags.join(",")], true, signal)
    }
    await cloud(["run", "revisions", "delete", name], true, signal)
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
    let cleanupFailed = false
    try {
      await cloud(["run", "services", "update-traffic", attrs.service, "--remove-tags", tag], true, null)
    } catch {
      cleanupFailed = true
    }
    if (revision !== undefined) {
      try {
        await cloud(["run", "revisions", "delete", revision], true, null)
      } catch {
        cleanupFailed = true
      }
    } else cleanupFailed = true
    throw new PreviewError({
      message: `CloudRun.Preview: public_surface: anonymous probe did not refuse access${
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
    const entries = service.status?.traffic ?? []
    if (
      name === undefined || name === revision || !/^[a-f0-9]{7}$/.test(labels?.["smthrs-commit"] ?? "") ||
      !/^\d+$/.test(labels?.["smthrs-expires"] ?? "") || !Number.isSafeInteger(expiration) ||
      expiration > Math.floor(Date.now() / 1000) || carriesTraffic(service, name)
    ) continue
    await remove(
      entries.filter((entry) => entry.revisionName === name && entry.tag !== undefined).map((entry) => entry.tag!),
      name
    )
    swept.push(name)
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
      readySeconds: (performance.now() - started) / 1000
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
