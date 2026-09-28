import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { choose, optional } from "./source.ts"
assert.equal(choose(false), "negative")
assert.equal(optional({ value: 2 }), 2)
const child = fileURLToPath(new URL("./child.ts", import.meta.url))
const mode = process.argv[2]
const options = { env: { PATH: process.env.PATH, SPECIAL: "kept" }, stdout: "pipe", stderr: "pipe" }
if (mode === "node-sync") {
  const result = spawnSync(process.execPath, [child, "4"], { env: options.env, encoding: "utf8" })
  assert.equal(result.status, 4, result.stderr)
  assert.equal(result.signal, null)
  assert.equal(result.stdout.trim(), "child:positive:kept")
  assert.equal(result.stderr.trim(), "child-stderr")
} else if (mode === "node-async") {
  const processChild = spawn(process.execPath, [child], { env: options.env, stdio: ["ignore", "pipe", "pipe"] })
  let stdout = "", stderr = ""
  processChild.stdout.on("data", (chunk) => { stdout += chunk })
  processChild.stderr.on("data", (chunk) => { stderr += chunk })
  const result = await new Promise((resolve, reject) => {
    processChild.once("error", reject)
    processChild.once("close", (code, signal) => resolve({ code, signal }))
  })
  assert.deepEqual(result, { code: 0, signal: null }, stderr)
  assert.equal(stdout.trim(), "child:positive:kept")
  assert.equal(stderr.trim(), "child-stderr")
} else if (mode === "bun-sync") {
  const result = Bun.spawnSync({ cmd: [process.execPath, child], ...options })
  assert.equal(result.exitCode, 0, result.stderr.toString())
  assert.equal(result.stdout.toString().trim(), "child:positive:kept")
  assert.equal(result.stderr.toString().trim(), "child-stderr")
} else if (mode === "bun-async") {
  const result = Bun.spawn([process.execPath, child], options)
  const code = await result.exited
  assert.equal(code, 0, code === 0 ? undefined : await new Response(result.stderr).text())
  assert.equal((await new Response(result.stdout).text()).trim(), "child:positive:kept")
  assert.equal((await new Response(result.stderr).text()).trim(), "child-stderr")
} else throw new Error("Unknown controlled process case")
console.log("parent completed")
