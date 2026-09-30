/** Resolve trusted host packages for ALE flows without per-episode installs. */
import { createRequire, registerHooks } from "node:module"
import { readFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { fileURLToPath, pathToFileURL } from "node:url"

const packages = ["@smthrs/flow", "@smthrs/agent/AgentAction", "@smthrs/agent/EventSink", "effect"]
const hostRequire = createRequire(new URL("../../packages/smithers/dist/esm/bin.js", import.meta.url))
const bindings = new Map(packages.map((name) => [name, pathToFileURL(hostRequire.resolve(name)).href]))
registerHooks({
  resolve(specifier, context, nextResolve) {
    const episode = context.parentURL?.startsWith("file:") && new URL(context.parentURL).pathname.includes("/flows/ale/")
    return nextResolve(episode ? bindings.get(specifier) ?? specifier : specifier, context)
  }
})

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === "--bindings") {
  console.log(JSON.stringify(Object.fromEntries([...bindings].map(([name, url]) => {
    const path = fileURLToPath(url)
    return [name, { path, sha256: createHash("sha256").update(readFileSync(path)).digest("hex") }]
  }))))
}
