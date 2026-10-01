/**
 * `SandboxedFlow` against real machines: a Docker container and a Microsandbox
 * microVM. The same child flow the unit suite runs in a scratch directory runs
 * here inside a guest whose `/etc/os-release` is the image's, and its output
 * comes back only through the session. Neither image carries `git`, so work
 * capture is the unit suite's to prove.
 *
 * Both suites skip, visibly, where the backend is absent: a machine without a
 * container engine, or one that cannot boot a microVM, names the skip rather
 * than letting a fake stand in for the boundary.
 */
import { NodeChildProcessSpawner, NodeFileSystem } from "@effect/platform-node"
import * as NodePath from "@effect/platform-node/NodePath"
import { describe, expect, it } from "@effect/vitest"
import { ContainerSandbox, MicrosandboxSandbox } from "@smthrs/sandbox"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import * as Microsandbox from "microsandbox"
import { spawnSync } from "node:child_process"
import { accessSync, constants } from "node:fs"
import { afterAll } from "vitest"
import * as SandboxedFlow from "../src/SandboxedFlow.ts"
import { docker } from "./DockerProbe.ts"
import { Inspector, Sum } from "./fixtures/sandboxed-child.ts"

const entry = new URL("./fixtures/sandboxed-child.ts", import.meta.url)

const platform = Layer.provideMerge(
  NodeChildProcessSpawner.layer,
  Layer.merge(NodeFileSystem.layer, NodePath.layer)
)

const spawner = Effect.gen(function*() {
  return yield* ChildProcessSpawner
}).pipe(Effect.provide(platform))

// Session keys are suite-unique so a concurrently running vitest worker
// cannot collide on container names. A normal completion removes the
// container; the force-removal below covers a run that died mid-acquire.
const engineAvailable = docker(["info"]).status === 0
const containerKeys = {
  node: `flows-sandboxed-it-${process.pid}-node`,
  bare: `flows-sandboxed-it-${process.pid}-bare`
}
afterAll(() => {
  if (!engineAvailable) return
  const names = docker(["ps", "--all", "--format", "{{.Names}}"]).stdout ?? ""
  for (const name of names.split("\n")) {
    if (name.includes(`flows-sandboxed-it-${process.pid}-`)) {
      docker(["rm", "--force", name])
    }
  }
})

// Acquisition and transport share the existing integration deadline. Even
// `docker create` can stall on a loaded daemon; that remains a test failure,
// and the bounded prerequisite/cleanup probes keep its diagnosis observable.
const containerBudget = 240_000

describe.skipIf(!engineAvailable)("SandboxedFlow inside a real container", () => {
  it.live(
    "runs the child flow's code in the guest image and reads back its result",
    () =>
      Effect.gen(function*() {
        const provider = ContainerSandbox.make({ spawner: yield* spawner, image: "node:22-alpine" })
        const started = Date.now()
        const result = yield* SandboxedFlow.execute(Inspector, { marker: "written in the container" }, {
          provider,
          session: containerKeys.node,
          entry,
          timeout: containerBudget
        })
        // Whatever this host runs, the guest's os-release is Alpine's and its
        // node is the image's 22.
        expect(result.output.osRelease).toContain("Alpine Linux")
        expect(result.output.runtime).toMatch(/^node v22\./)
        expect(result.output.cwd).toBe("/workspace")
        expect(result.output.seed).toBe("(absent)")
        expect(result.work).toBeNull()
        expect(Date.now() - started).toBeLessThan(containerBudget)
      }),
    containerBudget
  )

  it.live(
    "names the runtime an image without one cannot start",
    () =>
      Effect.gen(function*() {
        const provider = ContainerSandbox.make({ spawner: yield* spawner, image: "alpine:3.20" })
        const failure = yield* Effect.flip(
          SandboxedFlow.execute(Sum, { n: 1 }, {
            provider,
            session: containerKeys.bare,
            entry,
            timeout: containerBudget
          })
        )
        expect(failure.code, failure.message).toBe("guest_failed")
        expect(failure.message).toContain("no runnable `node`")
      }),
    containerBudget
  )
})

