import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { parse } from "yaml"
import type { Plugin } from "vite"

const OPENAPI_PATH = fileURLToPath(new URL("../../../docs/api/openapi.yaml", import.meta.url))

/** The module every bundler serves for `virtual:smithers-openapi`: the YAML document as JSON data. */
export const openApiModule = (): string => `export default ${JSON.stringify(parse(readFileSync(OPENAPI_PATH, "utf8")))}`

/** T-APP-21: YAML is build input; the browser imports JSON data only. */
export const openApiChunk = (): Plugin => ({
  name: "smithers-openapi-json",
  resolveId: id => id === "virtual:smithers-openapi" ? "\0smithers-openapi" : undefined,
  load(id) {
    if (id !== "\0smithers-openapi") return
    this.addWatchFile(OPENAPI_PATH)
    return openApiModule()
  }
})
