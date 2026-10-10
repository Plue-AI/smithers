import { expect, it } from "vitest"
import { makeCli } from "../src/Cli.ts"
import { installCommandPaths } from "../src/internal/backend/InstallDiscovery.ts"

it("keeps the person-only API playground outside CLI discovery", async () => {
  const cli = makeCli({ environment: {} }, { humanHelp: true })
  const capture = async (args: string[]) => {
    let output = ""
    await cli.serve(args, {
      env: {},
      stdout: (text) => {
        output += text
      },
      exit: (code) => expect(code).toBe(0)
    })
    return output
  }
  expect(await capture(["--help"])).not.toMatch(/^\s+debug\s{2,}/m)
  const paths = installCommandPaths(cli)
  const manifest = JSON.parse(await capture(["--llms-full", "--format", "json"]))
  const names = manifest.commands.map((row: { name: string }) => row.name)
  for (const kept of ["flows", "todo show", "runs show", "api", "workspace ssh", "host status"]) {
    expect(paths).toContain(kept)
    expect(names).toContain(kept)
  }
  // B.6 (including its no-agent approval rule): future/library commands are opt-in.
  for (
    const absent of [
      "debug api",
      "build",
      "serve",
      "environment list",
      "flow list",
      "runs continue",
      "runs stop",
      "admin health",
      "workspace children",
      "approvals approve"
    ]
  ) {
    expect(paths).not.toContain(absent)
    expect(names).not.toContain(absent)
  }
})
