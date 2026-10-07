import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('C-PERF-01 has twenty fixed, distinct no-machine questions requesting cards', async () => {
  const questions = JSON.parse(await readFile(new URL('./questions.json', import.meta.url), 'utf8'))
  assert.equal(questions.length, 20)
  assert.equal(new Set(questions).size, 20)
  for (const question of questions) {
    assert.match(question, /Show (the|its) (file|license file|wiki page)\.$/)
    assert.match(question, /^(What|How|Where|Which) /)
    assert.doesNotMatch(question, /\b(please run|execute|open a terminal|ssh|wake a machine)\b/i)
  }
})
