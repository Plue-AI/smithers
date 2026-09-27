package product

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5"
)

// Migration 0053 gives a planner's decline its own state: a skipped item the
// planner declined becomes declined; an admission skip stays skipped, even
// when an earlier decline's outcome is still recorded.
func TestMythicalDeclinedMigrationSeparatesDeclines(t *testing.T) {
	pool := newProductTestPool(t)
	ctx := context.Background()

	registered, err := registeredMigrations()
	if err != nil {
		t.Fatal(err)
	}
	var declined migration
	for _, m := range registered {
		if m.version == 53 {
			declined = m
			break
		}
		if _, err = pool.Exec(ctx, m.sql, pgx.QueryExecModeSimpleProtocol); err != nil {
			t.Fatalf("migration %d: %v", m.version, err)
		}
	}
	if declined.version != 53 {
		t.Fatal("migration 0053 is not registered")
	}
	if _, err = pool.Exec(ctx, `
		INSERT INTO users (id, username, lower_username) VALUES (1, 'alice', 'alice');
		INSERT INTO repositories (id, user_id, name, lower_name) VALUES (1, 1, 'repo', 'repo');
		INSERT INTO mythical_items (repository_id, issue_number, state, reason, request_outcome) VALUES
			(1, 1, 'skipped', 'Already done.', 'declined: Already done.'),
			(1, 2, 'skipped', 'waiting for a maintainer to add the smithers label', ''),
			(1, 3, 'blocked', 'out of attempts', 'declined: earlier'),
			(1, 4, 'skipped', 'labeled wontfix', 'declined: earlier');
	`, pgx.QueryExecModeSimpleProtocol); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, declined.sql, pgx.QueryExecModeSimpleProtocol); err != nil {
		t.Fatalf("migration 0053: %v", err)
	}
	rows, err := pool.Query(ctx, `SELECT state FROM mythical_items ORDER BY issue_number`)
	if err != nil {
		t.Fatal(err)
	}
	states, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"declined", "skipped", "blocked", "skipped"}
	if len(states) != len(want) {
		t.Fatalf("states %v, want %v", states, want)
	}
	for i := range want {
		if states[i] != want[i] {
			t.Fatalf("states %v, want %v", states, want)
		}
	}
}
