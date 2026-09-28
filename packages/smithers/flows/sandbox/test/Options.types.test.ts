/**
 * Pins every exported constructor-options name to the argument it describes.
 *
 * A consumer writing `const options: ... = {...}` or a factory forwarding
 * options to one of these constructors has to be able to name the argument.
 * An exported name that stops matching the parameter is worse than no export
 * at all.
 */
import { expect, it } from "@effect/vitest"
import { expectTypeOf } from "vitest"
import * as AwsSandbox from "../src/AwsSandbox/index.ts"
import * as CloudflareSandbox from "../src/CloudflareSandbox/index.ts"
import * as ContainerSandbox from "../src/ContainerSandbox/index.ts"
import * as DaytonaSandbox from "../src/DaytonaSandbox/index.ts"
import * as DirectorySandbox from "../src/DirectorySandbox/index.ts"
import * as JustBashSandbox from "../src/JustBashSandbox/index.ts"
import * as KubernetesSandbox from "../src/KubernetesSandbox/index.ts"
import * as MicrosandboxSandbox from "../src/MicrosandboxSandbox/index.ts"
import * as RemoteChildProcessSpawner from "../src/RemoteChildProcessSpawner/index.ts"
import * as Sandbox from "../src/Sandbox/index.ts"
import * as VercelSandbox from "../src/VercelSandbox/index.ts"

interface Binding {
  readonly namespace: "sandbox"
}

expectTypeOf<Parameters<typeof AwsSandbox.make>[0]>().toEqualTypeOf<AwsSandbox.AwsSandboxOptions>()
expectTypeOf<AwsSandbox.AwsSandboxTaskDefinitionOptions>().toExtend<AwsSandbox.AwsSandboxOptions>()
expectTypeOf<AwsSandbox.AwsSandboxImageOptions>().toExtend<AwsSandbox.AwsSandboxOptions>()
expectTypeOf<AwsSandbox.AwsSandboxTaskDefinitionOptions>().toExtend<AwsSandbox.AwsSandboxCommonOptions>()
expectTypeOf<AwsSandbox.AwsSandboxImageOptions>().toExtend<AwsSandbox.AwsSandboxCommonOptions>()
expectTypeOf<Parameters<typeof CloudflareSandbox.make<Binding>>[0]>()
  .toEqualTypeOf<CloudflareSandbox.CloudflareSandboxOptions<Binding>>()
expectTypeOf<Parameters<typeof ContainerSandbox.make>[0]>()
  .toEqualTypeOf<ContainerSandbox.ContainerSandboxOptions>()
expectTypeOf<Parameters<typeof DaytonaSandbox.make>[0]>()
  .toEqualTypeOf<DaytonaSandbox.DaytonaSandboxOptions>()
expectTypeOf<Parameters<typeof DirectorySandbox.make>[0]>()
  .toEqualTypeOf<DirectorySandbox.DirectorySandboxOptions>()
expectTypeOf<Parameters<typeof JustBashSandbox.make>[0]>()
  .toEqualTypeOf<JustBashSandbox.JustBashSandboxOptions>()
expectTypeOf<Parameters<typeof KubernetesSandbox.make>[0]>()
  .toEqualTypeOf<KubernetesSandbox.KubernetesSandboxOptions>()
expectTypeOf<Parameters<typeof MicrosandboxSandbox.make>[0]>()
  .toEqualTypeOf<MicrosandboxSandbox.MicrosandboxSandboxOptions>()
expectTypeOf<Parameters<typeof VercelSandbox.make>[0]>()
  .toEqualTypeOf<VercelSandbox.VercelSandboxOptions>()
// Every provider takes the neutral network option; Container also keeps its
// raw engine network mode.
expectTypeOf<AwsSandbox.AwsSandboxCommonOptions["network"]>().toEqualTypeOf<Sandbox.NetworkPolicy | undefined>()
expectTypeOf<CloudflareSandbox.CloudflareSandboxOptions<Binding>["network"]>()
  .toEqualTypeOf<Sandbox.NetworkPolicy | undefined>()
