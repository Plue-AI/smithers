import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
const childPath = fileURLToPath(new URL("./signal-child.ts", import.meta.url))
const mode = process.argv[2]
let timer: ReturnType<typeof setTimeout> | undefined
if (mode === "node") {
  const child = spawn(process.execPath, [childPath], { stdio: ["ignore", "pipe", "pipe"] })
  try {
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Child readiness deadline")), 3_000)
      child.once("error", reject)
      child.stdout.once("data", (bytes) => { assert.equal(bytes.toString().trim(), "ready"); resolve() })
    })
    const ended = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })))
    assert.equal(child.kill("SIGTERM"), true)
    assert.deepEqual(await ended, { code: 23, signal: null })
  } finally { clearTimeout(timer); child.kill("SIGKILL") }
} else if (mode === "bun") {
  const child = Bun.spawn([process.execPath, childPath], { stdout: "pipe", stderr: "pipe" })
  try {
    const reader = child.stdout.getReader()
    const ready = await Promise.race([
      reader.read(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Child readiness deadline")), 3_000)
      })
    ])
    assert.equal(new TextDecoder().decode(ready.value).trim(), "ready")
    reader.releaseLock()
    child.kill("SIGTERM")
    assert.equal(await child.exited, 23)
  } finally { clearTimeout(timer); child.kill("SIGKILL") }
} else throw new Error("Unknown signal fixture mode")
