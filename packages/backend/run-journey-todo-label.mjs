import { spawnSync } from 'node:child_process'
// Share the existing backend journey entry point: --j1 runs the J1 rehearsal
// (C-J1-04), --j2, --j4, --j4b, --j5, --j6, --j7 and --j11 that journey's
// rehearsal (--j4b: a failed TODO is dropped and the next merges); with none
// it runs C-J2-02.
const journeys = ['--j1', '--j2', '--j4', '--j4b', '--j5', '--j6', '--j7', '--j11']
const args = process.argv.slice(2)
const journey = args[0]
if (args.length > 1 || (args.length === 1 && !journeys.includes(journey))) {
  console.error(`Usage: node packages/backend/run-journey-todo-label.mjs [${journeys.join('|')}]`)
  process.exit(1)
}
const id = journey?.slice(2).toUpperCase()
const name = journey === undefined ? 'C-J2-02' : journey === '--j1' ? 'C-J1-04 rehearsal' : `${id} rehearsal`
if (!process.env.SMITHERS_TEST_DATABASE_URL) {
  console.error(JSON.stringify({ code: 'journey_prerequisite_missing', class: 'factory', message: `${name} requires real PostgreSQL in SMITHERS_TEST_DATABASE_URL` }))
  process.exit(1)
}
// A journey with several TODOs runs longer than J1's one.
const goArgs = journey
  ? ['test', '-v', '-count=1', '-timeout', journey === '--j1' || journey === '--j2' ? '30m' : '60m', '-run', `^Test${id}Rehearsal$`, './packages/backend/internal/compose']
  : ['test', '-json', '-count=1', '-run', '^TestJourneyTodoLabel', './packages/backend/internal/services']
const result = spawnSync('go', goArgs, {
  cwd: new URL('../../', import.meta.url),
  env: { ...process.env, SMITHERS_REQUIRE_DATABASE_TESTS: '1', ...(journey ? { [`SMITHERS_${id}_REHEARSAL`]: '1' } : {}) },
  stdio: 'inherit'
})
if (result.error) throw result.error
process.exit(result.status ?? 1)
