import { readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { parseAppendixC } from "./appendix-c.mjs"
const root = new URL("../", import.meta.url)
const labels = parseAppendixC(readFileSync(new URL(".specs/product/actions.md", root), "utf8"))
const target = new URL("packages/smithers/gateway/src/internal/InspectLabels.ts", root)
const output = `/** Generated from Appendix C by scripts/generate-inspect-labels.mjs; do not edit. */\nexport const INSPECT_LABELS: Readonly<Record<string, string>> = ${JSON.stringify(labels, null, 2)}\n`
if (process.argv.includes("--check")) {
  if (readFileSync(target, "utf8") !== output) throw new Error(`Stale labels: ${fileURLToPath(target)}`)
} else writeFileSync(target, output)
