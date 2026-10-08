package microsandbox

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

const generatorIdentityProbe = `import os
print('uid=%d gid=%d groups=%s' % (os.getuid(),os.getgid(),os.getgroups()),flush=True)
assert (os.getuid(),os.getgid(),os.getgroups()) == (19999,19999,[20000]), 'generator identity differs from C-PRC-02'
for name in ('scripts/renumber-migration.mjs','scripts/engineering-gate-environment.mjs','packages/backend/db/product/migration_registry_test.go','packages/backend/db/product/migrations/0001_things.sql','packages/backend/db/ownership.csv','packages/backend/db/product/sqlc.yaml'):
 with open(name,'rb') as f: assert f.read(),name
print('repository-inputs-read-after-identity')`

// generator-uid-before-repository-use qualifies only on the approved mini
// bundle. Missing runtime/approval is a skip locally and a failure in mandatory
// microVM mode. No branch program is ever dispatched with root authority.
func TestRealMicroVMGeneratorUIDBeforeRepositoryUse(t *testing.T) {
	if os.Getenv("SMITHERS_CHECK_BUNDLE") == "" {
		if os.Getenv("SMITHERS_REQUIRE_MICROVM_TESTS") == "1" || os.Getenv("SMITHERS_GUEST_ROOT_BOUNDARY_CHECK") == "1" {
			t.Fatal("main-pinned mini bundle is required; no development runtime fallback")
		}
		t.Skip("PENDING C-PRC-02: main-pinned mini bundle is unavailable")
	}
	r, _ := approvedRootBoundaryRuntime(t)
	ctx := operation("generator-uid-before-repository-use")
	const id = "prc02-generator"
	_, err := r.CreateWorkspace(ctx, workspaceapi.WorkspaceSpec{ID: id})
	require.NoError(t, err)

	// Observe identity in an isolated interpreter before opening any repository
	// helper, test, SQL, CSV or generator configuration. Literal expectations are
	// independent of the runtime's identity constants. The team group is required
	// for shared branch access (M-17); no other supplementary group is allowed.

	files := map[string]string{
		"go.mod": "module fixture\n\ngo 1.26.8\n",
		"packages/backend/db/product/migrations/0001_things.sql": "CREATE TABLE things(id bigint PRIMARY KEY);\n",
		"packages/backend/db/ownership.csv":                      "table,target_owner,status\nthings,product,installed\n",
		"packages/backend/db/product/sqlc.yaml":                  "version: \"2\"\nsql:\n - engine: postgresql\n   schema: migrations/\n   queries: queries/\n   gen:\n    go:\n     package: db\n     out: ../../internal/db\n",
		"packages/backend/db/product/queries/things.sql":         "-- name: GetThings :many\nSELECT id FROM things;\n",
		"packages/backend/internal/db/models.go":                 "package db\n",
		"packages/backend/db/product/migrate.go": `package product
import("embed";"io/fs")
//go:embed migrations/*.sql
var migrations embed.FS
const BaselineVersion=1
type migrationSpec struct{version int;path string}
var migrationRegistry=[]migrationSpec{
 {BaselineVersion, "migrations/0001_things.sql"},
}
func registeredMigrations()([]fs.DirEntry,error){return migrations.ReadDir("migrations")}
`,
	}
	for _, name := range []string{"scripts/renumber-migration.mjs", "scripts/engineering-gate-environment.mjs", "packages/backend/db/product/migration_registry_test.go"} {
		body, readErr := os.ReadFile(filepath.Join("../../..", name))
		require.NoError(t, readErr)
		files[name] = string(body)
	}
	for name, body := range files {
		require.NoError(t, writeGuestFixture(r, ctx, id, name, []byte(body), 0o644))
	}

	// A hostile root envelope must fail in the trusted preflight, before either
	// identity probe or branch canary can start. Compare every fixture byte.
	hostile, err := json.Marshal(map[string]any{"id": "prc02-root", "user": "root", "root": "/workspace", "cwd": "/workspace", "argv": []string{"/bin/sh", "-c", "printf root-canary > packages/backend/db/ownership.csv"}})
	require.NoError(t, err)
	_, err = r.guest(ctx, r.machineName(id), hostile, "exec", "prc02-root")
	require.ErrorContains(t, err, "invalid exec payload")
	for name, body := range files {
		observed, readErr := r.ReadFile(ctx, id, name)
		require.NoError(t, readErr)
		require.Equal(t, body, string(observed), name)
	}
	result, err := r.ExecuteCommand(ctx, id, workspaceapi.Command{Args: []string{"/usr/bin/python3", "-I", "-S", "-c", generatorIdentityProbe}})
	require.NoError(t, err)
	t.Logf("independent identity observation: %s", result.Stdout)
	require.Zero(t, result.ExitCode, result.Stderr)
	require.Equal(t, "uid=19999 gid=19999 groups=[20000]\nrepository-inputs-read-after-identity\n", result.Stdout)

	// Production Go and pinned sqlc execute in the guest, with an isolated home
	// and no live publication/database credentials. Only fixture origin/main is
	// created: no remote publication command is used.
	script := `set -eu
mkdir -p /workspace/isolated-home
export HOME=/workspace/isolated-home
unset DATABASE_URL SMITHERS_TEST_DATABASE_URL GITHUB_TOKEN GH_TOKEN PGPASSWORD PGPASSFILE PGSERVICE PGSERVICEFILE
export GOTOOLCHAIN=local SMITHERS_MIGRATION_TICKET=T-PRC-02
git init -b main
git config user.name Fixture
git config user.email fixture@example.invalid
git add .
git commit -m baseline
git update-ref refs/remotes/origin/main HEAD
printf 'CREATE TABLE reserved(id bigint PRIMARY KEY);\n' > packages/backend/db/product/migrations/0009_reserved.sql
sed -i '/^}/i\ {9, "migrations/0009_reserved.sql"},' packages/backend/db/product/migrate.go
printf 'reserved,product,planned:T-PRC-02;owner:smithers-8a\n' >> packages/backend/db/ownership.csv
node scripts/renumber-migration.mjs packages/backend/db/product/migrations/0009_reserved.sql
test -f packages/backend/db/product/migrations/0002_reserved.sql
grep -F '{2, "migrations/0002_reserved.sql"},' packages/backend/db/product/migrate.go
grep -F 'type Reserved struct' packages/backend/internal/db/models.go
grep -F 'reserved,product,product migration 0002;owner:smithers-8a' packages/backend/db/ownership.csv
git diff --exit-code -- packages/backend/db/product/migrations/0001_things.sql
printf 'generator-fixture-passed\n'
`
	result, err = r.ExecuteCommand(ctx, id, workspaceapi.Command{Args: []string{"/bin/sh", "-ec", script}})
	require.NoError(t, err)
	require.Zero(t, result.ExitCode, result.Stdout+result.Stderr)
	require.Contains(t, result.Stdout, "generator-fixture-passed\n")
}