expectTypeOf<ContainerSandbox.ContainerSandboxOptions["network"]>()
  .toEqualTypeOf<Sandbox.NetworkPolicy | string | undefined>()
expectTypeOf<DaytonaSandbox.DaytonaSandboxOptions["network"]>().toEqualTypeOf<Sandbox.NetworkPolicy | undefined>()
expectTypeOf<DirectorySandbox.DirectorySandboxOptions["network"]>().toEqualTypeOf<Sandbox.NetworkPolicy | undefined>()
expectTypeOf<JustBashSandbox.JustBashSandboxOptions["network"]>().toEqualTypeOf<Sandbox.NetworkPolicy | undefined>()
expectTypeOf<KubernetesSandbox.KubernetesSandboxOptions["network"]>()
  .toEqualTypeOf<Sandbox.NetworkPolicy | undefined>()
expectTypeOf<MicrosandboxSandbox.MicrosandboxSandboxOptions["network"]>()
  .toEqualTypeOf<Sandbox.NetworkPolicy | undefined>()
expectTypeOf<VercelSandbox.VercelSandboxOptions["network"]>().toEqualTypeOf<Sandbox.NetworkPolicy | undefined>()
// Every provider takes the neutral resource limits, and forwards or refuses each.
type Limits = Sandbox.ResourceLimits | undefined
expectTypeOf<AwsSandbox.AwsSandboxCommonOptions["limits"]>().toEqualTypeOf<Limits>()
expectTypeOf<CloudflareSandbox.CloudflareSandboxOptions<Binding>["limits"]>().toEqualTypeOf<Limits>()
expectTypeOf<ContainerSandbox.ContainerSandboxOptions["limits"]>().toEqualTypeOf<Limits>()
expectTypeOf<DaytonaSandbox.DaytonaSandboxOptions["limits"]>().toEqualTypeOf<Limits>()
expectTypeOf<DirectorySandbox.DirectorySandboxOptions["limits"]>().toEqualTypeOf<Limits>()
expectTypeOf<JustBashSandbox.JustBashSandboxOptions["limits"]>().toEqualTypeOf<Limits>()
expectTypeOf<KubernetesSandbox.KubernetesSandboxOptions["limits"]>().toEqualTypeOf<Limits>()
expectTypeOf<MicrosandboxSandbox.MicrosandboxSandboxOptions["limits"]>().toEqualTypeOf<Limits>()
expectTypeOf<VercelSandbox.VercelSandboxOptions["limits"]>().toEqualTypeOf<Limits>()
expectTypeOf<Sandbox.ResourceLimits>().toEqualTypeOf<{
  readonly cpus?: number | undefined
  readonly memoryMib?: number | undefined
  readonly timeoutSecs?: number | undefined
}>()
// The two doubles default their argument, so the parameter itself is the
// options type or nothing. `NonNullable` names the half a consumer writes.
expectTypeOf<NonNullable<Parameters<typeof Sandbox.TestSession.make>[0]>>()
  .toEqualTypeOf<Sandbox.TestSessionOptions>()
expectTypeOf<NonNullable<Parameters<typeof RemoteChildProcessSpawner.TestRemote.make>[0]>>()
  .toEqualTypeOf<RemoteChildProcessSpawner.TestRemoteOptions>()

it("exports every options-bearing constructor through its namespace", () => {
  expect(typeof AwsSandbox.make).toBe("function")
  expect(typeof CloudflareSandbox.make).toBe("function")
  expect(typeof ContainerSandbox.make).toBe("function")
  expect(typeof DaytonaSandbox.make).toBe("function")
  expect(typeof DirectorySandbox.make).toBe("function")
  expect(typeof JustBashSandbox.make).toBe("function")
  expect(typeof KubernetesSandbox.make).toBe("function")
  expect(typeof MicrosandboxSandbox.make).toBe("function")
  expect(typeof VercelSandbox.make).toBe("function")
  expect(typeof Sandbox.TestSession.make).toBe("function")
  expect(typeof RemoteChildProcessSpawner.TestRemote.make).toBe("function")
})
