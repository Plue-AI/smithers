import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

const build = await Bun.build({
  entrypoints: [fileURLToPath(new URL("../../src/mainview/cards/fixtures/UiSurfacesBrowser.ts", import.meta.url))],
  target: "browser", define: { "process.env.NODE_ENV": JSON.stringify("production") },
  plugins: [{ name: "raw-text", setup(builder) {
    builder.onResolve({ filter: /\?raw$/ }, (args) => ({ path: resolve(args.resolveDir, args.path.slice(0, -4)), namespace: "raw-text" }))
    builder.onLoad({ filter: /.*/, namespace: "raw-text" }, async (args) => ({ contents: `export default ${JSON.stringify(await readFile(args.path, "utf8"))}`, loader: "js" }))
  } }]
})
if (!build.success) throw new AggregateError(build.logs, "UI surfaces fixture did not build")
await Bun.write(Bun.stdout, build.outputs[0]!)
