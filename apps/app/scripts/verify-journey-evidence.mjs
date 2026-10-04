import { execFileSync } from 'node:child_process'
import { unpackResults, verifyCiRun } from '../../../scripts/check-evidence.mjs'
const landed = process.env.SMITHERS_REAL_E2E_BUILD_SHA
const label = process.env.SMITHERS_JOURNEY_EVIDENCE_PREREQUISITE_TARGET
if (!label || !/evidence/i.test(label)) {
  console.error(JSON.stringify({ code: 'journey_prerequisite_missing', class: 'factory', message: 'Supply the exclusive production todo_evidence_db_test.go target after its owning ticket lands' }))
  process.exit(1)
}
const gh = (path, encoding) => execFileSync('gh', ['api', path], { encoding, maxBuffer: 256 << 20, stdio: ['ignore', 'pipe', 'pipe'] })
const verdict = verifyCiRun({
  github: { json: path => JSON.parse(gh(path, 'utf8')), bytes: path => gh(path, 'buffer') },
  unpack: unpackResults, repo: 'smithersai/smithers', landed, label
})
console.log(JSON.stringify(verdict))
if (!verdict.pass) process.exit(1)