// Supplemental probe coverage; the installed-bundle test above remains the
// acceptance boundary. Refused identities must not open repository inputs.
func TestGeneratorIdentityProbeBeforeRepositoryUse(t *testing.T) {
	for _, identity := range []struct {
		name     string
		uid, gid int
		groups   string
		accepted bool
	}{
		{"team", 19999, 19999, "[20000]", true},
		{"empty", 19999, 19999, "[]", false},
		{"extra", 19999, 19999, "[20000,0]", false},
		{"root-uid", 0, 19999, "[20000]", false},
		{"root-gid", 19999, 0, "[20000]", false},
	} {
		t.Run(identity.name, func(t *testing.T) {
			boundaryPython(t, fmt.Sprintf(`
import builtins, io
os.getuid=lambda: %d
os.getgid=lambda: %d
os.getgroups=lambda: %s
opened=[]
def observed_open(name,mode):
 opened.append(name)
 return io.BytesIO(b'fixture')
builtins.open=observed_open
accepted=True
try: exec(%q)
except AssertionError: accepted=False
assert accepted == %s
assert len(opened) == %d, opened
`, identity.uid, identity.gid, identity.groups, generatorIdentityProbe, map[bool]string{true: "True", false: "False"}[identity.accepted], map[bool]int{true: 6, false: 0}[identity.accepted]))
		})
	}
}
