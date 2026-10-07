import { LiveChannel } from "../../../../../../apps/app/src/mainview/runtime/LiveChannel.ts"

const [origin, cookie] = process.argv.slice(2)
let socket, connections = 0, dropped = false, lastCursor
const seen = []
const deadline = setTimeout(() => { console.error("run replay timed out"); process.exit(1) }, 20000)
const channel = new LiveChannel({ socket: () => {
  connections++
  socket = new WebSocket(origin.replace("http:", "ws:") + "/api/live", {
    headers: { Cookie: "session=" + cookie, Origin: origin, "Sec-WebSocket-Protocol": "smithers.live.v1" }
  })
  return socket
} })
channel.registerProjection("run:fixture-run", (_, delta) => delta)
channel.subscribe("run:fixture-run", () => {
  const snapshot = channel.getSnapshot("run:fixture-run")
  if (snapshot?.error) throw new Error(snapshot.error)
  if (snapshot?.cursor === undefined) return
  // A continuity notification preserves the previous projection.
  if (snapshot.cursor === lastCursor) return
  if (lastCursor !== undefined && snapshot.cursor < lastCursor) throw new Error("Run cursor moved backwards")
  lastCursor = snapshot.cursor
  seen.push(...snapshot.data.events.map(event => event.kind))
  if (snapshot.cursor === 1) console.log("ready")
  if (snapshot.cursor === 4 && !dropped) {
    dropped = true
    socket.onmessage = null
    socket.close()
    console.log("disconnected")
  }
  if (snapshot.cursor === 8) {
    const expected = ["step.started", "step.output", "step.finished"]
    if (JSON.stringify(seen) !== JSON.stringify(expected) || connections !== 2 || snapshot.data.summary.status !== "completed") {
      throw new Error(JSON.stringify({ seen, connections, snapshot }))
    }
    console.log("replayed")
    clearTimeout(deadline)
    channel.dispose()
  }
})
