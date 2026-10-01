// A real resolver talks UDP to the test-local DNS service, then HTTP uses a real socket.
import { Resolver } from "node:dns/promises"
import { appendFileSync, readFileSync } from "node:fs"
import { get } from "node:http"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
export async function request(root, boundary, index = "probe") {
  const { url, server } = JSON.parse(readFileSync(join(root, `${boundary}-network.json`), "utf8"))
  const record = (event, extra = {}) =>
    appendFileSync(
      join(root, "network.jsonl"),
      JSON.stringify({ event, boundary, index, pid: process.pid, url, at: Date.now(), ...extra }) + "\n"
    )
  const resolver = new Resolver({ timeout: 1000, tries: 1 })
  resolver.setServers([server])
  record("query")
  try {
    const addresses = await resolver.resolve4(new URL(url).hostname)
    record("resolved", { addresses })
    const body = await new Promise((resolve, reject) => {
      const req = get(url, {
        // This callback performs real resolution above; it does not replace a network service.
        lookup: (_hostname, options, callback) =>
          options.all
            ? callback(null, addresses.map((address) => ({ address, family: 4 })))
            : callback(null, addresses[0], 4)
      }, (response) => {
        let body = ""
        response.setEncoding("utf8")
        response.on("data", (data) => {
          body += data
        })
        response.on(
          "end",
          () => response.statusCode === 200 ? resolve(body) : reject(Error(`HTTP ${response.statusCode}`))
        )
        response.on("error", reject)
      })
      req.setTimeout(5000, () => req.destroy(Error("HTTP socket deadline")))
      req.on("error", reject)
    })
    record("response", { body })
    return body
  } catch (error) {
    record("failure", { code: error.code, message: error.message })
    // The owning landing retry classifier accepts the real DNS failure with the command-style message.
    throw Error(`Could not resolve host: ${new URL(url).hostname}: ${error.code}: ${error.message}`)
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [root, boundary] = process.argv.slice(2)
  const processRecord = (event, extra = {}) =>
    appendFileSync(join(root, "network-pids.jsonl"), JSON.stringify({ event, pid: process.pid, ...extra }) + "\n")
  process.on("exit", (code) => processRecord("exit", { code }))
  processRecord("start")
  console.log(await request(root, boundary))
}
