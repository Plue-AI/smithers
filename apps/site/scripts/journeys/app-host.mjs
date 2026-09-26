/**
 * The docs capture host: the real app server (apps/app/src/bun/server.ts)
 * serving the built SPA offline, with a scripted model behind the chat
 * boundary so captures are repeatable. Run with Bun; prints `ready <origin>`.
 *
 * Usage: bun scripts/journeys/app-host.mjs <replies.json>
 */
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { startLocalServer } from "../../../app/src/bun/server.ts"

const here = fileURLToPath(new URL(".", import.meta.url))
const distDir = resolve(here, "../../../app/dist")
const replies = JSON.parse(await readFile(process.argv[2], "utf8"))

const lastUser = (request) => {
  for (let i = request.messages.length - 1; i >= 0; i -= 1) {
    const message = request.messages[i]
    if (message?.role === "user") return message.content
  }
  return ""
}

/** Streams the scripted reply for the last user message, word by word. */
const scriptedAgent = (publish) => {
  const active = new Set()
  return {
    start: (request) => {
      if (active.has(request.runId)) return { status: "error", message: "That Smithers turn is already running." }
      active.add(request.runId)
      const prompt = lastUser(request)
      const reply = replies.find((entry) => prompt.includes(entry.when))?.reply ?? "I don't have a scripted reply for that."
      const words = reply.split(/(?<= )/)
      const frames = [
        { type: "delta", kind: "reasoning", text: "Reading the request." },
        ...words.map((text) => ({ type: "delta", kind: "text", text })),
        { type: "done", reason: "stop" }
      ]
      let index = 0
      const step = () => {
        if (!active.has(request.runId)) return
        const frame = frames[index++]
        if (frame === undefined) return void active.delete(request.runId)
        publish({ runId: request.runId, ...frame })
        setTimeout(step, index === 1 ? 700 : 35)
      }
      setTimeout(step, 400)
      return { status: "started" }
    },
    cancel: (runId) => {
      if (!active.delete(runId)) return { status: "not-found" }
      return { status: "cancelled" }
    }
  }
}

const root = await mkdtemp(join(tmpdir(), "smithers-docs-capture-"))
const server = await startLocalServer({
  port: Number(process.env.PORT ?? 0),
  distDir,
  agent: scriptedAgent,
  cloudMode: "offline",
  cloudApi: null,
  identityUpstream: null,
  home: root,
  stateDir: join(root, "state")
})
console.log(`ready ${server.origin}`)
const stop = () => server.stop().then(() => rm(root, { recursive: true, force: true })).finally(() => process.exit(0))
process.on("SIGINT", stop)
process.on("SIGTERM", stop)
