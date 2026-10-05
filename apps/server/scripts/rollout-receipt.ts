/** Restore the existing trusted deployment artifact into a fresh runner's receipt store. */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

export interface ReceiptTransport {
  json(path: string): Promise<unknown>
  download(artifactId: number, directory: string): Promise<void>
}

/** Only the API hop carries the broker's placeholder; signed downloads carry no credential. */
export const receiptTransport = (repository: string): ReceiptTransport => {
  const base = process.env.GITHUB_API_URL ?? "https://api.github.com"
  const api = (path: string) => fetch(`${base}/${path}`, {
    headers: { authorization: `Bearer ${process.env.GITHUB_TOKEN ?? ""}`, accept: "application/vnd.github+json" },
    redirect: "manual", signal: AbortSignal.timeout(60_000)
  })
  return {
    async json(path) {
      const response = await api(path)
      if (!response.ok) throw Error("Deployment receipt read failed")
      return response.json()
    },
    async download(artifactId, directory) {
      const response = await api(`repos/${repository}/actions/artifacts/${artifactId}/zip`)
      const location = response.headers.get("location")
      if (response.status !== 302 || !location) throw Error("Deployment receipt download refused")
      const url = new URL(location)
      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw Error("Deployment receipt download refused")
      const archive = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(60_000) })
      if (!archive.ok) throw Error("Deployment receipt download failed")
      const zip = join(directory, "receipt.zip")
      await Bun.write(zip, await archive.arrayBuffer())
      const proc = Bun.spawn(["unzip", "-q", zip, "-d", directory], { stdout: "ignore", stderr: "ignore" })
      const timer = setTimeout(() => proc.kill("SIGKILL"), 60_000)
      try { if (await proc.exited !== 0) throw Error("Deployment receipt extraction failed") }
      finally { clearTimeout(timer) }
    }
  }
}
export const restoreRolloutReceipt = async (repository: string, directory: string, transport: ReceiptTransport = receiptTransport(repository)): Promise<void> => {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw Error("Invalid deployment repository")
  for (let page = 1; ; page++) {
    const { artifacts } = await transport.json(`repos/${repository}/actions/artifacts?name=deploy-receipt&per_page=100&page=${page}`) as {
      artifacts: Array<{ id: number; expired: boolean; workflow_run: { id: number } }>
    }
    if (!artifacts.length) return
    for (const artifact of artifacts) {
      const runId = String(artifact.workflow_run.id)
      const run = await transport.json(`repos/${repository}/actions/runs/${runId}`) as {
        path: string; event: string; head_branch: string; status: string
      }
      if (run.path !== ".github/workflows/apps-deploy.yml" || run.event !== "push" || run.head_branch !== "main" || run.status !== "completed") continue
      // Never reach past expired evidence to silently select an older recovery target.
      if (artifact.expired) return
      const temporary = mkdtempSync(join(tmpdir(), "smithers-rollout-receipt-"))
      try {
        await transport.download(artifact.id, temporary)
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
