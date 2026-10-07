#!/usr/bin/env node
// Landing-only helper. SQL/CSV and generators run with the caller's unprivileged identity.
import { engineeringGateEnvironment, requireEngineeringGateHome } from './engineering-gate-environment.mjs'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, renameSync, readdirSync, rmSync } from 'node:fs'
import { resolve, relative, basename, dirname, join } from 'node:path'

const run = (bin, args, cwd = process.cwd()) => {
  const result = spawnSync(bin, args, { cwd, encoding: 'utf8', env: engineeringGateEnvironment(process.env) })
  if (result.error || result.status !== 0) throw new Error(`${bin} ${args.join(' ')}: ${result.error?.message ?? (result.stdout + result.stderr)}`)
  return result.stdout.trim()
}
try {
  if (process.getuid?.() === 0) throw new Error('Refusing repository generator execution as root')
  requireEngineeringGateHome(process.env)
  if (process.argv.length !== 3) throw new Error('Usage: renumber-migration.mjs <file>')
  const root = run('git', ['rev-parse', '--show-toplevel'])
  const file = resolve(process.argv[2])
  const directory = join(root, 'packages/backend/db/product/migrations')
  if (dirname(file) !== directory || !/^\d{4}_.+\.sql$/.test(basename(file))) throw new Error('Expected a product migration file')
  // A missing/stale remote is never evidence of an unlanded file. Fetch before invoking.
  run('git', ['rev-parse', '--verify', 'origin/main^{commit}'], root)
  const mainFiles = run('git', ['ls-tree', '-r', 'origin/main', '--', relative(root, directory)], root).split('\n')
  const blob = run('git', ['hash-object', file], root)
  if (mainFiles.some(line => line.endsWith(`\t${relative(root, file)}`) || line.split(/\s+/)[2] === blob)) throw new Error('Refusing to renumber a migration already on origin/main')
  const landed = run('git', ['ls-tree', '-r', '--name-only', 'origin/main', '--', relative(root, directory)], root).split('\n')
  const max = Math.max(0, ...landed.map(name => Number(basename(name).match(/^(\d{4})_/)?.[1] ?? 0)))
  const number = max + 1
  const next = join(directory, basename(file).replace(/^\d{4}/, String(number).padStart(4, '0')))
  if (next !== file && existsSync(next)) throw new Error(`Migration number ${number} is already occupied locally`)
  const sqlc = existsSync(join(root, '.backend-sqlc/sqlc')) ? join(root, '.backend-sqlc/sqlc') : 'sqlc'
  if (run(sqlc, ['version'], root) !== 'v1.30.0') throw new Error('sqlc v1.30.0 is required (PACKAGE.ts pin)')
  const registry = join(root, 'packages/backend/db/product/migrate.go')
  const ownership = join(root, 'packages/backend/db/ownership.csv')
  const originalRegistry = readFileSync(registry, 'utf8')
  const originalOwnership = readFileSync(ownership, 'utf8')
  const oldPath = `migrations/${basename(file)}`
  const rowPattern = /\{(?:BaselineVersion|\d+), "migrations\/[^"\n]+"\},/g
  const rows = originalRegistry.match(rowPattern) ?? []
  const matching = rows.filter(row => row.includes(`"${oldPath}"`))
  if (matching.length !== 1) throw new Error('Migration needs exactly one registry row')
  const newRow = `{${number}, "migrations/${basename(next)}"},`
  const nextRegistry = originalRegistry.replace(matching[0], newRow)
  // Only this ticket's reservations are converted; other lanes' Ready rows stay planned.
  const ticket = process.env.SMITHERS_MIGRATION_TICKET
  const nextOwnership = originalOwnership.split('\n').map(line => {
    const fields = line.split(',')
    if (ticket && fields[2]?.startsWith(`planned:${ticket};owner:`)) {
      // Converted only after the DB-free gate verifies that this migration creates the reserved table.
      const escaped = fields[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      if (new RegExp(`\\bCREATE\\s+(?:UNLOGGED\\s+)?TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(?:public\\.)?"?${escaped}"?\\s*\\(`, 'i').test(readFileSync(file, 'utf8'))) fields[2] = `product migration ${String(number).padStart(4, '0')};owner:${fields[2].split(';owner:')[1]}`
    }
    return fields.join(',')
  }).join('\n')
  const generated = join(root, 'packages/backend/internal/db')
  const snapshot = new Map(readdirSync(generated).filter(name => name.endsWith('.go')).map(name => [name, readFileSync(join(generated, name))]))
  try {
    if (next !== file) renameSync(file, next)
    writeFileSync(registry, nextRegistry)
    // Check reservations before conversion so another ticket cannot steal a table.
    run('go', ['test', '-count=1', '-run', 'TestMigrationGate|TestMigrationRegistry', './packages/backend/db/product/'], root)
    writeFileSync(ownership, nextOwnership)
    run(sqlc, ['generate', '-f', 'packages/backend/db/product/sqlc.yaml'], root)
    run('go', ['test', '-count=1', '-run', 'TestMigrationGate|TestMigrationRegistry', './packages/backend/db/product/'], root)
  } catch (error) {
    if (next !== file) renameSync(next, file)
    writeFileSync(registry, originalRegistry); writeFileSync(ownership, originalOwnership)
    for (const name of readdirSync(generated).filter(name => name.endsWith('.go'))) if (!snapshot.has(name)) rmSync(join(generated, name))
    for (const [name, bytes] of snapshot) writeFileSync(join(generated, name), bytes)
    throw error
  }
  console.log(relative(root, next))
} catch (error) { console.error(error.message); process.exitCode = 1 }
