/** Restore the existing trusted deployment artifact into a fresh runner's receipt store. */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

type Command = (args: string[]) => Promise<string>
const gh: Command = async args => {
  const proc = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "ignore" })
  const timer = setTimeout(() => proc.kill("SIGKILL"), 60_000)
  try {
    const output = await new Response(proc.stdout).text()
    if (await proc.exited !== 0) throw Error("Deployment receipt read failed")
    return output
  } finally { clearTimeout(timer) }
}
export const restoreRolloutReceipt = async (repository: string, directory: string, command: Command = gh): Promise<void> => {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw Error("Invalid deployment repository")
  for (let page = 1; ; page++) {
    const { artifacts } = JSON.parse(await command(["api", `repos/${repository}/actions/artifacts?name=deploy-receipt&per_page=100&page=${page}`])) as {
      artifacts: Array<{ id: number; expired: boolean; workflow_run: { id: number } }>
    }
    if (!artifacts.length) return
    for (const artifact of artifacts) {
      const runId = String(artifact.workflow_run.id)
      const run = JSON.parse(await command(["api", `repos/${repository}/actions/runs/${runId}`])) as {
        path: string; event: string; head_branch: string; status: string
      }
      if (run.path !== ".github/workflows/apps-deploy.yml" || run.event !== "push" || run.head_branch !== "main" || run.status !== "completed") continue
      // Never reach past expired evidence to silently select an older recovery target.
      if (artifact.expired) return
      const temporary = mkdtempSync(join(tmpdir(), "smithers-rollout-receipt-"))
      try {
        await command(["run", "download", runId, "--repo", repository, "--name", "deploy-receipt", "--dir", temporary])
        const source = join(temporary, "rollout", "last-rollback.json")
        if (!existsSync(source)) {
          // The latest real deploy carries any earlier rollback forward. Do not resurrect stale evidence.
          if (existsSync(join(temporary, "latest.json"))) return
          continue
        }
        mkdirSync(directory, { recursive: true })
        copyFileSync(source, join(directory, "last-rollback.json"))
        return
      } finally { rmSync(temporary, { recursive: true, force: true }) }
    }
    if (artifacts.length < 100) return
  }
}
if (import.meta.main) {
  await restoreRolloutReceipt(process.env.GITHUB_REPOSITORY ?? "", new URL("../deploy-receipts/rollout", import.meta.url).pathname)
}
