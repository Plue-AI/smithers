import { build } from "esbuild"
import { createHash } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { resolve, dirname, basename } from "node:path"
import { fileURLToPath } from "node:url"

const output = resolve(process.argv[2] ?? "dist/chat-connector/smithers-chat-connector")
const result = await build({
  entryPoints: [fileURLToPath(new URL("./serve.ts", import.meta.url))],
  bundle: true, write: false, platform: "node", format: "esm", target: "node26.4",
  banner: { js: "#!/usr/bin/env node\nimport {createRequire as __createRequire} from 'node:module'; const require=__createRequire(import.meta.url);" }
})
if (result.outputFiles.length !== 1) throw new Error("Chat connector host must be one executable")
const bytes = result.outputFiles[0].contents
await mkdir(dirname(output), { recursive: true })
await writeFile(output, bytes, { mode: 0o755 })
await writeFile(`${output}.sha256`, `${createHash("sha256").update(bytes).digest("hex")}  ${basename(output)}\n`)
