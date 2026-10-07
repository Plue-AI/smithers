import { LiveChannel } from "../../../../../../apps/app/src/mainview/runtime/LiveChannel.ts"

const [origin, token] = process.argv.slice(2)
if (!origin?.startsWith("http://127.0.0.1:")) throw new Error("Fixture requires its own loopback server")
let socket
let connections = 0
let ready = false
let dropped = false
const applied = []
let observed
const deadline = setTimeout(() => { console.error("LiveChannel fixture timed out"); process.exit(2) }, 75000)
const channel = new LiveChannel({
  random: () => 0,
  project: (_topic, _previous, delta) => delta,
  socket: () => {
    connections++
    socket = new WebSocket(origin.replace("http:", "ws:") + "/api/live", {
      headers: { Cookie: "smithers_session=" + token, Origin: origin, "Sec-WebSocket-Protocol": "smithers.live.v1" }
    })
    return socket
  }
})
channel.subscribe("home", () => {
  const snapshot = channel.getSnapshot("home")
  if (snapshot?.error) throw new Error(snapshot.error)
  if (snapshot?.cursor === undefined) return
  // Continuity notifications retain the same view; they are not replayed rows.
  if (snapshot === observed) return
  observed = snapshot
  if (!ready) {
    ready = true
    console.log(JSON.stringify({ ready: snapshot.cursor }))
    return
  }
  applied.push(snapshot.cursor)
  if (!dropped && applied.length === 500) {
    dropped = true
    // A network fault drops queued reads too; the production client's close
    // handler must reconnect and carry its own last applied cursor.
    socket.onmessage = null
    socket.close()
  }
  if (applied.length === 1000) {
    console.log(JSON.stringify({ applied, connections, state: snapshot.data.State }))
    clearTimeout(deadline)
    channel.dispose()
  }
})
