/**
 * Builds an AWS Fargate sandbox provider.
 *
 * @since 0.1.0
 */

import * as CommandLine from "@smthrs/kernel/CommandLine"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import type { Scope } from "effect/Scope"
import * as Stream from "effect/Stream"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { attemptIn } from "../internal/attempt.ts"
import { decodeBase64, encodeBase64 } from "../internal/base64.ts"
import { configurationFingerprint } from "../internal/configurationFingerprint.ts"
import { environmentInput } from "../internal/environmentInput.ts"
import { checkEnvironmentNames } from "../internal/environmentNames.ts"
import { envPrefix } from "../internal/envPrefix.ts"
import { finalizeWithin } from "../internal/finalizeWithin.ts"
import { parentOf } from "../internal/guestPath.ts"
import { cancelledStatus, cancelMarker, killScript } from "../internal/killScript.ts"
import { gather, type GatheredRun, providerFailure } from "../internal/localProcess.ts"
import { pidDirectory } from "../internal/pidDirectory.ts"
import { rootedAt } from "../internal/rootedPath.ts"
import { sessionSlug } from "../internal/sessionSlug.ts"
import { stdinRedirect } from "../internal/stdinRedirect.ts"
import { warnTeardown } from "../internal/teardownWarning.ts"
import type { RemoteProcess } from "../RemoteChildProcessSpawner/Provider.ts"
import { ProviderError } from "../RemoteChildProcessSpawner/ProviderError.ts"
import { type NetworkPolicy, refuseNetworkPolicy } from "../Sandbox/NetworkPolicy.ts"
import type { Provider } from "../Sandbox/Provider.ts"
import { refuseResourceLimits, type ResourceLimits } from "../Sandbox/ResourceLimits.ts"
import type { Session } from "../Sandbox/Session.ts"
import type { ExecTransport } from "./ExecTransport.ts"
import type { Sdk } from "./Sdk.ts"

/**
 * What every AWS session needs, whichever way its task definition is named.
 *
 * @category models
 * @since 0.1.0
 */
export interface AwsSandboxCommonOptions {
  /**
   * Refused: ECS subnets and security groups are not a host allowlist. Setting it makes `make` throw rather than hand out a
   * machine with a network it did not ask for.
   */
  readonly network?: NetworkPolicy | undefined
  /**
   * The task's ceilings. With `image`, `cpus` becomes the task definition's
   * `cpu` units (1024 per vCPU) and `memoryMib` its `memory`, each exclusive
   * with the vendor-named option; Fargate accepts only its listed pairs.
   * `timeoutSecs` replaces the essential container's `sleep infinity` with
   * `sleep <timeoutSecs>`, so the task stops that long after it starts. A
   * `taskDefinition` fixes all three, so they are refused there.
   */
  readonly limits?: ResourceLimits | undefined
  readonly sdk: Sdk
  /**
   * How commands reach the task. Without it the provider provisions and tears
   * down tasks but refuses to run anything in them, because the ECS API alone
   * cannot; see {@link ExecTransport}.
   */
  readonly exec?: ExecTransport | undefined
  readonly region: string
  readonly cluster: string
  readonly subnets: ReadonlyArray<string>
  readonly securityGroups?: ReadonlyArray<string> | undefined
  readonly assignPublicIp?: boolean | undefined
  readonly container?: string | undefined
  readonly workdir?: string | undefined
  readonly platformVersion?: string | undefined
  readonly taskRoleArn?: string | undefined
  readonly executionRoleArn?: string | undefined
  readonly env?: Readonly<Record<string, string>> | undefined
  readonly pollIntervalMs?: number | undefined
  readonly maxPollAttempts?: number | undefined
}

/**
 * The arm that runs an existing task definition.
 *
 * @category models
 * @since 0.1.0
 */
export interface AwsSandboxTaskDefinitionOptions extends AwsSandboxCommonOptions {
  readonly taskDefinition: string
  readonly image?: never
}

/**
 * The arm that registers a task definition for an image.
 *
 * @category models
 * @since 0.1.0
 */
export interface AwsSandboxImageOptions extends AwsSandboxCommonOptions {
  readonly image: string
  readonly taskDefinition?: never
  readonly taskRoleArn: string
  readonly cpu?: string | undefined
  readonly memory?: string | undefined
}

/**
 * How the provider reaches ECS and shapes each session's task: either an
 * existing task definition or an image the provider registers one for.
 *
 * @category models
 * @since 0.1.0
 */
export type AwsSandboxOptions = AwsSandboxTaskDefinitionOptions | AwsSandboxImageOptions

