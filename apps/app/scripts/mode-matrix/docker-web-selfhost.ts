import { fixtureProtocolId } from "../../e2e/real/support/values"
import { createHash, randomUUID } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import type { ExecutionReceipt, ModeConfig } from "../../e2e/real/coverage/matrix"
import { ownerSeed } from "./owner-seed"

export type CommandStatus = "passed" | "failed"

export interface LaunchCommandReceipt {
  readonly label: string
  readonly status: CommandStatus
  readonly exitCode: number
  readonly detail?: string
}

export interface WebSelfhostLaunchReport {
  readonly mode: "web-selfhost"
  readonly revision: string
  readonly startedAt: string
  readonly finishedAt?: string
  readonly status: "starting" | "ready" | "failed" | "stopped"
  readonly resources: WebSelfhostResources
  readonly subscriptionConnections: boolean
  readonly commands: readonly LaunchCommandReceipt[]
  readonly readiness: readonly ReadinessObservation[]
  readonly failure?: string
  readonly teardownFailures?: readonly string[]
}

export interface WebSelfhostResources {
  readonly runId: string
  readonly image: string
  readonly network: string
  readonly postgresContainer: string
  readonly appContainer: string
  readonly postgresVolume: string
  readonly dataVolume: string
  readonly database: string
  readonly hostPort: number
}

export interface ReadinessObservation {
  readonly path: string
  readonly status?: number
  readonly error?: string
}

export interface CommandResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

export type CommandExecutor = (args: readonly string[]) => Promise<CommandResult>
export type LaunchFetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export interface WebSelfhostLaunchOptions {
  readonly rootDir: string
  readonly revision: string
  readonly outputDir: string
  readonly authEnvironment?: string
  readonly image?: string
  /** Opt in only for the self-hosted coding-account acceptance lane. */
  readonly subscriptionConnections?: boolean
  readonly executor?: CommandExecutor
  readonly fetcher?: LaunchFetcher
  readonly now?: () => Date
  readonly wait?: (milliseconds: number) => Promise<void>
}

export interface WebSelfhostSession {
  readonly modeConfig: ModeConfig
  readonly receipt: ExecutionReceipt
  readonly runtimeEnvironment: Readonly<Record<string, string>>
  readonly reportPath: string
  readonly close: () => Promise<void>
}

const safeTail = (value: string): string => value.trim().slice(-4_000)

export const executeCommand = async (args: readonly string[], cwd = process.cwd()): Promise<CommandResult> => {
  const child = Bun.spawn([...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited
  ])
  return { exitCode, stdout, stderr }
}

// PostgreSQL identifiers are limited to 63 bytes. Keep enough room for the
// fixed `smithers_matrix_` prefix while retaining a useful run discriminator.
const slug = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40)

export const webSelfhostResources = (id: string = randomUUID()): WebSelfhostResources => {
  const runId = slug(id)
  if (runId === "") throw new Error("web-selfhost launch id must contain a letter or number")
  const prefix = fixtureProtocolId(`smithers-matrix-${runId}`)
  const hostPort = 20_000 + (createHash("sha256").update(runId).digest().readUInt16BE(0) % 40_000)
  return {
    runId,
    image: `${prefix}:test`,
    network: `${prefix}-network`,
    postgresContainer: `${prefix}-postgres`,
    appContainer: `${prefix}-app`,
    postgresVolume: `${prefix}-postgres-data`,
    dataVolume: `${prefix}-app-data`,
    database: `smithers_matrix_${runId.replace(/-/g, "_")}`,
    hostPort
  }
}

const writeJson = (path: string, value: unknown): void => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
}

const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error)

class LaunchFailure extends Error {
  constructor(readonly label: string, readonly result: CommandResult) {
    const detail = safeTail(result.stderr || result.stdout) || `exit ${result.exitCode}`
    super(`${label} failed (exit ${result.exitCode}): ${detail}`)
  }
}

