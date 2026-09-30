import { NodeChildProcessSpawner, NodeFileSystem } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Path, Stream } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { spawnSync } from "node:child_process"
import { afterAll, beforeAll } from "vitest"
import * as KubernetesSandbox from "../src/KubernetesSandbox/index.ts"
import * as SandboxConformance from "../src/SandboxConformance/index.ts"
import { discover } from "./helpers/discover.ts"

const context = "orbstack"
const namespace = `smthrs-sandbox-it-${process.pid}`
const clusterAvailable = discover("kubectl", ["--context", context, "cluster-info"]).status === 0
const missingCluster = clusterAvailable
  ? undefined
  : `no Kubernetes cluster answers \`kubectl --context ${context} cluster-info\``

const kubectl = (args: ReadonlyArray<string>) =>
  spawnSync("kubectl", ["--context", context, ...args], { encoding: "utf8", timeout: 300_000 })

const platform = Layer.provideMerge(
  NodeChildProcessSpawner.layer,
  Layer.merge(NodeFileSystem.layer, Path.layer)
)

const provider = Effect.gen(function*() {
  const spawner = yield* ChildProcessSpawner
  return KubernetesSandbox.make({
    spawner,
    image: "alpine:3.20",
    context,
    namespace
  })
}).pipe(Effect.provide(platform))

// The skip has to be visible, and it has to name what is missing: a case that
// silently disappears is indistinguishable from one that never existed, and one
// that disappears without a reason is indistinguishable from a suite quietly
// switched off.
describe.skipIf(clusterAvailable)("KubernetesSandbox against OrbStack", () => {
  it(`is skipped because ${missingCluster ?? `the \`${context}\` cluster is reachable`}`, () => {
    expect(missingCluster).toEqual(expect.any(String))
  })
})

describe.skipIf(!clusterAvailable)("KubernetesSandbox against OrbStack", () => {
  beforeAll(() => {
    const created = kubectl(["create", "namespace", namespace])
    if (created.status !== 0) throw new Error(created.stderr || created.stdout)
  }, 300_000)

  afterAll(() => {
    kubectl(["delete", "namespace", namespace, "--force", "--grace-period=0", "--wait=false"])
  }, 300_000)

  it.effect("honors Pod shaping and transports processes and bytes on the real cluster", () =>
    Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner
      const shaped = KubernetesSandbox.make({
        spawner,
        image: "alpine:3.20",
        context,
        namespace,
        env: { POD_SEED: "created" },
        labels: { app: "smthrs-sandbox", test: "integration" },
        resources: {
          requests: { cpu: "5m", memory: "8Mi" },
          limits: { cpu: "100m", memory: "64Mi" }
        },
        serviceAccount: "default",
        nodeSelector: { "kubernetes.io/os": "linux" },
        createArgs: ["--image-pull-policy", "IfNotPresent"]
      })
      yield* Effect.scoped(
        Effect.gen(function*() {
          const session = yield* shaped.acquire(`real-machine-${process.pid}`)
          const bytes = new Uint8Array([0, 1, 2, 253, 254, 255, 10, 13, 0])
          yield* session.writeFile(`${session.workdir}/in.bin`, bytes)
          expect(Array.from(yield* session.readFile(`${session.workdir}/in.bin`))).toEqual(Array.from(bytes))
          const remote = yield* session.spawn(`printf '%s:%s' "$POD_SEED" "$CALL_ENV"`, {
            env: { CALL_ENV: "spawned" }
          })
          const answer = yield* Stream.mkString(Stream.decodeText(remote.stdout))
          expect(yield* remote.exitCode).toBe(0)
          expect(answer).toBe("created:spawned")
          yield* session.ping!
        })
      )
    }).pipe(Effect.provide(platform)), 600_000)

  it.effect("passes SandboxConformance on real Pods, including kill and ping", () =>
    Effect.gen(function*() {
      const live = yield* provider
      const violations = yield* SandboxConformance.check(live, {
        session: `real-conformance-${process.pid}`,
        provides: { kill: true, ping: true }
      })
      expect(violations).toEqual([])
    }), 1_200_000)
})
