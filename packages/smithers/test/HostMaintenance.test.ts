import { afterEach, expect, it, vi } from "vitest"
import { makeCli } from "../src/Cli.ts"
import { Refused } from "../src/CliError.ts"
import * as Host from "../src/internal/backend/HostService.ts"

afterEach(() => vi.restoreAllMocks())

// CLI parsing/presentation coverage. Native dispatch and confinement are
// separately exercised by apps/backend/maintenance_test.go without this mock.
it.each(
  [
    ["backup", undefined],
    ["upgrade", undefined],
    ["restore", "/tmp/snapshot with spaces"]
  ] as const
)("host %s reaches maintenance and reports its refusal", async (operation, directory) => {
  const maintenance = vi.spyOn(Host, "maintenance").mockImplementation(() => {
    throw new Refused({
      fault: "infra",
      code: "host_maintenance_unavailable",
      message: "Verified machine capture unavailable"
    })
  })
  let output = "", code = 0
  const cli = makeCli({
    exit: (value) => {
      code = value
    }
  })
  await cli.serve(["host", operation, ...(directory ? [directory] : []), "--json"], {
    stdout: (text) => {
      output += text
    },
    exit: (value) => {
      code = value
    }
  })
  expect(maintenance).toHaveBeenCalledWith(operation, ...(directory ? [directory] : []))
  expect(code).toBe(1)
  expect(output).toContain("host_maintenance_unavailable")
  expect(output).toContain("Verified machine capture unavailable")
})

it("restore requires a directory before invoking maintenance", async () => {
  const maintenance = vi.spyOn(Host, "maintenance")
  let code = 0
  const cli = makeCli({
    exit: (value) => {
      code = value
    }
  })
  await cli.serve(["host", "restore", "--json"], {
    stdout: () => {},
    exit: (value) => {
      code = value
    }
  })
  expect(code).not.toBe(0)
  expect(maintenance).not.toHaveBeenCalled()
})

it.each(
  [
    ["backup", undefined, "/Users/owner/Library/Application Support/Smithers/backups/1.2.3-20261007T010203Z"],
    ["restore", "/snapshot with spaces", "2026-10-07T01:02:03Z"]
  ] as const
)("host %s presents the native receipt", async (operation, directory, receipt) => {
  vi.spyOn(Host, "maintenance").mockReturnValue(receipt)
  let output = "", code = 0
  await makeCli({
    exit: (value) => {
      code = value
    }
  }).serve(
    ["host", operation, ...(directory ? [directory] : [])],
    {
      stdout: (text) => {
        output += text
      },
      exit: (value) => {
        code = value
      }
    }
  )
  expect(code).toBe(0)
  expect(output).toContain(receipt)
})
