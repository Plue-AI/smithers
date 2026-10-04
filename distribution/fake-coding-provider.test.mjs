import { strict as assert } from "node:assert"
import { spawn } from "node:child_process"
import { createServer } from "node:net"
import { test } from "node:test"

const freePort = async () => {
  const listener = createServer()
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve))
  const port = listener.address().port
  await new Promise((resolve) => listener.close(resolve))
  return port
}

test("scripted provider answers the host's mixed supervisor judgment and later completion", { timeout: 10_000 }, async (t) => {
  const port = await freePort()
  const origin = `http://127.0.0.1:${port}`
  const provider = spawn(process.execPath, [new URL("./fake-coding-provider.mjs", import.meta.url).pathname], {
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"]
  })
  let output = ""
  provider.stdout.setEncoding("utf8").on("data", (chunk) => { output += chunk })
  provider.stderr.setEncoding("utf8").on("data", (chunk) => { output += chunk })
  const exited = new Promise((resolve) => provider.once("exit", resolve))
  t.after(async () => {
    if (provider.exitCode === null && provider.signalCode === null) provider.kill()
    await exited
  })

  const deadline = Date.now() + 3000
  while (true) {
    try {
      const health = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(250) })
      if (health.ok) break
    } catch { /* The provider may still be starting. */ }
    assert.ok(Date.now() < deadline, `scripted provider did not start: ${output}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }

  const request = (questions) => fetch(`${origin}/v4/ai/evaluation-model`, {
    method: "POST",
    headers: {
      authorization: "Bearer scripted-evaluator-key",
      "ai-model-id": "typesafe-ai/jev",
      "ai-gateway-protocol-version": "0.0.1",
      "ai-gateway-auth-method": "api-key",
      "ai-evaluation-model-specification-version": "4",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      state: { task: "Write and read back flow-proof.txt", signals: { repeatFrames: 0 } },
      questions,
      providerOptions: { gateway: { zeroDataRetention: true } }
    })
  })
  const evaluate = async (questions) => {
    const response = await request(questions)
    if (response.status !== 200) assert.fail(`evaluation HTTP ${response.status}: ${await response.text()}`)
    assert.match(response.headers.get("content-type"), /^application\/json/)
    return response.json()
  }

  // The host's supervisor asks these three question types in one Jev call.
  const supervisor = await evaluate({
    on_target: { type: "boolean", instructions: "Is the run on task?", criteria: { true: "yes", false: "no" } },
    frustrated: { type: "score", instructions: "How frustrated is the run?", criteria: ["none", "mild", "strong"] },
    confident: { type: "score", instructions: "Is the run converging?", criteria: ["none", "mild", "strong"] },
    needs_help: {
      type: "choice", instructions: "What does the run need?",
      criteria: { none: "nothing", clarification: "ask the person", stuck: "intervene" }
    }
  })
  assert.deepEqual(Object.keys(supervisor.answers).sort(), ["confident", "frustrated", "needs_help", "on_target"])
  assert.deepEqual(supervisor.answers.on_target, { type: "boolean", probability: 0.99 })
  assert.deepEqual(supervisor.answers.frustrated, { type: "score", score: 0 })
  assert.deepEqual(supervisor.answers.confident, { type: "score", score: 2 })
  assert.deepEqual(supervisor.answers.needs_help, { type: "choice", choice: "none" })

  const malformed = await request({ unknown: { type: "mystery", instructions: "Unknown question" } })
  assert.equal(malformed.status, 400)
  assert.match(await malformed.text(), /unexpected evaluation type: mystery/)

  // A prior supervisor call or malformed request must not kill the provider before completion.
  const completion = await evaluate({
    complete: { type: "boolean", instructions: "Was the task done?", criteria: { true: "yes", false: "no" } },
    overclaims: { type: "boolean", instructions: "Is anything unsupported?", criteria: { true: "yes", false: "no" } },
    invented: { type: "boolean", instructions: "Was an outcome invented?", criteria: { true: "yes", false: "no" } }
  })
  assert.deepEqual(completion.answers, {
    complete: { type: "boolean", probability: 0.99 },
    overclaims: { type: "boolean", probability: 0.01 },
    invented: { type: "boolean", probability: 0.01 }
  })
})
