import { spawnSync } from 'node:child_process'
// Share the existing backend journey entry point; J1 stays opt-in while red.
const j1 = process.argv.includes('--j1')
if (process.argv.slice(2).some(arg => arg !== '--j1')) {
  console.error('Usage: node packages/backend/run-journey-todo-label.mjs [--j1]')
  process.exit(1)
}
if (!process.env.SMITHERS_TEST_DATABASE_URL) {
  console.error(JSON.stringify({ code: 'journey_prerequisite_missing', class: 'factory', message: `${j1 ? 'C-J1-04 rehearsal' : 'C-J2-02'} requires real PostgreSQL in SMITHERS_TEST_DATABASE_URL` }))
  process.exit(1)
}
const args = j1
  ? ['test', '-v', '-count=1', '-timeout', '30m', '-run', '^TestJ1Rehearsal$', './packages/backend/internal/compose']
  : ['test', '-json', '-count=1', '-run', '^TestJourneyTodoLabel', './packages/backend/internal/services']
const result = spawnSync('go', args, {
  cwd: new URL('../../', import.meta.url),
  env: { ...process.env, SMITHERS_REQUIRE_DATABASE_TESTS: '1', ...(j1 ? { SMITHERS_J1_REHEARSAL: '1' } : {}) },
  stdio: 'inherit'
})
if (result.error) throw result.error
process.exit(result.status ?? 1)
