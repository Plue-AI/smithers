import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execute = promisify(execFile)
// Provisioned reference canary: T2, twelve src files (retry/deliver/a included),
// Maya's SSH key/session, and Ben's signed-in browser. All writes run in the guest.
export const branchSSH = async (operation: string) => {
  const host = process.env.SMITHERS_OUTSIDE_SSH_HOST
  const port = process.env.SMITHERS_OUTSIDE_SSH_PORT
  if (!host || host.startsWith("-") || !port || !/^\d+$/.test(port)) throw new Error("Set SMITHERS_OUTSIDE_SSH_HOST and SMITHERS_OUTSIDE_SSH_PORT for Maya's branch")
  return (await execute("ssh", ["-o", "BatchMode=yes", "-p", port, host, operation], { timeout: 30_000 })).stdout
}
