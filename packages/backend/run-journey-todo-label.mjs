import { spawnSync } from 'node:child_process'
if (!process.env.SMITHERS_TEST_DATABASE_URL) {
  console.error(JSON.stringify({ code: 'journey_prerequisite_missing', class: 'factory', message: 'C-J2-02 requires real PostgreSQL in SMITHERS_TEST_DATABASE_URL' }))
  process.exit(1)
}
const result = spawnSync('go', ['test', '-json', '-count=1', '-tags', 'journey_pending', '-run', '^TestJourneyTodoLabel', './packages/backend/internal/services'], {
  cwd: new URL('../../', import.meta.url), env: { ...process.env, SMITHERS_REQUIRE_DATABASE_TESTS: '1' }, stdio: 'inherit'
})
if (result.error) throw result.error
process.exit(result.status ?? 1)
