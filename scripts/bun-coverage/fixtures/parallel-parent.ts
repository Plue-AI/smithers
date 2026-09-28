import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
const childPath = fileURLToPath(new URL("./child.ts", import.meta.url))
await Promise.all([0, 4, 0].map(async (status) => {
  const child = spawn(process.execPath, [childPath, String(status)], {
    env: { PATH: process.env.PATH, SPECIAL: "kept" }, stdio: ["ignore", "pipe", "pipe"]
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  let stdout = "", stderr = ""
  child.stdout.on("data", (bytes) => { stdout += bytes })
  child.stderr.on("data", (bytes) => { stderr += bytes })
  try {
    const actual = await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Parallel child deadline")), 5_000)
      child.once("error", reject)
      child.once("close", (code, signal) => resolve({ code, signal }))
    })
    assert.deepEqual(actual, { code: status, signal: null })
    assert.equal(stdout.trim(), "child:positive:kept")
    assert.equal(stderr.trim(), "child-stderr")
  } finally { clearTimeout(timer); child.kill("SIGKILL") }
}))
