package product

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5"
)

// Migration 0045 revokes every workspace landing credential minted before
// landing credentials named their workspace, since a landing opened with one
// cannot be traced to an outsider-marked workspace. Credentials that name
// their workspace, other run credentials and people's own tokens survive.
func TestOutsiderProvenanceMigrationRevokesUnscopedLandingCredentials(t *testing.T) {
	pool := newProductTestPool(t)
	ctx := context.Background()

	registered, err := registeredMigrations()
	if err != nil {
		t.Fatal(err)
	}
	var provenance migration
	for _, m := range registered {
		if m.version == 45 {
			provenance = m
			break
		}
		if _, err = pool.Exec(ctx, m.sql, pgx.QueryExecModeSimpleProtocol); err != nil {
			t.Fatalf("migration %d: %v", m.version, err)
		}
	}
	if provenance.version != 45 {
		t.Fatal("migration 0045 is not registered")
	}
	if _, err = pool.Exec(ctx, `
		INSERT INTO users (id, username, lower_username) VALUES (1, 'alice', 'alice');
		INSERT INTO access_tokens (user_id, name, token_hash, scopes, system_issued) VALUES
			(1, 'workspace-gateway-landing-gw-legacy', 'h1', 'write:repository,repo:7', true),
			(1, 'workspace-gateway-landing-gw-legacy-2', 'h2', 'write:repository,repo:7,path:src', true),
			(1, 'workspace-gateway-landing-gw-scoped', 'h3', 'write:repository,repo:7,landing-workspace:5f0c1f7e-7a55-4a53-9c1c-3f1f4b0a2e11', true),
			(1, 'sandbox-run-9', 'h4', 'write:repository,repo:7,agent-session:5f0c1f7e-7a55-4a53-9c1c-3f1f4b0a2e11', true),
			(1, 'laptop', 'h5', 'write:repository', false);
	`, pgx.QueryExecModeSimpleProtocol); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, provenance.sql, pgx.QueryExecModeSimpleProtocol); err != nil {
		t.Fatalf("migration 0045: %v", err)
	}
	rows, err := pool.Query(ctx, `SELECT name FROM access_tokens ORDER BY name`)
	if err != nil {
		t.Fatal(err)
	}
	kept, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"laptop", "sandbox-run-9", "workspace-gateway-landing-gw-scoped"}
	if len(kept) != len(want) {
		t.Fatalf("kept %v, want %v", kept, want)
	}
	for i := range want {
		if kept[i] != want[i] {
			t.Fatalf("kept %v, want %v", kept, want)
		}
	}
}