type RunTaskOutput = Awaited<ReturnType<Sdk["runTask"]>>
type DescribeTasksOutput = Awaited<ReturnType<Sdk["describeTasks"]>>
type Task = NonNullable<DescribeTasksOutput["tasks"]>[number]
type RegisterTaskDefinitionOutput = Awaited<ReturnType<Sdk["registerTaskDefinition"]>>

const failure = (code: ProviderError["code"], message: string, cause?: unknown): ProviderError =>
  new ProviderError({ code, message: `aws sandbox: ${message}`, cause })

const attempt = attemptIn("aws sandbox")

const fingerprintTag = "smithers.dev/sandbox-fingerprint"

const startedByOf = (session: string): string => {
  const slug = sessionSlug(session).replaceAll(/[^A-Za-z0-9/_-]/g, "-")
  if (slug.length <= 36) return slug
  const separator = slug.lastIndexOf("-")
  const digest = slug.slice(separator + 1)
  return `${slug.slice(0, 35 - digest.length)}-${digest}`
}

const taskArnsOf = (output: RunTaskOutput): ReadonlyArray<string> =>
  (output.tasks ?? []).flatMap((task) => task.taskArn === undefined ? [] : [task.taskArn])

const stopTasks = (options: AwsSandboxOptions, taskArns: ReadonlyArray<string>): Effect.Effect<void> =>
  Effect.forEach(taskArns, (task) =>
    finalizeWithin(
      Effect.ignore(
        attempt(
          () => options.sdk.stopTask({ cluster: options.cluster, task, reason: "Smithers scope released" }),
          "unknown",
          `could not stop ${task}`
        ).pipe(Effect.tapError((error) => warnTeardown("aws", "stopTasks", error)))
      ),
      `aws task ${task}`
    ), { discard: true })

/** A machine a previous acquire of this session key left behind. */
interface Leftover {
  readonly taskArn: string
  readonly taskDefinitionArn: string
  /** Whether its ECS Exec agent already answers, or the adopter must wait for it. */
  readonly ready: boolean
}

/** The most tasks one `DescribeTasks` call accepts. */
const describeBatch = 100

/** Every task ARN `startedBy` lists, following `nextToken` through every page. */
const listedTaskArns = (
  options: AwsSandboxOptions,
  startedBy: string
): Effect.Effect<ReadonlyArray<string>, ProviderError> =>
  Effect.gen(function*() {
    const arns: Array<string> = []
    const seen = new Set<string>()
    let nextToken: string | undefined
    do {
      const token = nextToken
      const page = yield* attempt(
        () =>
          options.sdk.listTasks({
            cluster: options.cluster,
            startedBy,
            ...token === undefined ? {} : { nextToken: token }
          }),
        "unavailable",
        `could not list tasks started by ${startedBy}`
      )
      arns.push(...page.taskArns ?? [])
      nextToken = page.nextToken
      if (nextToken !== undefined) {
        if (seen.has(nextToken)) {
          return yield* Effect.fail(
            failure("unavailable", `the task list for ${startedBy} repeated a page token; it cannot be read to its end`)
          )
        }
        seen.add(nextToken)
      }
    } while (nextToken !== undefined)
    return arns
  })

const definitionFamilyOf = (arn: string): string => arn.slice(arn.lastIndexOf("/") + 1).replace(/:\d+$/, "")

/**
 * The task a previous acquire of this session key left behind, if any, plus
 * every duplicate beside it.
 *
 * `RunTask` tags every task with `startedBy`, which is derived from the key,
 * so a crash-interrupted run can find its machine again instead of starting a
 * second one beside it. The AWS
 * [ListTasks](https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_ListTasks.html)
 * documentation says a PENDING desired-status filter does not return results
 * because ECS never sets a task's desired status to PENDING; only `lastStatus`
 * may be PENDING. It also says `startedBy` must be the only filter when it is
 * specified. This call therefore supplies only `startedBy`. The default desired
 * status is RUNNING, which recovers a crash-left task whose desired status is
 * RUNNING even while its `lastStatus` is still PENDING.
 *
 * Every page of the list is read, following `nextToken`, and described in
 * batches of at most 100. The whole list is ordered by ARN so two racing
 * acquires adopt the same one, and everything after the first is `stale`: a
 * duplicate the caller stops before provisioning, so a key never accumulates
 * machines.
 */