const parsePublishedPort = (value: string): number => {
  const match = /(?:^|\n)(?:127\.0\.0\.1|0\.0\.0\.0|\[::\]):([0-9]+)(?:\s|$)/m.exec(value.trim())
  const port = Number(match?.[1])
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`Docker did not publish a readable loopback port: ${value.trim()}`)
  return port
}

const markerFrom = (value: string): string => value.trim().split(/\s+/).at(-1) ?? ""

const provesDockerResourceAbsent = (args: readonly string[], detail: string): boolean => {
  if (args[0] !== "docker" || args[2] !== "inspect") return false
  switch (args[1]) {
    case "container": return /no such container(?::|\b)/i.test(detail)
    case "volume": return /no such volume(?::|\b)/i.test(detail)
    case "network": return /(?:no such network(?::|\b)|network\s+\S+\s+not found)/i.test(detail)
    case "image": return /no such image(?::|\b)/i.test(detail)
    default: return false
  }
}

export const startPackagedWebSelfhost = async (options: WebSelfhostLaunchOptions): Promise<WebSelfhostSession> => {
  if (!/^[0-9a-f]{40,64}$/.test(options.revision)) throw new Error("web-selfhost launcher requires an exact revision")
  const generated = webSelfhostResources()
  if (options.image !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]+$/.test(options.image)) {
    throw new Error("web-selfhost image must be a Docker image tag")
  }
  const resources = { ...generated, image: options.image ?? generated.image }
  const executor = options.executor ?? ((args: readonly string[]) => executeCommand(args, options.rootDir))
  const fetcher = options.fetcher ?? fetch
  const wait = options.wait ?? ((milliseconds: number) => new Promise<void>((resolveWait) => setTimeout(resolveWait, milliseconds)))
  const now = options.now ?? (() => new Date())
  const reportPath = resolve(options.outputDir, "web-selfhost.launch.json")
  const receiptPath = resolve(options.outputDir, "web-selfhost.execution.json")
  const commands: LaunchCommandReceipt[] = []
  const readiness: ReadinessObservation[] = []
  const databasePassword = randomUUID()
  const owner = ownerSeed("matrix-owner")
  const authEnvironment = options.authEnvironment ?? "SMITHERS_SELFHOST_OWNER_TOKEN"
  const runtimeEnvironment = { [authEnvironment]: owner.token }
  const databaseURL = `postgres://smithers:${encodeURIComponent(databasePassword)}@${resources.postgresContainer}:5432/${resources.database}?sslmode=disable`
  const expectedOrigin = `http://127.0.0.1:${resources.hostPort}`
  const persistenceMarker = randomUUID()
  const markerPath = `/var/lib/smithers/.matrix-restart-${persistenceMarker}`
  const startedAt = now().toISOString()
  let status: WebSelfhostLaunchReport["status"] = "starting"
  let failure: string | undefined
  let origin: string | undefined
  let closed = false
  let imageBuilt = false
  let networkCreated = false
  let postgresVolumeCreated = false
  let dataVolumeCreated = false
  let postgresContainerCreated = false
  let appContainerCreated = false
  const redact = (value: string): string => value
    .replaceAll(databasePassword, "[redacted]")
    .replaceAll(owner.token, "[redacted]")

  const report = (extra: Partial<Pick<WebSelfhostLaunchReport, "finishedAt" | "teardownFailures">> = {}): void => writeJson(reportPath, {
    mode: "web-selfhost",
    revision: options.revision,
    startedAt,
    status,
    resources,
    subscriptionConnections: options.subscriptionConnections === true,
    commands,
    readiness,
    ...(failure === undefined ? {} : { failure }),
    ...extra
  } satisfies WebSelfhostLaunchReport)

  const run = async (label: string, args: readonly string[]): Promise<CommandResult> => {
    const result = await executor(args)
    const detail = result.exitCode === 0 ? undefined : safeTail(redact(result.stderr || result.stdout))
    commands.push({ label, status: result.exitCode === 0 ? "passed" : "failed", exitCode: result.exitCode, ...(detail ? { detail } : {}) })
    report()
    if (result.exitCode !== 0) throw new LaunchFailure(label, { ...result, stdout: redact(result.stdout), stderr: redact(result.stderr) })
    return result
  }

  const absent = async (label: string, args: readonly string[]): Promise<boolean> => {
    const result = await executor(args)
    if (result.exitCode === 0) {
      commands.push({ label, status: "failed", exitCode: result.exitCode, detail: "the unique launch resource already existed" })
      report()
      return false
    }
    const detail = safeTail(redact(result.stderr || result.stdout))
    if (!provesDockerResourceAbsent(args, detail)) {
      commands.push({ label, status: "failed", exitCode: result.exitCode, ...(detail ? { detail } : {}) })
      report()
      throw new LaunchFailure(label, {
        ...result,
        stdout: redact(result.stdout),
        stderr: redact(result.stderr)
      })
    }
    commands.push({ label, status: "passed", exitCode: result.exitCode })
    report()
    return true
  }

  const cleanup = async (): Promise<void> => {
    if (closed) return
    closed = true
    const failures: string[] = []
    const remove = async (label: string, args: readonly string[]): Promise<void> => {
      const result = await executor(args)
      if (result.exitCode !== 0) {
        const detail = safeTail(redact(result.stderr || result.stdout))
        failures.push(`${label}: ${detail || `exit ${result.exitCode}`}`)
      }
      commands.push({ label, status: result.exitCode === 0 ? "passed" : "failed", exitCode: result.exitCode,
        ...(result.exitCode === 0 ? {} : { detail: failures.at(-1) }) })
    }
    if (appContainerCreated) await remove("remove app container", ["docker", "container", "rm", "--force", resources.appContainer])
    if (postgresContainerCreated) await remove("remove PostgreSQL container", ["docker", "container", "rm", "--force", resources.postgresContainer])
    if (dataVolumeCreated) await remove("remove app data volume", ["docker", "volume", "rm", resources.dataVolume])
    if (postgresVolumeCreated) await remove("remove PostgreSQL volume", ["docker", "volume", "rm", resources.postgresVolume])
    if (networkCreated) await remove("remove launch network", ["docker", "network", "rm", resources.network])
    if (imageBuilt) await remove("remove launch image", ["docker", "image", "rm", resources.image])
    if (failures.length > 0) status = "failed"
    else if (status !== "failed") status = "stopped"
    if (failures.length > 0) failure ??= "packaged web-selfhost teardown failed"
    report({ finishedAt: now().toISOString(), ...(failures.length === 0 ? {} : { teardownFailures: failures }) })
    if (failures.length > 0) throw new AggregateError(failures.map((message) => new Error(message)), "packaged web-selfhost teardown failed")
  }

  const waitForPostgres = async (): Promise<void> => {
    let last = "PostgreSQL did not answer"
    for (let attempt = 0; attempt < 90; attempt += 1) {
      // Initialization briefly exposes a socket-only server; the app needs the final TCP listener.
      const result = await executor(["docker", "exec", resources.postgresContainer, "pg_isready", "-h", "127.0.0.1", "-U", "smithers", "-d", resources.database])
      if (result.exitCode === 0) {
        commands.push({ label: "wait for PostgreSQL readiness", status: "passed", exitCode: 0 })
        report()
        return
      }
      last = safeTail(result.stderr || result.stdout) || last
      await wait(1_000)
    }
    const result = { exitCode: 1, stdout: "", stderr: last }
    commands.push({ label: "wait for PostgreSQL readiness", status: "failed", exitCode: 1, detail: last })
    report()
    throw new LaunchFailure("wait for PostgreSQL readiness", result)
  }

  const observeReadiness = async (candidateOrigin: string): Promise<void> => {
    let last: ReadinessObservation[] = []
    for (let attempt = 0; attempt < 180; attempt += 1) {
      const observed: ReadinessObservation[] = []
      let allReady = true
      for (const path of ["/readyz", "/api/health", "/api/bootstrap"] as const) {
        try {
          const response = await fetcher(new URL(path, candidateOrigin), { signal: AbortSignal.timeout(3_000) })
          observed.push({ path, status: response.status })
          if (!response.ok) allReady = false
          if (path === "/api/bootstrap" && response.ok) {
            const body = await response.json().catch(() => undefined) as { readonly host?: unknown; readonly capabilities?: unknown } | undefined
            if (body === undefined || typeof body.host !== "string" || !Array.isArray(body.capabilities)) allReady = false
          }
        } catch (error) {
          observed.push({ path, error: errorText(error) })
          allReady = false
        }
      }
      last = observed
      if (allReady) {
        readiness.push(...observed)
        report()
        return
      }
      await wait(1_000)
    }
    readiness.push(...last)
    const logs = await executor(["docker", "logs", "--tail", "200", resources.appContainer])
    const detail = safeTail(redact(logs.stderr || logs.stdout))
    const result = { exitCode: 1, stdout: "", stderr: `readiness timed out${detail ? `; app logs: ${detail}` : ""}` }
    commands.push({ label: "wait for product readiness", status: "failed", exitCode: 1, detail: result.stderr })
    report()
    throw new LaunchFailure("wait for product readiness", result)
  }

  report()
  try {
    const fresh = (await Promise.all([
      absent("prove app container is fresh", ["docker", "container", "inspect", resources.appContainer]),
      absent("prove PostgreSQL container is fresh", ["docker", "container", "inspect", resources.postgresContainer]),
      absent("prove app volume is fresh", ["docker", "volume", "inspect", resources.dataVolume]),
      absent("prove PostgreSQL volume is fresh", ["docker", "volume", "inspect", resources.postgresVolume]),
      absent("prove network is fresh", ["docker", "network", "inspect", resources.network]),
      ...(options.image === undefined ? [absent("prove image tag is fresh", ["docker", "image", "inspect", resources.image])] : [])
    ])).every(Boolean)
    if (!fresh) throw new Error("one or more unique Docker launch resources already existed")

    await run("create launch network", ["docker", "network", "create", resources.network])
    networkCreated = true
    await run("create PostgreSQL volume", ["docker", "volume", "create", resources.postgresVolume])
    postgresVolumeCreated = true
    await run("create app data volume", ["docker", "volume", "create", resources.dataVolume])
    dataVolumeCreated = true
    if (options.image === undefined) {
      await run("build packaged product image", [
        "docker", "build", "--file", "distribution/Dockerfile", "--tag", resources.image,
        "--build-arg", `BUILD_SHA=${options.revision}`,
        "--build-arg", `SMITHERS_DISTRIBUTION_VERSION=matrix-${options.revision.slice(0, 12)}`, "."
      ])
      imageBuilt = true
    } else {
      await run("verify packaged product image", ["docker", "image", "inspect", resources.image])
    }
    await run("start isolated PostgreSQL", [
      "docker", "run", "--detach", "--name", resources.postgresContainer, "--network", resources.network,
      "--env", "POSTGRES_USER=smithers", "--env", `POSTGRES_PASSWORD=${databasePassword}`, "--env", `POSTGRES_DB=${resources.database}`,
      "--volume", `${resources.postgresVolume}:/var/lib/postgresql`, "postgres:18.6-bookworm"
    ])
    postgresContainerCreated = true
    await waitForPostgres()
    await run("start packaged product", [
      "docker", "run", "--detach", "--name", resources.appContainer, "--network", resources.network,
      "--add-host", "host.docker.internal:host-gateway",
      "--publish", `127.0.0.1:${resources.hostPort}:4000`, "--env", `SMITHERS_DATABASE_URL=${databaseURL}`,
      "--env", "SMITHERS_AUTH_MODE=selfhost",
      ...(options.subscriptionConnections === true ? ["--env", "SMITHERS_FEATURE_FLAGS_SUBSCRIPTION_CONNECTIONS=true"] : []),
	  "--env", `AI_GATEWAY_API_KEY=matrix-flow-${randomUUID()}`,
      "--env", `SMITHERS_PUBLIC_URL=${expectedOrigin}`,
      "--volume", `${resources.dataVolume}:/var/lib/smithers`, resources.image
    ])
    appContainerCreated = true
    const port = parsePublishedPort((await run("read packaged product port", ["docker", "port", resources.appContainer, "4000/tcp"])).stdout)
    if (port !== resources.hostPort) throw new Error(`Docker published unexpected product port ${port}; expected ${resources.hostPort}`)
    origin = expectedOrigin
    await observeReadiness(origin)
    await run("seed matrix owner", [
      "docker", "exec", resources.postgresContainer, "psql", "-U", "smithers", "-d", resources.database,
      "-v", "ON_ERROR_STOP=1", "-Atqc", owner.sql
    ])

    const beforeDatabase = markerFrom((await run("write database restart marker", [
      "docker", "exec", resources.postgresContainer, "psql", "-U", "smithers", "-d", resources.database, "-Atqc",
      `CREATE TABLE IF NOT EXISTS smithers_matrix_restart_receipt (marker text PRIMARY KEY); INSERT INTO smithers_matrix_restart_receipt(marker) VALUES ('${persistenceMarker}') ON CONFLICT DO NOTHING; SELECT marker FROM smithers_matrix_restart_receipt WHERE marker='${persistenceMarker}';`
    ])).stdout)
    await run("write app-volume restart marker", ["docker", "exec", resources.appContainer, "touch", markerPath])
    const beforeDataVolume = persistenceMarker

    await run("restart packaged product", ["docker", "restart", resources.appContainer])
    readiness.length = 0
    await observeReadiness(origin)
    const afterDatabase = markerFrom((await run("read database restart marker", [
      "docker", "exec", resources.postgresContainer, "psql", "-U", "smithers", "-d", resources.database, "-Atqc",
      `SELECT marker FROM smithers_matrix_restart_receipt WHERE marker='${persistenceMarker}';`
    ])).stdout)
    await run("read app-volume restart marker", ["docker", "exec", resources.appContainer, "test", "-f", markerPath])
    const afterDataVolume = persistenceMarker
    const dataPreserved = beforeDatabase === persistenceMarker && afterDatabase === persistenceMarker && beforeDataVolume === afterDataVolume
    if (!dataPreserved) throw new Error("database or app-volume restart marker changed")

    const receipt: ExecutionReceipt = {
      mode: "web-selfhost",
      revision: options.revision,
      origin, endpoint: origin,
      ready: true,
      startedRoles: ["docker-app", "postgres"],
      freshLaunch: fresh,
      restarted: true,
      dataPreserved,
      persistenceProof: {
        database: { before: beforeDatabase, after: afterDatabase },
        dataVolume: { before: beforeDataVolume, after: afterDataVolume }
      },
      observedAt: now().toISOString()
    }
    writeJson(receiptPath, receipt)
    status = "ready"
    report({ finishedAt: now().toISOString() })
    return {
      receipt,
      runtimeEnvironment,
      reportPath,
      modeConfig: {
        mode: "web-selfhost",
        origin, endpoint: origin,
        auth: { kind: "owner-token", environment: authEnvironment },
        executionReceipt: receiptPath
      },
      close: cleanup
    }
  } catch (error) {
    failure = redact(errorText(error))
    status = "failed"
    report({ finishedAt: now().toISOString() })
    try {
      await cleanup()
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "packaged web-selfhost launch and teardown failed")
    }
    throw error
  }
}
