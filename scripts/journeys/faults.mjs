import { command, required } from "./lib.mjs"
import { sshTarget } from "./outside-save.mjs"

export async function restartBackend({ target, pid, executable, log = async () => {}, execImpl = command }) {
  sshTarget(target)
  if (!Number.isSafeInteger(pid) || pid < 2 || typeof executable !== "string" || !/^\/[A-Za-z0-9_./-]+$/.test(executable) || !/backend/i.test(executable)) throw new Error("Restart needs the exact reference backend PID and executable path")
  const args = ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "--", target]
  const inspected = await execImpl("ssh", [...args, `ps -p ${pid} -o comm=`])
  if (inspected.stdout.trim() !== executable) throw new Error("Backend PID identity changed; refusing SIGKILL")
  await log({ event: "restart.kill", target, pid, executable, signal: "SIGKILL" })
  await execImpl("ssh", [...args, `kill -9 ${pid}`])
  // The launcher restarts it. A successful kill is not a recovery receipt.
  await log({ event: "restart.requested", target, pid })
}

export async function duplicateLaunch({ origin, path, payload, key, token, log = async () => {}, fetchImpl = fetch }) {
  const url = new URL(path, origin)
  if (url.origin !== origin || !url.pathname.startsWith("/api/") || url.search || url.hash || url.username || url.password || !path.startsWith("/")) throw new Error("Duplicate launch must use an API path on the verified install")
  required(key, "Idempotency-Key")
  required(token, "install token")
  const results = []
  for (let attempt = 1; attempt <= 2; attempt++) {
    await log({ event: "duplicate.request", path, key, attempt })
    const response = await fetchImpl(url, { method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000), headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(payload) })
    await log({ event: "duplicate.response", path, key, attempt, status: response.status })
    if (!response.ok) throw new Error(`Duplicate launch HTTP ${response.status}`)
    results.push(await response.json())
  }
  if (JSON.stringify(results[0]) !== JSON.stringify(results[1])) throw new Error("Idempotency-Key repeat did not return the original result")
  const first = results[0]
  if (!first || typeof first !== "object" || !(first.id ?? first.todo_id ?? first.run_id ?? first.result?.id)) throw new Error("Duplicate launch returned no durable result identity")
  await log({ event: "duplicate.reconciled", path, key, id: first.id ?? first.todo_id ?? first.run_id ?? first.result.id })
  return first
}
