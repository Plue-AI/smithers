---
title: "Webhook ingress"
description: "Bound request bodies before shared channel ingestion."
---

Register a verified `Core.Channel.make` channel named `signed`. The host
provides `channelsLayer` and requires a stable `x-delivery` identity. GitHub
webhooks use the backend receiver; this is the generic host channel boundary.

```ts
import * as Channels from "@smthrs/control/Channels"
import { Effect } from "effect"
import { createServer } from "node:http"

const maxBodyBytes = 1024 * 1024
const server = createServer((request, response) => {
  const chunks: Array<Uint8Array> = []
  let receivedBytes = 0
  let stopped = false
  const discard = () => {
    stopped = true
    chunks.length = 0
  }
  request.on("aborted", discard)
  request.on("error", () => {
    discard()
    response.destroy()
  })
  request.on("data", (chunk: Uint8Array) => {
    if (stopped) return
    receivedBytes += chunk.byteLength
    if (receivedBytes > maxBodyBytes) {
      discard()
      request.pause()
      response.writeHead(413, { Connection: "close" }).end(() => request.destroy())
      return
    }
    chunks.push(chunk)
  })
  request.on("end", () => {
    if (stopped) return
    const body = Buffer.concat(chunks)
    discard()
    const delivery = request.headers["x-delivery"]
    if (typeof delivery !== "string" || delivery.trim() === "") {
      response.writeHead(401).end()
      return
    }
    const program = Effect.gen(function*() {
      const channels = yield* Channels.Channels
      const raw = {
        body,
        headers: request.headers as Record<string, string | undefined>
      }
      return yield* channels.ingest({
        channel: "signed",
        raw: { ...raw, idempotencyKey: delivery }
      })
    })
    Effect.runPromise(Effect.provide(program, channelsLayer)).then(
      () => response.writeHead(200).end(),
      () => response.writeHead(401).end()
    )
  })
})
```
