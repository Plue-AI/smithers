import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { comparePhases, runFreshness, writeEvidence } from './github-freshness.mjs'

// Host runner only. Never invoked by product credentials or the factory.
if (process.argv[2] === '--compare') {
  const inactive = JSON.parse(await readFile(process.argv[3], 'utf8'))
  const dropped = JSON.parse(await readFile(process.argv[4], 'utf8'))
  process.exit(comparePhases(inactive, dropped) ? 0 : 1)
}
const config = JSON.parse(await readFile(process.argv[2], 'utf8'))
const directory = process.argv[3]
await mkdir(directory, { recursive: false })
const result = await runFreshness(config, {
  githubToken: process.env.SMITHERS_FRESHNESS_GITHUB_TOKEN,
  installToken: process.env.SMITHERS_FRESHNESS_INSTALL_TOKEN,
  onSample: async sample => appendFile(`${directory}/events.jsonl`, `${JSON.stringify(sample)}\n`),
})
await writeEvidence(`${directory}/results`, result)
process.exitCode = Object.values(result.metrics).every(metric => metric.passed) ? 0 : 1
