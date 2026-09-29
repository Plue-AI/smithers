import { NodeChildProcessSpawner, NodeFileSystem } from "@effect/platform-node"
import { afterAll, describe, expect, it } from "@effect/vitest"
import { Effect, Exit, Layer, Path, PlatformError, Sink, Stream } from "effect"
import * as Scope from "effect/Scope"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import {
  ChildProcessSpawner,
  ExitCode,
  make as makeSpawner,
  makeHandle,
  ProcessId
} from "effect/unstable/process/ChildProcessSpawner"
import { createHmac } from "node:crypto"
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sessionSlug } from "../src/internal/sessionSlug.ts"
import * as KubernetesSandbox from "../src/KubernetesSandbox/index.ts"
import { ProviderError } from "../src/RemoteChildProcessSpawner/ProviderError.ts"
import type { Session } from "../src/Sandbox/index.ts"
import * as SandboxConformance from "../src/SandboxConformance/index.ts"
import { untouchable } from "./helpers/untouchable.ts"
import { stalledFinalizer } from "./stalledFinalizer.ts"

// -----------------------------------------------------------------------------
// The kubectl CLI as a fake: real shells behind kubectl's argv contract.
// -----------------------------------------------------------------------------

// The fake emulates only what kubectl and the API server contribute — the
// run/wait/get/label/exec/delete verbs, server-side Pod uniqueness, phases, exit
// codes, and stderr text — and every guest command runs through a real
// `/bin/sh` against a real directory, so pidfiles, signals, `base64`, and
// `pgrep` are all genuine. The fixed guest pid directory is remapped under
// the test root the way the AWS fake remaps it; the local shell starts in the
// image's default directory (the test root), so the provider's `cd` is what
// places a command; and the guest program runs under a supervising local
// shell so a signalled command reports `128+signal` the way the kubectl
// client does instead of failing the local exit observation.
const root = realpathSync(mkdtempSync(join(tmpdir(), "smthrs-kubernetes-sandbox-")))
const workdir = join(root, "workspace")
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

// A long-running fixture whose duration is this process's own, kept below the
// conformance suite's 4200+ range and apart from the container test file's
// 3700+ range, so no concurrent vitest worker's fixture can match this file's
// survivor probes. The probe brackets the last digit so it cannot match its
// own command line.
const sleepDuration = String(3850 + (process.pid % 150))
const sleeps = `sleep ${sleepDuration}`
const survivor = `pgrep -f 'sleep ${sleepDuration.slice(0, -1)}[${sleepDuration.slice(-1)}]'`

interface Call {
  readonly file: string
  readonly args: ReadonlyArray<string>
  readonly input: string
}

interface Response {
  readonly wait?: Effect.Effect<void>

  readonly stdout?: string | undefined
  readonly stderr?: string | undefined
  readonly exitCode?: number | undefined
  readonly failSpawn?: boolean | undefined
  readonly failObserve?: boolean | undefined
}

interface Pod {
  manifest: {
    metadata: { uid?: string; labels: Record<string, string> }
    spec: { containers: Array<{ name: string; image: string; command?: ReadonlyArray<string> }> }
  }
  phase: string
  readonly env: Record<string, string>
}

const remap = (token: string): string => token.replaceAll("/tmp/.smthrs-sbx", `${root}/.pids`)

