/** Reference guest only. Run as the daemon user, outside registered agent
 * cgroups, against the composed install. Launch argv must use the installed
 * session launcher, preserving Node IPC fd 3 for its registered agent child.
 * MOVE_ARGV runs the member's unprivileged off-item move; RETURN_URL is the
 * served todo.return-to-item command URL, with a person credential and the
 * current wait/revision payload supplied by RETURN_BODY_ARGV. No GitHub writes.
 * All argv are JSON arrays of strings supplied by the qualification runner.
 */
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { access, readFile, unlink, writeFile } from "node:fs/promises"
import { setTimeout as delay } from "node:timers/promises"

const argv = name => {
  const value = JSON.parse(process.env[name] ?? "null")
  assert.ok(Array.isArray(value) && value.length && value.every(x => typeof x === "string"), name)
  return value
}
const launch = argv("SMITHERS_COL05_AGENT_ARGV")
const move = argv("SMITHERS_COL05_MOVE_ARGV")
const body = argv("SMITHERS_COL05_RETURN_BODY_ARGV")
const receipt = argv("SMITHERS_COL05_RETURN_RECEIPT_ARGV")
const url = process.env.SMITHERS_COL05_RETURN_URL
const token = process.env.SMITHERS_COL05_PERSON_TOKEN
assert.ok(url && token, "served Return URL and person credential required")
assert.equal(process.getuid(), 19998, "run as installed daemon user")
const state = "/var/lib/smithers-machined"
const marker = (point, suffix) => `${state}/qualification-${point}.${suffix}`
const waitHit = async point => {
  const deadline = Date.now() + 25_000
  while (Date.now() < deadline) {
    try {
      assert.equal(await readFile(marker(point, "hit"), "utf8"), point)
      return
    } catch (error) { if (error.code !== "ENOENT") throw error }
    await delay(5)
  }
  throw new Error(`No production ${point} receipt`)
}
const run = (command, input) => new Promise((resolve, reject) => {
  const child = spawn(command[0], command.slice(1), { stdio: ["pipe", "pipe", "inherit"] })
  child.stdin.end(input)
  const timer = setTimeout(() => child.kill(), 25_000)
  let output = ""
  child.stdout.setEncoding("utf8")
  child.stdout.on("data", chunk => { output += chunk })
  child.once("error", error => { clearTimeout(timer); reject(error) })
  child.once("exit", code => {
    clearTimeout(timer)
    if (code === 0) resolve(output)
    else reject(new Error(`Qualification command exited ${code}`))
  })
})
// Never take over an existing qualification's markers.
for (const point of ["freeze-start", "coding-queued"]) {
  for (const suffix of ["arm", "hit"]) {
    try { await access(marker(point, suffix)); throw new Error(`Existing ${point}.${suffix}`) }
    catch (error) { if (error.code !== "ENOENT") throw error }
  }
}
const child = spawn(launch[0], launch.slice(1), {
  stdio: ["ignore", "inherit", "inherit", "ipc"],
  // Person credentials belong to this supervisor, never the coding session.
  env: Object.fromEntries(Object.entries({ ...process.env, SMITHERS_COL05_GUEST: "1" })
    .filter(([key]) => !key.startsWith("SMITHERS_COL05_") || key === "SMITHERS_COL05_GUEST"))
})
let returning
let activeTool
let count = 0
let failed = false
const handle = async message => {
  assert.ok(message && typeof message.tool === "string")
  if (message.phase === "hold-return") {
    assert.equal(activeTool, undefined)
    activeTool = message.tool
    await run(move)
    const payload = JSON.parse(await run(body))
    for (const point of ["freeze-start", "coding-queued"]) {
      await writeFile(marker(point, "arm"), point, { flag: "wx", mode: 0o600 })
    }
    returning = fetch(url, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(30_000)
    }).then(async response => {
      const text = await response.text()
      assert.equal(response.status, 202, `Return: ${text}`)
      // Installed runner waits for this request's durable success receipt. It
      // receives the launch response on stdin, never a hard-coded request id.
      const completion = JSON.parse(await run(receipt, text))
      assert.equal(completion.state, "succeeded", "real Return completion required")
    })
    // Attach rejection handling immediately while waiting for the hold receipt.
    returning.catch(() => {})
    await waitHit("freeze-start")
    child.send({ phase: "return-held", tool: activeTool })
  } else {
    assert.equal(message.phase, "finish-return")
    assert.equal(message.tool, activeTool)
    await waitHit("coding-queued")
    await unlink(marker("freeze-start", "hit"))
    await returning
    // Release the transport thread only after real Return completion.
    await unlink(marker("coding-queued", "hit"))
    child.send({ phase: "returned", tool: activeTool })
    activeTool = undefined
    count++
  }
}
child.on("message", message => {
  handle(message).catch(error => {
    failed = true
    console.error(error.message)
    child.send({ tool: message?.tool, error: error.message })
  })
})
const deadline = setTimeout(() => child.kill(), 125_000)
const code = await new Promise((resolve, reject) => {
  child.once("error", reject)
  child.once("exit", code => resolve(code))
})
clearTimeout(deadline)
for (const point of ["freeze-start", "coding-queued"]) {
  for (const suffix of ["arm", "hit"]) {
    await unlink(marker(point, suffix)).catch(error => { if (error.code !== "ENOENT") throw error })
  }
}
assert.equal(code, 0)
assert.equal(failed, false)
assert.equal(count, 3, "all three production mutation bindings must race Return")
