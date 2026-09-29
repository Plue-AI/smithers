import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { Client } from "../src/internal/backend/Client.ts"
import { workspaces } from "../src/internal/backend/Workspaces.ts"

const dirs: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

const fixture = async (failSeed = false) => {
  const home = await mkdtemp(join(tmpdir(), "smithers-workspace-shell-"))
  dirs.push(home)
  const bin = join(home, "bin"), guest = join(home, "guest")
  await mkdir(bin)
  await mkdir(join(home, ".codex"))
  const auth = JSON.stringify({ tokens: { access_token: "synthetic-access", refresh_token: "synthetic-refresh" } })
  const key = "sk-ant-api03-synthetic'credential"
  await writeFile(join(home, ".codex", "auth.json"), auth)
  // No remote backend or guest is available. Replace their network boundaries
  // and guest paths; retain the production SSH transport, stdin and spawner.
  await writeFile(
    join(bin, "ssh"),
    `#!${process.execPath}
const { readFileSync, appendFileSync } = require("node:fs")
const { spawnSync } = require("node:child_process")
const command = process.argv.at(-1).replaceAll("/home/developer", process.env.TEST_GUEST)
const input = readFileSync(0, "utf8").replaceAll("/home/developer", process.env.TEST_GUEST)
appendFileSync(process.env.TEST_SHELL_LOG, JSON.stringify({ command }) + "\\n")
if (process.env.TEST_FAIL_SEED === "1") process.exit(17)
const result = spawnSync(process.env.TEST_LOGIN_SHELL, ["-c", command], { input, encoding: "utf8", env: process.env })
process.stdout.write(result.stdout || "")
process.stderr.write(result.stderr || "")
process.exit(result.status ?? 1)
`,
    { mode: 0o700 }
  )
  await writeFile(
    join(bin, "bash"),
    `#!/bin/sh
printf '%s\\n' bash >> "$TEST_SHELL_LOG"
exec /bin/bash "$@"
`,
    { mode: 0o700 }
  )
  // Root test hosts lack the guest's developer account. Preserve the real
  // ownership command's arguments while limiting its stand-in to the guest.
  if (process.getuid?.() === 0) {
    await writeFile(
      join(bin, "chown"),
      `#!/bin/sh
test "$1" = -R && test "$2" = developer:developer || exit 1
case "$3" in "$TEST_GUEST"/*) exit 0 ;; *) exit 1 ;; esac
`,
      { mode: 0o700 }
    )
  }
  const shell = ["/bin/dash", "/usr/bin/dash"].find(existsSync) ?? "/bin/sh"
  const log = join(home, "shell.log")
  const c = new Client({
    environment: {
      HOME: home,
      PATH: `${bin}:/usr/bin:/bin`,
      SMITHERS_API_ORIGIN: "https://api.example.test",
      SMITHERS_TOKEN: "synthetic-session",
      SMITHERS_DISABLE_SYSTEM_KEYRING: "1",
      ANTHROPIC_API_KEY: key,
      TEST_GUEST: guest,
      TEST_SHELL_LOG: log,
      TEST_LOGIN_SHELL: shell,
      TEST_FAIL_SEED: failSeed ? "1" : "0"
    },
    exit: vi.fn()
  })
  let result: unknown
  // The unavailable remote command service executes its exact submitted argv
  // locally and returns a durable receipt; the shell/process boundary is real.
  const request = vi.spyOn(c, "request").mockImplementation(async (method, path, body) => {
    if (method === "GET" && path.endsWith("/ssh")) {
      return { ssh_command: "ssh guest", host_keys: [{ algorithm: "ssh-ed25519", public_key: "AAAA" }] }
    }
    if (method === "POST" && path.endsWith("/command-runs")) {
      const args = (body as { args: string[] }).args
      expect(args.slice(0, 2)).toEqual(["/bin/bash", "-lc"])
      const executed = spawnSync(args[0]!, args.slice(1), { encoding: "utf8", env: c.env, cwd: home })
      result = {
        exit_code: executed.status,
        stdout: executed.stdout,
        stderr: executed.stderr,
        output_truncated: false
      }
      return { operationId: "shell-run" }
    }
    if (method === "GET" && path.endsWith("/command-runs/shell-run")) {
      return { operationId: "shell-run", state: "completed", result }
    }
    throw new Error(`Unexpected ${method} ${path}`)
  })
  return { c, guest, log, request, auth, key, shell }
}

describe("workspace shell execution (#1865)", () => {
  it.each(["codex", "claude"])("seeds %s through Bash under a POSIX login shell", async (provider) => {
    const { c, guest, log, auth, key, shell } = await fixture()
    if (shell.endsWith("dash")) {
      expect(spawnSync(shell, ["-c", "set -o pipefail"], { encoding: "utf8" }).status).not.toBe(0)
    }
    const response = await workspaces["workspace exec"]!(c, { id: "box" }, {
      repo: "owner/repo",
      seedAgentAuth: provider,
      command: "set -euo pipefail\nvalues=(first 'second line')\nprintf '%s\\n' \"${values[@]}\""
    })
    expect(response).toMatchObject({ exit_code: 0, stdout: "first\nsecond line\n", stderr: "" })
    expect(await readFile(log, "utf8")).toBe("{\"command\":\"bash -s\"}\nbash\n")
    const file = join(guest, provider === "codex" ? ".codex/auth.json" : ".smithers/claude-env.sh")
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    if (provider === "codex") expect(await readFile(file, "utf8")).toBe(auth)
    else {
      const sourced = spawnSync("/bin/bash", ["-c", ". \"$1\"; printf %s \"$ANTHROPIC_API_KEY\"", "bash", file], {
        encoding: "utf8"
      })
      expect(sourced.status).toBe(0)
      expect(sourced.stdout).toBe(key)
      expect(sourced.stderr).toBe("")
    }
  })

  it("refuses command admission when credential seeding exits unsuccessfully", async () => {
    const { c, request, guest } = await fixture(true)
    await expect(workspaces["workspace exec"]!(c, { id: "box" }, {
      repo: "owner/repo",
      seedAgentAuth: "codex",
      command: "printf should-not-run"
    })).rejects.toThrow("Agent credential seeding failed")
    expect(request.mock.calls.some(([method]) => method === "POST")).toBe(false)
    expect(existsSync(guest)).toBe(false)
  })
})
