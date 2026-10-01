/**
 * Boot timing: N microVMs created from the issue-sweep snapshot at once,
 * straight through the SDK; prints each machine's create start and end
 * (seconds after launch) to show whether boots overlap or serialize.
 *   node flows/issue-sweep/test/vm-boot.ts <N>
 */
import type { MicrosandboxSandbox } from "@smthrs/sandbox"
import { Effect } from "effect"
import * as Microsandbox from "microsandbox"
import { latestImage } from "../vm.ts"

const sdk = Microsandbox as unknown as MicrosandboxSandbox.Sdk
const n = Number(process.argv[2] ?? 8)
const snapshot = await Effect.runPromise(latestImage(sdk))
const t0 = Date.now()
const at = () => Number(((Date.now() - t0) / 1000).toFixed(2))
const rows = await Promise.all(Array.from({ length: n }, async (_, i) => {
  const start = at()
  const box = await sdk.Sandbox.builder(`boot-probe-${process.pid}-${i}`).fromSnapshot(snapshot).cpus(2).memory(3072)
    .disableNetwork().ephemeral(true).detached(false).create()
  const created = at()
  await box.fs().mkdir("/tmp/probe")
  const ready = at()
  return { box, start, created, ready }
}))
process.stdout.write(`${JSON.stringify(rows.map(({ start, created, ready }) => [start, created, ready]))}\n`)
await Promise.all(rows.map(({ box }) => box.destroy({ timeoutMs: 3000, force: true })))
process.stdout.write(`${JSON.stringify({ n, removed: at() })}\n`)
