import { createHash } from "node:crypto"
import { chmod, mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"

const root = fileURLToPath(new URL("../../", import.meta.url))
const output = resolve(process.argv[2] ?? resolve(root, "dist/model-host/smithers.mjs"))
// `smithers:docs` is the app's in-app docs (M-35): the same page files, parsed
// by the same loader, as the app bundles, so the app agent answers from them.
const appDocs = resolve(root, "apps/app/src/docs")
const docs = {
  name: "smithers-docs",
  setup(plugin) {
    plugin.onResolve({ filter: /^smithers:docs$/ }, () => ({ path: "smithers:docs", namespace: "smithers-docs" }))
    plugin.onLoad({ filter: /.*/, namespace: "smithers-docs" }, async () => {
      const names = (await readdir(resolve(appDocs, "pages"))).filter((name) => name.endsWith(".md")).sort()
      const files = Object.fromEntries(await Promise.all(names.map(async (name) =>
        [`./pages/${name}`, await readFile(resolve(appDocs, "pages", name), "utf8")])))
      return {
        contents: `import { loadDocs } from "./Docs.ts"\nexport const docs = loadDocs(${JSON.stringify(files)}).pages\n`,
        resolveDir: appDocs,
        watchFiles: names.map((name) => resolve(appDocs, "pages", name)),
        loader: "ts"
      }
    })
  }
}
const result = await build({
  plugins: [docs],
  alias: {
    "@smthrs/harness": resolve(root, "packages/smithers/agent/harness/src"),
    "@smthrs/model-host": resolve(root, "packages/smithers/agent/model-host/src"),
    "@smthrs/model": resolve(root, "packages/smithers/agent/model/src"),
    "@smthrs/rpc": resolve(root, "packages/rpc/src")
  },
  entryPoints: [fileURLToPath(new URL("./src/serve.ts", import.meta.url))],
  write: false,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node26.4",
  banner: { js: "#!/usr/bin/env node\nimport {createRequire as __smithersCreateRequire} from 'node:module'; const require=__smithersCreateRequire(import.meta.url);" }
})
if (result.outputFiles.length !== 1) throw new Error("Model host must be one immutable executable")
const bytes = result.outputFiles[0].contents
const digest = createHash("sha256").update(bytes).digest("hex")
await mkdir(dirname(output), { recursive: true })
await writeFile(output, bytes)
await chmod(output, 0o755)
await writeFile(`${output}.sha256`, `${digest}  ${output.split("/").pop()}\n`)
process.stdout.write(`${JSON.stringify({ path: output, sha256: digest })}\n`)
