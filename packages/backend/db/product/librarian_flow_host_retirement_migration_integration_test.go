package product

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5"
)

// Migration 0047 retires every librarian (product gateway) Flow host binding
// so the reconciliation pass stops it; coding hosts keep running (#2194).
func TestLibrarianFlowHostRetirementMigrationRetiresOnlyLibrarianHosts(t *testing.T) {
	pool := newProductTestPool(t)
	ctx := context.Background()
	registered, err := registeredMigrations()
	if err != nil {
		t.Fatal(err)
	}
	var retirement migration
	for _, m := range registered {
		if m.version == 47 {
			retirement = m
			break
		}
		if _, err = pool.Exec(ctx, m.sql, pgx.QueryExecModeSimpleProtocol); err != nil {
			t.Fatalf("migration %d: %v", m.version, err)
		}
	}
	if retirement.version != 47 {
		t.Fatal("migration 0047 is not registered")
	}
	digest := "0000000000000000000000000000000000000000000000000000000000000000"
	revision := "0000000000000000000000000000000000000000"
	if _, err = pool.Exec(ctx, `
		INSERT INTO flow_runtime_host_bindings (id, tenant_id, principal_id, binding_kind, binding_id, repository_id, user_id,
			workspace_id, catalog_key, service_name, runtime_artifact_digest, source_revision, owner_generation,
			credential_ciphertext, credential_hash, state)
		VALUES
			('11111111-1111-4111-8111-111111111111', 'repository:1', 'user:1', 'browser-flow', 'o/r', 1, 1,
			 '21111111-1111-4111-8111-111111111111', 'librarian', 'smithers-librarian-host', $1, $2, 1, 'x', decode(repeat('00', 32), 'hex'), 'running'),
			('12111111-1111-4111-8111-111111111111', 'repository:1', 'user:1', 'browser-flow', 'o/r', 1, 1,
			 '22111111-1111-4111-8111-111111111111', 'librarian', 'smithers-librarian-host', $1, $2, 1, 'x', decode(repeat('00', 32), 'hex'), 'failed'),
			('13111111-1111-4111-8111-111111111111', 'repository:1', 'user:1', 'agent-session', 's', 1, 1,
			 '21111111-1111-4111-8111-111111111111', 'coding', 'smithers-coding-host', $1, $2, 1, 'x', decode(repeat('00', 32), 'hex'), 'running')`,
		digest, revision); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if _, err = pool.Exec(ctx, retirement.sql, pgx.QueryExecModeSimpleProtocol); err != nil {
			t.Fatal(err)
		}
	}
	rows, err := pool.Query(ctx, `SELECT catalog_key, state FROM flow_runtime_host_bindings ORDER BY id`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var got []string
	for rows.Next() {
		var catalog, state string
		if err := rows.Scan(&catalog, &state); err != nil {
			t.Fatal(err)
		}
		got = append(got, catalog+"="+state)
	}
	want := []string{"librarian=retired", "librarian=retired", "coding=running"}
	if len(got) != len(want) {
		t.Fatalf("bindings = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("bindings = %v, want %v", got, want)
		}
	}
}
