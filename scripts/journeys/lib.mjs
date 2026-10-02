import { spawn } from "node:child_process"
import { pathToFileURL } from "node:url"
import { appendFile, mkdir } from "node:fs/promises"
import { join } from "node:path"

export const isMain = (url) => process.argv[1] && url === pathToFileURL(process.argv[1]).href

export function required(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Missing ${name}`)
  return value
}

export function safeRelativePath(value) {
  required(value, "relative file path")
  if (!/^[a-zA-Z0-9_./-]+$/.test(value) || value.startsWith("/") || value.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("Unsafe relative file path")
  }
  return value
}

// Never pass the harness's GitHub tokens to a terminal or repository process.
export function childEnvironment(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !/(TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY)/i.test(key)))
}

const scrub = (value, secrets) => {
  if (typeof value === "string") return secrets.reduce((text, secret) => text.replaceAll(secret, "[redacted]"), value)
  if (Array.isArray(value)) return value.map((item) => scrub(item, secrets))
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /(?:token|password|secret|authorization|cookie|private.?key|api.?key)/i.test(key) ? "[redacted]" : scrub(item, secrets)]))
  return value
}

export async function createStepLog(directory, { now = () => new Date() } = {}) {
  await mkdir(directory, { recursive: true })
  const secrets = Object.entries(process.env).filter(([key, value]) => /TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY/i.test(key) && value.length >= 8).map(([, value]) => value)
  let tail = Promise.resolve()
  return (event) => {
    if (!event || typeof event.event !== "string" || !event.event) throw new Error("Step log event name required")
    const entry = { ...scrub(event, secrets), timestamp: new Date(now()).toISOString() }
    const next = tail.then(async () => { await appendFile(join(directory, "steps.jsonl"), `${JSON.stringify(entry)}\n`, { mode: 0o600 }); return entry })
    tail = next
    return next
  }
}

export async function command(file, args, { input, timeout = 30_000, env = childEnvironment(), spawnImpl = spawn } = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawnImpl(file, args, { env, stdio: ["pipe", "pipe", "pipe"], shell: false })
    let stdout = ""
    let stderr = ""
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL") }, timeout)
    child.stdout.on("data", (data) => { stdout += data })
    child.stderr.on("data", (data) => { stderr += data })
    child.on("error", (error) => { clearTimeout(timer); reject(error) })
    child.on("close", (code) => {
      clearTimeout(timer)
      if (timedOut || code !== 0) reject(new Error(`${file} ${timedOut ? "timed out" : `exited ${code}`}`))
      else resolve({ stdout, stderr, code })
    })
    child.stdin.on("error", () => {})
    child.stdin.end(input)
  })
}

export async function cli(main) {
  try { await main() } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1 }
}