const leftoverTasks = (
  options: AwsSandboxOptions,
  startedBy: string,
  container: string | undefined,
  fingerprint: string
): Effect.Effect<{ readonly adopt: Leftover | undefined; readonly stale: ReadonlyArray<string> }, ProviderError> =>
  Effect.gen(function*() {
    const unique = [...new Set(yield* listedTaskArns(options, startedBy))].sort()
    if (unique.length === 0) return { adopt: undefined, stale: [] }
    const batches: Array<Array<string>> = []
    for (let start = 0; start < unique.length; start += describeBatch) {
      batches.push(unique.slice(start, start + describeBatch))
    }
    const described = (yield* Effect.forEach(batches, (tasks) =>
      attempt(
        () => options.sdk.describeTasks({ cluster: options.cluster, tasks, include: ["TAGS"] }),
        "unavailable",
        `could not describe the tasks started by ${startedBy}`
      ))).flatMap((output) => output.tasks ?? [])
    // Verify every candidate on every page before registering finalizers or
    // stopping duplicates: one foreign task anywhere refuses the whole key.
    const live: Array<Leftover> = []
    for (const arn of unique) {
      const task = described.find((task) => task.taskArn === arn)
      if (task?.lastStatus === "STOPPED") continue
      const definition = options.taskDefinition
      if (
        task === undefined || task.taskDefinitionArn === undefined || task.startedBy !== startedBy ||
        !task.tags?.some((tag) => tag.key === fingerprintTag && tag.value === fingerprint) ||
        (definition === undefined &&
          (!/:\d+$/.test(task.taskDefinitionArn) ||
            definitionFamilyOf(task.taskDefinitionArn) !== `smthrs-${startedBy}`)) ||
        (definition !== undefined && (!/:\d+$/.test(definition) ||
          !(task.taskDefinitionArn === definition ||
            (!definition.startsWith("arn:") && task.taskDefinitionArn.endsWith(`/${definition}`)))))
      ) {
        return yield* Effect.fail(failure("unavailable", `${arn} does not match the requested configuration or owner`))
      }
      live.push({ taskArn: arn, taskDefinitionArn: task.taskDefinitionArn, ready: agentReady(task, container) })
    }
    live.sort((left, right) => left.taskArn.localeCompare(right.taskArn))
    const [first, ...rest] = live
    if (first === undefined) return { adopt: undefined, stale: [] }
    return { adopt: first, stale: rest.map((task) => task.taskArn) }
  })

/** The write-slice size a transport uses when it names none. */
const defaultChunkBytes = 3072

/** Maximum buffered payload per streaming write session. */
const maxChunkBytes = 64 * 1024

/** Validate the loop increment before any file transfer can start. */
const chunkBytesOf = (transport: ExecTransport): Effect.Effect<number, ProviderError> => {
  const chunkBytes = transport.chunkBytes ?? defaultChunkBytes
  return Number.isSafeInteger(chunkBytes) && chunkBytes >= 1 && chunkBytes <= maxChunkBytes
    ? Effect.succeed(chunkBytes)
    : Effect.fail(
      new ProviderError({
        code: "spawn_error",
        message:
          `ExecTransport.chunkBytes must be a whole number of bytes from 1 to ${maxChunkBytes}, not ${chunkBytes}`
      })
    )
}

const registeredArnOf = (output: RegisterTaskDefinitionOutput): string | undefined =>
  output.taskDefinition?.taskDefinitionArn

const deregisterDefinition = (
  options: AwsSandboxImageOptions,
  taskDefinition: string | undefined
): Effect.Effect<void> =>
  taskDefinition === undefined
    ? Effect.void
    : finalizeWithin(
      Effect.ignore(
        attempt(
          () => options.sdk.deregisterTaskDefinition({ taskDefinition }),
          "unknown",
          `could not deregister ${taskDefinition}`
        ).pipe(Effect.tapError((error) => warnTeardown("aws", "deregisterTaskDefinition", error)))
      ),
      `aws task definition ${taskDefinition}`
    )

/** Reclaim older crash-left registrations without touching the adopted revision. */
const deregisterStaleDefinitions = (
  options: AwsSandboxImageOptions,
  startedBy: string,
  adopted: string
): Effect.Effect<void, ProviderError> =>
  Effect.gen(function*() {
    const family = `smthrs-${startedBy}`
    let nextToken: string | undefined
    do {
      const listed = yield* attempt(
        () =>
          options.sdk.listTaskDefinitions({
            familyPrefix: family,
            status: "ACTIVE",
            ...nextToken === undefined ? {} : { nextToken }
          }),
        "unavailable",
        `could not list task definitions for ${family}`
      )
      for (const arn of listed.taskDefinitionArns ?? []) {
        if (arn !== adopted && definitionFamilyOf(arn) === family) {
          yield* deregisterDefinition(options, arn)
        }
      }
      nextToken = listed.nextToken
    } while (nextToken !== undefined)
  })

const agentReady = (task: Task, container: string | undefined): boolean =>
  task.lastStatus === "RUNNING" &&
  task.enableExecuteCommand === true &&
  (task.containers ?? []).some((candidate) =>
    (container === undefined || candidate.name === container) &&
    (candidate.managedAgents ?? []).some((agent) =>
      agent.name === "ExecuteCommandAgent" && agent.lastStatus === "RUNNING"
    )
  )

