import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import type { BunPlugin } from "bun"
import { openApiModule } from "../../scripts/openapi-chunk"

/**
 * The Vite-only imports a browser fixture bundle reaches through the app
 * controller: `?raw` text, and the bundled OpenAPI document that
 * vite.config.ts serves from `openApiChunk`.
 */
export const fixturePlugins: BunPlugin[] = [
  { name: "raw-text", setup(builder) {
    builder.onResolve({ filter: /\?raw$/ }, (args) => ({ path: resolve(args.resolveDir, args.path.slice(0, -4)), namespace: "raw-text" }))
    builder.onLoad({ filter: /.*/, namespace: "raw-text" }, async (args) => ({ contents: `export default ${JSON.stringify(await readFile(args.path, "utf8"))}`, loader: "js" }))
  } },
  { name: "smithers-openapi", setup(builder) {
    builder.onResolve({ filter: /^virtual:smithers-openapi$/ }, () => ({ path: "openapi", namespace: "smithers-openapi" }))
    builder.onLoad({ filter: /.*/, namespace: "smithers-openapi" }, () => ({ contents: openApiModule(), loader: "js" }))
  } }
]
