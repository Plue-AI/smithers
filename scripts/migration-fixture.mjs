// Shared literal checkout inputs for production landing-script tests.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
const root = resolve(import.meta.dirname, '..')
process.env.PATH = `${join(root, 'node_modules/.bin')}:${process.env.PATH}`
const sqlc = spawnSync('which', ['sqlc'], { encoding: 'utf8' }).stdout.trim()
const ok = (cwd, bin, args) => {
 const r = spawnSync(bin, args, { cwd, encoding: 'utf8' })
 assert.equal(r.status, 0, r.stdout + r.stderr); return r.stdout.trim()
}
export const registry = (extra = '') => `package product
import ("embed";"io/fs")
//go:embed migrations/*.sql
var migrations embed.FS
const BaselineVersion=1
type migrationSpec struct {version int;path string}
var migrationRegistry=[]migrationSpec{
 {BaselineVersion, "migrations/0001_things.sql"},
 ${extra}
}
func registeredMigrations()([]fs.DirEntry,error){return migrations.ReadDir("migrations")}
`
const schema = 'CREATE TABLE things(id bigint PRIMARY KEY);\n'
export function installMigrationFixture(dir) {
 const product = join(dir, 'packages/backend/db/product')
 mkdirSync(join(product, 'migrations'), { recursive: true });mkdirSync(join(product, 'queries'));mkdirSync(join(dir, 'packages/backend/internal/db'), { recursive: true });mkdirSync(join(dir, 'scripts'), { recursive: true })
 mkdirSync(join(dir, 'node_modules/@smthrs'), {recursive:true})
 symlinkSync(join(root, 'packages/smithers/build/targets'), join(dir, 'node_modules/@smthrs/targets'), 'dir')
 writeFileSync(join(dir, '.gitignore'), 'node_modules\n.flows/\n')
 writeFileSync(join(dir, 'package.json'), '{"name":"migration-fixture","private":true,"type":"module","packageManager":"pnpm@11.25.0","engines":{"node":">=26.4.0"}}\n')
 writeFileSync(join(dir, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\nimporters:\n  .: {}\n")
 writeFileSync(join(dir, 'WORKSPACE.ts'), `import { Smithers as S } from "@smthrs/targets"
const manifest = S.file("//package.json")
export const Workspace = S.Workspace("fixture", {
 repository: "git+https://example.invalid/fixture.git", cache: S.Cache({directory:".flows"}),
 runtime: S.Runtime.Node({version:">=26.4.0"}),
 packageManager: S.PackageManager.Pnpm({manifest,lockfile:S.file("//pnpm-lock.yaml")}),
 nodeModules: S.Npm.NodeModules({packageJson:manifest}),
})
`)
 writeFileSync(join(dir, 'PACKAGE.ts'), `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: {
 driftCi: S.Shell.Diff({shell:"true",changes:[],sandbox:"none"}),
 targetIndex: S.Shell.Diff({shell:"true",changes:[],sandbox:"none"}),
 ci: S.Shell.Diff({shell:"true",changes:[],sandbox:"none"}),
}})
`)
 writeFileSync(join(dir, 'scripts/PACKAGE.ts'), `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: {
 trackedHygiene: S.Shell.Diff({shell:"true",changes:[],sandbox:"none"}),
 conflictMarkers: S.Shell.Diff({shell:"true",changes:[],sandbox:"none"}),
}})
`)
 writeFileSync(join(dir, 'go.mod'), 'module fixture\n\ngo 1.26.8\n')
 writeFileSync(join(product, 'migrations/0001_things.sql'), schema)
 writeFileSync(join(product, 'migrate.go'), registry())
 copyFileSync(join(root, 'packages/backend/db/product/migration_registry_test.go'), join(product, 'migration_registry_test.go'))
 writeFileSync(join(dir, 'packages/backend/db/ownership.csv'), 'table,target_owner,status\nthings,product,installed\n')
 writeFileSync(join(product, 'sqlc.yaml'), 'version: "2"\nsql:\n - engine: postgresql\n   schema: migrations/\n   queries: queries/\n   gen:\n    go:\n     package: db\n     out: ../../internal/db\n')
 writeFileSync(join(product, 'queries/things.sql'), '-- name: GetThings :many\nSELECT id FROM things;\n')
 copyFileSync(join(root, 'packages/backend/internal/db/sqlc_regeneration_test.go'), join(dir, 'packages/backend/internal/db/sqlc_regeneration_test.go'))
 for (const name of ['commit.mjs', 'check-tracked-hygiene.mjs', 'check-sqlc-drift.sh', 'renumber-migration.mjs']) copyFileSync(join(root, 'scripts', name), join(dir, 'scripts', name))
 assert.ok(sqlc, 'pinned sqlc must be installed')
 ok(dir, sqlc, ['generate', '-f', 'packages/backend/db/product/sqlc.yaml'])
}
