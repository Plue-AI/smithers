import { createInterface } from "node:readline"
import { LiveChannel } from "../../../../../../apps/app/src/mainview/runtime/LiveChannel.ts"
import { projectRunTopic } from "../../../../../../apps/app/src/mainview/state/seams/RunMonitorSeam.ts"

const [origin] = process.argv.slice(2)
if (!origin?.startsWith("http://127.0.0.1:")) throw new Error("Fixture requires its own loopback server")
// The browser owns projection and reconnect behavior. This bridge only carries
// subscriptions and the Branch card's presence in, and the production client's
// committed views out.
const channel = new LiveChannel({
  socket: () => new WebSocket(origin.replace("http:", "ws:") + "/api/live", {
    headers: {
      Cookie: process.env.SMITHERS_LIVE_REHEARSAL_COOKIE ?? "",
      Origin: origin,
      "Sec-WebSocket-Protocol": "smithers.live.v1"
    }
  })
})
// One mounted reader's lease, as the Branch card holds it: a move sends at
// once and the channel's heartbeat renews it; a null location releases it.
let presence
try {
  for await (const line of createInterface({ input: process.stdin })) {
    const request = JSON.parse(line)
    if (request.t === "presence") {
      if (request.where) {
        if (presence) presence.move(request.where)
        else presence = channel.trackPresence(request.where)
      } else {
        presence?.release()
        presence = undefined
      }
      continue
    }
    if (request.t !== "sub") throw new Error("Unknown rehearsal command")
    // The run monitor registers its run:<id> projection, as the app's seam does.
    if (request.topic.startsWith("run:")) channel.registerProjection(request.topic, projectRunTopic)
    let previous
    channel.subscribe(request.topic, () => {
      const snapshot = channel.getSnapshot(request.topic)
      if (!snapshot || (!snapshot.error && snapshot.cursor === undefined)) return
      const frame = snapshot.error
        ? { t: "err", id: request.id, code: snapshot.error }
        : { t: "snap", id: request.id, cursor: snapshot.cursor, data: snapshot.data }
      const encoded = JSON.stringify(frame)
      if (encoded === previous) return
      previous = encoded
      console.log(encoded)
    })
  }
} finally {
  channel.dispose()
}
