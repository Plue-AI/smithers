import { afterEach, expect, it, vi } from "vitest"
import { makeCli } from "../src/Cli.ts"
import * as Host from "../src/internal/backend/HostService.ts"
import { Refused } from "../src/CliError.ts"

afterEach(() => vi.restoreAllMocks())

// CLI parsing/presentation coverage. Native dispatch and confinement are
// separately exercised by apps/backend/maintenance_test.go without this mock.
it.each([
  ["backup", undefined], ["upgrade", undefined], ["restore", "/tmp/snapshot with spaces"]
] as const)("host %s reaches maintenance and reports its refusal", async (operation, directory) => {
  const maintenance = vi.spyOn(Host, "maintenance").mockImplementation(() => {
    throw new Refused({ fault: "infra", code: "host_maintenance_unavailable", message: "Verified machine capture unavailable" })
  })
  let output = "", code = 0
  const cli = makeCli({ exit: value => { code = value } })
  await cli.serve(["host", operation, ...(directory ? [directory] : []), "--json"], {
    stdout: text => { output += text }, exit: value => { code = value }
  })
  expect(maintenance).toHaveBeenCalledWith(operation, ...(directory ? [directory] : []))
  expect(code).toBe(1)
  expect(output).toContain("host_maintenance_unavailable")
  expect(output).toContain("Verified machine capture unavailable")
})

it("restore requires a directory before invoking maintenance", async () => {
  const maintenance = vi.spyOn(Host, "maintenance")
  let code = 0
  const cli = makeCli({ exit: value => { code = value } })
  await cli.serve(["host", "restore", "--json"], { stdout: () => {}, exit: value => { code = value } })
  expect(code).not.toBe(0)
  expect(maintenance).not.toHaveBeenCalled()
})
