import { createHash } from "node:crypto"
import { chmod, mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"

const root = fileURLToPath(new URL("../../", import.meta.url))
const output = resolve(process.argv[2] ?? resolve(root, "dist/model-host/smithers.mjs"))
const result = await build({
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
