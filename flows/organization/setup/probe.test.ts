/**
 * The doctor's boot probe against real local Microsandbox microVMs. It skips,
 * by name, only on a host that positively lacks a hypervisor or the SDK.
 * Every machine it boots carries a `smithers-doctor-*` owner and is removed
 * by the probe itself; the test proves none is left behind.
 */
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { doctor, hypervisorLine } from "./doctor.ts"
import { bootProbe, locate, msb, sdkOf } from "./microsandbox.ts"
import { exampleRoot } from "./settings.ts"

const install = locate()
const hypervisor = hypervisorLine(process.platform)
const skip = install === undefined
  ? "the microsandbox SDK is not installed"
  : hypervisor.status !== "pass"
  ? `no hypervisor: ${hypervisor.detail}`
  : false
const image = "node:26-bookworm"

const run = `probe-test-${process.pid}-${Date.now()}`
const doctorMachines = () => {
  const listed = msb(install!, ["list", "--format", "json"])
  assert.equal(listed.status, 0, listed.stderr)
  return (JSON.parse(listed.stdout) as Array<unknown>).filter((machine) => JSON.stringify(machine).includes(run))
}

test(
  "the boot probe runs a command in a real Linux guest and leaves no machine",
  { skip, timeout: 900_000 },
  async () => {
    const sdk = await sdkOf(install!)
    // Exit 0 only inside a Linux guest: this host is not Linux.
    const guest = await bootProbe(sdk, image, {
      command: "test \"$(uname -s)\" = Linux && test -f /etc/debian_version",
      run: `${run}-guest`
    })
    assert.equal(guest.ok, true, guest.detail)
    const plain = await bootProbe(sdk, image, { run: `${run}-plain` })
    assert.equal(plain.ok, true, plain.detail)
    assert.match(plain.detail, /^node:26-bookworm booted, `true` exited 0 in /)
    // While a probe runs its machine is listed under this run, so the final
    // emptiness check below is not vacuous.
    const slow = bootProbe(sdk, image, { command: "sleep 3", run: `${run}-slow` })
    let seen = false
    for (let attempt = 0; attempt < 50 && !seen; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      seen = doctorMachines().length > 0
    }
    assert.equal(seen, true)
    assert.equal((await slow).ok, true)
    const failing = await bootProbe(sdk, image, { command: "exit 7", run: `${run}-exit` })
    assert.equal(failing.ok, false)
    assert.match(failing.detail, /`exit 7` exited 7/)
    const missing = await bootProbe(sdk, "smithers-doctor-no-such-image:0", {
      timeoutMs: 120_000,
      run: `${run}-missing`
    })
    assert.equal(missing.ok, false)
    assert.deepEqual(doctorMachines(), [])
  }
)

test("doctor passes the real host checks against the example organization", { skip, timeout: 900_000 }, async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "org-probe-"))
  // This machine's Node installations, and nothing else from the environment.
  const env = { PATH: process.env.PATH, HOME: process.env.HOME }
  const lines = await doctor({ root: exampleRoot, repos: [], stateDir: join(stateDir, "state"), env })
  rmSync(stateDir, { recursive: true, force: true })
  const status = Object.fromEntries(lines.map((line) => [line.name, line.status]))
  for (const name of ["node", "microsandbox", "hypervisor", "org", "image", "boot"]) {
    assert.equal(status[name], "pass", `${name}: ${lines.find((line) => line.name === name)?.detail}`)
  }
  assert.equal(status.slack, "skip")
})
