/** Replay the exact desired assertion without Vitest's expected-failure marker. */
import { deepStrictEqual } from "node:assert/strict"
import { readFileSync } from "node:fs"
import { pathToFileURL } from "node:url"
export const assertRecovery = (receipt: { actual: unknown; desired: unknown }) =>
  deepStrictEqual(receipt.actual, receipt.desired)
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2]) throw Error("usage: node recovery.ts /receipts/<scenario>/recovery.json")
  assertRecovery(JSON.parse(readFileSync(process.argv[2], "utf8")))
}