const microvmSession = `flows-sandboxed-microvm-${process.pid}-${Date.now()}`
const microvmBudget = 900_000
const microvmProbeBudget = 300_000

/**
 * Why this host cannot boot a microVM, or `undefined` when it can. The gate is
 * the one `@smthrs/sandbox`'s `RealMicrosandbox.integration.test.ts` states, and
 * for the same reason: a runnable platform binary is not the capability, so
 * each platform is asked for its hypervisor: `/dev/kvm` on Linux,
 * Hypervisor.framework on macOS, where `kern.hv_vmm_present` also says whether
 * this machine is itself a guest whose Virtualization Framework host gives it no
 * nested virtualization. A host that answers yes to all of them boots one
 * microVM to prove it. libkrun's `VmSetup(VmCreate)` is the hypervisor refusing
 * to create a VM; that exact refusal names the missing capability and skips,
 * while any other failure leaves the suite to run and report it.
 */
const microvmUnbootable = async (): Promise<string | undefined> => {
  if (spawnSync("microsandbox", ["--version"], { stdio: "ignore" }).status !== 0) {
    return "the microsandbox platform binary does not run here"
  }
  if (process.platform === "linux") {
    try {
      accessSync("/dev/kvm", constants.R_OK | constants.W_OK)
    } catch {
      return "this Linux host exposes no /dev/kvm this process may read and write"
    }
  } else if (process.platform === "darwin") {
    const sysctl = (name: string): string | undefined => {
      const read = spawnSync("sysctl", ["-n", name], { encoding: "utf8" })
      return read.status === 0 ? read.stdout.trim() : undefined
    }
    if (sysctl("kern.hv_support") !== "1") {
      return "this macOS host reports no Hypervisor.framework support (kern.hv_support)"
    }
    if (sysctl("kern.hv_vmm_present") === "1") {
      return "this macOS host is itself a guest (kern.hv_vmm_present), and Apple's Virtualization Framework"
        + " gives its guests no nested virtualization"
    }
  } else {
    return `microsandbox reaches no hypervisor on ${process.platform}`
  }
  const refusal = await Effect.runPromise(
    Effect.scoped(
      Effect.flatMap(
        MicrosandboxSandbox.make({
          sdk: Microsandbox,
          image: "oven/bun:1",
          pullPolicy: "if-missing",
          maxDurationSecs: 120,
          idleTimeoutSecs: 60
        }).acquire(`${microvmSession}-probe`),
        () => Effect.void
      )
    ).pipe(
      Effect.timeoutOption(microvmProbeBudget),
      Effect.as(undefined),
      Effect.catchCause((cause) => Effect.succeed(Cause.pretty(cause)))
    )
  )
  return refusal !== undefined && refusal.includes("VmSetup(VmCreate)")
    ? "this host's hypervisor refused to create a VM (VmSetup(VmCreate)): it provides no nested virtualization"
    : undefined
}

const microvmMissing = await microvmUnbootable()
const microvmAvailable = microvmMissing === undefined

describe.skipIf(microvmAvailable)("SandboxedFlow inside a real microVM", () => {
  it(`is skipped because ${microvmMissing ?? "this machine can boot a microVM"}`, () => {
    expect(microvmMissing).toEqual(expect.any(String))
  })
})

describe.skipIf(!microvmAvailable)("SandboxedFlow inside a real microVM", () => {
  it.live(
    "runs the child flow's code under bun in the guest and reads back its result",
    () =>
      Effect.gen(function*() {
        const provider = MicrosandboxSandbox.make({
          sdk: Microsandbox,
          image: "oven/bun:1",
          pullPolicy: "if-missing",
          maxDurationSecs: 900,
          idleTimeoutSecs: 120
        })
        const result = yield* SandboxedFlow.execute(Inspector, { marker: "written in the microVM" }, {
          provider,
          session: microvmSession,
          entry,
          runtime: "bun",
          timeout: microvmBudget
        })
        expect(result.output.runtime).toBe("bun")
        expect(result.output.osRelease).toContain("ID=")
        expect(result.output.seed).toBe("(absent)")
      }),
    microvmBudget
  )
})
