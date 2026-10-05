import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { parse } from "yaml"
import type { Plugin } from "vite"

/** T-APP-21: YAML is build input; the browser imports JSON data only. */
export const openApiChunk = (): Plugin => ({
  name: "smithers-openapi-json",
  resolveId: id => id === "virtual:smithers-openapi" ? "\0smithers-openapi" : undefined,
  load(id) {
    if (id !== "\0smithers-openapi") return
    const path = fileURLToPath(new URL("../../../docs/api/openapi.yaml", import.meta.url))
    this.addWatchFile(path)
    return `export default ${JSON.stringify(parse(readFileSync(path, "utf8")))}`
  }
})
