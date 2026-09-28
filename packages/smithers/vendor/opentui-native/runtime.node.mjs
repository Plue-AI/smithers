import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import manifest from "./manifest.json" with { type: "json" }
import { nativeTarget } from "./target.mjs"

const target = nativeTarget()
const path = fileURLToPath(new URL(`./${target}/${manifest.targets[target].file}`, import.meta.url))
if (!existsSync(path)) throw new Error(`Missing corrected OpenTUI native library for ${target}: ${path}`)
export default path