const describedTask = (output: DescribeTasksOutput, taskArn: string): Task | undefined =>
  output.tasks?.find((task) => task.taskArn === taskArn) ?? output.tasks?.[0]

const describe = (
  options: AwsSandboxOptions,
  taskArn: string
): Effect.Effect<DescribeTasksOutput, ProviderError> =>
  attempt(
    () => options.sdk.describeTasks({ cluster: options.cluster, tasks: [taskArn] }),
    "unavailable",
    `could not describe ${taskArn}`
  )

const awaitReady = (
  options: AwsSandboxOptions,
  taskArn: string,
  container: string | undefined
): Effect.Effect<Task, ProviderError> => {
  const interval = options.pollIntervalMs ?? 1_000
  const attempts = options.maxPollAttempts ?? 60

  const poll = (index: number): Effect.Effect<Task, ProviderError> =>
    Effect.flatMap(describe(options, taskArn), (output) => {
      const task = describedTask(output, taskArn)
      if (task?.lastStatus === "STOPPED") {
        return Effect.fail(failure("unavailable", `${taskArn} stopped before ECS Exec became ready`, task))
      }
      if (task !== undefined && agentReady(task, container)) return Effect.succeed(task)
      if (index + 1 >= attempts) {
        return Effect.fail(failure("timeout", `${taskArn} did not make its ECS Exec agent ready`, output.failures))
      }
      const delay = Math.min(interval * (2 ** index), 10_000)
      return Effect.andThen(Effect.sleep(Duration.millis(delay)), poll(index + 1))
    })

  return poll(0)
}

const registerDefinition = (
  options: AwsSandboxImageOptions,
  startedBy: string,
  workdir: string,
  container: string
): Effect.Effect<string, ProviderError, Scope> =>
  Effect.gen(function*() {
    const output = yield* Effect.acquireRelease(
      attempt(
        () =>
          options.sdk.registerTaskDefinition({
            family: `smthrs-${startedBy}`,
            networkMode: "awsvpc",
            requiresCompatibilities: ["FARGATE"],
            cpu: options.cpu ?? "256",
            memory: options.memory ?? "512",
            taskRoleArn: options.taskRoleArn,
            ...options.executionRoleArn === undefined ? {} : { executionRoleArn: options.executionRoleArn },
            containerDefinitions: [{
              name: container,
              image: options.image,
              essential: true,
              command: [
                "sleep",
                options.limits?.timeoutSecs === undefined ? "infinity" : String(options.limits.timeoutSecs)
              ],
              workingDirectory: workdir,
              linuxParameters: { initProcessEnabled: true }
            }]
          }),
        "unavailable",
        `could not register ${options.image}`
      ),
      (output) => deregisterDefinition(options, registeredArnOf(output))
    )
    const taskDefinition = registeredArnOf(output)
    return taskDefinition === undefined
      ? yield* Effect.fail(failure("unavailable", "RegisterTaskDefinition returned no task definition ARN", output))
      : taskDefinition
  })

const runTask = (
  options: AwsSandboxOptions,
  taskDefinition: string,
  startedBy: string,
  container: string | undefined,
  fingerprint: string
): Effect.Effect<RunTaskOutput, ProviderError> => {
  const roleOverrides = {
    ...options.taskRoleArn === undefined ? {} : { taskRoleArn: options.taskRoleArn },
    ...options.executionRoleArn === undefined ? {} : { executionRoleArn: options.executionRoleArn },
    ...container === undefined || options.env === undefined
      ? {}
      : {
        containerOverrides: [{
          name: container,
          environment: Object.entries(options.env).map(([name, value]) => ({ name, value }))
        }]
      }
  }
  return attempt(
    () =>
      options.sdk.runTask({
        cluster: options.cluster,
        taskDefinition,
        count: 1,
        enableExecuteCommand: true,
        launchType: "FARGATE",
        networkConfiguration: {
          awsvpcConfiguration: {
            subnets: [...options.subnets],
            ...options.securityGroups === undefined ? {} : { securityGroups: [...options.securityGroups] },
            assignPublicIp: options.assignPublicIp === true ? "ENABLED" : "DISABLED"
          }
        },
        startedBy,
        tags: [{ key: fingerprintTag, value: fingerprint }],
        ...options.platformVersion === undefined ? {} : { platformVersion: options.platformVersion },
        ...Object.keys(roleOverrides).length === 0 ? {} : { overrides: roleOverrides }
      }),
    "unavailable",
    `RunTask failed for ${taskDefinition}`
  )
}

const noTransport = (operation: string): ProviderError =>
  failure(
    "unavailable",
    `cannot ${operation}: no command transport was supplied, and the ECS API alone carries no command output; pass \`exec\` (the AWS CLI over a spawner)`
  )

