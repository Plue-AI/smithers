/**
 * Records `real-corpus.json` from `manifest.json` (every repository at its pinned SHA, S1-S5) and
 * refits it into `real-fit.json`. Needs network and `git`; clones live under the work directory and
 * are deleted as each repository finishes.
 * Rerun: `node --experimental-strip-types flows/register-repository/calibration/run-real.ts [workdir]`.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { fit } from "./fit.ts"
import { type ManifestEntry, type RealCase, recordRepository } from "./record.ts"

const here = new URL(".", import.meta.url)
const manifest: { entries: ReadonlyArray<ManifestEntry> } = JSON.parse(
  readFileSync(new URL("manifest.json", here), "utf8")
)
const work = process.argv[2] ?? "."
mkdirSync(work, { recursive: true })

const results = new Map<string, RealCase>()
const failures: Array<string> = []
const queue = [...manifest.entries]
await Promise.all(Array.from({ length: 5 }, async () => {
  for (let entry = queue.shift(); entry !== undefined; entry = queue.shift()) {
    const result = await recordRepository(entry, work)
    if (!result.ok) failures.push(`${entry.id} ${entry.repo}: ${result.reason}`)
    else if (result.measuredLanguage !== entry.language || result.recorded.band !== entry.band) {
      failures.push(`${entry.id} ${entry.repo}: measured ${result.measuredLanguage}/${result.recorded.band}`)
    } else results.set(entry.id, result.recorded)
    process.stderr.write(`${results.size}/${manifest.entries.length} recorded\n`)
  }
}))
if (failures.length > 0) throw new Error(`Not reproducible from the manifest:\n${failures.join("\n")}`)
const cases = manifest.entries.map((entry) => results.get(entry.id)!)
writeFileSync(
  new URL("real-corpus.json", here),
  JSON.stringify({ synthetic: false, manifest: "manifest.json", cases }, null, 1) + "\n"
)
writeFileSync(new URL("real-fit.json", here), JSON.stringify(fit(cases, "calibrated-real-v1"), null, 2) + "\n")