const cluster = (fault: (args: ReadonlyArray<string>) => Response | undefined = () => undefined) => {
  const calls: Array<Call> = []
  const pods = new Map<string, Pod>()
  const canned = (response: Response) =>
    makeHandle({
      pid: ProcessId(1),
      exitCode: response.failObserve === true
        ? Effect.fail(
          PlatformError.badArgument({ module: "ChildProcess", method: "exitCode", description: "lost" })
        )
        : Effect.as(response.wait ?? Effect.void, ExitCode(response.exitCode ?? 0)),
      isRunning: Effect.succeed(false),
      kill: () => Effect.void,
      stdin: Sink.drain,
      stdout: response.stdout === undefined ? Stream.empty : Stream.make(encoder.encode(response.stdout)),
      stderr: response.stderr === undefined ? Stream.empty : Stream.make(encoder.encode(response.stderr)),
      all: Stream.empty,
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
      unref: Effect.succeed(Effect.void)
    })
  const spawner = makeSpawner((command: ChildProcess.Command) =>
    Effect.gen(function*() {
      if (command._tag !== "StandardCommand") {
        return yield* Effect.fail(
          PlatformError.badArgument({ module: "ChildProcess", method: "spawn", description: "no pipelines here" })
        )
      }
      const input = Stream.isStream(command.options.stdin)
        ? yield* Stream.runFold(command.options.stdin as Stream.Stream<Uint8Array>, () =>
          "", (text, bytes) =>
          text + new TextDecoder().decode(bytes))
        : ""
      calls.push({ file: command.command, input, args: command.args })
      const injected = fault(command.args)
      if (injected?.failSpawn === true) {
        return yield* Effect.fail(
          PlatformError.badArgument({ module: "ChildProcess", method: "spawn", description: "kubectl missing" })
        )
      }
      if (injected !== undefined) {
        return canned(injected)
      }
      const args = [...command.args]
      while (["--context", "--namespace", "--kubeconfig"].includes(args[0] ?? "")) {
        args.splice(0, 2)
      }
      if (args[0] === "run" && args.includes("--dry-run=client")) {
        return canned({
          stdout: JSON.stringify({
            apiVersion: "v1",
            kind: "Pod",
            metadata: {
              name: args[1],
              labels: Object.fromEntries(
                args[args.indexOf("--labels") + 1]!.split(",").map((label) =>
                  label.split("=")
                )
              )
            },
            spec: {
              containers: [{ name: args[1], image: args[args.indexOf("--image") + 1] }]
            }
          })
        })
      }
      if (args[0] === "run" || args[0] === "create") {
        const manifest = args[0] === "create" ? JSON.parse(input) : undefined
        const name = manifest?.metadata.name ?? args[1]!
        if (pods.has(name)) {
          return canned({ exitCode: 1, stderr: `Error from server (AlreadyExists): pods "${name}" already exists\n` })
        }
        const env = Object.fromEntries(
          (manifest?.spec.containers[0].env ?? []).map((
            entry: { name: string; value: string }
          ) => [entry.name, entry.value])
        )
        const labels = args.includes("--labels")
          ? Object.fromEntries(args[args.indexOf("--labels") + 1]!.split(",").map((label) => label.split("=")))
          : {}
        pods.set(name, {
          phase: "Running",
          env,
          manifest: manifest === undefined
            ? {
              metadata: { uid: crypto.randomUUID(), labels },
              spec: { containers: [{ name, image: args[args.indexOf("--image") + 1]! }] }
            }
            : { ...manifest, metadata: { ...manifest.metadata, uid: crypto.randomUUID() } }
        })
        return canned({ stdout: `pod/${name} created\n` })
      }
      if (args[0] === "label") {
        const pod = pods.get(args[1]!.slice(4))
        if (pod === undefined) return canned({ exitCode: 1, stderr: `Error from server (NotFound)\n` })
        const [key, value] = args.at(-1)!.split("=")
        pod.manifest.metadata.labels[key!] = value!
        return canned({ stdout: `pod/${args[1]!.slice(4)} labeled\n` })
      }
      if (args[0] === "wait") {
        const name = args.find((arg) => arg.startsWith("pod/"))?.slice(4) ?? ""
        const pod = pods.get(name)
        if (pod === undefined) {
          return canned({ exitCode: 1, stderr: `Error from server (NotFound): pods "${name}" not found\n` })
        }
        // kubectl blocks for its whole timeout on a Pod that can never become
        // Ready again; the fake reports the same failure without the wait.
        return pod.phase === "Running"
          ? canned({ stdout: `pod/${name} condition met\n` })
          : canned({ exitCode: 1, stderr: `error: timed out waiting for the condition on pods/${name}\n` })
      }
      if (args[0] === "get") {
        const pod = pods.get(args[2]!)
        return pod === undefined
          ? canned({ exitCode: 1, stderr: `Error from server (NotFound): pods "${args[2]}" not found\n` })
          : canned({
            stdout: args.at(-1) === "json"
              ? JSON.stringify({ ...pod.manifest, status: { phase: pod.phase } })
              : args.at(-1) === "jsonpath={.metadata.uid}"
              ? pod.manifest.metadata.uid ?? ""
              : pod.phase
          })
      }
      if (args[0] === "delete") {
        const name = args[1]!.slice(4)
        return pods.delete(name)
          ? canned({ stdout: `pod "${name}" force deleted\n` })
          : canned({ exitCode: 1, stderr: `Error from server (NotFound): pods "${name}" not found\n` })
      }
      // exec [-i|--stdin] NAME -- PROGRAM ARGS...
      let index = 1
      let interactive = false
      while (args[index] === "-i" || args[index] === "--stdin") {
        interactive = true
        index += 1
      }
      const name = args[index]!
      const pod = pods.get(name)
      if (pod === undefined) {
        return canned({ exitCode: 1, stderr: `Error from server (NotFound): pods "${name}" not found\n` })
      }
      if (pod.phase !== "Running") {
        return canned({
          exitCode: 1,
          stderr: `error: cannot exec into a container in a completed pod; current phase is ${pod.phase}\n`
        })
      }
      const separator = args.indexOf("--")
      const guest = args.slice(separator + 1)
      // The fake already consumed the transport input above. Drain the local
      // replay if the guest refuses a write before reading it, preserving that
      // guest status without introducing a second, broken host input pipe.
      const supervise = interactive ? `"$0" "$@"; status=$?; cat > /dev/null; exit "$status"` : `"$0" "$@"; exit "$?"`
      const child = yield* local.spawn(
        ChildProcess.make("/bin/sh", ["-c", supervise, guest[0]!, ...guest.slice(1).map(remap)], {
          cwd: root,
          env: pod.env,
          extendEnv: true,
          ...interactive && Stream.isStream(command.options.stdin)
            ? { stdin: command.options.stdin as Stream.Stream<Uint8Array> }
            : {}
        })
      )
      return makeHandle({
        pid: child.pid,
        exitCode: child.exitCode,
        isRunning: child.isRunning,
        kill: (killOptions) => child.kill(killOptions),
        stdin: Sink.drain,
        stdout: child.stdout,
        stderr: child.stderr,
        all: child.all,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: child.unref
      })
    })
  )
  return { calls, pods, spawner }
}

