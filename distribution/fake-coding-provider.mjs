import { createServer } from "node:http"

const proof = "The coding Flow wrote this file through the packaged host.\n"
const cell = `\`\`\`cell
const written = await ctx.call("write", { path: "flow-proof.txt", content: ${JSON.stringify(proof)} });
if (written.ok === false) throw new Error(written.error?.message ?? "write failed");
const read = await ctx.call("read", { path: "flow-proof.txt" });
if (read.ok === false || read.content !== ${JSON.stringify(proof.trimEnd())}) throw new Error("readback failed");
ctx.done({ messages: ["Wrote flow-proof.txt and read it back."] });
\`\`\``

const server = createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200).end("ok")
    return
  }
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  let input
  try { input = JSON.parse(Buffer.concat(chunks).toString("utf8")) } catch { input = {} }
  console.log(`provider ${request.method} ${request.url}`)
  if (request.method === "POST" && request.url === "/v1/chat/completions") {
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
    response.write(`data: ${JSON.stringify({ id: "chatcmpl-coding-proof", choices: [{ index: 0, delta: { role: "assistant", content: cell }, finish_reason: null }] })}\n\n`)
    response.write(`data: ${JSON.stringify({ id: "chatcmpl-coding-proof", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`)
    // The metered model proxy settles the call from this usage report.
    response.write(`data: ${JSON.stringify({ id: "chatcmpl-coding-proof", choices: [], usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 } })}\n\n`)
    response.end("data: [DONE]\n\n")
    return
  }
  if (request.method === "POST" && request.url === "/v4/ai/evaluation-model") {
    const answers = Object.fromEntries(Object.entries(input.questions ?? {}).map(([name, question]) => {
      if (question.type !== "boolean") throw new Error(`unexpected evaluation type: ${question.type}`)
      return [name, { type: "boolean", probability: name === "complete" ? 0.99 : 0.01 }]
    }))
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ answers }))
    return
  }
  response.writeHead(404).end("unknown provider route")
})
// The image acceptance serves on 8080; a local acceptance picks its own port.
server.listen(Number(process.env.PORT ?? 8080), process.env.HOST ?? "0.0.0.0")
