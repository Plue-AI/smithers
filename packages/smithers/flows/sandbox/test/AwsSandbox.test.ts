import { NodeChildProcessSpawner, NodeFileSystem } from "@effect/platform-node"
import { afterAll, describe, expect, it } from "@effect/vitest"
import { Effect, Exit, Layer, Logger, Path, PlatformError, Sink, Stream } from "effect"
import * as Scope from "effect/Scope"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import {
  ChildProcessSpawner,
  ExitCode,
  make as makeSpawner,
  makeHandle
} from "effect/unstable/process/ChildProcessSpawner"
import { chmodSync, existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as AwsSandbox from "../src/AwsSandbox/index.ts"
import { ProviderError } from "../src/RemoteChildProcessSpawner/ProviderError.ts"
import type { Session } from "../src/Sandbox/Session.ts"
import * as SandboxConformance from "../src/SandboxConformance/index.ts"
import { untouchable } from "./helpers/untouchable.ts"
import { stalledFinalizer } from "./stalledFinalizer.ts"

type RunTaskInput = Parameters<AwsSandbox.Sdk["runTask"]>[0]
type RunTaskOutput = Awaited<ReturnType<AwsSandbox.Sdk["runTask"]>>
type DescribeTasksInput = Parameters<AwsSandbox.Sdk["describeTasks"]>[0]
type DescribeTasksOutput = Awaited<ReturnType<AwsSandbox.Sdk["describeTasks"]>>
type StopTaskInput = Parameters<AwsSandbox.Sdk["stopTask"]>[0]
type RegisterTaskDefinitionInput = Parameters<AwsSandbox.Sdk["registerTaskDefinition"]>[0]
type DeregisterTaskDefinitionInput = Parameters<AwsSandbox.Sdk["deregisterTaskDefinition"]>[0]
type Task = NonNullable<DescribeTasksOutput["tasks"]>[number]

type DescribeStep =
  | "missing"
  | "empty"
  | "pending"
  | "no-containers"
  | "no-agents"
  | "wrong-agent"
  | "wrong-container"
  | "fallback-ready"
  | "stopped"
  | "ready"

interface Fault {
  readonly cause: unknown
}

type ListTasksInput = Parameters<AwsSandbox.Sdk["listTasks"]>[0]

interface FakeTask {
  tags?: RunTaskInput["tags"]
  taskDefinition?: string | undefined
  readonly arn: string
  readonly startedBy: string
  lastStatus: string
  desiredStatus: NonNullable<ListTasksInput["desiredStatus"]>
}

interface FakeEcs {
  readonly runInputs: Array<RunTaskInput>
  readonly describeInputs: Array<DescribeTasksInput>
  readonly listInputs: Array<ListTasksInput>
  /** Tasks RunTask started and StopTask has not yet stopped, by startedBy. */
  readonly running: Array<FakeTask>
  readonly stopInputs: Array<StopTaskInput>
  readonly registerInputs: Array<RegisterTaskDefinitionInput>
  readonly deregisterInputs: Array<DeregisterTaskDefinitionInput>
  readonly events: Array<string>
  readonly describeSteps: Array<DescribeStep>
  runFault?: Fault | undefined
  describeFault?: Fault | undefined
  listFault?: Fault | undefined
  listWithoutArns?: boolean | undefined
  /** Tasks per ListTasks page; AWS returns up to 100 when `maxResults` is omitted. */
  listPageSize?: number | undefined
  /** Hands back the same page token forever instead of advancing. */
  listRepeatsToken?: boolean | undefined
  stopFault?: Fault | undefined
  registerFault?: Fault | undefined
  deregisterFault?: Fault | undefined
  runWithoutTask?: boolean | undefined
  runWithoutArn?: boolean | undefined
  registerWithoutArn?: boolean | undefined
  nextTask: number
  lastContainer: string
}

const fakeEcs = (): FakeEcs => ({
  runInputs: [],
  describeInputs: [],
  listInputs: [],
  running: [],
  stopInputs: [],
  registerInputs: [],
  deregisterInputs: [],
  events: [],
  describeSteps: [],
  nextTask: 0,
  lastContainer: "main"
})

const managed = (name = "ExecuteCommandAgent", lastStatus = "RUNNING") => ({ name, lastStatus })

const taskFor = (
  taskArn: string,
  container: string,
  step: DescribeStep,
  desiredStatus: NonNullable<ListTasksInput["desiredStatus"]> = "RUNNING"
): Task => {
  if (step === "stopped") return { taskArn, lastStatus: "STOPPED", desiredStatus, enableExecuteCommand: true }
  if (step === "pending") return { taskArn, lastStatus: "PENDING", desiredStatus, enableExecuteCommand: false }
  if (step === "no-containers") {
    return { taskArn, lastStatus: "RUNNING", desiredStatus, enableExecuteCommand: true }
  }
  if (step === "no-agents") {
    return {
      taskArn,
      lastStatus: "RUNNING",
      desiredStatus,
      enableExecuteCommand: true,
      containers: [{ name: container }]
    }
  }
  if (step === "wrong-agent") {
    return {
      taskArn,
      lastStatus: "RUNNING",
      desiredStatus,
      enableExecuteCommand: true,
      containers: [{
        name: container,
        managedAgents: [managed("OtherAgent", "STOPPED"), managed("ExecuteCommandAgent", "PENDING")]
      }]
    }
  }
  if (step === "wrong-container") {
    return {
      taskArn,
      lastStatus: "RUNNING",
      desiredStatus,
      enableExecuteCommand: true,
      containers: [{ name: "another", managedAgents: [managed()] }]
    }
  }
  return {
    taskArn: step === "fallback-ready" ? `${taskArn}-reported` : taskArn,
    lastStatus: "RUNNING",
    desiredStatus,
    enableExecuteCommand: true,
    containers: [{ name: container, managedAgents: [managed()] }]
  }
}

const takeFault = (target: FakeEcs, key: keyof FakeEcs): unknown | undefined => {
  const fault = target[key] as Fault | undefined
  if (fault === undefined) return undefined
  delete target[key]
  return fault.cause
}

const sdkOf = (fake: FakeEcs): AwsSandbox.Sdk => ({
  async runTask(input): Promise<RunTaskOutput> {
    fake.runInputs.push(input)
    fake.events.push("run")
    const fault = takeFault(fake, "runFault")
    if (fault !== undefined) throw fault
    if (fake.runWithoutTask === true) return { failures: [{ reason: "CAPACITY" }] }
    const taskArn = `arn:aws:ecs:us-west-2:123456789012:task/cluster/task-${fake.nextTask++}`
    fake.lastContainer = input.overrides?.containerOverrides?.[0]?.name ?? fake.lastContainer
    if (fake.runWithoutArn === true) {
      return { tasks: [{ lastStatus: "PROVISIONING" }], failures: [{ reason: "MISSING_ARN" }] }
    }
    fake.running.push({
      arn: taskArn,
      startedBy: input.startedBy,
      tags: input.tags,
      taskDefinition: input.taskDefinition,
      lastStatus: "PROVISIONING",
      desiredStatus: "RUNNING"
    })
    return {
      tasks: [{ taskArn, lastStatus: "PROVISIONING", desiredStatus: "RUNNING", enableExecuteCommand: true }]
    }
  },
  async listTasks(input) {
    fake.listInputs.push(input)
    fake.events.push("list")
    const fault = takeFault(fake, "listFault")
    if (fault !== undefined) throw fault
    if (fake.listWithoutArns === true) return {}
    const desiredStatus = input.desiredStatus ?? "RUNNING"
    const all = fake.running
      .filter((task) => task.startedBy === input.startedBy && task.desiredStatus === desiredStatus)
      .map((task) => task.arn)
    const size = fake.listPageSize ?? 100
    const start = input.nextToken === undefined ? 0 : Number(input.nextToken.replace("page-", ""))
    const end = start + size
    return {
      taskArns: all.slice(start, end),
      ...end < all.length ? { nextToken: fake.listRepeatsToken === true ? "page-0" : `page-${end}` } : {}
    }
  },
  async describeTasks(input): Promise<DescribeTasksOutput> {
    fake.describeInputs.push(input)
    fake.events.push("describe")
    const fault = takeFault(fake, "describeFault")
    if (fault !== undefined) throw fault
    if (input.tasks.length > 100) throw new Error("InvalidParameterException: tasks can have at most 100 items")
    const step = fake.describeSteps.shift() ?? "ready"
    if (step === "missing") return { failures: [{ arn: input.tasks[0], reason: "MISSING" }] }
    if (step === "empty") return { tasks: [] }
    // The step decides the first task; anything described beside it is a
    // leftover duplicate, and a duplicate that is merely there is ready.
    return {
      tasks: input.tasks.map((task, index) => {
        const stored = fake.running.find(({ arn }) => arn === task)
        const described = taskFor(
          task,
          fake.lastContainer,
          index === 0 ? step : "ready",
          stored?.desiredStatus ?? "RUNNING"
        )
        if (stored !== undefined && described.lastStatus !== undefined) stored.lastStatus = described.lastStatus
        return {
          ...described,
          startedBy: stored?.startedBy,
          tags: stored?.tags,
          taskDefinitionArn: stored?.taskDefinition
        }
      })
    }
  },
  async stopTask(input) {
    fake.stopInputs.push(input)
    fake.events.push("stop")
    const fault = takeFault(fake, "stopFault")
    if (fault !== undefined) throw fault
    const index = fake.running.findIndex((task) => task.arn === input.task)
    if (index >= 0) fake.running.splice(index, 1)
    return { task: { taskArn: input.task, lastStatus: "STOPPED" } }
  },
  async registerTaskDefinition(input) {
    fake.registerInputs.push(input)
    fake.events.push("register")
    const fault = takeFault(fake, "registerFault")
    if (fault !== undefined) throw fault
    fake.lastContainer = input.containerDefinitions[0]!.name
    return fake.registerWithoutArn === true
      ? { taskDefinition: {} }
      : {
        taskDefinition: {
          taskDefinitionArn:
            `arn:aws:ecs:us-west-2:123456789012:task-definition/${input.family}:${fake.registerInputs.length}`
        }
      }
  },
  async listTaskDefinitions() {
    return {}
  },
  async deregisterTaskDefinition(input) {
    fake.deregisterInputs.push(input)
    fake.events.push("deregister")
    const fault = takeFault(fake, "deregisterFault")
    if (fault !== undefined) throw fault
    return { taskDefinition: { taskDefinitionArn: input.taskDefinition, status: "INACTIVE" } }
  }
})

// -----------------------------------------------------------------------------
// The AWS CLI as a fake: real shells behind the Session Manager framing.
// -----------------------------------------------------------------------------

// The provider's guest scripts run through a real `sh` against a real
// directory, so `base64`, `wait`, the pidfile, and the signal are all genuine;
// what the fake adds is exactly what `session-manager-plugin` adds on top of
// them: the banner, the footer, `\r\n` line endings from the pseudo-terminal,
// standard error folded into standard output, and a zero exit whatever the
// command did. A fake that mirrored the provider's parsing would prove
// nothing; this one reproduces the transport the provider has to survive.
const root = realpathSync(mkdtempSync(join(tmpdir(), "smthrs-aws-sandbox-")))
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

const platform = Layer.provideMerge(
  NodeChildProcessSpawner.layer,
  Layer.merge(NodeFileSystem.layer, Path.layer)
)
const local = Effect.runSync(
  Effect.gen(function*() {
    return yield* ChildProcessSpawner
  }).pipe(Effect.provide(platform))
)

const encoder = new TextEncoder()
const decoder = new TextDecoder()

interface CliFaults {
  readonly wait?: (remote: string) => Effect.Effect<void> | undefined
  readonly removeResult?: "failed" | "missing"

  /** The plugin exits with this code and prints this to standard error. */
  readonly pluginFailure?: { readonly code: number; readonly stderr: string } | undefined
  /** The session drops before the wrapper's sentinel line is printed. */
  readonly dropSentinel?: boolean | undefined
  /** An older plugin that prints no banner line. */
  readonly noBanner?: boolean | undefined
  /** Replaces a matching guest command's framed payload and status. */
  readonly guestResult?:
    | ((remote: string) => { readonly code: number; readonly payload: string } | undefined)
    | undefined
}

interface CliCall {
  readonly file: string
  readonly args: ReadonlyArray<string>
  readonly input: string
  readonly remote: string
}

const crlf = (bytes: Uint8Array): Uint8Array => {
  const out: Array<number> = []
  for (const byte of bytes) {
    if (byte === 0x0a) out.push(0x0d)
    out.push(byte)
  }
  return Uint8Array.from(out)
}

const fakeCli = (faults: CliFaults = {}) => {
  const calls: Array<CliCall> = []
  const spawner = makeSpawner((command: ChildProcess.Command) =>
    Effect.gen(function*() {
      if (command._tag !== "StandardCommand") {
        return yield* Effect.fail(
          PlatformError.badArgument({ module: "ChildProcess", method: "spawn", description: "no pipelines" })
        )
      }
      const remoteIndex = command.args.indexOf("--command")
      // Guest pids live under a fixed guest path; on this host they live
      // under the test's own root instead.
      const remote = command.args[remoteIndex + 1]!.replaceAll("/tmp/.smthrs-sbx", `${root}/.pids`)
      const chunks = Stream.isStream(command.options.stdin)
        ? yield* Stream.runCollect(command.options.stdin as Stream.Stream<Uint8Array>)
        : undefined
      const stdinBytes = chunks === undefined ? undefined : Buffer.concat([...chunks])
      const input = stdinBytes === undefined ? "" : new TextDecoder().decode(stdinBytes)
      calls.push({ file: command.command, input, args: command.args, remote })
      const sessionId = `ecs-execute-command-${calls.length}`
      const wait = faults.wait?.(remote)
      if (
        wait !== undefined ||
        (faults.removeResult !== undefined && remote.includes("rm -f ") && remote.includes(".smthrs-stdin/"))
      ) {
        const marker = /__smthrs_exit_[0-9a-f]+_/.exec(remote)![0]
        return makeHandle({
          pid: 0 as never,
          exitCode: Effect.as(wait ?? Effect.void, ExitCode(0)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          stdin: Sink.drain,
          stdout: faults.removeResult === "missing" ? Stream.empty : Stream.make(encoder.encode(`\n${marker}1__\n`)),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void)
        })
      }

      if (faults.pluginFailure !== undefined) {
        return makeHandle({
          pid: 0 as never,
          exitCode: Effect.succeed(ExitCode(faults.pluginFailure.code)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          stdin: Sink.drain,
          stdout: Stream.empty,
          stderr: Stream.make(encoder.encode(faults.pluginFailure.stderr)),
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void)
        })
      }
      // `exec 2>&1` is the pseudo-terminal, modelled where the plugin has one:
      // at the file descriptor. A Session Manager session gives the guest ONE
      // output channel, so the kernel orders standard error against standard
      // output and the exit sentinel the transport frames on is always last.
      // Reading two host pipes and merging the two streams in userspace does
      // not reproduce that — the merge emits in whatever order two reader
      // fibers happen to be scheduled, so a loaded machine could deliver
      // `to-stderr` AFTER the sentinel, where `unframe` correctly discards it
      // as session footer, and the conformance suite saw a command's standard
      // error vanish. One descriptor, one order, no race.
      // The recorded input reaches the shell from a file, not a pipe: a guest
      // script that exits before reading its stdin (`exit 23`) would otherwise
      // leave Bun's pipe writer with an unhandled EPIPE.
      const stdinFile = stdinBytes === undefined ? undefined : join(root, `.stdin-${calls.length}`)
      if (stdinFile !== undefined) writeFileSync(stdinFile, stdinBytes!)
      const child = yield* local.spawn(
        ChildProcess.make("sh", [
          "-c",
          `exec 2>&1${stdinFile === undefined ? "" : ` <'${stdinFile}'`}\n${remote}`
        ], { cwd: root })
      )
      const banner = faults.noBanner === true
        ? Stream.empty
        : Stream.make(encoder.encode(`\r\nStarting session with SessionId: ${sessionId}\r\n`))
      const footer = Stream.make(encoder.encode(`\r\n\r\nExiting session with sessionId: ${sessionId}.\r\n`))
      const guestResult = faults.guestResult?.(remote)
      const merged = guestResult === undefined
        ? child.stdout.pipe(
          Stream.map(crlf),
          Stream.map((bytes) =>
            faults.dropSentinel === true
              ? encoder.encode(decoder.decode(bytes).replaceAll("__smthrs_exit_", "__dropped_"))
              : bytes
          )
        )
        : Stream.fromEffect(
          Effect.map(child.exitCode, () => {
            const marker = /__smthrs_exit_[0-9a-f]+_/.exec(remote)?.[0] ?? "__smthrs_exit_missing_"
            return crlf(encoder.encode(`${guestResult.payload}\n${marker}${guestResult.code}__\n`))
          })
        )
      return makeHandle({
        pid: child.pid,
        // The plugin reports its own success, never the remote command's.
        exitCode: Effect.map(child.exitCode, () => ExitCode(0)),
        isRunning: child.isRunning,
        kill: (options) => child.kill(options),
        stdin: Sink.drain,
        stdout: Stream.concat(Stream.concat(banner, merged), footer),
        stderr: Stream.empty,
        all: Stream.concat(Stream.concat(banner, merged), footer),
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: child.unref
      })
    })
  )
  return { spawner, calls }
}

const taskDefinitionProvider = (fake: FakeEcs, overrides: Record<string, unknown> = {}) =>
  AwsSandbox.make({
    sdk: sdkOf(fake),
    region: "us-west-2",
    cluster: "cluster-arn",
    taskDefinition: "family:7",
    subnets: ["subnet-a"],
    ...overrides
  })

const transportProvider = (
  fake: FakeEcs,
  cli: ReturnType<typeof fakeCli>,
  overrides: Record<string, unknown> = {},
  transport: Record<string, unknown> = {}
) =>
  taskDefinitionProvider(fake, {
    workdir: root,
    pollIntervalMs: 0,
    maxPollAttempts: 3,
    exec: { spawner: cli.spawner, streamingSpawner: cli.spawner, ...transport },
    ...overrides
  })

const acquired = <A, E>(
  provider: ReturnType<typeof AwsSandbox.make>,
  body: (session: Session) => Effect.Effect<A, E>,
  session = "aws/session"
): Effect.Effect<A, E | ProviderError> => Effect.scoped(Effect.flatMap(provider.acquire(session), body))

const output = (session: Session, command: string, options: Parameters<Session["spawn"]>[1] = {}) =>
  Effect.scoped(
    Effect.gen(function*() {
      const process = yield* session.spawn(command, options)
      const stdout = yield* Stream.mkString(Stream.decodeText(process.stdout))
      const code = yield* process.exitCode
      return { stdout, code }
    })
  )

describe("AwsSandbox", () => {
  it("refuses every network policy at construction, before touching its dependencies", () => {
    const deps = untouchable<never>()
    for (const network of ["none", { allow: ["example.com"] }] as const) {
      expect(() =>
        AwsSandbox.make({
          sdk: deps.value,
          region: "us-west-2",
          cluster: "cluster-arn",
          taskDefinition: "family:7",
          subnets: ["subnet-a"],
          network
        })
      )
        .toThrow("aws-sandbox: cannot enforce a network policy; omit `network`")
    }
    expect(deps.touched).toEqual([])
  })

  for (const operation of ["remove", "kill"] as const) {
    it.effect(`bounds stalled ${operation} on the platform timer`, () =>
      stalledFinalizer((stall) => {
        const cli = fakeCli({
          wait: (remote) =>
            (operation === "remove"
                ? remote.includes("rm -f ") && remote.includes(".smthrs-stdin/")
                : remote.includes("kill -s TERM")) ?
              stall :
              undefined
        })
        return acquired(transportProvider(fakeEcs(), cli), (session) =>
          operation === "remove"
            ? Effect.asVoid(output(session, "true", { stdin: encoder.encode("input") }))
            : Effect.asVoid(Effect.scoped(session.spawn("true", {}))))
      }, operation === "remove" ? ".smthrs-stdin/" : ".pid"))
  }

  for (const operation of ["stop", "deregister"] as const) {
    it.effect(`bounds stalled ${operation} on the platform timer`, () =>
      stalledFinalizer((stall) => {
        const fake = fakeEcs()
        const sdk = {
          ...sdkOf(fake),
          ...operation === "stop"
            ? { stopTask: () => Effect.runPromise(Effect.as(stall, {})) }
            : { deregisterTaskDefinition: () => Effect.runPromise(Effect.as(stall, {})) }
        }
        const provider = AwsSandbox.make({
          sdk,
          region: "us-west-2",
          cluster: "cluster-arn",
          subnets: ["subnet-a"],
          image: "alpine",
          taskRoleArn: "role-arn",
          pollIntervalMs: 0
        })
        return acquired(provider, Effect.succeed)
      }, operation === "stop" ? "aws task " : "aws task definition"))
  }

  for (const removeResult of ["failed", "missing"] as const) {
    it.effect(`reports ${removeResult} staged stdin removal without claiming the file was removed`, () =>
      Effect.gen(function*() {
        const workspace = mkdtempSync(join(root, "remove-failure-"))
        const cli = fakeCli({ removeResult })
        const warnings: Array<unknown> = []
        yield* acquired(transportProvider(fakeEcs(), cli, { workdir: workspace }), (session) =>
          Effect.gen(function*() {
            yield* output(session, "true", { stdin: encoder.encode("private input") })
            const files = readdirSync(join(workspace, ".smthrs-stdin"))
            expect(files).toHaveLength(1)
            expect(existsSync(join(workspace, ".smthrs-stdin", files[0]!))).toBe(true)
            expect(warnings).toHaveLength(1)
          })).pipe(Effect.provide(Logger.layer([Logger.make((entry) => {
            if (entry.logLevel === "Warn") warnings.push(entry)
          })])))
      }))
  }

  it.effect("verifies task tags, owner, and pinned definition before adoption or duplicate cleanup", () =>
    Effect.gen(function*() {
      for (
        const change of [
          "tags",
          "fingerprint",
          "owner",
          "definition",
          "missingDefinition",
          "arnMismatch",
          "unpinned",
          "duplicate"
        ] as const
      ) {
        const fake = fakeEcs()
        const leaked = yield* Scope.make()
        const provider = taskDefinitionProvider(
          fake,
          change === "unpinned"
            ? { taskDefinition: "family" }
            : change === "arnMismatch"
            ? { taskDefinition: "arn:aws:ecs:us-west-2:123:task-definition/family:7" }
            : {}
        )
        yield* Effect.provideService(provider.acquire("verify"), Scope.Scope, leaked)
        const stored = fake.running[0]!
        if (change === "tags") stored.tags = undefined
        if (change === "fingerprint") stored.tags = [{ key: "smithers.dev/sandbox-fingerprint", value: "other" }]
        if (change === "definition" || change === "arnMismatch") stored.taskDefinition = "family:8"
        if (change === "missingDefinition") stored.taskDefinition = undefined
        if (change === "duplicate") fake.running.push({ ...stored, arn: `${stored.arn}-duplicate`, tags: [] })
        const sdk = sdkOf(fake)
        const next = change === "owner" ?
          taskDefinitionProvider(fake, {
            sdk: {
              ...sdk,
              describeTasks: async (input: DescribeTasksInput) => {
                const output = await sdk.describeTasks(input)
                return { ...output, tasks: output.tasks?.map((task) => ({ ...task, startedBy: "someone-else" })) }
              }
            }
          }) :
          provider
        expect(yield* Effect.flip(Effect.scoped(next.acquire("verify")))).toMatchObject({ code: "unavailable" })
        expect(fake.describeInputs.at(-1)?.include).toEqual(["TAGS"])
        expect(fake.runInputs).toHaveLength(1)
        expect(fake.stopInputs).toHaveLength(0)
        yield* Scope.close(leaked, Exit.void)
      }
    }))

  it.effect("refuses task-definition environment overrides without a container before SDK calls", () =>
    Effect.gen(function*() {
      const fake = fakeEcs()
      const error = yield* Effect.flip(Effect.scoped(
        taskDefinitionProvider(fake, { env: { BOOT: "yes" } }).acquire("missing-container")
      ))
      expect(error).toBeInstanceOf(ProviderError)
      expect(error).toMatchObject({ code: "spawn_error" })
      expect(error.message).toContain("container")
      expect(fake.events).toEqual([])
    }))

  it.effect("keeps long session keys sharing a prefix on separate tasks", () =>
    Effect.scoped(Effect.gen(function*() {
      const fake = fakeEcs()
      const provider = taskDefinitionProvider(fake)
      const prefix = "flow:0f3c2b1a-7d6e-4f5a-9b8c-1d2e3f4a5b6c:"
      const first = yield* provider.acquire(`${prefix}lane-1`)
      const second = yield* provider.acquire(`${prefix}lane-2`)
      expect(first.remoteId).not.toBe(second.remoteId)
      expect(fake.runInputs).toHaveLength(2)
      expect(fake.runInputs.map((input) => input.startedBy)).toEqual([
        "flow-0f3c2b1a-7d6e--5869781b6e6d1d39",
        "flow-0f3c2b1a-7d6e--5869781c6b6d1880"
      ])
    })))

  it.effect("reuses a crash-left image definition and reclaims its stale revisions", () =>
    Effect.gen(function*() {
      const fake = fakeEcs()
      const leaked = yield* Scope.make()
      const listInputs: Array<{ familyPrefix: string; status: "ACTIVE"; nextToken?: string | undefined }> = []
      let original = ""
      const sdk = {
        ...sdkOf(fake),
        async listTaskDefinitions(input: typeof listInputs[number]) {
          listInputs.push(input)
          return input.nextToken === undefined
            ? { taskDefinitionArns: [original, original.replace(/:1$/, ":2")], nextToken: "next" }
            : { taskDefinitionArns: [original.replace(/:1$/, ":3"), original.replace(/:1$/, "-other:1")] }
        }
      }
      const provider = AwsSandbox.make({
        sdk,
        image: "img",
        taskRoleArn: "role",
        cluster: "cluster-arn",
        region: "us-west-2",
        subnets: ["subnet-a"]
      })
      const first = yield* Effect.provideService(provider.acquire("image-recovery"), Scope.Scope, leaked)
      original = fake.runInputs[0]!.taskDefinition
      yield* Effect.scoped(Effect.gen(function*() {
        const second = yield* provider.acquire("image-recovery")
        expect(second.remoteId).toBe(first.remoteId)
        expect(fake.runInputs).toHaveLength(1)
        expect(fake.registerInputs).toHaveLength(1)
        expect(fake.deregisterInputs).toEqual([
          { taskDefinition: original.replace(/:1$/, ":2") },
          { taskDefinition: original.replace(/:1$/, ":3") }
        ])
      }))
      expect(listInputs).toEqual([
        { familyPrefix: fake.registerInputs[0]!.family, status: "ACTIVE" },
        { familyPrefix: fake.registerInputs[0]!.family, status: "ACTIVE", nextToken: "next" }
      ])
      expect(fake.deregisterInputs.at(-1)).toEqual({ taskDefinition: original })
      expect(fake.events.slice(-2)).toEqual(["stop", "deregister"])
      expect(fake.events.indexOf("list")).toBeLessThan(fake.events.indexOf("register"))
      yield* Scope.close(leaked, Exit.void)
    }))

  it.effect("refuses image recovery without a definition in its generated family", () =>
    Effect.gen(function*() {
      for (const definition of [undefined, "arn:aws:ecs:us-west-2:123:task-definition/unrelated:1", "unversioned"]) {
        const fake = fakeEcs()
        const leaked = yield* Scope.make()
        const provider = AwsSandbox.make({
          sdk: sdkOf(fake),
          image: "img",
          taskRoleArn: "role",
          cluster: "cluster-arn",
          region: "us-west-2",
          subnets: ["subnet-a"]
        })
        yield* Effect.provideService(provider.acquire("image-identity"), Scope.Scope, leaked)
        fake.running[0]!.taskDefinition = definition
        expect(yield* Effect.flip(Effect.scoped(provider.acquire("image-identity")))).toMatchObject({
          code: "unavailable"
        })
        expect(fake.registerInputs).toHaveLength(1)
        expect(fake.stopInputs).toHaveLength(0)
        expect(fake.deregisterInputs).toHaveLength(0)
        yield* Scope.close(leaked, Exit.void)
      }
    }))

  it.effect("releases the adopted image task and definition when revision listing fails", () =>
    Effect.gen(function*() {
      const fake = fakeEcs()
      const leaked = yield* Scope.make()
      const sdk = {
        ...sdkOf(fake),
        async listTaskDefinitions() {
          throw new Error("list denied")
        }
      }
      const provider = AwsSandbox.make({
        sdk,
        image: "img",
        taskRoleArn: "role",
        cluster: "cluster-arn",
        region: "us-west-2",
        subnets: ["subnet-a"]
      })
      yield* Effect.provideService(provider.acquire("image-list-failure"), Scope.Scope, leaked)
      const original = fake.runInputs[0]!.taskDefinition
      expect(yield* Effect.flip(Effect.scoped(provider.acquire("image-list-failure")))).toMatchObject({
        code: "unavailable"
      })
      expect(fake.registerInputs).toHaveLength(1)
      expect(fake.events.slice(-2)).toEqual(["stop", "deregister"])
      expect(fake.deregisterInputs).toEqual([{ taskDefinition: original }])
      yield* Scope.close(leaked, Exit.void)
    }))

  it.effect("reattaches matching generated definitions and revision-qualified task ARNs", () =>
    Effect.gen(function*() {
      for (const generated of [false, true]) {
        const fake = fakeEcs()
        const leaked = yield* Scope.make()
        const provider = generated ?
          AwsSandbox.make({
            sdk: sdkOf(fake),
            image: "img",
            taskRoleArn: "role",
            cluster: "cluster-arn",
            region: "us-west-2",
            subnets: ["subnet-a"]
          }) :
          taskDefinitionProvider(fake)
        const first = yield* Effect.provideService(provider.acquire("match"), Scope.Scope, leaked)
        if (!generated) fake.running[0]!.taskDefinition = "arn:aws:ecs:us-west-2:123:task-definition/family:7"
        const second = yield* Effect.scoped(provider.acquire("match"))
        expect(second.remoteId).toBe(first.remoteId)
        expect(fake.runInputs).toHaveLength(1)
        yield* Scope.close(leaked, Exit.void)
      }
    }))

  it.effect("refuses a crash-left task with a different network or role", () =>
    Effect.gen(function*() {
      const fake = fakeEcs()
      const leaked = yield* Scope.make()
      const options = {
        sdk: sdkOf(fake),
        region: "us-west-2",
        cluster: "cluster-arn",
        subnets: ["subnet-a"],
        taskDefinition: "family:7"
      }
      yield* Effect.provideService(
        AwsSandbox.make({ ...options, assignPublicIp: true, taskRoleArn: "administrator" }).acquire("isolation"),
        Scope.Scope,
        leaked
      )
      const result = yield* Effect.exit(Effect.scoped(AwsSandbox.make(options).acquire("isolation")))
      expect(Exit.isFailure(result)).toBe(true)
      expect(fake.runInputs).toHaveLength(1)
      expect(fake.stopInputs).toHaveLength(0)
      yield* Scope.close(leaked, Exit.void)
    }))

  it.effect("fails closed before sending sensitive input through a CLI-only transport", () =>
    Effect.gen(function*() {
      const cli = fakeCli()
      yield* acquired(transportProvider(fakeEcs(), cli, {}, { streamingSpawner: undefined }), (session) =>
        Effect.gen(function*() {
          expect((yield* output(session, "true")).code).toBe(0)
          const before = cli.calls.length
          for (
            const operation of [
              session.writeFile(`${root}/secret`, encoder.encode("FILE_CANARY")),
              session.writeFile(`${root}/empty`, new Uint8Array()),
              Effect.scoped(session.spawn("cat", { stdin: encoder.encode("STDIN_CANARY") })),
              Effect.scoped(session.spawn("true", { env: { TOKEN: "ENV_CANARY" } })),
              Effect.scoped(session.spawn("true", { env: { TOKEN: undefined } }))
            ]
          ) {
            const error = yield* Effect.flip(operation)
            expect(error).toBeInstanceOf(ProviderError)
            expect(error.code).toBe("unavailable")
            expect(error.message).toContain("ExecTransport.streamingSpawner")
          }
          expect(cli.calls).toHaveLength(before)
        }))
    }), 30_000)

  it.effect("keeps environment, file, and stdin payloads out of local argv", () =>
    Effect.gen(function*() {
      const cli = fakeCli()
      const secret = "ARGV_ENV_CANARY_'_é\nsecond line $(printf injected)\n"
      const file = encoder.encode("ARGV_FILE_CANARY")
      const stdin = encoder.encode("ARGV_STDIN_CANARY\n\u0000tail")
      yield* acquired(transportProvider(fakeEcs(), cli), (session) =>
        Effect.gen(function*() {
          yield* session.writeFile(`${root}/canary.bin`, file)
          expect(Array.from(yield* session.readFile(`${root}/canary.bin`))).toEqual(Array.from(file))
          expect((yield* output(session, `printf '%s' "$TOKEN"`, { env: { TOKEN: secret } })).stdout).toBe(secret)
          yield* output(session, "cat > stdin-canary.bin", { env: { TOKEN: secret }, stdin })
          expect(Array.from(yield* session.readFile(`${root}/stdin-canary.bin`))).toEqual(Array.from(stdin))
        }))
      const argv = cli.calls.flatMap((call) => call.args).join("\n")
      for (
        const value of [
          "ARGV_ENV_CANARY",
          "ARGV_FILE_CANARY",
          "ARGV_STDIN_CANARY",
          Buffer.from(secret).toString("base64"),
          Buffer.from(file).toString("base64"),
          Buffer.from(stdin).toString("base64")
        ]
      ) {
        expect(argv).not.toContain(value)
      }
      for (const call of cli.calls) {
        if (call.input.length > 0) expect(argv).not.toContain(call.input.trimEnd())
      }
    }), 30_000)

  it.effect("provisions a Fargate task and refuses to reach into it without a transport", () =>
    Effect.gen(function*() {
      const fake = fakeEcs()
      const provider = taskDefinitionProvider(fake, {
        securityGroups: ["sg-a"],
        assignPublicIp: true,
        container: "runner",
        workdir: "/work dir",
        platformVersion: "1.4.0",
        taskRoleArn: "arn:task-role",
        executionRoleArn: "arn:execution-role",
        env: { BOOT: "yes" }
      })
      const longSession = "../../this-is-a-very-long-session-key-that-needs-a-safe-started-by-value"
      yield* acquired(
        provider,
        (session) =>
          Effect.gen(function*() {
            expect(session.id).toBe(longSession)
            expect(session.remoteId).toContain(":task/")
            expect(session.workdir).toBe("/work dir")
            yield* session.ping!
            const refusals = [
              yield* Effect.flip(Effect.scoped(session.spawn("printf 'hello'", {}))),
              yield* Effect.flip(session.readFile("/work dir/file")),
              yield* Effect.flip(session.writeFile("/work dir/file", new Uint8Array()))
            ]
            for (const refusal of refusals) {
              expect(refusal).toMatchObject({ code: "unavailable" })
              expect(refusal.message).toContain("no command transport")
            }
            fake.describeSteps.push("pending")
            expect(yield* Effect.flip(session.ping!)).toMatchObject({ code: "unavailable" })
          }),
        longSession
      )

      expect(fake.runInputs[0]).toMatchObject({
        cluster: "cluster-arn",
        taskDefinition: "family:7",
        count: 1,
        enableExecuteCommand: true,
        launchType: "FARGATE",
        startedBy: "------this-is-a-ver-65f8abebacfab7cd",
        platformVersion: "1.4.0",
        networkConfiguration: {
          awsvpcConfiguration: {
            subnets: ["subnet-a"],
            securityGroups: ["sg-a"],
            assignPublicIp: "ENABLED"
          }
        },
        overrides: {
          taskRoleArn: "arn:task-role",
          executionRoleArn: "arn:execution-role",
          containerOverrides: [{ name: "runner", environment: [{ name: "BOOT", value: "yes" }] }]
        }
      })
      expect(fake.stopInputs).toHaveLength(1)
    }))

  it.effect("runs commands, moves bytes, and signals through the CLI session transport", () =>
    Effect.gen(function*() {
      const fake = fakeEcs()
      // The fake reports the container it last saw named; name it up front so
      // readiness for `runner` is observable without an environment override.
      fake.lastContainer = "runner"
      const cli = fakeCli()
      const provider = transportProvider(fake, cli, { container: "runner", env: { DROP: "base" } }, {
        program: "aws-wrapper",
        globalArgs: ["--profile", "sandbox"],
        chunkBytes: 5
      })
      yield* acquired(provider, (session) =>
        Effect.gen(function*() {
          // The workspace and pid directory are prepared before the session
          // is handed out, through the same transport.
          expect(cli.calls[0]!.remote).toContain("mkdir -p")
          const greeting = yield* output(session, `printf 'hello\\nfrom %s' "$WHO"`, {
            cwd: root,
            env: { KEEP: "1", DROP: undefined, WHO: "fargate" }
          })
          expect(greeting).toEqual({ stdout: "hello\nfrom fargate", code: 0 })
          // The recorded input proves the inherited value is explicitly deleted.
          const greetingCall = cli.calls.find((call) => call.remote.includes("hello"))!
          // Every `-u` before every assignment: `env` stops reading options at
          // the first operand, so `env KEEP=1 -u DROP prog` would run `-u`.
          expect(Buffer.from(greetingCall.input.trim(), "base64").toString()).toBe("-u DROP KEEP=1 WHO=fargate")
          expect(greetingCall.remote).toContain("env \"$@\" /bin/sh -c")
          expect(yield* output(session, "pwd")).toEqual({ stdout: `${root}\n`, code: 0 })
          expect((yield* output(session, "exit 23")).code).toBe(23)
          expect((yield* output(session, "true")).stdout).toBe("")
          expect((yield* output(session, "true", { cwd: `${root}/nowhere` })).code).toBe(127)

          const bytes = new Uint8Array([0, 1, 2, 253, 254, 255, 10, 13, 0, 7, 8, 9])
          yield* session.writeFile(`${root}/deep/tree/out.bin`, bytes)
          expect(Array.from(yield* session.readFile(`${root}/deep/tree/out.bin`))).toEqual(Array.from(bytes))
          yield* session.writeFile(`${root}/empty.bin`, new Uint8Array())
          expect(Array.from(yield* session.readFile(`${root}/empty.bin`))).toEqual([])
          // A path with no parent to create takes the bare write.
          yield* session.writeFile("rooted.bin", new Uint8Array([42]))
          expect(Array.from(yield* session.readFile(`${root}/rooted.bin`))).toEqual([42])
          const absent = yield* Effect.flip(session.readFile(`${root}/absent.bin`))
          expect(absent).toMatchObject({ code: "not_found" })
          writeFileSync(`${root}/sealed.bin`, "sealed")
          chmodSync(`${root}/sealed.bin`, 0)
          const unreadable = yield* Effect.flip(session.readFile(`${root}/sealed.bin`))
          expect(unreadable).toMatchObject({ code: "unknown" })
          writeFileSync(`${root}/blocker`, "a file, not a directory")
          const unwritable = yield* Effect.flip(session.writeFile(`${root}/blocker/child`, new Uint8Array([1])))
          expect(unwritable).toMatchObject({ code: "unknown" })

          // A signalled command still reports a status, because the wrapper
          // waits for it rather than dying with it.
          const signalled = yield* Effect.scoped(
            Effect.gen(function*() {
              const process = yield* session.spawn("sleep 30", {})
              yield* session.kill!(process, "SIGTERM")
              return yield* process.exitCode
            })
          )
          expect(signalled).toBe(143)
        }))

      const shapes = cli.calls.map((call) => call.args)
      for (const args of shapes) {
        expect(args.slice(0, 12)).toEqual([
          "--profile",
          "sandbox",
          "--region",
          "us-west-2",
          "ecs",
          "execute-command",
          "--cluster",
          "cluster-arn",
          "--task",
          expect.stringContaining(":task/"),
          "--container",
          "runner"
        ])
        expect(args.slice(12, 14)).toEqual(["--interactive", "--command"])
      }
      expect(cli.calls.every((call) => call.file === "aws-wrapper")).toBe(true)
      // Every shipped helper uses the absolute shell path, which prevents a
      // task-level PATH override from disabling the provider's own plumbing.
      expect(cli.calls.every((call) => call.remote.startsWith("/bin/sh -c "))).toBe(true)
      // Twelve bytes at five per slice is three commands for the first write.
      const writes = cli.calls.filter((call) => call.remote.includes("base64 -d"))
      expect(writes.filter((call) => call.remote.includes("deep/tree/out.bin"))).toHaveLength(3)
      expect(cli.calls.some((call) => call.remote.includes("kids()"))).toBe(true)
      expect(fake.stopInputs).toHaveLength(1)
    }), 60_000)

  it.effect("uses the CLI defaults and omits the container flag when none is named", () =>
    Effect.gen(function*() {
      const fake = fakeEcs()
      const cli = fakeCli()
      yield* acquired(transportProvider(fake, cli), (session) => output(session, "true"))
      expect(cli.calls[0]!.file).toBe("aws")
      expect(cli.calls[0]!.args.slice(0, 2)).toEqual(["--region", "us-west-2"])
      expect(cli.calls[0]!.args).not.toContain("--container")
    }), 30_000)

  it.effect("reports transport failures as what they are", () =>
    Effect.gen(function*() {
      // The plugin itself failing to run is a transport failure, and it stops
      // acquisition at the workspace preparation.
      const missingPlugin = fakeCli({ pluginFailure: { code: 254, stderr: "SessionManagerPlugin is not found" } })
      const pluginFailure = yield* Effect.flip(
        acquired(transportProvider(fakeEcs(), missingPlugin), () => Effect.void)
      )
      expect(pluginFailure).toMatchObject({ code: "unavailable" })
      expect(pluginFailure.message).toContain("SessionManagerPlugin is not found")

      // A session that drops before the status line is never a success.
      const dropping = fakeCli({ dropSentinel: true })
      const droppedFailure = yield* Effect.flip(
        acquired(transportProvider(fakeEcs(), dropping), () => Effect.void)
      )
      expect(droppedFailure).toMatchObject({ code: "unavailable" })
      expect(droppedFailure.message).toContain("could not be prepared")

      // Drop the sentinel only once the session exists, so every operation's
      // own reaction to a dropped session is observable.
      let drop = false
      const flaky = fakeCli()
      const flakyWithDrops = fakeCli({ dropSentinel: true })
      const provider = transportProvider(fakeEcs(), {
        calls: flaky.calls,
        spawner: makeSpawner((command) => drop ? flakyWithDrops.spawner.spawn(command) : flaky.spawner.spawn(command))
      })
      yield* acquired(provider, (session) =>
        Effect.gen(function*() {
          drop = true
          const process = yield* Effect.scoped(
            Effect.flatMap(session.spawn("printf 'x'", {}), (process) => Effect.flip(process.exitCode))
          )
          expect(process).toMatchObject({ code: "aborted" })
          expect(yield* Effect.flip(session.readFile(`${root}/rooted.bin`))).toMatchObject({ code: "aborted" })
          expect(yield* Effect.flip(session.writeFile(`${root}/x.bin`, new Uint8Array([1])))).toMatchObject({
            code: "aborted"
          })
          const killFailure = yield* Effect.scoped(
            Effect.flatMap(session.spawn("true", {}), (running) => Effect.flip(session.kill!(running, "SIGTERM")))
          )
          expect(killFailure).toMatchObject({ code: "aborted" })
          drop = false
        }))

      // The plugin failing only after acquisition maps each spawn to a
      // transport failure rather than a fabricated exit.
      let broken = false
      const healthy = fakeCli()
      const dying = fakeCli({ pluginFailure: { code: 254, stderr: "connection reset" } })
      const decaying = transportProvider(fakeEcs(), {
        calls: healthy.calls,
        spawner: makeSpawner((command) => broken ? dying.spawner.spawn(command) : healthy.spawner.spawn(command))
      })
      yield* acquired(decaying, (session) =>
        Effect.gen(function*() {
          broken = true
          const failed = yield* Effect.scoped(
            Effect.flatMap(session.spawn("printf 'x'", {}), (process) => Effect.flip(process.exitCode))
          )
          expect(failed).toMatchObject({ code: "unavailable" })
          expect(failed.message).toContain("connection reset")
          broken = false
        }))

      // An older plugin with no banner line still parses.
      const bannerless = fakeCli({ noBanner: true })
      const plain = yield* acquired(transportProvider(fakeEcs(), bannerless), (session) =>
        output(session, "printf 'no banner'"))
      expect(plain).toEqual({ stdout: "no banner", code: 0 })

      // A workspace that cannot be prepared refuses the session.
      writeFileSync(`${root}/not-a-dir`, "")
      const unpreparable = yield* Effect.flip(
        acquired(transportProvider(fakeEcs(), fakeCli(), { workdir: `${root}/not-a-dir` }), () =>
          Effect.void)
      )
      expect(unpreparable).toMatchObject({ code: "unavailable" })
      expect(unpreparable.message).toContain("could not be prepared")
    }), 60_000)

  it.effect("registers neutral limits as task cpu, memory, and the essential sleep", () =>
    Effect.gen(function*() {
      const fake = fakeEcs()
      const base = {
        sdk: sdkOf(fake),
        region: "us-east-1",
        cluster: "cluster",
        image: "image:latest",
        taskRoleArn: "role",
        subnets: ["subnet-a"],
        pollIntervalMs: 0,
        maxPollAttempts: 2
      }
      yield* acquired(AwsSandbox.make({ ...base, limits: { cpus: 0.5, memoryMib: 1024, timeoutSecs: 600 } }), () =>
        Effect.void)
      expect(fake.registerInputs[0]).toMatchObject({
        cpu: "512",
        memory: "1024",
        containerDefinitions: [{ command: ["sleep", "600"] }]
      })
      expect(() =>
        AwsSandbox.make({ ...base, cpu: "512", limits: { cpus: 1 } })
      ).toThrow(/exclusive/)
      expect(() => AwsSandbox.make({ ...base, memory: "512", limits: { memoryMib: 512 } })).toThrow(/exclusive/)
      expect(() => AwsSandbox.make({ ...base, limits: { cpus: 0.3 } })).toThrow(/1024 cpu units per vCPU/)
      const cpuOnly = fakeEcs()
      yield* acquired(AwsSandbox.make({ ...base, sdk: sdkOf(cpuOnly), memory: "4096", limits: { cpus: 2 } }), () =>
        Effect.void)
      expect(cpuOnly.registerInputs[0]).toMatchObject({ cpu: "2048", memory: "4096" })
      const memoryOnly = fakeEcs()
      yield* acquired(
        AwsSandbox.make({ ...base, sdk: sdkOf(memoryOnly), cpu: "1024", limits: { memoryMib: 2048 } }),
        () =>
          Effect.void
      )
      expect(memoryOnly.registerInputs[0]).toMatchObject({
        cpu: "1024",
        memory: "2048",
        containerDefinitions: [{ command: ["sleep", "infinity"] }]
      })
    }))

  it("refuses every resource limit on a task definition at construction", () => {
    const deps = untouchable<never>()
    for (
      const [field, limits] of [
        ["cpus", { cpus: 1 }],
        ["memoryMib", { memoryMib: 512 }],
        ["timeoutSecs", { timeoutSecs: 60 }]
      ] as const
    ) {
      expect(() =>
        AwsSandbox.make({
          sdk: deps.value,
          region: "us-west-2",
          cluster: "cluster-arn",
          taskDefinition: "family:7",
          subnets: ["subnet-a"],
          limits
        })
      ).toThrow(`aws-sandbox: cannot enforce limits.${field}`)
    }
    expect(deps.touched).toEqual([])
  })

  it.effect("registers image task definitions and finalizes task before definition", () =>
    Effect.gen(function*() {
      const fake = fakeEcs()
      const provider = AwsSandbox.make({
        sdk: sdkOf(fake),
        region: "us-east-1",
        cluster: "cluster",
        image: "registry.example/sandbox:1",
        taskRoleArn: "arn:task-role",
        executionRoleArn: "arn:execution-role",
        subnets: ["subnet-a"],
        securityGroups: [],
        cpu: "512",
        memory: "1024",
        pollIntervalMs: 0,
        maxPollAttempts: 2
      })
      yield* acquired(provider, (session) => session.ping!)

      expect(fake.registerInputs[0]).toEqual({
        family: expect.stringMatching(/^smthrs-/),
        networkMode: "awsvpc",
        requiresCompatibilities: ["FARGATE"],
        cpu: "512",
        memory: "1024",
        taskRoleArn: "arn:task-role",
        executionRoleArn: "arn:execution-role",
        containerDefinitions: [{
          name: "sandbox",
          image: "registry.example/sandbox:1",
          essential: true,
          command: ["sleep", "infinity"],
          workingDirectory: "/workspace",
          linuxParameters: { initProcessEnabled: true }
        }]
      })
      expect(fake.runInputs[0]!.taskDefinition).toContain(":task-definition/")
      expect(fake.events.indexOf("stop")).toBeLessThan(fake.events.indexOf("deregister"))
      expect(fake.deregisterInputs).toHaveLength(1)

      const defaults = fakeEcs()
      const defaultProvider = AwsSandbox.make({
        sdk: sdkOf(defaults),
        region: "us-east-1",
        cluster: "cluster",
        image: "image:latest",
        taskRoleArn: "role",
        subnets: ["subnet-a"]
      })
      yield* acquired(defaultProvider, () => Effect.void, "short")
      expect(defaults.registerInputs[0]).toMatchObject({ cpu: "256", memory: "512" })
      expect(defaults.runInputs[0]!.networkConfiguration.awsvpcConfiguration).toEqual({
        subnets: ["subnet-a"],
        assignPublicIp: "DISABLED"
      })
    }))

  it.effect("polls documented ECS task and managed-agent readiness states", () =>
    Effect.gen(function*() {
      const fake = fakeEcs()
      fake.describeSteps.push(
        "missing",
        "empty",
        "pending",
        "no-containers",
        "no-agents",
        "wrong-agent",
        "wrong-container",
        "fallback-ready"
      )
      const provider = taskDefinitionProvider(fake, {
        container: "main",
        pollIntervalMs: 0,
        maxPollAttempts: 9
      })
      yield* acquired(provider, (session) => session.ping!)
      expect(fake.describeInputs.length).toBe(9)

      const stopped = fakeEcs()
      stopped.describeSteps.push("stopped")
      const stoppedFailure = yield* Effect.flip(acquired(
        taskDefinitionProvider(stopped),
        () => Effect.void
      ))
      expect(stoppedFailure).toMatchObject({ code: "unavailable" })
      expect(stopped.stopInputs).toHaveLength(1)

      const timedOut = fakeEcs()
      timedOut.describeSteps.push("missing")
      const timeoutFailure = yield* Effect.flip(acquired(
        taskDefinitionProvider(timedOut, { pollIntervalMs: 0, maxPollAttempts: 1 }),
        () => Effect.void
      ))
      expect(timeoutFailure).toMatchObject({ code: "timeout" })
    }))

  it.effect("finalizes every successfully created AWS resource on later failure", () =>
    Effect.gen(function*() {
      const describeFailed = fakeEcs()
      describeFailed.describeFault = { cause: new Error("describe failed") }
      describeFailed.stopFault = { cause: new Error("stop failed") }
      expect(yield* Effect.flip(acquired(taskDefinitionProvider(describeFailed), () => Effect.void))).toMatchObject({
        code: "unavailable"
      })
      expect(describeFailed.stopInputs).toHaveLength(1)

      const runFailed = fakeEcs()
      runFailed.runFault = { cause: new Error("run failed") }
      expect(yield* Effect.flip(acquired(taskDefinitionProvider(runFailed), () => Effect.void))).toMatchObject({
        code: "unavailable"
      })
      expect(runFailed.stopInputs).toHaveLength(0)

      const noTask = fakeEcs()
      noTask.runWithoutTask = true
      expect(yield* Effect.flip(acquired(taskDefinitionProvider(noTask), () => Effect.void))).toMatchObject({
        code: "unavailable"
      })
      expect(noTask.stopInputs).toHaveLength(0)

      const noArn = fakeEcs()
      noArn.runWithoutArn = true
      expect(yield* Effect.flip(acquired(taskDefinitionProvider(noArn), () => Effect.void))).toMatchObject({
        code: "unavailable"
      })

      const registerFailed = fakeEcs()
      registerFailed.registerFault = { cause: new Error("register failed") }
      const registerProvider = AwsSandbox.make({
        sdk: sdkOf(registerFailed),
        region: "region",
        cluster: "cluster",
        image: "image",
        taskRoleArn: "role",
        subnets: ["subnet"]
      })
      expect(yield* Effect.flip(acquired(registerProvider, () => Effect.void))).toMatchObject({
        code: "unavailable"
      })

      const missingDefinition = fakeEcs()
      missingDefinition.registerWithoutArn = true
      const missingProvider = AwsSandbox.make({
        sdk: sdkOf(missingDefinition),
        region: "region",
        cluster: "cluster",
        image: "image",
        taskRoleArn: "role",
        subnets: ["subnet"]
      })
      expect(yield* Effect.flip(acquired(missingProvider, () => Effect.void))).toMatchObject({
        code: "unavailable"
      })
      expect(missingDefinition.deregisterInputs).toHaveLength(0)

      const runAfterRegister = fakeEcs()
      runAfterRegister.runFault = { cause: new Error("run failed") }
      runAfterRegister.deregisterFault = { cause: new Error("deregister failed") }
      const runAfterRegisterProvider = AwsSandbox.make({
        sdk: sdkOf(runAfterRegister),
        region: "region",
        cluster: "cluster",
        image: "image",
        taskRoleArn: "role",
        subnets: ["subnet"]
      })
      expect(yield* Effect.flip(acquired(runAfterRegisterProvider, () => Effect.void))).toMatchObject({
        code: "unavailable"
      })
      expect(runAfterRegister.deregisterInputs).toHaveLength(1)
    }))

  it.effect("adopts the task a previous acquire of the same key left running", () =>
    Effect.gen(function*() {
      const fake = fakeEcs()
      const cli = fakeCli()
      const provider = transportProvider(fake, cli)
      // A crash is a scope whose finalizers never ran.
      const leaked = yield* Scope.make()
      const first = yield* Effect.provideService(provider.acquire("aws/resume"), Scope.Scope, leaked)
      const second = yield* acquired(provider, (session) => Effect.succeed(session.remoteId), "aws/resume")
      expect(second).toBe(first.remoteId)
      expect(fake.runInputs).toHaveLength(1)
      // `startedBy` must be the only ListTasks filter. Omitting desiredStatus
      // also uses ECS's RUNNING desired-status default, which includes a task
      // whose lastStatus is still PENDING.
      expect(fake.listInputs).toHaveLength(2)
      for (const input of fake.listInputs) {
        expect(input).toEqual({ cluster: "cluster-arn", startedBy: fake.runInputs[0]!.startedBy })
        expect(Object.hasOwn(input, "desiredStatus")).toBe(false)
      }
      // Releasing the adopting scope stops the adopted task like any other.
      expect(fake.stopInputs).toHaveLength(1)
      yield* Scope.close(leaked, Exit.void)

      // A crash-left task that is still PENDING is adopted and waited for, not
      // abandoned beside a second one that nothing would ever stop.
      const notReady = fakeEcs()
      const notReadyProvider = transportProvider(notReady, fakeCli())
      const leakedToo = yield* Scope.make()
      const pendingSession = yield* Effect.provideService(
        notReadyProvider.acquire("aws/pending"),
        Scope.Scope,
        leakedToo
      )
      const pendingTask = notReady.running.find(({ arn }) => arn === pendingSession.remoteId)!
      pendingTask.lastStatus = "PENDING"
      pendingTask.desiredStatus = "RUNNING"
      notReady.describeSteps.push("pending")
      const described = notReady.describeInputs.length
      yield* acquired(notReadyProvider, () => Effect.void, "aws/pending")
      expect(notReady.runInputs).toHaveLength(1)
      // The adopter waited for readiness rather than assuming it.
      expect(notReady.describeInputs.length).toBeGreaterThan(described + 1)
      expect(notReady.stopInputs).toHaveLength(1)
      yield* Scope.close(leakedToo, Exit.void)

      // A task whose desired status is STOPPED is excluded by the faithful
      // ListTasks default and cannot be adopted merely because its last status
      // still says PENDING.
      const stopping = fakeEcs()
      const stoppingProvider = transportProvider(stopping, fakeCli())
      const stoppingLeak = yield* Scope.make()
      const stoppingSession = yield* Effect.provideService(
        stoppingProvider.acquire("aws/stopping"),
        Scope.Scope,
        stoppingLeak
      )
      const stoppingTask = stopping.running.find(({ arn }) => arn === stoppingSession.remoteId)!
      stoppingTask.lastStatus = "PENDING"
      stoppingTask.desiredStatus = "STOPPED"
      const replacement = yield* acquired(
        stoppingProvider,
        (session) => Effect.succeed(session.remoteId),
        "aws/stopping"
      )
      expect(replacement).not.toBe(stoppingSession.remoteId)
      expect(stopping.runInputs).toHaveLength(2)
      expect(stopping.listInputs).toHaveLength(2)
      yield* Scope.close(stoppingLeak, Exit.void)

      // Two machines under one key collapse to one: the lowest ARN is adopted
      // and the duplicate is stopped before anything else is provisioned.
      const duplicated = fakeEcs()
      const duplicatedProvider = transportProvider(duplicated, fakeCli())
      const leakedTwice = yield* Scope.make()
      yield* Effect.provideService(duplicatedProvider.acquire("aws/duplicate"), Scope.Scope, leakedTwice)
      const orphan = "arn:aws:ecs:us-west-2:123456789012:task/cluster/task-99"
      duplicated.running.push({
        arn: orphan,
        tags: duplicated.runInputs[0]!.tags,
        taskDefinition: duplicated.runInputs[0]!.taskDefinition,
        startedBy: duplicated.runInputs[0]!.startedBy,
        lastStatus: "RUNNING",
        desiredStatus: "RUNNING"
      })
      yield* acquired(duplicatedProvider, () => Effect.void, "aws/duplicate")
      expect(duplicated.runInputs).toHaveLength(1)
      expect(duplicated.stopInputs.map(({ task }) => task)).toContain(orphan)
      yield* Scope.close(leakedTwice, Exit.void)

      // A listing with no ARNs field at all reads as nothing to adopt.
      const bare = fakeEcs()
      bare.listWithoutArns = true
      yield* acquired(transportProvider(bare, fakeCli()), () => Effect.void, "aws/bare")
      expect(bare.runInputs).toHaveLength(1)

      // Listing or describing leftovers failing is a failure to acquire.
      const listFailed = fakeEcs()
      listFailed.listFault = { cause: new Error("list failed") }
      expect(yield* Effect.flip(acquired(transportProvider(listFailed, fakeCli()), () => Effect.void))).toMatchObject({
        code: "unavailable"
      })
      const describeFailed = fakeEcs()
      const describeProvider = transportProvider(describeFailed, fakeCli())
      const leakedThrice = yield* Scope.make()
      yield* Effect.provideService(describeProvider.acquire("aws/described"), Scope.Scope, leakedThrice)
      describeFailed.describeFault = { cause: new Error("describe failed") }
      expect(yield* Effect.flip(acquired(describeProvider, () => Effect.void, "aws/described"))).toMatchObject({
        code: "unavailable"
      })
      yield* Scope.close(leakedThrice, Exit.void)
    }), 60_000)

  it.effect(
    "reads every ListTasks page before adopting, stopping duplicates, or refusing a foreign task",
    () =>
      Effect.gen(function*() {
        /** A crash leaves the first acquire's task; `count` more share its key, tags, and definition. */
        const crashLeft = (fake: FakeEcs, provider: ReturnType<typeof transportProvider>, key: string, count: number) =>
          Effect.gen(function*() {
            const leaked = yield* Scope.make()
            yield* Effect.provideService(provider.acquire(key), Scope.Scope, leaked)
            const run = fake.runInputs[0]!
            for (let index = 0; index < count; index++) {
              fake.running.push({
                arn: `arn:aws:ecs:us-west-2:123456789012:task/cluster/leftover-${String(index).padStart(3, "0")}`,
                tags: run.tags,
                taskDefinition: run.taskDefinition,
                startedBy: run.startedBy,
                lastStatus: "RUNNING",
                desiredStatus: "RUNNING"
              })
            }
            return { leaked, startedBy: run.startedBy }
          })

        // 100 and 101 leftovers beside the crashed task: one page and exactly
        // one more. Every one is verified, the lowest ARN adopted, the rest
        // stopped, and closing the adopting scope leaves nothing running.
        for (const count of [100, 101]) {
          const fake = fakeEcs()
          const provider = transportProvider(fake, fakeCli())
          const key = `aws/pages-${count}`
          const { leaked, startedBy } = yield* crashLeft(fake, provider, key, count)
          fake.listInputs.length = 0
          const adopted = yield* acquired(provider, (session) => Effect.succeed(session.remoteId), key)
          expect(adopted).toBe("arn:aws:ecs:us-west-2:123456789012:task/cluster/leftover-000")
          expect(fake.runInputs).toHaveLength(1)
          // With the crashed task that is 101 or 102 tasks: always a second page.
          expect(fake.listInputs.map(({ nextToken }) => nextToken)).toEqual([undefined, "page-100"])
          const leftovers = fake.describeInputs.slice(-2)
          expect(leftovers.map(({ tasks }) => tasks.length)).toEqual([100, count - 99])
          expect(fake.running.filter((task) => task.startedBy === startedBy)).toEqual([])
          expect(new Set(fake.stopInputs.map(({ task }) => task)).size).toBe(count + 1)
          yield* Scope.close(leaked, Exit.void)
        }

        // A foreign task on a later page refuses the key before anything is
        // stopped or started: an unverified resource is never deleted.
        const foreign = fakeEcs()
        foreign.listPageSize = 2
        const foreignProvider = transportProvider(foreign, fakeCli())
        const crashed = yield* crashLeft(foreign, foreignProvider, "aws/foreign", 3)
        const intruder = "arn:aws:ecs:us-west-2:123456789012:task/cluster/zz-foreign"
        foreign.running.push({
          arn: intruder,
          tags: [],
          taskDefinition: foreign.runInputs[0]!.taskDefinition,
          startedBy: crashed.startedBy,
          lastStatus: "RUNNING",
          desiredStatus: "RUNNING"
        })
        foreign.listInputs.length = 0
        const refused = yield* Effect.flip(acquired(foreignProvider, () => Effect.void, "aws/foreign"))
        expect(refused).toMatchObject({ code: "unavailable", message: expect.stringContaining(intruder) })
        expect(foreign.listInputs.map(({ nextToken }) => nextToken)).toEqual([undefined, "page-2", "page-4"])
        expect(foreign.stopInputs).toEqual([])
        expect(foreign.runInputs).toHaveLength(1)
        yield* Scope.close(crashed.leaked, Exit.void)

        // A list that hands back a page token it already gave cannot be read
        // to its end, so nothing is adopted, stopped, or started.
        const looping = fakeEcs()
        looping.listPageSize = 1
        const loopingProvider = transportProvider(looping, fakeCli())
        const stuck = yield* crashLeft(looping, loopingProvider, "aws/looping", 2)
        looping.listRepeatsToken = true
        const repeated = yield* Effect.flip(acquired(loopingProvider, () => Effect.void, "aws/looping"))
        expect(repeated).toMatchObject({
          code: "unavailable",
          message: expect.stringContaining("repeated a page token")
        })
        expect(looping.stopInputs).toEqual([])
        expect(looping.runInputs).toHaveLength(1)
        yield* Scope.close(stuck.leaked, Exit.void)
      }),
    60_000
  )

  it.effect(
    "signals the guest when a spawn scope closes on a live command, and not on an ended one",
    () =>
      Effect.gen(function*() {
        const fake = fakeEcs()
        const cli = fakeCli()
        yield* acquired(transportProvider(fake, cli), (session) =>
          Effect.gen(function*() {
            const kills = () => cli.calls.filter((call) => call.remote.includes("kids()")).length
            yield* Effect.scoped(Effect.asVoid(session.spawn("sleep 30", {})))
            expect(kills()).toBe(1)
            yield* output(session, "true")
            expect(kills()).toBe(1)
          }))
      }),
    60_000
  )

  it.effect("fails a signal whose guest kill command reports a nonzero status", () =>
    Effect.gen(function*() {
      const cli = fakeCli({
        guestResult: (remote) =>
          remote.includes("kids()") ? { code: 1, payload: "kill: operation not permitted" } : undefined
      })
      yield* acquired(transportProvider(fakeEcs(), cli), (session) =>
        Effect.scoped(
          Effect.gen(function*() {
            const process = yield* session.spawn("sleep 30", {})
            const error = yield* Effect.flip(session.kill!(process, "SIGTERM"))
            expect(error).toBeInstanceOf(ProviderError)
            expect(error).toMatchObject({ code: "unknown" })
            expect(error.message).toContain("SIGTERM")
            expect(error.message).toContain(session.remoteId)
            expect(error.message).toContain("operation not permitted")
          })
        ))
    }), 30_000)

  it.effect(
    "signals the guest when a spawn scope closes after its status sentinel was dropped",
    () =>
      Effect.gen(function*() {
        let drop = false
        const healthy = fakeCli()
        const dropping = fakeCli({ dropSentinel: true })
        const provider = transportProvider(fakeEcs(), {
          calls: healthy.calls,
          spawner: makeSpawner((command) => drop ? dropping.spawner.spawn(command) : healthy.spawner.spawn(command))
        })

        yield* acquired(provider, (session) =>
          Effect.gen(function*() {
            drop = true
            const scope = yield* Scope.make()
            const process = yield* Effect.provideService(session.spawn("true", {}), Scope.Scope, scope)
            const error = yield* Effect.flip(process.exitCode)
            expect(error).toMatchObject({ code: "aborted" })

            drop = false
            yield* Scope.close(scope, Exit.void)
            const calls = [...healthy.calls, ...dropping.calls]
            expect(calls.filter((call) => call.remote.includes("kids()"))).toHaveLength(1)
          }))
      }),
    30_000
  )

  it.effect(
    "refuses a write-slice size that would spin or truncate, and accepts the rest",
    () =>
      Effect.gen(function*() {
        // `chunkBytes` is the increment of the loop that splits a file into
        // commands. `0` and negatives never advance the offset and spin forever
        // on empty slices; `NaN` makes the offset `NaN` after one iteration and
        // ends the loop having written a single empty slice, which is a silently
        // truncated file rather than an error.
        for (const chunkBytes of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5, 3072.5]) {
          const error = yield* Effect.flip(
            acquired(transportProvider(fakeEcs(), fakeCli(), {}, { chunkBytes }), () => Effect.void)
          )
          expect(error).toMatchObject({ code: "spawn_error" })
          expect((error as ProviderError).message).toContain("ExecTransport.chunkBytes")
          expect((error as ProviderError).message).toContain("from 1 to 65536")
          expect((error as ProviderError).message).toContain(String(chunkBytes))
        }

        // A single byte per slice is legal, if wasteful, and the file still
        // arrives whole.
        const bytes = new Uint8Array([0, 1, 2, 250, 251, 252])
        const round = yield* acquired(
          transportProvider(fakeEcs(), fakeCli(), {}, { chunkBytes: 1 }),
          (session) =>
            Effect.gen(function*() {
              yield* session.writeFile(`${root}/sliced.bin`, bytes)
              return yield* session.readFile(`${root}/sliced.bin`)
            })
        )
        expect(Array.from(round)).toEqual(Array.from(bytes))
      }),
    60_000
  )

  it.effect("accepts a 65536-byte write slice and refuses 65537", () =>
    Effect.gen(function*() {
      yield* acquired(
        transportProvider(fakeEcs(), fakeCli(), {}, { chunkBytes: 65_536 }),
        () => Effect.void
      )
      const error = yield* Effect.flip(
        acquired(
          transportProvider(fakeEcs(), fakeCli(), {}, { chunkBytes: 65_537 }),
          () => Effect.void
        )
      )
      expect(error).toMatchObject({ code: "spawn_error" })
      expect((error as ProviderError).message).toContain("from 1 to 65536")
      expect((error as ProviderError).message).toContain("65537")
    }))

  it.effect("provisions rather than adopting when every task the key names has stopped", () =>
    Effect.gen(function*() {
      // A key whose leftovers are all STOPPED owns no machine: adopting one
      // would hand the caller a task that can never run a command.
      const stopped = fakeEcs()
      const stoppedProvider = transportProvider(stopped, fakeCli())
      const leaked = yield* Scope.make()
      yield* Effect.provideService(stoppedProvider.acquire("aws/stopped"), Scope.Scope, leaked)
      stopped.describeSteps.push("stopped")
      yield* acquired(stoppedProvider, () => Effect.void, "aws/stopped")
      expect(stopped.runInputs).toHaveLength(2)
      yield* Scope.close(leaked, Exit.void)

      // A listed task missing from describe cannot be verified, so fail
      // without provisioning beside it or stopping it.
      for (const [step, key] of [["empty", "aws/empty"], ["missing", "aws/missing"]] as const) {
        const bare = fakeEcs()
        const bareProvider = transportProvider(bare, fakeCli())
        const leakedToo = yield* Scope.make()
        yield* Effect.provideService(bareProvider.acquire(key), Scope.Scope, leakedToo)
        bare.describeSteps.push(step)
        expect(yield* Effect.flip(acquired(bareProvider, () => Effect.void, key))).toMatchObject({
          code: "unavailable"
        })
        expect(bare.runInputs).toHaveLength(1)
        expect(bare.stopInputs).toHaveLength(0)
        yield* Scope.close(leakedToo, Exit.void)
      }
    }), 60_000)

  it.effect(
    "pins the nonce framing that separates a command's status from terminal noise",
    () =>
      Effect.gen(function*() {
        // The plugin exits zero whatever the remote command did, so the status
        // travels in-band inside this framing. Both halves of it are written
        // here and parsed here; a change to either that is not a change to both
        // reads every command as `aborted`.
        const cli = fakeCli()
        const ran = yield* acquired(
          transportProvider(fakeEcs(), cli),
          (session) => output(session, "echo framed; exit 4")
        )
        // The wrapper's own status line is what the exit code came from: the
        // plugin reported zero.
        expect(ran).toEqual({ stdout: "framed\n", code: 4 })

        // The workspace and the random nonce are the parts of these lines this
        // test cannot know.
        const framing = (command: string): string =>
          command.replaceAll(root, "<workdir>").replace(/__smthrs_exit_[0-9a-f]{32}_/, "__smthrs_exit_<nonce>_")
        const first = cli.calls[0]!
        expect(first.args.at(-2)).toBe("--command")
        expect(framing(first.args.at(-1)!)).toBe(
          "/bin/sh -c '( mkdir -p <workdir> && rm -rf /tmp/.smthrs-sbx && mkdir -p /tmp/.smthrs-sbx ); "
            + "printf '\\''\\n__smthrs_exit_<nonce>_%s__\\n'\\'' \"$?\"'"
        )
        // A spawned command records its pid, honors a cancellation left before
        // it started, and prints the same sentinel with its own nonce.
        const spawned = cli.calls.find((call) => call.args.at(-1)?.includes("echo framed") === true)!
        expect(framing(spawned.args.at(-1)!)).toBe(
          "/bin/sh -c 'if [ -e /tmp/.smthrs-sbx/0.pid.cancel ]; then c=143; "
            + "elif cd <workdir>; then /bin/sh -c '\\''echo framed; exit 4'\\'' & p=$!; "
            + "echo \"$p\" > /tmp/.smthrs-sbx/0.pid; if [ -e /tmp/.smthrs-sbx/0.pid.cancel ]; "
            + "then kill -s TERM \"$p\" 2>/dev/null; fi; wait \"$p\"; c=$?; else c=127; fi; "
            + "printf '\\''\\n__smthrs_exit_<nonce>_%s__\\n'\\'' \"$c\"'"
        )
      }),
    60_000
  )

  it.effect(
    "ignores a sentinel a detached child prints after the wrapper's status",
    () =>
      Effect.gen(function*() {
        // Guest code reads its own wrapper's nonce off the process table, exits
        // 3, and leaves a child that prints a forged success line after the
        // wrapper's real one. The first sentinel is the status.
        const ran = yield* acquired(
          transportProvider(fakeEcs(), fakeCli()),
          (session) =>
            output(
              session,
              "n=$(ps -o args= -p $PPID | grep -oE '__smthrs_exit_[0-9a-f]{32}_'); "
                + "[ -n \"$n\" ] || exit 99; "
                + "( sleep 0.3; printf '\\n%s0__\\n' \"$n\"; printf '\\n__smthrs_exit_1_0__\\n' ) & exit 3"
            )
        )
        expect(ran.code).toBe(3)
      }),
    60_000
  )

  it.effect("draws a fresh 128-bit sentinel nonce for every framed run", () =>
    Effect.gen(function*() {
      const cli = fakeCli()
      yield* acquired(transportProvider(fakeEcs(), cli), (session) =>
        Effect.gen(function*() {
          yield* output(session, "true")
          yield* output(session, "true")
        }))
      const nonces = cli.calls.map((call) => /__smthrs_exit_([0-9a-f]+)_/.exec(call.remote)?.[1])
      expect(nonces.length).toBeGreaterThanOrEqual(3)
      for (const nonce of nonces) expect(nonce).toMatch(/^[0-9a-f]{32}$/)
      expect(new Set(nonces).size).toBe(nonces.length)
    }), 60_000)

  it.effect("passes the sandbox conformance suite through the CLI session transport", () =>
    Effect.gen(function*() {
      const violations = yield* SandboxConformance.check(transportProvider(fakeEcs(), fakeCli()), {
        provides: { ping: true, kill: true },
        commands: { ...SandboxConformance.uniquePosixCommands(), stopsWithin: "15 seconds" },
        checkTimeout: "25 seconds"
      })
      expect(violations).toEqual([])
    }), 120_000)

  it.effect("names every obligation a transport-less provider cannot meet", () =>
    Effect.gen(function*() {
      const violations = yield* SandboxConformance.check(taskDefinitionProvider(fakeEcs()), {
        provides: { ping: true }
      })
      expect(violations.map(({ check }) => check)).toEqual([
        "round-trips-binary-bytes",
        "round-trips-an-empty-file",
        "round-trips-a-large-file",
        "reports-an-absent-file",
        "creates-parent-directories",
        "runs-in-its-workdir",
        "roots-a-relative-cwd",
        "delivers-the-environment",
        "deletes-inherited-environment-or-refuses",
        "delivers-standard-input",
        "delivers-standard-error",
        "files-reach-processes",
        "processes-reach-files",
        "reacquires-its-session",
        "writes-its-output",
        "reports-a-nonzero-exit",
        // The session contract obliges every provider to deliver standard
        // input, so a transport-less one is named for that too.
        "delivers-standard-input"
      ])
    }))
})
