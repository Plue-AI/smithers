import { LiveChannel } from "../../../../../../apps/app/src/mainview/runtime/LiveChannel.ts"
const [origin, cookie, host, runId] = process.argv.slice(2)
const topic = `run:${runId}`
const samples = []
let expected = 0, committedAt, ready = false, observed
const deadline = setTimeout(() => { console.error("journal latency timed out"); process.exit(1) }, 60000)
const channel = new LiveChannel({ socket: () => new WebSocket(origin.replace("http:", "ws:") + "/api/live", {
  headers: { Cookie: "session=" + cookie, Origin: origin, "Sec-WebSocket-Protocol": "smithers.live.v1" }
}) })
channel.registerProjection(topic, (_, delta) => delta)
async function append() {
  expected++
  observed = undefined
  const response = await fetch(host + "/append", { method: "POST", body: JSON.stringify({ index: expected }) })
  if (!response.ok) throw new Error(await response.text())
  committedAt = (await response.json()).committedAt
  if (observed !== undefined) complete()
}
function complete() {
  samples.push(Math.max(0, observed - committedAt))
  committedAt = undefined
  if (samples.length === 50) {
    samples.sort((a, b) => a - b)
    const result = { changes: 50, p50_ms: samples[24], p95_ms: samples[47], max_ms: samples[49] }
    console.log(JSON.stringify(result))
    clearTimeout(deadline)
    channel.dispose()
    if (result.p95_ms > 1000) process.exitCode = 1
  } else void append().catch(fail)
}
function fail(error) { console.error(error); process.exit(1) }
channel.subscribe(topic, () => {
  const snapshot = channel.getSnapshot(topic)
  if (snapshot?.error) return fail(new Error(snapshot.error))
  if (!snapshot?.data) return
  if (!ready) { ready = true; void append().catch(fail); return }
  if (!snapshot.data.steps.some(step => step.label === `step-${expected}` && step.status === "running")) return
  if (observed !== undefined) return
  observed = Date.now()
  if (committedAt !== undefined) complete()
})
