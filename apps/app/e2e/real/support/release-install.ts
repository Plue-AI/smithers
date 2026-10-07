import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { J1PreconditionError, type requireJ1Preconditions } from "./j1-preconditions"

const execute = promisify(execFile)

/** Only installed Homebrew tools execute here; canary files never run on the host. */
export async function installReleasedHost(input: ReturnType<typeof requireJ1Preconditions>): Promise<string> {
  if (process.platform !== "darwin" || process.arch !== "arm64" || process.getuid?.() === 0) {
    throw new J1PreconditionError("release_host_required", "released installation requires a non-root Apple Silicon reference user")
  }
  if (input.stage !== "R") throw new J1PreconditionError("release_stage_required", "Homebrew qualification requires stage R")
  const run = async (binary: string, argv: string[]) => {
    try { return await execute(binary, argv, { timeout: 600_000, maxBuffer: 1_048_576 }) }
    catch { throw new J1PreconditionError("release_command_failed", `${binary} ${argv.join(" ")} failed; raw output withheld`) }
  }
  // Refuse reuse of a previous installation before changing this user's state.
  const existing = await run("brew", ["list", "--formula"])
  if (existing.stdout.split(/\s+/).includes("smithers")) {
    throw new J1PreconditionError("release_not_fresh", "Smithers is already installed for this user")
  }
  await run("brew", ["install", "smithersai/tap/smithers"])
  const version = await run("smthrs", ["--version"])
  if (!version.stdout.split(/\s+/).includes(input.install.version)) {
    throw new J1PreconditionError("release_version_mismatch", "released CLI does not match the operator's candidate version")
  }
  const started = await run("smthrs", ["host", "start"])
  // The printed token is checked in memory and never attached to artifacts.
  const urls = started.stdout.match(/https?:\/\/[^\s<>"']+/g) ?? []
  const setup = urls.filter(url => {
    const parsed = new URL(url)
    return parsed.origin === new URL(input.setupURL).origin && parsed.pathname === "/setup" &&
      Boolean(parsed.searchParams.get("token")) && !parsed.username && !parsed.password
  })
  if (setup.length !== 1) {
    throw new J1PreconditionError("release_setup_url_mismatch", "host start did not print exactly one setup URL at the declared origin")
  }
  return setup[0]!
}