const acquired = <A, E>(
  provider: ReturnType<typeof KubernetesSandbox.make>,
  body: (session: Session) => Effect.Effect<A, E>,
  session = "run-1"
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

describe("KubernetesSandbox", () => {
  it("refuses every network policy at construction, before touching its dependencies", () => {
    const deps = untouchable<never>()
    for (const network of ["none", { allow: ["example.com"] }] as const) {
      expect(() => KubernetesSandbox.make({ spawner: deps.value, image: "img", network }))
        .toThrow("kubernetes-sandbox: cannot enforce a network policy; omit `network`")
    }
    expect(deps.touched).toEqual([])
  })

  it.effect("bounds stalled process signalling on the platform timer", () =>
    stalledFinalizer((stall) => {
      const fake = cluster((args) => args.at(-1)?.includes("kill -s TERM") === true ? { wait: stall } : undefined)
      return acquired(KubernetesSandbox.make({ spawner: fake.spawner, image: "img", workdir }), (session) =>
        Effect.scoped(session.spawn("true", {})))
    }, ".pid"))

  it.effect("bounds stalled session removal on the platform timer", () =>
    stalledFinalizer((stall) => {
      const fake = cluster((args) => args[0] === "delete" ? { wait: stall } : undefined)
      return acquired(KubernetesSandbox.make({ spawner: fake.spawner, image: "img", workdir }), Effect.succeed)
    }, "smthrs-"))

  it.effect("rejects missing ownership and altered live or terminal Pod specifications", () =>
    Effect.gen(function*() {
      for (
        const change of [
          "labels",
          "owner",
          "image",
          "serviceAccount",
          "hostNetwork",
          "hostPID",
          "hostIPC",
          "privileged",
          "hostPath",
          "json"
        ] as const
      ) {
        let label = ""
        const fake = cluster((args) => {
          if (args[0] === "run") {
            label = args[args.indexOf("--labels") + 1]!.split("=")[1]!
            return { exitCode: 1, stderr: "AlreadyExists" }
          }
          if (args[0] !== "get") return undefined
          return {
            stdout: change === "json" ? "{" : JSON.stringify({
              metadata: {
                labels: change === "labels"
                  ? {}
                  : { "smithers.dev/sandbox-fingerprint": change === "owner" ? "other" : label }
              },
              spec: {
                serviceAccountName: change === "serviceAccount" ? "admin" : "runner",
                hostNetwork: change === "hostNetwork",
                hostPID: change === "hostPID",
                hostIPC: change === "hostIPC",
                containers: [{
                  name: args[2],
                  image: change === "image" ? "other" : "img",
                  securityContext: { privileged: change === "privileged" }
                }],
                volumes: change === "hostPath" ? [{ hostPath: { path: "/" } }] : []
              },
              status: { phase: "Succeeded" }
            })
          }
        })
        const provider = KubernetesSandbox.make({
          spawner: fake.spawner,
          image: "img",
          workdir,
          serviceAccount: "runner"
        })
        expect(yield* Effect.flip(Effect.scoped(provider.acquire("inspect")))).toMatchObject({ code: "unavailable" })
        expect(fake.calls.some(({ args }) => ["wait", "exec", "delete"].includes(args[0]!))).toBe(false)
      }
    }))

  it.effect("reattaches matching Pod options and accepts ordinary non-host volumes", () =>
    Effect.gen(function*() {
      for (const createArgs of [[], ["--image-pull-policy", "Never"]]) {
        let label = ""
        const fake = cluster((args) => {
          if (args[0] === "run") {
            label = args[args.indexOf("--labels") + 1]!.split("=")[1]!
            return { exitCode: 1, stderr: "AlreadyExists" }
          }
          if (args[0] === "get") {
            return {
              stdout: JSON.stringify({
                metadata: {
                  uid: "uid-1",
                  labels: {
                    "smithers.dev/sandbox-fingerprint": label,
                    // The seal the provider's wire contract names:
                    // HMAC-SHA256(key, fingerprint NUL uid), 60 hex digits.
                    "smithers.dev/sandbox-seal": "s1-" +
                      createHmac("sha256", "operator-key").update(`${label}\0uid-1`).digest("hex").slice(0, 60)
                  }
                },
                spec: {
                  serviceAccountName: "runner",
                  containers: [
                    { name: "sidecar", image: "sidecar" },
                    { name: args[2], image: "img", securityContext: { privileged: false } }
                  ],
                  volumes: [{ emptyDir: {} }]
                },
                status: { phase: "Running" }
              })
            }
          }
          return {}
        })
        const provider = KubernetesSandbox.make({
          spawner: fake.spawner,
          image: "img",
          workdir,
          serviceAccount: "runner",
          createArgs,
          reattachKey: "operator-key"
        })
        yield* Effect.scoped(provider.acquire("match"))
        expect(fake.calls.some(({ args }) => args[0] === "wait")).toBe(true)
        // Adopted, not replaced: the sealed leftover is never deleted before use.
        expect(fake.calls.findIndex(({ args }) => args[0] === "delete"))
          .toBeGreaterThan(fake.calls.findIndex(({ args }) => args[0] === "wait"))
      }
    }))

  it.effect("refuses a crash-left Pod with a different image or service account", () =>
    Effect.gen(function*() {
      const fake = cluster()
      const leaked = yield* Scope.make()
      const old = KubernetesSandbox.make({
        spawner: fake.spawner,
        image: "old-image",
        workdir,
        serviceAccount: "administrator",
        createArgs: ["--privileged"]
      })
      yield* Effect.provideService(old.acquire("isolation"), Scope.Scope, leaked)
      fake.calls.length = 0
      const next = KubernetesSandbox.make({ spawner: fake.spawner, image: "img", workdir })
      const result = yield* Effect.exit(Effect.scoped(next.acquire("isolation")))
      expect(Exit.isFailure(result)).toBe(true)
      expect(fake.calls.some(({ args }) => ["wait", "exec", "delete"].includes(args[0]!))).toBe(false)
      yield* Scope.close(leaked, Exit.void)
    }))

  it.effect(
    "merges creation environment into the stdin manifest and refuses failed rendering",
    () =>
      Effect.gen(function*() {
        const fake = cluster((args) =>
          args.includes("--dry-run=client") ?
            {
              stdout: JSON.stringify({
                metadata: {
                  name: args[1],
                  labels: Object.fromEntries(
                    args[args.indexOf("--labels") + 1]!.split(",").map((label) => label.split("="))
                  )
                },
                spec: {
                  containers: [
                    { name: "sidecar" },
                    { name: args[1], env: [{ name: "KEPT", value: "base" }, { name: "TOKEN", value: "old" }] }
                  ]
                }
              })
            } :
            undefined
        )
        // Inspect the manifest without requiring the fake to choose among sidecars.
        yield* acquired(
          KubernetesSandbox.make({ spawner: fake.spawner, image: "img", workdir, env: { TOKEN: "secret" } }),
          () => Effect.void
        )
        const manifest = JSON.parse(fake.calls.find((call) => call.args[0] === "create")!.input)
        expect(manifest.spec.containers).toEqual([
          { name: "sidecar" },
          { name: expect.any(String), env: [{ name: "KEPT", value: "base" }, { name: "TOKEN", value: "secret" }] }
        ])
        for (
          const response of [{ stdout: "invalid json" }, { stdout: "{}" }, { exitCode: 1, stderr: "cannot render" }]
        ) {
          const broken = cluster((args) => args.includes("--dry-run=client") ? response : undefined)
          const error = yield* Effect.flip(
            acquired(
              KubernetesSandbox.make({ spawner: broken.spawner, image: "img", workdir, env: { TOKEN: "secret" } }),
              Effect.succeed
            )
          )
          expect(error).toBeInstanceOf(ProviderError)
          expect(error.code).toBe(response.exitCode === 1 ? "unavailable" : "spawn_error")
          expect(broken.calls.some((call) => call.args[0] === "create")).toBe(false)
        }
      }),
    30_000
  )

  it.effect("keeps creation and spawn environment values and stdin out of local argv", () =>
    Effect.gen(function*() {
      const fake = cluster()
      const secret = "ARGV_ENV_CANARY_'_é\nsecond line $(printf injected)\n"
      const boot = "ARGV_BOOT_CANARY\nsecond line"
      const bytes = encoder.encode("ARGV_STDIN_CANARY\n\u0000tail")
      yield* acquired(
        KubernetesSandbox.make({
          spawner: fake.spawner,
          image: "img",
          workdir,
          env: { BOOT: boot, smthrs_env: "inherited" }
        }),
        (session) =>
          Effect.gen(function*() {
            expect((yield* output(session, `printf '%s' "$BOOT"`)).stdout).toBe(boot)
            expect((yield* output(session, `printf '%s' "$TOKEN"`, { env: { TOKEN: secret } })).stdout).toBe(secret)
            expect((yield* output(session, `printf '%s' "$smthrs_env"`, { env: { TOKEN: secret } })).stdout).toBe(
              "inherited"
            )
            yield* output(session, "cat > canary.bin", { env: { TOKEN: secret }, stdin: bytes })
            expect(Array.from(yield* session.readFile(`${workdir}/canary.bin`))).toEqual(Array.from(bytes))
          })
      )
      const argv = fake.calls.flatMap((call) => call.args).join("\n")
      for (
        const value of [
          boot,
          "ARGV_ENV_CANARY",
          "ARGV_STDIN_CANARY",
          Buffer.from(secret).toString("base64"),
          Buffer.from(bytes).toString("base64")
        ]
      ) {
        expect(argv).not.toContain(value)
      }
      for (const call of fake.calls) {
        if (call.input.length > 0) expect(argv).not.toContain(call.input.trimEnd())
      }
    }), 30_000)

  it.effect("threads shaping and global flags through the full Pod lifecycle", () =>
    Effect.gen(function*() {
      const spaced = join(root, "work dir")
      const fake = cluster()
      const provider = KubernetesSandbox.make({
        spawner: fake.spawner,
        image: "img:tag",
        namespace: "test-ns",
        program: "k",
        context: "test-context",
        kubeconfig: "/tmp/kube config",
        workdir: spaced,
        env: { SEED: "1" },
        labels: { app: "sandbox", tier: "test" },
        resources: {
          requests: { cpu: "10m", memory: "16Mi" },
          limits: { cpu: "100m", memory: "64Mi" }
        },
        serviceAccount: "runner",
        nodeSelector: { "kubernetes.io/os": "linux" },
        createArgs: ["--image-pull-policy", "IfNotPresent"],
        namePrefix: "T_"
      })
      const session = yield* acquired(provider, (session) =>
        Effect.scoped(
          Effect.gen(function*() {
            yield* session.writeFile(`${spaced}/file.bin`, new Uint8Array([1, 2]))
            expect(Array.from(yield* session.readFile(`${spaced}/file.bin`))).toEqual([1, 2])
            // The container-wide environment reaches every spawned command.
            expect(
              yield* Effect.scoped(
                Effect.flatMap(
                  session.spawn(`printf '%s' "$SEED"`, {}),
                  (process) => Stream.mkString(Stream.decodeText(process.stdout))
                )
              )
            ).toBe("1")
            const remote = yield* session.spawn(sleeps, {})
            yield* session.kill!(remote, "SIGTERM")
            expect(yield* remote.exitCode).toBe(143)
            yield* session.ping!
            return session
          })
        ))
      expect(session).toMatchObject({ id: "run-1", workdir: spaced })
      expect(session.remoteId.startsWith("t-run-1-")).toBe(true)
      const globals = [
        "--context",
        "test-context",
        "--namespace",
        "test-ns",
        "--kubeconfig",
        "/tmp/kube config"
      ]
      for (const call of fake.calls) {
        expect(call.file).toBe("k")
        expect(call.args.slice(0, globals.length)).toEqual(globals)
      }
      const localCalls = fake.calls.map((call) => call.args.slice(globals.length))
      const created = localCalls.find((args) => args[0] === "run")!
      expect(created.slice(0, 10)).toEqual([
        "run",
        session.remoteId,
        "--image",
        "img:tag",
        "--restart",
        "Never",
        "--labels",
        expect.stringMatching(/^app=sandbox,tier=test,smithers\.dev\/sandbox-fingerprint=v1-[A-Za-z0-9_-]{43}$/),
        "--override-type",
        "strategic"
      ])
      const overrides = JSON.parse(created[11]!)
      expect(overrides).toEqual({
        apiVersion: "v1",
        spec: {
          serviceAccountName: "runner",
          nodeSelector: { "kubernetes.io/os": "linux" },
          containers: [{
            name: session.remoteId,
            resources: {
              requests: { cpu: "10m", memory: "16Mi" },
              limits: { cpu: "100m", memory: "64Mi" }
            }
          }]
        }
      })
      expect(created.slice(12)).toEqual([
        "--image-pull-policy",
        "IfNotPresent",
        "--dry-run=client",
        "-o",
        "json",
        "--command",
        "--",
        "sleep",
        "infinity"
      ])
      expect(localCalls.find((args) => args[0] === "wait")).toEqual([
        "wait",
        "--for=condition=Ready",
        `pod/${session.remoteId}`,
        "--timeout=300s"
      ])
      const prepared = localCalls.find((args) => args.at(-1)?.startsWith("mkdir -p") === true)!
      expect(prepared.slice(-3, -1)).toEqual(["/bin/sh", "-c"])
      expect(prepared.at(-1)).toBe(
        `mkdir -p '${spaced}' && rm -rf /tmp/.smthrs-sbx && mkdir -p /tmp/.smthrs-sbx`
      )
      expect(localCalls.find((args) => args[0] === "delete")).toEqual([
        "delete",
        `pod/${session.remoteId}`,
        "--force",
        "--grace-period=0"
      ])
    }), 30_000)

  it.effect("reattaches an existing Pod and preserves its files", () =>
    Effect.gen(function*() {
      const fake = cluster()
      const provider = KubernetesSandbox.make({
        spawner: fake.spawner,
        image: "alpine",
        workdir,
        reattachKey: "operator-key"
      })
      const leaked = yield* Scope.make()
      const first = yield* Effect.provideService(provider.acquire("resume"), Scope.Scope, leaked)
      yield* first.writeFile(`${first.workdir}/kept.bin`, new Uint8Array([0, 255, 1]))
      const resumed = yield* Effect.scoped(
        Effect.gen(function*() {
          const second = yield* provider.acquire("resume")
          const bytes = yield* second.readFile(`${second.workdir}/kept.bin`)
          return { remoteId: second.remoteId, bytes }
        })
      )
      expect(resumed.remoteId).toBe(first.remoteId)
      expect(Array.from(resumed.bytes)).toEqual([0, 255, 1])
      expect(fake.calls.filter((call) => call.args[0] === "run")).toHaveLength(2)
      // A live leftover is adopted, so its phase was inspected, not assumed.
      expect(fake.calls.some((call) => call.args[0] === "get" && call.args.at(-1) === "json"))
        .toBe(true)
      expect(yield* Scope.close(leaked, Exit.void)).toBeUndefined()
    }), 30_000)

  it.effect(
    "replaces a squatted Pod that matches every public check instead of adopting it",
    () =>
      Effect.gen(function*() {
        for (const reattachKey of [undefined, "operator-key"]) {
          // The squatter has pods/create and pods/get, not pods/exec. The
          // fingerprint is a hash of public configuration, so it learns the
          // label by computing it (here: from a dry acquire elsewhere), and it
          // copies a real seal off one of the victim's earlier Pods.
          const probe = cluster()
          const options = { image: "img", workdir, ...reattachKey === undefined ? {} : { reattachKey } }
          const earlier = yield* Scope.make()
          const genuine = yield* Effect.provideService(
            KubernetesSandbox.make({ spawner: probe.spawner, ...options }).acquire("victim"),
            Scope.Scope,
            earlier
          )
          const copied = { ...probe.pods.get(genuine.remoteId)!.manifest.metadata.labels }
          yield* Scope.close(earlier, Exit.void)

          const fake = cluster()
          fake.pods.set(genuine.remoteId, {
            phase: "Running",
            env: {},
            manifest: {
              metadata: { uid: "squatter-uid", labels: copied },
              spec: {
                containers: [{ name: genuine.remoteId, image: "img", command: ["/bin/sh", "-c", "steal"] }]
              }
            }
          })
          const squatter = fake.pods.get(genuine.remoteId)
          const provider = KubernetesSandbox.make({ spawner: fake.spawner, ...options })
          yield* acquired(provider, (session) =>
            Effect.gen(function*() {
              expect(session.remoteId).toBe(genuine.remoteId)
              // The Pod the session runs in is a fresh one, not the squatter's.
              const current = fake.pods.get(genuine.remoteId)!
              expect(current).not.toBe(squatter)
              expect(current.manifest.metadata.uid).not.toBe("squatter-uid")
            }), "victim")
          const verbs = fake.calls.map((call) => call.args[0])
          // The squatter was deleted before the replacement was created, and
          // nothing was exec'd while it still held the name.
          const deleted = verbs.indexOf("delete")
          expect(deleted).toBeGreaterThan(-1)
          expect(deleted).toBeLessThan(verbs.lastIndexOf("run"))
          expect(verbs.indexOf("exec")).toBeGreaterThan(deleted)
          expect(fake.pods.size).toBe(0)
        }
      }),
    30_000
  )

  it.effect(
    "replaces a crash-left Pod when no reattach key was given, or the key changed",
    () =>
      Effect.gen(function*() {
        for (const [first, second] of [[undefined, undefined], ["old-key", "new-key"], ["key", undefined]] as const) {
          const fake = cluster()
          const leaked = yield* Scope.make()
          const firstSession = yield* Effect.provideService(
            KubernetesSandbox.make({ spawner: fake.spawner, image: "alpine", workdir, reattachKey: first })
              .acquire("fresh"),
            Scope.Scope,
            leaked
          )
          yield* firstSession.writeFile(`${firstSession.workdir}/gone.txt`, new Uint8Array([1]))
          const leftover = fake.pods.get(firstSession.remoteId)
          yield* acquired(
            KubernetesSandbox.make({ spawner: fake.spawner, image: "alpine", workdir, reattachKey: second }),
            () => Effect.sync(() => expect(fake.pods.get(firstSession.remoteId)).not.toBe(leftover)),
            "fresh"
          )
          expect(fake.calls.filter((call) => call.args[0] === "run")).toHaveLength(3)
          yield* Scope.close(leaked, Exit.void)
        }
      }),
    30_000
  )

  it.effect(
    "replaces a leftover Pod finished in a terminal phase instead of waiting on it",
    () =>
      Effect.gen(function*() {
        const fake = cluster()
        const provider = KubernetesSandbox.make({ spawner: fake.spawner, image: "img", workdir })
        const leaked = yield* Scope.make()
        const first = yield* Effect.provideService(provider.acquire("finished"), Scope.Scope, leaked)
        fake.pods.get(first.remoteId)!.phase = "Succeeded"
        yield* acquired(provider, (session) =>
          Effect.gen(function*() {
            expect(session.remoteId).toBe(first.remoteId)
            // The replacement is a usable machine, not the corpse.
            expect(yield* output(session, "printf 'reborn'")).toEqual({ stdout: "reborn", code: 0 })
          }), "finished")
        const verbs = fake.calls.map((call) => call.args[0])
        expect(verbs.filter((verb) => verb === "run")).toHaveLength(3)
        // The finished Pod was deleted between the refused create and the
        // fresh one, and the release deleted the replacement at the end.
        expect(verbs.indexOf("delete")).toBeLessThan(verbs.lastIndexOf("run"))
        expect(fake.pods.size).toBe(0)
        expect(Exit.isSuccess(yield* Effect.exit(Scope.close(leaked, Exit.void)))).toBe(true)

        // An unreadable Pod is neither adopted nor removed.
        const unreadable = cluster((args) => args[0] === "get" ? { exitCode: 1, stderr: "rbac denied" } : undefined)
        const blindProvider = KubernetesSandbox.make({ spawner: unreadable.spawner, image: "img", workdir })
        const leakedToo = yield* Scope.make()
        const seeded = yield* Effect.provideService(blindProvider.acquire("blind"), Scope.Scope, leakedToo)
        unreadable.pods.get(seeded.remoteId)!.phase = "Succeeded"
        const waitFailure = yield* Effect.flip(acquired(blindProvider, Effect.succeed, "blind"))
        expect((waitFailure as ProviderError).message).toContain("could not be inspected")
        expect(unreadable.pods.size).toBe(1)
        yield* Scope.close(leakedToo, Exit.void)

        // A recreation the server refuses is an acquire failure, with nothing
        // left behind: the corpse is gone and no new Pod exists.
        let runs = 0
        const refusing = cluster((args) =>
          args[0] === "run" && ++runs === 3 ? { exitCode: 1, stderr: "exceeded quota" } : undefined
        )
        const refusingProvider = KubernetesSandbox.make({ spawner: refusing.spawner, image: "img", workdir })
        const leakedThrice = yield* Scope.make()
        const corpse = yield* Effect.provideService(refusingProvider.acquire("quota"), Scope.Scope, leakedThrice)
        refusing.pods.get(corpse.remoteId)!.phase = "Failed"
        const recreateFailure = yield* Effect.flip(acquired(refusingProvider, Effect.succeed, "quota"))
        expect((recreateFailure as ProviderError).message).toContain("could not be recreated")
        expect(refusing.pods.size).toBe(0)
        expect(refusing.calls.filter((call) => call.args[0] === "delete")).toHaveLength(1)
        yield* Scope.close(leakedThrice, Exit.void)
      }),
    30_000
  )

  it.effect("deletes a newly created Pod when Ready or workspace setup fails", () =>
    Effect.gen(function*() {
      const notReady = cluster((args) => args[0] === "wait" ? { exitCode: 1, stderr: "timed out" } : undefined)
      const waitError = yield* Effect.flip(
        acquired(KubernetesSandbox.make({ spawner: notReady.spawner, image: "img", workdir }), Effect.succeed)
      )
      expect((waitError as ProviderError).message).toContain("did not become Ready")
      expect(notReady.calls.some((call) => call.args[0] === "delete")).toBe(true)
      expect(notReady.pods.size).toBe(0)

      const noWorkspace = cluster((args) =>
        args[0] === "exec" && args.at(-1)?.startsWith("mkdir -p") === true
          ? { exitCode: 1, stderr: "read-only filesystem" }
          : undefined
      )
      const setupError = yield* Effect.flip(
        acquired(KubernetesSandbox.make({ spawner: noWorkspace.spawner, image: "img", workdir }), Effect.succeed)
      )
      expect((setupError as ProviderError).message).toContain("could not be prepared")
      expect(noWorkspace.calls.some((call) => call.args[0] === "delete")).toBe(true)
      expect(noWorkspace.pods.size).toBe(0)
    }))

  it.effect("#2702 CI coverage: rejects a fresh Pod with no uid before sealing or exec", () =>
    Effect.gen(function*() {
      for (const uid of ["", " \t\n"]) {
        const fake = cluster((args) =>
          args[0] === "get" && args.at(-1) === "jsonpath={.metadata.uid}"
            ? { stdout: uid }
            : undefined
        )
        const error = yield* Effect.flip(Effect.scoped(
          KubernetesSandbox.make({ spawner: fake.spawner, image: "img", workdir, reattachKey: "operator-key" })
            .acquire("missing-uid")
        ))
        expect(error).toMatchObject({
          code: "unavailable",
          message: expect.stringContaining("reported no uid to seal")
        })
        const name = fake.calls[0]!.args[1]!
        expect(fake.calls.map(({ args }) => args[0])).toEqual(["run", "get", "delete"])
        expect(fake.calls[1]!.args).toEqual(["get", "pod", name, "-o", "jsonpath={.metadata.uid}"])
        expect(fake.calls[2]!.args).toEqual(["delete", `pod/${name}`, "--force", "--grace-period=0"])
        expect(fake.pods.size).toBe(0)
      }
    }))

  it.effect("uses /bin/sh for every provider-owned helper", () =>
    Effect.gen(function*() {
      const fake = cluster()
      const provider = KubernetesSandbox.make({ spawner: fake.spawner, image: "img", workdir })
      yield* acquired(provider, (session) =>
        Effect.gen(function*() {
          yield* session.writeFile(`${workdir}/helper.bin`, new Uint8Array([1]))
          yield* session.readFile(`${workdir}/helper.bin`)
          yield* output(session, "true")
          yield* Effect.scoped(
            Effect.gen(function*() {
              const process = yield* session.spawn(sleeps, {})
              yield* session.kill!(process, "SIGTERM")
              yield* process.exitCode
            })
          )
        }))
      // A Pod-wide PATH can omit `sh`, so every provider-owned shell argv
      // must use the absolute path before that environment can apply.
      const helpers = fake.calls.filter((call) => call.args.includes("-c"))
      expect(helpers.length).toBeGreaterThan(0)
      for (const helper of helpers) {
        const shell = helper.args[helper.args.indexOf("-c") - 1]
        expect(shell).toBe("/bin/sh")
        expect(helper.args).not.toContain("sh")
      }
    }), 30_000)

  it.effect("refuses create failures and restates transport failures", () =>
    Effect.gen(function*() {
      // No workdir given: the default applies, and the refused create keeps
      // the fake from ever preparing /workspace on this host.
      const denied = cluster((args) =>
        args[0] === "run" ? { exitCode: 1, stderr: "Error from server (Forbidden): denied" } : undefined
      )
      const deniedError = yield* Effect.flip(
        acquired(KubernetesSandbox.make({ spawner: denied.spawner, image: "private" }), Effect.succeed)
      )
      expect((deniedError as ProviderError).code).toBe("unavailable")
      expect((deniedError as ProviderError).message).toContain("Forbidden")
      expect(denied.calls.some((call) => call.args[0] === "delete")).toBe(false)

      const missing = cluster((args) => args[0] === "run" ? { failSpawn: true } : undefined)
      const spawnError = yield* Effect.flip(
        acquired(KubernetesSandbox.make({ spawner: missing.spawner, image: "img", workdir }), Effect.succeed)
      )
      expect((spawnError as ProviderError).code).toBe("spawn_error")

      const lossy = cluster((args) => args[0] === "run" ? { failObserve: true } : undefined)
      const observeError = yield* Effect.flip(
        acquired(KubernetesSandbox.make({ spawner: lossy.spawner, image: "img", workdir }), Effect.succeed)
      )
      expect((observeError as ProviderError).code).toBe("unknown")
    }))

  it.effect(
    "spawns with a rooted cwd, env(1) deletion, and stdin through the exec channel",
    () =>
      Effect.gen(function*() {
        const fake = cluster()
        const provider = KubernetesSandbox.make({
          spawner: fake.spawner,
          image: "img",
          workdir,
          env: { DROP: "base" }
        })
        yield* acquired(provider, (session) =>
          Effect.gen(function*() {
            // A bare spawn runs in the workdir; kubectl exec itself starts
            // elsewhere, so this proves the script's `cd`.
            expect((yield* output(session, "pwd")).stdout).toBe(`${workdir}\n`)
            yield* output(session, "mkdir -p sub/nested")
            expect((yield* output(session, "pwd", { cwd: "./sub/nested/" })).stdout).toBe(`${workdir}/sub/nested\n`)
            expect((yield* output(session, "pwd", { cwd: root })).stdout).toBe(`${root}\n`)
            // `env(1)` carries a value with spaces as one entry and sets
            // nothing for an explicitly undefined name.
            const delivered = yield* output(
              session,
              `printf '%s:%s:%s' "$KEEP" "$PRESENT" "\${DROP-unset}"`,
              {
                env: { "KEEP": "two words", "PRESENT": "delivered", "DROP": undefined }
              }
            )
            expect(delivered).toEqual({ stdout: "two words:delivered:unset", code: 0 })
            // A name the guest `sh -c` would drop is refused before anything
            // is sent, so every platform gives the caller the same answer.
            // `env(1)` would carry `WITH-DASH` to the shell, and dash, which
            // is `/bin/sh` on Debian and Ubuntu, would then discard it.
            const refused = yield* Effect.flip(
              Effect.scoped(session.spawn(`printenv WITH-DASH`, { env: { "WITH-DASH": "delivered" } }))
            )
            expect((refused as ProviderError).code).toBe("spawn_error")
            expect((refused as ProviderError).message).toContain("WITH-DASH")
            // Standard input arrives on the exec's own input channel, verified
            // through the file the command writes.
            const bytes = new Uint8Array([0, 1, 2, 255, 254, 10, 13, 0, 7])
            expect((yield* output(session, "cat > stdin-copy.bin", { stdin: bytes })).code).toBe(0)
            expect(Array.from(yield* session.readFile(`${workdir}/stdin-copy.bin`))).toEqual(Array.from(bytes))
          }))
        const spawns = fake.calls.filter((call) => call.args.at(-1)?.includes("exec ") === true)
        expect(spawns[0]!.args).toEqual([
          "exec",
          spawns[0]!.args[1]!,
          "--",
          "/bin/sh",
          "-c",
          `cd ${workdir} && echo $$ > /tmp/.smthrs-sbx/0.pid`
          + " && if [ -e /tmp/.smthrs-sbx/0.pid.cancel ]; then exit 143; fi"
          + " && exec /bin/sh -c pwd"
        ])
        const withEnv = spawns.find((call) => call.args.at(-1)?.includes("env ") === true)!
        // Every `-u` before every assignment: `env` stops reading options at
        // the first operand, so `env KEEP=1 -u DROP prog` would run `-u`.
        expect(withEnv.args.at(-1)).toContain("exec env \"$@\" /bin/sh -c")
        expect(Buffer.from(withEnv.input.trim(), "base64").toString()).toBe(
          "-u DROP 'KEEP=two words' PRESENT=delivered"
        )
        expect(withEnv.args.at(-1)).not.toContain("export")
        // The refused spawn never reached the cluster at all.
        expect(fake.calls.some((call) => call.args.at(-1)?.includes("WITH-DASH") === true)).toBe(false)
        const fed = spawns.find((call) => call.args.at(-1)?.includes("cat > stdin-copy.bin") === true)!
        expect(fed.args.slice(0, 2)).toEqual(["exec", "--stdin"])
        // Only a command with input asks for the input channel.
        expect(spawns.filter((call) => call.args.includes("--stdin"))).toHaveLength(2)
      }),
    30_000
  )

  it.effect(
    "signals the guest when a spawn scope closes on a live command, and not on an ended one",
    () =>
      Effect.gen(function*() {
        const fake = cluster()
        const provider = KubernetesSandbox.make({ spawner: fake.spawner, image: "img", workdir })
        yield* acquired(provider, (session) =>
          Effect.gen(function*() {
            const kills = () => fake.calls.filter((call) => call.args.at(-1)?.includes("kids()") === true).length
            yield* Effect.scoped(Effect.asVoid(session.spawn(sleeps, {})))
            expect(kills()).toBe(1)
            expect((yield* output(session, survivor)).code).not.toBe(0)
            yield* output(session, "true")
            expect(kills()).toBe(1)
          }))
      }),
    30_000
  )

  it.effect("kills a spawned command by pid walk inside the pod", () =>
    Effect.gen(function*() {
      const fake = cluster()
      const provider = KubernetesSandbox.make({ spawner: fake.spawner, image: "img", workdir })
      yield* acquired(provider, (session) =>
        Effect.gen(function*() {
          const signalled = yield* Effect.scoped(
            Effect.gen(function*() {
              const process = yield* session.spawn(sleeps, {})
              yield* session.kill!(process, "SIGTERM")
              return yield* process.exitCode
            })
          )
          expect(signalled).toBe(143)
          expect((yield* output(session, survivor)).code).not.toBe(0)
        }))
      const kill = fake.calls.find((call) => call.args.at(-1)?.includes("kids()") === true)
      expect(kill!.args.at(-1)).toContain("while [ ! -s /tmp/.smthrs-sbx/0.pid ]")
      // One batch delivery to the collected set: killing children one at a
      // time before the parent lets a respawning parent replace them.
      expect(kill!.args.at(-1)).toContain(`kill -s TERM "$@"`)

      const refused = cluster((args) =>
        args.at(-1)?.includes("kids()") === true ? { exitCode: 1, stderr: "exec refused" } : undefined
      )
      const killError = yield* Effect.flip(
        acquired(KubernetesSandbox.make({ spawner: refused.spawner, image: "img", workdir }), (session) =>
          Effect.scoped(
            Effect.flatMap(session.spawn("sleep 30", {}), (process) => session.kill!(process, "SIGKILL"))
          ))
      )
      expect((killError as ProviderError).code).toBe("unknown")
      expect((killError as ProviderError).message).toContain("SIGKILL")
    }), 30_000)

  it.effect("round-trips bytes through base64 and classifies read and write failures", () =>
    Effect.gen(function*() {
      const fake = cluster()
      const provider = KubernetesSandbox.make({ spawner: fake.spawner, image: "img", workdir })
      yield* acquired(provider, (session) =>
        Effect.gen(function*() {
          const binary = new Uint8Array([0, 255, 254, 10, 13, 7])
          yield* session.writeFile(`${workdir}/deep/out.bin`, binary)
          expect(Array.from(yield* session.readFile(`${workdir}/deep/out.bin`))).toEqual(Array.from(binary))
          yield* session.writeFile(`${workdir}/void.bin`, new Uint8Array())
          expect(yield* session.readFile(`${workdir}/void.bin`)).toEqual(new Uint8Array())
          // A path with no parent to create takes the bare write.
          yield* session.writeFile("bare.bin", new Uint8Array([9]))
          expect(Array.from(yield* session.readFile(`${root}/bare.bin`))).toEqual([9])
          const absent = yield* Effect.flip(session.readFile(`${workdir}/absent`))
          expect((absent as ProviderError).code).toBe("not_found")
          writeFileSync(`${workdir}/sealed.bin`, "sealed")
          chmodSync(`${workdir}/sealed.bin`, 0)
          const refused = yield* Effect.flip(session.readFile(`${workdir}/sealed.bin`))
          expect((refused as ProviderError).code).toBe("unknown")
          expect((refused as ProviderError).message).toContain("Permission denied")
          writeFileSync(`${workdir}/blocker`, "a file, not a directory")
          const unwritable = yield* Effect.flip(session.writeFile(`${workdir}/blocker/child`, new Uint8Array([1])))
          expect((unwritable as ProviderError).code).toBe("unknown")
        }))
      const writes = fake.calls.filter((call) => call.args.includes("-i"))
      expect(writes[0]!.args.slice(0, 2)).toEqual(["exec", "-i"])
      expect(writes[0]!.args.at(-1)).toBe(`mkdir -p ${workdir}/deep && base64 -d > ${workdir}/deep/out.bin`)
      // Redirected, not positional: BSD `base64` takes no file operand.
      const reads = fake.calls.filter((call) => call.args.at(-1)?.includes("base64 < ") === true)
      expect(reads.length).toBeGreaterThan(0)

      const badRead = cluster((args) =>
        args.at(-1)?.includes(`base64 < ${workdir}/bad`) === true ? { stdout: "%%%" } : undefined
      )
      const badBase64 = yield* Effect.flip(
        acquired(KubernetesSandbox.make({ spawner: badRead.spawner, image: "img", workdir }), (session) =>
          session.readFile(`${workdir}/bad`))
      )
      expect((badBase64 as ProviderError).message).toContain("invalid base64")

      const refusedWrite = cluster((args) =>
        args.includes("-i") ? { exitCode: 1, stderr: "read-only filesystem" } : undefined
      )
      const writeError = yield* Effect.flip(
        acquired(KubernetesSandbox.make({ spawner: refusedWrite.spawner, image: "img", workdir }), (session) =>
          session.writeFile(`${workdir}/out`, new Uint8Array([1])))
      )
      expect((writeError as ProviderError).code).toBe("unknown")

      const missingExec = cluster((args) =>
        args.includes("-i") ? { failSpawn: true } : undefined
      )
      const writeSpawnError = yield* Effect.flip(
        acquired(KubernetesSandbox.make({ spawner: missingExec.spawner, image: "img", workdir }), (session) =>
          session.writeFile(`${workdir}/out`, new Uint8Array([1])))
      )
      expect((writeSpawnError as ProviderError).code).toBe("spawn_error")
    }), 30_000)

  it.effect("answers ping and spawn failures honestly", () =>
    Effect.gen(function*() {
      const dead = cluster((args) => args.at(-1) === "true" ? { exitCode: 1, stderr: "pod gone" } : undefined)
      const pingError = yield* Effect.flip(
        acquired(KubernetesSandbox.make({ spawner: dead.spawner, image: "img", workdir }), (session) => session.ping!)
      )
      expect((pingError as ProviderError).code).toBe("unavailable")

      const noExec = cluster((args) =>
        args.at(-1)?.includes("exec /bin/sh -c") === true ? { failSpawn: true } : undefined
      )
      const spawnError = yield* Effect.flip(
        acquired(KubernetesSandbox.make({ spawner: noExec.spawner, image: "img", workdir }), (session) =>
          Effect.scoped(Effect.asVoid(session.spawn("true", {}))))
      )
      expect((spawnError as ProviderError).code).toBe("spawn_error")
    }))

  it.effect("merges neutral limits into container limits and the Pod deadline", () =>
    Effect.gen(function*() {
      const labelOf = (args: ReadonlyArray<string>) => args.find((arg) => arg.includes("sandbox-fingerprint"))
      const overridesOf = (args: ReadonlyArray<string>) => JSON.parse(args[args.indexOf("--overrides") + 1]!)
      const limited = cluster()
      yield* Effect.scoped(
        KubernetesSandbox.make({
          spawner: limited.spawner,
          image: "img",
          workdir,
          resources: { requests: { cpu: "250m" } },
          limits: { cpus: 1.5, memoryMib: 512, timeoutSecs: 3600 }
        }).acquire("limits")
      )
      const overrides = overridesOf(limited.calls[0]!.args)
      expect(overrides.spec.activeDeadlineSeconds).toBe(3600)
      expect(overrides.spec.containers[0].resources).toEqual({
        requests: { cpu: "250m" },
        limits: { cpu: "1.5", memory: "512Mi" }
      })
      const lifetimeOnly = cluster()
      yield* Effect.scoped(
        KubernetesSandbox.make({ spawner: lifetimeOnly.spawner, image: "img", workdir, limits: { timeoutSecs: 60 } })
          .acquire("limits")
      )
      expect(overridesOf(lifetimeOnly.calls[0]!.args).spec).toEqual({ activeDeadlineSeconds: 60 })
      const cpuOnly = cluster()
      yield* Effect.scoped(
        KubernetesSandbox.make({ spawner: cpuOnly.spawner, image: "img", workdir, limits: { cpus: 2 } })
          .acquire("limits")
      )
      expect(overridesOf(cpuOnly.calls[0]!.args).spec.containers[0].resources).toEqual({ limits: { cpu: "2" } })
      const memoryOnly = cluster()
      yield* Effect.scoped(
        KubernetesSandbox.make({ spawner: memoryOnly.spawner, image: "img", workdir, limits: { memoryMib: 256 } })
          .acquire("limits")
      )
      expect(overridesOf(memoryOnly.calls[0]!.args).spec.containers[0].resources).toEqual({
        limits: { memory: "256Mi" }
      })
      const unlimited = cluster()
      yield* Effect.scoped(
        KubernetesSandbox.make({ spawner: unlimited.spawner, image: "img", workdir }).acquire("limits")
      )
      expect(unlimited.calls[0]!.args).not.toContain("--overrides")
      expect(labelOf(lifetimeOnly.calls[0]!.args)).not.toBe(labelOf(unlimited.calls[0]!.args))
    }))

  it("refuses a neutral limit that collides with the Kubernetes-named one", () => {
    const deps = untouchable<never>()
    expect(() =>
      KubernetesSandbox.make({
        spawner: deps.value,
        image: "img",
        resources: { limits: { cpu: "1" } },
        limits: { cpus: 2 }
      })
    ).toThrow("resources.limits.cpu and limits.cpus are exclusive")
    expect(() =>
      KubernetesSandbox.make({
        spawner: deps.value,
        image: "img",
        resources: { limits: { memory: "1Gi" } },
        limits: { memoryMib: 512 }
      })
    ).toThrow("resources.limits.memory and limits.memoryMib are exclusive")
    expect(deps.touched).toEqual([])
  })

  it("refuses a caller override that would replace the one carrying neutral limits", () => {
    const deps = untouchable<never>()
    const make = (options: Partial<KubernetesSandbox.KubernetesSandboxOptions>) => () =>
      KubernetesSandbox.make({ spawner: deps.value, image: "img", ...options })
    const later = ["--overrides", JSON.stringify({ apiVersion: "v1", spec: {} })]
    for (const limits of [{ cpus: 1 }, { memoryMib: 256 }, { timeoutSecs: 60 }]) {
      expect(make({ limits, createArgs: later })).toThrow(
        "kubernetes-sandbox: createArgs --overrides would replace the Pod override"
      )
    }
    expect(make({ limits: { cpus: 1 }, createArgs: [`--overrides=${JSON.stringify({ spec: {} })}`] }))
      .toThrow("createArgs --overrides would replace")
    expect(make({ limits: { timeoutSecs: 60 }, createArgs: ["--override-type", "json"] }))
      .toThrow("createArgs --override-type would replace")
    expect(make({ nodeSelector: { pool: "a" }, createArgs: later })).toThrow("createArgs --overrides would replace")
    // With nothing of its own to override, a caller's override is theirs.
    expect(make({ createArgs: later })).not.toThrow()
    expect(make({ limits: {}, createArgs: later })).not.toThrow()
    expect(deps.touched).toEqual([])
  })

  it.effect("handles empty resources and bounds sanitized Pod names", () =>
    Effect.gen(function*() {
      const fake = cluster()
      const provider = KubernetesSandbox.make({
        spawner: fake.spawner,
        image: "img",
        workdir,
        resources: {},
        namePrefix: "INVALID_PREFIX_THAT_IS_MUCH_TOO_LONG_TO_FIT_WITH_THE_COMPLETE_SESSION_SLUG_"
      })
      const key = "UPPER_case.with/a/very/long/session/key"
      const session = yield* Effect.scoped(provider.acquire(key))
      const otherKey = `${key}/other`
      const other = yield* Effect.scoped(provider.acquire(otherKey))
      expect(other.remoteId).not.toBe(session.remoteId)
      for (const [id, sessionKey] of [[session.remoteId, key], [other.remoteId, otherKey]] as const) {
        const digest = sessionSlug(sessionKey).slice(-16).toLowerCase()
        expect(digest).toMatch(/^[a-f0-9]{16}$/)
        expect(id.endsWith(`-${digest}`)).toBe(true)
      }
      expect(session.remoteId).toMatch(/^[a-z0-9-]+$/)
      expect(session.remoteId).toHaveLength(63)
      const create = fake.calls[0]!.args
      const overrides = JSON.parse(create[create.indexOf("--overrides") + 1]!)
      expect(overrides.spec.containers[0].resources).toEqual({})
    }))

  it.effect("passes SandboxConformance against the faithful kubectl fake", () =>
    Effect.gen(function*() {
      const fake = cluster()
      const provider = KubernetesSandbox.make({ spawner: fake.spawner, image: "alpine:3.20", workdir })
      const violations = yield* SandboxConformance.check(provider, {
        provides: { kill: true, ping: true }
      })
      expect(violations).toEqual([])
    }), 120_000)
})