const decoder = new TextDecoder()
const encoder = new TextEncoder()

/**
 * The line a wrapped command prints after it ends, carrying its exit status.
 *
 * `session-manager-plugin` exits zero whatever the remote command did, so the
 * status has to travel in-band. The nonce is 128 random bits per framed run,
 * so it cannot be predicted before the run starts: a per-session counter let
 * guest code print a later run's sentinel ahead of time. It is not secret
 * once the run starts, because it rides on the wrapper's argv, so a process
 * already running in the task can read it and print the sentinel first.
 * `unframe` taking the first sentinel closes only the narrower case of a
 * detached child printing one after the wrapper's own status.
 */
const sentinel = (nonce: string): string => `__smthrs_exit_${nonce}_`

/** A fresh, unguessable sentinel nonce. */
const freshNonce = (): string => {
  const bytes = new Uint8Array(16)
  globalThis.crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
}

/**
 * What the transport handed back once the plugin's own framing is removed.
 * `code` is absent when the session ended without the wrapper's sentinel: the
 * remote shell died or the session dropped, and neither is a success.
 */
interface Unframed {
  readonly payload: string
  readonly code: number | undefined
}

/**
 * Strips the Session Manager banner and footer and reads the sentinel back.
 *
 * The session is a pseudo-terminal, so the plugin prints its own
 * `Starting session with SessionId` line before the command's output and an
 * `Exiting session` line after, and every newline arrives as `\r\n`. The
 * command's output is what lies between the banner and the sentinel.
 *
 * The FIRST sentinel is the wrapper's: it prints once, when the command ends,
 * and anything after it (a detached child that outlived the command, still
 * holding the terminal) is footer, never a second status.
 */
const unframe = (run: GatheredRun, nonce: string): Unframed => {
  const text = decoder.decode(run.stdout).replaceAll("\r\n", "\n")
  const banner = text.match(/^Starting session with SessionId: .*$/m)
  const start = banner === null || banner.index === undefined
    ? 0
    : banner.index + banner[0].length + 1
  const first = new RegExp(`\\n${sentinel(nonce)}(\\d+)__`).exec(text.slice(start))
  if (first === null) return { payload: text.slice(Math.min(start, text.length)), code: undefined }
  return {
    payload: text.slice(start, start + first.index),
    code: Number.parseInt(first[1]!, 10)
  }
}

/**
 * Wraps a one-shot guest script so its status comes back in-band. The
 * subshell keeps an `exit` inside the script from skipping the sentinel. The
 * absolute shell path prevents a task-level PATH override from disabling the
 * provider's own framing, read, write, kill, or preparation plumbing.
 */
const framedScript = (script: string, nonce: string): string =>
  `/bin/sh -c ${CommandLine.quote(`( ${script} ); printf '\\n${sentinel(nonce)}%s__\\n' "$?"`)}`

/**
 * Wraps a spawned command so it can be signalled and still report its status.
 *
 * The command runs as a background job whose pid is recorded for `kill`, and
 * the wrapper waits for it, so a signal delivered to the command lets the
 * wrapper print `128 + signal` rather than taking the sentinel down with it.
 * A `cd` that fails reports 127 the way a shell reports a command it could
 * not start. The absolute wrapper shell prevents a task-level PATH override
 * from disabling the provider's own process framing.
 */
const spawnScript = (
  command: string,
  cwd: string,
  environment: ReturnType<typeof environmentInput>,
  pidfile: string,
  nonce: string
): string =>
  `/bin/sh -c ${
    CommandLine.quote(
      // The first marker check handles a cancellation planted before start. A
      // kill can also plant the marker after this guard, then read an empty
      // pidfile between `cmd & p=$!` and `echo`. Rechecking immediately after
      // the pid write signals that now-recorded command and closes that window.
      environment.script + `if [ -e ${cancelMarker(pidfile)} ]; then c=${cancelledStatus}; ` +
        `elif cd ${CommandLine.quote(cwd)}; then ${environment.prefix}/bin/sh -c ${
          CommandLine.quote(command)
        } & p=$!; ` +
        `echo "$p" > ${pidfile}; if [ -e ${cancelMarker(pidfile)} ]; then kill -s TERM "$p" 2>/dev/null; fi; ` +
        `wait "$p"; c=$?; else c=127; fi; printf '\\n${sentinel(nonce)}%s__\\n' "$c"`
    )
  }`

