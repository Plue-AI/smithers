import { spawnSync } from 'node:child_process'
// Share the existing backend journey entry point: --j1 runs the J1 rehearsal
// (C-J1-04), --j2 the J2 rehearsal; with neither it runs C-J2-02.
const args = process.argv.slice(2)
const journey = args[0]
if (args.length > 1 || (args.length === 1 && journey !== '--j1' && journey !== '--j2')) {
  console.error('Usage: node packages/backend/run-journey-todo-label.mjs [--j1|--j2]')
  process.exit(1)
}
const name = { '--j1': 'C-J1-04 rehearsal', '--j2': 'J2 rehearsal' }[journey] ?? 'C-J2-02'
if (!process.env.SMITHERS_TEST_DATABASE_URL) {
  console.error(JSON.stringify({ code: 'journey_prerequisite_missing', class: 'factory', message: `${name} requires real PostgreSQL in SMITHERS_TEST_DATABASE_URL` }))
  process.exit(1)
}
const rehearsal = { '--j1': ['^TestJ1Rehearsal$', 'SMITHERS_J1_REHEARSAL'], '--j2': ['^TestJ2Rehearsal$', 'SMITHERS_J2_REHEARSAL'] }[journey]
const goArgs = rehearsal
  ? ['test', '-v', '-count=1', '-timeout', '30m', '-run', rehearsal[0], './packages/backend/internal/compose']
  : ['test', '-json', '-count=1', '-run', '^TestJourneyTodoLabel', './packages/backend/internal/services']
const result = spawnSync('go', goArgs, {
  cwd: new URL('../../', import.meta.url),
  env: { ...process.env, SMITHERS_REQUIRE_DATABASE_TESTS: '1', ...(rehearsal ? { [rehearsal[1]]: '1' } : {}) },
  stdio: 'inherit'
})
if (result.error) throw result.error
process.exit(result.status ?? 1)