const withLimits = (options: AwsSandboxOptions): AwsSandboxOptions => {
  const limits = refuseResourceLimits(
    "aws-sandbox",
    options.limits,
    options.taskDefinition === undefined ? [] : ["cpus", "memoryMib", "timeoutSecs"],
    "the task definition fixes CPU, memory, and the container command"
  )
  if (limits === undefined || options.taskDefinition !== undefined) return options
  if (limits.cpus !== undefined && options.cpu !== undefined) {
    throw new TypeError("aws-sandbox: cpu and limits.cpus are exclusive; name one")
  }
  if (limits.memoryMib !== undefined && options.memory !== undefined) {
    throw new TypeError("aws-sandbox: memory and limits.memoryMib are exclusive; name one")
  }
  const units = limits.cpus === undefined ? undefined : limits.cpus * 1024
  if (units !== undefined && !Number.isInteger(units)) {
    throw new TypeError(`aws-sandbox: cannot enforce limits.cpus ${limits.cpus}; ECS counts 1024 cpu units per vCPU`)
  }
  return {
    ...options,
    ...units === undefined ? {} : { cpu: String(units) },
    ...limits.memoryMib === undefined ? {} : { memory: String(limits.memoryMib) }
  }
}

/**
 * Builds a Fargate provider using an injected AWS ECS aggregate client.
 *
 * Acquisition uses `RunTask`, polls `DescribeTasks` until the ECS Exec managed
 * agent is ready, and registers `StopTask` on the acquiring scope. Supplying
 * an image registers a minimal Fargate task definition for a fresh task or
 * reuses an adopted task’s definition, deregistering it after the task finalizer
 * runs. Image recovery also deregisters stale ACTIVE revisions of its family.
 *
 * Commands, reads, and writes travel through {@link ExecTransport}: the AWS
 * CLI and its Session Manager plugin over an injected spawner, because the ECS
 * API returns SSM session metadata and nothing more. Reads come back as
 * base64 and writes go in through streaming stdin as base64 in bounded slices, so bytes survive the
 * pseudo-terminal in both directions; `kill` records each command's guest pid
 * and signals it through a second session. Without a transport the session
 * refuses `spawn`, `readFile`, and `writeFile` explicitly rather than
 * fabricating a process or corrupting bytes.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (input: AwsSandboxOptions): Provider => {
  refuseNetworkPolicy("aws-sandbox", input.network)
  const options = withLimits(input)
  return {
    acquire: (sessionKey) =>
      Effect.gen(function*() {
        if (options.taskDefinition !== undefined && options.env !== undefined && options.container === undefined) {
          return yield* Effect.fail(
            failure("spawn_error", "env overrides for a taskDefinition require a container name")
          )
        }
        const workdir = options.workdir ?? "/workspace"
        const startedBy = startedByOf(sessionKey)
        const { sdk: _sdk, exec: _exec, pollIntervalMs: _poll, maxPollAttempts: _attempts, ...configuration } = options
        const fingerprint = yield* configurationFingerprint({
          ...configuration,
          provider: "AwsSandbox/v1",
          owner: sessionKey
        })
        const imageOptions = options.taskDefinition === undefined ? options : undefined
        const container = options.container ?? (imageOptions === undefined ? undefined : "sandbox")
        // Reattach before provisioning: the same key names the same machine
        // wherever one is still running. An adopted task is released the same
        // way a fresh one is, so closing the scope attempts to stop either.
        const leftover = yield* leftoverTasks(options, startedBy, container, fingerprint)
        // Duplicates go before anything else: an adopter that provisioned beside
        // them would leave the key owning more machines every incarnation.
        if (leftover.stale.length > 0) yield* stopTasks(options, leftover.stale)
        const adopt = leftover.adopt
        const taskArn = adopt !== undefined
          ? yield* Effect.gen(function*() {
            const arn = yield* Effect.acquireRelease(
              Effect.succeed(adopt.taskArn),
              (task) =>
                stopTasks(options, [task]).pipe(
                  Effect.andThen(
                    imageOptions === undefined
                      ? Effect.void
                      : deregisterDefinition(imageOptions, adopt.taskDefinitionArn)
                  )
                )
            )
            if (imageOptions !== undefined) {
              yield* deregisterStaleDefinitions(imageOptions, startedBy, adopt.taskDefinitionArn)
            }
            // A task adopted while still provisioning is released by the same
            // finalizer whether or not it ever becomes ready.
            if (!adopt.ready) yield* awaitReady(options, arn, container)
            return arn
          })
          : yield* Effect.gen(function*() {
            const taskDefinition = options.taskDefinition === undefined
              ? yield* registerDefinition(options, startedBy, workdir, options.container ?? "sandbox")
              : options.taskDefinition
            const output = yield* Effect.acquireRelease(
              runTask(options, taskDefinition, startedBy, container, fingerprint),
              (output) => stopTasks(options, taskArnsOf(output))
            )
            const started = taskArnsOf(output)[0]
            if (started === undefined) {
              return yield* Effect.fail(failure("unavailable", "RunTask returned no task ARN", output.failures))
            }
            yield* awaitReady(options, started, container)
            return started
          })
        const ping = Effect.flatMap(describe(options, taskArn), (description) => {
          const task = describedTask(description, taskArn)
          return task !== undefined && agentReady(task, container)
            ? Effect.void
            : Effect.fail(failure("unavailable", `${taskArn} is not ready`, description.failures))
        })

        const transport = options.exec
        if (transport === undefined) {
          const session: Session = {
            id: sessionKey,
            remoteId: taskArn,
            workdir,
            spawn: () => Effect.fail(noTransport("spawn a command")),
            readFile: (path) => Effect.fail(noTransport(`read ${path}`)),
            writeFile: (path) => Effect.fail(noTransport(`write ${path}`)),
            ping
          }
          return session
        }

        const program = transport.program ?? "aws"
        const chunkBytes = yield* chunkBytesOf(transport)
        const cli = (remote: string, stdin?: Stream.Stream<Uint8Array>): ChildProcess.Command =>
          ChildProcess.make(program, [
            ...transport.globalArgs ?? [],
            "--region",
            options.region,
            "ecs",
            "execute-command",
            "--cluster",
            options.cluster,
            "--task",
            taskArn,
            ...container === undefined ? [] : ["--container", container],
            "--interactive",
            "--command",
            remote
          ], stdin === undefined ? {} : { stdin })
        const requireStreaming = Effect.suspend(() =>
          transport.streamingSpawner === undefined
            ? Effect.fail(
              failure(
                "unavailable",
                "file writes, stdin, and environment input require ExecTransport.streamingSpawner; the AWS CLI cannot carry them safely"
              )
            )
            : Effect.succeed(transport.streamingSpawner)
        )
        const spawnTransport = (remote: string, stdin?: Stream.Stream<Uint8Array>) =>
          Effect.gen(function*() {
            const spawner = stdin === undefined ? transport.spawner : yield* requireStreaming
            return yield* spawner.spawn(cli(remote, stdin)).pipe(
              Effect.mapError(providerFailure("spawn_error", `\`${program} ecs execute-command\` could not start`))
            )
          })
        const transportFailure = (run: GatheredRun): ProviderError =>
          failure("unavailable", `\`${program} ecs execute-command\` exited ${run.code}: ${run.stderr.trim()}`)
        // One-shot guest scripts: reads, writes, kills, and the workspace
        // preparation. Each opens its own session and reports its own status.
        let nextPid = 0
        const run = (script: string, stdin?: Stream.Stream<Uint8Array>): Effect.Effect<Unframed, ProviderError> =>
          Effect.scoped(
            Effect.gen(function*() {
              const nonce = freshNonce()
              const handle = yield* spawnTransport(framedScript(script, nonce), stdin)
              const gathered = yield* gather(handle, `${program} ecs execute-command`)
              if (gathered.code !== 0) return yield* Effect.fail(transportFailure(gathered))
              return unframe(gathered, nonce)
            })
          )
        const settled = (what: string, result: Unframed): Effect.Effect<Unframed, ProviderError> =>
          result.code === undefined
            ? Effect.fail(failure("aborted", `${what}: the session ended before the command reported its status`))
            : Effect.succeed(result)
        yield* Effect.flatMap(
          run(`mkdir -p ${CommandLine.quote(workdir)} && rm -rf ${pidDirectory} && mkdir -p ${pidDirectory}`),
          (result) =>
            result.code === 0 ? Effect.void : Effect.fail(
              failure(
                "unavailable",
                `the workspace ${workdir} could not be prepared in ${taskArn}: ${result.payload.trim()}`
              )
            )
        )

        const writeFile: Session["writeFile"] = (path, content) =>
          Effect.gen(function*() {
            yield* requireStreaming
            const target = CommandLine.quote(path)
            const parent = parentOf(path)
            const prepare = parent === undefined ? "" : `mkdir -p ${CommandLine.quote(parent)} && `
            for (let offset = 0; offset < Math.max(1, content.length); offset += chunkBytes) {
              const script = `${offset === 0 ? prepare : ""}base64 -d ${offset === 0 ? ">" : ">>"} ${target}`
              const input = Stream.make(encoder.encode(encodeBase64(content.slice(offset, offset + chunkBytes))))
              const result = yield* Effect.flatMap(run(script, input), (result) => settled(`writing ${path}`, result))
              if (result.code !== 0) {
                return yield* Effect.fail(failure("unknown", `could not write ${path}: ${result.payload.trim()}`))
              }
            }
          })
        // The session is a pseudo-terminal with no input channel of its own, so
        // standard input is staged as a workspace file and redirected.
        const redirect = stdinRedirect({
          workdir,
          writeFile,
          remove: (path) =>
            Effect.flatMap(
              Effect.flatMap(run(`rm -f ${CommandLine.quote(path)}`), (result) => settled(`removing ${path}`, result)),
              (result) =>
                result.code === 0 ? Effect.void : Effect.fail(
                  failure("unknown", `could not remove ${path}: command exited ${result.code}`)
                )
            )
        })
        const resolveCwd = rootedAt(workdir)
        const kill = (pidfile: string, signal: string): Effect.Effect<void, ProviderError> =>
          Effect.flatMap(
            run(killScript(pidfile, signal.replace(/^SIG/, ""))),
            (result) =>
              Effect.flatMap(settled(`signalling with ${signal}`, result), (settledResult) =>
                settledResult.code === 0
                  ? Effect.void
                  : Effect.fail(
                    failure(
                      "unknown",
                      `the signal ${signal} could not be delivered in ${taskArn}: ${settledResult.payload.trim()}`
                    )
                  ))
          )

        const pidfiles = new WeakMap<RemoteProcess, string>()
        const session: Session = {
          id: sessionKey,
          remoteId: taskArn,
          workdir,
          spawn: Effect.fnUntraced(function*(command, spawnOptions) {
            yield* checkEnvironmentNames(spawnOptions.env)
            const environment = environmentInput(envPrefix(spawnOptions.env), undefined)
            if (spawnOptions.stdin !== undefined || environment.stdin !== undefined) yield* requireStreaming
            const nonce = freshNonce()
            const pidfile = `${pidDirectory}/${nextPid++}.pid`
            const fed = yield* redirect(command, spawnOptions.stdin)
            const remote = spawnScript(fed, resolveCwd(spawnOptions.cwd ?? ""), environment, pidfile, nonce)
            const handle = yield* spawnTransport(remote, environment.stdin)
            // The session's whole output is needed before any of it can be
            // read back (the banner leads and the sentinel trails), so the
            // three pieces of the process share one gathering of the local
            // client, taken when the first of them is consumed.
            const gathered = yield* Effect.cached(
              Effect.flatMap(
                gather(handle, `${program} ecs execute-command`),
                (result) =>
                  result.code === 0 ? Effect.succeed(unframe(result, nonce)) : Effect.fail(transportFailure(result))
              )
            )
            // Closing the process scope ends the local client, which the guest
            // does not notice. The contract says the scope IS the process's
            // lifetime, so the finalizer signals the guest side too, unless the
            // command has already been seen to end. A session that ended without
            // a status is exactly the case where the guest may still be running.
            let ended = false
            const observed = Effect.tap(gathered, (result) =>
              Effect.sync(() => {
                if (result.code !== undefined) ended = true
              }))
            yield* Effect.addFinalizer(() =>
              ended ? Effect.void : finalizeWithin(
                Effect.ignore(
                  kill(pidfile, "SIGTERM").pipe(Effect.tapError((error) => warnTeardown("aws", "kill", error)))
                ),
                `aws task ${taskArn} process ${pidfile}`
              )
            )
            const process: RemoteProcess = {
              stdout: Stream.unwrap(
                Effect.map(
                  observed,
                  (result) => result.payload.length === 0 ? Stream.empty : Stream.make(encoder.encode(result.payload))
                )
              ),
              // The pseudo-terminal merges standard error into standard output.
              stderr: Stream.empty,
              exitCode: Effect.flatMap(observed, (result) =>
                result.code === undefined
                  ? Effect.fail(failure("aborted", `\`${command}\` ended without reporting its status`))
                  : Effect.succeed(result.code))
            }
            pidfiles.set(process, pidfile)
            return process
          }),
          readFile: (path) =>
            Effect.flatMap(
              // Redirected, not positional: BSD `base64` takes no file operand,
              // and the redirect reads the same on every guest.
              run(`test -e ${CommandLine.quote(path)} || exit 9; base64 < ${CommandLine.quote(path)}`),
              (result) =>
                result.code === 0
                  ? decodeBase64(result.payload, `while reading ${path}`)
                  : result.code === 9
                  ? Effect.fail(new ProviderError({ code: "not_found", message: `the task holds nothing at ${path}` }))
                  : Effect.fail(
                    failure(
                      result.code === undefined ? "aborted" : "unknown",
                      `could not read ${path}: ${result.payload.trim()}`
                    )
                  )
            ),
          writeFile,
          kill: (process, signal) =>
            Effect.suspend(() => {
              const pidfile = pidfiles.get(process)
              /* v8 ignore next 3 -- `spawn` records every process it returns and a `RemoteProcess` has no other source, so the guard only discharges the optional a map read carries */
              if (pidfile === undefined) {
                return Effect.fail(failure("unknown", "unrecognized process"))
              }
              return kill(pidfile, signal)
            }),
          ping
        }
        return session
      })
  }
}
